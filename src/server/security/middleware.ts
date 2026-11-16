import { randomUUID } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';
import { ADMIN_ROLES, Currency, Permission, Role } from '../../shared/types.ts';
import { dbStore } from '../db/store.ts';
import { rbacService } from '../modules/rules/rbac.service.ts';
import { verifyAccessToken, verifyStepUpToken } from './crypto.ts';

export interface AuthenticatedRequest extends Request {
  correlationId?: string;
  authUser?: {
    id: string;
    sessionId: string;
    role: Role;
    twoFactorVerified: boolean;
  };
  idempotencyKey?: string;
}

export function correlationIdMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const corrId = (req.headers['x-correlation-id'] as string) || randomUUID();
  req.correlationId = corrId;
  res.setHeader('X-Correlation-ID', corrId);
  next();
}

export function sendApiError(res: Response, status: number, code: string, message: string, correlationId?: string) {
  return res.status(status).json({
    error: {
      code,
      message,
      correlationId: correlationId || res.getHeader('X-Correlation-ID'),
    },
  });
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return sendApiError(res, 401, 'UNAUTHORIZED', 'Missing Bearer access token.', req.correlationId);
  }
  const token = header.slice('Bearer '.length).trim();
  const claims = verifyAccessToken(token);
  if (!claims) {
    return sendApiError(res, 401, 'INVALID_TOKEN', 'Access token is invalid or expired.', req.correlationId);
  }

  const session = dbStore.sessions.get(claims.sid);
  if (!session || session.revokedAt) {
    return sendApiError(res, 401, 'SESSION_REVOKED', 'Session has been revoked.', req.correlationId);
  }

  // Idle timeout enforcement (5 minutes in production, 30 minutes in dev preview unless inactive)
  const idleLimitMs = process.env.NODE_ENV === 'production' ? 5 * 60 * 1000 : 30 * 60 * 1000;
  if (Date.now() - Date.parse(session.lastSeen) > idleLimitMs) {
    session.revokedAt = new Date().toISOString();
    return sendApiError(res, 401, 'IDLE_TIMEOUT', 'Session timed out due to inactivity.', req.correlationId);
  }

  session.lastSeen = new Date().toISOString();
  req.authUser = {
    id: claims.sub,
    sessionId: claims.sid,
    role: claims.role,
    twoFactorVerified: claims.twoFactorVerified,
  };
  next();
}

export function requirePermission(permission: Permission) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.authUser) {
      return sendApiError(res, 401, 'UNAUTHORIZED', 'Authentication required.', req.correlationId);
    }
    const dbUser = dbStore.users.get(req.authUser.id);
    if (!dbUser) {
      return sendApiError(res, 401, 'UNAUTHORIZED', 'Account record not found.', req.correlationId);
    }
    if (dbUser.status !== 'ACTIVE') {
      return sendApiError(res, 403, 'ACCOUNT_RESTRICTED', 'Staff account is frozen or closed.', req.correlationId);
    }
    if (!ADMIN_ROLES.includes(dbUser.role)) {
      return sendApiError(res, 403, 'FORBIDDEN', 'Staff role required.', req.correlationId);
    }
    if (dbUser.staffStatus !== 'APPROVED') {
      return sendApiError(
        res,
        403,
        'STAFF_APPROVAL_PENDING',
        'Your staff account is pending Super Admin approval before Back-Office access is granted.',
        req.correlationId,
      );
    }
    if (!req.authUser.twoFactorVerified) {
      return sendApiError(res, 403, 'MFA_REQUIRED', 'Staff 2FA verification is mandatory.', req.correlationId);
    }
    // Strict DB-backed RBAC check against rbac_rules store
    if (!rbacService.hasPermission(dbUser.role, permission)) {
      return sendApiError(res, 403, 'INSUFFICIENT_PERMISSIONS', `Role ${dbUser.role} lacks ${permission}.`, req.correlationId);
    }
    next();
  };
}

export function requireViewStepUp(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const token = req.headers['x-step-up-token'] as string | undefined;
  if (!token) {
    return sendApiError(res, 403, 'PIN_STEPUP_REQUIRED', 'View PIN step-up token is required.', req.correlationId);
  }
  const claims = verifyStepUpToken(token);
  if (!claims || claims.sub !== req.authUser?.id || claims.scope !== 'view') {
    return sendApiError(res, 403, 'INVALID_STEPUP_TOKEN', 'Step-up token is invalid or expired.', req.correlationId);
  }
  next();
}

export function verifyAndConsumeTransactionStepUp(
  req: AuthenticatedRequest,
  expectedAction: 'transfer' | 'withdrawal',
  expectedAmountMinor: number,
  expectedCurrency: Currency,
): { ok: true } | { ok: false; code: string; message: string } {
  const token = req.headers['x-step-up-token'] as string | undefined;
  if (!token) {
    return { ok: false, code: 'PIN_STEPUP_REQUIRED', message: 'Fresh single-use PIN verification is required.' };
  }
  const claims = verifyStepUpToken(token);
  if (!claims || claims.sub !== req.authUser?.id || claims.scope !== 'transaction') {
    return { ok: false, code: 'INVALID_STEPUP_TOKEN', message: 'Transaction PIN token is invalid or expired.' };
  }
  if (dbStore.usedStepUpTokens.has(claims.jti)) {
    return { ok: false, code: 'STEPUP_TOKEN_REUSED', message: 'Transaction PIN token is single-use and already consumed.' };
  }
  if (
    claims.action !== expectedAction ||
    claims.amountMinor !== expectedAmountMinor ||
    claims.currency !== expectedCurrency
  ) {
    return {
      ok: false,
      code: 'STEPUP_BINDING_MISMATCH',
      message: 'PIN token is bound to a different action, amount, or currency.',
    };
  }
  dbStore.usedStepUpTokens.add(claims.jti);
  return { ok: true };
}

export function requireAdminPinStepUp(expectedAdminAction: string) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const token = req.headers['x-step-up-token'] as string | undefined;
    if (!token) {
      return sendApiError(
        res,
        403,
        'ADMIN_PIN_STEPUP_REQUIRED',
        'Your 6-digit Staff Security PIN is required to authorize this sensitive operation.',
        req.correlationId,
      );
    }
    const claims = verifyStepUpToken(token);
    if (!claims || claims.sub !== req.authUser?.id || claims.scope !== 'admin_action') {
      return sendApiError(res, 403, 'INVALID_STEPUP_TOKEN', 'Staff PIN token is invalid or expired.', req.correlationId);
    }
    if (dbStore.usedStepUpTokens.has(claims.jti)) {
      return sendApiError(res, 403, 'STEPUP_TOKEN_REUSED', 'Staff PIN token is single-use and already consumed.', req.correlationId);
    }
    if (claims.adminAction !== expectedAdminAction) {
      return sendApiError(res, 403, 'STEPUP_BINDING_MISMATCH', 'Staff PIN token is bound to a different admin action.', req.correlationId);
    }
    dbStore.usedStepUpTokens.add(claims.jti);
    next();
  };
}

export function requireIdempotencyKey(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const key = (req.headers['idempotency-key'] as string | undefined)?.trim();
  if (!key || key.length < 8 || key.length > 128) {
    return sendApiError(
      res,
      400,
      'IDEMPOTENCY_KEY_REQUIRED',
      'An Idempotency-Key header (8-128 chars) is required for money-moving requests.',
      req.correlationId,
    );
  }
  req.idempotencyKey = key;
  next();
}
