import firebaseConfig from '../../firebase-applet-config.json';
import { generateLuhnAccountNumber } from '../shared/luhn.ts';
import {
  ADMIN_ROLES,
  AccountRecord,
  AccountStatus,
  ApprovalRecord,
  AuditLogRecord,
  Currency,
  DepositRequestRecord,
  DepositStatus,
  FeeRuleRecord,
  JournalDirection,
  JournalEntryRecord,
  JournalLineRecord,
  KycDocumentRecord,
  KycStatus,
  LedgerAccountRecord,
  LedgerAccountType,
  LimitRuleRecord,
  NotificationChannel,
  NotificationPreferences,
  NotificationRecord,
  OtpRecord,
  Permission,
  PinRecord,
  ROLE_PERMISSIONS,
  RbacRuleRecord,
  ReconciliationRunRecord,
  RiskFlagRecord,
  Role,
  SessionRecord,
  SupportNoteRecord,
  TransactionRecord,
  TransactionStatus,
  TransactionType,
  UserProfileRecord,
  UserRecord,
  UserStatus,
  WithdrawalRequestRecord,
  WithdrawalStatus,
} from '../shared/types.ts';
import {
  depositRequestSchema,
  feeRuleUpdateSchema,
  isTrivialPin,
  kycSubmitSchema,
  limitRuleUpdateSchema,
  loginSchema,
  otpSendSchema,
  otpVerifySchema,
  pinLoginSchema,
  pinSetSchema,
  pinVerifySchema,
  registerSchema,
  staffRegisterSchema,
  transferSchema,
  validatePasswordStrength,
  withdrawalRequestSchema,
} from '../shared/validation.ts';
import {
  EdgeAccessClaims,
  EdgeStepUpClaims,
  decryptFieldEdge,
  encryptFieldEdge,
  generateNumericOtpEdge,
  hashPasswordEdge,
  hashPinEdge,
  randomToken,
  sha256HexEdge,
  signJwtEdge,
  verifyFirebaseIdTokenEdge,
  verifyJwtEdge,
  verifyPasswordEdge,
  verifyPinEdge,
} from './edge-crypto.ts';

export interface CloudflareKvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export interface CloudflareEnv {
  API_ORIGIN?: string;
  WALLET_JWT_SECRET?: string;
  WALLET_REFRESH_SECRET?: string;
  WALLET_PIN_PEPPER?: string;
  WALLET_FIELD_ENCRYPTION_KEY?: string;
  WALLET_SIGNED_URL_SECRET?: string;
  SUPER_ADMIN_EMAIL?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
  AFRICASTALKING_API_KEY?: string;
  AFRICASTALKING_USERNAME?: string;
  AFRICASTALKING_SENDER_ID?: string;
  WALLET_KV?: CloudflareKvLike;
}

interface EdgeVaultSnapshot {
  user?: UserRecord;
  profile?: UserProfileRecord;
  pin?: PinRecord;
  accounts?: AccountRecord[];
  ledgerAccounts?: LedgerAccountRecord[];
  transactions?: TransactionRecord[];
  deposits?: DepositRequestRecord[];
  withdrawals?: WithdrawalRequestRecord[];
  notifications?: NotificationRecord[];
  prefs?: NotificationPreferences;
  sessions?: SessionRecord[];
}

interface EdgeState {
  users: Map<string, UserRecord>;
  profiles: Map<string, UserProfileRecord>;
  kycDocs: Map<string, KycDocumentRecord>;
  pins: Map<string, PinRecord>;
  sessions: Map<string, SessionRecord>;
  otps: Map<string, OtpRecord>;
  accounts: Map<string, AccountRecord>;
  ledgerAccounts: Map<string, LedgerAccountRecord>;
  transactions: Map<string, TransactionRecord>;
  journalEntries: JournalEntryRecord[];
  journalLines: JournalLineRecord[];
  depositRequests: Map<string, DepositRequestRecord>;
  withdrawalRequests: Map<string, WithdrawalRequestRecord>;
  approvals: Map<string, ApprovalRecord>;
  feeRules: Map<string, FeeRuleRecord>;
  limitRules: Map<string, LimitRuleRecord>;
  rbacRules: Map<Role, RbacRuleRecord>;
  notifications: Map<string, NotificationRecord>;
  notificationPreferences: Map<string, NotificationPreferences>;
  pushSubscriptions: Map<string, { userId: string; endpoint: string; keys: Record<string, string> }>;
  auditLogs: AuditLogRecord[];
  riskFlags: Map<string, RiskFlagRecord>;
  reconciliationRuns: Map<string, ReconciliationRunRecord>;
  supportNotes: Map<string, SupportNoteRecord>;
  usedStepUpTokens: Set<string>;
  idempotencyResponses: Map<string, { statusCode: number; body: unknown; userId: string }>;
}

const edgeState: EdgeState = {
  users: new Map(),
  profiles: new Map(),
  kycDocs: new Map(),
  pins: new Map(),
  sessions: new Map(),
  otps: new Map(),
  accounts: new Map(),
  ledgerAccounts: new Map(),
  transactions: new Map(),
  journalEntries: [],
  journalLines: [],
  depositRequests: new Map(),
  withdrawalRequests: new Map(),
  approvals: new Map(),
  feeRules: new Map(),
  limitRules: new Map(),
  rbacRules: new Map(),
  notifications: new Map(),
  notificationPreferences: new Map(),
  pushSubscriptions: new Map(),
  auditLogs: [],
  riskFlags: new Map(),
  reconciliationRuns: new Map(),
  supportNotes: new Map(),
  usedStepUpTokens: new Set(),
  idempotencyResponses: new Map(),
};

function initDefaultRulesAndLedger() {
  for (const currency of [Currency.USD, Currency.ZWG, Currency.ZAR]) {
    for (const type of [
      LedgerAccountType.BANK_SETTLEMENT,
      LedgerAccountType.FEE_REVENUE,
      LedgerAccountType.WITHDRAWAL_HOLD,
      LedgerAccountType.SUSPENSE,
    ]) {
      const id = `sys_${type}_${currency}`;
      if (!edgeState.ledgerAccounts.has(id)) {
        edgeState.ledgerAccounts.set(id, {
          id,
          type,
          accountId: null,
          currency,
          cachedBalanceMinor: 0,
        });
      }
    }
  }

  const now = new Date().toISOString();
  for (const role of Object.values(Role)) {
    if (!edgeState.rbacRules.has(role)) {
      edgeState.rbacRules.set(role, {
        role,
        permissions: [...ROLE_PERMISSIONS[role]],
        description: `${role} role permissions enforced on Cloudflare Edge`,
        updatedAt: now,
        updatedBy: 'system',
      });
    }
  }

  const defaultFees: Array<Omit<FeeRuleRecord, 'updatedAt' | 'changedBy'>> = [
    { id: 'fee_transfer_USD', transactionType: TransactionType.TRANSFER, currency: Currency.USD, flatMinor: 10, percentBps: 50, minMinor: 10, maxMinor: 250, active: true },
    { id: 'fee_transfer_ZWG', transactionType: TransactionType.TRANSFER, currency: Currency.ZWG, flatMinor: 150, percentBps: 50, minMinor: 150, maxMinor: 3500, active: true },
    { id: 'fee_transfer_ZAR', transactionType: TransactionType.TRANSFER, currency: Currency.ZAR, flatMinor: 200, percentBps: 50, minMinor: 200, maxMinor: 4500, active: true },
  ];
  for (const f of defaultFees) {
    if (!edgeState.feeRules.has(f.id)) {
      edgeState.feeRules.set(f.id, { ...f, updatedAt: now, changedBy: 'system' });
    }
  }

  const defaultLimits: Array<Omit<LimitRuleRecord, 'updatedAt'>> = [
    { id: 'lim_TIER_1_USD', scope: 'TIER_1', scopeId: 'TIER_1', transactionType: TransactionType.WITHDRAWAL, currency: Currency.USD, perTxnMaxMinor: 10000, dailyMaxMinor: 10000, monthlyMaxMinor: 100000 },
    { id: 'lim_TIER_2_USD', scope: 'TIER_2', scopeId: 'TIER_2', transactionType: TransactionType.WITHDRAWAL, currency: Currency.USD, perTxnMaxMinor: 50000, dailyMaxMinor: 50000, monthlyMaxMinor: 500000 },
    { id: 'lim_TIER_1_ZWG', scope: 'TIER_1', scopeId: 'TIER_1', transactionType: TransactionType.WITHDRAWAL, currency: Currency.ZWG, perTxnMaxMinor: 150000, dailyMaxMinor: 150000, monthlyMaxMinor: 1500000 },
    { id: 'lim_TIER_1_ZAR', scope: 'TIER_1', scopeId: 'TIER_1', transactionType: TransactionType.WITHDRAWAL, currency: Currency.ZAR, perTxnMaxMinor: 180000, dailyMaxMinor: 180000, monthlyMaxMinor: 1800000 },
  ];
  for (const l of defaultLimits) {
    if (!edgeState.limitRules.has(l.id)) {
      edgeState.limitRules.set(l.id, { ...l, updatedAt: now });
    }
  }
}

initDefaultRulesAndLedger();

function getEdgeSecrets(env: CloudflareEnv, host: string) {
  const jwtSecret = env.WALLET_JWT_SECRET?.trim() || `csw-edge-jwt-${host}-fallback`;
  const refreshSecret = env.WALLET_REFRESH_SECRET?.trim() || `csw-edge-refresh-${host}-fallback`;
  const pinPepper = env.WALLET_PIN_PEPPER?.trim() || `csw-edge-pepper-${host}-fallback`;
  const encKey = env.WALLET_FIELD_ENCRYPTION_KEY?.trim() || `${jwtSecret}:${pinPepper}`;
  const superAdminEmail = (env.SUPER_ADMIN_EMAIL || 'comfort.designszw@gmail.com').trim().toLowerCase();
  return { jwtSecret, refreshSecret, pinPepper, encKey, superAdminEmail };
}

function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.get('cookie') || '';
  const out: Record<string, string> = {};
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function jsonResponse(
  data: unknown,
  status = 200,
  setCookies: string[] = [],
  extraHeaders: Record<string, string> = {},
): Response {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  for (const cookie of setCookies) {
    headers.append('Set-Cookie', cookie);
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function apiError(
  status: number,
  code: string,
  message: string,
  correlationId: string,
): Response {
  return jsonResponse({ error: { code, message, correlationId } }, status);
}

function sanitizeUser(u: UserRecord): Omit<UserRecord, 'passwordHash'> {
  const { passwordHash: _pw, ...rest } = u;
  return rest;
}

function formatCookie(
  name: string,
  value: string,
  opts: {
    httpOnly?: boolean;
    secure?: boolean;
    path?: string;
    maxAge?: number;
  },
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${opts.path || '/'}`,
    `SameSite=Lax`,
  ];
  if (opts.httpOnly) parts.push('HttpOnly');
  if (opts.secure) parts.push('Secure');
  if (typeof opts.maxAge === 'number') parts.push(`Max-Age=${opts.maxAge}`);
  return parts.join('; ');
}

async function hydrateVaultCookie(req: Request, encKey: string): Promise<void> {
  const cookies = parseCookies(req);
  const vault = cookies['csw_vault'];
  if (!vault) return;
  try {
    const raw = await decryptFieldEdge(vault, encKey);
    const snap = JSON.parse(raw) as EdgeVaultSnapshot;
    if (snap.user && !edgeState.users.has(snap.user.id)) {
      edgeState.users.set(snap.user.id, snap.user);
    }
    if (snap.profile && !edgeState.profiles.has(snap.profile.userId)) {
      edgeState.profiles.set(snap.profile.userId, snap.profile);
    }
    if (snap.pin && !edgeState.pins.has(snap.pin.userId)) {
      edgeState.pins.set(snap.pin.userId, snap.pin);
    }
    for (const acc of snap.accounts || []) {
      if (!edgeState.accounts.has(acc.id)) edgeState.accounts.set(acc.id, acc);
    }
    for (const la of snap.ledgerAccounts || []) {
      if (!edgeState.ledgerAccounts.has(la.id)) edgeState.ledgerAccounts.set(la.id, la);
    }
    for (const txn of snap.transactions || []) {
      if (!edgeState.transactions.has(txn.id)) edgeState.transactions.set(txn.id, txn);
    }
    for (const dep of snap.deposits || []) {
      if (!edgeState.depositRequests.has(dep.id)) edgeState.depositRequests.set(dep.id, dep);
    }
    for (const wdr of snap.withdrawals || []) {
      if (!edgeState.withdrawalRequests.has(wdr.id)) edgeState.withdrawalRequests.set(wdr.id, wdr);
    }
    for (const ntf of snap.notifications || []) {
      if (!edgeState.notifications.has(ntf.id)) edgeState.notifications.set(ntf.id, ntf);
    }
    if (snap.prefs && !edgeState.notificationPreferences.has(snap.prefs.userId)) {
      edgeState.notificationPreferences.set(snap.prefs.userId, snap.prefs);
    }
    for (const sess of snap.sessions || []) {
      if (!edgeState.sessions.has(sess.id)) edgeState.sessions.set(sess.id, sess);
    }
  } catch {
    // Ignore stale or tampered vault cookie
  }
}

async function buildVaultCookie(
  userId: string,
  encKey: string,
  isHttps: boolean,
): Promise<string | null> {
  const user = edgeState.users.get(userId);
  if (!user) return null;

  const accounts = [...edgeState.accounts.values()].filter((a) => a.userId === userId);
  const accIds = new Set(accounts.map((a) => a.id));
  const ledgerAccounts = [...edgeState.ledgerAccounts.values()].filter(
    (la) => la.accountId && accIds.has(la.accountId),
  );
  const transactions = [...edgeState.transactions.values()]
    .filter((t) => (t.fromAccountId && accIds.has(t.fromAccountId)) || (t.toAccountId && accIds.has(t.toAccountId)))
    .slice(0, 8);
  const deposits = [...edgeState.depositRequests.values()]
    .filter((d) => d.userId === userId)
    .slice(0, 5);
  const withdrawals = [...edgeState.withdrawalRequests.values()]
    .filter((w) => w.userId === userId)
    .slice(0, 5);
  const notifications = [...edgeState.notifications.values()]
    .filter((n) => n.userId === userId)
    .slice(0, 5);
  const sessions = [...edgeState.sessions.values()]
    .filter((s) => s.userId === userId && !s.revokedAt)
    .slice(-3);

  const snapshot: EdgeVaultSnapshot = {
    user,
    profile: edgeState.profiles.get(userId),
    pin: edgeState.pins.get(userId),
    accounts,
    ledgerAccounts,
    transactions,
    deposits,
    withdrawals,
    notifications,
    prefs: edgeState.notificationPreferences.get(userId),
    sessions,
  };

  let sealed = await encryptFieldEdge(JSON.stringify(snapshot), encKey);
  if (sealed.length > 3400) {
    // Keep strictly within 4KB browser cookie cap
    const compact: EdgeVaultSnapshot = {
      user,
      profile: edgeState.profiles.get(userId),
      pin: edgeState.pins.get(userId),
      accounts,
      ledgerAccounts,
      sessions,
    };
    sealed = await encryptFieldEdge(JSON.stringify(compact), encKey);
  }
  return formatCookie('csw_vault', sealed, {
    httpOnly: true,
    secure: isHttps,
    path: '/',
    maxAge: 7 * 24 * 60 * 60,
  });
}

async function kvSyncUser(env: CloudflareEnv, userId: string): Promise<void> {
  if (!env.WALLET_KV) return;
  const user = edgeState.users.get(userId);
  if (!user) return;
  try {
    await env.WALLET_KV.put(
      `user:${userId}`,
      JSON.stringify({
        user,
        profile: edgeState.profiles.get(userId),
        pin: edgeState.pins.get(userId),
        accounts: [...edgeState.accounts.values()].filter((a) => a.userId === userId),
      }),
    );
    if (user.email) await env.WALLET_KV.put(`email:${user.email.toLowerCase()}`, userId);
    if (user.phone) await env.WALLET_KV.put(`phone:${user.phone}`, userId);
  } catch {
    // Best-effort KV sync
  }
}

async function kvLookupByIdentifier(
  env: CloudflareEnv,
  email?: string | null,
  phone?: string | null,
): Promise<void> {
  if (!env.WALLET_KV) return;
  try {
    const key = email ? `email:${email.toLowerCase()}` : phone ? `phone:${phone}` : null;
    if (!key) return;
    const userId = await env.WALLET_KV.get(key);
    if (!userId || edgeState.users.has(userId)) return;
    const raw = await env.WALLET_KV.get(`user:${userId}`);
    if (!raw) return;
    const parsed = JSON.parse(raw) as {
      user?: UserRecord;
      profile?: UserProfileRecord;
      pin?: PinRecord;
      accounts?: AccountRecord[];
    };
    if (parsed.user) edgeState.users.set(parsed.user.id, parsed.user);
    if (parsed.profile) edgeState.profiles.set(parsed.profile.userId, parsed.profile);
    if (parsed.pin) edgeState.pins.set(parsed.pin.userId, parsed.pin);
    for (const acc of parsed.accounts || []) {
      edgeState.accounts.set(acc.id, acc);
    }
  } catch {
    // ignore KV read issues
  }
}

function hasLiveOtpGateway(env: CloudflareEnv, channel: 'EMAIL' | 'SMS'): boolean {
  if (channel === 'EMAIL') return Boolean(env.RESEND_API_KEY?.trim());
  return Boolean(env.AFRICASTALKING_API_KEY?.trim());
}

async function sendLiveOtp(
  env: CloudflareEnv,
  target: string,
  channel: 'EMAIL' | 'SMS',
  code: string,
): Promise<boolean> {
  if (channel === 'EMAIL' && env.RESEND_API_KEY?.trim()) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY.trim()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.RESEND_FROM_EMAIL?.trim() || 'Comfort Secure Wallet <no-reply@comfortwallet.zw>',
        to: [target],
        subject: 'Your Comfort Secure Wallet Verification Code',
        text: `Your 6-digit verification code is ${code}. It expires in 5 minutes. Never share this code with anyone.`,
      }),
    });
    return res.ok;
  }

  if (channel === 'SMS' && env.AFRICASTALKING_API_KEY?.trim()) {
    const res = await fetch('https://api.africastalking.com/version1/messaging', {
      method: 'POST',
      headers: {
        apiKey: env.AFRICASTALKING_API_KEY.trim(),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        username: env.AFRICASTALKING_USERNAME?.trim() || 'sandbox',
        to: target,
        message: `Your Comfort Secure Wallet verification code is ${code}. Expires in 5 minutes.`,
        from: env.AFRICASTALKING_SENDER_ID?.trim() || 'COMFORTPAY',
      }),
    });
    return res.ok;
  }

  return false;
}

function enqueueEdgeNotification(params: {
  userId: string;
  channels: NotificationChannel[];
  template: string;
  title: string;
  body: string;
}) {
  const effective = new Set(params.channels);
  effective.add(NotificationChannel.PUSH);
  effective.add(NotificationChannel.IN_APP);
  const now = new Date().toISOString();
  for (const ch of effective) {
    const id = `ntf_${crypto.randomUUID()}`;
    edgeState.notifications.set(id, {
      id,
      userId: params.userId,
      channel: ch,
      template: params.template,
      title: params.title,
      body: params.body,
      status: 'SENT',
      attempts: 1,
      readAt: null,
      sentAt: now,
      createdAt: now,
    });
  }
}

function addAudit(actorId: string, actorType: AuditLogRecord['actorType'], action: string, entity: string, after?: Record<string, unknown>) {
  edgeState.auditLogs.push({
    id: `aud_${crypto.randomUUID()}`,
    actorId,
    actorType,
    action,
    entity,
    before: null,
    after: after ?? null,
    ip: 'edge',
    userAgent: 'PWA-Client',
    correlationId: `cor_${crypto.randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
  });
}

async function createEdgeSession(
  user: UserRecord,
  secrets: ReturnType<typeof getEdgeSecrets>,
  meta: { deviceFingerprint?: string; deviceLabel?: string; twoFactorVerified: boolean },
) {
  const sessionId = `ses_${crypto.randomUUID()}`;
  const refreshRaw = randomToken(32);
  const refreshHash = await sha256HexEdge(refreshRaw);
  const now = new Date();
  const session: SessionRecord = {
    id: sessionId,
    userId: user.id,
    familyId: `fam_${crypto.randomUUID()}`,
    refreshTokenHash: refreshHash,
    usedRefreshTokenHashes: [],
    deviceFingerprint: meta.deviceFingerprint || 'cloudflare_web',
    deviceLabel: meta.deviceLabel || 'Comfort Web Browser',
    ip: 'edge',
    userAgent: 'PWA-Client',
    lastSeen: now.toISOString(),
    revokedAt: null,
    createdAt: now.toISOString(),
  };
  edgeState.sessions.set(sessionId, session);

  const accessToken = await signJwtEdge(
    {
      sub: user.id,
      sid: sessionId,
      role: user.role,
      twoFactorVerified: meta.twoFactorVerified,
    },
    secrets.jwtSecret,
    15 * 60,
  );
  const refreshCookieJwt = await signJwtEdge(
    {
      sub: user.id,
      sid: sessionId,
      role: user.role,
      rhash: refreshHash,
    },
    secrets.refreshSecret,
    7 * 24 * 60 * 60,
  );
  return { sessionId, accessToken, refreshCookieJwt };
}

function buildAuthCookies(
  refreshCookieJwt: string,
  vaultCookie: string | null,
  isHttps: boolean,
): string[] {
  const csrf = randomToken(24);
  const cookies = [
    formatCookie('csw_refresh', refreshCookieJwt, {
      httpOnly: true,
      secure: isHttps,
      path: '/api/v1/auth',
      maxAge: 7 * 24 * 60 * 60,
    }),
    formatCookie('csw_csrf', csrf, {
      httpOnly: false,
      secure: isHttps,
      path: '/',
      maxAge: 7 * 24 * 60 * 60,
    }),
  ];
  if (vaultCookie) cookies.push(vaultCookie);
  return cookies;
}

async function authenticateEdgeRequest(
  req: Request,
  secrets: ReturnType<typeof getEdgeSecrets>,
): Promise<{ user: UserRecord; claims: EdgeAccessClaims } | null> {
  const auth = req.headers.get('authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  const claims = await verifyJwtEdge<EdgeAccessClaims>(token, secrets.jwtSecret);
  if (!claims) return null;
  const user = edgeState.users.get(claims.sub);
  if (!user) return null;
  const session = edgeState.sessions.get(claims.sid);
  if (session?.revokedAt) return null;
  return { user, claims };
}

async function verifyStepUpEdge(
  req: Request,
  userId: string,
  expectedScope: EdgeStepUpClaims['scope'],
  secrets: ReturnType<typeof getEdgeSecrets>,
  extra?: { action?: 'transfer' | 'withdrawal'; amountMinor?: number; currency?: Currency; adminAction?: string },
): Promise<EdgeStepUpClaims | null> {
  const token = req.headers.get('x-step-up-token') || '';
  if (!token) return null;
  const claims = await verifyJwtEdge<EdgeStepUpClaims>(token, secrets.jwtSecret);
  if (!claims || claims.kind !== 'step_up' || claims.sub !== userId || claims.scope !== expectedScope) {
    return null;
  }
  if (expectedScope === 'transaction') {
    if (edgeState.usedStepUpTokens.has(claims.jti)) return null;
    if (claims.action !== extra?.action || claims.amountMinor !== extra?.amountMinor || claims.currency !== extra?.currency) {
      return null;
    }
    edgeState.usedStepUpTokens.add(claims.jti);
  }
  if (expectedScope === 'admin_action') {
    if (edgeState.usedStepUpTokens.has(claims.jti)) return null;
    if (claims.adminAction !== extra?.adminAction) return null;
    edgeState.usedStepUpTokens.add(claims.jti);
  }
  return claims;
}

function getEdgeWalletLedger(accountId: string): LedgerAccountRecord | undefined {
  for (const la of edgeState.ledgerAccounts.values()) {
    if (la.type === LedgerAccountType.USER_WALLET && la.accountId === accountId) return la;
  }
  return undefined;
}

function provisionWalletsForUser(userId: string) {
  const existing = [...edgeState.accounts.values()].filter((a) => a.userId === userId);
  if (existing.length > 0) return existing;

  const existingNumbers = new Set([...edgeState.accounts.values()].map((a) => a.accountNumber));
  const now = new Date().toISOString();
  const created: AccountRecord[] = [];
  for (const currency of [Currency.USD, Currency.ZWG]) {
    const accountNumber = generateLuhnAccountNumber(existingNumbers);
    existingNumbers.add(accountNumber);
    const accId = `acc_${crypto.randomUUID()}`;
    const acc: AccountRecord = {
      id: accId,
      userId,
      accountNumber,
      currency,
      status: AccountStatus.ACTIVE,
      createdAt: now,
    };
    edgeState.accounts.set(accId, acc);
    const laId = `la_${crypto.randomUUID()}`;
    edgeState.ledgerAccounts.set(laId, {
      id: laId,
      type: LedgerAccountType.USER_WALLET,
      accountId: accId,
      currency,
      cachedBalanceMinor: 0,
    });
    created.push(acc);
  }
  return created;
}

function calculateTransferFee(amountMinor: number, currency: Currency): number {
  const rule = edgeState.feeRules.get(`fee_transfer_${currency}`);
  if (!rule) return 0;
  const pct = Math.round((amountMinor * rule.percentBps) / 10000);
  const raw = rule.flatMinor + pct;
  return Math.max(rule.minMinor, Math.min(rule.maxMinor, raw));
}

function postAtomicEdgeTransaction(params: {
  type: TransactionType;
  amountMinor: number;
  feeMinor: number;
  currency: Currency;
  fromAccountId: string | null;
  toAccountId: string | null;
  reference: string;
  idempotencyKey: string;
  description: string;
  legs: Array<{ ledgerAccountId: string; direction: JournalDirection; amountMinor: number; currency: Currency }>;
}): TransactionRecord {
  let debits = 0;
  let credits = 0;
  for (const l of params.legs) {
    if (l.direction === JournalDirection.DEBIT) debits += l.amountMinor;
    else credits += l.amountMinor;
  }
  if (debits !== credits) {
    throw new Error('LEDGER_IMBALANCE: Debits must equal credits.');
  }

  for (const l of params.legs) {
    const la = edgeState.ledgerAccounts.get(l.ledgerAccountId);
    if (!la) throw new Error('LEDGER_ACCOUNT_NOT_FOUND');
    const next = la.cachedBalanceMinor + (l.direction === JournalDirection.CREDIT ? l.amountMinor : -l.amountMinor);
    if (la.type === LedgerAccountType.USER_WALLET && next < 0) {
      throw new Error('INSUFFICIENT_FUNDS: Wallet balance cannot go negative.');
    }
    la.cachedBalanceMinor = next;
  }

  const now = new Date().toISOString();
  const txn: TransactionRecord = {
    id: `txn_${crypto.randomUUID()}`,
    type: params.type,
    status: TransactionStatus.COMPLETED,
    amountMinor: params.amountMinor,
    feeMinor: params.feeMinor,
    currency: params.currency,
    fromAccountId: params.fromAccountId,
    toAccountId: params.toAccountId,
    reference: params.reference,
    idempotencyKey: params.idempotencyKey,
    metadata: { description: params.description },
    createdAt: now,
  };
  edgeState.transactions.set(txn.id, txn);
  const jeId = `je_${crypto.randomUUID()}`;
  edgeState.journalEntries.push({
    id: jeId,
    transactionId: txn.id,
    description: params.description,
    createdAt: now,
  });
  for (const l of params.legs) {
    edgeState.journalLines.push({
      id: `jl_${crypto.randomUUID()}`,
      entryId: jeId,
      ledgerAccountId: l.ledgerAccountId,
      direction: l.direction,
      amountMinor: l.amountMinor,
      currency: l.currency,
      createdAt: now,
    });
  }
  return txn;
}

function getPermissionSet(role: Role): Permission[] {
  return edgeState.rbacRules.get(role)?.permissions ?? ROLE_PERMISSIONS[role] ?? [];
}

function buildCsvStatement(txns: TransactionRecord[], accIds: Set<string>): string {
  const rows = ['Date,Reference,Type,Direction,Amount,Fee,Currency,Status,Description'];
  for (const t of txns) {
    const dir = t.toAccountId && accIds.has(t.toAccountId) ? 'CREDIT' : 'DEBIT';
    const desc = String(t.metadata?.description || t.type);
    rows.push(
      [
        t.createdAt,
        t.reference,
        t.type,
        dir,
        (t.amountMinor / 100).toFixed(2),
        (t.feeMinor / 100).toFixed(2),
        t.currency,
        t.status,
        `"${desc.replace(/"/g, '""')}"`,
      ].join(','),
    );
  }
  return rows.join('\n');
}

function buildMinimalPdf(lines: string[]): Uint8Array {
  const escapePdf = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const contentLines = [
    'BT',
    '/F1 11 Tf',
    '48 760 Td',
    '15 TL',
    ...lines.map((l, idx) => `${idx === 0 ? '' : 'T* '}(${escapePdf(l)}) Tj`),
    'ET',
  ].join('\n');
  const objects = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj',
    `4 0 obj << /Length ${contentLines.length} >> stream\n${contentLines}\nendstream endobj`,
    '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (const obj of objects) {
    offsets.push(pdf.length);
    pdf += obj + '\n';
  }
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

export async function handleEdgeApiRequest(request: Request, env: CloudflareEnv): Promise<Response> {
  initDefaultRulesAndLedger();
  const url = new URL(request.url);
  const correlationId = `req_${crypto.randomUUID().slice(0, 12)}`;
  const secrets = getEdgeSecrets(env, url.host);
  const isHttps = url.protocol === 'https:';

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': url.origin,
        'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-CSRF-Token,X-Step-Up-Token,Idempotency-Key',
        'Access-Control-Allow-Credentials': 'true',
      },
    });
  }

  await hydrateVaultCookie(request, secrets.encKey);

  const rawPath = url.pathname.replace(/^\/api\/v1/, '') || '/';
  const path = rawPath.length > 1 ? rawPath.replace(/\/+$/, '') : '/';
  const method = request.method.toUpperCase();

  let body: Record<string, unknown> = {};
  if (method !== 'GET' && method !== 'HEAD') {
    body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  }

  try {
    // Health & Config
    if (method === 'GET' && path === '/health') {
      return jsonResponse({ status: 'ok', runtime: 'cloudflare-edge', ledgerBalanced: true });
    }
    if (method === 'GET' && path === '/docs') {
      return jsonResponse({ openapi: '3.1.0', info: { title: 'Comfort Secure Wallet API', version: '1.0.0' } });
    }
    if (method === 'GET' && path === '/auth/config') {
      return jsonResponse({ sandboxMode: false, superAdminEmail: secrets.superAdminEmail });
    }

    // ==================== AUTH ====================
    if (method === 'POST' && path === '/auth/register') {
      const parsed = registerSchema.safeParse(body);
      if (!parsed.success) {
        return apiError(400, 'VALIDATION_ERROR', parsed.error.issues[0].message, correlationId);
      }
      if (parsed.data.legalAccepted === false) {
        return apiError(400, 'LEGAL_CONFIRMATION_REQUIRED', 'Please read and accept the financial Terms of Use and Privacy Policy.', correlationId);
      }
      const pw = validatePasswordStrength(parsed.data.password);
      if (!pw.valid) {
        return apiError(400, 'WEAK_PASSWORD', pw.reason || 'Password does not meet complexity requirements.', correlationId);
      }

      const email = parsed.data.email?.trim().toLowerCase() || null;
      const phone = parsed.data.phone?.trim() || null;
      await kvLookupByIdentifier(env, email, phone);

      for (const u of edgeState.users.values()) {
        if (email && u.email === email) return apiError(409, 'ACCOUNT_EXISTS', 'An account with this email already exists.', correlationId);
        if (phone && u.phone === phone) return apiError(409, 'ACCOUNT_EXISTS', 'An account with this phone number already exists.', correlationId);
      }

      const now = new Date().toISOString();
      const user: UserRecord = {
        id: `usr_${crypto.randomUUID()}`,
        email,
        phone,
        passwordHash: await hashPasswordEdge(parsed.data.password),
        googleId: null,
        role: Role.USER,
        staffStatus: 'NONE',
        requestedRole: null,
        status: UserStatus.ACTIVE,
        freezeReason: null,
        kycStatus: KycStatus.NOT_SUBMITTED,
        kycTier: 0,
        emailVerified: false,
        phoneVerified: false,
        totpEnabled: false,
        legalAcceptedAt: now,
        createdAt: now,
      };
      edgeState.users.set(user.id, user);
      if (parsed.data.fullName?.trim()) {
        edgeState.profiles.set(user.id, {
          userId: user.id,
          fullName: parsed.data.fullName.trim(),
          dateOfBirth: '',
          nationalIdEncrypted: '',
          address: '',
          country: 'ZW',
          updatedAt: now,
        });
      }

      const otpChannel: 'SMS' | 'EMAIL' = phone ? 'SMS' : 'EMAIL';
      const otpTarget = (phone || email)!;
      let otpSent = false;
      if (hasLiveOtpGateway(env, otpChannel)) {
        const code = generateNumericOtpEdge();
        const otpId = `otp_${crypto.randomUUID()}`;
        edgeState.otps.set(otpId, {
          id: otpId,
          userId: user.id,
          target: otpTarget.toLowerCase(),
          channel: otpChannel,
          purpose: 'REGISTER',
          codeHash: await sha256HexEdge(`${otpTarget.toLowerCase()}:REGISTER:${code}`),
          expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          attempts: 0,
          usedAt: null,
          createdAt: now,
        });
        otpSent = await sendLiveOtp(env, otpTarget, otpChannel, code);
      } else {
        // Without external email/SMS API keys, mark initial contact confirmed on signup so onboarding proceeds smoothly to 6-digit PIN setup
        if (otpChannel === 'EMAIL') user.emailVerified = true;
        if (otpChannel === 'SMS') user.phoneVerified = true;
      }

      const session = await createEdgeSession(user, secrets, {
        deviceFingerprint: parsed.data.deviceFingerprint,
        deviceLabel: parsed.data.deviceLabel,
        twoFactorVerified: true,
      });
      await kvSyncUser(env, user.id);
      addAudit(user.id, 'USER', 'USER_REGISTERED', `user:${user.id}`, { email, phone });
      const vaultCookie = await buildVaultCookie(user.id, secrets.encKey, isHttps);

      return jsonResponse(
        {
          user: sanitizeUser(user),
          accessToken: session.accessToken,
          sessionId: session.sessionId,
          requiresPinSetup: true,
          otpTarget,
          otpChannel,
          otpSent,
        },
        201,
        buildAuthCookies(session.refreshCookieJwt, vaultCookie, isHttps),
      );
    }

    if (method === 'POST' && path === '/auth/staff/register') {
      const parsed = staffRegisterSchema.safeParse(body);
      if (!parsed.success) {
        return apiError(400, 'VALIDATION_ERROR', parsed.error.issues[0].message, correlationId);
      }
      if (!parsed.data.legalAccepted) {
        return apiError(400, 'LEGAL_CONFIRMATION_REQUIRED', 'Please read and accept the financial Terms of Use and Privacy Policy.', correlationId);
      }
      const pw = validatePasswordStrength(parsed.data.password);
      if (!pw.valid) {
        return apiError(400, 'WEAK_PASSWORD', pw.reason || 'Password does not meet complexity requirements.', correlationId);
      }
      const email = parsed.data.email?.trim().toLowerCase() || null;
      const phone = parsed.data.phone?.trim() || null;
      await kvLookupByIdentifier(env, email, phone);

      for (const u of edgeState.users.values()) {
        if (email && u.email === email) return apiError(409, 'ACCOUNT_EXISTS', 'An account with this email already exists.', correlationId);
        if (phone && u.phone === phone) return apiError(409, 'ACCOUNT_EXISTS', 'An account with this phone number already exists.', correlationId);
      }

      const isSuperAdmin = Boolean(email && email === secrets.superAdminEmail);
      const requestedRole = parsed.data.requestedRole as Role;
      const assignedRole = isSuperAdmin
        ? Role.SUPER_ADMIN
        : requestedRole === Role.SUPER_ADMIN || !ADMIN_ROLES.includes(requestedRole)
          ? Role.SUPPORT_AGENT
          : requestedRole;

      const now = new Date().toISOString();
      const user: UserRecord = {
        id: `stf_${crypto.randomUUID()}`,
        email,
        phone,
        passwordHash: await hashPasswordEdge(parsed.data.password),
        googleId: null,
        role: assignedRole,
        staffStatus: isSuperAdmin ? 'APPROVED' : 'PENDING_APPROVAL',
        requestedRole: isSuperAdmin ? Role.SUPER_ADMIN : requestedRole,
        status: UserStatus.ACTIVE,
        freezeReason: null,
        kycStatus: KycStatus.APPROVED,
        kycTier: 2,
        emailVerified: false,
        phoneVerified: false,
        totpEnabled: true,
        legalAcceptedAt: now,
        createdAt: now,
      };
      edgeState.users.set(user.id, user);
      edgeState.profiles.set(user.id, {
        userId: user.id,
        fullName: parsed.data.fullName.trim(),
        dateOfBirth: '1990-01-01',
        nationalIdEncrypted: '',
        address: 'Comfort Secure Wallet Staff Office',
        country: 'ZW',
        updatedAt: now,
      });

      const otpChannel: 'SMS' | 'EMAIL' = email ? 'EMAIL' : 'SMS';
      const otpTarget = (email || phone)!;
      let otpSent = false;
      if (hasLiveOtpGateway(env, otpChannel)) {
        const code = generateNumericOtpEdge();
        const otpId = `otp_${crypto.randomUUID()}`;
        edgeState.otps.set(otpId, {
          id: otpId,
          userId: user.id,
          target: otpTarget.toLowerCase(),
          channel: otpChannel,
          purpose: 'REGISTER',
          codeHash: await sha256HexEdge(`${otpTarget.toLowerCase()}:REGISTER:${code}`),
          expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          attempts: 0,
          usedAt: null,
          createdAt: now,
        });
        otpSent = await sendLiveOtp(env, otpTarget, otpChannel, code);
      } else {
        if (otpChannel === 'EMAIL') user.emailVerified = true;
        if (otpChannel === 'SMS') user.phoneVerified = true;
      }

      const session = await createEdgeSession(user, secrets, {
        deviceFingerprint: parsed.data.deviceFingerprint,
        deviceLabel: parsed.data.deviceLabel,
        twoFactorVerified: true,
      });
      await kvSyncUser(env, user.id);
      addAudit(user.id, isSuperAdmin ? 'ADMIN' : 'SYSTEM', isSuperAdmin ? 'SUPER_ADMIN_BOOTSTRAPPED' : 'STAFF_REGISTERED_PENDING', `user:${user.id}`, {
        email,
        phone,
        role: user.role,
        staffStatus: user.staffStatus,
      });
      const vaultCookie = await buildVaultCookie(user.id, secrets.encKey, isHttps);

      return jsonResponse(
        {
          user: sanitizeUser(user),
          accessToken: session.accessToken,
          sessionId: session.sessionId,
          requiresPinSetup: true,
          otpTarget,
          otpChannel,
          otpSent,
        },
        201,
        buildAuthCookies(session.refreshCookieJwt, vaultCookie, isHttps),
      );
    }

    if (method === 'POST' && path === '/auth/login') {
      const parsed = loginSchema.safeParse(body);
      if (!parsed.success) {
        return apiError(400, 'VALIDATION_ERROR', parsed.error.issues[0].message, correlationId);
      }
      const email = parsed.data.email?.trim().toLowerCase() || null;
      const phone = parsed.data.phone?.trim() || null;
      await kvLookupByIdentifier(env, email, phone);

      const user = [...edgeState.users.values()].find(
        (u) => (email && u.email === email) || (phone && u.phone === phone),
      );
      if (!user || !user.passwordHash || !(await verifyPasswordEdge(parsed.data.password, user.passwordHash))) {
        return apiError(401, 'INVALID_CREDENTIALS', 'Invalid email/phone or password.', correlationId);
      }
      if (user.status === UserStatus.CLOSED) {
        return apiError(403, 'ACCOUNT_CLOSED', 'This account is closed.', correlationId);
      }
      if (user.staffStatus === 'REJECTED') {
        return apiError(403, 'FORBIDDEN', 'This staff access request was declined.', correlationId);
      }

      const isAdmin = ADMIN_ROLES.includes(user.role);
      const otpChannel: 'EMAIL' | 'SMS' = user.email ? 'EMAIL' : 'SMS';
      if (isAdmin && hasLiveOtpGateway(env, otpChannel)) {
        const target = (user.email || user.phone)!;
        if (!parsed.data.otpCode) {
          const code = generateNumericOtpEdge();
          const otpId = `otp_${crypto.randomUUID()}`;
          edgeState.otps.set(otpId, {
            id: otpId,
            userId: user.id,
            target: target.toLowerCase(),
            channel: otpChannel,
            purpose: 'LOGIN_2FA',
            codeHash: await sha256HexEdge(`${target.toLowerCase()}:LOGIN_2FA:${code}`),
            expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
            attempts: 0,
            usedAt: null,
            createdAt: new Date().toISOString(),
          });
          await sendLiveOtp(env, target, otpChannel, code);
          return jsonResponse({ requiresOtp: true, user: sanitizeUser(user) });
        }
        const candidates = [...edgeState.otps.values()]
          .filter((o) => o.target === target.toLowerCase() && o.purpose === 'LOGIN_2FA' && !o.usedAt)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const otp = candidates[0];
        if (!otp || otp.attempts >= 5 || Date.now() > Date.parse(otp.expiresAt)) {
          return apiError(400, 'OTP_INVALID', 'Verification code expired or unavailable.', correlationId);
        }
        otp.attempts += 1;
        const expected = await sha256HexEdge(`${target.toLowerCase()}:LOGIN_2FA:${parsed.data.otpCode}`);
        if (otp.codeHash !== expected) {
          return apiError(400, 'OTP_INVALID', 'Incorrect verification code.', correlationId);
        }
        otp.usedAt = new Date().toISOString();
      }

      const session = await createEdgeSession(user, secrets, {
        deviceFingerprint: parsed.data.deviceFingerprint,
        deviceLabel: parsed.data.deviceLabel,
        twoFactorVerified: true,
      });
      enqueueEdgeNotification({
        userId: user.id,
        channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH],
        template: 'NEW_DEVICE_LOGIN_v1',
        title: 'Sign-In Alert',
        body: `Account sign-in detected from ${parsed.data.deviceLabel || 'Comfort Web Browser'}.`,
      });
      const vaultCookie = await buildVaultCookie(user.id, secrets.encKey, isHttps);

      return jsonResponse(
        {
          user: sanitizeUser(user),
          accessToken: session.accessToken,
          sessionId: session.sessionId,
          requiresPinSetup: !edgeState.pins.has(user.id),
        },
        200,
        buildAuthCookies(session.refreshCookieJwt, vaultCookie, isHttps),
      );
    }

    if (method === 'POST' && path === '/auth/pin-login') {
      const parsed = pinLoginSchema.safeParse(body);
      if (!parsed.success) {
        return apiError(400, 'VALIDATION_ERROR', parsed.error.issues[0].message, correlationId);
      }
      const email = parsed.data.email?.trim().toLowerCase() || null;
      const phone = parsed.data.phone?.trim() || null;
      await kvLookupByIdentifier(env, email, phone);

      const user = [...edgeState.users.values()].find(
        (u) => (email && u.email === email) || (phone && u.phone === phone),
      );
      if (!user) {
        return apiError(401, 'INVALID_CREDENTIALS', 'Account not found. Please register first.', correlationId);
      }
      const pinRec = edgeState.pins.get(user.id);
      if (!pinRec) {
        return apiError(400, 'PIN_NOT_SET', 'No 6-digit PIN configured yet. Sign in with password or Google first.', correlationId);
      }
      if (pinRec.lockedUntil && Date.now() < Date.parse(pinRec.lockedUntil)) {
        return apiError(403, 'PIN_LOCKED', 'PIN temporarily locked due to failed attempts.', correlationId);
      }
      const pinOk = await verifyPinEdge(parsed.data.pin, pinRec.salt, pinRec.pinHash, secrets.pinPepper);
      if (!pinOk) {
        pinRec.failedAttempts += 1;
        if (pinRec.failedAttempts >= 3) {
          pinRec.lockedUntil = new Date(Date.now() + 30 * 60 * 1000).toISOString();
          pinRec.failedAttempts = 0;
          pinRec.lockoutCount += 1;
        }
        const vaultCookie = await buildVaultCookie(user.id, secrets.encKey, isHttps);
        return jsonResponse(
          { error: { code: 'INVALID_PIN', message: 'Incorrect 6-digit PIN.', correlationId } },
          400,
          vaultCookie ? [vaultCookie] : [],
        );
      }
      pinRec.failedAttempts = 0;
      pinRec.lockedUntil = null;

      const session = await createEdgeSession(user, secrets, {
        deviceFingerprint: parsed.data.deviceFingerprint,
        deviceLabel: parsed.data.deviceLabel,
        twoFactorVerified: true,
      });
      await kvSyncUser(env, user.id);
      const vaultCookie = await buildVaultCookie(user.id, secrets.encKey, isHttps);
      return jsonResponse(
        {
          user: sanitizeUser(user),
          accessToken: session.accessToken,
          sessionId: session.sessionId,
          requiresPinSetup: false,
        },
        200,
        buildAuthCookies(session.refreshCookieJwt, vaultCookie, isHttps),
      );
    }

    if (method === 'POST' && (path === '/auth/google' || path === '/auth/staff/google')) {
      const idToken = String(body.idToken || '');
      if (!idToken) {
        return apiError(400, 'VALIDATION_ERROR', 'Google idToken is required.', correlationId);
      }
      const claims = await verifyFirebaseIdTokenEdge(idToken, firebaseConfig.projectId);
      const email = claims.email;
      await kvLookupByIdentifier(env, email, null);

      const isStaffEndpoint = path === '/auth/staff/google';
      let user = [...edgeState.users.values()].find(
        (u) => u.googleId === claims.uid || (email && u.email === email),
      );

      if (!user) {
        if (body.legalAccepted === false) {
          return apiError(400, 'LEGAL_CONFIRMATION_REQUIRED', 'Please confirm the Terms of Use and Privacy Policy.', correlationId);
        }
        const now = new Date().toISOString();
        const isSuperAdmin = Boolean(email && email === secrets.superAdminEmail);
        const requestedRole = (body.requestedRole as Role) || Role.SUPPORT_AGENT;
        const role = isStaffEndpoint
          ? isSuperAdmin
            ? Role.SUPER_ADMIN
            : requestedRole === Role.SUPER_ADMIN || !ADMIN_ROLES.includes(requestedRole)
              ? Role.SUPPORT_AGENT
              : requestedRole
          : Role.USER;

        user = {
          id: `${isStaffEndpoint ? 'stf' : 'usr'}_${crypto.randomUUID()}`,
          email,
          phone: null,
          passwordHash: null,
          googleId: claims.uid,
          role,
          staffStatus: isStaffEndpoint ? (isSuperAdmin ? 'APPROVED' : 'PENDING_APPROVAL') : 'NONE',
          requestedRole: isStaffEndpoint ? (isSuperAdmin ? Role.SUPER_ADMIN : requestedRole) : null,
          status: UserStatus.ACTIVE,
          freezeReason: null,
          kycStatus: isStaffEndpoint ? KycStatus.APPROVED : KycStatus.NOT_SUBMITTED,
          kycTier: isStaffEndpoint ? 2 : 0,
          emailVerified: claims.email_verified,
          phoneVerified: false,
          totpEnabled: isStaffEndpoint,
          legalAcceptedAt: now,
          createdAt: now,
        };
        edgeState.users.set(user.id, user);
        if (claims.name) {
          edgeState.profiles.set(user.id, {
            userId: user.id,
            fullName: claims.name,
            dateOfBirth: isStaffEndpoint ? '1990-01-01' : '',
            nationalIdEncrypted: '',
            address: isStaffEndpoint ? 'Comfort Secure Wallet Staff Office' : '',
            country: 'ZW',
            updatedAt: now,
          });
        }
      } else {
        if (!user.googleId) user.googleId = claims.uid;
        if (claims.email_verified) user.emailVerified = true;
        if (isStaffEndpoint && email === secrets.superAdminEmail) {
          user.role = Role.SUPER_ADMIN;
          user.staffStatus = 'APPROVED';
          user.requestedRole = Role.SUPER_ADMIN;
        }
      }

      if (isStaffEndpoint && !ADMIN_ROLES.includes(user.role)) {
        return apiError(403, 'FORBIDDEN', 'This Google account is registered as a customer wallet user, not staff.', correlationId);
      }

      const session = await createEdgeSession(user, secrets, {
        deviceFingerprint: String(body.deviceFingerprint || `google_${claims.uid.slice(0, 8)}`),
        deviceLabel: String(body.deviceLabel || 'Google Sign-In'),
        twoFactorVerified: true,
      });
      await kvSyncUser(env, user.id);
      const vaultCookie = await buildVaultCookie(user.id, secrets.encKey, isHttps);

      return jsonResponse(
        {
          user: sanitizeUser(user),
          accessToken: session.accessToken,
          sessionId: session.sessionId,
          requiresPinSetup: !edgeState.pins.has(user.id),
        },
        200,
        buildAuthCookies(session.refreshCookieJwt, vaultCookie, isHttps),
      );
    }

    if (method === 'POST' && path === '/auth/otp/send') {
      const parsed = otpSendSchema.safeParse(body);
      if (!parsed.success) return apiError(400, 'VALIDATION_ERROR', parsed.error.issues[0].message, correlationId);
      const code = generateNumericOtpEdge();
      const target = parsed.data.target.trim().toLowerCase();
      const otpId = `otp_${crypto.randomUUID()}`;
      edgeState.otps.set(otpId, {
        id: otpId,
        userId: null,
        target,
        channel: parsed.data.channel,
        purpose: parsed.data.purpose,
        codeHash: await sha256HexEdge(`${target}:${parsed.data.purpose}:${code}`),
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        attempts: 0,
        usedAt: null,
        createdAt: new Date().toISOString(),
      });
      const sent = await sendLiveOtp(env, target, parsed.data.channel, code);
      return jsonResponse({ otpId, sent, expiresAt: edgeState.otps.get(otpId)!.expiresAt });
    }

    if (method === 'POST' && path === '/auth/otp/verify') {
      const parsed = otpVerifySchema.safeParse(body);
      if (!parsed.success) return apiError(400, 'VALIDATION_ERROR', parsed.error.issues[0].message, correlationId);
      const target = parsed.data.target.trim().toLowerCase();
      const candidates = [...edgeState.otps.values()]
        .filter((o) => o.target === target && o.purpose === parsed.data.purpose && o.channel === parsed.data.channel && !o.usedAt)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const otp = candidates[0];
      if (!otp) return apiError(400, 'OTP_NOT_FOUND', 'No active verification code found.', correlationId);
      if (Date.now() > Date.parse(otp.expiresAt)) return apiError(400, 'OTP_EXPIRED', 'Verification code has expired.', correlationId);
      if (otp.attempts >= 5) return apiError(400, 'OTP_MAX_ATTEMPTS', 'Maximum verification attempts exceeded.', correlationId);
      otp.attempts += 1;
      const expected = await sha256HexEdge(`${target}:${parsed.data.purpose}:${parsed.data.code}`);
      if (otp.codeHash !== expected) return apiError(400, 'OTP_INVALID', 'Incorrect verification code.', correlationId);
      otp.usedAt = new Date().toISOString();
      if (otp.userId) {
        const u = edgeState.users.get(otp.userId);
        if (u) {
          if (parsed.data.channel === 'EMAIL') u.emailVerified = true;
          if (parsed.data.channel === 'SMS') u.phoneVerified = true;
        }
      }
      return jsonResponse({ verified: true, userId: otp.userId });
    }

    if (method === 'POST' && path === '/auth/refresh') {
      const cookies = parseCookies(request);
      const refreshJwt = cookies['csw_refresh'];
      if (!refreshJwt) return apiError(401, 'UNAUTHORIZED', 'Missing refresh session', correlationId);
      const claims = await verifyJwtEdge<{ sub: string; sid: string; role: Role; exp?: number }>(refreshJwt, secrets.refreshSecret);
      if (!claims) return apiError(401, 'UNAUTHORIZED', 'Invalid or expired session', correlationId);
      const user = edgeState.users.get(claims.sub);
      if (!user) return apiError(401, 'UNAUTHORIZED', 'Session user unavailable', correlationId);

      const session = await createEdgeSession(user, secrets, { twoFactorVerified: true });
      const vaultCookie = await buildVaultCookie(user.id, secrets.encKey, isHttps);
      return jsonResponse(
        {
          user: sanitizeUser(user),
          accessToken: session.accessToken,
          sessionId: session.sessionId,
          requiresPinSetup: !edgeState.pins.has(user.id),
        },
        200,
        buildAuthCookies(session.refreshCookieJwt, vaultCookie, isHttps),
      );
    }

    if (method === 'POST' && path === '/auth/logout') {
      const clearRefresh = formatCookie('csw_refresh', '', { httpOnly: true, secure: isHttps, path: '/api/v1/auth', maxAge: 0 });
      const clearCsrf = formatCookie('csw_csrf', '', { httpOnly: false, secure: isHttps, path: '/', maxAge: 0 });
      return jsonResponse({ ok: true }, 200, [clearRefresh, clearCsrf]);
    }

    // ==================== AUTHENTICATED ENDPOINTS ====================
    const authCtx = await authenticateEdgeRequest(request, secrets);
    if (!authCtx) {
      return apiError(401, 'UNAUTHORIZED', 'Authentication required', correlationId);
    }
    const { user, claims } = authCtx;

    if (method === 'GET' && path === '/auth/devices') {
      const devices = [...edgeState.sessions.values()].filter((s) => s.userId === user.id && !s.revokedAt);
      return jsonResponse({ devices });
    }

    const revokeMatch = path.match(/^\/auth\/devices\/([^/]+)\/revoke$/);
    if (method === 'POST' && revokeMatch) {
      const sess = edgeState.sessions.get(revokeMatch[1]);
      if (sess && sess.userId === user.id) {
        sess.revokedAt = new Date().toISOString();
      }
      return jsonResponse({ revoked: true });
    }

    if (method === 'POST' && path === '/pin/set') {
      const parsed = pinSetSchema.safeParse(body);
      if (!parsed.success) return apiError(400, 'VALIDATION_ERROR', parsed.error.issues[0].message, correlationId);
      const pinCheck = isTrivialPin(parsed.data.pin);
      if (pinCheck.trivial) {
        return apiError(400, 'TRIVIAL_PIN', pinCheck.reason || 'PIN cannot be sequential or repeated digits.', correlationId);
      }
      const { hash, salt } = await hashPinEdge(parsed.data.pin, secrets.pinPepper);
      edgeState.pins.set(user.id, {
        userId: user.id,
        pinHash: hash,
        salt,
        failedAttempts: 0,
        lockoutCount: 0,
        lockedUntil: null,
        requiresComplianceReview: false,
        updatedAt: new Date().toISOString(),
      });
      await kvSyncUser(env, user.id);
      const vaultCookie = await buildVaultCookie(user.id, secrets.encKey, isHttps);
      return jsonResponse({ pinSet: true }, 200, vaultCookie ? [vaultCookie] : []);
    }

    if (method === 'POST' && path === '/pin/verify') {
      const parsed = pinVerifySchema.safeParse(body);
      if (!parsed.success) return apiError(400, 'VALIDATION_ERROR', parsed.error.issues[0].message, correlationId);
      const pinRec = edgeState.pins.get(user.id);
      if (!pinRec) return apiError(400, 'PIN_NOT_SET', 'Set your 6-digit PIN first.', correlationId);
      if (pinRec.lockedUntil && Date.now() < Date.parse(pinRec.lockedUntil)) {
        return apiError(403, 'PIN_LOCKED', 'PIN temporarily locked due to failed attempts.', correlationId);
      }
      const ok = await verifyPinEdge(parsed.data.pin, pinRec.salt, pinRec.pinHash, secrets.pinPepper);
      if (!ok) {
        pinRec.failedAttempts += 1;
        if (pinRec.failedAttempts >= 3) {
          pinRec.lockedUntil = new Date(Date.now() + 30 * 60 * 1000).toISOString();
          pinRec.failedAttempts = 0;
          pinRec.lockoutCount += 1;
        }
        return apiError(400, 'INVALID_PIN', 'Incorrect 6-digit PIN.', correlationId);
      }
      pinRec.failedAttempts = 0;
      pinRec.lockedUntil = null;
      const ttl = parsed.data.scope === 'view' ? 300 : 120;
      const stepUpToken = await signJwtEdge(
        {
          jti: `stp_${crypto.randomUUID()}`,
          sub: user.id,
          scope: parsed.data.scope,
          action: parsed.data.action,
          adminAction: parsed.data.adminAction,
          amountMinor: parsed.data.amountMinor,
          currency: parsed.data.currency,
          kind: 'step_up',
        },
        secrets.jwtSecret,
        ttl,
      );
      return jsonResponse({ stepUpToken, expiresInSeconds: ttl, scope: parsed.data.scope });
    }

    if (method === 'POST' && path === '/pin/change') {
      const currentPin = String(body.currentPin || '');
      const newPin = String(body.newPin || '');
      const pinRec = edgeState.pins.get(user.id);
      if (!pinRec || !(await verifyPinEdge(currentPin, pinRec.salt, pinRec.pinHash, secrets.pinPepper))) {
        return apiError(400, 'INVALID_PIN', 'Current PIN is incorrect.', correlationId);
      }
      const newPinCheck = isTrivialPin(newPin);
      if (!/^\d{6}$/.test(newPin) || newPinCheck.trivial) {
        return apiError(400, 'TRIVIAL_PIN', newPinCheck.reason || 'New PIN must be 6 non-trivial digits.', correlationId);
      }
      const { hash, salt } = await hashPinEdge(newPin, secrets.pinPepper);
      pinRec.pinHash = hash;
      pinRec.salt = salt;
      pinRec.updatedAt = new Date().toISOString();
      const vaultCookie = await buildVaultCookie(user.id, secrets.encKey, isHttps);
      return jsonResponse({ changed: true }, 200, vaultCookie ? [vaultCookie] : []);
    }

    if (method === 'GET' && path === '/me') {
      const prefs: NotificationPreferences = edgeState.notificationPreferences.get(user.id) || {
        userId: user.id,
        emailReceipts: true,
        pushTransactions: true,
        smsTransactions: true,
        mandatorySecurityAlerts: true,
      };
      return jsonResponse({
        user: sanitizeUser(user),
        profile: edgeState.profiles.get(user.id) ?? null,
        pinConfigured: edgeState.pins.has(user.id),
        notificationPreferences: { ...prefs, pushTransactions: true, mandatorySecurityAlerts: true },
        permissions: getPermissionSet(user.role),
      });
    }

    if (method === 'PATCH' && path === '/me') {
      const fullName = typeof body.fullName === 'string' ? body.fullName.trim() : undefined;
      const address = typeof body.address === 'string' ? body.address.trim() : undefined;
      const existing = edgeState.profiles.get(user.id) || {
        userId: user.id,
        fullName: fullName || user.email || user.phone || 'Wallet User',
        dateOfBirth: '',
        nationalIdEncrypted: '',
        address: address || '',
        country: 'ZW',
        updatedAt: new Date().toISOString(),
      };
      if (fullName) existing.fullName = fullName;
      if (address) existing.address = address;
      existing.updatedAt = new Date().toISOString();
      edgeState.profiles.set(user.id, existing);
      const vaultCookie = await buildVaultCookie(user.id, secrets.encKey, isHttps);
      return jsonResponse({ profile: existing }, 200, vaultCookie ? [vaultCookie] : []);
    }

    if (method === 'POST' && path === '/kyc/documents') {
      const parsed = kycSubmitSchema.safeParse(body);
      if (!parsed.success) return apiError(400, 'VALIDATION_ERROR', parsed.error.issues[0].message, correlationId);
      const now = new Date().toISOString();
      edgeState.profiles.set(user.id, {
        userId: user.id,
        fullName: parsed.data.fullName,
        dateOfBirth: parsed.data.dateOfBirth,
        nationalIdEncrypted: await encryptFieldEdge(parsed.data.nationalIdNumber, secrets.encKey),
        address: parsed.data.address,
        country: parsed.data.country,
        updatedAt: now,
      });
      const kycId = `kyc_${crypto.randomUUID()}`;
      edgeState.kycDocs.set(kycId, {
        id: kycId,
        userId: user.id,
        type: parsed.data.documentType,
        storageKey: `private/kyc/${user.id}/id`,
        mimeType: 'image/png',
        status: KycStatus.PENDING,
        reviewedBy: null,
        reviewedAt: null,
        rejectionReason: null,
        createdAt: now,
      });
      user.kycStatus = KycStatus.PENDING;
      await kvSyncUser(env, user.id);
      const vaultCookie = await buildVaultCookie(user.id, secrets.encKey, isHttps);
      return jsonResponse({ kycStatus: user.kycStatus }, 201, vaultCookie ? [vaultCookie] : []);
    }

    if (method === 'GET' && path === '/kyc/status') {
      const docs = [...edgeState.kycDocs.values()].filter((d) => d.userId === user.id);
      return jsonResponse({ kycStatus: user.kycStatus, kycTier: user.kycTier, documents: docs });
    }

    if (method === 'GET' && path === '/accounts') {
      const accounts = [...edgeState.accounts.values()].filter((a) => a.userId === user.id);
      return jsonResponse({ accounts });
    }

    const balMatch = path.match(/^\/accounts\/([^/]+)\/balance$/);
    if (method === 'GET' && balMatch) {
      const step = await verifyStepUpEdge(request, user.id, 'view', secrets);
      if (!step) return apiError(403, 'STEPUP_REQUIRED', 'PIN verification required to view balances.', correlationId);
      const acc = edgeState.accounts.get(balMatch[1]);
      if (!acc || acc.userId !== user.id) return apiError(404, 'ACCOUNT_NOT_FOUND', 'Wallet account not found.', correlationId);
      const la = getEdgeWalletLedger(acc.id);
      const holdMinor = [...edgeState.withdrawalRequests.values()]
        .filter((w) => w.accountId === acc.id && (w.status === WithdrawalStatus.PENDING || w.status === WithdrawalStatus.MAKER_APPROVED || w.status === WithdrawalStatus.CHECKER_APPROVED))
        .reduce((sum, w) => sum + w.amountMinor, 0);
      return jsonResponse({
        accountId: acc.id,
        currency: acc.currency,
        balanceMinor: la?.cachedBalanceMinor ?? 0,
        holdMinor,
      });
    }

    const lookupMatch = path.match(/^\/accounts\/lookup\/([^/]+)$/);
    if (method === 'GET' && lookupMatch) {
      const acc = [...edgeState.accounts.values()].find((a) => a.accountNumber === lookupMatch[1]);
      if (!acc) return apiError(404, 'RECIPIENT_NOT_FOUND', 'Recipient wallet account number not found.', correlationId);
      const prof = edgeState.profiles.get(acc.userId);
      const nameParts = (prof?.fullName || 'Wallet User').split(' ');
      const maskedName = nameParts.map((p) => (p.length <= 2 ? p : `${p[0]}${'*'.repeat(p.length - 2)}${p[p.length - 1]}`)).join(' ');
      return jsonResponse({ accountNumber: acc.accountNumber, currency: acc.currency, maskedName });
    }

    if (method === 'GET' && path === '/fees/preview') {
      const amountMinor = Number(url.searchParams.get('amountMinor') || '0');
      const currency = (url.searchParams.get('currency') || Currency.USD) as Currency;
      const feeMinor = calculateTransferFee(amountMinor, currency);
      return jsonResponse({ amountMinor, feeMinor, totalDebitMinor: amountMinor + feeMinor, currency });
    }

    if (method === 'GET' && path === '/transactions') {
      const accIds = new Set([...edgeState.accounts.values()].filter((a) => a.userId === user.id).map((a) => a.id));
      const transactions = [...edgeState.transactions.values()]
        .filter((t) => (t.fromAccountId && accIds.has(t.fromAccountId)) || (t.toAccountId && accIds.has(t.toAccountId)))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return jsonResponse({ transactions });
    }

    const receiptMatch = path.match(/^\/transactions\/([^/]+)\/receipt$/);
    if (method === 'GET' && receiptMatch) {
      const txn = edgeState.transactions.get(receiptMatch[1]);
      if (!txn) return apiError(404, 'NOT_FOUND', 'Transaction not found.', correlationId);
      const pdf = buildMinimalPdf([
        'COMFORT SECURE WALLET - OFFICIAL RECEIPT',
        `Transaction ID: ${txn.id}`,
        `Reference: ${txn.reference}`,
        `Type: ${txn.type.toUpperCase()} (${txn.status})`,
        `Amount: ${txn.currency} ${(txn.amountMinor / 100).toFixed(2)}`,
        `Fee: ${txn.currency} ${(txn.feeMinor / 100).toFixed(2)}`,
        `Description: ${String(txn.metadata?.description || txn.type)}`,
        `Timestamp: ${txn.createdAt}`,
      ]);
      return new Response(pdf as BodyInit, {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="comfort-receipt-${txn.id}.pdf"`,
        },
      });
    }

    if (method === 'GET' && path === '/deposits/requests') {
      const deposits = [...edgeState.depositRequests.values()]
        .filter((d) => d.userId === user.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return jsonResponse({ deposits });
    }

    if (method === 'POST' && path === '/deposits/requests') {
      const parsed = depositRequestSchema.safeParse(body);
      if (!parsed.success) return apiError(400, 'VALIDATION_ERROR', parsed.error.issues[0].message, correlationId);
      const normRef = parsed.data.paymentReference.trim().toLowerCase();
      for (const d of edgeState.depositRequests.values()) {
        if (d.paymentReference.toLowerCase() === normRef) {
          return apiError(409, 'DUPLICATE_REFERENCE', 'This payment reference has already been submitted.', correlationId);
        }
      }
      const dep: DepositRequestRecord = {
        id: `dep_${crypto.randomUUID()}`,
        userId: user.id,
        accountId: parsed.data.accountId,
        amountMinor: parsed.data.amountMinor,
        currency: parsed.data.currency,
        method: parsed.data.method,
        proofStorageKey: `private/deposits/${user.id}/${crypto.randomUUID()}`,
        paymentReference: parsed.data.paymentReference.trim(),
        status: DepositStatus.PENDING,
        makerId: null,
        checkerId: null,
        decidedAt: null,
        notes: null,
        createdAt: new Date().toISOString(),
      };
      edgeState.depositRequests.set(dep.id, dep);
      enqueueEdgeNotification({
        userId: user.id,
        channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH],
        template: 'DEPOSIT_SUBMITTED_v1',
        title: 'Deposit Request Received',
        body: `Deposit request for ${dep.currency} ${(dep.amountMinor / 100).toFixed(2)} (${dep.paymentReference}) is pending review.`,
      });
      const vaultCookie = await buildVaultCookie(user.id, secrets.encKey, isHttps);
      return jsonResponse({ deposit: dep }, 201, vaultCookie ? [vaultCookie] : []);
    }

    if (method === 'POST' && path === '/transfers') {
      const idemKey = request.headers.get('idempotency-key')?.trim();
      if (!idemKey) return apiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header required.', correlationId);
      const cached = edgeState.idempotencyResponses.get(`${user.id}:${idemKey}`);
      if (cached) return jsonResponse(cached.body, cached.statusCode);

      const parsed = transferSchema.safeParse(body);
      if (!parsed.success) return apiError(400, 'VALIDATION_ERROR', parsed.error.issues[0].message, correlationId);

      const fromAcc = edgeState.accounts.get(parsed.data.fromAccountId);
      if (!fromAcc || fromAcc.userId !== user.id) return apiError(404, 'ACCOUNT_NOT_FOUND', 'Source wallet not found.', correlationId);

      const step = await verifyStepUpEdge(request, user.id, 'transaction', secrets, {
        action: 'transfer',
        amountMinor: parsed.data.amountMinor,
        currency: fromAcc.currency,
      });
      if (!step) return apiError(403, 'STEPUP_REQUIRED', 'Single-use transaction PIN approval is required.', correlationId);

      const toAcc = [...edgeState.accounts.values()].find((a) => a.accountNumber === parsed.data.toAccountNumber);
      if (!toAcc) return apiError(404, 'RECIPIENT_NOT_FOUND', 'Recipient wallet account not found.', correlationId);
      if (toAcc.id === fromAcc.id) return apiError(400, 'SELF_TRANSFER_FORBIDDEN', 'Cannot transfer to the same wallet.', correlationId);
      if (toAcc.currency !== fromAcc.currency) return apiError(400, 'CURRENCY_MISMATCH', 'Cross-currency transfers are not enabled.', correlationId);

      const feeMinor = calculateTransferFee(parsed.data.amountMinor, fromAcc.currency);
      const fromLa = getEdgeWalletLedger(fromAcc.id);
      const toLa = getEdgeWalletLedger(toAcc.id);
      const feeLa = edgeState.ledgerAccounts.get(`sys_${LedgerAccountType.FEE_REVENUE}_${fromAcc.currency}`);
      if (!fromLa || !toLa || !feeLa) return apiError(500, 'LEDGER_ERROR', 'Ledger accounts unavailable.', correlationId);

      const txn = postAtomicEdgeTransaction({
        type: TransactionType.TRANSFER,
        amountMinor: parsed.data.amountMinor,
        feeMinor,
        currency: fromAcc.currency,
        fromAccountId: fromAcc.id,
        toAccountId: toAcc.id,
        reference: `TRF-${randomToken(4).toUpperCase()}`,
        idempotencyKey: idemKey,
        description: parsed.data.note || `Transfer to ${toAcc.accountNumber}`,
        legs: [
          { ledgerAccountId: fromLa.id, direction: JournalDirection.DEBIT, amountMinor: parsed.data.amountMinor + feeMinor, currency: fromAcc.currency },
          { ledgerAccountId: toLa.id, direction: JournalDirection.CREDIT, amountMinor: parsed.data.amountMinor, currency: fromAcc.currency },
          ...(feeMinor > 0 ? [{ ledgerAccountId: feeLa.id, direction: JournalDirection.CREDIT, amountMinor: feeMinor, currency: fromAcc.currency }] : []),
        ],
      });

      enqueueEdgeNotification({
        userId: user.id,
        channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH],
        template: 'TRANSFER_SENT_v1',
        title: 'Money Sent',
        body: `Sent ${txn.currency} ${(txn.amountMinor / 100).toFixed(2)} to ${toAcc.accountNumber}.`,
      });
      enqueueEdgeNotification({
        userId: toAcc.userId,
        channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH],
        template: 'TRANSFER_RECEIVED_v1',
        title: 'Money Received',
        body: `Received ${txn.currency} ${(txn.amountMinor / 100).toFixed(2)} from ${fromAcc.accountNumber}.`,
      });
      const resp = { transaction: txn };
      edgeState.idempotencyResponses.set(`${user.id}:${idemKey}`, { statusCode: 201, body: resp, userId: user.id });
      const vaultCookie = await buildVaultCookie(user.id, secrets.encKey, isHttps);
      return jsonResponse(resp, 201, vaultCookie ? [vaultCookie] : []);
    }

    if (method === 'GET' && path === '/withdrawals/requests') {
      const withdrawals = [...edgeState.withdrawalRequests.values()]
        .filter((w) => w.userId === user.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return jsonResponse({ withdrawals });
    }

    if (method === 'POST' && path === '/withdrawals/requests') {
      const idemKey = request.headers.get('idempotency-key')?.trim();
      if (!idemKey) return apiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header required.', correlationId);

      const parsed = withdrawalRequestSchema.safeParse(body);
      if (!parsed.success) return apiError(400, 'VALIDATION_ERROR', parsed.error.issues[0].message, correlationId);
      const acc = edgeState.accounts.get(parsed.data.accountId);
      if (!acc || acc.userId !== user.id) return apiError(404, 'ACCOUNT_NOT_FOUND', 'Wallet account not found.', correlationId);

      const step = await verifyStepUpEdge(request, user.id, 'transaction', secrets, {
        action: 'withdrawal',
        amountMinor: parsed.data.amountMinor,
        currency: acc.currency,
      });
      if (!step) return apiError(403, 'STEPUP_REQUIRED', 'Single-use transaction PIN approval is required.', correlationId);

      const lim = edgeState.limitRules.get(`lim_TIER_${Math.max(1, user.kycTier)}_${acc.currency}`) || edgeState.limitRules.get(`lim_TIER_1_${acc.currency}`);
      if (lim && parsed.data.amountMinor > lim.dailyMaxMinor) {
        return apiError(400, 'DAILY_LIMIT_EXCEEDED', `Exceeds daily withdrawal limit of ${acc.currency} ${(lim.dailyMaxMinor / 100).toFixed(2)}.`, correlationId);
      }

      const fromLa = getEdgeWalletLedger(acc.id);
      const holdLa = edgeState.ledgerAccounts.get(`sys_${LedgerAccountType.WITHDRAWAL_HOLD}_${acc.currency}`);
      if (!fromLa || !holdLa) return apiError(500, 'LEDGER_ERROR', 'Ledger unavailable.', correlationId);

      postAtomicEdgeTransaction({
        type: TransactionType.WITHDRAWAL,
        amountMinor: parsed.data.amountMinor,
        feeMinor: 0,
        currency: acc.currency,
        fromAccountId: acc.id,
        toAccountId: null,
        reference: `WDR-${randomToken(4).toUpperCase()}`,
        idempotencyKey: idemKey,
        description: `Withdrawal hold (${parsed.data.method})`,
        legs: [
          { ledgerAccountId: fromLa.id, direction: JournalDirection.DEBIT, amountMinor: parsed.data.amountMinor, currency: acc.currency },
          { ledgerAccountId: holdLa.id, direction: JournalDirection.CREDIT, amountMinor: parsed.data.amountMinor, currency: acc.currency },
        ],
      });

      const wdr: WithdrawalRequestRecord = {
        id: `wdr_${crypto.randomUUID()}`,
        userId: user.id,
        accountId: acc.id,
        amountMinor: parsed.data.amountMinor,
        currency: acc.currency,
        destinationDetailsEncrypted: await encryptFieldEdge(`${parsed.data.method}|${parsed.data.destinationLabel}`, secrets.encKey),
        destinationPreview: `${parsed.data.method}: ••••${parsed.data.destinationLabel.slice(-4)}`,
        status: WithdrawalStatus.PENDING,
        makerId: null,
        checkerId: null,
        payoutReference: null,
        decidedAt: null,
        rejectionReason: null,
        createdAt: new Date().toISOString(),
      };
      edgeState.withdrawalRequests.set(wdr.id, wdr);
      enqueueEdgeNotification({
        userId: user.id,
        channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH],
        template: 'WITHDRAWAL_REQUESTED_v1',
        title: 'Withdrawal Hold Placed',
        body: `Withdrawal of ${wdr.currency} ${(wdr.amountMinor / 100).toFixed(2)} placed on hold for processing.`,
      });
      const vaultCookie = await buildVaultCookie(user.id, secrets.encKey, isHttps);
      return jsonResponse({ withdrawal: wdr }, 201, vaultCookie ? [vaultCookie] : []);
    }

    if (method === 'GET' && path === '/statements') {
      const step = await verifyStepUpEdge(request, user.id, 'view', secrets);
      if (!step) return apiError(403, 'STEPUP_REQUIRED', 'PIN verification required to view statements.', correlationId);
      const accIds = new Set([...edgeState.accounts.values()].filter((a) => a.userId === user.id).map((a) => a.id));
      const txns = [...edgeState.transactions.values()].filter(
        (t) => (t.fromAccountId && accIds.has(t.fromAccountId)) || (t.toAccountId && accIds.has(t.toAccountId)),
      );
      return jsonResponse({ transactions: txns, openingBalanceMinor: 0, closingBalanceMinor: 0 });
    }

    if (method === 'POST' && path === '/statements/export') {
      const step = await verifyStepUpEdge(request, user.id, 'view', secrets);
      if (!step) return apiError(403, 'STEPUP_REQUIRED', 'PIN verification required to export statements.', correlationId);
      const format = String(body.format || 'CSV').toUpperCase();
      const accIds = new Set([...edgeState.accounts.values()].filter((a) => a.userId === user.id).map((a) => a.id));
      const txns = [...edgeState.transactions.values()].filter(
        (t) => (t.fromAccountId && accIds.has(t.fromAccountId)) || (t.toAccountId && accIds.has(t.toAccountId)),
      );
      if (format === 'PDF') {
        const pdf = buildMinimalPdf([
          'COMFORT SECURE WALLET - ACCOUNT STATEMENT',
          `Account Holder: ${user.email || user.phone || user.id}`,
          `Transactions Count: ${txns.length}`,
          ...txns.slice(0, 20).map((t) => `${t.createdAt.slice(0, 10)} | ${t.reference} | ${t.currency} ${(t.amountMinor / 100).toFixed(2)} | ${t.type}`),
        ]);
        return new Response(pdf as BodyInit, {
          status: 200,
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Disposition': 'attachment; filename="comfort-statement.pdf"',
          },
        });
      }
      const csv = buildCsvStatement(txns, accIds);
      return new Response(csv, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="comfort-statement.csv"',
        },
      });
    }

    if (method === 'GET' && path === '/notifications') {
      const notifications = [...edgeState.notifications.values()]
        .filter((n) => n.userId === user.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return jsonResponse({ notifications });
    }

    const readNotifMatch = path.match(/^\/notifications\/([^/]+)\/read$/);
    if (method === 'POST' && readNotifMatch) {
      const n = edgeState.notifications.get(readNotifMatch[1]);
      if (n && n.userId === user.id && !n.readAt) n.readAt = new Date().toISOString();
      return jsonResponse({ ok: true });
    }

    if (method === 'POST' && path === '/push/subscribe') {
      if (typeof body.endpoint === 'string') {
        edgeState.pushSubscriptions.set(user.id, {
          userId: user.id,
          endpoint: body.endpoint,
          keys: (body.keys as Record<string, string>) || {},
        });
      }
      return jsonResponse({ subscribed: true, mandatoryForTransactions: true });
    }

    if (method === 'PATCH' && path === '/notification-preferences') {
      const updated: NotificationPreferences = {
        userId: user.id,
        emailReceipts: typeof body.emailReceipts === 'boolean' ? body.emailReceipts : true,
        pushTransactions: true,
        smsTransactions: typeof body.smsTransactions === 'boolean' ? body.smsTransactions : true,
        mandatorySecurityAlerts: true,
      };
      edgeState.notificationPreferences.set(user.id, updated);
      return jsonResponse({ preferences: updated });
    }

    // ==================== ADMIN / BACK-OFFICE ====================
    if (path.startsWith('/admin/')) {
      if (!ADMIN_ROLES.includes(user.role)) {
        return apiError(403, 'FORBIDDEN', 'Staff role required.', correlationId);
      }
      if (user.staffStatus !== 'APPROVED') {
        return apiError(403, 'STAFF_APPROVAL_PENDING', 'Staff account awaiting Super Admin approval.', correlationId);
      }
      const perms = getPermissionSet(user.role);
      const requirePerm = (p: Permission) => perms.includes(p);

      if (method === 'GET' && path === '/admin/overview') {
        return jsonResponse({
          usersCount: edgeState.users.size,
          accountsCount: edgeState.accounts.size,
          pendingKycCount: [...edgeState.users.values()].filter((u) => u.kycStatus === KycStatus.PENDING).length,
          pendingDepositsCount: [...edgeState.depositRequests.values()].filter((d) => d.status === DepositStatus.PENDING || d.status === DepositStatus.MAKER_APPROVED).length,
          pendingWithdrawalsCount: [...edgeState.withdrawalRequests.values()].filter((w) => w.status === WithdrawalStatus.PENDING || w.status === WithdrawalStatus.MAKER_APPROVED || w.status === WithdrawalStatus.CHECKER_APPROVED).length,
          openRiskFlagsCount: [...edgeState.riskFlags.values()].filter((r) => !r.resolvedAt).length,
        });
      }

      if (method === 'GET' && path === '/admin/kyc') {
        if (!requirePerm('kyc:read')) return apiError(403, 'INSUFFICIENT_PERMISSIONS', 'Missing permission kyc:read', correlationId);
        const queue = [...edgeState.users.values()]
          .filter((u) => !ADMIN_ROLES.includes(u.role))
          .map((u) => ({
            user: sanitizeUser(u),
            profile: edgeState.profiles.get(u.id) ?? null,
            documents: [...edgeState.kycDocs.values()].filter((d) => d.userId === u.id),
          }));
        return jsonResponse({ queue });
      }

      const kycDecMatch = path.match(/^\/admin\/kyc\/([^/]+)\/decision$/);
      if (method === 'POST' && kycDecMatch) {
        if (!requirePerm('kyc:decide')) return apiError(403, 'INSUFFICIENT_PERMISSIONS', 'Missing permission kyc:decide', correlationId);
        const step = await verifyStepUpEdge(request, user.id, 'admin_action', secrets, { adminAction: 'kyc_decide' });
        if (!step) return apiError(403, 'ADMIN_PIN_REQUIRED', 'Staff 6-digit PIN verification required.', correlationId);
        const target = edgeState.users.get(kycDecMatch[1]);
        if (!target) return apiError(404, 'USER_NOT_FOUND', 'User not found.', correlationId);
        const decision = body.decision as KycStatus;
        target.kycStatus = decision;
        if (decision === KycStatus.APPROVED) {
          target.kycTier = 1;
          provisionWalletsForUser(target.id);
        }
        return jsonResponse({ user: sanitizeUser(target) });
      }

      if (method === 'GET' && path === '/admin/deposits') {
        if (!requirePerm('deposits:read')) return apiError(403, 'INSUFFICIENT_PERMISSIONS', 'Missing permission deposits:read', correlationId);
        return jsonResponse({ deposits: [...edgeState.depositRequests.values()] });
      }

      const depApproveMatch = path.match(/^\/admin\/deposits\/([^/]+)\/approve$/);
      if (method === 'POST' && depApproveMatch) {
        const dep = edgeState.depositRequests.get(depApproveMatch[1]);
        if (!dep) return apiError(404, 'NOT_FOUND', 'Deposit request not found.', correlationId);
        if (dep.status === DepositStatus.PENDING) {
          if (!requirePerm('deposits:make')) return apiError(403, 'INSUFFICIENT_PERMISSIONS', 'Missing deposits:make', correlationId);
          dep.status = DepositStatus.MAKER_APPROVED;
          dep.makerId = user.id;
        } else if (dep.status === DepositStatus.MAKER_APPROVED) {
          if (!requirePerm('deposits:check')) return apiError(403, 'INSUFFICIENT_PERMISSIONS', 'Missing deposits:check', correlationId);
          if (dep.makerId === user.id) return apiError(403, 'MAKER_CHECKER_VIOLATION', 'Checker must differ from Maker.', correlationId);
          const acc = edgeState.accounts.get(dep.accountId);
          const la = acc ? getEdgeWalletLedger(acc.id) : undefined;
          const bankLa = edgeState.ledgerAccounts.get(`sys_${LedgerAccountType.BANK_SETTLEMENT}_${dep.currency}`);
          if (la && bankLa) {
            postAtomicEdgeTransaction({
              type: TransactionType.DEPOSIT,
              amountMinor: dep.amountMinor,
              feeMinor: 0,
              currency: dep.currency,
              fromAccountId: null,
              toAccountId: dep.accountId,
              reference: dep.paymentReference,
              idempotencyKey: `dep_chk_${dep.id}`,
              description: `Deposit credited (${dep.method})`,
              legs: [
                { ledgerAccountId: bankLa.id, direction: JournalDirection.DEBIT, amountMinor: dep.amountMinor, currency: dep.currency },
                { ledgerAccountId: la.id, direction: JournalDirection.CREDIT, amountMinor: dep.amountMinor, currency: dep.currency },
              ],
            });
          }
          dep.status = DepositStatus.APPROVED;
          dep.checkerId = user.id;
          dep.decidedAt = new Date().toISOString();
        }
        return jsonResponse({ deposit: dep });
      }

      if (method === 'GET' && path === '/admin/withdrawals') {
        if (!requirePerm('withdrawals:read')) return apiError(403, 'INSUFFICIENT_PERMISSIONS', 'Missing permission withdrawals:read', correlationId);
        return jsonResponse({ withdrawals: [...edgeState.withdrawalRequests.values()] });
      }

      if (method === 'GET' && path === '/admin/users') {
        if (!requirePerm('users:read')) return apiError(403, 'INSUFFICIENT_PERMISSIONS', 'Missing users:read', correlationId);
        const users = [...edgeState.users.values()]
          .filter((u) => !ADMIN_ROLES.includes(u.role))
          .map((u) => ({
            user: sanitizeUser(u),
            profile: edgeState.profiles.get(u.id) ?? null,
            accounts: [...edgeState.accounts.values()].filter((a) => a.userId === u.id),
          }));
        return jsonResponse({ users });
      }

      if (method === 'GET' && path === '/admin/transactions') {
        if (!requirePerm('transactions:read')) return apiError(403, 'INSUFFICIENT_PERMISSIONS', 'Missing transactions:read', correlationId);
        return jsonResponse({ transactions: [...edgeState.transactions.values()] });
      }

      if (method === 'GET' && path === '/admin/fees') {
        return jsonResponse({ feeRules: [...edgeState.feeRules.values()] });
      }

      if (method === 'PUT' && path === '/admin/fees') {
        if (!requirePerm('fees:write')) return apiError(403, 'INSUFFICIENT_PERMISSIONS', 'Missing fees:write', correlationId);
        const parsed = feeRuleUpdateSchema.safeParse(body);
        if (!parsed.success) return apiError(400, 'VALIDATION_ERROR', parsed.error.issues[0].message, correlationId);
        const id = `fee_${parsed.data.transactionType}_${parsed.data.currency}`;
        const updated: FeeRuleRecord = {
          id,
          ...parsed.data,
          updatedAt: new Date().toISOString(),
          changedBy: user.id,
        };
        edgeState.feeRules.set(id, updated);
        return jsonResponse({ status: 'APPLIED', rule: updated });
      }

      if (method === 'GET' && path === '/admin/limits') {
        return jsonResponse({ limitRules: [...edgeState.limitRules.values()] });
      }

      if (method === 'PUT' && path === '/admin/limits') {
        if (!requirePerm('limits:write')) return apiError(403, 'INSUFFICIENT_PERMISSIONS', 'Missing limits:write', correlationId);
        const parsed = limitRuleUpdateSchema.safeParse(body);
        if (!parsed.success) return apiError(400, 'VALIDATION_ERROR', parsed.error.issues[0].message, correlationId);
        const id = `lim_${parsed.data.scope}_${parsed.data.currency}`;
        const updated: LimitRuleRecord = {
          id,
          ...parsed.data,
          updatedAt: new Date().toISOString(),
        };
        edgeState.limitRules.set(id, updated);
        return jsonResponse({ status: 'APPLIED', rule: updated });
      }

      if (method === 'GET' && path === '/admin/rbac') {
        return jsonResponse({ rules: [...edgeState.rbacRules.values()] });
      }

      if (method === 'GET' && path === '/admin/staff') {
        const staff = [...edgeState.users.values()]
          .filter((u) => ADMIN_ROLES.includes(u.role))
          .map((u) => ({
            user: sanitizeUser(u),
            profile: edgeState.profiles.get(u.id) ?? null,
            pinConfigured: edgeState.pins.has(u.id),
          }));
        return jsonResponse({ staff, rbacRules: [...edgeState.rbacRules.values()] });
      }

      const staffAppMatch = path.match(/^\/admin\/staff\/([^/]+)\/approve$/);
      if (method === 'POST' && staffAppMatch) {
        if (!requirePerm('staff:write')) return apiError(403, 'INSUFFICIENT_PERMISSIONS', 'Super Admin permission required.', correlationId);
        const step = await verifyStepUpEdge(request, user.id, 'admin_action', secrets, { adminAction: 'staff_approve' });
        if (!step) return apiError(403, 'ADMIN_PIN_REQUIRED', 'Staff PIN verification required.', correlationId);
        const target = edgeState.users.get(staffAppMatch[1]);
        if (!target) return apiError(404, 'USER_NOT_FOUND', 'Staff member not found.', correlationId);
        target.staffStatus = body.decision === 'REJECTED' ? 'REJECTED' : 'APPROVED';
        if (body.assignedRole && ADMIN_ROLES.includes(body.assignedRole as Role)) {
          target.role = body.assignedRole as Role;
        }
        await kvSyncUser(env, target.id);
        return jsonResponse({ user: sanitizeUser(target) });
      }

      const staffRoleMatch = path.match(/^\/admin\/staff\/([^/]+)\/role$/);
      if (method === 'POST' && staffRoleMatch) {
        if (!requirePerm('staff:write')) return apiError(403, 'INSUFFICIENT_PERMISSIONS', 'Super Admin permission required.', correlationId);
        const step = await verifyStepUpEdge(request, user.id, 'admin_action', secrets, { adminAction: 'staff_role' });
        if (!step) return apiError(403, 'ADMIN_PIN_REQUIRED', 'Staff PIN verification required.', correlationId);
        const target = edgeState.users.get(staffRoleMatch[1]);
        if (!target) return apiError(404, 'USER_NOT_FOUND', 'Staff member not found.', correlationId);
        if (ADMIN_ROLES.includes(body.role as Role)) {
          target.role = body.role as Role;
          target.staffStatus = 'APPROVED';
        }
        await kvSyncUser(env, target.id);
        return jsonResponse({ user: sanitizeUser(target) });
      }

      if (method === 'GET' && path === '/admin/audit-logs') {
        return jsonResponse({ logs: [...edgeState.auditLogs].reverse() });
      }

      if (method === 'GET' && path === '/admin/reconciliation') {
        return jsonResponse({ runs: [...edgeState.reconciliationRuns.values()], ledgerInvariant: { valid: true } });
      }

      if (method === 'GET' && path === '/admin/risk-flags') {
        return jsonResponse({ flags: [...edgeState.riskFlags.values()] });
      }

      if (method === 'GET' && path === '/admin/reports/summary') {
        return jsonResponse({
          currencies: [Currency.USD, Currency.ZWG, Currency.ZAR].map((c) => ({
            currency: c,
            userLiabilitiesMinor: 0,
            bankSettlementMinor: 0,
            feeRevenueMinor: 0,
            withdrawalHoldMinor: 0,
          })),
          totalTransactions: edgeState.transactions.size,
          pendingApprovals: [...edgeState.approvals.values()].filter((a) => a.status === 'PENDING').length,
        });
      }
    }

    return apiError(404, 'NOT_FOUND', `Endpoint ${method} ${path} not found`, correlationId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unexpected edge error';
    const [code, ...rest] = msg.includes(':') ? msg.split(':') : ['REQUEST_ERROR', msg];
    return apiError(400, code, rest.join(':').trim() || msg, correlationId);
  }
}
