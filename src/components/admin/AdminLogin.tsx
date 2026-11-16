import React, { useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  KeyRound,
  Lock,
  Mail,
  Phone,
  Smartphone,
} from 'lucide-react';
import { Role } from '../../shared/types.ts';
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
import { SiteFooter } from '../SiteFooter.tsx';
import { WalletBrandMark } from '../WalletBrandMark.tsx';

interface AdminLoginProps {
  legalAccepted: boolean;
  onSetLegalAccepted: (accepted: boolean) => void;
  onOpenLegalDoc: (doc: LegalDocId) => void;
  onAuthenticated: () => Promise<void>;
  onBackToWallet: () => void;
}

const STAFF_ROLE_OPTIONS: Array<{ value: Role; label: string }> = [
  { value: Role.FINANCE_MAKER, label: 'Finance Maker' },
  { value: Role.FINANCE_CHECKER, label: 'Finance Checker' },
  { value: Role.KYC_OFFICER, label: 'KYC Officer' },
  { value: Role.COMPLIANCE_OFFICER, label: 'Compliance Officer' },
  { value: Role.SUPPORT_AGENT, label: 'Support Agent' },
  { value: Role.AUDITOR, label: 'Auditor' },
  { value: Role.SUPER_ADMIN, label: 'Super Admin' },
];

export const AdminLogin: React.FC<AdminLoginProps> = ({
  legalAccepted,
  onSetLegalAccepted,
  onOpenLegalDoc,
  onAuthenticated,
  onBackToWallet,
}) => {
  const [rememberedHints, setRememberedHints] = useState<RememberedLoginHint[]>(() =>
    getRememberedLogins('admin'),
  );
  const [mode, setMode] = useState<'pin_login' | 'login' | 'register' | 'otp_register' | 'pin_setup'>(() =>
    getRememberedLogins('admin').length > 0 ? 'pin_login' : 'login',
  );
  const [channel, setChannel] = useState<'email' | 'phone'>(() =>
    getRememberedLogins('admin')[0]?.channel || 'email',
  );
  const [email, setEmail] = useState(() =>
    getRememberedLogins('admin')[0]?.channel === 'email' ? getRememberedLogins('admin')[0].identifier : '',
  );
  const [phone, setPhone] = useState(() =>
    getRememberedLogins('admin')[0]?.channel === 'phone' ? getRememberedLogins('admin')[0].identifier : '+26377',
  );
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [requestedRole, setRequestedRole] = useState<Role>(Role.FINANCE_MAKER);
  const [loginPin, setLoginPin] = useState('');
  const [otpRequired, setOtpRequired] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const [otpTarget, setOtpTarget] = useState('');
  const [otpChannel, setOtpChannel] = useState<'SMS' | 'EMAIL'>('EMAIL');
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const persistHint = (ch: 'email' | 'phone', id: string) => {
    rememberLoginHint({ identifier: id, channel: ch, surface: 'admin' });
    setRememberedHints(getRememberedLogins('admin'));
  };

  const handlePasswordOrPinLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const endpoint = mode === 'pin_login' ? '/auth/pin-login' : '/auth/login';
      const base =
        channel === 'email'
          ? { email, deviceFingerprint: 'admin_console_web', deviceLabel: 'Staff Back-Office Console' }
          : { phone, deviceFingerprint: 'admin_console_web', deviceLabel: 'Staff Back-Office Console' };

      const payload =
        mode === 'pin_login'
          ? { ...base, pin: loginPin, otpCode: otpRequired ? otpCode : undefined }
          : { ...base, password, otpCode: otpRequired ? otpCode : undefined };

      const res = await apiFetch<{
        requiresOtp?: boolean;
        requiresPinSetup?: boolean;
        accessToken?: string;
      }>(endpoint, {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      if (res.requiresOtp) {
        setOtpRequired(true);
        setLoading(false);
        return;
      }

      if (res.accessToken) {
        setAccessToken(res.accessToken);
        persistHint(channel, channel === 'email' ? email : phone);
        void ensurePushSubscription();
        if (res.requiresPinSetup) {
          setMode('pin_setup');
        } else {
          await onAuthenticated();
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Staff authentication failed');
    } finally {
      setLoading(false);
    }
  };

  const handleStaffRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!legalAccepted) {
      setError('Please read and confirm the Terms of Use & Privacy Policy ("I understand") before registering.');
      onOpenLegalDoc('terms');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const base =
        channel === 'email'
          ? { email, password, fullName, requestedRole, legalAccepted: true }
          : { phone, password, fullName, requestedRole, legalAccepted: true };
      const res = await apiFetch<{
        accessToken: string;
        otpTarget: string;
        otpChannel: 'SMS' | 'EMAIL';
      }>('/auth/staff/register', {
        method: 'POST',
        body: JSON.stringify({
          ...base,
          deviceFingerprint: 'admin_console_web',
          deviceLabel: 'Staff Back-Office Console',
        }),
      });
      setAccessToken(res.accessToken);
      persistHint(channel, channel === 'email' ? email : phone);
      setOtpTarget(res.otpTarget);
      setOtpChannel(res.otpChannel);
      setOtpCode('');
      setMode('otp_register');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Staff registration failed');
    } finally {
      setLoading(false);
    }
  };

  const handleStaffGoogleAuth = async () => {
    if (mode === 'register' && !legalAccepted) {
      setError('Please confirm the Terms of Use & Privacy Policy ("I understand") before continuing with Google.');
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
      }>('/auth/staff/google', {
        method: 'POST',
        body: JSON.stringify({
          idToken,
          requestedRole,
          legalAccepted,
          deviceFingerprint: 'admin_console_google',
          deviceLabel: 'Staff Google Sign-In',
        }),
      });
      setAccessToken(res.accessToken);
      if (res.user?.email) {
        persistHint('email', res.user.email);
      }
      void ensurePushSubscription();
      if (res.requiresPinSetup) {
        setMode('pin_setup');
      } else {
        await onAuthenticated();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Google Staff Sign-In failed');
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyRegistrationOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ accessToken?: string }>('/auth/otp/verify', {
        method: 'POST',
        body: JSON.stringify({
          target: otpTarget,
          channel: otpChannel,
          purpose: 'REGISTER',
          code: otpCode,
        }),
      });
      if (res.accessToken) {
        setAccessToken(res.accessToken);
      }
      setMode('pin_setup');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'OTP verification failed');
    } finally {
      setLoading(false);
    }
  };

  const handleSetStaffPin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pin !== confirmPin) {
      setError('Staff Security PIN and confirmation PIN must match.');
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
      setError(err instanceof Error ? err.message : 'Could not set Staff PIN');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#F7F8FA] flex flex-col justify-between">
      <div className="flex-1 flex flex-col justify-center items-center p-5">
        <div className="w-full max-w-lg bg-white rounded-3xl border border-slate-200 p-7 md:p-8">
          <div className="flex items-center justify-between gap-4 pb-5 border-b border-slate-100">
            <div className="flex items-center gap-2.5">
              <WalletBrandMark className="w-8 h-8" />
              <div>
                <span className="font-display text-base font-bold text-slate-900">Back-Office Console</span>
                <p className="text-[11px] text-slate-500">Authorized Staff Operations Portal</p>
              </div>
            </div>
            <button
              type="button"
              onClick={onBackToWallet}
              className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-slate-900 min-h-[38px]"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              User Wallet
            </button>
          </div>

          {(mode === 'pin_login' || mode === 'login' || mode === 'register') ? (
            <>
              <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-xl">
                  <button
                    type="button"
                    onClick={() => {
                      setMode('pin_login');
                      setOtpRequired(false);
                      setError(null);
                    }}
                    className={`px-2.5 py-1.5 text-xs font-semibold rounded-lg min-h-[36px] inline-flex items-center gap-1 ${
                      mode === 'pin_login' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                    }`}
                  >
                    <Lock className="w-3.5 h-3.5" />
                    PIN Login
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMode('login');
                      setOtpRequired(false);
                      setError(null);
                    }}
                    className={`px-2.5 py-1.5 text-xs font-semibold rounded-lg min-h-[36px] ${
                      mode === 'login' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                    }`}
                  >
                    Password
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMode('register');
                      setOtpRequired(false);
                      setError(null);
                    }}
                    className={`px-2.5 py-1.5 text-xs font-semibold rounded-lg min-h-[36px] ${
                      mode === 'register' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                    }`}
                  >
                    Staff Sign Up
                  </button>
                </div>

                <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-xl">
                  <button
                    type="button"
                    onClick={() => {
                      setChannel('email');
                      setOtpRequired(false);
                    }}
                    className={`px-2.5 py-1.5 text-xs font-medium rounded-lg flex items-center gap-1 min-h-[34px] ${
                      channel === 'email' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                    }`}
                  >
                    <Mail className="w-3.5 h-3.5" />
                    Email
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setChannel('phone');
                      setOtpRequired(false);
                    }}
                    className={`px-2.5 py-1.5 text-xs font-medium rounded-lg flex items-center gap-1 min-h-[34px] ${
                      channel === 'phone' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                    }`}
                  >
                    <Phone className="w-3.5 h-3.5" />
                    Phone
                  </button>
                </div>
              </div>

              {mode === 'pin_login' && rememberedHints.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {rememberedHints.map((hint) => (
                    <button
                      key={`${hint.channel}:${hint.identifier}`}
                      type="button"
                      onClick={() => {
                        setChannel(hint.channel);
                        if (hint.channel === 'email') setEmail(hint.identifier);
                        else setPhone(hint.identifier);
                        setOtpRequired(false);
                      }}
                      className="px-3 py-1 rounded-lg border border-emerald-200 bg-emerald-50 text-xs font-medium text-emerald-900"
                    >
                      {hint.identifier}
                    </button>
                  ))}
                </div>
              )}

              <form
                onSubmit={mode === 'register' ? handleStaffRegister : handlePasswordOrPinLogin}
                className="mt-5 space-y-4"
              >
                {mode === 'register' && (
                  <>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1.5">Staff Full Name</label>
                      <input
                        type="text"
                        required
                        value={fullName}
                        onChange={(e) => setFullName(e.target.value)}
                        placeholder="Full legal name"
                        className="w-full h-11 rounded-xl border border-slate-200 px-3.5 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1.5">Requested Staff Role</label>
                      <select
                        value={requestedRole}
                        onChange={(e) => setRequestedRole(e.target.value as Role)}
                        className="w-full h-11 rounded-xl border border-slate-200 px-3.5 text-sm bg-white"
                      >
                        {STAFF_ROLE_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </>
                )}

                {channel === 'email' ? (
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1.5">Staff Email</label>
                    <input
                      type="email"
                      required
                      value={email}
                      onChange={(e) => {
                        setEmail(e.target.value);
                        setOtpRequired(false);
                        setOtpCode('');
                      }}
                      placeholder="staff@company.com"
                      className="w-full h-11 rounded-xl border border-slate-200 px-3.5 text-sm"
                    />
                  </div>
                ) : (
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1.5">Staff Mobile (E.164)</label>
                    <input
                      type="tel"
                      required
                      value={phone}
                      onChange={(e) => {
                        setPhone(e.target.value);
                        setOtpRequired(false);
                        setOtpCode('');
                      }}
                      placeholder="+263770000000"
                      className="w-full h-11 rounded-xl border border-slate-200 px-3.5 font-mono text-sm"
                    />
                  </div>
                )}

                {mode === 'pin_login' ? (
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1.5">6-Digit Staff PIN</label>
                    <input
                      type="password"
                      inputMode="numeric"
                      pattern="\d{6}"
                      maxLength={6}
                      required
                      value={loginPin}
                      onChange={(e) => setLoginPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      placeholder="••••••"
                      className="w-full h-12 rounded-xl border border-slate-200 px-4 font-mono text-xl tracking-[0.4em] text-center"
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
                      className="w-full h-11 rounded-xl border border-slate-200 px-3.5 text-sm"
                    />
                  </div>
                )}

                {otpRequired && (
                  <div className="space-y-2 pt-1">
                    <label className="block text-xs font-medium text-slate-700">6-Digit Verification Code</label>
                    <input
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      required
                      value={otpCode}
                      onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      placeholder="000000"
                      className="w-full h-11 rounded-xl border border-slate-200 px-3.5 font-mono text-lg text-center tracking-[0.35em]"
                    />
                  </div>
                )}

                {/* Legal agreement banner */}
                <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-3 text-xs text-slate-700 space-y-1.5">
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={legalAccepted}
                      onChange={(e) => onSetLegalAccepted(e.target.checked)}
                      className="mt-0.5 h-4 w-4 accent-emerald-700 shrink-0"
                    />
                    <span>
                      I confirm acceptance of the{' '}
                      <button type="button" onClick={() => onOpenLegalDoc('terms')} className="text-emerald-700 font-semibold underline">
                        Terms of Use
                      </button>
                      ,{' '}
                      <button type="button" onClick={() => onOpenLegalDoc('privacy')} className="text-emerald-700 font-semibold underline">
                        Privacy Policy
                      </button>{' '}
                      &amp;{' '}
                      <button type="button" onClick={() => onOpenLegalDoc('aml')} className="text-emerald-700 font-semibold underline">
                        AML / Safeguarding Policy
                      </button>
                      .
                    </span>
                  </label>
                  <button
                    type="button"
                    onClick={() => onOpenLegalDoc('terms')}
                    className="pl-6 text-[11px] font-semibold text-emerald-800 hover:underline inline-flex items-center gap-1"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    {legalAccepted ? 'Confirmed: I understand' : 'Read Legal Docs & Confirm "I understand"'}
                  </button>
                </div>

                {error && (
                  <div className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs font-medium text-red-700">
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full h-11 rounded-xl bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800 disabled:opacity-60 flex items-center justify-center gap-2"
                >
                  {loading
                    ? 'Authenticating...'
                    : mode === 'register'
                      ? 'Register Staff & Continue'
                      : otpRequired
                        ? 'Verify & Enter Console'
                        : mode === 'pin_login'
                          ? 'Sign In with Staff PIN'
                          : 'Continue'}
                  <ArrowRight className="w-4 h-4" />
                </button>
              </form>

              {mode !== 'pin_login' && (
                <>
                  <div className="my-4 flex items-center gap-3">
                    <div className="h-px flex-1 bg-slate-200" />
                    <span className="text-xs text-slate-400">or continue with Google</span>
                    <div className="h-px flex-1 bg-slate-200" />
                  </div>

                  <button
                    type="button"
                    disabled={loading}
                    onClick={handleStaffGoogleAuth}
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
            </>
          ) : mode === 'otp_register' ? (
            <form onSubmit={handleVerifyRegistrationOtp} className="mt-6 space-y-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-emerald-50 border border-emerald-200 flex items-center justify-center text-emerald-700">
                  <Smartphone className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="font-display text-base font-bold text-slate-900">Verify Staff Contact</h2>
                  <p className="text-xs text-slate-500">Enter the 6-digit verification code sent to {otpTarget}</p>
                </div>
              </div>

              <input
                type="text"
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                required
                value={otpCode}
                onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="000000"
                className="w-full h-12 rounded-xl border border-slate-200 px-4 font-mono text-xl tracking-[0.35em] text-center"
              />

              {error && <p className="text-xs font-medium text-red-600">{error}</p>}

              <button
                type="submit"
                disabled={loading || otpCode.length !== 6}
                className="w-full h-11 rounded-xl bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800 disabled:opacity-60"
              >
                {loading ? 'Verifying...' : 'Verify & Set Staff PIN'}
              </button>
            </form>
          ) : (
            <form onSubmit={handleSetStaffPin} className="mt-6 space-y-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-emerald-50 border border-emerald-200 flex items-center justify-center text-emerald-700">
                  <KeyRound className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="font-display text-base font-bold text-slate-900">Create &amp; Confirm 6-Digit Staff PIN</h2>
                  <p className="text-xs text-slate-500">
                    Used to sign in rapidly and authorize sensitive operations
                  </p>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">6-Digit Staff Security PIN</label>
                <input
                  type="password"
                  inputMode="numeric"
                  pattern="\d{6}"
                  maxLength={6}
                  required
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="••••••"
                  className="w-full h-12 rounded-xl border border-slate-200 px-4 font-mono text-xl tracking-[0.4em] text-center"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">Confirm 6-Digit Staff PIN</label>
                <input
                  type="password"
                  inputMode="numeric"
                  pattern="\d{6}"
                  maxLength={6}
                  required
                  value={confirmPin}
                  onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="••••••"
                  className="w-full h-12 rounded-xl border border-slate-200 px-4 font-mono text-xl tracking-[0.4em] text-center"
                />
              </div>

              {error && (
                <div className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs font-medium text-red-700">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading || pin.length !== 6 || confirmPin.length !== 6}
                className="w-full h-11 rounded-xl bg-emerald-700 text-white text-sm font-semibold hover:bg-emerald-800 disabled:opacity-60"
              >
                {loading ? 'Securing Staff PIN...' : 'Confirm Staff PIN & Continue'}
              </button>
            </form>
          )}
        </div>
      </div>

      <SiteFooter onOpenLegalDoc={onOpenLegalDoc} />
    </div>
  );
};
