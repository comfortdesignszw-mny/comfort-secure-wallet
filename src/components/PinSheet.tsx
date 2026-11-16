import React, { useState } from 'react';
import { Delete, Lock, X } from 'lucide-react';
import { Currency } from '../shared/types.ts';
import { formatMinorUnits } from '../shared/money.ts';
import { apiFetch, setViewStepUpToken } from '../lib/api.ts';

interface PinSheetProps {
  open: boolean;
  onClose: () => void;
  scope: 'view' | 'transaction' | 'admin_action';
  action?: 'transfer' | 'withdrawal';
  adminAction?: string;
  amountMinor?: number;
  currency?: Currency;
  title?: string;
  subtitle?: string;
  onVerified: (stepUpToken: string) => void;
}

export const PinSheet: React.FC<PinSheetProps> = ({
  open,
  onClose,
  scope,
  action,
  adminAction,
  amountMinor,
  currency,
  title,
  subtitle,
  onVerified,
}) => {
  const [pin, setPin] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const submitPin = async (candidate: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ stepUpToken: string; expiresInSeconds: number }>('/pin/verify', {
        method: 'POST',
        body: JSON.stringify({
          pin: candidate,
          scope,
          action,
          adminAction,
          amountMinor,
          currency,
        }),
      });
      if (scope === 'view') {
        setViewStepUpToken(res.stepUpToken, res.expiresInSeconds);
      }
      setPin('');
      onVerified(res.stepUpToken);
    } catch (err) {
      setPin('');
      setError(err instanceof Error ? err.message : 'PIN verification failed');
    } finally {
      setLoading(false);
    }
  };

  const handleDigit = (d: string) => {
    if (loading || pin.length >= 6) return;
    const next = pin + d;
    setPin(next);
    setError(null);
    if (next.length === 6) {
      void submitPin(next);
    }
  };

  const handleBackspace = () => {
    if (loading) return;
    setPin((prev) => prev.slice(0, -1));
  };

  const defaultTitle =
    scope === 'view'
      ? 'Unlock Wallet View'
      : scope === 'admin_action'
        ? 'Authorize Back-Office Action'
        : 'Authorize Transaction';

  const defaultSubtitle =
    scope === 'transaction' && amountMinor && currency
      ? `Fresh 6-digit PIN required for ${action} of ${formatMinorUnits(amountMinor, currency)}`
      : scope === 'admin_action'
        ? 'Enter your 6-digit Staff Security PIN to authorize this sensitive operation'
        : 'Enter your 6-digit security PIN';

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-slate-900/55 backdrop-blur-xs">
      <div className="w-full max-w-md rounded-t-3xl md:rounded-2xl bg-white border border-slate-200 p-6 shadow-2xl">
        <div className="w-10 h-1 bg-slate-200 rounded-full mx-auto mb-4 md:hidden" />

        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-50 border border-emerald-200 flex items-center justify-center text-emerald-700 shrink-0">
              <Lock className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-slate-900">{title || defaultTitle}</h3>
              <p className="text-xs text-slate-500 mt-0.5">{subtitle || defaultSubtitle}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setPin('');
              setError(null);
              onClose();
            }}
            aria-label="Close PIN prompt"
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl text-slate-400 hover:text-slate-700 hover:bg-slate-100"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 6-digit visual dots */}
        <div className="flex justify-center gap-3 my-6" aria-label="PIN entry progress">
          {[0, 1, 2, 3, 4, 5].map((idx) => (
            <div
              key={idx}
              className={`w-10 h-12 rounded-xl border flex items-center justify-center font-mono text-lg font-semibold transition-colors ${
                pin.length > idx
                  ? 'border-emerald-600 bg-emerald-50 text-emerald-800'
                  : 'border-slate-200 bg-slate-50 text-slate-300'
              }`}
            >
              {pin.length > idx ? '•' : ''}
            </div>
          ))}
        </div>

        {error && (
          <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs font-medium text-red-700">
            {error}
          </div>
        )}

        {/* Tactile 44px+ keypad */}
        <div className="grid grid-cols-3 gap-2.5">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
            <button
              key={digit}
              type="button"
              disabled={loading}
              onClick={() => handleDigit(digit)}
              className="h-12 min-h-[48px] rounded-xl border border-slate-200 bg-slate-50/70 font-mono text-lg font-semibold text-slate-900 hover:bg-slate-100 active:scale-[0.98] transition-all disabled:opacity-50"
            >
              {digit}
            </button>
          ))}
          <div />
          <button
            type="button"
            disabled={loading}
            onClick={() => handleDigit('0')}
            className="h-12 min-h-[48px] rounded-xl border border-slate-200 bg-slate-50/70 font-mono text-lg font-semibold text-slate-900 hover:bg-slate-100 active:scale-[0.98] transition-all disabled:opacity-50"
          >
            0
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={handleBackspace}
            aria-label="Backspace"
            className="h-12 min-h-[48px] rounded-xl border border-slate-200 bg-slate-50/70 flex items-center justify-center text-slate-700 hover:bg-slate-100 active:scale-[0.98] transition-all disabled:opacity-50"
          >
            <Delete className="w-5 h-5" />
          </button>
        </div>

        <p className="mt-4 text-center text-[11px] text-slate-400">
          {loading
            ? 'Verifying security PIN...'
            : '3 failed attempts lock PIN for 30 minutes'}
        </p>
      </div>
    </div>
  );
};
