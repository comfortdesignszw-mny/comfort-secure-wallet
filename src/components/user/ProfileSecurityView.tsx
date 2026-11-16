import React, { useEffect, useState } from 'react';
import { Bell, KeyRound, Laptop, Shield, Trash2 } from 'lucide-react';
import { NotificationPreferences, NotificationRecord } from '../../shared/types.ts';
import { apiFetch } from '../../lib/api.ts';
import { ensurePushSubscription } from '../../lib/pushNotifications.ts';

interface DeviceSession {
  id: string;
  deviceLabel: string;
  ip: string;
  lastSeen: string;
  revokedAt: string | null;
}

interface ProfileSecurityViewProps {
  userEmail: string | null;
  userPhone: string | null;
  kycStatus: string;
  kycTier: number;
  notifications: NotificationRecord[];
  initialPrefs: NotificationPreferences;
  onRefresh: () => Promise<void>;
}

export const ProfileSecurityView: React.FC<ProfileSecurityViewProps> = ({
  userEmail,
  userPhone,
  kycStatus,
  kycTier,
  notifications,
  initialPrefs,
  onRefresh,
}) => {
  const [devices, setDevices] = useState<DeviceSession[]>([]);
  const [prefs, setPrefs] = useState<NotificationPreferences>(initialPrefs);
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [pinMsg, setPinMsg] = useState<string | null>(null);
  const [pinErr, setPinErr] = useState<string | null>(null);
  const [pushStatus, setPushStatus] = useState<string | null>(null);

  const loadDevices = async () => {
    try {
      const res = await apiFetch<{ devices: DeviceSession[] }>('/auth/devices');
      setDevices(res.devices);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    void loadDevices();
  }, []);

  const handleRevokeDevice = async (id: string) => {
    await apiFetch(`/auth/devices/${id}/revoke`, { method: 'POST' });
    await loadDevices();
  };

  const handleChangePin = async (e: React.FormEvent) => {
    e.preventDefault();
    setPinMsg(null);
    setPinErr(null);
    try {
      await apiFetch('/pin/change', {
        method: 'POST',
        body: JSON.stringify({ currentPin, newPin }),
      });
      setCurrentPin('');
      setNewPin('');
      setPinMsg('Security PIN updated successfully.');
    } catch (err) {
      setPinErr(err instanceof Error ? err.message : 'Failed to change PIN');
    }
  };

  const handleTogglePref = async (key: 'emailReceipts' | 'smsTransactions') => {
    const next = { ...prefs, [key]: !prefs[key] };
    setPrefs(next);
    await apiFetch('/notification-preferences', {
      method: 'PATCH',
      body: JSON.stringify({ [key]: next[key] }),
    });
  };

  const handleEnableWebPush = async () => {
    const res = await ensurePushSubscription();
    if (res.subscribed) {
      setPushStatus(`Transaction Web Push alerts active (Browser permission: ${res.permission}).`);
    } else {
      setPushStatus('Could not register Web Push subscription.');
    }
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Profile & Change PIN */}
        <section className="lg:col-span-6 bg-white rounded-3xl border border-slate-200 p-6 space-y-6">
          <div className="flex items-start gap-3 pb-4 border-b border-slate-100">
            <div className="w-10 h-10 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-700 flex items-center justify-center shrink-0">
              <Shield className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-display text-base font-bold text-slate-900">Identity & Security</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                {userEmail || userPhone} · KYC {kycStatus} · Tier {kycTier}
              </p>
            </div>
          </div>

          <form onSubmit={handleChangePin} className="space-y-3">
            <h3 className="text-xs font-semibold text-slate-800 flex items-center gap-1.5">
              <KeyRound className="w-3.5 h-3.5 text-emerald-700" />
              Change 6-Digit Security PIN
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <input
                type="password"
                inputMode="numeric"
                maxLength={6}
                required
                value={currentPin}
                onChange={(e) => setCurrentPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="Current PIN"
                className="h-11 rounded-xl border border-slate-200 px-3 font-mono text-sm text-center"
              />
              <input
                type="password"
                inputMode="numeric"
                maxLength={6}
                required
                value={newPin}
                onChange={(e) => setNewPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="New 6-digit PIN"
                className="h-11 rounded-xl border border-slate-200 px-3 font-mono text-sm text-center"
              />
            </div>
            {pinErr && <p className="text-xs text-red-600">{pinErr}</p>}
            {pinMsg && <p className="text-xs text-emerald-700">{pinMsg}</p>}
            <button
              type="submit"
              className="px-4 py-2.5 rounded-xl bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 min-h-[42px]"
            >
              Update Security PIN
            </button>
          </form>

          {/* Notification Preferences */}
          <div className="pt-4 border-t border-slate-100 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-slate-800 flex items-center gap-1.5">
                <Bell className="w-3.5 h-3.5 text-emerald-700" />
                Notification Preferences
              </h3>
              <button
                type="button"
                onClick={handleEnableWebPush}
                className="text-xs font-semibold text-emerald-700 hover:text-emerald-800"
              >
                Enable Web Push
              </button>
            </div>
            {pushStatus && <p className="text-xs text-emerald-700">{pushStatus}</p>}

            <label className="flex items-center justify-between text-xs text-slate-700 py-1">
              <span>Email transaction receipts & statements</span>
              <input
                type="checkbox"
                checked={prefs.emailReceipts}
                onChange={() => void handleTogglePref('emailReceipts')}
                className="h-4 w-4 accent-emerald-700"
              />
            </label>
            <div className="flex items-center justify-between text-xs text-slate-700 py-1">
              <span>Push notifications for every account transaction</span>
              <span className="font-mono text-[11px] font-semibold text-emerald-700">MANDATORY · ON</span>
            </div>
            <label className="flex items-center justify-between text-xs text-slate-700 py-1">
              <span>SMS transaction notices (Africa&apos;s Talking)</span>
              <input
                type="checkbox"
                checked={prefs.smsTransactions}
                onChange={() => void handleTogglePref('smsTransactions')}
                className="h-4 w-4 accent-emerald-700"
              />
            </label>
            <p className="text-[11px] text-slate-400">
              Real-time transaction push alerts and mandatory security notices (OTP, PIN lockouts, new-device sign-ins) are always enforced and cannot be disabled.
            </p>
          </div>
        </section>

        {/* Active Devices & Notifications Inbox */}
        <section className="lg:col-span-6 space-y-6">
          <div className="bg-white rounded-3xl border border-slate-200 p-6">
            <h3 className="font-display text-base font-semibold text-slate-900 flex items-center gap-2">
              <Laptop className="w-4 h-4 text-emerald-700" />
              Active Devices & Sessions
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">Manage signed-in devices and revoke unfamiliar sessions</p>

            <div className="mt-4 divide-y divide-slate-100">
              {devices.map((d) => (
                <div key={d.id} className="py-3 flex items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold text-slate-900">{d.deviceLabel}</p>
                    <p className="text-[11px] text-slate-500 font-mono">
                      {d.ip} · Last seen {new Date(d.lastSeen).toLocaleString()}
                      {d.revokedAt ? ' · REVOKED' : ''}
                    </p>
                  </div>
                  {!d.revokedAt && (
                    <button
                      type="button"
                      onClick={() => void handleRevokeDevice(d.id)}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-red-200 text-xs text-red-700 hover:bg-red-50 min-h-[36px]"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Revoke
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="bg-white rounded-3xl border border-slate-200 p-6">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900">In-App Notifications</h3>
              <button type="button" onClick={() => void onRefresh()} className="text-xs text-emerald-700 font-semibold">
                Refresh
              </button>
            </div>
            <div className="mt-3 divide-y divide-slate-100 max-h-64 overflow-y-auto">
              {notifications.length === 0 ? (
                <p className="py-6 text-center text-xs text-slate-500">No notifications yet.</p>
              ) : (
                notifications.slice(0, 12).map((n) => (
                  <div key={n.id} className="py-2.5">
                    <p className="text-xs font-semibold text-slate-900">
                      {n.title} · <span className="font-mono text-slate-500">{n.channel}</span>
                    </p>
                    <p className="text-xs text-slate-600 mt-0.5">{n.body}</p>
                    <p className="text-[10px] text-slate-400 mt-0.5">
                      {new Date(n.createdAt).toLocaleString()} · {n.status}
                    </p>
                  </div>
                ))
              )}
            </div>
          </div>
        </section>
      </div>

      {/* Terms, Privacy & Fee Schedule Disclosure (Section 12 checklist) */}
      <section className="bg-white rounded-3xl border border-slate-200 p-6 text-xs text-slate-600 space-y-2">
        <h3 className="font-display text-sm font-semibold text-slate-900">
          Regulatory Disclosures, Fee Schedule & Privacy Notice
        </h3>
        <p>
          <strong>Fee Schedule (Tier 1 USD):</strong> Wallet-to-wallet transfers carry a $0.10 flat + 0.50% fee (capped at $2.50).
          Deposits via verified partners are free. Default withdrawal limits are USD 100.00/day and USD 1,000.00/month.
        </p>
        <p>
          <strong>Data Protection & Safeguarding:</strong> National IDs and payout destinations are encrypted at rest
          under safeguarded financial controls, and all wallet ledger records are protected with comprehensive audit trails.
        </p>
      </section>
    </div>
  );
};
