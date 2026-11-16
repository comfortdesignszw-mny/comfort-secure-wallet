import { randomUUID } from 'node:crypto';
import { AuditLogRecord } from '../../shared/types.ts';
import { dbStore } from '../db/store.ts';

const SENSITIVE_KEYS = new Set([
  'password',
  'passwordHash',
  'pin',
  'pinHash',
  'salt',
  'nationalIdNumber',
  'otp',
  'code',
  'refreshToken',
  'accessToken',
  'stepUpToken',
]);

function redactObject(obj: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!obj) return null;
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(key)) {
      clean[key] = '[REDACTED]';
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      clean[key] = redactObject(value as Record<string, unknown>);
    } else {
      clean[key] = value;
    }
  }
  return clean;
}

export function recordAuditLog(params: {
  actorId: string;
  actorType: 'USER' | 'ADMIN' | 'SYSTEM';
  action: string;
  entity: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  ip?: string;
  userAgent?: string;
  correlationId?: string;
}): AuditLogRecord {
  const entry: AuditLogRecord = {
    id: `aud_${randomUUID()}`,
    actorId: params.actorId,
    actorType: params.actorType,
    action: params.action,
    entity: params.entity,
    before: redactObject(params.before),
    after: redactObject(params.after),
    ip: params.ip || '127.0.0.1',
    userAgent: (params.userAgent || 'unknown').slice(0, 180),
    correlationId: params.correlationId || randomUUID(),
    createdAt: new Date().toISOString(),
  };

  // Append-only write — existing entries are never mutated or deleted
  dbStore.appendAuditLog(entry);
  return entry;
}
