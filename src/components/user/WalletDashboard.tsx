import React from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Copy,
  Eye,
  EyeOff,
  FileText,
  Plus,
  Send,
} from 'lucide-react';
import { Currency, TransactionRecord } from '../../shared/types.ts';
import { formatMinorUnits } from '../../shared/money.ts';

export interface WalletAccountSummary {
  id: string;
  accountNumber: string;
  currency: Currency;
  status: string;
  withdrawalLimits: {
    perTxnMaxMinor: number;
    dailyMaxMinor: number;
    monthlyMaxMinor: number;
    dailyUsedMinor: number;
    monthlyUsedMinor: number;
  };
}

interface WalletDashboardProps {
  accounts: WalletAccountSummary[];
  selectedAccountId: string;
  onSelectAccount: (id: string) => void;
  balancesByAccount: Record<string, { balanceMinor: number; holdMinor: number }>;
  balancesUnlocked: boolean;
  onRequestUnlockBalance: () => void;
  onLockBalance: () => void;
  transactions: TransactionRecord[];
  onNavigateAction: (tab: 'add' | 'send' | 'withdraw' | 'activity') => void;
  onDownloadReceipt: (txnId: string) => void;
}

export const WalletDashboard: React.FC<WalletDashboardProps> = ({
  accounts,
  selectedAccountId,
  onSelectAccount,
  balancesByAccount,
  balancesUnlocked,
  onRequestUnlockBalance,
  onLockBalance,
  transactions,
  onNavigateAction,
  onDownloadReceipt,
}) => {
  const [copied, setCopied] = React.useState(false);
  const activeAccount = accounts.find((a) => a.id === selectedAccountId) || accounts[0];

  if (!activeAccount) {
    return null;
  }

  const bal = balancesByAccount[activeAccount.id];
  const accountTxns = transactions.filter(
    (t) => t.fromAccountId === activeAccount.id || t.toAccountId === activeAccount.id,
  );

  // Aggregate cashflow stats for SVG chart
  const inflowsMinor = accountTxns
    .filter((t) => t.toAccountId === activeAccount.id && t.status === 'COMPLETED')
    .reduce((sum, t) => sum + t.amountMinor, 0);
  const outflowsMinor = accountTxns
    .filter((t) => t.fromAccountId === activeAccount.id && t.status === 'COMPLETED')
    .reduce((sum, t) => sum + t.amountMinor + t.feeMinor, 0);
  const totalFlow = Math.max(1, inflowsMinor + outflowsMinor);
  const inflowPct = Math.round((inflowsMinor / totalFlow) * 100);
  const outflowPct = 100 - inflowPct;

  const handleCopyAccount = () => {
    void navigator.clipboard?.writeText(activeAccount.accountNumber);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="space-y-6">
      {/* Currency Wallet Switcher */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-xl">
          {accounts.map((acc) => (
            <button
              key={acc.id}
              type="button"
              onClick={() => onSelectAccount(acc.id)}
              className={`px-4 py-2 text-xs font-semibold rounded-lg transition-colors min-h-[38px] whitespace-nowrap ${
                acc.id === activeAccount.id
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {acc.currency} Wallet
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={handleCopyAccount}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-200 bg-white text-xs font-mono text-slate-700 hover:bg-slate-50 min-h-[40px]"
        >
          <span>Acct: {activeAccount.accountNumber}</span>
          <Copy className="w-3.5 h-3.5 text-slate-400" />
          {copied && <span className="font-sans text-emerald-700 font-semibold">Copied</span>}
        </button>
      </div>

      {/* Primary Balance & Quick Actions Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        <div className="lg:col-span-7 bg-slate-900 text-white rounded-3xl p-6 md:p-8 flex flex-col justify-between">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs text-slate-400">
                Available Balance · {activeAccount.currency} · {activeAccount.status}
              </p>
              <div className="mt-2 font-mono text-3xl md:text-4xl font-bold tracking-tight tabular-nums">
                {balancesUnlocked && bal
                  ? formatMinorUnits(bal.balanceMinor, activeAccount.currency)
                  : '••••••'}
              </div>
              {balancesUnlocked && bal && bal.holdMinor > 0 && (
                <p className="mt-2 text-xs text-amber-300 font-mono tabular-nums">
                  In Withdrawal Hold: {formatMinorUnits(bal.holdMinor, activeAccount.currency)}
                </p>
              )}
            </div>

            <button
              type="button"
              onClick={balancesUnlocked ? onLockBalance : onRequestUnlockBalance}
              className="inline-flex items-center gap-2 rounded-xl bg-slate-800 hover:bg-slate-700 px-3.5 py-2.5 text-xs font-medium text-slate-100 transition-colors min-h-[44px] whitespace-nowrap shrink-0"
            >
              {balancesUnlocked ? (
                <>
                  <EyeOff className="w-4 h-4" />
                  Mask Balance
                </>
              ) : (
                <>
                  <Eye className="w-4 h-4" />
                  Unlock with PIN
                </>
              )}
            </button>
          </div>

          {/* 4 Thumb-Friendly Action Buttons */}
          <div className="mt-8 grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            <button
              type="button"
              onClick={() => onNavigateAction('add')}
              className="min-h-[48px] rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center justify-center gap-2 transition-colors px-3"
            >
              <Plus className="w-4 h-4" />
              Add Money
            </button>
            <button
              type="button"
              onClick={() => onNavigateAction('send')}
              className="min-h-[48px] rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold flex items-center justify-center gap-2 transition-colors px-3"
            >
              <Send className="w-4 h-4" />
              Send Money
            </button>
            <button
              type="button"
              onClick={() => onNavigateAction('withdraw')}
              className="min-h-[48px] rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold flex items-center justify-center gap-2 transition-colors px-3"
            >
              <ArrowUpRight className="w-4 h-4" />
              Withdraw
            </button>
            <button
              type="button"
              onClick={() => onNavigateAction('activity')}
              className="min-h-[48px] rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold flex items-center justify-center gap-2 transition-colors px-3"
            >
              <FileText className="w-4 h-4" />
              Statements
            </button>
          </div>
        </div>

        {/* Cashflow & Limits Summary Card */}
        <div className="lg:col-span-5 bg-white rounded-3xl border border-slate-200 p-6 flex flex-col justify-between">
          <div>
            <h3 className="font-display text-sm font-semibold text-slate-900">Wallet Cashflow & Payout Limits</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Ledger-verified inflows vs outflows ({activeAccount.currency})
            </p>

            <div className="mt-5 space-y-3">
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-slate-600">Total Credits</span>
                  <span className="font-mono font-semibold text-emerald-700 tabular-nums">
                    {balancesUnlocked ? formatMinorUnits(inflowsMinor, activeAccount.currency) : '••••'}
                  </span>
                </div>
                <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
                  <div className="h-full bg-emerald-600 rounded-full" style={{ width: `${inflowPct}%` }} />
                </div>
              </div>

              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-slate-600">Total Debits & Fees</span>
                  <span className="font-mono font-semibold text-slate-800 tabular-nums">
                    {balancesUnlocked ? formatMinorUnits(outflowsMinor, activeAccount.currency) : '••••'}
                  </span>
                </div>
                <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
                  <div className="h-full bg-slate-700 rounded-full" style={{ width: `${outflowPct}%` }} />
                </div>
              </div>
            </div>
          </div>

          <div className="mt-6 pt-4 border-t border-slate-100 grid grid-cols-2 gap-4 text-xs">
            <div>
              <span className="text-slate-500 block">Daily Withdrawal Used</span>
              <span className="font-mono font-semibold text-slate-900 tabular-nums mt-0.5 block">
                {formatMinorUnits(activeAccount.withdrawalLimits.dailyUsedMinor, activeAccount.currency)} /{' '}
                {formatMinorUnits(activeAccount.withdrawalLimits.dailyMaxMinor, activeAccount.currency)}
              </span>
            </div>
            <div>
              <span className="text-slate-500 block">Monthly Withdrawal Used</span>
              <span className="font-mono font-semibold text-slate-900 tabular-nums mt-0.5 block">
                {formatMinorUnits(activeAccount.withdrawalLimits.monthlyUsedMinor, activeAccount.currency)} /{' '}
                {formatMinorUnits(activeAccount.withdrawalLimits.monthlyMaxMinor, activeAccount.currency)}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Recent Transactions */}
      <section className="bg-white rounded-3xl border border-slate-200 p-6">
        <div className="flex items-center justify-between gap-4 pb-4 border-b border-slate-100">
          <div>
            <h3 className="font-display text-base font-semibold text-slate-900">Recent Activity</h3>
            <p className="text-xs text-slate-500">Immutable double-entry movements</p>
          </div>
          <button
            type="button"
            onClick={() => onNavigateAction('activity')}
            className="text-xs font-semibold text-emerald-700 hover:text-emerald-800 min-h-[40px] px-2"
          >
            View All & Statements
          </button>
        </div>

        {accountTxns.length === 0 ? (
          <div className="py-10 text-center text-sm text-slate-500">
            No transactions recorded on this {activeAccount.currency} wallet yet.
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {accountTxns.slice(0, 6).map((txn) => {
              const isCredit = txn.toAccountId === activeAccount.id;
              return (
                <div
                  key={txn.id}
                  className="py-3.5 flex items-center justify-between gap-4 hover:bg-slate-50/70 px-2 rounded-xl transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div
                      className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                        isCredit
                          ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                          : 'bg-slate-100 text-slate-700 border border-slate-200'
                      }`}
                    >
                      {isCredit ? <ArrowDownLeft className="w-4 h-4" /> : <ArrowUpRight className="w-4 h-4" />}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-900 capitalize truncate">
                        {txn.type} · {txn.reference}
                      </p>
                      <p className="text-xs text-slate-500 truncate">
                        {new Date(txn.createdAt).toLocaleString()} · {txn.status}
                        {txn.feeMinor > 0 ? ` · Fee ${formatMinorUnits(txn.feeMinor, txn.currency)}` : ''}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 shrink-0">
                    <span
                      className={`font-mono text-sm font-semibold tabular-nums ${
                        isCredit ? 'text-emerald-700' : 'text-slate-900'
                      }`}
                    >
                      {isCredit ? '+' : '-'}
                      {formatMinorUnits(txn.amountMinor, txn.currency)}
                    </span>
                    <button
                      type="button"
                      onClick={() => onDownloadReceipt(txn.id)}
                      title="Download PDF receipt"
                      aria-label={`Download receipt for ${txn.reference}`}
                      className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-100"
                    >
                      <FileText className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
};
