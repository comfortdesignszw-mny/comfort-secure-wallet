import { randomUUID } from 'node:crypto';
import { Currency, FeeRuleRecord, LimitRuleRecord, TransactionStatus, TransactionType } from '../../../shared/types.ts';
import { calculateFeeMinor } from '../../../shared/money.ts';
import { dbStore } from '../../db/store.ts';

class RulesEngineService {
  ensureDefaultRules() {
    if (dbStore.feeRules.size === 0) {
      const now = new Date().toISOString();
      const defaults: FeeRuleRecord[] = [
        {
          id: 'fee_transfer_USD',
          transactionType: TransactionType.TRANSFER,
          currency: Currency.USD,
          flatMinor: 10, // $0.10 flat + 0.50% (50 bps), min $0.10, max $2.50
          percentBps: 50,
          minMinor: 10,
          maxMinor: 250,
          active: true,
          changedBy: 'system',
          updatedAt: now,
        },
        {
          id: 'fee_transfer_ZWG',
          transactionType: TransactionType.TRANSFER,
          currency: Currency.ZWG,
          flatMinor: 100,
          percentBps: 50,
          minMinor: 100,
          maxMinor: 5000,
          active: true,
          changedBy: 'system',
          updatedAt: now,
        },
        {
          id: 'fee_withdrawal_USD',
          transactionType: TransactionType.WITHDRAWAL,
          currency: Currency.USD,
          flatMinor: 50, // $0.50 flat fee on payouts
          percentBps: 0,
          minMinor: 50,
          maxMinor: 500,
          active: true,
          changedBy: 'system',
          updatedAt: now,
        },
      ];
      for (const r of defaults) dbStore.feeRules.set(r.id, r);
    }

    if (dbStore.limitRules.size === 0) {
      const now = new Date().toISOString();
      const defaults: LimitRuleRecord[] = [
        // Confirmed decision: USD 100/day, USD 1,000/month for withdrawals (10,000 and 100,000 minor units)
        {
          id: 'lim_TIER_1_withdrawal_USD',
          scope: 'TIER_1',
          scopeId: 'TIER_1',
          transactionType: TransactionType.WITHDRAWAL,
          currency: Currency.USD,
          perTxnMaxMinor: 10000,
          dailyMaxMinor: 10000,
          monthlyMaxMinor: 100000,
          updatedAt: now,
        },
        {
          id: 'lim_TIER_1_transfer_USD',
          scope: 'TIER_1',
          scopeId: 'TIER_1',
          transactionType: TransactionType.TRANSFER,
          currency: Currency.USD,
          perTxnMaxMinor: 50000,
          dailyMaxMinor: 100000,
          monthlyMaxMinor: 500000,
          updatedAt: now,
        },
        {
          id: 'lim_TIER_1_withdrawal_ZWG',
          scope: 'TIER_1',
          scopeId: 'TIER_1',
          transactionType: TransactionType.WITHDRAWAL,
          currency: Currency.ZWG,
          perTxnMaxMinor: 300000,
          dailyMaxMinor: 300000,
          monthlyMaxMinor: 3000000,
          updatedAt: now,
        },
        {
          id: 'lim_TIER_1_transfer_ZWG',
          scope: 'TIER_1',
          scopeId: 'TIER_1',
          transactionType: TransactionType.TRANSFER,
          currency: Currency.ZWG,
          perTxnMaxMinor: 1500000,
          dailyMaxMinor: 3000000,
          monthlyMaxMinor: 15000000,
          updatedAt: now,
        },
      ];
      for (const l of defaults) dbStore.limitRules.set(l.id, l);
    }
  }

  getFeeRule(transactionType: TransactionType, currency: Currency): FeeRuleRecord | null {
    this.ensureDefaultRules();
    for (const rule of dbStore.feeRules.values()) {
      if (rule.transactionType === transactionType && rule.currency === currency && rule.active) {
        return rule;
      }
    }
    return null;
  }

  computeFee(transactionType: TransactionType, currency: Currency, amountMinor: number): number {
    const rule = this.getFeeRule(transactionType, currency);
    return calculateFeeMinor(amountMinor, rule);
  }

  getLimitRule(userId: string, kycTier: number, transactionType: TransactionType, currency: Currency): LimitRuleRecord {
    this.ensureDefaultRules();
    // User-specific override takes precedence
    for (const rule of dbStore.limitRules.values()) {
      if (
        rule.scope === 'USER' &&
        rule.scopeId === userId &&
        rule.transactionType === transactionType &&
        rule.currency === currency
      ) {
        return rule;
      }
    }
    const tierKey = kycTier >= 2 ? 'TIER_2' : 'TIER_1';
    for (const rule of dbStore.limitRules.values()) {
      if (
        rule.scope === tierKey &&
        rule.transactionType === transactionType &&
        rule.currency === currency
      ) {
        return rule;
      }
    }
    // Safe conservative fallback (USD 100/day, USD 1,000/month)
    return {
      id: `fallback_${randomUUID()}`,
      scope: 'TIER_1',
      scopeId: 'TIER_1',
      transactionType,
      currency,
      perTxnMaxMinor: 10000,
      dailyMaxMinor: 10000,
      monthlyMaxMinor: 100000,
      updatedAt: new Date().toISOString(),
    };
  }

  getUsageTotals(userId: string, accountId: string, transactionType: TransactionType, currency: Currency): {
    dailyUsedMinor: number;
    monthlyUsedMinor: number;
  } {
    const now = new Date();
    const startOfDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const startOfMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);

    let dailyUsedMinor = 0;
    let monthlyUsedMinor = 0;

    if (transactionType === TransactionType.WITHDRAWAL) {
      // Count active pending/approved/paid withdrawal requests (not rejected) so holds count against limits
      for (const w of dbStore.withdrawalRequests.values()) {
        if (w.userId === userId && w.currency === currency && w.status !== 'REJECTED') {
          const ts = Date.parse(w.createdAt);
          if (ts >= startOfMonth) monthlyUsedMinor += w.amountMinor;
          if (ts >= startOfDay) dailyUsedMinor += w.amountMinor;
        }
      }
      return { dailyUsedMinor, monthlyUsedMinor };
    }

    for (const txn of dbStore.transactions.values()) {
      if (
        txn.type === transactionType &&
        txn.currency === currency &&
        txn.fromAccountId === accountId &&
        txn.status !== TransactionStatus.FAILED &&
        txn.status !== TransactionStatus.REVERSED
      ) {
        const ts = Date.parse(txn.createdAt);
        if (ts >= startOfMonth) monthlyUsedMinor += txn.amountMinor;
        if (ts >= startOfDay) dailyUsedMinor += txn.amountMinor;
      }
    }
    return { dailyUsedMinor, monthlyUsedMinor };
  }

  assertWithinLimits(params: {
    userId: string;
    kycTier: number;
    accountId: string;
    transactionType: TransactionType;
    currency: Currency;
    amountMinor: number;
  }): { rule: LimitRuleRecord; dailyUsedMinor: number; monthlyUsedMinor: number } {
    const rule = this.getLimitRule(params.userId, params.kycTier, params.transactionType, params.currency);
    const { dailyUsedMinor, monthlyUsedMinor } = this.getUsageTotals(
      params.userId,
      params.accountId,
      params.transactionType,
      params.currency,
    );

    if (params.amountMinor > rule.perTxnMaxMinor) {
      throw new Error(`LIMIT_EXCEEDED: Amount exceeds per-transaction limit of ${rule.perTxnMaxMinor} minor units (${params.currency}).`);
    }
    if (dailyUsedMinor + params.amountMinor > rule.dailyMaxMinor) {
      throw new Error(`DAILY_LIMIT_EXCEEDED: Exceeds daily ${params.transactionType} limit of ${rule.dailyMaxMinor} minor units (${params.currency}).`);
    }
    if (monthlyUsedMinor + params.amountMinor > rule.monthlyMaxMinor) {
      throw new Error(`MONTHLY_LIMIT_EXCEEDED: Exceeds monthly ${params.transactionType} limit of ${rule.monthlyMaxMinor} minor units (${params.currency}).`);
    }
    return { rule, dailyUsedMinor, monthlyUsedMinor };
  }
}

export const rulesService = new RulesEngineService();
