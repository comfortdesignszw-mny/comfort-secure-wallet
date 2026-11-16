import React, { useState } from 'react';
import { CheckCircle2, FileText, Lock, Scale, ShieldCheck, X } from 'lucide-react';

export type LegalDocId = 'terms' | 'privacy' | 'aml' | 'fees';

interface LegalDocsModalProps {
  open: boolean;
  initialDoc: LegalDocId;
  onClose: () => void;
  onConfirmUnderstand: () => void;
  alreadyConfirmed?: boolean;
}

const TABS: Array<{ id: LegalDocId; label: string; icon: React.ReactNode }> = [
  { id: 'terms', label: 'Terms of Use', icon: <FileText className="w-3.5 h-3.5" /> },
  { id: 'privacy', label: 'Privacy Policy', icon: <Lock className="w-3.5 h-3.5" /> },
  { id: 'aml', label: 'AML / CFT & Risk', icon: <ShieldCheck className="w-3.5 h-3.5" /> },
  { id: 'fees', label: 'Fee & Safeguarding', icon: <Scale className="w-3.5 h-3.5" /> },
];

export const LegalDocsModal: React.FC<LegalDocsModalProps> = ({
  open,
  initialDoc,
  onClose,
  onConfirmUnderstand,
  alreadyConfirmed,
}) => {
  const [activeDoc, setActiveDoc] = useState<LegalDocId>(initialDoc);

  React.useEffect(() => {
    setActiveDoc(initialDoc);
  }, [initialDoc, open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/60 backdrop-blur-xs p-0 sm:p-4">
      <div className="w-full max-w-3xl max-h-[90vh] bg-white rounded-t-3xl sm:rounded-3xl border border-slate-200 shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
          <div>
            <h2 className="font-display text-base font-bold text-slate-900">
              Comfort Secure Wallet — Financial Legal Documentation
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Effective 2026 · Operated & Engineered by Comfort Designs (+263772824132)
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close legal documentation"
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl text-slate-400 hover:text-slate-700 hover:bg-slate-100"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Document Tabs */}
        <div className="px-6 py-3 bg-slate-50 border-b border-slate-200 flex items-center gap-2 overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveDoc(t.id)}
              className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold whitespace-nowrap min-h-[38px] transition-colors ${
                activeDoc === t.id
                  ? 'bg-slate-900 text-white'
                  : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-100'
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>

        {/* Scrollable Legal Copy */}
        <div className="flex-1 overflow-y-auto px-6 py-5 text-xs text-slate-700 leading-relaxed space-y-4">
          {activeDoc === 'terms' && (
            <>
              <h3 className="font-display text-sm font-bold text-slate-900">1. Financial Services Terms of Use</h3>
              <p>
                By creating an account or accessing <strong>Comfort Secure Wallet</strong>, you enter into a binding agreement governing digital stored-value wallet custody, peer-to-peer wallet transfers, deposits, and withdrawals in supported currencies (USD default, ZWG, and ZAR).
              </p>
              <h4 className="font-semibold text-slate-900">1.1 Account Eligibility & Verification</h4>
              <p>
                Every customer must register with verified contact credentials (Google Social Sign-In, verified Email, or verified Mobile Phone) and submit valid government-issued KYC identity documentation. Wallet account numbers are issued strictly after KYC Officer review and approval.
              </p>
              <h4 className="font-semibold text-slate-900">1.2 Security Credentials & 6-Digit Security PIN</h4>
              <p>
                You are strictly responsible for safeguarding your account password, one-time verification codes (OTP), and 6-digit Security PIN. Three consecutive incorrect PIN entries automatically trigger a 30-minute lockout; repeated lockouts place a protective hold requiring compliance verification.
              </p>
              <h4 className="font-semibold text-slate-900">1.3 Immutable Double-Entry Settlement & Reversals</h4>
              <p>
                All approved transfers settle immediately on an immutable double-entry financial ledger where debits equal credits and no user balance may go negative. Authorised transfers cannot be cancelled unilaterally by the sender; erroneous transactions may only be corrected through dual-control administrative reversals logged to the permanent audit trail.
              </p>
              <h4 className="font-semibold text-slate-900">1.4 Mandatory Transaction & Security Notifications</h4>
              <p>
                For fraud protection, real-time Push notifications, in-app alerts, and security OTP notices are mandatory for every transaction, deposit, withdrawal, PIN lockout, and unrecognized device sign-in on your account.
              </p>
            </>
          )}

          {activeDoc === 'privacy' && (
            <>
              <h3 className="font-display text-sm font-bold text-slate-900">2. Privacy & Data Protection Notice</h3>
              <p>
                Comfort Secure Wallet processes personal and financial records in alignment with the Zimbabwe Cyber and Data Protection Act [Chapter 12:07] and applicable African regional financial privacy standards.
              </p>
              <h4 className="font-semibold text-slate-900">2.1 Information We Collect</h4>
              <ul className="list-disc pl-5 space-y-1">
                <li>Identity data: full legal name, date of birth, national ID/passport document, and biometric selfie verification.</li>
                <li>Contact & authentication telemetry: verified email, mobile number, device fingerprints, IP addresses, and rotating session logs.</li>
                <li>Financial records: wallet account numbers, deposit proofs, payout destinations, and double-entry ledger statements.</li>
              </ul>
              <h4 className="font-semibold text-slate-900">2.2 Encryption, Storage & Access Controls</h4>
              <p>
                National ID numbers, payout bank/mobile-money destinations, and uploaded verification documents are encrypted at rest and accessible solely via short-lived authorized links to vetted KYC and Finance officers under strict role-based controls. Passwords and 6-digit Security PINs are cryptographically hashed and are never stored or displayed in plaintext.
              </p>
              <h4 className="font-semibold text-slate-900">2.3 Retention & Contact</h4>
              <p>
                Statutory AML/CFT financial ledgers and audit logs are retained for the minimum period required by financial regulators. For privacy inquiries or account closure requests, contact Comfort Designs on <strong>+263772824132</strong>.
              </p>
            </>
          )}

          {activeDoc === 'aml' && (
            <>
              <h3 className="font-display text-sm font-bold text-slate-900">3. AML / CFT Compliance & Risk Disclosure</h3>
              <p>
                Comfort Secure Wallet operates a zero-tolerance policy against money laundering, terrorist financing, structuring, and fraud across Zimbabwe and SADC/Pan-African corridors.
              </p>
              <h4 className="font-semibold text-slate-900">3.1 Transaction Monitoring & Automated Flags</h4>
              <p>
                Transactions are continuously screened for rapid velocity bursts, structuring just below reporting thresholds, duplicate deposit payment references, and anomalous device behavior. Compliance Officers may temporarily freeze accounts pending Source-of-Funds verification.
              </p>
              <h4 className="font-semibold text-slate-900">3.2 Staff Segregation of Duties & Maker-Checker Controls</h4>
              <p>
                No single employee can unilaterally move or settle external funds. Deposits and withdrawals above policy thresholds require independent Maker and Checker approvals by separate authorized staff, verified with mandatory 2FA and Staff 6-digit PIN step-up authentication.
              </p>
            </>
          )}

          {activeDoc === 'fees' && (
            <>
              <h3 className="font-display text-sm font-bold text-slate-900">4. Fee Schedule & Fund Safeguarding Policy</h3>
              <div className="rounded-2xl border border-slate-200 overflow-hidden">
                <table className="w-full text-left border-collapse">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                    <tr>
                      <th className="py-2.5 px-3">Service / Rail</th>
                      <th className="py-2.5 px-3">Fee Structure (Tier 1 USD)</th>
                      <th className="py-2.5 px-3">Default Limits</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-mono">
                    <tr>
                      <td className="py-2.5 px-3 font-sans font-medium">Deposits (Bank / EcoCash / InnBucks / ZIPIT)</td>
                      <td className="py-2.5 px-3">USD 0.00 (Partner Verified)</td>
                      <td className="py-2.5 px-3">Subject to Maker-Checker</td>
                    </tr>
                    <tr>
                      <td className="py-2.5 px-3 font-sans font-medium">Wallet-to-Wallet Transfer</td>
                      <td className="py-2.5 px-3">USD 0.10 + 0.50% (Max USD 2.50)</td>
                      <td className="py-2.5 px-3">Instant Double-Entry</td>
                    </tr>
                    <tr>
                      <td className="py-2.5 px-3 font-sans font-medium">External Withdrawal Payout</td>
                      <td className="py-2.5 px-3">Held in Escrow until Paid</td>
                      <td className="py-2.5 px-3">USD 100/day · USD 1,000/mo</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p>
                Customer wallet liabilities and withdrawal holds are reconciled daily against sponsoring settlement balances so total user obligations remain fully accounted for at all times.
              </p>
            </>
          )}
        </div>

        {/* Sticky Confirmation Footer */}
        <div className="px-6 py-4 bg-slate-50 border-t border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <p className="text-[11px] text-slate-600">
            By clicking <strong className="text-slate-900">I understand</strong>, you acknowledge and accept these Financial Terms of Use, Privacy Policy, AML Disclosure, and Fee Schedule.
          </p>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2.5 rounded-xl border border-slate-200 bg-white text-xs font-semibold text-slate-700 hover:bg-slate-100 min-h-[42px]"
            >
              Close
            </button>
            <button
              type="button"
              onClick={() => {
                onConfirmUnderstand();
                onClose();
              }}
              className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-xl bg-emerald-700 text-white text-xs font-semibold hover:bg-emerald-800 min-h-[42px]"
            >
              <CheckCircle2 className="w-4 h-4" />
              {alreadyConfirmed ? 'Confirmed — I understand' : 'I understand'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
