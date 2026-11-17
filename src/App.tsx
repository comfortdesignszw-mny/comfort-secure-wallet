import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  Clock,
  Home,
  KeyRound,
  LogOut,
  Plus,
  Send,
  Shield,
  User as UserIcon,
} from 'lucide-react';
import {
  ADMIN_ROLES,
  DepositRequestRecord,
  KycStatus,
  NotificationPreferences,
  NotificationRecord,
  TransactionRecord,
  UserRecord,
  WithdrawalRequestRecord,
} from './shared/types.ts';
import {
  apiFetch,
  getValidViewStepUpToken,
  setAccessToken,
  setViewStepUpToken,
  tryRefreshSession,
} from './lib/api.ts';
import { consumeGoogleRedirectResult } from './lib/firebase.ts';
import { dispatchTransactionPushAlerts, ensurePushSubscription } from './lib/pushNotifications.ts';
import { LegalDocId, LegalDocsModal } from './components/LegalDocsModal.tsx';
import { OfflineIndicator } from './components/OfflineIndicator.tsx';
import { PinSheet } from './components/PinSheet.tsx';
import { PWAInstallButton } from './components/PWAInstallButton.tsx';
import { SiteFooter } from './components/SiteFooter.tsx';
import { WalletBrandMark } from './components/WalletBrandMark.tsx';
import { AdminConsole } from './components/admin/AdminConsole.tsx';
import { AdminLogin } from './components/admin/AdminLogin.tsx';
import { ActivityStatementsView } from './components/user/ActivityStatementsView.tsx';
import { AddMoneyView } from './components/user/AddMoneyView.tsx';
import { AuthFlow } from './components/user/AuthFlow.tsx';
import { KycOnboarding } from './components/user/KycOnboarding.tsx';
import { ProfileSecurityView } from './components/user/ProfileSecurityView.tsx';
import { SendMoneyView } from './components/user/SendMoneyView.tsx';
import { WalletAccountSummary, WalletDashboard } from './components/user/WalletDashboard.tsx';
import { WithdrawView } from './components/user/WithdrawView.tsx';

type UserTab = 'home' | 'add' | 'send' | 'withdraw' | 'activity' | 'profile';

export default function App() {
  const [surface, setSurface] = useState<'wallet' | 'admin'>('wallet');
  const [booting, setBooting] = useState(true);
  const [legalAccepted, setLegalAccepted] = useState(false);
  const [legalModalOpen, setLegalModalOpen] = useState(false);
  const [legalModalDoc, setLegalModalDoc] = useState<LegalDocId>('terms');

  const [user, setUser] = useState<Omit<UserRecord, 'passwordHash'> | null>(null);
  const [pinConfigured, setPinConfigured] = useState(true);
  const [setupPin, setSetupPin] = useState('');
  const [setupConfirmPin, setSetupConfirmPin] = useState('');
  const [setupPinErr, setSetupPinErr] = useState<string | null>(null);
  const [setupPinLoading, setSetupPinLoading] = useState(false);

  const [accounts, setAccounts] = useState<WalletAccountSummary[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [balancesByAccount, setBalancesByAccount] = useState<Record<string, { balanceMinor: number; holdMinor: number }>>({});
  const [balancesUnlocked, setBalancesUnlocked] = useState(false);
  const [transactions, setTransactions] = useState<TransactionRecord[]>([]);
  const [deposits, setDeposits] = useState<DepositRequestRecord[]>([]);
  const [withdrawals, setWithdrawals] = useState<WithdrawalRequestRecord[]>([]);
  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);
  const [notifPrefs, setNotifPrefs] = useState<NotificationPreferences>({
    userId: '',
    emailReceipts: true,
    pushTransactions: true,
    smsTransactions: true,
    mandatorySecurityAlerts: true,
  });
  const [activeTab, setActiveTab] = useState<UserTab>('home');
  const [pinUnlockOpen, setPinUnlockOpen] = useState(false);

  const openLegalDoc = (doc: LegalDocId) => {
    setLegalModalDoc(doc);
    setLegalModalOpen(true);
  };

  const loadWalletData = useCallback(async () => {
    try {
      const me = await apiFetch<{
        user: Omit<UserRecord, 'passwordHash'>;
        pinConfigured: boolean;
        notificationPreferences: NotificationPreferences;
      }>('/me');
      setUser(me.user);
      setPinConfigured(me.pinConfigured);
      setNotifPrefs(me.notificationPreferences);
      void ensurePushSubscription();

      if (ADMIN_ROLES.includes(me.user.role)) {
        setSurface('admin');
        return;
      }

      const [accRes, txnRes, depRes, wdrRes, ntfRes] = await Promise.all([
        apiFetch<{ accounts: WalletAccountSummary[] }>('/accounts'),
        apiFetch<{ transactions: TransactionRecord[] }>('/transactions'),
        apiFetch<{ deposits: DepositRequestRecord[] }>('/deposits/requests'),
        apiFetch<{ withdrawals: WithdrawalRequestRecord[] }>('/withdrawals/requests'),
        apiFetch<{ notifications: NotificationRecord[] }>('/notifications'),
      ]);
      setAccounts(accRes.accounts);
      if (accRes.accounts.length > 0) {
        setSelectedAccountId((prev) => prev || accRes.accounts[0].id);
      }
      setTransactions(txnRes.transactions);
      setDeposits(depRes.deposits);
      setWithdrawals(wdrRes.withdrawals);
      setNotifications(ntfRes.notifications);
      void dispatchTransactionPushAlerts(ntfRes.notifications);

      const viewToken = getValidViewStepUpToken();
      if (viewToken && accRes.accounts.length > 0) {
        const nextBalances: Record<string, { balanceMinor: number; holdMinor: number }> = {};
        await Promise.all(
          accRes.accounts.map(async (acc) => {
            const b = await apiFetch<{ balanceMinor: number; holdMinor: number }>(`/accounts/${acc.id}/balance`, {
              stepUpToken: viewToken,
            });
            nextBalances[acc.id] = b;
          }),
        );
        setBalancesByAccount(nextBalances);
        setBalancesUnlocked(true);
      }
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const redirectResult = await consumeGoogleRedirectResult();
        if (redirectResult?.idToken) {
          const isAdminSurface = redirectResult.meta?.surface === 'admin';
          if (isAdminSurface) setSurface('admin');
          const endpoint = isAdminSurface ? '/auth/staff/google' : '/auth/google';
          const res = await apiFetch<{ accessToken: string }>(endpoint, {
            method: 'POST',
            body: JSON.stringify({
              idToken: redirectResult.idToken,
              legalAccepted: redirectResult.meta?.legalAccepted ?? true,
              requestedRole: redirectResult.meta?.requestedRole,
              deviceFingerprint: isAdminSurface ? 'admin_console_google' : 'pwa_google_web',
              deviceLabel: 'Google Account',
            }),
          });
          setAccessToken(res.accessToken);
          await loadWalletData();
          setBooting(false);
          return;
        }
      } catch {
        // Fall through to normal session boot
      }

      const refreshed = await tryRefreshSession();
      if (refreshed) {
        await loadWalletData();
      }
      setBooting(false);
    })();
  }, [loadWalletData]);

  const handleMandatoryPinSet = async (e: React.FormEvent) => {
    e.preventDefault();
    if (setupPin !== setupConfirmPin) {
      setSetupPinErr('Security PIN and confirmation PIN do not match.');
      return;
    }
    setSetupPinLoading(true);
    setSetupPinErr(null);
    try {
      await apiFetch('/pin/set', {
        method: 'POST',
        body: JSON.stringify({ pin: setupPin, confirmPin: setupConfirmPin }),
      });
      setSetupPin('');
      setSetupConfirmPin('');
      await loadWalletData();
    } catch (err) {
      setSetupPinErr(err instanceof Error ? err.message : 'Failed to configure PIN');
    } finally {
      setSetupPinLoading(false);
    }
  };

  const handleUnlockBalances = async (stepUpToken: string) => {
    setPinUnlockOpen(false);
    const nextBalances: Record<string, { balanceMinor: number; holdMinor: number }> = {};
    await Promise.all(
      accounts.map(async (acc) => {
        const b = await apiFetch<{ balanceMinor: number; holdMinor: number }>(`/accounts/${acc.id}/balance`, {
          stepUpToken,
        });
        nextBalances[acc.id] = b;
      }),
    );
    setBalancesByAccount(nextBalances);
    setBalancesUnlocked(true);
  };

  const handleLockBalance = () => {
    setViewStepUpToken(null);
    setBalancesUnlocked(false);
    setBalancesByAccount({});
  };

  const handleDownloadReceipt = async (txnId: string) => {
    const blob = await apiFetch<Blob>(`/transactions/${txnId}/receipt`);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `comfort-receipt-${txnId}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleLogout = async () => {
    try {
      await apiFetch('/auth/logout', { method: 'POST' });
    } catch {
      // ignore
    }
    setAccessToken(null);
    setViewStepUpToken(null);
    setUser(null);
    setAccounts([]);
    setBalancesUnlocked(false);
    setBalancesByAccount({});
  };

  const legalModalNode = (
    <LegalDocsModal
      open={legalModalOpen}
      initialDoc={legalModalDoc}
      alreadyConfirmed={legalAccepted}
      onClose={() => setLegalModalOpen(false)}
      onConfirmUnderstand={() => setLegalAccepted(true)}
    />
  );

  if (booting) {
    return (
      <div className="min-h-screen bg-[#F7F8FA] flex items-center justify-center">
        <div className="text-center space-y-3">
          <WalletBrandMark className="w-10 h-10 mx-auto" />
          <p className="text-xs font-medium text-slate-500">Loading Comfort Secure Wallet...</p>
        </div>
      </div>
    );
  }

  // Mandatory Create & Confirm 6-digit PIN gate for any authenticated user or staff missing a PIN
  if (user && !pinConfigured) {
    return (
      <div className="min-h-screen bg-[#F7F8FA] flex flex-col justify-between">
        <div className="flex-1 flex items-center justify-center p-5">
          <form onSubmit={handleMandatoryPinSet} className="w-full max-w-md bg-white rounded-3xl border border-slate-200 p-8 space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-emerald-50 border border-emerald-200 flex items-center justify-center text-emerald-700">
                <KeyRound className="w-5 h-5" />
              </div>
              <div>
                <h1 className="font-display text-lg font-bold text-slate-900">Create &amp; Confirm 6-Digit PIN</h1>
                <p className="text-xs text-slate-500">Required for signing in and authorizing transactions</p>
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
                value={setupPin}
                onChange={(e) => setSetupPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="••••••"
                className="w-full h-12 rounded-xl border border-slate-200 px-4 font-mono text-xl tracking-[0.4em] text-center"
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
                value={setupConfirmPin}
                onChange={(e) => setSetupConfirmPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="••••••"
                className="w-full h-12 rounded-xl border border-slate-200 px-4 font-mono text-xl tracking-[0.4em] text-center"
              />
            </div>

            {setupPinErr && (
              <div className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs font-medium text-red-700">
                {setupPinErr}
              </div>
            )}

            <button
              type="submit"
              disabled={setupPinLoading || setupPin.length !== 6 || setupConfirmPin.length !== 6}
              className="w-full h-12 rounded-xl bg-emerald-700 text-white text-sm font-semibold hover:bg-emerald-800 disabled:opacity-60"
            >
              {setupPinLoading ? 'Securing PIN...' : 'Confirm & Save PIN'}
            </button>

            <button
              type="button"
              onClick={() => void handleLogout()}
              className="w-full h-10 rounded-xl border border-slate-200 text-xs font-medium text-slate-600 hover:bg-slate-50"
            >
              Sign Out
            </button>
          </form>
        </div>
        <SiteFooter onOpenLegalDoc={openLegalDoc} />
        {legalModalNode}
        <OfflineIndicator />
      </div>
    );
  }

  if (surface === 'admin') {
    if (!user || !ADMIN_ROLES.includes(user.role)) {
      return (
        <>
          <AdminLogin
            legalAccepted={legalAccepted}
            onSetLegalAccepted={setLegalAccepted}
            onOpenLegalDoc={openLegalDoc}
            onAuthenticated={async () => {
              await loadWalletData();
            }}
            onBackToWallet={() => setSurface('wallet')}
          />
          {legalModalNode}
          <OfflineIndicator />
        </>
      );
    }

    // Staff pending Super Admin approval screen
    if (user.staffStatus !== 'APPROVED') {
      return (
        <div className="min-h-screen bg-[#F7F8FA] flex flex-col justify-between">
          <div className="flex-1 flex items-center justify-center p-5">
            <div className="w-full max-w-md bg-white rounded-3xl border border-slate-200 p-8 text-center space-y-4">
              <div className="w-12 h-12 rounded-2xl bg-amber-50 border border-amber-200 text-amber-700 flex items-center justify-center mx-auto">
                <Clock className="w-6 h-6" />
              </div>
              <h1 className="font-display text-xl font-bold text-slate-900">Awaiting Super Admin Approval</h1>
              <p className="text-xs text-slate-600 leading-relaxed">
                Your staff account (<span className="font-mono font-semibold">{user.email || user.phone}</span>) and 6-digit Security PIN are registered. An authorized Super Admin must review and approve your requested role ({user.requestedRole || user.role}) before Back-Office access is enabled.
              </p>
              <div className="flex gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => void loadWalletData()}
                  className="flex-1 h-11 rounded-xl bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800"
                >
                  Check Approval Status
                </button>
                <button
                  type="button"
                  onClick={() => void handleLogout()}
                  className="px-4 h-11 rounded-xl border border-slate-200 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Sign Out
                </button>
              </div>
            </div>
          </div>
          <SiteFooter onOpenLegalDoc={openLegalDoc} />
          {legalModalNode}
          <OfflineIndicator />
        </div>
      );
    }

    return (
      <>
        <AdminConsole
          currentUser={user}
          onLogout={handleLogout}
          onOpenLegalDoc={openLegalDoc}
          onSwitchToWallet={() => {
            void handleLogout();
            setSurface('wallet');
          }}
        />
        {legalModalNode}
        <OfflineIndicator />
      </>
    );
  }

  if (!user) {
    return (
      <>
        <AuthFlow
          legalAccepted={legalAccepted}
          onSetLegalAccepted={setLegalAccepted}
          onOpenLegalDoc={openLegalDoc}
          onAuthenticated={loadWalletData}
          onSwitchToAdmin={() => setSurface('admin')}
        />
        {legalModalNode}
        <OfflineIndicator />
      </>
    );
  }

  const kycApproved = user.kycStatus === KycStatus.APPROVED;

  return (
    <div className="min-h-screen bg-[#F7F8FA] pb-16 md:pb-0 flex flex-col">
      {/* Three-Zone Top Bar */}
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-md border-b border-slate-200">
        <div className="max-w-6xl mx-auto px-4 md:px-6 h-14 flex items-center justify-between gap-8">
          <button
            type="button"
            onClick={() => setActiveTab('home')}
            className="flex items-center gap-2.5 whitespace-nowrap shrink-0"
          >
            <WalletBrandMark className="w-7 h-7" />
            <span className="font-display text-base font-bold text-slate-900">Comfort Secure Wallet</span>
          </button>

          {kycApproved && (
            <nav className="hidden md:flex items-center gap-6 text-xs font-medium text-slate-600">
              <button
                type="button"
                onClick={() => setActiveTab('home')}
                className={`whitespace-nowrap shrink-0 py-1 border-b-2 transition-colors ${
                  activeTab === 'home' ? 'border-emerald-700 text-slate-900 font-semibold' : 'border-transparent hover:text-slate-900'
                }`}
              >
                Home
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('add')}
                className={`whitespace-nowrap shrink-0 py-1 border-b-2 transition-colors ${
                  activeTab === 'add' ? 'border-emerald-700 text-slate-900 font-semibold' : 'border-transparent hover:text-slate-900'
                }`}
              >
                Add Money
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('send')}
                className={`whitespace-nowrap shrink-0 py-1 border-b-2 transition-colors ${
                  activeTab === 'send' ? 'border-emerald-700 text-slate-900 font-semibold' : 'border-transparent hover:text-slate-900'
                }`}
              >
                Send
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('withdraw')}
                className={`whitespace-nowrap shrink-0 py-1 border-b-2 transition-colors ${
                  activeTab === 'withdraw' ? 'border-emerald-700 text-slate-900 font-semibold' : 'border-transparent hover:text-slate-900'
                }`}
              >
                Withdraw
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('activity')}
                className={`whitespace-nowrap shrink-0 py-1 border-b-2 transition-colors ${
                  activeTab === 'activity' ? 'border-emerald-700 text-slate-900 font-semibold' : 'border-transparent hover:text-slate-900'
                }`}
              >
                Statements
              </button>
            </nav>
          )}

          <div className="flex items-center gap-2.5 shrink-0">
            <PWAInstallButton />
            <button
              type="button"
              onClick={() => setActiveTab('profile')}
              className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 min-h-[38px]"
            >
              <Shield className="w-3.5 h-3.5 text-emerald-700" />
              Security
            </button>
            <button
              type="button"
              onClick={() => void handleLogout()}
              aria-label="Sign out"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 min-h-[38px]"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Sign Out</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 w-full max-w-6xl mx-auto px-4 md:px-6 pt-6">
        {!kycApproved ? (
          <KycOnboarding kycStatus={user.kycStatus} onSubmitted={loadWalletData} />
        ) : activeTab === 'home' ? (
          <WalletDashboard
            accounts={accounts}
            selectedAccountId={selectedAccountId}
            onSelectAccount={setSelectedAccountId}
            balancesByAccount={balancesByAccount}
            balancesUnlocked={balancesUnlocked}
            onRequestUnlockBalance={() => setPinUnlockOpen(true)}
            onLockBalance={handleLockBalance}
            transactions={transactions}
            onNavigateAction={(t) => setActiveTab(t)}
            onDownloadReceipt={(id) => void handleDownloadReceipt(id)}
          />
        ) : activeTab === 'add' ? (
          <AddMoneyView accounts={accounts} deposits={deposits} onRefresh={loadWalletData} />
        ) : activeTab === 'send' ? (
          <SendMoneyView
            accounts={accounts}
            onRefresh={loadWalletData}
            onDownloadReceipt={(id) => void handleDownloadReceipt(id)}
          />
        ) : activeTab === 'withdraw' ? (
          <WithdrawView accounts={accounts} withdrawals={withdrawals} onRefresh={loadWalletData} />
        ) : activeTab === 'activity' ? (
          <ActivityStatementsView
            accounts={accounts}
            transactions={transactions}
            onDownloadReceipt={(id) => void handleDownloadReceipt(id)}
          />
        ) : (
          <ProfileSecurityView
            userEmail={user.email}
            userPhone={user.phone}
            kycStatus={user.kycStatus}
            kycTier={user.kycTier}
            notifications={notifications}
            initialPrefs={notifPrefs}
            onRefresh={loadWalletData}
          />
        )}
      </main>

      <SiteFooter onOpenLegalDoc={openLegalDoc} />

      {/* Mobile Fixed Thumb-Zone Bottom Tab Bar */}
      {kycApproved && (
        <nav
          aria-label="Mobile wallet navigation"
          className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-white/95 backdrop-blur-md border-t border-slate-200 grid grid-cols-5 items-center h-16 pb-safe"
        >
          <button
            type="button"
            onClick={() => setActiveTab('home')}
            className={`flex flex-col items-center justify-center min-h-[44px] ${
              activeTab === 'home' ? 'text-emerald-700 font-semibold' : 'text-slate-500'
            }`}
          >
            <Home className="w-5 h-5" />
            <span className="text-[10px] mt-1">Home</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('add')}
            className={`flex flex-col items-center justify-center min-h-[44px] ${
              activeTab === 'add' ? 'text-emerald-700 font-semibold' : 'text-slate-500'
            }`}
          >
            <Plus className="w-5 h-5" />
            <span className="text-[10px] mt-1">Add</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('send')}
            className={`flex flex-col items-center justify-center min-h-[44px] ${
              activeTab === 'send' ? 'text-emerald-700 font-semibold' : 'text-slate-500'
            }`}
          >
            <Send className="w-5 h-5" />
            <span className="text-[10px] mt-1">Send</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('activity')}
            className={`flex flex-col items-center justify-center min-h-[44px] ${
              activeTab === 'activity' ? 'text-emerald-700 font-semibold' : 'text-slate-500'
            }`}
          >
            <Activity className="w-5 h-5" />
            <span className="text-[10px] mt-1">Activity</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('profile')}
            className={`flex flex-col items-center justify-center min-h-[44px] ${
              activeTab === 'profile' ? 'text-emerald-700 font-semibold' : 'text-slate-500'
            }`}
          >
            <UserIcon className="w-5 h-5" />
            <span className="text-[10px] mt-1">Profile</span>
          </button>
        </nav>
      )}

      <PinSheet
        open={pinUnlockOpen}
        onClose={() => setPinUnlockOpen(false)}
        scope="view"
        onVerified={(token) => void handleUnlockBalances(token)}
      />

      {legalModalNode}
      <OfflineIndicator />
    </div>
  );
}
