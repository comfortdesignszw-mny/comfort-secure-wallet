import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

class AppErrorBoundary extends React.Component<{ children: React.ReactNode }, ErrorBoundaryState> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      message: error?.message || 'An unexpected interface error occurred.',
    };
  }

  componentDidCatch(error: Error) {
    console.error('Comfort Secure Wallet UI boundary caught:', error);
  }

  handleResetSessionAndReload = async () => {
    try {
      await fetch('/api/v1/auth/logout', { method: 'POST', credentials: 'include' });
    } catch {
      // ignore
    }
    try {
      window.localStorage.removeItem('csw_returning_accounts_v1');
    } catch {
      // ignore
    }
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#F7F8FA] flex items-center justify-center p-6">
          <div className="w-full max-w-md bg-white rounded-3xl border border-slate-200 p-7 text-center space-y-4 shadow-sm">
            <h1 className="font-display text-lg font-bold text-slate-900">
              Comfort Secure Wallet Recovery
            </h1>
            <p className="text-xs text-slate-600 leading-relaxed">
              The screen encountered an unexpected state and was safely paused to protect your session.
            </p>
            <p className="text-[11px] font-mono text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2 break-words">
              {this.state.message}
            </p>
            <div className="flex flex-col sm:flex-row gap-2.5 pt-1">
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="flex-1 h-11 rounded-xl bg-emerald-700 text-white text-xs font-semibold hover:bg-emerald-800"
              >
                Reload Wallet
              </button>
              <button
                type="button"
                onClick={() => void this.handleResetSessionAndReload()}
                className="flex-1 h-11 rounded-xl border border-slate-200 text-slate-700 text-xs font-semibold hover:bg-slate-50"
              >
                Reset Session &amp; Reload
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <AppErrorBoundary>
    <App />
  </AppErrorBoundary>,
);
