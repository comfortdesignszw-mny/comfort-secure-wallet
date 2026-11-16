import React, { useState } from 'react';
import { Download, FileSpreadsheet, FileText, Lock, Search } from 'lucide-react';
import { Currency, TransactionRecord } from '../../shared/types.ts';
import { formatMinorUnits } from '../../shared/money.ts';
import { apiFetch, getValidViewStepUpToken } from '../../lib/api.ts';
import { PinSheet } from '../PinSheet.tsx';
import { WalletAccountSummary } from './WalletDashboard.tsx';

interface StatementLine {
  transactionId: string;
  reference: string;
  type: string;
  description: string;
  direction: 'CREDIT' | 'DEBIT';
  amountMinor: number;
  feeMinor: number;
  runningBalanceMinor: number;
  createdAt: string;
}

interface StatementReport {
  accountId: string;
  accountNumber: string;
  currency: Currency;
  holderName: string;
  from: string;
  to: string;
  generatedAt: string;
  openingBalanceMinor: number;
  closingBalanceMinor: number;
  entries: StatementLine[];
}

interface ActivityStatementsViewProps {
  accounts: WalletAccountSummary[];
  transactions: TransactionRecord[];
  onDownloadReceipt: (txnId: string) => void;
}

export const ActivityStatementsView: React.FC<ActivityStatementsViewProps> = ({
  accounts,
  transactions,
  onDownloadReceipt,
}) => {
  const [search, setSearch] = useState('');
  const [selectedAccountId, setSelectedAccountId] = useState(accounts[0]?.id || '');
  const [fromDate, setFromDate] = useState(new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10));
  const [toDate, setToDate] = useState(new Date().toISOString().slice(0, 10));
  const [statement, setStatement] = useState<StatementReport | null>(null);
  const [pinOpen, setPinOpen] = useState(false);
  const [pendingFormat, setPendingFormat] = useState<'VIEW' | 'CSV' | 'PDF'>('VIEW');
  const [error, setError] = useState<string | null>(null);

  const filteredTxns = transactions.filter(
    (t) =>
      !search.trim() ||
      t.reference.toLowerCase().includes(search.toLowerCase()) ||
      t.type.toLowerCase().includes(search.toLowerCase()),
  );

  const runStatementAction = async (mode: 'VIEW' | 'CSV' | 'PDF', stepUpToken?: string) => {
    setError(null);
    const token = stepUpToken || getValidViewStepUpToken();
    if (!token) {
      setPendingFormat(mode);
      setPinOpen(true);
      return;
    }

    const fromIso = `${fromDate}T00:00:00.000Z`;
    const toIso = `${toDate}T23:59:59.999Z`;

    try {
      if (mode === 'VIEW') {
        const res = await apiFetch<{ statement: StatementReport }>(
          `/statements?accountId=${encodeURIComponent(selectedAccountId)}&from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`,
          { stepUpToken: token },
        );
        setStatement(res.statement);
      } else {
        const res = await apiFetch<{ downloadUrl: string }>('/statements/export', {
          method: 'POST',
          stepUpToken: token,
          body: JSON.stringify({
            accountId: selectedAccountId,
            from: fromIso,
            to: toIso,
            format: mode,
          }),
        });
        window.open(res.downloadUrl, '_blank', 'noopener,noreferrer');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load statement');
    }
  };

  return (
    <div className="space-y-6">
      {/* Statements & Export Section */}
      <section className="bg-white rounded-3xl border border-slate-200 p-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-5 border-b border-slate-100">
          <div>
            <h2 className="font-display text-lg font-bold text-slate-900">Account Statements</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              PIN-gated date-range ledger statements with opening/closing balances and signed CSV/PDF exports.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void runStatementAction('VIEW')}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-700 text-white text-xs font-semibold hover:bg-emerald-800 min-h-[42px]"
            >
              <Lock className="w-3.5 h-3.5" />
              View Statement
            </button>
            <button
              type="button"
              onClick={() => void runStatementAction('CSV')}
              className="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl border border-slate-200 bg-white text-xs font-semibold text-slate-700 hover:bg-slate-50 min-h-[42px]"
            >
              <FileSpreadsheet className="w-3.5 h-3.5" />
              Export CSV
            </button>
            <button
              type="button"
              onClick={() => void runStatementAction('PDF')}
              className="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl border border-slate-200 bg-white text-xs font-semibold text-slate-700 hover:bg-slate-50 min-h-[42px]"
            >
              <Download className="w-3.5 h-3.5" />
              Export PDF
            </button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">Wallet Account</label>
            <select
              value={selectedAccountId}
              onChange={(e) => setSelectedAccountId(e.target.value)}
              className="w-full h-11 rounded-xl border border-slate-200 px-3 text-sm bg-white"
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.currency} · {a.accountNumber}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">From Date</label>
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="w-full h-11 rounded-xl border border-slate-200 px-3 text-sm font-mono"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">To Date</label>
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="w-full h-11 rounded-xl border border-slate-200 px-3 text-sm font-mono"
            />
          </div>
        </div>

        {error && <p className="mt-3 text-xs font-medium text-red-600">{error}</p>}

        {statement && (
          <div className="mt-6 pt-5 border-t border-slate-200">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4 text-xs">
              <div>
                <span className="text-slate-500 block">Account Number</span>
                <span className="font-mono font-semibold text-slate-900">{statement.accountNumber}</span>
              </div>
              <div>
                <span className="text-slate-500 block">Opening Balance</span>
                <span className="font-mono font-semibold text-slate-900 tabular-nums">
                  {formatMinorUnits(statement.openingBalanceMinor, statement.currency)}
                </span>
              </div>
              <div>
                <span className="text-slate-500 block">Closing Balance</span>
                <span className="font-mono font-semibold text-emerald-700 tabular-nums">
                  {formatMinorUnits(statement.closingBalanceMinor, statement.currency)}
                </span>
              </div>
              <div>
                <span className="text-slate-500 block">Generated</span>
                <span className="font-mono text-slate-700">{new Date(statement.generatedAt).toLocaleString()}</span>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500">
                    <th className="py-2.5 pr-4 font-medium">Timestamp</th>
                    <th className="py-2.5 pr-4 font-medium">Reference</th>
                    <th className="py-2.5 pr-4 font-medium">Description</th>
                    <th className="py-2.5 pr-4 font-medium text-right">Amount</th>
                    <th className="py-2.5 font-medium text-right">Running Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {statement.entries.map((entry, idx) => (
                    <tr key={`${entry.transactionId}_${idx}`} className="hover:bg-slate-50">
                      <td className="py-2.5 pr-4 font-mono text-slate-500 whitespace-nowrap">
                        {new Date(entry.createdAt).toLocaleString()}
                      </td>
                      <td className="py-2.5 pr-4 font-mono text-slate-800 whitespace-nowrap">{entry.reference}</td>
                      <td className="py-2.5 pr-4 text-slate-700">{entry.description}</td>
                      <td
                        className={`py-2.5 pr-4 font-mono font-semibold text-right tabular-nums whitespace-nowrap ${
                          entry.direction === 'CREDIT' ? 'text-emerald-700' : 'text-slate-900'
                        }`}
                      >
                        {entry.direction === 'CREDIT' ? '+' : '-'}
                        {formatMinorUnits(entry.amountMinor, statement.currency)}
                      </td>
                      <td className="py-2.5 font-mono font-medium text-right tabular-nums whitespace-nowrap text-slate-900">
                        {formatMinorUnits(entry.runningBalanceMinor, statement.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      {/* Transactions List */}
      <section className="bg-white rounded-3xl border border-slate-200 p-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-100">
          <h3 className="font-display text-base font-semibold text-slate-900">All Transactions</h3>
          <div className="relative w-full sm:w-64">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter by ref or type..."
              className="w-full h-10 rounded-xl border border-slate-200 pl-9 pr-3 text-xs"
            />
          </div>
        </div>

        <div className="divide-y divide-slate-100 mt-2">
          {filteredTxns.map((txn) => (
            <div key={txn.id} className="py-3.5 flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-slate-900 capitalize">
                  {txn.type} · <span className="font-mono">{txn.reference}</span>
                </p>
                <p className="text-xs text-slate-500 mt-0.5">
                  {new Date(txn.createdAt).toLocaleString()} · {txn.status} · {txn.currency}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className="font-mono text-sm font-semibold text-slate-900 tabular-nums">
                  {formatMinorUnits(txn.amountMinor, txn.currency)}
                </span>
                <button
                  type="button"
                  onClick={() => onDownloadReceipt(txn.id)}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50 min-h-[38px]"
                >
                  <FileText className="w-3.5 h-3.5" />
                  Receipt
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <PinSheet
        open={pinOpen}
        onClose={() => setPinOpen(false)}
        scope="view"
        title="Unlock Statements"
        subtitle="Enter your 6-digit PIN to view or export official statements"
        onVerified={(token) => {
          setPinOpen(false);
          void runStatementAction(pendingFormat, token);
        }}
      />
    </div>
  );
};
