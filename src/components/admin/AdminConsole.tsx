import React, { useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDownCircle,
  ArrowUpCircle,
  CheckCircle2,
  FileCheck,
  History,
  LayoutDashboard,
  LogOut,
  Scale,
  Settings,
  Users,
} from 'lucide-react';
import {
  ADMIN_ROLES,
  ApprovalRecord,
  AuditLogRecord,
  Currency,
  DepositRequestRecord,
  FeeRuleRecord,
  LimitRuleRecord,
  RbacRuleRecord,
  ReconciliationRunRecord,
  RiskFlagRecord,
  ROLE_PERMISSIONS,
  Role,
  TransactionRecord,
  TransactionType,
  UserRecord,
  WithdrawalRequestRecord,
} from '../../shared/types.ts';
import { formatMinorUnits } from '../../shared/money.ts';
import { apiFetch } from '../../lib/api.ts';
import { LegalDocId } from '../LegalDocsModal.tsx';
import { PinSheet } from '../PinSheet.tsx';
import { SiteFooter } from '../SiteFooter.tsx';
import { WalletBrandMark } from '../WalletBrandMark.tsx';

type AdminTab =
  | 'overview'
  | 'kyc'
  | 'deposits'
  | 'withdrawals'
  | 'users'
  | 'transactions'
  | 'rules'
  | 'staff'
  | 'reconciliation'
  | 'risk'
  | 'audit';

interface AdminConsoleProps {
  currentUser: Omit<UserRecord, 'passwordHash'>;
  onLogout: () => Promise<void>;
  onSwitchToWallet: () => void;
  onOpenLegalDoc: (doc: LegalDocId) => void;
}

export const AdminConsole: React.FC<AdminConsoleProps> = ({
  currentUser,
  onLogout,
  onSwitchToWallet,
  onOpenLegalDoc,
}) => {
  const [tab, setTab] = useState<AdminTab>('overview');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [overview, setOverview] = useState<any>(null);
  const [kycQueue, setKycQueue] = useState<any[]>([]);
  const [deposits, setDeposits] = useState<Array<DepositRequestRecord & { userEmail?: string; userName?: string }>>([]);
  const [withdrawals, setWithdrawals] = useState<Array<WithdrawalRequestRecord & { destinationDecrypted?: string; userName?: string }>>([]);
  const [usersList, setUsersList] = useState<any[]>([]);
  const [userQuery, setUserQuery] = useState('');
  const [transactions, setTransactions] = useState<Array<TransactionRecord & { journalLines?: any[] }>>([]);
  const [feeRules, setFeeRules] = useState<FeeRuleRecord[]>([]);
  const [limitRules, setLimitRules] = useState<LimitRuleRecord[]>([]);
  const [staffList, setStaffList] = useState<any[]>([]);
  const [rbacRules, setRbacRules] = useState<RbacRuleRecord[]>([]);
  const [staffRoleSelections, setStaffRoleSelections] = useState<Record<string, Role>>({});
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [reconciliationRuns, setReconciliationRuns] = useState<ReconciliationRunRecord[]>([]);
  const [riskFlags, setRiskFlags] = useState<RiskFlagRecord[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogRecord[]>([]);

  const [pendingPinAction, setPendingPinAction] = useState<{
    adminAction: string;
    title: string;
    fn: (stepUpToken: string) => Promise<void>;
    successMessage: string;
  } | null>(null);

  // Inline inputs
  const [payoutRefMap, setPayoutRefMap] = useState<Record<string, string>>({});
  const [extBankInput, setExtBankInput] = useState('');
  const [flatFeeInput, setFlatFeeInput] = useState('15');
  const [bpsFeeInput, setBpsFeeInput] = useState('50');

  const permissions = new Set(ROLE_PERMISSIONS[currentUser.role] || []);

  const loadTab = async (targetTab: AdminTab) => {
    setError(null);
    try {
      if (targetTab === 'overview' && permissions.has('transactions:read')) {
        setOverview(await apiFetch('/admin/overview'));
      } else if (targetTab === 'kyc' && permissions.has('kyc:read')) {
        const res = await apiFetch<{ queue: any[] }>('/admin/kyc');
        setKycQueue(res.queue);
      } else if (targetTab === 'deposits' && permissions.has('deposits:read')) {
        const res = await apiFetch<{ deposits: any[] }>('/admin/deposits');
        setDeposits(res.deposits);
      } else if (targetTab === 'withdrawals' && permissions.has('withdrawals:read')) {
        const res = await apiFetch<{ withdrawals: any[] }>('/admin/withdrawals');
        setWithdrawals(res.withdrawals);
      } else if (targetTab === 'users' && permissions.has('users:read')) {
        const res = await apiFetch<{ users: any[] }>(`/admin/users?q=${encodeURIComponent(userQuery)}`);
        setUsersList(res.users);
      } else if (targetTab === 'transactions' && permissions.has('transactions:read')) {
        const res = await apiFetch<{ transactions: any[] }>('/admin/transactions');
        setTransactions(res.transactions);
      } else if (targetTab === 'rules') {
        if (permissions.has('fees:read') || permissions.has('fees:write')) {
          const f = await apiFetch<{ feeRules: FeeRuleRecord[] }>('/admin/fees');
          setFeeRules(f.feeRules);
        }
        if (permissions.has('limits:read') || permissions.has('limits:write')) {
          const l = await apiFetch<{ limitRules: LimitRuleRecord[] }>('/admin/limits');
          setLimitRules(l.limitRules);
        }
        if (permissions.has('staff:read') || permissions.has('approvals:read')) {
          const s = await apiFetch<{ staff: any[]; approvals: ApprovalRecord[] }>('/admin/staff');
          setApprovals(s.approvals);
        }
      } else if (targetTab === 'staff' && permissions.has('staff:read')) {
        const s = await apiFetch<{ staff: any[]; approvals: ApprovalRecord[]; rbacRules?: RbacRuleRecord[] }>('/admin/staff');
        setStaffList(s.staff);
        setApprovals(s.approvals);
        setRbacRules(s.rbacRules || []);
      } else if (targetTab === 'reconciliation' && permissions.has('reconciliation:read')) {
        const r = await apiFetch<{ runs: ReconciliationRunRecord[] }>('/admin/reconciliation');
        setReconciliationRuns(r.runs);
      } else if (targetTab === 'risk' && permissions.has('risk:read')) {
        const rf = await apiFetch<{ flags: RiskFlagRecord[] }>('/admin/risk-flags');
        setRiskFlags(rf.flags);
      } else if (targetTab === 'audit' && permissions.has('audit:read')) {
        const a = await apiFetch<{ auditLogs: AuditLogRecord[] }>('/admin/audit-logs');
        setAuditLogs(a.auditLogs);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load admin view');
    }
  };

  useEffect(() => {
    void loadTab(tab);
  }, [tab]);

  const runAction = async (fn: () => Promise<void>, successMessage: string) => {
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(successMessage);
      await loadTab(tab);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    }
  };

  const runPinGuardedAction = (
    adminAction: string,
    title: string,
    fn: (stepUpToken: string) => Promise<void>,
    successMessage: string,
  ) => {
    setError(null);
    setNotice(null);
    setPendingPinAction({ adminAction, title, fn, successMessage });
  };

  const navItems: Array<{ id: AdminTab; label: string; icon: React.ReactNode; show: boolean }> = [
    { id: 'overview', label: 'Overview', icon: <LayoutDashboard className="w-4 h-4" />, show: permissions.has('transactions:read') },
    { id: 'kyc', label: 'KYC Queue', icon: <FileCheck className="w-4 h-4" />, show: permissions.has('kyc:read') },
    { id: 'deposits', label: 'Deposits', icon: <ArrowDownCircle className="w-4 h-4" />, show: permissions.has('deposits:read') },
    { id: 'withdrawals', label: 'Withdrawals', icon: <ArrowUpCircle className="w-4 h-4" />, show: permissions.has('withdrawals:read') },
    { id: 'users', label: 'Users & Accounts', icon: <Users className="w-4 h-4" />, show: permissions.has('users:read') },
    { id: 'transactions', label: 'Ledger & Txns', icon: <Activity className="w-4 h-4" />, show: permissions.has('transactions:read') },
    { id: 'rules', label: 'Fees & Limits', icon: <Settings className="w-4 h-4" />, show: permissions.has('fees:read') || permissions.has('fees:write') },
    { id: 'staff', label: 'Staff & Dual Control', icon: <CheckCircle2 className="w-4 h-4" />, show: permissions.has('staff:read') },
    { id: 'reconciliation', label: 'Reconciliation', icon: <Scale className="w-4 h-4" />, show: permissions.has('reconciliation:read') },
    { id: 'risk', label: 'Risk Flags', icon: <AlertTriangle className="w-4 h-4" />, show: permissions.has('risk:read') },
    { id: 'audit', label: 'Audit Log', icon: <History className="w-4 h-4" />, show: permissions.has('audit:read') },
  ];

  return (
    <div className="min-h-screen bg-[#F7F8FA] flex flex-col lg:flex-row">
      {/* Sidebar */}
      <aside className="w-full lg:w-64 bg-white border-b lg:border-b-0 lg:border-r border-slate-200 p-4 flex flex-col justify-between shrink-0">
        <div>
          <div className="flex items-center gap-2.5 px-2 pb-4 border-b border-slate-100">
            <WalletBrandMark className="w-7 h-7" />
            <div>
              <p className="font-display text-sm font-bold text-slate-900">Comfort Ops</p>
              <p className="text-[11px] font-mono text-slate-500">{currentUser.role}</p>
            </div>
          </div>

          <nav className="mt-4 flex lg:flex-col gap-1 overflow-x-auto pb-2 lg:pb-0">
            {navItems
              .filter((item) => item.show)
              .map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setTab(item.id)}
                  className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-medium whitespace-nowrap transition-colors min-h-[40px] ${
                    tab === item.id
                      ? 'bg-emerald-50 text-emerald-800 font-semibold'
                      : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                  }`}
                >
                  {item.icon}
                  <span>{item.label}</span>
                </button>
              ))}
          </nav>
        </div>

        <div className="hidden lg:flex flex-col gap-2 pt-4 border-t border-slate-100">
          <button
            type="button"
            onClick={onSwitchToWallet}
            className="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50 text-left"
          >
            Switch to User PWA
          </button>
          <button
            type="button"
            onClick={() => void onLogout()}
            className="w-full px-3 py-2 rounded-xl text-xs font-medium text-red-700 hover:bg-red-50 flex items-center gap-2"
          >
            <LogOut className="w-3.5 h-3.5" />
            Sign Out
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="bg-white border-b border-slate-200 px-6 py-3.5 flex items-center justify-between gap-4">
          <div className="text-xs text-slate-500">
            Back-Office / <span className="font-semibold text-slate-900 capitalize">{tab}</span>
          </div>
          <div className="flex items-center gap-3 text-xs text-slate-600">
            <span className="hidden sm:inline font-mono">{currentUser.email}</span>
            <button
              type="button"
              onClick={() => void onLogout()}
              className="lg:hidden px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-medium"
            >
              Sign Out
            </button>
          </div>
        </header>

        <main className="p-6 max-w-7xl w-full mx-auto space-y-6">
          {error && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs font-medium text-red-700">
              {error}
            </div>
          )}
          {notice && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs font-medium text-emerald-800">
              {notice}
            </div>
          )}

          {tab === 'overview' && overview && (
            <div className="space-y-6">
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
                <div className="bg-white rounded-2xl border border-slate-200 p-4">
                  <p className="text-xs text-slate-500">Wallet Users</p>
                  <p className="mt-1 font-mono text-2xl font-bold text-slate-900 tabular-nums">{overview.totalUsers}</p>
                </div>
                <div className="bg-white rounded-2xl border border-slate-200 p-4">
                  <p className="text-xs text-slate-500">Pending KYC</p>
                  <p className="mt-1 font-mono text-2xl font-bold text-amber-700 tabular-nums">{overview.pendingKyc}</p>
                </div>
                <div className="bg-white rounded-2xl border border-slate-200 p-4">
                  <p className="text-xs text-slate-500">Deposit Queue</p>
                  <p className="mt-1 font-mono text-2xl font-bold text-slate-900 tabular-nums">{overview.pendingDeposits}</p>
                </div>
                <div className="bg-white rounded-2xl border border-slate-200 p-4">
                  <p className="text-xs text-slate-500">Withdrawal Queue</p>
                  <p className="mt-1 font-mono text-2xl font-bold text-slate-900 tabular-nums">{overview.pendingWithdrawals}</p>
                </div>
                <div className="bg-white rounded-2xl border border-slate-200 p-4">
                  <p className="text-xs text-slate-500">Open Risk Flags</p>
                  <p className="mt-1 font-mono text-2xl font-bold text-red-700 tabular-nums">{overview.openRiskFlags}</p>
                </div>
              </div>

              <div className="bg-white rounded-2xl border border-slate-200 p-6">
                <h2 className="font-display text-base font-bold text-slate-900">
                  Double-Entry Ledger Position · Invariant{' '}
                  {overview.ledgerInvariant.valid ? 'Balanced (Debits == Credits)' : 'IMBALANCE DETECTED'}
                </h2>
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200 text-slate-500">
                        <th className="py-2 pr-4">Currency</th>
                        <th className="py-2 pr-4 text-right">User Wallet Liabilities</th>
                        <th className="py-2 pr-4 text-right">Withdrawal Holds</th>
                        <th className="py-2 pr-4 text-right">Fee Revenue</th>
                        <th className="py-2 text-right">Bank Settlement</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 font-mono tabular-nums">
                      {Object.entries(overview.balancesByCurrency).map(([cur, vals]: [string, any]) => (
                        <tr key={cur}>
                          <td className="py-2.5 pr-4 font-semibold">{cur}</td>
                          <td className="py-2.5 pr-4 text-right">{formatMinorUnits(vals.userLiabilitiesMinor, cur as Currency)}</td>
                          <td className="py-2.5 pr-4 text-right">{formatMinorUnits(vals.withdrawalHoldMinor, cur as Currency)}</td>
                          <td className="py-2.5 pr-4 text-right">{formatMinorUnits(vals.feeRevenueMinor, cur as Currency)}</td>
                          <td className="py-2.5 text-right font-semibold text-emerald-700">
                            {formatMinorUnits(vals.bankSettlementMinor, cur as Currency)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {tab === 'kyc' && (
            <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
              <h2 className="font-display text-base font-bold text-slate-900">KYC Verification Queue</h2>
              {kycQueue.length === 0 ? (
                <p className="text-sm text-slate-500 py-6">No pending KYC submissions.</p>
              ) : (
                <div className="divide-y divide-slate-100">
                  {kycQueue.map((item) => (
                    <div key={item.userId} className="py-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
                      <div>
                        <p className="text-sm font-semibold text-slate-900">
                          {item.profile?.fullName || item.email} · <span className="font-mono text-xs">{item.kycStatus}</span>
                        </p>
                        <p className="text-xs text-slate-500 mt-0.5">
                          ID: <span className="font-mono">{item.profile?.nationalIdNumber}</span> · DOB: {item.profile?.dateOfBirth} ·{' '}
                          {item.profile?.address} ({item.profile?.country})
                        </p>
                        <div className="mt-2 flex gap-3">
                          {item.documents?.map((doc: any) => (
                            <a
                              key={doc.id}
                              href={doc.signedUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="text-xs text-emerald-700 underline"
                            >
                              Signed {doc.type} URL
                            </a>
                          ))}
                        </div>
                      </div>
                      {permissions.has('kyc:decide') && (
                        <div className="flex gap-2 shrink-0">
                          <button
                            type="button"
                            onClick={() =>
                              runPinGuardedAction(
                                'kyc_decide',
                                'Authorize KYC Approval',
                                (stepUpToken) =>
                                  apiFetch(`/admin/kyc/${item.userId}/decision`, {
                                    method: 'POST',
                                    stepUpToken,
                                    body: JSON.stringify({ decision: 'APPROVED' }),
                                  }),
                                'KYC approved and 10-digit wallet account provisioned.',
                              )
                            }
                            className="px-3.5 py-2 rounded-xl bg-emerald-700 text-white text-xs font-semibold hover:bg-emerald-800 min-h-[38px]"
                          >
                            Approve & Create Wallet
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              runPinGuardedAction(
                                'kyc_decide',
                                'Authorize KYC Rejection',
                                (stepUpToken) =>
                                  apiFetch(`/admin/kyc/${item.userId}/decision`, {
                                    method: 'POST',
                                    stepUpToken,
                                    body: JSON.stringify({ decision: 'REJECTED', reason: 'Document illegible or mismatch' }),
                                  }),
                                'KYC rejected.',
                              )
                            }
                            className="px-3.5 py-2 rounded-xl border border-red-200 text-red-700 text-xs font-semibold hover:bg-red-50 min-h-[38px]"
                          >
                            Reject
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === 'deposits' && (
            <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
              <h2 className="font-display text-base font-bold text-slate-900">Deposit Approval Queue (Maker-Checker)</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-500">
                      <th className="py-2 pr-4">User</th>
                      <th className="py-2 pr-4">Reference</th>
                      <th className="py-2 pr-4">Method</th>
                      <th className="py-2 pr-4 text-right">Amount</th>
                      <th className="py-2 pr-4">Status</th>
                      <th className="py-2 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {deposits.map((d) => (
                      <tr key={d.id}>
                        <td className="py-3 pr-4">{d.userName || d.userEmail}</td>
                        <td className="py-3 pr-4 font-mono">{d.paymentReference}</td>
                        <td className="py-3 pr-4">{d.method}</td>
                        <td className="py-3 pr-4 text-right font-mono font-semibold tabular-nums">
                          {formatMinorUnits(d.amountMinor, d.currency)}
                        </td>
                        <td className="py-3 pr-4 font-mono">{d.status}</td>
                        <td className="py-3 text-right space-x-2 whitespace-nowrap">
                          {d.status === 'PENDING' && permissions.has('deposits:make') && (
                            <button
                              type="button"
                              onClick={() =>
                                runPinGuardedAction(
                                  'deposit_approve',
                                  'Authorize Deposit Maker Approval',
                                  (stepUpToken) =>
                                    apiFetch(`/admin/deposits/${d.id}/approve`, {
                                      method: 'POST',
                                      stepUpToken,
                                      body: JSON.stringify({}),
                                    }),
                                  'Deposit Maker-approved. Ready for Finance Checker.',
                                )
                              }
                              className="px-3 py-1.5 rounded-lg bg-slate-900 text-white font-semibold"
                            >
                              Maker Approve
                            </button>
                          )}
                          {d.status === 'MAKER_APPROVED' && permissions.has('deposits:check') && (
                            <button
                              type="button"
                              onClick={() =>
                                runPinGuardedAction(
                                  'deposit_approve',
                                  'Authorize Deposit Checker Ledger Post',
                                  (stepUpToken) =>
                                    apiFetch(`/admin/deposits/${d.id}/approve`, {
                                      method: 'POST',
                                      stepUpToken,
                                      body: JSON.stringify({}),
                                    }),
                                  'Deposit Checker-approved and posted to ledger.',
                                )
                              }
                              className="px-3 py-1.5 rounded-lg bg-emerald-700 text-white font-semibold"
                            >
                              Checker Post
                            </button>
                          )}
                          {(d.status === 'PENDING' || d.status === 'MAKER_APPROVED') && permissions.has('deposits:make') && (
                            <button
                              type="button"
                              onClick={() =>
                                runPinGuardedAction(
                                  'deposit_reject',
                                  'Authorize Deposit Rejection',
                                  (stepUpToken) =>
                                    apiFetch(`/admin/deposits/${d.id}/reject`, {
                                      method: 'POST',
                                      stepUpToken,
                                      body: JSON.stringify({ reason: 'Unmatched settlement reference' }),
                                    }),
                                  'Deposit rejected.',
                                )
                              }
                              className="px-3 py-1.5 rounded-lg border border-red-200 text-red-700 font-semibold"
                            >
                              Reject
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {tab === 'withdrawals' && (
            <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
              <h2 className="font-display text-base font-bold text-slate-900">Withdrawal & Payout Queue (Maker-Checker)</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-500">
                      <th className="py-2 pr-4">User</th>
                      <th className="py-2 pr-4">Destination</th>
                      <th className="py-2 pr-4 text-right">Amount</th>
                      <th className="py-2 pr-4">Status</th>
                      <th className="py-2 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {withdrawals.map((w) => (
                      <tr key={w.id}>
                        <td className="py-3 pr-4">{w.userName}</td>
                        <td className="py-3 pr-4 font-mono">{w.destinationDecrypted || w.destinationPreview}</td>
                        <td className="py-3 pr-4 text-right font-mono font-semibold tabular-nums">
                          {formatMinorUnits(w.amountMinor, w.currency)}
                        </td>
                        <td className="py-3 pr-4 font-mono">{w.status}</td>
                        <td className="py-3 text-right space-x-2 whitespace-nowrap">
                          {w.status === 'PENDING' && permissions.has('withdrawals:make') && (
                            <button
                              type="button"
                              onClick={() =>
                                runPinGuardedAction(
                                  'withdrawal_approve',
                                  'Authorize Withdrawal Maker Approval',
                                  (stepUpToken) =>
                                    apiFetch(`/admin/withdrawals/${w.id}/approve`, {
                                      method: 'POST',
                                      stepUpToken,
                                      body: JSON.stringify({}),
                                    }),
                                  'Withdrawal Maker-approved.',
                                )
                              }
                              className="px-3 py-1.5 rounded-lg bg-slate-900 text-white font-semibold"
                            >
                              Maker Approve
                            </button>
                          )}
                          {w.status === 'MAKER_APPROVED' && permissions.has('withdrawals:check') && (
                            <button
                              type="button"
                              onClick={() =>
                                runPinGuardedAction(
                                  'withdrawal_approve',
                                  'Authorize Withdrawal Checker Approval',
                                  (stepUpToken) =>
                                    apiFetch(`/admin/withdrawals/${w.id}/approve`, {
                                      method: 'POST',
                                      stepUpToken,
                                      body: JSON.stringify({}),
                                    }),
                                  'Withdrawal Checker-approved. Ready for external payout.',
                                )
                              }
                              className="px-3 py-1.5 rounded-lg bg-emerald-700 text-white font-semibold"
                            >
                              Checker Approve
                            </button>
                          )}
                          {w.status === 'CHECKER_APPROVED' && permissions.has('withdrawals:payout') && (
                            <div className="inline-flex items-center gap-1.5">
                              <input
                                type="text"
                                placeholder="Payout Ref"
                                value={payoutRefMap[w.id] || ''}
                                onChange={(e) => setPayoutRefMap({ ...payoutRefMap, [w.id]: e.target.value })}
                                className="h-8 w-28 rounded-lg border border-slate-200 px-2 font-mono text-xs"
                              />
                              <button
                                type="button"
                                onClick={() =>
                                  runPinGuardedAction(
                                    'withdrawal_payout',
                                    'Authorize External Payout Settlement',
                                    (stepUpToken) =>
                                      apiFetch(`/admin/withdrawals/${w.id}/mark-paid`, {
                                        method: 'POST',
                                        stepUpToken,
                                        body: JSON.stringify({ payoutReference: payoutRefMap[w.id] || `PAY-${w.id.slice(-6).toUpperCase()}` }),
                                      }),
                                    'Payout marked paid and hold released to settlement.',
                                  )
                                }
                                className="px-3 py-1.5 rounded-lg bg-emerald-700 text-white font-semibold"
                              >
                                Mark Paid
                              </button>
                            </div>
                          )}
                          {(w.status === 'PENDING' || w.status === 'MAKER_APPROVED' || w.status === 'CHECKER_APPROVED') &&
                            permissions.has('withdrawals:make') && (
                              <button
                                type="button"
                                onClick={() =>
                                  runPinGuardedAction(
                                    'withdrawal_reject',
                                    'Authorize Withdrawal Rejection & Release',
                                    (stepUpToken) =>
                                      apiFetch(`/admin/withdrawals/${w.id}/reject`, {
                                        method: 'POST',
                                        stepUpToken,
                                        body: JSON.stringify({ reason: 'Payout destination validation failed' }),
                                      }),
                                    'Withdrawal rejected and held funds returned to user wallet.',
                                  )
                                }
                                className="px-3 py-1.5 rounded-lg border border-red-200 text-red-700 font-semibold"
                              >
                                Reject & Release
                              </button>
                            )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {tab === 'users' && (
            <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <h2 className="font-display text-base font-bold text-slate-900">Users & Accounts</h2>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={userQuery}
                    onChange={(e) => setUserQuery(e.target.value)}
                    placeholder="Search email, name, phone..."
                    className="h-9 rounded-xl border border-slate-200 px-3 text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => void loadTab('users')}
                    className="px-3 h-9 rounded-xl bg-slate-900 text-white text-xs font-semibold"
                  >
                    Search
                  </button>
                </div>
              </div>

              <div className="divide-y divide-slate-100">
                {usersList.map((u) => (
                  <div key={u.id} className="py-3.5 flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div>
                      <p className="text-sm font-semibold text-slate-900">
                        {u.fullName || u.email} · <span className="font-mono text-xs">{u.role}</span> ·{' '}
                        <span className={u.status === 'FROZEN' ? 'text-red-700 font-mono text-xs' : 'text-emerald-700 font-mono text-xs'}>
                          {u.status}
                        </span>
                      </p>
                      <p className="text-xs text-slate-500 mt-0.5">
                        {u.email || u.phone} · KYC {u.kycStatus}
                        {u.accounts?.map((a: any) => ` · ${a.currency} ${a.accountNumber} (${formatMinorUnits(a.balanceMinor, a.currency)})`)}
                      </p>
                    </div>
                    {u.role === Role.USER && permissions.has('users:freeze') && (
                      <div>
                        {u.status === 'ACTIVE' ? (
                          <button
                            type="button"
                            onClick={() =>
                              runPinGuardedAction(
                                'user_freeze',
                                'Authorize Account Freeze',
                                (stepUpToken) =>
                                  apiFetch(`/admin/users/${u.id}/freeze`, {
                                    method: 'POST',
                                    stepUpToken,
                                    body: JSON.stringify({ reason: 'Compliance velocity review' }),
                                  }),
                                'User account frozen.',
                              )
                            }
                            className="px-3 py-1.5 rounded-lg border border-red-200 text-red-700 text-xs font-semibold"
                          >
                            Freeze Account
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() =>
                              runPinGuardedAction(
                                'user_unfreeze',
                                'Authorize Account Unfreeze',
                                (stepUpToken) =>
                                  apiFetch(`/admin/users/${u.id}/unfreeze`, {
                                    method: 'POST',
                                    stepUpToken,
                                    body: JSON.stringify({ reason: 'Compliance cleared' }),
                                  }),
                                'User account unfrozen.',
                              )
                            }
                            className="px-3 py-1.5 rounded-lg bg-emerald-700 text-white text-xs font-semibold"
                          >
                            Unfreeze
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === 'transactions' && (
            <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
              <h2 className="font-display text-base font-bold text-slate-900">Transactions & Immutable Journal</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-500">
                      <th className="py-2 pr-4">Reference</th>
                      <th className="py-2 pr-4">Type</th>
                      <th className="py-2 pr-4">Status</th>
                      <th className="py-2 pr-4 text-right">Amount</th>
                      <th className="py-2 pr-4 text-right">Fee</th>
                      <th className="py-2 pr-4">Legs</th>
                      <th className="py-2 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {transactions.map((t) => (
                      <tr key={t.id}>
                        <td className="py-2.5 pr-4 font-mono">{t.reference}</td>
                        <td className="py-2.5 pr-4 capitalize">{t.type}</td>
                        <td className="py-2.5 pr-4 font-mono">{t.status}</td>
                        <td className="py-2.5 pr-4 text-right font-mono tabular-nums">
                          {formatMinorUnits(t.amountMinor, t.currency)}
                        </td>
                        <td className="py-2.5 pr-4 text-right font-mono tabular-nums">
                          {formatMinorUnits(t.feeMinor, t.currency)}
                        </td>
                        <td className="py-2.5 pr-4 font-mono text-slate-500">{t.journalLines?.length || 0} lines</td>
                        <td className="py-2.5 text-right">
                          {t.status === 'COMPLETED' && t.type !== 'reversal' && permissions.has('transactions:reverse') && (
                            <button
                              type="button"
                              onClick={() =>
                                runPinGuardedAction(
                                  'transaction_reverse',
                                  'Authorize Immutable Ledger Reversal',
                                  (stepUpToken) =>
                                    apiFetch(`/admin/transactions/${t.id}/reverse`, {
                                      method: 'POST',
                                      stepUpToken,
                                      body: JSON.stringify({ reason: 'Admin reversal authorized with PIN' }),
                                    }),
                                  'Immutable reversal journal entry posted.',
                                )
                              }
                              className="px-2.5 py-1 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 font-semibold"
                            >
                              Reverse
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {tab === 'rules' && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <section className="bg-white rounded-2xl border border-slate-200 p-6">
                  <h2 className="font-display text-base font-bold text-slate-900">Active Fee Rules</h2>
                  <div className="mt-4 divide-y divide-slate-100 text-xs">
                    {feeRules.map((f) => (
                      <div key={f.id} className="py-2.5 flex justify-between">
                        <span className="font-semibold capitalize">{f.transactionType} ({f.currency})</span>
                        <span className="font-mono">
                          Flat {formatMinorUnits(f.flatMinor, f.currency)} + {(f.percentBps / 100).toFixed(2)}%
                        </span>
                      </div>
                    ))}
                  </div>
                  {permissions.has('fees:write') && (
                    <div className="mt-4 pt-4 border-t border-slate-100 flex items-center gap-2">
                      <input
                        type="number"
                        value={flatFeeInput}
                        onChange={(e) => setFlatFeeInput(e.target.value)}
                        className="h-9 w-24 rounded-lg border border-slate-200 px-2 font-mono text-xs"
                        placeholder="Flat minor"
                      />
                      <input
                        type="number"
                        value={bpsFeeInput}
                        onChange={(e) => setBpsFeeInput(e.target.value)}
                        className="h-9 w-24 rounded-lg border border-slate-200 px-2 font-mono text-xs"
                        placeholder="BPS"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          runPinGuardedAction(
                            'fees_write',
                            'Authorize Fee Rule Proposal',
                            (stepUpToken) =>
                              apiFetch('/admin/fees', {
                                method: 'PUT',
                                stepUpToken,
                                body: JSON.stringify({
                                  transactionType: TransactionType.TRANSFER,
                                  currency: Currency.USD,
                                  flatMinor: Number(flatFeeInput),
                                  percentBps: Number(bpsFeeInput),
                                  minMinor: 10,
                                  maxMinor: 300,
                                  active: true,
                                }),
                              }),
                            'Fee rule change queued for second Super Admin approval.',
                          )
                        }
                        className="px-3 h-9 rounded-lg bg-slate-900 text-white text-xs font-semibold"
                      >
                        Propose USD Transfer Fee
                      </button>
                    </div>
                  )}
                </section>

                <section className="bg-white rounded-2xl border border-slate-200 p-6">
                  <h2 className="font-display text-base font-bold text-slate-900">Active Limit Rules</h2>
                  <div className="mt-4 divide-y divide-slate-100 text-xs">
                    {limitRules.map((l) => (
                      <div key={l.id} className="py-2.5 flex justify-between gap-4">
                        <span className="font-semibold">
                          {l.scope} · {l.transactionType} ({l.currency})
                        </span>
                        <span className="font-mono tabular-nums">
                          Day {formatMinorUnits(l.dailyMaxMinor, l.currency)} · Mo {formatMinorUnits(l.monthlyMaxMinor, l.currency)}
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              </div>
            </div>
          )}

          {tab === 'staff' && (
            <div className="space-y-6">
              {/* Pending Staff Onboarding Queue (Super Admin Approval & Promotion) */}
              <section className="bg-white rounded-2xl border border-slate-200 p-6">
                <h2 className="font-display text-base font-bold text-slate-900">
                  Pending Staff Signups &amp; Role Promotion
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  All staff signups remain locked in PENDING_APPROVAL until approved and assigned a least-privilege role by Super Admin.
                </p>
                <div className="mt-4 divide-y divide-slate-100 text-xs">
                  {staffList.filter((s) => s.staffStatus === 'PENDING_APPROVAL').length === 0 ? (
                    <p className="text-slate-500 py-4">No pending staff applications awaiting Super Admin review.</p>
                  ) : (
                    staffList
                      .filter((s) => s.staffStatus === 'PENDING_APPROVAL')
                      .map((s) => {
                        const selectedRole = staffRoleSelections[s.id] || s.requestedRole || s.role;
                        return (
                          <div key={s.id} className="py-3.5 flex flex-col md:flex-row md:items-center justify-between gap-3">
                            <div>
                              <p className="font-semibold text-slate-900">
                                {s.fullName || s.email || s.phone} ·{' '}
                                <span className="font-mono text-amber-700">{s.staffStatus}</span>
                              </p>
                              <p className="text-slate-500 mt-0.5">
                                {s.email || s.phone} · Requested: <span className="font-mono">{s.requestedRole || s.role}</span> ·{' '}
                                {s.pinConfigured ? '6-Digit PIN Secured' : 'PIN Pending'}
                              </p>
                            </div>
                            {currentUser.role === Role.SUPER_ADMIN && (
                              <div className="flex flex-wrap items-center gap-2 shrink-0">
                                <select
                                  value={selectedRole}
                                  onChange={(e) =>
                                    setStaffRoleSelections({ ...staffRoleSelections, [s.id]: e.target.value as Role })
                                  }
                                  className="h-9 rounded-lg border border-slate-200 px-2.5 text-xs bg-white font-mono"
                                >
                                  {ADMIN_ROLES.map((r) => (
                                    <option key={r} value={r}>
                                      {r}
                                    </option>
                                  ))}
                                </select>
                                <button
                                  type="button"
                                  onClick={() =>
                                    runPinGuardedAction(
                                      'staff_approve',
                                      `Approve & Promote Staff (${selectedRole})`,
                                      (stepUpToken) =>
                                        apiFetch(`/admin/staff/${s.id}/approve`, {
                                          method: 'POST',
                                          stepUpToken,
                                          body: JSON.stringify({ decision: 'APPROVED', assignedRole: selectedRole }),
                                        }),
                                      `Staff member approved and promoted to ${selectedRole}.`,
                                    )
                                  }
                                  className="px-3 py-1.5 rounded-lg bg-emerald-700 text-white font-semibold min-h-[36px]"
                                >
                                  Approve &amp; Promote
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    runPinGuardedAction(
                                      'staff_approve',
                                      'Decline Staff Application',
                                      (stepUpToken) =>
                                        apiFetch(`/admin/staff/${s.id}/approve`, {
                                          method: 'POST',
                                          stepUpToken,
                                          body: JSON.stringify({ decision: 'REJECTED', reason: 'Not authorized' }),
                                        }),
                                      'Staff application declined.',
                                    )
                                  }
                                  className="px-3 py-1.5 rounded-lg border border-red-200 text-red-700 font-semibold min-h-[36px]"
                                >
                                  Decline
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })
                  )}
                </div>
              </section>

              {/* Active Staff Directory & Role Promotion */}
              <section className="bg-white rounded-2xl border border-slate-200 p-6">
                <h2 className="font-display text-base font-bold text-slate-900">Active Staff Directory &amp; Role Management</h2>
                <div className="mt-4 divide-y divide-slate-100 text-xs">
                  {staffList
                    .filter((s) => s.staffStatus !== 'PENDING_APPROVAL')
                    .map((s) => {
                      const selectedRole = staffRoleSelections[s.id] || s.role;
                      return (
                        <div key={s.id} className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                          <div>
                            <p className="font-semibold text-slate-900">
                              {s.fullName || s.email || s.phone} ·{' '}
                              <span className="font-mono text-emerald-700">{s.role}</span> ·{' '}
                              <span className="font-mono text-slate-500">{s.staffStatus}</span>
                            </p>
                            <p className="text-slate-500 mt-0.5">
                              {s.email || s.phone} · {s.pinConfigured ? 'Staff 6-Digit PIN Active' : 'No PIN Yet'}
                            </p>
                          </div>
                          {currentUser.role === Role.SUPER_ADMIN && s.id !== currentUser.id && (
                            <div className="flex items-center gap-2 shrink-0">
                              <select
                                value={selectedRole}
                                onChange={(e) =>
                                  setStaffRoleSelections({ ...staffRoleSelections, [s.id]: e.target.value as Role })
                                }
                                className="h-9 rounded-lg border border-slate-200 px-2.5 text-xs bg-white font-mono"
                              >
                                {ADMIN_ROLES.map((r) => (
                                  <option key={r} value={r}>
                                    {r}
                                  </option>
                                ))}
                              </select>
                              <button
                                type="button"
                                onClick={() =>
                                  runPinGuardedAction(
                                    'staff_approve',
                                    `Promote Staff to ${selectedRole}`,
                                    (stepUpToken) =>
                                      apiFetch(`/admin/staff/${s.id}/approve`, {
                                        method: 'POST',
                                        stepUpToken,
                                        body: JSON.stringify({ decision: 'APPROVED', assignedRole: selectedRole }),
                                      }),
                                    `Updated staff role to ${selectedRole}.`,
                                  )
                                }
                                className="px-3 py-1.5 rounded-lg bg-slate-900 text-white font-semibold min-h-[36px]"
                              >
                                Update Role
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                </div>
              </section>

              {/* Role-Based Access Permissions */}
              <section className="bg-white rounded-2xl border border-slate-200 p-6">
                <h2 className="font-display text-base font-bold text-slate-900">Role Permissions Matrix</h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Role-based permissions enforced across Back-Office operations.
                </p>
                <div className="mt-4 divide-y divide-slate-100 text-xs">
                  {rbacRules.map((rule) => (
                    <div key={rule.role} className="py-3 space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono font-bold text-slate-900">{rule.role}</span>
                        <span className="font-mono text-[11px] text-slate-500">{rule.permissions.length} permissions</span>
                      </div>
                      <p className="text-slate-600">{rule.description}</p>
                      <p className="font-mono text-[11px] text-slate-400 break-words">
                        {rule.permissions.join(' · ') || 'customer-only scope'}
                      </p>
                    </div>
                  ))}
                </div>
              </section>

              <section className="bg-white rounded-2xl border border-slate-200 p-6">
                <h2 className="font-display text-base font-bold text-slate-900">Dual-Control Pending Approvals</h2>
                <div className="mt-4 divide-y divide-slate-100 text-xs">
                  {approvals.length === 0 ? (
                    <p className="text-slate-500 py-4">No dual-control change requests.</p>
                  ) : (
                    approvals.map((a) => (
                      <div key={a.id} className="py-3 flex items-center justify-between gap-4">
                        <div>
                          <p className="font-semibold">
                            {a.entityType} · {a.entityId} · <span className="font-mono">{a.status}</span>
                          </p>
                          <p className="text-slate-500 font-mono mt-0.5">Requested by: {a.requestedBy}</p>
                        </div>
                        {a.status === 'PENDING' && permissions.has('approvals:decide') && (
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={() =>
                                runPinGuardedAction(
                                  'approval_decide',
                                  'Authorize Dual-Control Approval',
                                  (stepUpToken) =>
                                    apiFetch(`/admin/approvals/${a.id}/decide`, {
                                      method: 'POST',
                                      stepUpToken,
                                      body: JSON.stringify({ decision: 'APPROVED' }),
                                    }),
                                  'Change approved by second administrator.',
                                )
                              }
                              className="px-3 py-1.5 rounded-lg bg-emerald-700 text-white font-semibold"
                            >
                              Approve
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                runPinGuardedAction(
                                  'approval_decide',
                                  'Authorize Dual-Control Rejection',
                                  (stepUpToken) =>
                                    apiFetch(`/admin/approvals/${a.id}/decide`, {
                                      method: 'POST',
                                      stepUpToken,
                                      body: JSON.stringify({ decision: 'REJECTED' }),
                                    }),
                                  'Change rejected.',
                                )
                              }
                              className="px-3 py-1.5 rounded-lg border border-red-200 text-red-700 font-semibold"
                            >
                              Reject
                            </button>
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </section>
            </div>
          )}

          {tab === 'reconciliation' && (
            <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <h2 className="font-display text-base font-bold text-slate-900">Daily Reconciliation Runs</h2>
                {permissions.has('reconciliation:resolve') && (
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={extBankInput}
                      onChange={(e) => setExtBankInput(e.target.value)}
                      placeholder="Bank USD minor (optional)"
                      className="h-9 rounded-xl border border-slate-200 px-3 font-mono text-xs"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        void runAction(
                          () =>
                            apiFetch('/admin/reconciliation/run', {
                              method: 'POST',
                              body: JSON.stringify({
                                currency: Currency.USD,
                                externalBankTotalMinor: extBankInput ? Number(extBankInput) : undefined,
                              }),
                            }),
                          'Daily USD reconciliation run completed.',
                        )
                      }
                      className="px-3.5 h-9 rounded-xl bg-slate-900 text-white text-xs font-semibold"
                    >
                      Run USD Reconciliation
                    </button>
                  </div>
                )}
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-500">
                      <th className="py-2 pr-4">Date</th>
                      <th className="py-2 pr-4">Currency</th>
                      <th className="py-2 pr-4 text-right">Ledger Total</th>
                      <th className="py-2 pr-4 text-right">Bank Total</th>
                      <th className="py-2 pr-4 text-right">Difference</th>
                      <th className="py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-mono tabular-nums">
                    {reconciliationRuns.map((r) => (
                      <tr key={r.id}>
                        <td className="py-2.5 pr-4">{r.date}</td>
                        <td className="py-2.5 pr-4">{r.currency}</td>
                        <td className="py-2.5 pr-4 text-right">{formatMinorUnits(r.ledgerTotalMinor, r.currency)}</td>
                        <td className="py-2.5 pr-4 text-right">{formatMinorUnits(r.bankTotalMinor, r.currency)}</td>
                        <td className="py-2.5 pr-4 text-right">{formatMinorUnits(r.differenceMinor, r.currency)}</td>
                        <td className="py-2.5">{r.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {tab === 'risk' && (
            <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
              <h2 className="font-display text-base font-bold text-slate-900">AML & Risk Monitoring Flags</h2>
              <div className="divide-y divide-slate-100 text-xs">
                {riskFlags.map((rf) => (
                  <div key={rf.id} className="py-3 flex items-center justify-between gap-4">
                    <div>
                      <p className="font-semibold text-slate-900">
                        {rf.rule} · <span className="font-mono">{rf.severity}</span> · {rf.status}
                      </p>
                      <p className="text-slate-600 mt-0.5">{rf.details}</p>
                    </div>
                    {rf.status === 'OPEN' && permissions.has('risk:resolve') && (
                      <button
                        type="button"
                        onClick={() =>
                          void runAction(
                            () =>
                              apiFetch(`/admin/risk-flags/${rf.id}/resolve`, {
                                method: 'POST',
                                body: JSON.stringify({ status: 'RESOLVED', note: 'Reviewed by Compliance' }),
                              }),
                            'Risk flag resolved.',
                          )
                        }
                        className="px-3 py-1.5 rounded-lg bg-slate-900 text-white font-semibold shrink-0"
                      >
                        Resolve
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === 'audit' && (
            <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
              <h2 className="font-display text-base font-bold text-slate-900">Append-Only Audit Trail</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-500">
                      <th className="py-2 pr-4">Timestamp</th>
                      <th className="py-2 pr-4">Actor</th>
                      <th className="py-2 pr-4">Action</th>
                      <th className="py-2 pr-4">Entity</th>
                      <th className="py-2">Correlation ID</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-mono">
                    {auditLogs.slice(0, 60).map((log) => (
                      <tr key={log.id}>
                        <td className="py-2 pr-4 text-slate-500 whitespace-nowrap">{new Date(log.createdAt).toLocaleString()}</td>
                        <td className="py-2 pr-4">{log.actorType}:{log.actorId.slice(0, 12)}</td>
                        <td className="py-2 pr-4 font-semibold text-slate-900">{log.action}</td>
                        <td className="py-2 pr-4 text-slate-700">{log.entity}</td>
                        <td className="py-2 text-slate-400">{log.correlationId.slice(0, 12)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </main>
        <SiteFooter onOpenLegalDoc={onOpenLegalDoc} />
      </div>

      <PinSheet
        open={Boolean(pendingPinAction)}
        onClose={() => setPendingPinAction(null)}
        scope="admin_action"
        adminAction={pendingPinAction?.adminAction}
        title={pendingPinAction?.title}
        subtitle="Enter your 6-digit Staff Security PIN to execute this Back-Office operation"
        onVerified={(stepUpToken) => {
          const current = pendingPinAction;
          setPendingPinAction(null);
          if (current) {
            void runAction(() => current.fn(stepUpToken), current.successMessage);
          }
        }}
      />
    </div>
  );
};
