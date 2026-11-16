import React from 'react';
import { LegalDocId } from './LegalDocsModal.tsx';

interface SiteFooterProps {
  onOpenLegalDoc: (doc: LegalDocId) => void;
}

export const SiteFooter: React.FC<SiteFooterProps> = ({ onOpenLegalDoc }) => {
  return (
    <footer className="w-full border-t border-[#183163] bg-[#0B1B3B] text-slate-200 py-7 px-5 mt-auto">
      <div className="max-w-6xl mx-auto flex flex-col items-center text-center gap-3.5">
        <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs font-medium text-emerald-300">
          <button
            type="button"
            onClick={() => onOpenLegalDoc('terms')}
            className="hover:text-emerald-200 underline-offset-4 hover:underline transition-colors"
          >
            Terms of Use
          </button>
          <button
            type="button"
            onClick={() => onOpenLegalDoc('privacy')}
            className="hover:text-emerald-200 underline-offset-4 hover:underline transition-colors"
          >
            Privacy Policy
          </button>
          <button
            type="button"
            onClick={() => onOpenLegalDoc('aml')}
            className="hover:text-emerald-200 underline-offset-4 hover:underline transition-colors"
          >
            AML / CFT &amp; Risk Disclosure
          </button>
          <button
            type="button"
            onClick={() => onOpenLegalDoc('fees')}
            className="hover:text-emerald-200 underline-offset-4 hover:underline transition-colors"
          >
            Fee &amp; Safeguarding Schedule
          </button>
        </div>

        <div className="space-y-1 text-xs">
          <p className="font-semibold text-white">
            @2026 Comfort Secure Wallet. All Rights Reserved
          </p>
          <p className="text-slate-300">
            Developed with ❤️ by Comfort Designs - +263772824132
          </p>
        </div>
      </div>
    </footer>
  );
};
