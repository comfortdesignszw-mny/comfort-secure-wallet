import { randomUUID } from 'node:crypto';
import {
  Currency,
  DepositStatus,
  KycStatus,
  LedgerAccountType,
  NotificationChannel,
  ReconciliationRunRecord,
  Role,
  SupportNoteRecord,
  UserStatus,
  WithdrawalStatus,
} from '../../../shared/types.ts';
import { dbStore } from '../../db/store.ts';
import { recordAuditLog } from '../../security/audit.ts';
import { ledgerService } from '../ledger/ledger.service.ts';
import { notificationService } from '../notifications/notifications.service.ts';
import { approvalsService } from '../approvals/approvals.service.ts';
import { rbacService } from '../rules/rbac.service.ts';

class AdminService {
  getOverviewMetrics() {
    const ledgerInvariant = ledgerService.verifyGlobalInvariant();
    const pendingKyc = [...dbStore.users.values()].filter(
      (u) => u.kycStatus === KycStatus.PENDING || u.kycStatus === KycStatus.NEEDS_MORE_INFO,
    ).length;
    const pendingDeposits = [...dbStore.depositRequests.values()].filter(
      (d) => d.status === DepositStatus.PENDING || d.status === DepositStatus.MAKER_APPROVED,
    ).length;
    const pendingWithdrawals = [...dbStore.withdrawalRequests.values()].filter(
      (w) =>
        w.status === WithdrawalStatus.PENDING ||
        w.status === WithdrawalStatus.MAKER_APPROVED ||
        w.status === WithdrawalStatus.CHECKER_APPROVED,
    ).length;
    const openRiskFlags = [...dbStore.riskFlags.values()].filter((r) => r.status === 'OPEN').length;
    const pendingApprovals = [...dbStore.approvals.values()].filter((a) => a.status === 'PENDING').length;

    const balancesByCurrency: Record<string, { userLiabilitiesMinor: number; withdrawalHoldMinor: number; feeRevenueMinor: number; bankSettlementMinor: number }> = {};
    for (const currency of [Currency.USD, Currency.ZWG, Currency.ZAR]) {
      let userLiabilitiesMinor = 0;
      for (const la of dbStore.ledgerAccounts.values()) {
        if (la.currency === currency && la.type === LedgerAccountType.USER_WALLET) {
          userLiabilitiesMinor += ledgerService.deriveBalanceFromJournal(la.id);
        }
      }
      const hold = ledgerService.deriveBalanceFromJournal(
        dbStore.getSystemLedgerAccount(LedgerAccountType.WITHDRAWAL_HOLD, currency).id,
      );
      const fee = ledgerService.deriveBalanceFromJournal(
        dbStore.getSystemLedgerAccount(LedgerAccountType.FEE_REVENUE, currency).id,
      );
      const bank = ledgerService.deriveBalanceFromJournal(
        dbStore.getSystemLedgerAccount(LedgerAccountType.BANK_SETTLEMENT, currency).id,
      );
      balancesByCurrency[currency] = {
        userLiabilitiesMinor,
        withdrawalHoldMinor: hold,
        feeRevenueMinor: fee,
        bankSettlementMinor: bank,
      };
    }

    return {
      totalUsers: [...dbStore.users.values()].filter((u) => u.role === Role.USER).length,
      totalTransactions: dbStore.transactions.size,
      pendingKyc,
      pendingDeposits,
      pendingWithdrawals,
      openRiskFlags,
      pendingApprovals,
      makerCheckerThresholdMinor: dbStore.makerCheckerThresholdMinor,
      ledgerInvariant,
      balancesByCurrency,
    };
  }

  async freezeOrUnfreezeUser(params: {
    targetUserId: string;
    adminId: string;
    freeze: boolean;
    reason: string;
  }) {
    if (!params.reason || params.reason.trim().length < 3) {
      throw new Error('REASON_REQUIRED: Freeze or unfreeze action requires a reason.');
    }
    const user = dbStore.users.get(params.targetUserId);
    if (!user) throw new Error('User not found');

    const before = { status: user.status, freezeReason: user.freezeReason };
    user.status = params.freeze ? UserStatus.FROZEN : UserStatus.ACTIVE;
    user.freezeReason = params.freeze ? params.reason.trim() : null;

    if (params.freeze) {
      for (const acc of dbStore.accounts.values()) {
        if (acc.userId === user.id) acc.status = 'FROZEN' as typeof acc.status;
      }
      await notificationService.enqueue({
        userId: user.id,
        channels: [NotificationChannel.IN_APP, NotificationChannel.EMAIL, NotificationChannel.SMS],
        template: 'ACCOUNT_FROZEN_v1',
        body: `Your wallet account has been restricted: ${params.reason.trim()}`,
      });
    } else {
      for (const acc of dbStore.accounts.values()) {
        if (acc.userId === user.id) acc.status = 'ACTIVE' as typeof acc.status;
      }
    }

    recordAuditLog({
      actorId: params.adminId,
      actorType: 'ADMIN',
      action: params.freeze ? 'USER_FROZEN' : 'USER_UNFROZEN',
      entity: `user:${user.id}`,
      before,
      after: { status: user.status, freezeReason: user.freezeReason },
    });

    return user;
  }

  addSupportNote(userId: string, authorId: string, note: string): SupportNoteRecord {
    if (!note.trim()) throw new Error('Note cannot be empty');
    const record: SupportNoteRecord = {
      id: `not_${randomUUID()}`,
      userId,
      authorId,
      note: note.trim(),
      createdAt: new Date().toISOString(),
    };
    dbStore.supportNotes.set(record.id, record);
    recordAuditLog({
      actorId: authorId,
      actorType: 'ADMIN',
      action: 'SUPPORT_NOTE_ADDED',
      entity: `user:${userId}`,
      after: { noteId: record.id },
    });
    return record;
  }

  runDailyReconciliation(currency: Currency, externalBankStatementMinor?: number): ReconciliationRunRecord {
    const bankLedgerMinor = ledgerService.deriveBalanceFromJournal(
      dbStore.getSystemLedgerAccount(LedgerAccountType.BANK_SETTLEMENT, currency).id,
    );
    let liabilitiesPlusEquity = 0;
    for (const la of dbStore.ledgerAccounts.values()) {
      if (
        la.currency === currency &&
        (la.type === LedgerAccountType.USER_WALLET ||
          la.type === LedgerAccountType.WITHDRAWAL_HOLD ||
          la.type === LedgerAccountType.FEE_REVENUE)
      ) {
        liabilitiesPlusEquity += ledgerService.deriveBalanceFromJournal(la.id);
      }
    }

    const bankTotalMinor = externalBankStatementMinor ?? bankLedgerMinor;
    const differenceMinor = bankTotalMinor - liabilitiesPlusEquity;
    const run: ReconciliationRunRecord = {
      id: `rec_${randomUUID()}`,
      date: new Date().toISOString().slice(0, 10),
      currency,
      ledgerTotalMinor: liabilitiesPlusEquity,
      bankTotalMinor,
      differenceMinor,
      status: differenceMinor === 0 ? 'MATCHED' : 'DISCREPANCY',
      resolvedBy: null,
      note: differenceMinor === 0 ? 'Ledger liabilities equal bank settlement balance.' : 'Variance detected between bank statement and ledger.',
      createdAt: new Date().toISOString(),
    };
    dbStore.reconciliationRuns.set(run.id, run);
    return run;
  }

  resolveReconciliation(runId: string, adminId: string, note: string) {
    const run = dbStore.reconciliationRuns.get(runId);
    if (!run) throw new Error('Reconciliation run not found');
    const before = { status: run.status };
    run.status = 'RESOLVED';
    run.resolvedBy = adminId;
    run.note = note;
    recordAuditLog({
      actorId: adminId,
      actorType: 'ADMIN',
      action: 'RECONCILIATION_RESOLVED',
      entity: `reconciliation:${run.id}`,
      before,
      after: { status: run.status, note },
    });
    return run;
  }

  requestStaffRoleChange(targetUserId: string, newRole: Role, requestedBy: string, reason: string) {
    return approvalsService.requestChange({
      entityType: 'STAFF_ROLE',
      entityId: targetUserId,
      payload: { targetUserId, newRole },
      requestedBy,
      reason,
    });
  }

  listStaffDirectory() {
    rbacService.ensureRbacRulesInDb();
    const staff = [...dbStore.users.values()]
      .filter((u) => u.role !== Role.USER || u.staffStatus === 'PENDING_APPROVAL' || u.requestedRole !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((u) => {
        const prof = dbStore.userProfiles.get(u.id);
        const { passwordHash: _pw, ...safe } = u;
        return {
          ...safe,
          fullName: prof?.fullName || u.email || u.phone || u.id,
          pinConfigured: dbStore.pins.has(u.id),
        };
      });
    return {
      staff,
      approvals: approvalsService.listApprovals(),
      rbacRules: rbacService.listRules(),
    };
  }

  async approveOrPromoteStaff(params: {
    targetUserId: string;
    superAdminId: string;
    decision: 'APPROVED' | 'REJECTED';
    assignedRole?: Role;
    reason?: string;
  }) {
    const actor = dbStore.users.get(params.superAdminId);
    if (!actor || actor.role !== Role.SUPER_ADMIN || actor.staffStatus !== 'APPROVED') {
      throw new Error('FORBIDDEN: Only an approved Super Admin can approve or promote staff.');
    }
    const target = dbStore.users.get(params.targetUserId);
    if (!target) {
      throw new Error('USER_NOT_FOUND: Staff applicant not found.');
    }
    if (target.id === actor.id && params.decision === 'REJECTED') {
      throw new Error('FORBIDDEN: Super Admin cannot reject own account.');
    }

    const before = {
      role: target.role,
      staffStatus: target.staffStatus,
      requestedRole: target.requestedRole,
    };

    if (params.decision === 'APPROVED') {
      const nextRole = params.assignedRole || target.requestedRole || target.role;
      if (nextRole === Role.USER) {
        throw new Error('INVALID_ROLE: Cannot promote staff to regular USER role.');
      }
      target.role = nextRole;
      target.staffStatus = 'APPROVED';
      target.requestedRole = nextRole;
      target.totpEnabled = true;

      await notificationService.enqueue({
        userId: target.id,
        channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH, NotificationChannel.EMAIL],
        template: 'STAFF_APPROVED_v1',
        body: `Your Comfort Secure Wallet staff access has been approved with role ${nextRole}.`,
      });
    } else {
      target.staffStatus = 'REJECTED';
      await notificationService.enqueue({
        userId: target.id,
        channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH, NotificationChannel.EMAIL],
        template: 'STAFF_REJECTED_v1',
        body: `Your Comfort Secure Wallet staff access application was declined: ${params.reason || 'Administrative decision'}`,
      });
    }

    dbStore.mirrorDoc('users', target.id, { ...target, passwordHash: undefined });

    recordAuditLog({
      actorId: actor.id,
      actorType: 'ADMIN',
      action: params.decision === 'APPROVED' ? 'STAFF_APPROVED_PROMOTED' : 'STAFF_REJECTED',
      entity: `user:${target.id}`,
      before,
      after: {
        role: target.role,
        staffStatus: target.staffStatus,
        reason: params.reason || null,
      },
    });

    const { passwordHash: _pw, ...safe } = target;
    return safe;
  }
}

export const adminService = new AdminService();
