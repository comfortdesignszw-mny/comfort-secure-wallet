import React, { useRef, useState } from 'react';
import { CheckCircle2, FileText, Search, Send } from 'lucide-react';
import { Currency, TransactionRecord } from '../../shared/types.ts';
import { formatMinorUnits, parseDecimalToMinorUnits } from '../../shared/money.ts';
import { isValidLuhnAccountNumber } from '../../shared/luhn.ts';
import { apiFetch, newIdempotencyKey } from '../../lib/api.ts';
import { PinSheet } from '../PinSheet.tsx';
import { WalletAccountSummary } from './WalletDashboard.tsx';

interface SendMoneyViewProps {
  accounts: WalletAccountSummary[];
  onRefresh: () => Promise<void>;
  onDownloadReceipt: (txnId: string) => void;
}

export const SendMoneyView: React.FC<SendMoneyViewProps> = ({
  accounts,
  onRefresh,
  onDownloadReceipt,
}) => {
  const [fromAccountId, setFromAccountId] = useState(accounts[0]?.id || '');
  const [toAccountNumber, setToAccountNumber] = useState('');
  const [amountInput, setAmountInput] = useState('20.00');
  const [note, setNote] = useState('');
  const [recipientPreview, setRecipientPreview] = useState<{
    accountNumber: string;
    currency: Currency;
    maskedName: string;
    feeMinor: number;
  } | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [pinModalOpen, setPinModalOpen] = useState(false);
  const [pendingAmountMinor, setPendingAmountMinor] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [completedTxn, setCompletedTxn] = useState<TransactionRecord | null>(null);
  const inFlightRef = useRef(false);
  const draftIdemKeyRef = useRef(newIdempotencyKey());

  const selectedAcc = accounts.find((a) => a.id === fromAccountId) || accounts[0];

  const resetDraftKey = () => {
    draftIdemKeyRef.current = newIdempotencyKey();
  };

  const handleLookup = async () => {
    if (submitting) return;
    setLookupError(null);
    setRecipientPreview(null);
    setError(null);
    const cleaned = toAccountNumber.replace(/\s+/g, '');
    if (!isValidLuhnAccountNumber(cleaned)) {
      setLookupError('Enter a valid 10-digit Comfort wallet account number.');
      return;
    }
    try {
      const amountMinor = parseDecimalToMinorUnits(amountInput || '1.00', selectedAcc.currency);
      const res = await apiFetch<{
        accountNumber: string;
        currency: Currency;
        maskedName: string;
        feeMinor: number;
      }>(`/accounts/lookup/${cleaned}?amountMinor=${amountMinor}`);
      setRecipientPreview(res);
      resetDraftKey();
    } catch (err) {
      setLookupError(err instanceof Error ? err.message : 'Account lookup failed');
    }
  };

  const handleInitiateTransfer = (e: React.FormEvent) => {
    e.preventDefault();
    if (inFlightRef.current || submitting) return;
    setError(null);
    if (!selectedAcc || !recipientPreview) {
      setError('Verify the recipient account number first.');
      return;
    }
    try {
      const amountMinor = parseDecimalToMinorUnits(amountInput, selectedAcc.currency);
      setPendingAmountMinor(amountMinor);
      setPinModalOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid transfer amount');
    }
  };

  const executeWithStepUp = async (stepUpToken: string) => {
    if (inFlightRef.current || submitting) return;
    inFlightRef.current = true;
    setPinModalOpen(false);
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch<{ transaction: TransactionRecord }>('/transfers', {
        method: 'POST',
        stepUpToken,
        idempotencyKey: draftIdemKeyRef.current,
        body: JSON.stringify({
          fromAccountId: selectedAcc.id,
          toAccountNumber: recipientPreview!.accountNumber,
          amountMinor: pendingAmountMinor,
          note: note.trim() || undefined,
        }),
      });
      draftIdemKeyRef.current = newIdempotencyKey();
      setCompletedTxn(res.transaction);
      setToAccountNumber('');
      setNote('');
      setRecipientPreview(null);
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Transfer failed');
    } finally {
      inFlightRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <section className="bg-white rounded-3xl border border-slate-200 p-6 md:p-8">
        <h2 className="font-display text-lg font-bold text-slate-900">Send Money (Wallet-to-Wallet)</h2>
        <p className="text-xs text-slate-500 mt-1">
          Instant wallet-to-wallet settlement by 10-digit account number. Confirmed with your 6-digit PIN per transfer.
        </p>

        <form onSubmit={handleInitiateTransfer} className="mt-6 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">From Wallet</label>
              <select
                value={selectedAcc?.id || ''}
                onChange={(e) => {
                  setFromAccountId(e.target.value);
                  setRecipientPreview(null);
                }}
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
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                Amount ({selectedAcc?.currency || 'USD'})
              </label>
              <input
                type="text"
                inputMode="decimal"
                required
                value={amountInput}
                onChange={(e) => {
                  setAmountInput(e.target.value);
                  setRecipientPreview(null);
                }}
                className="w-full h-11 rounded-xl border border-slate-200 px-3.5 font-mono text-sm"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">Recipient 10-Digit Account Number</label>
            <div className="flex gap-2">
              <input
                type="text"
                inputMode="numeric"
                maxLength={10}
                required
                value={toAccountNumber}
                onChange={(e) => {
                  setToAccountNumber(e.target.value.replace(/\D/g, '').slice(0, 10));
                  setRecipientPreview(null);
                }}
                placeholder="10-digit wallet account number"
                className="flex-1 h-11 rounded-xl border border-slate-200 px-3.5 font-mono text-sm"
              />
              <button
                type="button"
                onClick={handleLookup}
                className="px-4 h-11 rounded-xl border border-slate-200 bg-slate-50 text-xs font-semibold text-slate-800 hover:bg-slate-100 flex items-center gap-1.5 whitespace-nowrap shrink-0"
              >
                <Search className="w-3.5 h-3.5" />
                Verify Recipient
              </button>
            </div>
            {lookupError && <p className="mt-1.5 text-xs text-red-600">{lookupError}</p>}
          </div>

          {recipientPreview && (
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50/70 p-4 space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-slate-600">Confirmed Recipient</span>
                <span className="font-semibold text-slate-900">{recipientPreview.maskedName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600">Transfer Amount</span>
                <span className="font-mono font-semibold text-slate-900 tabular-nums">
                  {formatMinorUnits(parseDecimalToMinorUnits(amountInput, selectedAcc.currency), selectedAcc.currency)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600">Platform Fee</span>
                <span className="font-mono font-semibold text-slate-900 tabular-nums">
                  {formatMinorUnits(recipientPreview.feeMinor, selectedAcc.currency)}
                </span>
              </div>
              <div className="flex justify-between pt-2 border-t border-emerald-200 font-semibold">
                <span className="text-slate-900">Total Debit</span>
                <span className="font-mono text-emerald-900 tabular-nums">
                  {formatMinorUnits(
                    parseDecimalToMinorUnits(amountInput, selectedAcc.currency) + recipientPreview.feeMinor,
                    selectedAcc.currency,
                  )}
                </span>
              </div>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">Reference Note (Optional)</label>
            <input
              type="text"
              maxLength={140}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Harare invoice payment"
              className="w-full h-11 rounded-xl border border-slate-200 px-3.5 text-sm"
            />
          </div>

          {error && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs font-medium text-red-700">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting || !recipientPreview}
            className="w-full h-12 rounded-xl bg-emerald-700 text-white text-sm font-semibold hover:bg-emerald-800 active:scale-[0.98] transition-all cursor-pointer disabled:opacity-50 disabled:pointer-events-none flex items-center justify-center gap-2"
          >
            <Send className="w-4 h-4" />
            {submitting ? 'Posting Ledger Entry...' : 'Enter PIN & Send Money'}
          </button>
        </form>
      </section>

      {completedTxn && (
        <section className="bg-white rounded-3xl border border-emerald-200 p-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="w-6 h-6 text-emerald-700 shrink-0 mt-0.5" />
            <div>
              <h3 className="text-sm font-bold text-slate-900">Transfer Complete · {completedTxn.reference}</h3>
              <p className="text-xs text-slate-600 mt-0.5 font-mono">
                {formatMinorUnits(completedTxn.amountMinor, completedTxn.currency)} sent (Fee:{' '}
                {formatMinorUnits(completedTxn.feeMinor, completedTxn.currency)})
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => onDownloadReceipt(completedTxn.id)}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 min-h-[42px] whitespace-nowrap"
          >
            <FileText className="w-4 h-4" />
            Download PDF Receipt
          </button>
        </section>
      )}

      {selectedAcc && (
        <PinSheet
          open={pinModalOpen}
          onClose={() => setPinModalOpen(false)}
          scope="transaction"
          action="transfer"
          amountMinor={pendingAmountMinor}
          currency={selectedAcc.currency}
          onVerified={(token) => void executeWithStepUp(token)}
        />
      )}
    </div>
  );
};
