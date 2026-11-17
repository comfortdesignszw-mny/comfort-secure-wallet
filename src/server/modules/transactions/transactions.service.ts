import { randomUUID } from 'node:crypto';
import {
  ADMIN_ROLES,
  AccountStatus,
  Currency,
  DepositRequestRecord,
  DepositStatus,
  JournalDirection,
  KycStatus,
  LedgerAccountType,
  NotificationChannel,
  RiskSeverity,
  TransactionRecord,
  TransactionType,
  UserStatus,
  WithdrawalRequestRecord,
  WithdrawalStatus,
} from '../../../shared/types.ts';
import { formatMinorUnits } from '../../../shared/money.ts';
import { broadcastSyncEvent } from '../../db/realtime.ts';
import { dbStore } from '../../db/store.ts';
import { encryptBuffer, encryptField, signStorageKey } from '../../security/crypto.ts';
import { recordAuditLog } from '../../security/audit.ts';
import { ledgerService } from '../ledger/ledger.service.ts';
import { notificationService } from '../notifications/notifications.service.ts';
import { riskService } from '../risk/risk.service.ts';
import { rulesService } from '../rules/rules.service.ts';

class TransactionsService {
  private ensureAccountOperable(userId: string, accountId: string) {
    const user = dbStore.users.get(userId);
    if (!user) throw new Error('USER_NOT_FOUND');
    if (user.status !== UserStatus.ACTIVE) {
      throw new Error(`ACCOUNT_FROZEN: User account is ${user.status}. ${user.freezeReason || ''}`);
    }
    if (user.kycStatus !== KycStatus.APPROVED) {
      throw new Error('KYC_REQUIRED: Complete identity verification before moving money.');
    }
    const account = dbStore.accounts.get(accountId);
    if (!account || account.userId !== userId) {
      throw new Error('ACCOUNT_NOT_FOUND');
    }
    if (account.status !== AccountStatus.ACTIVE) {
      throw new Error(`WALLET_${account.status}: This wallet is currently ${account.status}.`);
    }
    return { user, account };
  }

  async submitDepositRequest(params: {
    userId: string;
    accountId: string;
    amountMinor: number;
    currency: Currency;
    method: string;
    paymentReference: string;
    proofDataUrl: string;
    idempotencyKey: string;
  }): Promise<DepositRequestRecord> {
    const { account } = this.ensureAccountOperable(params.userId, params.accountId);
    if (account.currency !== params.currency) {
      throw new Error('CURRENCY_MISMATCH: Deposit currency does not match selected wallet.');
    }

    const normalizedRef = params.paymentReference.trim().toUpperCase();

    return dbStore.runInTransaction([`deposit_ref:${normalizedRef}`, `account:${account.id}`], async () => {
      const idem = dbStore.checkIdempotency('dep', params.userId, params.idempotencyKey, {
        accountId: params.accountId,
        amountMinor: params.amountMinor,
        currency: params.currency,
        method: params.method,
        paymentReference: normalizedRef,
      });
      if (idem.hit) {
        return idem.record.body as DepositRequestRecord;
      }

      // Duplicate payment-reference detection across non-rejected deposits
      for (const existing of dbStore.depositRequests.values()) {
        if (
          existing.paymentReference.toUpperCase() === normalizedRef &&
          existing.status !== DepositStatus.REJECTED
        ) {
          riskService.raiseFlag({
            userId: params.userId,
            rule: 'DUPLICATE_DEPOSIT_REFERENCE',
            severity: RiskSeverity.MEDIUM,
            details: `User attempted to submit duplicate payment reference ${normalizedRef}.`,
          });
          throw new Error(`DUPLICATE_REFERENCE: Payment reference ${normalizedRef} has already been submitted.`);
        }
      }

      const match = params.proofDataUrl.match(/^data:([^;]+);base64,(.+)$/);
      const mimeType = match ? match[1] : 'image/png';
      const rawBuf = match ? Buffer.from(match[2], 'base64') : Buffer.from(params.proofDataUrl, 'utf8');
      const now = new Date().toISOString();
      const storageKey = `private/deposit-proofs/${params.userId}/${randomUUID()}`;
      dbStore.privateBlobs.set(storageKey, {
        storageKey,
        mimeType,
        encryptedPayload: encryptBuffer(rawBuf),
        ownerUserId: params.userId,
        createdAt: now,
      });

      const reqRecord: DepositRequestRecord = {
        id: `dep_${randomUUID()}`,
        userId: params.userId,
        accountId: account.id,
        amountMinor: params.amountMinor,
        currency: params.currency,
        method: params.method,
        proofStorageKey: storageKey,
        paymentReference: normalizedRef,
        status: DepositStatus.PENDING,
        makerId: null,
        checkerId: null,
        decidedAt: null,
        notes: null,
        version: 1,
        updatedAt: now,
        createdAt: now,
      };
      dbStore.depositRequests.set(reqRecord.id, reqRecord);
      const idemRec = dbStore.recordIdempotencyResponse({
        cacheKey: idem.cacheKey,
        scope: 'dep',
        userId: params.userId,
        key: params.idempotencyKey,
        payloadHash: idem.payloadHash,
        statusCode: 201,
        body: reqRecord,
      });

      await notificationService.enqueue({
        userId: params.userId,
        channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH, NotificationChannel.EMAIL],
        template: 'DEPOSIT_SUBMITTED_v1',
        body: `Deposit request of ${formatMinorUnits(params.amountMinor, params.currency)} (${normalizedRef}) submitted for verification.`,
      });

      // Notify active finance/super-admin operators immediately in Back-Office
      for (const staff of dbStore.users.values()) {
        if (ADMIN_ROLES.includes(staff.role) && staff.staffStatus === 'APPROVED') {
          await notificationService.enqueue({
            userId: staff.id,
            channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH],
            template: 'ADMIN_NEW_DEPOSIT_v1',
            body: `New deposit request ${normalizedRef} (${formatMinorUnits(params.amountMinor, params.currency)}) awaiting Maker review.`,
          });
        }
      }

      recordAuditLog({
        actorId: params.userId,
        actorType: 'USER',
        action: 'DEPOSIT_REQUESTED',
        entity: `deposit:${reqRecord.id}`,
        after: { amountMinor: params.amountMinor, currency: params.currency, reference: normalizedRef },
      });

      const rev = await dbStore.persistImmediate([
        { collection: 'deposit_requests', id: reqRecord.id, data: reqRecord as unknown as Record<string, unknown> },
        { collection: 'idempotency_keys', id: idem.cacheKey, data: idemRec as unknown as Record<string, unknown> },
      ]);

      broadcastSyncEvent({
        type: 'DEPOSIT_CREATED',
        syncRevision: rev,
        syncedAt: dbStore.lastSyncedAt,
        entityId: reqRecord.id,
        targetUserIds: [params.userId],
        notifyAdmins: true,
      });

      return reqRecord;
    });
  }

  async makerApproveDeposit(depositId: string, makerId: string, notes?: string, expectedStatus?: DepositStatus) {
    return dbStore.runInTransaction([`deposit:${depositId}`], async () => {
      const dep = dbStore.depositRequests.get(depositId);
      if (!dep) throw new Error('Deposit request not found');
      if (expectedStatus && dep.status !== expectedStatus) {
        throw new Error(`STATE_CONFLICT: Deposit status already changed to ${dep.status} on another session.`);
      }
      if (dep.status !== DepositStatus.PENDING) {
        throw new Error(`INVALID_STATE: Deposit is currently ${dep.status}.`);
      }
      if (dep.userId === makerId) {
        throw new Error('SEGREGATION_OF_DUTIES: Staff cannot approve their own deposit.');
      }

      const before = { status: dep.status, makerId: dep.makerId };
      dep.makerId = makerId;
      dep.notes = notes || null;
      dep.version = (dep.version ?? 1) + 1;
      dep.updatedAt = new Date().toISOString();

      if (dep.amountMinor < dbStore.makerCheckerThresholdMinor) {
        await this.finalizeDepositPosting(dep, makerId);
      } else {
        dep.status = DepositStatus.MAKER_APPROVED;
      }

      recordAuditLog({
        actorId: makerId,
        actorType: 'ADMIN',
        action: 'DEPOSIT_MAKER_APPROVED',
        entity: `deposit:${dep.id}`,
        before,
        after: { status: dep.status, makerId: dep.makerId },
      });

      const rev = await dbStore.persistImmediate([
        { collection: 'deposit_requests', id: dep.id, data: dep as unknown as Record<string, unknown> },
      ]);

      broadcastSyncEvent({
        type: 'DEPOSIT_UPDATED',
        syncRevision: rev,
        syncedAt: dbStore.lastSyncedAt,
        entityId: dep.id,
        targetUserIds: [dep.userId],
        notifyAdmins: true,
      });

      return dep;
    });
  }

  async checkerApproveDeposit(depositId: string, checkerId: string, notes?: string, expectedStatus?: DepositStatus) {
    return dbStore.runInTransaction([`deposit:${depositId}`], async () => {
      const dep = dbStore.depositRequests.get(depositId);
      if (!dep) throw new Error('Deposit request not found');
      if (expectedStatus && dep.status !== expectedStatus) {
        throw new Error(`STATE_CONFLICT: Deposit status already changed to ${dep.status} on another session.`);
      }
      if (dep.status !== DepositStatus.MAKER_APPROVED) {
        throw new Error(`INVALID_STATE: Deposit must be MAKER_APPROVED before checker approval (current: ${dep.status}).`);
      }
      if (dep.makerId === checkerId) {
        throw new Error('MAKER_CHECKER_VIOLATION: Checker must be a different person from the Maker.');
      }

      const before = { status: dep.status, checkerId: dep.checkerId };
      if (notes) dep.notes = notes;
      dep.version = (dep.version ?? 1) + 1;
      dep.updatedAt = new Date().toISOString();
      await this.finalizeDepositPosting(dep, checkerId);

      recordAuditLog({
        actorId: checkerId,
        actorType: 'ADMIN',
        action: 'DEPOSIT_CHECKER_APPROVED',
        entity: `deposit:${dep.id}`,
        before,
        after: { status: dep.status, checkerId: dep.checkerId },
      });

      const rev = await dbStore.persistImmediate([
        { collection: 'deposit_requests', id: dep.id, data: dep as unknown as Record<string, unknown> },
      ]);

      broadcastSyncEvent({
        type: 'DEPOSIT_UPDATED',
        syncRevision: rev,
        syncedAt: dbStore.lastSyncedAt,
        entityId: dep.id,
        targetUserIds: [dep.userId],
        notifyAdmins: true,
      });

      return dep;
    });
  }

  private async finalizeDepositPosting(dep: DepositRequestRecord, approverId: string) {
    const userLedger = dbStore.getUserWalletLedgerAccount(dep.accountId);
    if (!userLedger) throw new Error('User ledger wallet not found');
    const bankSettlement = dbStore.getSystemLedgerAccount(LedgerAccountType.BANK_SETTLEMENT, dep.currency);

    await ledgerService.postAtomicTransaction({
      type: TransactionType.DEPOSIT,
      amountMinor: dep.amountMinor,
      feeMinor: 0,
      currency: dep.currency,
      fromAccountId: null,
      toAccountId: dep.accountId,
      reference: dep.paymentReference,
      idempotencyKey: `dep_post_${dep.id}`,
      description: `Approved ${dep.method} deposit (${dep.paymentReference})`,
      legs: [
        {
          ledgerAccountId: bankSettlement.id,
          direction: JournalDirection.DEBIT,
          amountMinor: dep.amountMinor,
          currency: dep.currency,
        },
        {
          ledgerAccountId: userLedger.id,
          direction: JournalDirection.CREDIT,
          amountMinor: dep.amountMinor,
          currency: dep.currency,
        },
      ],
      metadata: { depositRequestId: dep.id, method: dep.method },
    });

    dep.checkerId = dep.makerId === approverId ? null : approverId;
    dep.status = DepositStatus.APPROVED;
    dep.decidedAt = new Date().toISOString();
    dep.updatedAt = dep.decidedAt;

    await notificationService.enqueue({
      userId: dep.userId,
      channels: [NotificationChannel.IN_APP, NotificationChannel.EMAIL, NotificationChannel.PUSH],
      template: 'DEPOSIT_APPROVED_v1',
      body: `Your deposit of ${formatMinorUnits(dep.amountMinor, dep.currency)} (${dep.paymentReference}) has been credited.`,
    });
  }

  async rejectDeposit(depositId: string, staffId: string, reason: string, expectedStatus?: DepositStatus) {
    if (!reason || reason.trim().length < 3) {
      throw new Error('REJECTION_REASON_REQUIRED: Rejection requires a clear reason.');
    }
    return dbStore.runInTransaction([`deposit:${depositId}`], async () => {
      const dep = dbStore.depositRequests.get(depositId);
      if (!dep) throw new Error('Deposit request not found');
      if (expectedStatus && dep.status !== expectedStatus) {
        throw new Error(`STATE_CONFLICT: Deposit status already changed to ${dep.status} on another session.`);
      }
      if (dep.status === DepositStatus.APPROVED || dep.status === DepositStatus.REJECTED) {
        throw new Error(`INVALID_STATE: Deposit is already ${dep.status}.`);
      }
      const before = { status: dep.status };
      const now = new Date().toISOString();
      dep.status = DepositStatus.REJECTED;
      dep.notes = reason.trim();
      dep.decidedAt = now;
      dep.updatedAt = now;
      dep.version = (dep.version ?? 1) + 1;
      if (!dep.makerId) dep.makerId = staffId;
      else if (dep.makerId !== staffId) dep.checkerId = staffId;

      await notificationService.enqueue({
        userId: dep.userId,
        channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH, NotificationChannel.EMAIL],
        template: 'DEPOSIT_REJECTED_v1',
        body: `Deposit ${dep.paymentReference} was declined: ${dep.notes}`,
      });

      recordAuditLog({
        actorId: staffId,
        actorType: 'ADMIN',
        action: 'DEPOSIT_REJECTED',
        entity: `deposit:${dep.id}`,
        before,
        after: { status: dep.status, reason: dep.notes },
      });

      const rev = await dbStore.persistImmediate([
        { collection: 'deposit_requests', id: dep.id, data: dep as unknown as Record<string, unknown> },
      ]);

      broadcastSyncEvent({
        type: 'DEPOSIT_UPDATED',
        syncRevision: rev,
        syncedAt: dbStore.lastSyncedAt,
        entityId: dep.id,
        targetUserIds: [dep.userId],
        notifyAdmins: true,
      });

      return dep;
    });
  }

  /**
   * Wallet-to-wallet P2P transfer with ordered account locks, fee calculation, limits, and idempotency.
   */
  async executeTransfer(params: {
    userId: string;
    fromAccountId: string;
    toAccountNumber: string;
    amountMinor: number;
    note?: string;
    idempotencyKey: string;
  }): Promise<TransactionRecord> {
    const { user: sender, account: fromAccount } = this.ensureAccountOperable(params.userId, params.fromAccountId);

    const toAccount = [...dbStore.accounts.values()].find((a) => a.accountNumber === params.toAccountNumber);
    if (!toAccount) {
      throw new Error('RECIPIENT_NOT_FOUND: Recipient account number does not exist.');
    }
    if (toAccount.id === fromAccount.id) {
      throw new Error('SELF_TRANSFER_FORBIDDEN: Cannot transfer to the same wallet.');
    }
    if (toAccount.currency !== fromAccount.currency) {
      throw new Error(`CURRENCY_MISMATCH: Recipient account is ${toAccount.currency}, not ${fromAccount.currency}.`);
    }
    if (toAccount.status !== AccountStatus.ACTIVE) {
      throw new Error('RECIPIENT_UNAVAILABLE: Recipient wallet is not active.');
    }
    const recipientUser = dbStore.users.get(toAccount.userId);
    if (!recipientUser || recipientUser.status !== UserStatus.ACTIVE) {
      throw new Error('RECIPIENT_UNAVAILABLE: Recipient account is restricted.');
    }

    const currency = fromAccount.currency;
    const feeMinor = rulesService.computeFee(TransactionType.TRANSFER, currency, params.amountMinor);
    const totalDebitMinor = params.amountMinor + feeMinor;

    const fromLedger = dbStore.getUserWalletLedgerAccount(fromAccount.id);
    const toLedger = dbStore.getUserWalletLedgerAccount(toAccount.id);
    const feeLedger = dbStore.getSystemLedgerAccount(LedgerAccountType.FEE_REVENUE, currency);
    if (!fromLedger || !toLedger) throw new Error('Ledger account configuration missing');

    const lockKeys = [`account:${fromAccount.id}`, `account:${toAccount.id}`];

    return dbStore.runInTransaction(lockKeys, async () => {
      const idem = dbStore.checkIdempotency('trf', params.userId, params.idempotencyKey, {
        fromAccountId: params.fromAccountId,
        toAccountNumber: params.toAccountNumber,
        amountMinor: params.amountMinor,
        note: params.note || '',
      });
      if (idem.hit) {
        return idem.record.body as TransactionRecord;
      }

      rulesService.assertWithinLimits({
        userId: sender.id,
        kycTier: sender.kycTier,
        accountId: fromAccount.id,
        transactionType: TransactionType.TRANSFER,
        currency,
        amountMinor: params.amountMinor,
      });

      riskService.evaluateTransactionRisk(sender.id, TransactionType.TRANSFER, params.amountMinor);

      const legs = [
        {
          ledgerAccountId: fromLedger.id,
          direction: JournalDirection.DEBIT,
          amountMinor: totalDebitMinor,
          currency,
        },
        {
          ledgerAccountId: toLedger.id,
          direction: JournalDirection.CREDIT,
          amountMinor: params.amountMinor,
          currency,
        },
      ];

      if (feeMinor > 0) {
        legs.push({
          ledgerAccountId: feeLedger.id,
          direction: JournalDirection.CREDIT,
          amountMinor: feeMinor,
          currency,
        });
      }

      const ref = `TRF-${randomUUID().slice(0, 8).toUpperCase()}`;
      const posted = await ledgerService.postAtomicTransaction({
        type: TransactionType.TRANSFER,
        amountMinor: params.amountMinor,
        feeMinor,
        currency,
        fromAccountId: fromAccount.id,
        toAccountId: toAccount.id,
        reference: ref,
        idempotencyKey: params.idempotencyKey,
        description: params.note
          ? `Transfer to ${toAccount.accountNumber}: ${params.note}`
          : `Transfer to ${toAccount.accountNumber}`,
        legs,
        metadata: {
          senderAccountNumber: fromAccount.accountNumber,
          recipientAccountNumber: toAccount.accountNumber,
          note: params.note || null,
        },
      });

      const idemRec = dbStore.recordIdempotencyResponse({
        cacheKey: idem.cacheKey,
        scope: 'trf',
        userId: params.userId,
        key: params.idempotencyKey,
        payloadHash: idem.payloadHash,
        statusCode: 201,
        body: posted.transaction,
      });

      await notificationService.enqueue({
        userId: sender.id,
        channels: [NotificationChannel.IN_APP, NotificationChannel.EMAIL, NotificationChannel.PUSH],
        template: 'TRANSFER_SENT_v1',
        body: `Sent ${formatMinorUnits(params.amountMinor, currency)} (fee ${formatMinorUnits(feeMinor, currency)}) to ${toAccount.accountNumber}. Ref: ${ref}.`,
      });

      await notificationService.enqueue({
        userId: recipientUser.id,
        channels: [NotificationChannel.IN_APP, NotificationChannel.EMAIL, NotificationChannel.PUSH],
        template: 'TRANSFER_RECEIVED_v1',
        body: `Received ${formatMinorUnits(params.amountMinor, currency)} from account ${fromAccount.accountNumber}. Ref: ${ref}.`,
      });

      recordAuditLog({
        actorId: sender.id,
        actorType: 'USER',
        action: 'TRANSFER_EXECUTED',
        entity: `transaction:${posted.transaction.id}`,
        after: {
          amountMinor: params.amountMinor,
          feeMinor,
          currency,
          toAccountNumber: toAccount.accountNumber,
          reference: ref,
        },
      });

      const rev = await dbStore.persistImmediate([
        { collection: 'idempotency_keys', id: idem.cacheKey, data: idemRec as unknown as Record<string, unknown> },
      ]);

      broadcastSyncEvent({
        type: 'TRANSFER_COMPLETED',
        syncRevision: rev,
        syncedAt: dbStore.lastSyncedAt,
        entityId: posted.transaction.id,
        targetUserIds: [sender.id, recipientUser.id],
        notifyAdmins: true,
      });

      return posted.transaction;
    });
  }

  /**
   * Withdrawal request: checks limits (USD 100/day, USD 1,000/month), moves funds immediately
   * from user_wallet to withdrawal_hold ledger account inside an atomic transaction.
   */
  async requestWithdrawal(params: {
    userId: string;
    accountId: string;
    amountMinor: number;
    method: string;
    destinationLabel: string;
    idempotencyKey: string;
  }): Promise<WithdrawalRequestRecord> {
    const { user, account } = this.ensureAccountOperable(params.userId, params.accountId);
    const currency = account.currency;
    const userLedger = dbStore.getUserWalletLedgerAccount(account.id);
    const holdLedger = dbStore.getSystemLedgerAccount(LedgerAccountType.WITHDRAWAL_HOLD, currency);
    if (!userLedger) throw new Error('User ledger account missing');

    return dbStore.runInTransaction([`account:${account.id}`], async () => {
      const idem = dbStore.checkIdempotency('wdr_req', params.userId, params.idempotencyKey, {
        accountId: params.accountId,
        amountMinor: params.amountMinor,
        method: params.method,
        destinationLabel: params.destinationLabel,
      });
      if (idem.hit) {
        return idem.record.body as WithdrawalRequestRecord;
      }

      rulesService.assertWithinLimits({
        userId: user.id,
        kycTier: user.kycTier,
        accountId: account.id,
        transactionType: TransactionType.WITHDRAWAL,
        currency,
        amountMinor: params.amountMinor,
      });

      riskService.evaluateTransactionRisk(user.id, TransactionType.WITHDRAWAL, params.amountMinor);

      const reqId = `wdr_${randomUUID()}`;
      const ref = `WDR-${randomUUID().slice(0, 8).toUpperCase()}`;

      await ledgerService.postAtomicTransaction({
        type: TransactionType.WITHDRAWAL,
        amountMinor: params.amountMinor,
        feeMinor: 0,
        currency,
        fromAccountId: account.id,
        toAccountId: null,
        reference: ref,
        idempotencyKey: `wdr_hold_${params.idempotencyKey}`,
        description: `Withdrawal hold (${params.method})`,
        legs: [
          {
            ledgerAccountId: userLedger.id,
            direction: JournalDirection.DEBIT,
            amountMinor: params.amountMinor,
            currency,
          },
          {
            ledgerAccountId: holdLedger.id,
            direction: JournalDirection.CREDIT,
            amountMinor: params.amountMinor,
            currency,
          },
        ],
        metadata: { withdrawalRequestId: reqId, stage: 'HOLD_PLACED', method: params.method },
      });

      const now = new Date().toISOString();
      const maskedDest = `${params.method}: ••••${params.destinationLabel.slice(-4)}`;
      const wdr: WithdrawalRequestRecord = {
        id: reqId,
        userId: user.id,
        accountId: account.id,
        amountMinor: params.amountMinor,
        currency,
        destinationDetailsEncrypted: encryptField(`${params.method}|${params.destinationLabel}`),
        destinationPreview: maskedDest,
        status: WithdrawalStatus.PENDING,
        makerId: null,
        checkerId: null,
        payoutReference: null,
        decidedAt: null,
        rejectionReason: null,
        version: 1,
        updatedAt: now,
        createdAt: now,
      };
      dbStore.withdrawalRequests.set(wdr.id, wdr);
      const idemRec = dbStore.recordIdempotencyResponse({
        cacheKey: idem.cacheKey,
        scope: 'wdr_req',
        userId: user.id,
        key: params.idempotencyKey,
        payloadHash: idem.payloadHash,
        statusCode: 201,
        body: wdr,
      });

      await notificationService.enqueue({
        userId: user.id,
        channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH, NotificationChannel.EMAIL, NotificationChannel.SMS],
        template: 'WITHDRAWAL_REQUESTED_v1',
        body: `Withdrawal request for ${formatMinorUnits(params.amountMinor, currency)} placed in hold pending review.`,
      });

      recordAuditLog({
        actorId: user.id,
        actorType: 'USER',
        action: 'WITHDRAWAL_REQUESTED',
        entity: `withdrawal:${wdr.id}`,
        after: { amountMinor: params.amountMinor, currency, destinationPreview: maskedDest },
      });

      const rev = await dbStore.persistImmediate([
        { collection: 'withdrawal_requests', id: wdr.id, data: wdr as unknown as Record<string, unknown> },
        { collection: 'idempotency_keys', id: idem.cacheKey, data: idemRec as unknown as Record<string, unknown> },
      ]);

      broadcastSyncEvent({
        type: 'WITHDRAWAL_CREATED',
        syncRevision: rev,
        syncedAt: dbStore.lastSyncedAt,
        entityId: wdr.id,
        targetUserIds: [user.id],
        notifyAdmins: true,
      });

      return wdr;
    });
  }

  async makerApproveWithdrawal(withdrawalId: string, makerId: string, expectedStatus?: WithdrawalStatus) {
    return dbStore.runInTransaction([`withdrawal:${withdrawalId}`], async () => {
      const wdr = dbStore.withdrawalRequests.get(withdrawalId);
      if (!wdr) throw new Error('Withdrawal request not found');
      if (expectedStatus && wdr.status !== expectedStatus) {
        throw new Error(`STATE_CONFLICT: Withdrawal status already changed to ${wdr.status} on another session.`);
      }
      if (wdr.status !== WithdrawalStatus.PENDING) {
        throw new Error(`INVALID_STATE: Withdrawal is ${wdr.status}`);
      }
      if (wdr.userId === makerId) {
        throw new Error('SEGREGATION_OF_DUTIES: Staff cannot approve their own withdrawal.');
      }
      const before = { status: wdr.status };
      wdr.makerId = makerId;
      wdr.status =
        wdr.amountMinor < dbStore.makerCheckerThresholdMinor
          ? WithdrawalStatus.CHECKER_APPROVED
          : WithdrawalStatus.MAKER_APPROVED;
      wdr.version = (wdr.version ?? 1) + 1;
      wdr.updatedAt = new Date().toISOString();

      recordAuditLog({
        actorId: makerId,
        actorType: 'ADMIN',
        action: 'WITHDRAWAL_MAKER_APPROVED',
        entity: `withdrawal:${wdr.id}`,
        before,
        after: { status: wdr.status, makerId },
      });

      const rev = await dbStore.persistImmediate([
        { collection: 'withdrawal_requests', id: wdr.id, data: wdr as unknown as Record<string, unknown> },
      ]);

      broadcastSyncEvent({
        type: 'WITHDRAWAL_UPDATED',
        syncRevision: rev,
        syncedAt: dbStore.lastSyncedAt,
        entityId: wdr.id,
        targetUserIds: [wdr.userId],
        notifyAdmins: true,
      });

      return wdr;
    });
  }

  async checkerApproveWithdrawal(withdrawalId: string, checkerId: string, expectedStatus?: WithdrawalStatus) {
    return dbStore.runInTransaction([`withdrawal:${withdrawalId}`], async () => {
      const wdr = dbStore.withdrawalRequests.get(withdrawalId);
      if (!wdr) throw new Error('Withdrawal request not found');
      if (expectedStatus && wdr.status !== expectedStatus) {
        throw new Error(`STATE_CONFLICT: Withdrawal status already changed to ${wdr.status} on another session.`);
      }
      if (wdr.status !== WithdrawalStatus.MAKER_APPROVED) {
        throw new Error(`INVALID_STATE: Withdrawal must be MAKER_APPROVED first (current: ${wdr.status})`);
      }
      if (wdr.makerId === checkerId) {
        throw new Error('MAKER_CHECKER_VIOLATION: Checker must be a different person from the Maker.');
      }
      const before = { status: wdr.status };
      wdr.checkerId = checkerId;
      wdr.status = WithdrawalStatus.CHECKER_APPROVED;
      wdr.version = (wdr.version ?? 1) + 1;
      wdr.updatedAt = new Date().toISOString();

      recordAuditLog({
        actorId: checkerId,
        actorType: 'ADMIN',
        action: 'WITHDRAWAL_CHECKER_APPROVED',
        entity: `withdrawal:${wdr.id}`,
        before,
        after: { status: wdr.status, checkerId },
      });

      const rev = await dbStore.persistImmediate([
        { collection: 'withdrawal_requests', id: wdr.id, data: wdr as unknown as Record<string, unknown> },
      ]);

      broadcastSyncEvent({
        type: 'WITHDRAWAL_UPDATED',
        syncRevision: rev,
        syncedAt: dbStore.lastSyncedAt,
        entityId: wdr.id,
        targetUserIds: [wdr.userId],
        notifyAdmins: true,
      });

      return wdr;
    });
  }

  async markWithdrawalPaid(withdrawalId: string, staffId: string, payoutReference: string, expectedStatus?: WithdrawalStatus) {
    if (!payoutReference || payoutReference.trim().length < 4) {
      throw new Error('PAYOUT_REFERENCE_REQUIRED: External bank/mobile-money payout reference is required.');
    }
    return dbStore.runInTransaction([`withdrawal:${withdrawalId}`], async () => {
      const wdr = dbStore.withdrawalRequests.get(withdrawalId);
      if (!wdr) throw new Error('Withdrawal request not found');
      if (expectedStatus && wdr.status !== expectedStatus) {
        throw new Error(`STATE_CONFLICT: Withdrawal status already changed to ${wdr.status} on another session.`);
      }
      if (wdr.status !== WithdrawalStatus.CHECKER_APPROVED) {
        throw new Error(`INVALID_STATE: Withdrawal must be CHECKER_APPROVED before payout (current: ${wdr.status})`);
      }
      const holdLedger = dbStore.getSystemLedgerAccount(LedgerAccountType.WITHDRAWAL_HOLD, wdr.currency);
      const settlementLedger = dbStore.getSystemLedgerAccount(LedgerAccountType.BANK_SETTLEMENT, wdr.currency);

      await ledgerService.postAtomicTransaction({
        type: TransactionType.WITHDRAWAL,
        amountMinor: wdr.amountMinor,
        feeMinor: 0,
        currency: wdr.currency,
        fromAccountId: wdr.accountId,
        toAccountId: null,
        reference: payoutReference.trim().toUpperCase(),
        idempotencyKey: `wdr_paid_${wdr.id}`,
        description: `Withdrawal payout settled (${payoutReference.trim().toUpperCase()})`,
        legs: [
          {
            ledgerAccountId: holdLedger.id,
            direction: JournalDirection.DEBIT,
            amountMinor: wdr.amountMinor,
            currency: wdr.currency,
          },
          {
            ledgerAccountId: settlementLedger.id,
            direction: JournalDirection.CREDIT,
            amountMinor: wdr.amountMinor,
            currency: wdr.currency,
          },
        ],
        metadata: { withdrawalRequestId: wdr.id, stage: 'PAID_OUT' },
      });

      const before = { status: wdr.status };
      const now = new Date().toISOString();
      wdr.status = WithdrawalStatus.PAID;
      wdr.payoutReference = payoutReference.trim().toUpperCase();
      wdr.decidedAt = now;
      wdr.updatedAt = now;
      wdr.version = (wdr.version ?? 1) + 1;

      await notificationService.enqueue({
        userId: wdr.userId,
        channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH, NotificationChannel.EMAIL, NotificationChannel.SMS],
        template: 'WITHDRAWAL_PAID_v1',
        body: `Your withdrawal of ${formatMinorUnits(wdr.amountMinor, wdr.currency)} has been paid out. Ref: ${wdr.payoutReference}.`,
      });

      recordAuditLog({
        actorId: staffId,
        actorType: 'ADMIN',
        action: 'WITHDRAWAL_MARKED_PAID',
        entity: `withdrawal:${wdr.id}`,
        before,
        after: { status: wdr.status, payoutReference: wdr.payoutReference },
      });

      const rev = await dbStore.persistImmediate([
        { collection: 'withdrawal_requests', id: wdr.id, data: wdr as unknown as Record<string, unknown> },
      ]);

      broadcastSyncEvent({
        type: 'WITHDRAWAL_UPDATED',
        syncRevision: rev,
        syncedAt: dbStore.lastSyncedAt,
        entityId: wdr.id,
        targetUserIds: [wdr.userId],
        notifyAdmins: true,
      });

      return wdr;
    });
  }

  async rejectWithdrawal(withdrawalId: string, staffId: string, reason: string, expectedStatus?: WithdrawalStatus) {
    if (!reason || reason.trim().length < 3) {
      throw new Error('REJECTION_REASON_REQUIRED');
    }
    return dbStore.runInTransaction([`withdrawal:${withdrawalId}`], async () => {
      const wdr = dbStore.withdrawalRequests.get(withdrawalId);
      if (!wdr) throw new Error('Withdrawal request not found');
      if (expectedStatus && wdr.status !== expectedStatus) {
        throw new Error(`STATE_CONFLICT: Withdrawal status already changed to ${wdr.status} on another session.`);
      }
      if (wdr.status === WithdrawalStatus.PAID || wdr.status === WithdrawalStatus.REJECTED) {
        throw new Error(`INVALID_STATE: Withdrawal is already ${wdr.status}`);
      }

      const userLedger = dbStore.getUserWalletLedgerAccount(wdr.accountId);
      const holdLedger = dbStore.getSystemLedgerAccount(LedgerAccountType.WITHDRAWAL_HOLD, wdr.currency);
      if (!userLedger) throw new Error('User ledger account missing');

      await ledgerService.postAtomicTransaction({
        type: TransactionType.REVERSAL,
        amountMinor: wdr.amountMinor,
        feeMinor: 0,
        currency: wdr.currency,
        fromAccountId: null,
        toAccountId: wdr.accountId,
        reference: `REL-${wdr.id.slice(0, 10).toUpperCase()}`,
        idempotencyKey: `wdr_reject_${wdr.id}`,
        description: `Withdrawal rejected — hold released: ${reason.trim()}`,
        legs: [
          {
            ledgerAccountId: holdLedger.id,
            direction: JournalDirection.DEBIT,
            amountMinor: wdr.amountMinor,
            currency: wdr.currency,
          },
          {
            ledgerAccountId: userLedger.id,
            direction: JournalDirection.CREDIT,
            amountMinor: wdr.amountMinor,
            currency: wdr.currency,
          },
        ],
        metadata: { withdrawalRequestId: wdr.id, stage: 'HOLD_RELEASED', reason: reason.trim() },
      });

      const before = { status: wdr.status };
      const now = new Date().toISOString();
      wdr.status = WithdrawalStatus.REJECTED;
      wdr.rejectionReason = reason.trim();
      wdr.decidedAt = now;
      wdr.updatedAt = now;
      wdr.version = (wdr.version ?? 1) + 1;

      await notificationService.enqueue({
        userId: wdr.userId,
        channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH, NotificationChannel.EMAIL],
        template: 'WITHDRAWAL_REJECTED_v1',
        body: `Your withdrawal of ${formatMinorUnits(wdr.amountMinor, wdr.currency)} was declined and funds were returned to your wallet. Reason: ${wdr.rejectionReason}`,
      });

      recordAuditLog({
        actorId: staffId,
        actorType: 'ADMIN',
        action: 'WITHDRAWAL_REJECTED_HOLD_RELEASED',
        entity: `withdrawal:${wdr.id}`,
        before,
        after: { status: wdr.status, reason: wdr.rejectionReason },
      });

      const rev = await dbStore.persistImmediate([
        { collection: 'withdrawal_requests', id: wdr.id, data: wdr as unknown as Record<string, unknown> },
      ]);

      broadcastSyncEvent({
        type: 'WITHDRAWAL_UPDATED',
        syncRevision: rev,
        syncedAt: dbStore.lastSyncedAt,
        entityId: wdr.id,
        targetUserIds: [wdr.userId],
        notifyAdmins: true,
      });

      return wdr;
    });
  }

  listUserTransactions(userId: string, accountId?: string): TransactionRecord[] {
    const userAccountIds = new Set(
      [...dbStore.accounts.values()]
        .filter((a) => a.userId === userId && (!accountId || a.id === accountId))
        .map((a) => a.id),
    );
    return [...dbStore.transactions.values()]
      .filter((t) => (t.fromAccountId && userAccountIds.has(t.fromAccountId)) || (t.toAccountId && userAccountIds.has(t.toAccountId)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  listDepositsForUser(userId: string) {
    return [...dbStore.depositRequests.values()]
      .filter((d) => d.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((d) => ({ ...d, proofSignedUrl: signStorageKey(d.proofStorageKey, 60).url }));
  }

  listWithdrawalsForUser(userId: string) {
    return [...dbStore.withdrawalRequests.values()]
      .filter((w) => w.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

export const transactionsService = new TransactionsService();
