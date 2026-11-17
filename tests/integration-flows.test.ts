import { beforeEach, describe, expect, it } from 'vitest';
import {
  Currency,
  DepositStatus,
  KycStatus,
  Role,
  UserStatus,
  WithdrawalStatus,
} from '../src/shared/types.ts';
import { dbStore } from '../src/server/db/store.ts';
import { kycService } from '../src/server/modules/kyc/kyc.service.ts';
import { accountsService } from '../src/server/modules/accounts/accounts.service.ts';
import { transactionsService } from '../src/server/modules/transactions/transactions.service.ts';
import { ledgerService } from '../src/server/modules/ledger/ledger.service.ts';
import { authService } from '../src/server/modules/auth/auth.service.ts';

function seedUser(id: string, email: string, name: string) {
  dbStore.users.set(id, {
    id,
    email,
    phone: null,
    passwordHash: null,
    googleId: null,
    role: Role.USER,
    staffStatus: 'NONE',
    requestedRole: null,
    status: UserStatus.ACTIVE,
    freezeReason: null,
    kycStatus: KycStatus.NOT_SUBMITTED,
    kycTier: 0,
    emailVerified: true,
    phoneVerified: true,
    totpEnabled: false,
    legalAcceptedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  });
  dbStore.userProfiles.set(id, {
    userId: id,
    fullName: name,
    dateOfBirth: '1992-03-10',
    nationalIdEncrypted: 'enc',
    address: 'Harare',
    country: 'ZW',
    updatedAt: new Date().toISOString(),
  });
}

describe('Integration Flows: KYC, Maker-Checker Deposits, Concurrent Transfers, Idempotency & Withdrawals', () => {
  beforeEach(() => {
    dbStore.resetForTests();
    seedUser('u_sender', 'sender@wallet.zw', 'Tendai Moyo');
    seedUser('u_recv', 'recv@wallet.zw', 'Rumbidzai Chikwanda');
  });

  it('runs end-to-end KYC -> Deposit (Maker-Checker + Duplicate Ref) -> Concurrent P2P Transfers -> Withdrawal Hold/Reject/Pay', async () => {
    // 1. KYC approval creates wallets and 10-digit Luhn account numbers
    await kycService.decideKyc({ targetUserId: 'u_sender', officerId: 'kyc_1', decision: 'APPROVED' });
    await kycService.decideKyc({ targetUserId: 'u_recv', officerId: 'kyc_1', decision: 'APPROVED' });

    const senderUsd = accountsService.listUserAccounts('u_sender').find((a) => a.currency === Currency.USD)!;
    const recvUsd = accountsService.listUserAccounts('u_recv').find((a) => a.currency === Currency.USD)!;
    expect(senderUsd.accountNumber).toMatch(/^\d{10}$/);

    // 2. Deposit request + duplicate reference rejection + Maker != Checker
    const dep = await transactionsService.submitDepositRequest({
      userId: 'u_sender',
      accountId: senderUsd.id,
      amountMinor: 20000, // $200.00
      currency: Currency.USD,
      method: 'ECOCASH',
      paymentReference: 'ECO-REF-1001',
      proofDataUrl: 'data:text/plain;base64,cHJvb2Y=',
      idempotencyKey: 'dep_idem_1',
    });
    expect(dep.status).toBe(DepositStatus.PENDING);

    await expect(
      transactionsService.submitDepositRequest({
        userId: 'u_sender',
        accountId: senderUsd.id,
        amountMinor: 20000,
        currency: Currency.USD,
        method: 'ECOCASH',
        paymentReference: 'eco-ref-1001',
        proofDataUrl: 'data:text/plain;base64,cHJvb2Y=',
        idempotencyKey: 'dep_idem_2',
      }),
    ).rejects.toThrow(/DUPLICATE_REFERENCE/);

    await transactionsService.makerApproveDeposit(dep.id, 'maker_1');
    await expect(transactionsService.checkerApproveDeposit(dep.id, 'maker_1')).rejects.toThrow(/MAKER_CHECKER_VIOLATION/);
    const approvedDep = await transactionsService.checkerApproveDeposit(dep.id, 'checker_1');
    expect(approvedDep.status).toBe(DepositStatus.APPROVED);
    expect(accountsService.getVerifiedBalance('u_sender', senderUsd.id).balanceMinor).toBe(20000);

    // 3. Idempotency retry on P2P transfer never double-debits
    const t1 = await transactionsService.executeTransfer({
      userId: 'u_sender',
      fromAccountId: senderUsd.id,
      toAccountNumber: recvUsd.accountNumber,
      amountMinor: 2000, // $20.00 + $0.20 fee = 2020
      idempotencyKey: 'trf_idem_abc',
    });
    const t1Retry = await transactionsService.executeTransfer({
      userId: 'u_sender',
      fromAccountId: senderUsd.id,
      toAccountNumber: recvUsd.accountNumber,
      amountMinor: 2000,
      idempotencyKey: 'trf_idem_abc',
    });
    expect(t1Retry.id).toBe(t1.id);
    expect(accountsService.getVerifiedBalance('u_sender', senderUsd.id).balanceMinor).toBe(17980);
    expect(accountsService.getVerifiedBalance('u_recv', recvUsd.id).balanceMinor).toBe(2000);

    // 4. Concurrent P2P transfers racing for remaining balance cannot overdraft
    // Remaining balance = 17980. Fire 4 concurrent $60.00 transfers (each costs 6040 -> max 2 can succeed!)
    const concurrentResults = await Promise.allSettled([
      transactionsService.executeTransfer({ userId: 'u_sender', fromAccountId: senderUsd.id, toAccountNumber: recvUsd.accountNumber, amountMinor: 6000, idempotencyKey: 'conc_1' }),
      transactionsService.executeTransfer({ userId: 'u_sender', fromAccountId: senderUsd.id, toAccountNumber: recvUsd.accountNumber, amountMinor: 6000, idempotencyKey: 'conc_2' }),
      transactionsService.executeTransfer({ userId: 'u_sender', fromAccountId: senderUsd.id, toAccountNumber: recvUsd.accountNumber, amountMinor: 6000, idempotencyKey: 'conc_3' }),
      transactionsService.executeTransfer({ userId: 'u_sender', fromAccountId: senderUsd.id, toAccountNumber: recvUsd.accountNumber, amountMinor: 6000, idempotencyKey: 'conc_4' }),
    ]);
    const succeeded = concurrentResults.filter((r) => r.status === 'fulfilled');
    const failed = concurrentResults.filter((r) => r.status === 'rejected');
    expect(succeeded.length).toBe(2);
    expect(failed.length).toBe(2);
    expect(accountsService.getVerifiedBalance('u_sender', senderUsd.id).balanceMinor).toBe(17980 - 2 * 6040);

    // 5. Withdrawal hold, daily limit ($100), rejection release, and paid payout
    // Sender currently has 5900 ($59.00)
    const w1 = await transactionsService.requestWithdrawal({
      userId: 'u_sender',
      accountId: senderUsd.id,
      amountMinor: 4000,
      method: 'ECOCASH',
      destinationLabel: '+263771234567',
      idempotencyKey: 'wdr_1',
    });
    expect(accountsService.getVerifiedBalance('u_sender', senderUsd.id).balanceMinor).toBe(1900);

    // Rejecting w1 releases funds back to user wallet
    const rejected = await transactionsService.rejectWithdrawal(w1.id, 'maker_1', 'Invalid EcoCash wallet name');
    expect(rejected.status).toBe(WithdrawalStatus.REJECTED);
    expect(accountsService.getVerifiedBalance('u_sender', senderUsd.id).balanceMinor).toBe(5900);

    // Request w2 and take through Maker -> Checker -> Paid
    const w2 = await transactionsService.requestWithdrawal({
      userId: 'u_sender',
      accountId: senderUsd.id,
      amountMinor: 5000,
      method: 'BANK_TRANSFER',
      destinationLabel: 'CBZ-00918273',
      idempotencyKey: 'wdr_2',
    });
    await transactionsService.makerApproveWithdrawal(w2.id, 'maker_1');
    await transactionsService.checkerApproveWithdrawal(w2.id, 'checker_1');
    const paid = await transactionsService.markWithdrawalPaid(w2.id, 'maker_1', 'CBZ-PAY-8812');
    expect(paid.status).toBe(WithdrawalStatus.PAID);
    expect(accountsService.getVerifiedBalance('u_sender', senderUsd.id).balanceMinor).toBe(900);
    expect(ledgerService.verifyGlobalInvariant().valid).toBe(true);
  });

  it('detects refresh token reuse and revokes the entire session family', () => {
    const user = dbStore.users.get('u_sender')!;
    const s0 = authService.createSession(user, {
      deviceFingerprint: 'fp1',
      deviceLabel: 'Pixel 7',
      ip: '10.0.0.1',
      userAgent: 'Chrome',
      twoFactorVerified: true,
    });
    const s1 = authService.rotateRefreshToken(s0.refreshToken);
    // Replay old s0 refresh token -> must revoke entire family
    expect(() => authService.rotateRefreshToken(s0.refreshToken)).toThrow(/TOKEN_REUSE_DETECTED/);
    // Even the newer s1 token is now revoked
    expect(() => authService.rotateRefreshToken(s1.refreshToken)).toThrow(/SESSION_REVOKED/);
  });

  it('enforces deposit idempotency replay/conflict, optimistic expectedStatus locks, and staff notification visibility', async () => {
    await kycService.decideKyc({ targetUserId: 'u_sender', officerId: 'kyc_1', decision: 'APPROVED' });
    const senderUsd = accountsService.listUserAccounts('u_sender').find((a) => a.currency === Currency.USD)!;

    dbStore.users.set('admin_maker', {
      id: 'admin_maker',
      email: 'maker@comfortwallet.zw',
      phone: null,
      passwordHash: null,
      googleId: null,
      role: Role.FINANCE_MAKER,
      staffStatus: 'APPROVED',
      requestedRole: Role.FINANCE_MAKER,
      status: UserStatus.ACTIVE,
      freezeReason: null,
      kycStatus: KycStatus.APPROVED,
      kycTier: 3,
      emailVerified: true,
      phoneVerified: true,
      totpEnabled: false,
      legalAcceptedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });

    const dep1 = await transactionsService.submitDepositRequest({
      userId: 'u_sender',
      accountId: senderUsd.id,
      amountMinor: 5000,
      currency: Currency.USD,
      method: 'INNBUCKS',
      paymentReference: 'INB-SYNC-9001',
      proofDataUrl: 'data:text/plain;base64,cHJvb2Y=',
      idempotencyKey: 'dep_idem_sync_1',
    });
    expect(dep1.id).toMatch(/^dep_/);
    expect(dep1.version).toBe(1);

    // Exact idempotency replay returns the identical deposit record
    const depReplay = await transactionsService.submitDepositRequest({
      userId: 'u_sender',
      accountId: senderUsd.id,
      amountMinor: 5000,
      currency: Currency.USD,
      method: 'INNBUCKS',
      paymentReference: 'INB-SYNC-9001',
      proofDataUrl: 'data:text/plain;base64,cHJvb2Y=',
      idempotencyKey: 'dep_idem_sync_1',
    });
    expect(depReplay.id).toBe(dep1.id);
    expect(dbStore.depositRequests.size).toBe(1);

    // Reusing the same idempotency key with different amount must throw IDEMPOTENCY_CONFLICT
    await expect(
      transactionsService.submitDepositRequest({
        userId: 'u_sender',
        accountId: senderUsd.id,
        amountMinor: 7500,
        currency: Currency.USD,
        method: 'INNBUCKS',
        paymentReference: 'INB-SYNC-9001',
        proofDataUrl: 'data:text/plain;base64,cHJvb2Y=',
        idempotencyKey: 'dep_idem_sync_1',
      }),
    ).rejects.toThrow(/IDEMPOTENCY_CONFLICT/);

    // Staff received immediate in-app/push notification for the new Add Money request
    const staffNotifs = [...dbStore.notifications.values()].filter((n) => n.userId === 'admin_maker');
    expect(staffNotifs.some((n) => n.template === 'ADMIN_NEW_DEPOSIT_v1')).toBe(true);

    // Maker approves with expectedStatus === PENDING
    const makerApproved = await transactionsService.makerApproveDeposit(dep1.id, 'admin_maker', undefined, DepositStatus.PENDING);
    expect(makerApproved.status).toBe(DepositStatus.MAKER_APPROVED);
    expect(makerApproved.version).toBe(2);

    // Stale concurrent Maker click with expectedStatus === PENDING fails with STATE_CONFLICT
    await expect(
      transactionsService.makerApproveDeposit(dep1.id, 'admin_maker', undefined, DepositStatus.PENDING),
    ).rejects.toThrow(/STATE_CONFLICT/);
  });
});

