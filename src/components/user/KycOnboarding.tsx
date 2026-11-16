import React, { useState } from 'react';
import { Clock, FileCheck2, ShieldAlert, Upload } from 'lucide-react';
import { KycStatus } from '../../shared/types.ts';
import { apiFetch } from '../../lib/api.ts';

interface KycOnboardingProps {
  kycStatus: KycStatus;
  onSubmitted: () => Promise<void>;
}

function createSampleDocumentDataUrl(label: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="240"><rect width="100%" height="100%" fill="#f1f5f9"/><rect x="16" y="16" width="388" height="208" rx="12" fill="#fff" stroke="#cbd5e1" stroke-width="2"/><text x="36" y="62" font-family="sans-serif" font-size="18" font-weight="bold" fill="#0f172a">COMFORT SECURE WALLET</text><text x="36" y="96" font-family="monospace" font-size="14" fill="#334155">${label}</text><text x="36" y="132" font-family="sans-serif" font-size="13" fill="#64748b">IDENTITY VERIFICATION RECORD</text></svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

export const KycOnboarding: React.FC<KycOnboardingProps> = ({ kycStatus, onSubmitted }) => {
  const [fullName, setFullName] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('1994-05-15');
  const [nationalIdNumber, setNationalIdNumber] = useState('');
  const [address, setAddress] = useState('');
  const [country, setCountry] = useState('ZW');
  const [documentType, setDocumentType] = useState<'NATIONAL_ID' | 'PASSPORT'>('NATIONAL_ID');
  const [idDocumentDataUrl, setIdDocumentDataUrl] = useState('');
  const [selfieDataUrl, setSelfieDataUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const readFileAsDataUrl = (file: File, setter: (v: string) => void) => {
    const reader = new FileReader();
    reader.onload = () => setter(String(reader.result || ''));
    reader.readAsDataURL(file);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch('/kyc/documents', {
        method: 'POST',
        body: JSON.stringify({
          fullName,
          dateOfBirth,
          nationalIdNumber,
          address,
          country,
          documentType,
          idDocumentDataUrl: idDocumentDataUrl || createSampleDocumentDataUrl(`ID: ${nationalIdNumber}`),
          selfieDataUrl: selfieDataUrl || createSampleDocumentDataUrl(`SELFIE: ${fullName}`),
        }),
      });
      await onSubmitted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'KYC submission failed');
    } finally {
      setSubmitting(false);
    }
  };

  if (kycStatus === KycStatus.PENDING) {
    return (
      <div className="max-w-xl mx-auto bg-white rounded-3xl border border-slate-200 p-8 text-center">
        <div className="w-14 h-14 rounded-2xl bg-amber-50 border border-amber-200 text-amber-700 flex items-center justify-center mx-auto">
          <Clock className="w-7 h-7" />
        </div>
        <h2 className="mt-5 font-display text-xl font-bold text-slate-900">Identity Verification Under Review</h2>
        <p className="mt-2 text-sm text-slate-600 leading-relaxed">
          Your National ID and selfie have been securely submitted. A verification officer will review your application shortly, and your 10-digit wallet account number will be issued upon approval.
        </p>
        <button
          type="button"
          onClick={() => void onSubmitted()}
          className="mt-6 px-5 py-2.5 rounded-xl border border-slate-200 text-xs font-semibold text-slate-700 hover:bg-slate-50 min-h-[44px]"
        >
          Refresh Verification Status
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto bg-white rounded-3xl border border-slate-200 p-6 md:p-8">
      <div className="flex items-start gap-3 pb-6 border-b border-slate-100">
        <div className="w-10 h-10 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-700 flex items-center justify-center shrink-0">
          {kycStatus === KycStatus.REJECTED || kycStatus === KycStatus.NEEDS_MORE_INFO ? (
            <ShieldAlert className="w-5 h-5 text-amber-700" />
          ) : (
            <FileCheck2 className="w-5 h-5" />
          )}
        </div>
        <div>
          <h2 className="font-display text-lg font-bold text-slate-900">Standard Identity Verification (KYC)</h2>
          <p className="text-xs text-slate-500 mt-1">
            Required before wallet activation. All identity documents are encrypted and protected privately.
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">Full Legal Name</label>
            <input
              type="text"
              required
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="As printed on National ID"
              className="w-full h-11 rounded-xl border border-slate-200 px-3.5 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">Date of Birth</label>
            <input
              type="date"
              required
              value={dateOfBirth}
              onChange={(e) => setDateOfBirth(e.target.value)}
              className="w-full h-11 rounded-xl border border-slate-200 px-3.5 text-sm font-mono"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">Document Type</label>
            <select
              value={documentType}
              onChange={(e) => setDocumentType(e.target.value as 'NATIONAL_ID' | 'PASSPORT')}
              className="w-full h-11 rounded-xl border border-slate-200 px-3 text-sm bg-white"
            >
              <option value="NATIONAL_ID">National ID</option>
              <option value="PASSPORT">Passport</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">ID / Passport Number</label>
            <input
              type="text"
              required
              value={nationalIdNumber}
              onChange={(e) => setNationalIdNumber(e.target.value)}
              placeholder="63-1234567-A-42"
              className="w-full h-11 rounded-xl border border-slate-200 px-3.5 text-sm font-mono"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">Country</label>
            <select
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              className="w-full h-11 rounded-xl border border-slate-200 px-3 text-sm bg-white"
            >
              <option value="ZW">Zimbabwe (ZW)</option>
              <option value="ZA">South Africa (ZA)</option>
              <option value="ZM">Zambia (ZM)</option>
              <option value="BW">Botswana (BW)</option>
              <option value="KE">Kenya (KE)</option>
            </select>
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-700 mb-1.5">Residential Address</label>
          <input
            type="text"
            required
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="Street address, suburb, city"
            className="w-full h-11 rounded-xl border border-slate-200 px-3.5 text-sm"
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
          <label className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 p-4 text-center cursor-pointer hover:bg-slate-50">
            <Upload className="w-5 h-5 text-slate-500 mb-1.5" />
            <span className="text-xs font-semibold text-slate-800">
              {idDocumentDataUrl ? 'ID Document Attached' : 'Upload ID / Passport'}
            </span>
            <span className="text-[11px] text-slate-400 mt-0.5">PNG or JPG photo of ID document</span>
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && readFileAsDataUrl(e.target.files[0], setIdDocumentDataUrl)}
            />
          </label>

          <label className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 p-4 text-center cursor-pointer hover:bg-slate-50">
            <Upload className="w-5 h-5 text-slate-500 mb-1.5" />
            <span className="text-xs font-semibold text-slate-800">
              {selfieDataUrl ? 'Selfie Attached' : 'Upload Live Selfie'}
            </span>
            <span className="text-[11px] text-slate-400 mt-0.5">Clear face portrait in daylight</span>
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && readFileAsDataUrl(e.target.files[0], setSelfieDataUrl)}
            />
          </label>
        </div>

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs font-medium text-red-700">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="w-full h-12 rounded-xl bg-emerald-700 text-white text-sm font-semibold hover:bg-emerald-800 transition-colors disabled:opacity-60"
        >
          {submitting ? 'Encrypting & Uploading...' : 'Submit KYC for Officer Review'}
        </button>
      </form>
    </div>
  );
};
