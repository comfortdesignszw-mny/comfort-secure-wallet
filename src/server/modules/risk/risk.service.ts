import { randomUUID } from 'node:crypto';
import { RiskFlagRecord, RiskSeverity, TransactionType } from '../../../shared/types.ts';
import { dbStore } from '../../db/store.ts';
import { recordAuditLog } from '../../security/audit.ts';

class RiskMonitoringService {
  raiseFlag(params: {
    userId: string;
    rule: string;
    severity: RiskSeverity;
    details: string;
  }): RiskFlagRecord {
    const flag: RiskFlagRecord = {
      id: `rsk_${randomUUID()}`,
      userId: params.userId,
      rule: params.rule,
      severity: params.severity,
      details: params.details,
      status: 'OPEN',
      resolvedBy: null,
      resolutionNote: null,
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    };
    dbStore.riskFlags.set(flag.id, flag);
    return flag;
  }

  /**
   * Evaluate velocity and structuring rules prior to or alongside money movement.
   */
  evaluateTransactionRisk(userId: string, type: TransactionType, amountMinor: number) {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const twentyFourHoursAgo = now - 24 * 60 * 60 * 1000;

    const userAccountIds = new Set(
      [...dbStore.accounts.values()].filter((a) => a.userId === userId).map((a) => a.id),
    );

    const recentUserTxns = [...dbStore.transactions.values()].filter((t) => {
      const created = Date.parse(t.createdAt);
      const belongs = (t.fromAccountId && userAccountIds.has(t.fromAccountId)) || (t.toAccountId && userAccountIds.has(t.toAccountId));
      return belongs && created >= twentyFourHoursAgo;
    });

    const lastHourCount = recentUserTxns.filter((t) => Date.parse(t.createdAt) >= oneHourAgo).length;
    if (lastHourCount >= 8) {
      this.raiseFlag({
        userId,
        rule: 'HIGH_VELOCITY_1H',
        severity: RiskSeverity.HIGH,
        details: `${lastHourCount + 1} transactions attempted within 60 minutes (${type}).`,
      });
    }

    // Structuring check: repeated transactions just under $100 (e.g. $85-$99.99) within 24h
    if (amountMinor >= 8500 && amountMinor < 10000) {
      const nearThresholdCount = recentUserTxns.filter((t) => t.amountMinor >= 8500 && t.amountMinor < 10000).length;
      if (nearThresholdCount >= 2) {
        this.raiseFlag({
          userId,
          rule: 'STRUCTURING_PATTERN',
          severity: RiskSeverity.MEDIUM,
          details: `Multiple transactions structured just below USD 100.00 threshold within 24h.`,
        });
      }
    }
  }

  listFlags(status?: string): RiskFlagRecord[] {
    return [...dbStore.riskFlags.values()]
      .filter((f) => !status || f.status === status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  resolveFlag(flagId: string, resolverId: string, status: 'INVESTIGATING' | 'RESOLVED' | 'FALSE_POSITIVE', note: string) {
    const flag = dbStore.riskFlags.get(flagId);
    if (!flag) throw new Error('Risk flag not found');
    const before = { status: flag.status, resolvedBy: flag.resolvedBy };
    flag.status = status;
    flag.resolvedBy = resolverId;
    flag.resolutionNote = note;
    if (status === 'RESOLVED' || status === 'FALSE_POSITIVE') {
      flag.resolvedAt = new Date().toISOString();
    }
    recordAuditLog({
      actorId: resolverId,
      actorType: 'ADMIN',
      action: 'RISK_FLAG_UPDATED',
      entity: `risk_flag:${flagId}`,
      before,
      after: { status: flag.status, resolutionNote: note },
    });
    return flag;
  }
}

export const riskService = new RiskMonitoringService();
