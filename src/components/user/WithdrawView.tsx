import React, { useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { WithdrawalRequestRecord } from '../../shared/types.ts';
import { formatMinorUnits, parseDecimalToMinorUnits } from '../../shared/money.ts';
import { apiFetch, newIdempotencyKey } from '../../lib/api.ts';
import { PinSheet } from '../PinSheet.tsx';
import { WalletAccountSummary } from './WalletDashboard.tsx';

interface WithdrawViewProps {
  accounts: WalletAccountSummary[];
  withdrawals: WithdrawalRequestRecord[];
  onRefresh: () => Promise<void>;
}

export const WithdrawView: React.FC<WithdrawViewProps> = ({ accounts, withdrawals, onRefresh }) => {
  const [accountId, setAccountId] = useState(accounts[0]?.id || '');
  const [amountInput, setAmountInput] = useState('25.00');
  const [method, setMethod] = useState<'ECOCASH' | 'INNBUCKS' | 'BANK_TRANSFER'>('ECOCASH');
  const [destinationLabel, setDestinationLabel] = useState('');
  const [pinModalOpen, setPinModalOpen] = useState(false);
  const [pendingAmountMinor, setPendingAmountMinor] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const selectedAcc = accounts.find((a) => a.id === accountId) || accounts[0];

  const handleRequestSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);
    if (!selectedAcc) return;
    try {
      const amountMinor = parseDecimalToMinorUnits(amountInput, selectedAcc.currency);
      setPendingAmountMinor(amountMinor);
      setPinModalOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid amount');
    }
  };

  const executeWithStepUp = async (stepUpToken: string) => {
    setPinModalOpen(false);
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch('/withdrawals/requests', {
        method: 'POST',
        stepUpToken,
        idempotencyKey: newIdempotencyKey(),
        body: JSON.stringify({
          accountId: selectedAcc.id,
          amountMinor: pendingAmountMinor,
          method,
          destinationLabel,
        }),
      });
      setDestinationLabel('');
      setSuccessMsg('Withdrawal placed into hold ledger pending Maker-Checker approval and external payout.');
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Withdrawal request failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
      <section className="lg:col-span-6 bg-white rounded-3xl border border-slate-200 p-6">
        <h2 className="font-display text-lg font-bold text-slate-900">Withdraw Funds</h2>
        <p className="text-xs text-slate-500 mt-1">
          Requested funds are securely held while payout settlement is reviewed and processed.
        </p>

        {selectedAcc && (
          <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4 grid grid-cols-2 gap-4 text-xs">
            <div>
              <span className="text-slate-500 block">Daily Payout Limit</span>
              <span className="font-mono font-semibold text-slate-900 tabular-nums mt-0.5 block">
                {formatMinorUnits(selectedAcc.withdrawalLimits.dailyUsedMinor, selectedAcc.currency)} /{' '}
                {formatMinorUnits(selectedAcc.withdrawalLimits.dailyMaxMinor, selectedAcc.currency)}
              </span>
            </div>
            <div>
              <span className="text-slate-500 block">Monthly Payout Limit</span>
              <span className="font-mono font-semibold text-slate-900 tabular-nums mt-0.5 block">
                {formatMinorUnits(selectedAcc.withdrawalLimits.monthlyUsedMinor, selectedAcc.currency)} /{' '}
                {formatMinorUnits(selectedAcc.withdrawalLimits.monthlyMaxMinor, selectedAcc.currency)}
              </span>
            </div>
          </div>
        )}

        <form onSubmit={handleRequestSubmit} className="mt-5 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">Source Wallet</label>
              <select
                value={selectedAcc?.id || ''}
                onChange={(e) => setAccountId(e.target.value)}
                className="w-full h-11 rounded-xl border border-slate-200 px-3 text-sm bg-white"
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.currency} ({a.accountNumber})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">Payout Channel</label>
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value as typeof method)}
                className="w-full h-11 rounded-xl border border-slate-200 px-3 text-sm bg-white"
              >
                <option value="ECOCASH">EcoCash Mobile Money</option>
                <option value="INNBUCKS">InnBucks</option>
                <option value="BANK_TRANSFER">Zimbabwe Bank Account</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                Amount ({selectedAcc?.currency || 'USD'})
              </label>
              <input
                type="text"
                inputMode="decimal"
                required
                value={amountInput}
                onChange={(e) => setAmountInput(e.target.value)}
                className="w-full h-11 rounded-xl border border-slate-200 px-3.5 font-mono text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">Destination Mobile / Bank Acct</label>
              <input
                type="text"
                required
                minLength={4}
                value={destinationLabel}
                onChange={(e) => setDestinationLabel(e.target.value)}
                placeholder="+263771234567 or CBZ-100293"
                className="w-full h-11 rounded-xl border border-slate-200 px-3.5 font-mono text-sm"
              />
            </div>
          </div>

          {error && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs font-medium text-red-700">
              {error}
            </div>
          )}
          {successMsg && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-xs font-medium text-emerald-800">
              {successMsg}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full h-12 rounded-xl bg-emerald-700 text-white text-sm font-semibold hover:bg-emerald-800 disabled:opacity-60 flex items-center justify-center gap-2"
          >
            <ArrowUpRight className="w-4 h-4" />
            {submitting ? 'Placing Hold...' : 'Authorize Withdrawal with PIN'}
          </button>
        </form>
      </section>

      <section className="lg:col-span-6 bg-white rounded-3xl border border-slate-200 p-6">
        <h3 className="font-display text-base font-semibold text-slate-900">Withdrawal Queue Status</h3>
        <p className="text-xs text-slate-500 mt-0.5">Rejected payouts release held funds back to your wallet automatically</p>

        <div className="mt-4 divide-y divide-slate-100">
          {withdrawals.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-500">No withdrawal requests yet.</p>
          ) : (
            withdrawals.map((w) => (
              <div key={w.id} className="py-3.5 flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-semibold text-slate-900 font-mono">
                    {formatMinorUnits(w.amountMinor, w.currency)} · {w.destinationPreview}
                  </p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {w.status} · {new Date(w.createdAt).toLocaleDateString()}
                    {w.payoutReference ? ` · Payout Ref: ${w.payoutReference}` : ''}
                  </p>
                  {w.rejectionReason && <p className="text-xs text-red-600 mt-1">Reason: {w.rejectionReason}</p>}
                </div>
                <span className="text-xs font-semibold text-slate-700">{w.status}</span>
              </div>
            ))
          )}
        </div>
      </section>

      {selectedAcc && (
        <PinSheet
          open={pinModalOpen}
          onClose={() => setPinModalOpen(false)}
          scope="transaction"
          action="withdrawal"
          amountMinor={pendingAmountMinor}
          currency={selectedAcc.currency}
          onVerified={(token) => void executeWithStepUp(token)}
        />
      )}
    </div>
  );
};
