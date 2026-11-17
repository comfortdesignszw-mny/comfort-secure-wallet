import { Router } from 'express';
import {
  ADMIN_ROLES,
  Currency,
  DepositStatus,
  Role,
  TransactionType,
  WithdrawalStatus,
} from '../../shared/types.ts';
import {
  depositRequestSchema,
  feeRuleUpdateSchema,
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
  withdrawalRequestSchema,
} from '../../shared/validation.ts';
import { getSuperAdminEmail } from '../config/env.ts';
import { broadcastSyncEvent, subscribeSseClient } from '../db/realtime.ts';
import { dbStore } from '../db/store.ts';
import {
  decryptBuffer,
  decryptField,
  generateCsrfToken,
  verifyAccessToken,
  verifyStorageSignature,
} from '../security/crypto.ts';
import {
  AuthenticatedRequest,
  requireAdminPinStepUp,
  requireAuth,
  requireIdempotencyKey,
  requirePermission,
  requireViewStepUp,
  sendApiError,
  verifyAndConsumeTransactionStepUp,
} from '../security/middleware.ts';
import { authRateLimiter, moneyRateLimiter, otpRateLimiter, pinRateLimiter } from '../security/rate-limit.ts';
import { authService } from '../modules/auth/auth.service.ts';
import { pinService } from '../modules/pin/pin.service.ts';
import { kycService } from '../modules/kyc/kyc.service.ts';
import { accountsService } from '../modules/accounts/accounts.service.ts';
import { transactionsService } from '../modules/transactions/transactions.service.ts';
import { rulesService } from '../modules/rules/rules.service.ts';
import { rbacService } from '../modules/rules/rbac.service.ts';
import { statementsService } from '../modules/statements/statements.service.ts';
import { notificationService } from '../modules/notifications/notifications.service.ts';
import { approvalsService } from '../modules/approvals/approvals.service.ts';
import { riskService } from '../modules/risk/risk.service.ts';
import { adminService } from '../modules/admin/admin.service.ts';
import { ledgerService } from '../modules/ledger/ledger.service.ts';

function getCookieSecurityOptions(res: import('express').Response) {
  const forwardedProto = String(res.req?.headers?.['x-forwarded-proto'] || '').toLowerCase();
  const isHttps = Boolean(res.req?.secure || forwardedProto.includes('https') || process.env.NODE_ENV === 'production');
  return {
    secure: isHttps,
    sameSite: (isHttps ? 'none' : 'lax') as 'none' | 'lax',
  };
}

function setRefreshCookies(res: import('express').Response, refreshToken: string) {
  const { secure, sameSite } = getCookieSecurityOptions(res);
  res.cookie('csw_refresh', refreshToken, {
    httpOnly: true,
    secure,
    sameSite,
    path: '/api/v1/auth',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
  res.cookie('csw_csrf', generateCsrfToken(), {
    httpOnly: false,
    secure,
    sameSite,
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

function handleError(req: AuthenticatedRequest, res: import('express').Response, err: unknown, fallbackStatus = 400) {
  const msg = err instanceof Error ? err.message : 'Unexpected error';
  const [code, ...rest] = msg.includes(':') ? msg.split(':') : ['REQUEST_ERROR', msg];
  const cleanMessage = rest.join(':').trim() || msg;
  const status =
    code === 'UNAUTHORIZED' || code === 'INVALID_CREDENTIALS' || code === 'TOKEN_REUSE_DETECTED'
      ? 401
      : code === 'FORBIDDEN' || code === 'PIN_LOCKED' || code === 'PIN_REVIEW_REQUIRED' || code === 'MAKER_CHECKER_VIOLATION' || code === 'DUAL_CONTROL_VIOLATION'
        ? 403
        : code.includes('NOT_FOUND')
          ? 404
          : code.includes('DUPLICATE') || code.includes('CONFLICT')
            ? 409
            : code.includes('RATE_LIMITED') || code.includes('THROTTLED')
              ? 429
              : fallbackStatus;
  return sendApiError(res, status, code, cleanMessage, req.correlationId);
}

export function createV1Router(): Router {
  const router = Router();

  // OpenAPI 3.1 Specification endpoint
  router.get('/docs', (_req, res) => {
    res.json({
      openapi: '3.1.0',
      info: {
        title: 'Comfort Secure Wallet API',
        version: '1.0.0',
        description: 'Double-entry digital wallet API for Zimbabwe & Africa.',
      },
      servers: [{ url: '/api/v1' }],
      paths: {
        '/auth/register': { post: { summary: 'Register user with email or phone + password' } },
        '/auth/login': { post: { summary: 'Login with password (and 2FA OTP for staff)' } },
        '/auth/google': { post: { summary: 'Verify Firebase Google ID Token' } },
        '/auth/otp/send': { post: { summary: 'Send 6-digit OTP via SMS or Email' } },
        '/auth/otp/verify': { post: { summary: 'Verify 6-digit OTP' } },
        '/auth/refresh': { post: { summary: 'Rotate httpOnly refresh cookie with reuse detection' } },
        '/pin/set': { post: { summary: 'Set 6-digit wallet PIN (argon2id + pepper)' } },
        '/pin/verify': { post: { summary: 'Verify PIN and issue scoped step-up token' } },
        '/kyc/documents': { post: { summary: 'Submit KYC profile, encrypted National ID, and selfie' } },
        '/accounts': { get: { summary: 'List user wallet accounts' } },
        '/accounts/{id}/balance': { get: { summary: 'Get ledger-derived balance (requires view step-up token)' } },
        '/transfers': { post: { summary: 'Execute atomic idempotent P2P wallet transfer' } },
        '/deposits/requests': { post: { summary: 'Submit deposit request with proof and reference' } },
        '/withdrawals/requests': { post: { summary: 'Request withdrawal into hold ledger with tier limits' } },
        '/statements': { get: { summary: 'Fetch date-range statement with opening/closing balances' } },
        '/admin/reconciliation': { get: { summary: 'Daily ledger vs settlement reconciliation' } },
      },
    });
  });

  router.get('/health', (_req, res) => {
    const invariant = ledgerService.verifyGlobalInvariant();
    res.json({
      status: 'ok',
      ledgerBalanced: invariant.valid,
      syncRevision: dbStore.syncRevision,
      cloudBackend: dbStore.getCloudBackend(),
    });
  });

  // Real-time Server-Sent Events stream for live balance & Back-Office queue updates
  router.get('/events/stream', (req: AuthenticatedRequest, res) => {
    const authHeader = req.headers.authorization;
    const rawToken =
      authHeader && authHeader.startsWith('Bearer ')
        ? authHeader.slice('Bearer '.length).trim()
        : typeof req.query.token === 'string'
          ? req.query.token.trim()
          : '';
    if (!rawToken) {
      return sendApiError(res, 401, 'UNAUTHORIZED', 'Missing access token for event stream', req.correlationId);
    }
    const claims = verifyAccessToken(rawToken);
    if (!claims) {
      return sendApiError(res, 401, 'UNAUTHORIZED', 'Invalid or expired access token', req.correlationId);
    }
    const session = dbStore.sessions.get(claims.sid);
    if (!session || session.revokedAt) {
      return sendApiError(res, 401, 'SESSION_REVOKED', 'Session has been revoked', req.correlationId);
    }
    const user = dbStore.users.get(claims.sub);
    if (!user) {
      return sendApiError(res, 401, 'UNAUTHORIZED', 'User not found', req.correlationId);
    }
    subscribeSseClient({
      userId: user.id,
      role: user.role,
      res,
      syncRevision: dbStore.syncRevision,
      syncedAt: dbStore.lastSyncedAt,
    });
  });

  // Cloud Sync endpoints (quick refresh button + multi-device reconciliation)
  router.get('/sync', requireAuth, async (req: AuthenticatedRequest, res) => {
    const force = req.query.force === 'true';
    const synced = await dbStore.syncFromCloud(force);
    const invariant = ledgerService.verifyGlobalInvariant();
    const isAdmin = ADMIN_ROLES.includes(req.authUser!.role);
    res.json({
      syncedAt: synced.syncedAt,
      syncRevision: synced.syncRevision,
      cloudBackend: synced.cloudBackend,
      ledgerBalanced: invariant.valid,
      ...(isAdmin
        ? {
            counts: {
              pendingDeposits: [...dbStore.depositRequests.values()].filter(
                (d) => d.status === DepositStatus.PENDING || d.status === DepositStatus.MAKER_APPROVED,
              ).length,
              pendingWithdrawals: [...dbStore.withdrawalRequests.values()].filter(
                (w) =>
                  w.status === WithdrawalStatus.PENDING ||
                  w.status === WithdrawalStatus.MAKER_APPROVED ||
                  w.status === WithdrawalStatus.CHECKER_APPROVED,
              ).length,
              pendingKyc: [...dbStore.users.values()].filter(
                (u) => !ADMIN_ROLES.includes(u.role) && (u.kycStatus === 'PENDING' || u.kycStatus === 'NEEDS_MORE_INFO'),
              ).length,
            },
          }
        : {}),
    });
  });

  router.post('/sync', requireAuth, async (req: AuthenticatedRequest, res) => {
    const synced = await dbStore.syncFromCloud(true);
    const invariant = ledgerService.verifyGlobalInvariant();
    const isAdmin = ADMIN_ROLES.includes(req.authUser!.role);
    broadcastSyncEvent({
      type: 'CLOUD_SYNCED',
      syncRevision: synced.syncRevision,
      syncedAt: synced.syncedAt,
      targetUserIds: [req.authUser!.id],
      notifyAdmins: isAdmin,
    });
    res.json({
      syncedAt: synced.syncedAt,
      syncRevision: synced.syncRevision,
      cloudBackend: synced.cloudBackend,
      ledgerBalanced: invariant.valid,
      ...(isAdmin
        ? {
            counts: {
              pendingDeposits: [...dbStore.depositRequests.values()].filter(
                (d) => d.status === DepositStatus.PENDING || d.status === DepositStatus.MAKER_APPROVED,
              ).length,
              pendingWithdrawals: [...dbStore.withdrawalRequests.values()].filter(
                (w) =>
                  w.status === WithdrawalStatus.PENDING ||
                  w.status === WithdrawalStatus.MAKER_APPROVED ||
                  w.status === WithdrawalStatus.CHECKER_APPROVED,
              ).length,
              pendingKyc: [...dbStore.users.values()].filter(
                (u) => !ADMIN_ROLES.includes(u.role) && (u.kycStatus === 'PENDING' || u.kycStatus === 'NEEDS_MORE_INFO'),
              ).length,
            },
          }
        : {}),
    });
  });

  // ==================== AUTH ====================
  router.get('/auth/config', (_req, res) => {
    res.json({
      sandboxMode: process.env.NODE_ENV !== 'production',
      superAdminEmail: getSuperAdminEmail(),
    });
  });

  router.post('/auth/register', authRateLimiter, async (req: AuthenticatedRequest, res) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendApiError(res, 400, 'VALIDATION_ERROR', parsed.error.issues[0].message, req.correlationId);
    }
    try {
      const result = await authService.register({
        ...parsed.data,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      setRefreshCookies(res, result.tokens.refreshToken);
      res.status(201).json({
        user: result.user,
        accessToken: result.tokens.accessToken,
        sessionId: result.tokens.sessionId,
        requiresPinSetup: result.tokens.requiresPinSetup,
        otpTarget: result.otpTarget,
        otpChannel: result.otpChannel,
        otpSent: result.otpSent,
        devOtpPreview: result.devOtpPreview,
      });
    } catch (err) {
      handleError(req, res, err);
    }
  });

  router.post('/auth/staff/register', authRateLimiter, async (req: AuthenticatedRequest, res) => {
    const parsed = staffRegisterSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendApiError(res, 400, 'VALIDATION_ERROR', parsed.error.issues[0].message, req.correlationId);
    }
    try {
      const result = await authService.registerStaff({
        ...parsed.data,
        requestedRole: parsed.data.requestedRole as Role,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      setRefreshCookies(res, result.tokens.refreshToken);
      res.status(201).json({
        user: result.user,
        accessToken: result.tokens.accessToken,
        sessionId: result.tokens.sessionId,
        requiresPinSetup: result.tokens.requiresPinSetup,
        otpTarget: result.otpTarget,
        otpChannel: result.otpChannel,
        otpSent: result.otpSent,
        devOtpPreview: result.devOtpPreview,
      });
    } catch (err) {
      handleError(req, res, err);
    }
  });

  router.post('/auth/login', authRateLimiter, async (req: AuthenticatedRequest, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendApiError(res, 400, 'VALIDATION_ERROR', parsed.error.issues[0].message, req.correlationId);
    }
    try {
      const result = await authService.login({
        ...parsed.data,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      if (result.requiresOtp) {
        return res.status(200).json({
          requiresOtp: true,
          user: result.user,
          devOtpPreview: result.devOtpPreview,
        });
      }
      setRefreshCookies(res, result.refreshToken);
      res.json({
        user: result.user,
        accessToken: result.accessToken,
        sessionId: result.sessionId,
        requiresPinSetup: result.requiresPinSetup,
      });
    } catch (err) {
      handleError(req, res, err);
    }
  });

  router.post('/auth/pin-login', authRateLimiter, pinRateLimiter, async (req: AuthenticatedRequest, res) => {
    const parsed = pinLoginSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendApiError(res, 400, 'VALIDATION_ERROR', parsed.error.issues[0].message, req.correlationId);
    }
    try {
      const result = await authService.loginWithPin({
        ...parsed.data,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      if (result.requiresOtp) {
        return res.status(200).json({
          requiresOtp: true,
          user: result.user,
          devOtpPreview: result.devOtpPreview,
        });
      }
      setRefreshCookies(res, result.refreshToken);
      res.json({
        user: result.user,
        accessToken: result.accessToken,
        sessionId: result.sessionId,
        requiresPinSetup: result.requiresPinSetup,
      });
    } catch (err) {
      handleError(req, res, err);
    }
  });

  router.post('/auth/google', authRateLimiter, async (req: AuthenticatedRequest, res) => {
    const idToken = typeof req.body?.idToken === 'string' ? req.body.idToken : '';
    if (!idToken) {
      return sendApiError(res, 400, 'VALIDATION_ERROR', 'Google idToken is required.', req.correlationId);
    }
    try {
      const result = await authService.loginWithGoogle({
        idToken,
        legalAccepted: req.body?.legalAccepted,
        deviceFingerprint: req.body?.deviceFingerprint,
        deviceLabel: req.body?.deviceLabel,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      setRefreshCookies(res, result.refreshToken);
      res.json({
        user: result.user,
        accessToken: result.accessToken,
        sessionId: result.sessionId,
        requiresPinSetup: result.requiresPinSetup,
      });
    } catch (err) {
      handleError(req, res, err);
    }
  });

  router.post('/auth/staff/google', authRateLimiter, async (req: AuthenticatedRequest, res) => {
    const idToken = typeof req.body?.idToken === 'string' ? req.body.idToken : '';
    if (!idToken) {
      return sendApiError(res, 400, 'VALIDATION_ERROR', 'Google idToken is required.', req.correlationId);
    }
    try {
      const result = await authService.loginOrRegisterStaffWithGoogle({
        idToken,
        requestedRole: req.body?.requestedRole as Role | undefined,
        legalAccepted: req.body?.legalAccepted,
        deviceFingerprint: req.body?.deviceFingerprint,
        deviceLabel: req.body?.deviceLabel,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      setRefreshCookies(res, result.refreshToken);
      res.json({
        user: result.user,
        accessToken: result.accessToken,
        sessionId: result.sessionId,
        requiresPinSetup: result.requiresPinSetup,
      });
    } catch (err) {
      handleError(req, res, err);
    }
  });

  router.post('/auth/otp/send', otpRateLimiter, async (req: AuthenticatedRequest, res) => {
    const parsed = otpSendSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendApiError(res, 400, 'VALIDATION_ERROR', parsed.error.issues[0].message, req.correlationId);
    }
    try {
      const user = [...dbStore.users.values()].find(
        (u) =>
          u.email?.toLowerCase() === parsed.data.target.toLowerCase() ||
          u.phone === parsed.data.target,
      );
      const result = await authService.sendOtp({
        userId: user?.id ?? null,
        target: parsed.data.target,
        channel: parsed.data.channel,
        purpose: parsed.data.purpose,
      });
      res.json(result);
    } catch (err) {
      handleError(req, res, err);
    }
  });

  router.post('/auth/otp/verify', otpRateLimiter, async (req: AuthenticatedRequest, res) => {
    const parsed = otpVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      return sendApiError(res, 400, 'VALIDATION_ERROR', parsed.error.issues[0].message, req.correlationId);
    }
    try {
      const result = await authService.verifyOtp(parsed.data);
      const authHeader = req.headers.authorization;
      if (result.verified && result.userId && authHeader?.startsWith('Bearer ')) {
        const claims = verifyAccessToken(authHeader.slice('Bearer '.length).trim());
        const user = dbStore.users.get(result.userId);
        if (claims && claims.sub === result.userId && user) {
          const upgraded = authService.createSession(user, {
            deviceFingerprint: 'otp-verified-session',
            deviceLabel: 'Verified Browser',
            ip: req.ip || '127.0.0.1',
            userAgent: req.headers['user-agent'] || 'PWA-Client',
            twoFactorVerified: true,
          });
          setRefreshCookies(res, upgraded.refreshToken);
          return res.json({
            ...result,
            accessToken: upgraded.accessToken,
            sessionId: upgraded.sessionId,
            user: upgraded.user,
            requiresPinSetup: !dbStore.pins.has(user.id),
          });
        }
      }
      res.json(result);
    } catch (err) {
      handleError(req, res, err);
    }
  });

  router.post('/auth/refresh', (req: AuthenticatedRequest, res) => {
    const refreshToken = req.cookies?.csw_refresh as string | undefined;
    if (!refreshToken) {
      return sendApiError(res, 401, 'MISSING_REFRESH_COOKIE', 'No refresh cookie present.', req.correlationId);
    }
    // CSRF double-submit check if csw_csrf cookie exists
    const csrfCookie = req.cookies?.csw_csrf as string | undefined;
    const csrfHeader = req.headers['x-csrf-token'] as string | undefined;
    if (csrfCookie && csrfHeader && csrfCookie !== csrfHeader) {
      return sendApiError(res, 403, 'CSRF_INVALID', 'CSRF token mismatch.', req.correlationId);
    }
    try {
      const result = authService.rotateRefreshToken(refreshToken, req.ip);
      setRefreshCookies(res, result.refreshToken);
      res.json({
        accessToken: result.accessToken,
        sessionId: result.sessionId,
        user: result.user,
      });
    } catch (err) {
      const { secure, sameSite } = getCookieSecurityOptions(res);
      res.clearCookie('csw_refresh', { path: '/api/v1/auth', httpOnly: true, secure, sameSite });
      handleError(req, res, err);
    }
  });

  router.post('/auth/logout', requireAuth, (req: AuthenticatedRequest, res) => {
    authService.revokeSession(req.authUser!.id, req.authUser!.sessionId);
    const { secure, sameSite } = getCookieSecurityOptions(res);
    res.clearCookie('csw_refresh', { path: '/api/v1/auth', httpOnly: true, secure, sameSite });
    res.clearCookie('csw_csrf', { path: '/', httpOnly: false, secure, sameSite });
    res.json({ loggedOut: true });
  });

  router.post('/auth/password/reset', authRateLimiter, async (req: AuthenticatedRequest, res) => {
    try {
      await authService.resetPassword({
        target: String(req.body?.target || ''),
        channel: req.body?.channel === 'SMS' ? 'SMS' : 'EMAIL',
        otpCode: String(req.body?.otpCode || ''),
        newPassword: String(req.body?.newPassword || ''),
      });
      res.json({ reset: true });
    } catch (err) {
      handleError(req, res, err);
    }
  });

  router.get('/auth/devices', requireAuth, (req: AuthenticatedRequest, res) => {
    res.json({ devices: authService.listSessions(req.authUser!.id) });
  });

  router.post('/auth/devices/:id/revoke', requireAuth, (req: AuthenticatedRequest, res) => {
    try {
      authService.revokeSession(req.authUser!.id, String(req.params.id));
      res.json({ revoked: true });
    } catch (err) {
      handleError(req, res, err);
    }
  });

  // ==================== PIN & STEP-UP ====================
  router.post('/pin/set', requireAuth, pinRateLimiter, async (req: AuthenticatedRequest, res) => {
    const parsed = pinSetSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendApiError(res, 400, 'VALIDATION_ERROR', parsed.error.issues[0].message, req.correlationId);
    }
    try {
      await pinService.setPin(req.authUser!.id, parsed.data.pin);
      res.json({ pinConfigured: true });
    } catch (err) {
      handleError(req, res, err);
    }
  });

  router.post('/pin/verify', requireAuth, pinRateLimiter, async (req: AuthenticatedRequest, res) => {
    const parsed = pinVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      return sendApiError(res, 400, 'VALIDATION_ERROR', parsed.error.issues[0].message, req.correlationId);
    }
    try {
      const result = await pinService.verifyPinAndIssueStepUp({
        userId: req.authUser!.id,
        ...parsed.data,
      });
      res.json(result);
    } catch (err) {
      handleError(req, res, err);
    }
  });

  router.post('/pin/change', requireAuth, pinRateLimiter, async (req: AuthenticatedRequest, res) => {
    try {
      await pinService.changePin(req.authUser!.id, String(req.body?.currentPin || ''), String(req.body?.newPin || ''));
      res.json({ changed: true });
    } catch (err) {
      handleError(req, res, err);
    }
  });

  router.post('/pin/reset', requireAuth, pinRateLimiter, async (req: AuthenticatedRequest, res) => {
    try {
      await pinService.resetPin({
        userId: req.authUser!.id,
        password: String(req.body?.password || ''),
        otpCode: String(req.body?.otpCode || ''),
        target: String(req.body?.target || ''),
        channel: req.body?.channel === 'SMS' ? 'SMS' : 'EMAIL',
        newPin: String(req.body?.newPin || ''),
      });
      res.json({ reset: true });
    } catch (err) {
      handleError(req, res, err);
    }
  });

  // ==================== PROFILE & KYC ====================
  router.get('/me', requireAuth, (req: AuthenticatedRequest, res) => {
    const user = dbStore.users.get(req.authUser!.id);
    if (!user) return sendApiError(res, 404, 'USER_NOT_FOUND', 'User not found', req.correlationId);
    const kyc = kycService.getStatusForUser(user.id);
    res.json({
      user: authService.sanitizeUser(user),
      pinConfigured: dbStore.pins.has(user.id),
      kyc,
      notificationPreferences: notificationService.getPreferences(user.id),
    });
  });

  router.patch('/me', requireAuth, (req: AuthenticatedRequest, res) => {
    const user = dbStore.users.get(req.authUser!.id);
    if (!user) return sendApiError(res, 404, 'USER_NOT_FOUND', 'User not found', req.correlationId);
    const profile = dbStore.userProfiles.get(user.id);
    if (profile && typeof req.body?.address === 'string' && req.body.address.trim().length >= 5) {
      profile.address = req.body.address.trim();
      profile.updatedAt = new Date().toISOString();
    }
    res.json({ updated: true });
  });

  router.post('/kyc/documents', requireAuth, async (req: AuthenticatedRequest, res) => {
    const parsed = kycSubmitSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendApiError(res, 400, 'VALIDATION_ERROR', parsed.error.issues[0].message, req.correlationId);
    }
    try {
      const result = await kycService.submitKyc(req.authUser!.id, parsed.data);
      res.status(201).json(result);
    } catch (err) {
      handleError(req, res, err);
    }
  });

  router.get('/kyc/status', requireAuth, (req: AuthenticatedRequest, res) => {
    try {
      res.json(kycService.getStatusForUser(req.authUser!.id));
    } catch (err) {
      handleError(req, res, err);
    }
  });

  // ==================== ACCOUNTS ====================
  router.get('/accounts', requireAuth, async (req: AuthenticatedRequest, res) => {
    if (dbStore.getCloudBackend() === 'firestore') {
      await dbStore.syncFromCloud();
    }
    const user = dbStore.users.get(req.authUser!.id);
    const accounts = accountsService.listUserAccounts(req.authUser!.id).map((acc) => {
      const withdrawalRule = rulesService.getLimitRule(
        req.authUser!.id,
        user?.kycTier || 1,
        TransactionType.WITHDRAWAL,
        acc.currency,
      );
      const withdrawalUsage = rulesService.getUsageTotals(
        req.authUser!.id,
        acc.id,
        TransactionType.WITHDRAWAL,
        acc.currency,
      );
      return {
        ...acc,
        withdrawalLimits: {
          perTxnMaxMinor: withdrawalRule.perTxnMaxMinor,
          dailyMaxMinor: withdrawalRule.dailyMaxMinor,
          monthlyMaxMinor: withdrawalRule.monthlyMaxMinor,
          dailyUsedMinor: withdrawalUsage.dailyUsedMinor,
          monthlyUsedMinor: withdrawalUsage.monthlyUsedMinor,
        },
      };
    });
    res.json({ accounts });
  });

  router.get('/accounts/:id/balance', requireAuth, requireViewStepUp, async (req: AuthenticatedRequest, res) => {
    try {
      if (dbStore.getCloudBackend() === 'firestore') {
        await dbStore.syncFromCloud();
      }
      const bal = accountsService.getVerifiedBalance(req.authUser!.id, String(req.params.id));
      res.json(bal);
    } catch (err) {
      handleError(req, res, err);
    }
  });

  router.get('/accounts/lookup/:accountNumber', requireAuth, (req: AuthenticatedRequest, res) => {
    try {
      const info = accountsService.lookupByAccountNumber(String(req.params.accountNumber));
      const amountMinor = Number(req.query.amountMinor || 0);
      const feeMinor =
        Number.isSafeInteger(amountMinor) && amountMinor > 0
          ? rulesService.computeFee(TransactionType.TRANSFER, info.currency, amountMinor)
          : 0;
      res.json({ ...info, feeMinor });
    } catch (err) {
      handleError(req, res, err);
    }
  });

  router.get('/fees/preview', requireAuth, (req: AuthenticatedRequest, res) => {
    const type = (req.query.type as TransactionType) || TransactionType.TRANSFER;
    const currency = (req.query.currency as Currency) || Currency.USD;
    const amountMinor = Number(req.query.amountMinor || 0);
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
      return res.json({ feeMinor: 0, totalMinor: 0 });
    }
    const feeMinor = rulesService.computeFee(type, currency, amountMinor);
    res.json({ feeMinor, totalMinor: amountMinor + feeMinor });
  });

  // ==================== TRANSACTIONS, DEPOSITS, TRANSFERS, WITHDRAWALS ====================
  router.get('/transactions', requireAuth, async (req: AuthenticatedRequest, res) => {
    if (dbStore.getCloudBackend() === 'firestore') {
      await dbStore.syncFromCloud();
    }
    const accountId = typeof req.query.accountId === 'string' ? req.query.accountId : undefined;
    const txns = transactionsService.listUserTransactions(req.authUser!.id, accountId);
    res.json({ transactions: txns });
  });

  router.get('/transactions/:id/receipt', requireAuth, (req: AuthenticatedRequest, res) => {
    try {
      const pdf = statementsService.generateReceiptPdf(req.authUser!.id, String(req.params.id));
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="receipt-${req.params.id}.pdf"`);
      res.send(pdf);
    } catch (err) {
      handleError(req, res, err);
    }
  });

  router.get('/deposits/requests', requireAuth, async (req: AuthenticatedRequest, res) => {
    if (dbStore.getCloudBackend() === 'firestore') {
      await dbStore.syncFromCloud();
    }
    res.json({ deposits: transactionsService.listDepositsForUser(req.authUser!.id) });
  });

  router.post(
    '/deposits/requests',
    requireAuth,
    moneyRateLimiter,
    requireIdempotencyKey,
    async (req: AuthenticatedRequest, res) => {
      const parsed = depositRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return sendApiError(res, 400, 'VALIDATION_ERROR', parsed.error.issues[0].message, req.correlationId);
      }
      try {
        const dep = await transactionsService.submitDepositRequest({
          userId: req.authUser!.id,
          ...parsed.data,
          idempotencyKey: req.idempotencyKey!,
        });
        res.status(201).json({ deposit: dep });
      } catch (err) {
        handleError(req, res, err);
      }
    },
  );

  router.post(
    '/transfers',
    requireAuth,
    moneyRateLimiter,
    requireIdempotencyKey,
    async (req: AuthenticatedRequest, res) => {
      const parsed = transferSchema.safeParse(req.body);
      if (!parsed.success) {
        return sendApiError(res, 400, 'VALIDATION_ERROR', parsed.error.issues[0].message, req.correlationId);
      }
      const fromAccount = dbStore.accounts.get(parsed.data.fromAccountId);
      if (!fromAccount || fromAccount.userId !== req.authUser!.id) {
        return sendApiError(res, 404, 'ACCOUNT_NOT_FOUND', 'Source wallet not found.', req.correlationId);
      }
      const stepUpCheck = verifyAndConsumeTransactionStepUp(
        req,
        'transfer',
        parsed.data.amountMinor,
        fromAccount.currency,
      );
      if (!stepUpCheck.ok) {
        return sendApiError(res, 403, stepUpCheck.code, stepUpCheck.message, req.correlationId);
      }
      try {
        const transaction = await transactionsService.executeTransfer({
          userId: req.authUser!.id,
          ...parsed.data,
          idempotencyKey: req.idempotencyKey!,
        });
        res.status(201).json({ transaction });
      } catch (err) {
        handleError(req, res, err);
      }
    },
  );

  router.get('/withdrawals/requests', requireAuth, async (req: AuthenticatedRequest, res) => {
    if (dbStore.getCloudBackend() === 'firestore') {
      await dbStore.syncFromCloud();
    }
    res.json({ withdrawals: transactionsService.listWithdrawalsForUser(req.authUser!.id) });
  });

  router.post(
    '/withdrawals/requests',
    requireAuth,
    moneyRateLimiter,
    requireIdempotencyKey,
    async (req: AuthenticatedRequest, res) => {
      const parsed = withdrawalRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return sendApiError(res, 400, 'VALIDATION_ERROR', parsed.error.issues[0].message, req.correlationId);
      }
      const account = dbStore.accounts.get(parsed.data.accountId);
      if (!account || account.userId !== req.authUser!.id) {
        return sendApiError(res, 404, 'ACCOUNT_NOT_FOUND', 'Source wallet not found.', req.correlationId);
      }
      const stepUpCheck = verifyAndConsumeTransactionStepUp(
        req,
        'withdrawal',
        parsed.data.amountMinor,
        account.currency,
      );
      if (!stepUpCheck.ok) {
        return sendApiError(res, 403, stepUpCheck.code, stepUpCheck.message, req.correlationId);
      }
      try {
        const withdrawal = await transactionsService.requestWithdrawal({
          userId: req.authUser!.id,
          ...parsed.data,
          idempotencyKey: req.idempotencyKey!,
        });
        res.status(201).json({ withdrawal });
      } catch (err) {
        handleError(req, res, err);
      }
    },
  );

  // ==================== STATEMENTS ====================
  router.get('/statements', requireAuth, requireViewStepUp, (req: AuthenticatedRequest, res) => {
    try {
      const accountId = String(req.query.accountId || '');
      const from = String(req.query.from || new Date(Date.now() - 30 * 86400_000).toISOString());
      const to = String(req.query.to || new Date().toISOString());
      const report = statementsService.buildStatement(req.authUser!.id, accountId, from, to);
      res.json({ statement: report });
    } catch (err) {
      handleError(req, res, err);
    }
  });

  router.post('/statements/export', requireAuth, requireViewStepUp, (req: AuthenticatedRequest, res) => {
    try {
      const result = statementsService.enqueueExportJob({
        userId: req.authUser!.id,
        accountId: String(req.body?.accountId || ''),
        from: String(req.body?.from || new Date(Date.now() - 30 * 86400_000).toISOString()),
        to: String(req.body?.to || new Date().toISOString()),
        format: req.body?.format === 'PDF' ? 'PDF' : 'CSV',
      });
      res.status(201).json(result);
    } catch (err) {
      handleError(req, res, err);
    }
  });

  // ==================== NOTIFICATIONS ====================
  router.get('/notifications', requireAuth, (req: AuthenticatedRequest, res) => {
    res.json({ notifications: notificationService.listForUser(req.authUser!.id) });
  });

  router.post('/notifications/:id/read', requireAuth, (req: AuthenticatedRequest, res) => {
    notificationService.markRead(req.authUser!.id, String(req.params.id));
    res.json({ read: true });
  });

  router.post('/push/subscribe', requireAuth, (req: AuthenticatedRequest, res) => {
    const endpoint = String(req.body?.endpoint || '');
    if (!endpoint) {
      return sendApiError(res, 400, 'VALIDATION_ERROR', 'Push endpoint required.', req.correlationId);
    }
    dbStore.pushSubscriptions.set(req.authUser!.id, {
      userId: req.authUser!.id,
      endpoint,
      keys: req.body?.keys || {},
    });
    res.json({ subscribed: true });
  });

  router.patch('/notification-preferences', requireAuth, (req: AuthenticatedRequest, res) => {
    const prefs = notificationService.updatePreferences(req.authUser!.id, {
      emailReceipts: typeof req.body?.emailReceipts === 'boolean' ? req.body.emailReceipts : undefined,
      pushTransactions: typeof req.body?.pushTransactions === 'boolean' ? req.body.pushTransactions : undefined,
      smsTransactions: typeof req.body?.smsTransactions === 'boolean' ? req.body.smsTransactions : undefined,
    });
    res.json({ preferences: prefs });
  });

  // ==================== PRIVATE SIGNED STORAGE ====================
  router.get('/storage/signed', (req: AuthenticatedRequest, res) => {
    const key = String(req.query.key || '');
    const exp = String(req.query.exp || '');
    const sig = String(req.query.sig || '');
    if (!verifyStorageSignature(key, exp, sig)) {
      return sendApiError(res, 403, 'SIGNED_URL_INVALID', 'Signed URL is invalid or expired.', req.correlationId);
    }
    const blob = dbStore.privateBlobs.get(key);
    if (!blob) {
      return sendApiError(res, 404, 'OBJECT_NOT_FOUND', 'Private object not found.', req.correlationId);
    }
    const decrypted = decryptBuffer(blob.encryptedPayload);
    res.setHeader('Content-Type', blob.mimeType);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(decrypted);
  });

  // ==================== ADMIN BACK-OFFICE ====================
  router.get('/admin/overview', requireAuth, requirePermission('transactions:read'), async (_req, res) => {
    if (dbStore.getCloudBackend() === 'firestore') {
      await dbStore.syncFromCloud();
    }
    res.json(adminService.getOverviewMetrics());
  });

  router.get('/admin/kyc', requireAuth, requirePermission('kyc:read'), async (_req, res) => {
    if (dbStore.getCloudBackend() === 'firestore') {
      await dbStore.syncFromCloud();
    }
    res.json({ queue: kycService.listKycQueueForOfficer() });
  });

  router.post('/admin/kyc/:userId/decision', requireAuth, requirePermission('kyc:decide'), requireAdminPinStepUp('kyc_decide'), async (req: AuthenticatedRequest, res) => {
    const decision = req.body?.decision;
    if (!['APPROVED', 'REJECTED', 'NEEDS_MORE_INFO'].includes(decision)) {
      return sendApiError(res, 400, 'VALIDATION_ERROR', 'Invalid KYC decision.', req.correlationId);
    }
    try {
      const result = await kycService.decideKyc({
        targetUserId: String(req.params.userId),
        officerId: req.authUser!.id,
        decision,
        reason: req.body?.reason,
      });
      res.json(result);
    } catch (err) {
      handleError(req, res, err);
    }
  });

  router.get('/admin/deposits', requireAuth, requirePermission('deposits:read'), async (_req, res) => {
    if (dbStore.getCloudBackend() === 'firestore') {
      await dbStore.syncFromCloud();
    }
    const items = [...dbStore.depositRequests.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((d) => {
        const user = dbStore.users.get(d.userId);
        const profile = dbStore.userProfiles.get(d.userId);
        return {
          ...d,
          userEmail: user?.email,
          userName: profile?.fullName || 'Unknown',
        };
      });
    res.json({ deposits: items });
  });

  router.post('/admin/deposits/:id/approve', requireAuth, async (req: AuthenticatedRequest, res) => {
    const depositId = String(req.params.id);
    const idemHeader = req.headers['idempotency-key'];
    const idemKey = typeof idemHeader === 'string' && idemHeader.trim() ? idemHeader.trim() : null;
    if (idemKey) {
      try {
        const hitCheck = dbStore.checkIdempotency('adm_dep_app', req.authUser!.id, idemKey, {
          depositId,
          expectedStatus: req.body?.expectedStatus || null,
        });
        if (hitCheck.hit) {
          return res.status(hitCheck.record.statusCode).json(hitCheck.record.body);
        }
      } catch (err) {
        return handleError(req, res, err);
      }
    }

    const dep = dbStore.depositRequests.get(depositId);
    if (!dep) return sendApiError(res, 404, 'NOT_FOUND', 'Deposit request not found.', req.correlationId);
    const expectedStatus = req.body?.expectedStatus as DepositStatus | undefined;

    try {
      if (dep.status === DepositStatus.PENDING) {
        return requirePermission('deposits:make')(req, res, () =>
          requireAdminPinStepUp('deposit_approve')(req, res, async () => {
            try {
              const updated = await transactionsService.makerApproveDeposit(dep.id, req.authUser!.id, req.body?.notes, expectedStatus);
              const payload = { deposit: updated };
              if (idemKey) {
                const slot = dbStore.checkIdempotency('adm_dep_app', req.authUser!.id, idemKey, {
                  depositId,
                  expectedStatus: req.body?.expectedStatus || null,
                });
                if (!slot.hit) {
                  dbStore.recordIdempotencyResponse({
                    cacheKey: slot.cacheKey,
                    scope: 'adm_dep_app',
                    userId: req.authUser!.id,
                    key: idemKey,
                    payloadHash: slot.payloadHash,
                    statusCode: 200,
                    body: payload,
                  });
                }
              }
              res.json(payload);
            } catch (e) {
              handleError(req, res, e);
            }
          }),
        );
      }
      return requirePermission('deposits:check')(req, res, () =>
        requireAdminPinStepUp('deposit_approve')(req, res, async () => {
          try {
            const updated = await transactionsService.checkerApproveDeposit(dep.id, req.authUser!.id, req.body?.notes, expectedStatus);
            const payload = { deposit: updated };
            if (idemKey) {
              const slot = dbStore.checkIdempotency('adm_dep_app', req.authUser!.id, idemKey, {
                depositId,
                expectedStatus: req.body?.expectedStatus || null,
              });
              if (!slot.hit) {
                dbStore.recordIdempotencyResponse({
                  cacheKey: slot.cacheKey,
                  scope: 'adm_dep_app',
                  userId: req.authUser!.id,
                  key: idemKey,
                  payloadHash: slot.payloadHash,
                  statusCode: 200,
                  body: payload,
                });
              }
            }
            res.json(payload);
          } catch (e) {
            handleError(req, res, e);
          }
        }),
      );
    } catch (err) {
      handleError(req, res, err);
    }
  });

  router.post('/admin/deposits/:id/reject', requireAuth, requirePermission('deposits:make'), requireAdminPinStepUp('deposit_reject'), async (req: AuthenticatedRequest, res) => {
    const depositId = String(req.params.id);
    const idemHeader = req.headers['idempotency-key'];
    const idemKey = typeof idemHeader === 'string' && idemHeader.trim() ? idemHeader.trim() : null;
    try {
      let idemSlot: { hit: false; cacheKey: string; payloadHash: string } | null = null;
      if (idemKey) {
        const chk = dbStore.checkIdempotency('adm_dep_rej', req.authUser!.id, idemKey, {
          depositId,
          reason: String(req.body?.reason || ''),
        });
        if (chk.hit) return res.status(chk.record.statusCode).json(chk.record.body);
        idemSlot = chk;
      }
      const updated = await transactionsService.rejectDeposit(
        depositId,
        req.authUser!.id,
        String(req.body?.reason || ''),
        req.body?.expectedStatus as DepositStatus | undefined,
      );
      const payload = { deposit: updated };
      if (idemSlot && idemKey) {
        dbStore.recordIdempotencyResponse({
          cacheKey: idemSlot.cacheKey,
          scope: 'adm_dep_rej',
          userId: req.authUser!.id,
          key: idemKey,
          payloadHash: idemSlot.payloadHash,
          statusCode: 200,
          body: payload,
        });
      }
      res.json(payload);
    } catch (err) {
      handleError(req, res, err);
    }
  });

  router.get('/admin/withdrawals', requireAuth, requirePermission('withdrawals:read'), async (_req, res) => {
    if (dbStore.getCloudBackend() === 'firestore') {
      await dbStore.syncFromCloud();
    }
    const items = [...dbStore.withdrawalRequests.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((w) => {
        const user = dbStore.users.get(w.userId);
        const profile = dbStore.userProfiles.get(w.userId);
        return {
          ...w,
          destinationDecrypted: decryptField(w.destinationDetailsEncrypted),
          userEmail: user?.email,
          userName: profile?.fullName || 'Unknown',
        };
      });
    res.json({ withdrawals: items });
  });

  router.post('/admin/withdrawals/:id/approve', requireAuth, async (req: AuthenticatedRequest, res) => {
    const withdrawalId = String(req.params.id);
    const idemHeader = req.headers['idempotency-key'];
    const idemKey = typeof idemHeader === 'string' && idemHeader.trim() ? idemHeader.trim() : null;
    if (idemKey) {
      try {
        const hitCheck = dbStore.checkIdempotency('adm_wdr_app', req.authUser!.id, idemKey, {
          withdrawalId,
          expectedStatus: req.body?.expectedStatus || null,
        });
        if (hitCheck.hit) {
          return res.status(hitCheck.record.statusCode).json(hitCheck.record.body);
        }
      } catch (err) {
        return handleError(req, res, err);
      }
    }

    const wdr = dbStore.withdrawalRequests.get(withdrawalId);
    if (!wdr) return sendApiError(res, 404, 'NOT_FOUND', 'Withdrawal not found.', req.correlationId);
    const expectedStatus = req.body?.expectedStatus as WithdrawalStatus | undefined;

    if (wdr.status === WithdrawalStatus.PENDING) {
      return requirePermission('withdrawals:make')(req, res, () =>
        requireAdminPinStepUp('withdrawal_approve')(req, res, async () => {
          try {
            const updated = await transactionsService.makerApproveWithdrawal(wdr.id, req.authUser!.id, expectedStatus);
            const payload = { withdrawal: updated };
            if (idemKey) {
              const slot = dbStore.checkIdempotency('adm_wdr_app', req.authUser!.id, idemKey, {
                withdrawalId,
                expectedStatus: req.body?.expectedStatus || null,
              });
              if (!slot.hit) {
                dbStore.recordIdempotencyResponse({
                  cacheKey: slot.cacheKey,
                  scope: 'adm_wdr_app',
                  userId: req.authUser!.id,
                  key: idemKey,
                  payloadHash: slot.payloadHash,
                  statusCode: 200,
                  body: payload,
                });
              }
            }
            res.json(payload);
          } catch (e) {
            handleError(req, res, e);
          }
        }),
      );
    }
    return requirePermission('withdrawals:check')(req, res, () =>
      requireAdminPinStepUp('withdrawal_approve')(req, res, async () => {
        try {
          const updated = await transactionsService.checkerApproveWithdrawal(wdr.id, req.authUser!.id, expectedStatus);
          const payload = { withdrawal: updated };
          if (idemKey) {
            const slot = dbStore.checkIdempotency('adm_wdr_app', req.authUser!.id, idemKey, {
              withdrawalId,
              expectedStatus: req.body?.expectedStatus || null,
            });
            if (!slot.hit) {
              dbStore.recordIdempotencyResponse({
                cacheKey: slot.cacheKey,
                scope: 'adm_wdr_app',
                userId: req.authUser!.id,
                key: idemKey,
                payloadHash: slot.payloadHash,
                statusCode: 200,
                body: payload,
              });
            }
          }
          res.json(payload);
        } catch (e) {
          handleError(req, res, e);
        }
      }),
    );
  });

  router.post('/admin/withdrawals/:id/mark-paid', requireAuth, requirePermission('withdrawals:payout'), requireAdminPinStepUp('withdrawal_payout'), async (req: AuthenticatedRequest, res) => {
    const withdrawalId = String(req.params.id);
    const idemHeader = req.headers['idempotency-key'];
    const idemKey = typeof idemHeader === 'string' && idemHeader.trim() ? idemHeader.trim() : null;
    try {
      let idemSlot: { hit: false; cacheKey: string; payloadHash: string } | null = null;
      if (idemKey) {
        const chk = dbStore.checkIdempotency('adm_wdr_paid', req.authUser!.id, idemKey, {
          withdrawalId,
          payoutReference: String(req.body?.payoutReference || ''),
        });
        if (chk.hit) return res.status(chk.record.statusCode).json(chk.record.body);
        idemSlot = chk;
      }
      const updated = await transactionsService.markWithdrawalPaid(
        withdrawalId,
        req.authUser!.id,
        String(req.body?.payoutReference || ''),
        req.body?.expectedStatus as WithdrawalStatus | undefined,
      );
      const payload = { withdrawal: updated };
      if (idemSlot && idemKey) {
        dbStore.recordIdempotencyResponse({
          cacheKey: idemSlot.cacheKey,
          scope: 'adm_wdr_paid',
          userId: req.authUser!.id,
          key: idemKey,
          payloadHash: idemSlot.payloadHash,
          statusCode: 200,
          body: payload,
        });
      }
      res.json(payload);
    } catch (err) {
      handleError(req, res, err);
    }
  });

  router.post('/admin/withdrawals/:id/reject', requireAuth, requirePermission('withdrawals:make'), requireAdminPinStepUp('withdrawal_reject'), async (req: AuthenticatedRequest, res) => {
    const withdrawalId = String(req.params.id);
    const idemHeader = req.headers['idempotency-key'];
    const idemKey = typeof idemHeader === 'string' && idemHeader.trim() ? idemHeader.trim() : null;
    try {
      let idemSlot: { hit: false; cacheKey: string; payloadHash: string } | null = null;
      if (idemKey) {
        const chk = dbStore.checkIdempotency('adm_wdr_rej', req.authUser!.id, idemKey, {
          withdrawalId,
          reason: String(req.body?.reason || ''),
        });
        if (chk.hit) return res.status(chk.record.statusCode).json(chk.record.body);
        idemSlot = chk;
      }
      const updated = await transactionsService.rejectWithdrawal(
        withdrawalId,
        req.authUser!.id,
        String(req.body?.reason || ''),
        req.body?.expectedStatus as WithdrawalStatus | undefined,
      );
      const payload = { withdrawal: updated };
      if (idemSlot && idemKey) {
        dbStore.recordIdempotencyResponse({
          cacheKey: idemSlot.cacheKey,
          scope: 'adm_wdr_rej',
          userId: req.authUser!.id,
          key: idemKey,
          payloadHash: idemSlot.payloadHash,
          statusCode: 200,
          body: payload,
        });
      }
      res.json(payload);
    } catch (err) {
      handleError(req, res, err);
    }
  });

  router.get('/admin/users', requireAuth, requirePermission('users:read'), async (req, res) => {
    if (dbStore.getCloudBackend() === 'firestore') {
      await dbStore.syncFromCloud();
    }
    const q = String(req.query.q || '').trim().toLowerCase();
    const list = [...dbStore.users.values()]
      .filter((u) => {
        if (!q) return true;
        const prof = dbStore.userProfiles.get(u.id);
        return (
          u.email?.toLowerCase().includes(q) ||
          u.phone?.toLowerCase().includes(q) ||
          prof?.fullName.toLowerCase().includes(q) ||
          u.id.toLowerCase().includes(q)
        );
      })
      .map((u) => {
        const prof = dbStore.userProfiles.get(u.id);
        const accounts = accountsService.listUserAccounts(u.id).map((a) => ({
          ...a,
          balanceMinor: accountsService.getVerifiedBalance(u.id, a.id).balanceMinor,
        }));
        const notes = [...dbStore.supportNotes.values()].filter((n) => n.userId === u.id);
        return {
          ...authService.sanitizeUser(u),
          fullName: prof?.fullName || null,
          country: prof?.country || null,
          accounts,
          notes,
        };
      });
    res.json({ users: list });
  });

  router.post('/admin/users/:id/freeze', requireAuth, requirePermission('users:freeze'), requireAdminPinStepUp('user_freeze'), async (req: AuthenticatedRequest, res) => {
    try {
      const user = await adminService.freezeOrUnfreezeUser({
        targetUserId: String(req.params.id),
        adminId: req.authUser!.id,
        freeze: true,
        reason: String(req.body?.reason || ''),
      });
      res.json({ user: authService.sanitizeUser(user) });
    } catch (err) {
      handleError(req, res, err);
    }
  });

  router.post('/admin/users/:id/unfreeze', requireAuth, requirePermission('users:freeze'), requireAdminPinStepUp('user_unfreeze'), async (req: AuthenticatedRequest, res) => {
    try {
      const user = await adminService.freezeOrUnfreezeUser({
        targetUserId: String(req.params.id),
        adminId: req.authUser!.id,
        freeze: false,
        reason: String(req.body?.reason || ''),
      });
      res.json({ user: authService.sanitizeUser(user) });
    } catch (err) {
      handleError(req, res, err);
    }
  });

  router.post('/admin/users/:id/notes', requireAuth, requirePermission('users:note'), (req: AuthenticatedRequest, res) => {
    try {
      const note = adminService.addSupportNote(String(req.params.id), req.authUser!.id, String(req.body?.note || ''));
      res.status(201).json({ note });
    } catch (err) {
      handleError(req, res, err);
    }
  });

  router.get('/admin/transactions', requireAuth, requirePermission('transactions:read'), async (req, res) => {
    if (dbStore.getCloudBackend() === 'firestore') {
      await dbStore.syncFromCloud();
    }
    const q = String(req.query.q || '').trim().toLowerCase();
    const txns = [...dbStore.transactions.values()]
      .filter((t) => !q || t.reference.toLowerCase().includes(q) || t.id.toLowerCase().includes(q))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((t) => {
        const entry = dbStore.journalEntries.find((e) => e.transactionId === t.id);
        const lines = entry ? dbStore.journalLines.filter((l) => l.entryId === entry.id) : [];
        return { ...t, journalEntry: entry, journalLines: lines };
      });
    res.json({ transactions: txns });
  });

  router.post('/admin/transactions/:id/reverse', requireAuth, requirePermission('transactions:reverse'), requireAdminPinStepUp('transaction_reverse'), async (req: AuthenticatedRequest, res) => {
    const txnId = String(req.params.id);
    const idemHeader = req.headers['idempotency-key'];
    const idemKey = typeof idemHeader === 'string' && idemHeader.trim() ? idemHeader.trim() : `rev_${txnId}`;
    try {
      const idemChk = dbStore.checkIdempotency('adm_txn_rev', req.authUser!.id, idemKey, {
        txnId,
        reason: String(req.body?.reason || 'Administrative reversal'),
      });
      if (idemChk.hit) {
        return res.status(idemChk.record.statusCode).json(idemChk.record.body);
      }
      const rev = await ledgerService.reverseTransaction(
        txnId,
        String(req.body?.reason || 'Administrative reversal'),
        `rev_${txnId}_${idemKey}`,
      );
      const payload = { reversal: rev };
      dbStore.recordIdempotencyResponse({
        cacheKey: idemChk.cacheKey,
        scope: 'adm_txn_rev',
        userId: req.authUser!.id,
        key: idemKey,
        payloadHash: idemChk.payloadHash,
        statusCode: 201,
        body: payload,
      });
      broadcastSyncEvent({
        type: 'TRANSACTION_REVERSED',
        syncRevision: dbStore.syncRevision,
        syncedAt: dbStore.lastSyncedAt,
        entityId: txnId,
        notifyAdmins: true,
      });
      res.status(201).json(payload);
    } catch (err) {
      handleError(req, res, err);
    }
  });

  router.get('/admin/fees', requireAuth, requirePermission('fees:read'), (_req, res) => {
    rulesService.ensureDefaultRules();
    res.json({ feeRules: [...dbStore.feeRules.values()] });
  });

  router.put('/admin/fees', requireAuth, requirePermission('fees:write'), requireAdminPinStepUp('fees_write'), (req: AuthenticatedRequest, res) => {
    const parsed = feeRuleUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendApiError(res, 400, 'VALIDATION_ERROR', parsed.error.issues[0].message, req.correlationId);
    }
    const approval = approvalsService.requestChange({
      entityType: 'FEE_RULE',
      entityId: `fee_${parsed.data.transactionType}_${parsed.data.currency}`,
      payload: parsed.data,
      requestedBy: req.authUser!.id,
      reason: req.body?.reason || 'Fee schedule adjustment',
    });
    res.status(202).json({ approval, message: 'Fee rule change queued for second Super Admin approval.' });
  });

  router.get('/admin/limits', requireAuth, requirePermission('limits:read'), (_req, res) => {
    rulesService.ensureDefaultRules();
    res.json({ limitRules: [...dbStore.limitRules.values()] });
  });

  router.put('/admin/limits', requireAuth, requirePermission('limits:write'), requireAdminPinStepUp('limits_write'), (req: AuthenticatedRequest, res) => {
    const parsed = limitRuleUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendApiError(res, 400, 'VALIDATION_ERROR', parsed.error.issues[0].message, req.correlationId);
    }
    const approval = approvalsService.requestChange({
      entityType: 'LIMIT_RULE',
      entityId: `lim_${parsed.data.scope}_${parsed.data.scopeId}_${parsed.data.transactionType}_${parsed.data.currency}`,
      payload: parsed.data,
      requestedBy: req.authUser!.id,
      reason: req.body?.reason || 'Limit rule adjustment',
    });
    res.status(202).json({ approval, message: 'Limit rule change queued for second Super Admin approval.' });
  });

  router.get('/admin/rbac', requireAuth, requirePermission('staff:read'), (_req, res) => {
    res.json({ rules: rbacService.listRules() });
  });

  router.get('/admin/staff', requireAuth, requirePermission('staff:read'), (_req, res) => {
    res.json(adminService.listStaffDirectory());
  });

  router.post('/admin/staff/:id/approve', requireAuth, requirePermission('staff:write'), requireAdminPinStepUp('staff_approve'), async (req: AuthenticatedRequest, res) => {
    const decision = req.body?.decision === 'REJECTED' ? 'REJECTED' : 'APPROVED';
    const assignedRole = req.body?.assignedRole as Role | undefined;
    if (assignedRole && !ADMIN_ROLES.includes(assignedRole)) {
      return sendApiError(res, 400, 'INVALID_ROLE', 'Invalid admin role.', req.correlationId);
    }
    try {
      const staff = await adminService.approveOrPromoteStaff({
        targetUserId: String(req.params.id),
        superAdminId: req.authUser!.id,
        decision,
        assignedRole,
        reason: typeof req.body?.reason === 'string' ? req.body.reason : undefined,
      });
      res.json({ staff });
    } catch (err) {
      handleError(req, res, err);
    }
  });

  router.post('/admin/staff/:id/role', requireAuth, requirePermission('staff:write'), requireAdminPinStepUp('staff_role'), (req: AuthenticatedRequest, res) => {
    const newRole = req.body?.role as Role;
    if (!ADMIN_ROLES.includes(newRole)) {
      return sendApiError(res, 400, 'INVALID_ROLE', 'Invalid admin role.', req.correlationId);
    }
    const approval = adminService.requestStaffRoleChange(
      String(req.params.id),
      newRole,
      req.authUser!.id,
      String(req.body?.reason || 'Staff role update'),
    );
    res.status(202).json({ approval, message: 'Role change queued for second approver.' });
  });

  router.post('/admin/approvals/:id/decide', requireAuth, requirePermission('approvals:decide'), requireAdminPinStepUp('approval_decide'), (req: AuthenticatedRequest, res) => {
    const decision = req.body?.decision === 'REJECTED' ? 'REJECTED' : 'APPROVED';
    try {
      const updated = approvalsService.decideChange(String(req.params.id), req.authUser!.id, decision, req.body?.reason);
      res.json({ approval: updated });
    } catch (err) {
      handleError(req, res, err);
    }
  });

  router.get('/admin/audit-logs', requireAuth, requirePermission('audit:read'), (_req, res) => {
    res.json({ auditLogs: [...dbStore.auditLogs].reverse() });
  });

  router.get('/admin/reconciliation', requireAuth, requirePermission('reconciliation:read'), (_req, res) => {
    res.json({
      runs: [...dbStore.reconciliationRuns.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      ledgerInvariant: ledgerService.verifyGlobalInvariant(),
    });
  });

  router.post('/admin/reconciliation/run', requireAuth, requirePermission('reconciliation:resolve'), (req: AuthenticatedRequest, res) => {
    const currency = (req.body?.currency as Currency) || Currency.USD;
    const external = typeof req.body?.externalBankTotalMinor === 'number' ? req.body.externalBankTotalMinor : undefined;
    const run = adminService.runDailyReconciliation(currency, external);
    res.status(201).json({ run });
  });

  router.post('/admin/reconciliation/:id/resolve', requireAuth, requirePermission('reconciliation:resolve'), (req: AuthenticatedRequest, res) => {
    try {
      const run = adminService.resolveReconciliation(String(req.params.id), req.authUser!.id, String(req.body?.note || 'Reviewed and cleared.'));
      res.json({ run });
    } catch (err) {
      handleError(req, res, err);
    }
  });

  router.get('/admin/risk-flags', requireAuth, requirePermission('risk:read'), (_req, res) => {
    res.json({ flags: riskService.listFlags() });
  });

  router.post('/admin/risk-flags/:id/resolve', requireAuth, requirePermission('risk:resolve'), (req: AuthenticatedRequest, res) => {
    const status = ['INVESTIGATING', 'RESOLVED', 'FALSE_POSITIVE'].includes(req.body?.status) ? req.body.status : 'RESOLVED';
    try {
      const flag = riskService.resolveFlag(String(req.params.id), req.authUser!.id, status, String(req.body?.note || 'Reviewed'));
      res.json({ flag });
    } catch (err) {
      handleError(req, res, err);
    }
  });

  router.get('/admin/reports/summary', requireAuth, requirePermission('reports:read'), (_req, res) => {
    const txns = [...dbStore.transactions.values()];
    const totalVolumeUsdMinor = txns
      .filter((t) => t.currency === Currency.USD && t.status === 'COMPLETED')
      .reduce((acc, t) => acc + t.amountMinor, 0);
    const totalFeesUsdMinor = txns
      .filter((t) => t.currency === Currency.USD && t.status === 'COMPLETED')
      .reduce((acc, t) => acc + t.feeMinor, 0);
    res.json({
      generatedAt: new Date().toISOString(),
      totalVolumeUsdMinor,
      totalFeesUsdMinor,
      transactionCount: txns.length,
      kycApprovedUsers: [...dbStore.users.values()].filter((u) => u.kycStatus === 'APPROVED').length,
      openRiskFlags: riskService.listFlags('OPEN').length,
    });
  });

  return router;
}
