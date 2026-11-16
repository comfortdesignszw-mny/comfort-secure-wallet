import React, { useEffect, useState } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  KeyRound,
  Lock,
  Mail,
  Phone,
  Smartphone,
} from 'lucide-react';
import {
  apiFetch,
  getRememberedLogins,
  rememberLoginHint,
  RememberedLoginHint,
  setAccessToken,
} from '../../lib/api.ts';
import { signInWithGooglePopup } from '../../lib/firebase.ts';
import { ensurePushSubscription } from '../../lib/pushNotifications.ts';
import { LegalDocId } from '../LegalDocsModal.tsx';
import { PWAInstallButton } from '../PWAInstallButton.tsx';
import { SiteFooter } from '../SiteFooter.tsx';
import { WalletBrandMark } from '../WalletBrandMark.tsx';

interface AuthFlowProps {
  legalAccepted: boolean;
  onSetLegalAccepted: (accepted: boolean) => void;
  onOpenLegalDoc: (doc: LegalDocId) => void;
  onAuthenticated: () => Promise<void>;
  onSwitchToAdmin: () => void;
}

export const AuthFlow: React.FC<AuthFlowProps> = ({
  legalAccepted,
  onSetLegalAccepted,
  onOpenLegalDoc,
  onAuthenticated,
  onSwitchToAdmin,
}) => {
  const [rememberedHints, setRememberedHints] = useState<RememberedLoginHint[]>(() =>
    getRememberedLogins('wallet'),
  );
  const [mode, setMode] = useState<'pin_login' | 'login' | 'register' | 'otp' | 'pin'>(() =>
    getRememberedLogins('wallet').length > 0 ? 'pin_login' : 'login',
  );
  const [channel, setChannel] = useState<'email' | 'phone'>(() =>
    getRememberedLogins('wallet')[0]?.channel || 'email',
  );
  const [email, setEmail] = useState(() =>
    getRememberedLogins('wallet')[0]?.channel === 'email' ? getRememberedLogins('wallet')[0].identifier : '',
  );
  const [phone, setPhone] = useState(() =>
    getRememberedLogins('wallet')[0]?.channel === 'phone' ? getRememberedLogins('wallet')[0].identifier : '+26377',
  );
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [loginPin, setLoginPin] = useState('');
  const [otpTarget, setOtpTarget] = useState('');
  const [otpChannel, setOtpChannel] = useState<'SMS' | 'EMAIL'>('EMAIL');
  const [otpCode, setOtpCode] = useState('');
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRememberedHints(getRememberedLogins('wallet'));
  }, []);

  const persistHint = (ch: 'email' | 'phone', id: string) => {
    rememberLoginHint({ identifier: id, channel: ch, surface: 'wallet' });
    setRememberedHints(getRememberedLogins('wallet'));
  };

  const handlePinLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const payload =
        channel === 'email'
          ? { email, pin: loginPin, deviceFingerprint: 'pwa_web_pin', deviceLabel: '6-Digit PIN Quick Sign-In' }
          : { phone, pin: loginPin, deviceFingerprint: 'pwa_web_pin', deviceLabel: '6-Digit PIN Quick Sign-In' };
      const res = await apiFetch<{ accessToken: string }>('/auth/pin-login', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setAccessToken(res.accessToken);
      persistHint(channel, channel === 'email' ? email : phone);
      void ensurePushSubscription();
      await onAuthenticated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'PIN sign-in failed');
    } finally {
      setLoading(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const payload =
        channel === 'email'
          ? { email, password, deviceFingerprint: 'pwa_web_primary', deviceLabel: 'Comfort PWA Browser' }
          : { phone, password, deviceFingerprint: 'pwa_web_primary', deviceLabel: 'Comfort PWA Browser' };

      const res = await apiFetch<{
        accessToken: string;
        requiresPinSetup?: boolean;
      }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setAccessToken(res.accessToken);
      persistHint(channel, channel === 'email' ? email : phone);
      void ensurePushSubscription();
      if (res.requiresPinSetup) {
        setMode('pin');
      } else {
        await onAuthenticated();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!legalAccepted) {
      setError('Please read and confirm our Terms of Use & Privacy Policy ("I understand") before creating an account.');
      onOpenLegalDoc('terms');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const payload =
        channel === 'email'
          ? {
              email,
              password,
              fullName,
              legalAccepted: true,
              deviceFingerprint: 'pwa_web_primary',
              deviceLabel: 'Comfort PWA Browser',
            }
          : {
              phone,
              password,
              fullName,
              legalAccepted: true,
              deviceFingerprint: 'pwa_web_primary',
              deviceLabel: 'Comfort PWA Browser',
            };
      const res = await apiFetch<{
        accessToken: string;
        otpTarget: string;
        otpChannel: 'SMS' | 'EMAIL';
      }>('/auth/register', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setAccessToken(res.accessToken);
      persistHint(channel, channel === 'email' ? email : phone);
      setOtpTarget(res.otpTarget);
      setOtpChannel(res.otpChannel);
      setMode('otp');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed');
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleLogin = async () => {
    if (mode === 'register' && !legalAccepted) {
      setError('Please confirm the Terms of Use & Privacy Policy ("I understand") before registering with Google.');
      onOpenLegalDoc('terms');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const idToken = await signInWithGooglePopup();
      const res = await apiFetch<{
        accessToken: string;
        user: { email?: string | null };
        requiresPinSetup?: boolean;
      }>('/auth/google', {
        method: 'POST',
        body: JSON.stringify({
          idToken,
          legalAccepted,
          deviceFingerprint: 'pwa_google_web',
          deviceLabel: 'Google Account',
        }),
      });
      setAccessToken(res.accessToken);
      if (res.user?.email) {
        persistHint('email', res.user.email);
      }
      void ensurePushSubscription();
      if (res.requiresPinSetup) {
        setMode('pin');
      } else {
        await onAuthenticated();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Google sign-in cancelled or failed');
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await apiFetch('/auth/otp/verify', {
        method: 'POST',
        body: JSON.stringify({
          target: otpTarget,
          channel: otpChannel,
          purpose: 'REGISTER',
          code: otpCode,
        }),
      });
      setMode('pin');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'OTP verification failed');
    } finally {
      setLoading(false);
    }
  };

  const handleSetPin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pin !== confirmPin) {
      setError('Security PIN and confirmation PIN must match.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await apiFetch('/pin/set', {
        method: 'POST',
        body: JSON.stringify({ pin, confirmPin }),
      });
      void ensurePushSubscription();
      await onAuthenticated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not set PIN');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#F7F8FA] flex flex-col">
      <header className="w-full max-w-6xl mx-auto px-5 py-4 flex items-center justify-between gap-6">
        <div className="flex items-center gap-2.5 shrink-0">
          <WalletBrandMark className="w-8 h-8" />
          <span className="font-display text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap">
            Comfort Secure Wallet
          </span>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <PWAInstallButton />
          <button
            type="button"
            onClick={onSwitchToAdmin}
            className="text-xs font-medium text-slate-600 hover:text-slate-900 px-3 py-2 rounded-lg border border-slate-200 bg-white whitespace-nowrap shrink-0 min-h-[40px]"
          >
            Staff Console
          </button>
        </div>
      </header>

      <main className="flex-1 w-full max-w-6xl mx-auto px-5 py-6 md:py-10 grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch">
        {/* Left editorial landing overview */}
        <section className="lg:col-span-6 flex flex-col justify-between bg-slate-900 text-slate-50 rounded-3xl p-8 md:p-10">
          <div>
            <p className="text-xs font-medium text-emerald-300 tracking-wide">
              Zimbabwe &amp; Pan-African Digital Finance
            </p>
            <h1 className="mt-4 font-display text-3xl md:text-4xl font-bold tracking-tight text-balance leading-[1.15]">
              Trusted digital custody built for Zimbabwe and wider Africa.
            </h1>
            <p className="mt-4 text-sm md:text-base text-slate-300 leading-relaxed max-w-lg">
              Move value across USD, ZWG, and ZAR wallets with institutional safeguards, real-time account alerts, and verifiable financial records designed for everyday confidence.
            </p>
          </div>

          <div className="mt-10 pt-8 border-t border-slate-800 space-y-5">
            <div className="flex items-start gap-4">
              <span className="font-mono text-xs font-semibold text-emerald-300 pt-0.5 shrink-0">01</span>
              <div>
                <h2 className="text-sm font-semibold text-white">Local African Finance Architecture</h2>
                <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                  Built around local bank and mobile-money corridors including EcoCash, InnBucks, ZIPIT, and bank settlement reconciliation.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-4">
              <span className="font-mono text-xs font-semibold text-emerald-300 pt-0.5 shrink-0">02</span>
              <div>
                <h2 className="text-sm font-semibold text-white">Auditable Transactions</h2>
                <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                  Every deposit, transfer, and withdrawal is recorded in an immutable double-entry ledger with verifiable PDF receipts and range statements.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-4">
              <span className="font-mono text-xs font-semibold text-emerald-300 pt-0.5 shrink-0">03</span>
              <div>
                <h2 className="text-sm font-semibold text-white">Secure and Safe Financial Service</h2>
                <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                  Encrypted KYC onboarding, dual-control operations, mandatory transaction push notifications, and strong user authentication keep funds protected.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Right authentication card */}
        <section className="lg:col-span-6 bg-white rounded-3xl border border-slate-200 p-6 md:p-9 flex flex-col justify-between">
          {mode === 'pin_login' || mode === 'login' || mode === 'register' ? (
            <div>
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
                <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-xl">
                  <button
                    type="button"
                    onClick={() => {
                      setMode('pin_login');
                      setError(null);
                    }}
                    className={`px-3 py-2 text-xs font-semibold rounded-lg transition-colors min-h-[38px] inline-flex items-center gap-1.5 ${
                      mode === 'pin_login' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    <Lock className="w-3.5 h-3.5" />
                    PIN Sign-In
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMode('login');
                      setError(null);
                    }}
                    className={`px-3 py-2 text-xs font-semibold rounded-lg transition-colors min-h-[38px] ${
                      mode === 'login' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Password
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMode('register');
                      setError(null);
                    }}
                    className={`px-3 py-2 text-xs font-semibold rounded-lg transition-colors min-h-[38px] ${
                      mode === 'register' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Create Account
                  </button>
                </div>

                <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-xl">
                  <button
                    type="button"
                    onClick={() => setChannel('email')}
                    className={`px-2.5 py-1.5 text-xs font-medium rounded-lg flex items-center gap-1 min-h-[36px] ${
                      channel === 'email' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                    }`}
                  >
                    <Mail className="w-3.5 h-3.5" />
                    Email
                  </button>
                  <button
                    type="button"
                    onClick={() => setChannel('phone')}
                    className={`px-2.5 py-1.5 text-xs font-medium rounded-lg flex items-center gap-1 min-h-[36px] ${
                      channel === 'phone' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                    }`}
                  >
                    <Phone className="w-3.5 h-3.5" />
                    Phone
                  </button>
                </div>
              </div>

              {mode === 'pin_login' && rememberedHints.length > 0 && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {rememberedHints.map((hint) => (
                    <button
                      key={`${hint.channel}:${hint.identifier}`}
                      type="button"
                      onClick={() => {
                        setChannel(hint.channel);
                        if (hint.channel === 'email') setEmail(hint.identifier);
                        else setPhone(hint.identifier);
                      }}
                      className="px-3 py-1.5 rounded-lg border border-emerald-200 bg-emerald-50/70 text-xs font-medium text-emerald-900 hover:bg-emerald-100"
                    >
                      {hint.identifier}
                    </button>
                  ))}
                </div>
              )}

              <form
                onSubmit={
                  mode === 'pin_login' ? handlePinLogin : mode === 'login' ? handleLogin : handleRegister
                }
                className="mt-5 space-y-4"
              >
                {mode === 'register' && (
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1.5">Full Legal Name</label>
                    <input
                      type="text"
                      required
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      placeholder="Full name as on ID"
                      className="w-full h-11 rounded-xl border border-slate-200 px-3.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-600"
                    />
                  </div>
                )}

                {channel === 'email' ? (
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1.5">Email Address</label>
                    <input
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="name@example.com"
                      className="w-full h-11 rounded-xl border border-slate-200 px-3.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-600"
                    />
                  </div>
                ) : (
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1.5">Mobile Number (E.164)</label>
                    <input
                      type="tel"
                      required
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder="+263770000000"
                      className="w-full h-11 rounded-xl border border-slate-200 px-3.5 font-mono text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-600"
                    />
                  </div>
                )}

                {mode === 'pin_login' ? (
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1.5">
                      6-Digit Wallet PIN
                    </label>
                    <input
                      type="password"
                      inputMode="numeric"
                      pattern="\d{6}"
                      maxLength={6}
                      required
                      value={loginPin}
                      onChange={(e) => setLoginPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      placeholder="••••••"
                      className="w-full h-12 rounded-xl border border-slate-200 px-4 font-mono text-xl tracking-[0.4em] text-center text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-600"
                    />
                  </div>
                ) : (
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1.5">
                      Password {mode === 'register' && <span className="text-slate-400">(min 10 chars, letters + digits)</span>}
                    </label>
                    <input
                      type="password"
                      required
                      minLength={mode === 'register' ? 10 : 1}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••••••"
                      className="w-full h-11 rounded-xl border border-slate-200 px-3.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-600"
                    />
                  </div>
                )}

                {/* Legal Documentation & I Understand Confirmation */}
                <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-3.5 space-y-2">
                  <div className="flex items-start gap-2.5">
                    <input
                      id="wallet-legal-accept"
                      type="checkbox"
                      checked={legalAccepted}
                      onChange={(e) => onSetLegalAccepted(e.target.checked)}
                      className="mt-0.5 h-4 w-4 accent-emerald-700 shrink-0"
                    />
                    <label htmlFor="wallet-legal-accept" className="text-xs text-slate-700 leading-relaxed">
                      I have read and accept the{' '}
                      <button
                        type="button"
                        onClick={() => onOpenLegalDoc('terms')}
                        className="font-semibold text-emerald-700 underline"
                      >
                        Terms of Use
                      </button>
                      ,{' '}
                      <button
                        type="button"
                        onClick={() => onOpenLegalDoc('privacy')}
                        className="font-semibold text-emerald-700 underline"
                      >
                        Privacy Policy
                      </button>
                      ,{' '}
                      <button
                        type="button"
                        onClick={() => onOpenLegalDoc('aml')}
                        className="font-semibold text-emerald-700 underline"
                      >
                        AML Disclosure
                      </button>{' '}
                      &amp;{' '}
                      <button
                        type="button"
                        onClick={() => onOpenLegalDoc('fees')}
                        className="font-semibold text-emerald-700 underline"
                      >
                        Fee Schedule
                      </button>
                      .
                    </label>
                  </div>
                  <div className="flex items-center justify-between pl-6">
                    <button
                      type="button"
                      onClick={() => onOpenLegalDoc('terms')}
                      className="text-[11px] font-semibold text-emerald-800 hover:underline inline-flex items-center gap-1"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      {legalAccepted ? 'Confirmed: I understand' : 'Review & Click "I understand"'}
                    </button>
                  </div>
                </div>

                {error && (
                  <div className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs font-medium text-red-700">
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full h-12 rounded-xl bg-emerald-700 text-white text-sm font-semibold hover:bg-emerald-800 transition-colors flex items-center justify-center gap-2 disabled:opacity-60"
                >
                  {loading
                    ? 'Processing...'
                    : mode === 'pin_login'
                      ? 'Sign In with 6-Digit PIN'
                      : mode === 'login'
                        ? 'Sign In with Password'
                        : 'Create Account'}
                  <ArrowRight className="w-4 h-4" />
                </button>
              </form>

              {mode !== 'pin_login' && (
                <>
                  <div className="my-5 flex items-center gap-3">
                    <div className="h-px flex-1 bg-slate-200" />
                    <span className="text-xs text-slate-400">or continue with</span>
                    <div className="h-px flex-1 bg-slate-200" />
                  </div>

                  <button
                    type="button"
                    disabled={loading}
                    onClick={handleGoogleLogin}
                    className="w-full h-11 rounded-xl border border-slate-200 bg-white text-sm font-medium text-slate-800 hover:bg-slate-50 transition-colors flex items-center justify-center gap-2.5"
                  >
                    <svg className="w-4 h-4" viewBox="0 0 24 24" aria-hidden="true">
                      <path fill="#4285F4" d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17Z" />
                      <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.31 24 12 24Z" />
                      <path fill="#FBBC05" d="M5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14Z" />
                      <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96Z" />
                    </svg>
                    {mode === 'register' ? 'Sign Up with Google' : 'Continue with Google'}
                  </button>
                </>
              )}
            </div>
          ) : mode === 'otp' ? (
            <form onSubmit={handleVerifyOtp} className="space-y-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-emerald-50 border border-emerald-200 flex items-center justify-center text-emerald-700">
                  <Smartphone className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="font-display text-lg font-bold text-slate-900">Verify Your {otpChannel}</h2>
                  <p className="text-xs text-slate-500">Enter the 6-digit verification code sent to {otpTarget}</p>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">6-Digit Verification Code</label>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="\d{6}"
                  maxLength={6}
                  required
                  value={otpCode}
                  onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="000000"
                  className="w-full h-12 rounded-xl border border-slate-200 px-4 font-mono text-xl tracking-[0.35em] text-center text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>

              {error && <p className="text-xs font-medium text-red-600">{error}</p>}

              <button
                type="submit"
                disabled={loading || otpCode.length !== 6}
                className="w-full h-12 rounded-xl bg-emerald-700 text-white text-sm font-semibold hover:bg-emerald-800 disabled:opacity-60"
              >
                {loading ? 'Verifying...' : 'Verify Code & Continue'}
              </button>
            </form>
          ) : (
            <form onSubmit={handleSetPin} className="space-y-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-emerald-50 border border-emerald-200 flex items-center justify-center text-emerald-700">
                  <KeyRound className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="font-display text-lg font-bold text-slate-900">Create &amp; Confirm Your 6-Digit PIN</h2>
                  <p className="text-xs text-slate-500">
                    Used for quick returning sign-in, viewing balances, and authorizing transfers
                  </p>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">6-Digit Security PIN</label>
                <input
                  type="password"
                  inputMode="numeric"
                  pattern="\d{6}"
                  maxLength={6}
                  required
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="••••••"
                  className="w-full h-12 rounded-xl border border-slate-200 px-4 font-mono text-xl tracking-[0.4em] text-center text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">Confirm 6-Digit PIN</label>
                <input
                  type="password"
                  inputMode="numeric"
                  pattern="\d{6}"
                  maxLength={6}
                  required
                  value={confirmPin}
                  onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="••••••"
                  className="w-full h-12 rounded-xl border border-slate-200 px-4 font-mono text-xl tracking-[0.4em] text-center text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
                <p className="mt-1.5 text-[11px] text-slate-500">
                  Choose a unique 6-digit PIN and avoid simple sequences or your birth date.
                </p>
              </div>

              {error && (
                <div className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs font-medium text-red-700">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading || pin.length !== 6 || confirmPin.length !== 6}
                className="w-full h-12 rounded-xl bg-emerald-700 text-white text-sm font-semibold hover:bg-emerald-800 disabled:opacity-60"
              >
                {loading ? 'Securing PIN...' : 'Confirm PIN & Enter Wallet'}
              </button>
            </form>
          )}
        </section>
      </main>

      <SiteFooter onOpenLegalDoc={onOpenLegalDoc} />
    </div>
  );
};
