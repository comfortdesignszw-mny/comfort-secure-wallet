import React, { useState } from 'react';
import { Upload } from 'lucide-react';
import { DepositRequestRecord } from '../../shared/types.ts';
import { formatMinorUnits, parseDecimalToMinorUnits } from '../../shared/money.ts';
import { apiFetch, newIdempotencyKey } from '../../lib/api.ts';
import { WalletAccountSummary } from './WalletDashboard.tsx';

interface AddMoneyViewProps {
  accounts: WalletAccountSummary[];
  deposits: Array<DepositRequestRecord & { proofSignedUrl?: string }>;
  onRefresh: () => Promise<void>;
}

function createSampleProofDataUrl(ref: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="220"><rect width="100%" height="100%" fill="#f8fafc"/><rect x="16" y="16" width="368" height="188" rx="10" fill="#fff" stroke="#cbd5e1"/><text x="32" y="58" font-family="sans-serif" font-size="16" font-weight="bold" fill="#0f172a">BANK / MOBILE MONEY DEPOSIT SLIP</text><text x="32" y="96" font-family="monospace" font-size="14" fill="#047857">REF: ${ref}</text><text x="32" y="130" font-family="sans-serif" font-size="12" fill="#64748b">Uploaded via Comfort Secure Wallet</text></svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

export const AddMoneyView: React.FC<AddMoneyViewProps> = ({ accounts, deposits, onRefresh }) => {
  const [accountId, setAccountId] = useState(accounts[0]?.id || '');
  const [amountInput, setAmountInput] = useState('50.00');
  const [method, setMethod] = useState<'ECOCASH' | 'INNBUCKS' | 'BANK_TRANSFER' | 'ZIPIT'>('ECOCASH');
  const [paymentReference, setPaymentReference] = useState('');
  const [proofDataUrl, setProofDataUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const selectedAcc = accounts.find((a) => a.id === accountId) || accounts[0];

  const handleFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => setProofDataUrl(String(reader.result || ''));
    reader.readAsDataURL(file);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAcc) return;
    setSubmitting(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const amountMinor = parseDecimalToMinorUnits(amountInput, selectedAcc.currency);
      await apiFetch('/deposits/requests', {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
        body: JSON.stringify({
          accountId: selectedAcc.id,
          amountMinor,
          currency: selectedAcc.currency,
          method,
          paymentReference,
          proofDataUrl: proofDataUrl || createSampleProofDataUrl(paymentReference),
        }),
      });
      setPaymentReference('');
      setProofDataUrl('');
      setSuccessMsg('Deposit request submitted. Finance Maker & Checker will verify your payment reference.');
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit deposit request');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
      <section className="lg:col-span-6 bg-white rounded-3xl border border-slate-200 p-6">
        <h2 className="font-display text-lg font-bold text-slate-900">Add Money (Deposit Request)</h2>
        <p className="text-xs text-slate-500 mt-1">
          Transfer funds to our settlement account via EcoCash, InnBucks, ZIPIT, or Bank Transfer, then submit your reference and proof.
        </p>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">Destination Wallet</label>
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
              <label className="block text-xs font-medium text-slate-700 mb-1.5">Method</label>
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value as typeof method)}
                className="w-full h-11 rounded-xl border border-slate-200 px-3 text-sm bg-white"
              >
                <option value="ECOCASH">EcoCash</option>
                <option value="INNBUCKS">InnBucks</option>
                <option value="ZIPIT">ZIPIT Instant</option>
                <option value="BANK_TRANSFER">Bank Transfer</option>
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
              <label className="block text-xs font-medium text-slate-700 mb-1.5">Payment Reference</label>
              <input
                type="text"
                required
                value={paymentReference}
                onChange={(e) => setPaymentReference(e.target.value)}
                placeholder="e.g. ECO-2026-55912"
                className="w-full h-11 rounded-xl border border-slate-200 px-3.5 font-mono text-sm uppercase"
              />
            </div>
          </div>

          <label className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 p-4 text-center cursor-pointer hover:bg-slate-50">
            <Upload className="w-5 h-5 text-slate-500 mb-1" />
            <span className="text-xs font-semibold text-slate-800">
              {proofDataUrl ? 'Proof of Payment Attached' : 'Upload Proof of Payment'}
            </span>
            <span className="text-[11px] text-slate-400 mt-0.5">Upload PNG, JPG, or PDF payment receipt</span>
            <input
              type="file"
              accept="image/*,application/pdf"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
            />
          </label>

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
            className="w-full h-12 rounded-xl bg-emerald-700 text-white text-sm font-semibold hover:bg-emerald-800 disabled:opacity-60"
          >
            {submitting ? 'Submitting...' : 'Submit Deposit Request'}
          </button>
        </form>
      </section>

      <section className="lg:col-span-6 bg-white rounded-3xl border border-slate-200 p-6">
        <h3 className="font-display text-base font-semibold text-slate-900">Your Deposit Requests</h3>
        <p className="text-xs text-slate-500 mt-0.5">Duplicate payment references are automatically blocked</p>

        <div className="mt-4 divide-y divide-slate-100">
          {deposits.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-500">No deposit requests submitted yet.</p>
          ) : (
            deposits.map((d) => (
              <div key={d.id} className="py-3.5 flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-semibold text-slate-900 font-mono">
                    {formatMinorUnits(d.amountMinor, d.currency)} · {d.paymentReference}
                  </p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {d.method} · {d.status} · {new Date(d.createdAt).toLocaleDateString()}
                  </p>
                  {d.notes && <p className="text-xs text-slate-600 mt-1">Note: {d.notes}</p>}
                </div>
                <span className="text-xs font-semibold text-slate-700">{d.status}</span>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
};
