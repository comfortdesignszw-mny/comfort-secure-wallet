import { randomUUID } from 'node:crypto';
import { ApprovalRecord, Currency, FeeRuleRecord, LimitRuleRecord, Role, TransactionType } from '../../../shared/types.ts';
import { dbStore } from '../../db/store.ts';
import { recordAuditLog } from '../../security/audit.ts';
import { rulesService } from '../rules/rules.service.ts';

class ApprovalsService {
  requestChange(params: {
    entityType: ApprovalRecord['entityType'];
    entityId: string;
    payload: Record<string, unknown>;
    requestedBy: string;
    reason?: string;
  }): ApprovalRecord {
    const approval: ApprovalRecord = {
      id: `apr_${randomUUID()}`,
      entityType: params.entityType,
      entityId: params.entityId,
      payload: params.payload,
      requestedBy: params.requestedBy,
      approvedBy: null,
      status: 'PENDING',
      reason: params.reason || null,
      createdAt: new Date().toISOString(),
      decidedAt: null,
    };
    dbStore.approvals.set(approval.id, approval);

    recordAuditLog({
      actorId: params.requestedBy,
      actorType: 'ADMIN',
      action: `CHANGE_REQUESTED_${params.entityType}`,
      entity: `approval:${approval.id}`,
      after: params.payload,
    });

    return approval;
  }

  decideChange(approvalId: string, approverId: string, decision: 'APPROVED' | 'REJECTED', reason?: string): ApprovalRecord {
    const apr = dbStore.approvals.get(approvalId);
    if (!apr) throw new Error('Approval request not found');
    if (apr.status !== 'PENDING') throw new Error(`Approval is already ${apr.status}`);
    if (apr.requestedBy === approverId) {
      throw new Error('DUAL_CONTROL_VIOLATION: A second administrator must approve or reject this change.');
    }

    apr.status = decision;
    apr.approvedBy = approverId;
    apr.decidedAt = new Date().toISOString();
    if (reason) apr.reason = reason;

    if (decision === 'APPROVED') {
      this.applyApprovedChange(apr, approverId);
    }

    recordAuditLog({
      actorId: approverId,
      actorType: 'ADMIN',
      action: `CHANGE_${decision}_${apr.entityType}`,
      entity: `approval:${apr.id}`,
      after: { entityId: apr.entityId, payload: apr.payload, reason: apr.reason },
    });

    return apr;
  }

  private applyApprovedChange(apr: ApprovalRecord, approverId: string) {
    const now = new Date().toISOString();
    if (apr.entityType === 'FEE_RULE') {
      rulesService.ensureDefaultRules();
      const p = apr.payload as {
        transactionType: TransactionType;
        currency: Currency;
        flatMinor: number;
        percentBps: number;
        minMinor: number;
        maxMinor: number;
        active: boolean;
      };
      const id = `fee_${p.transactionType}_${p.currency}`;
      const updated: FeeRuleRecord = {
        id,
        transactionType: p.transactionType,
        currency: p.currency,
        flatMinor: p.flatMinor,
        percentBps: p.percentBps,
        minMinor: p.minMinor,
        maxMinor: p.maxMinor,
        active: p.active,
        changedBy: approverId,
        updatedAt: now,
      };
      dbStore.feeRules.set(id, updated);
    } else if (apr.entityType === 'LIMIT_RULE') {
      rulesService.ensureDefaultRules();
      const p = apr.payload as {
        scope: 'TIER_1' | 'TIER_2' | 'USER';
        scopeId: string;
        transactionType: TransactionType;
        currency: Currency;
        perTxnMaxMinor: number;
        dailyMaxMinor: number;
        monthlyMaxMinor: number;
      };
      const id = `lim_${p.scope}_${p.scopeId}_${p.transactionType}_${p.currency}`;
      const updated: LimitRuleRecord = {
        id,
        scope: p.scope,
        scopeId: p.scopeId,
        transactionType: p.transactionType,
        currency: p.currency,
        perTxnMaxMinor: p.perTxnMaxMinor,
        dailyMaxMinor: p.dailyMaxMinor,
        monthlyMaxMinor: p.monthlyMaxMinor,
        updatedAt: now,
      };
      dbStore.limitRules.set(id, updated);
    } else if (apr.entityType === 'STAFF_ROLE') {
      const p = apr.payload as { targetUserId: string; newRole: Role };
      const target = dbStore.users.get(p.targetUserId);
      if (target) {
        target.role = p.newRole;
      }
    } else if (apr.entityType === 'MAKER_CHECKER_THRESHOLD') {
      const p = apr.payload as { thresholdMinor: number };
      dbStore.makerCheckerThresholdMinor = p.thresholdMinor;
    }
  }

  listApprovals(status?: string) {
    return [...dbStore.approvals.values()]
      .filter((a) => !status || a.status === status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

export const approvalsService = new ApprovalsService();
