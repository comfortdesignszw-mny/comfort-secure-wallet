import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { ADMIN_ROLES, Role } from '../../shared/types.ts';

export interface SyncEventPayload {
  type:
    | 'CONNECTED'
    | 'DEPOSIT_CREATED'
    | 'DEPOSIT_UPDATED'
    | 'TRANSFER_COMPLETED'
    | 'WITHDRAWAL_CREATED'
    | 'WITHDRAWAL_UPDATED'
    | 'KYC_SUBMITTED'
    | 'KYC_UPDATED'
    | 'USER_STATUS_CHANGED'
    | 'TRANSACTION_REVERSED'
    | 'CLOUD_SYNCED';
  syncRevision: number;
  syncedAt: string;
  entityId?: string;
  targetUserIds?: string[];
  notifyAdmins?: boolean;
}

interface SseClient {
  id: string;
  userId: string;
  role: Role;
  res: Response;
  heartbeat: ReturnType<typeof setInterval>;
}

const clients = new Map<string, SseClient>();

function writeSseFrame(res: Response, eventName: string, data: unknown) {
  try {
    res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    // Ignore closed stream writes
  }
}

export function subscribeSseClient(params: {
  userId: string;
  role: Role;
  res: Response;
  syncRevision: number;
  syncedAt: string;
}): () => void {
  const { userId, role, res, syncRevision, syncedAt } = params;
  const id = `sse_${randomUUID()}`;

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  writeSseFrame(res, 'sync', {
    type: 'CONNECTED',
    syncRevision,
    syncedAt,
  } satisfies SyncEventPayload);

  const heartbeat = setInterval(() => {
    try {
      res.write(`: ping ${Date.now()}\n\n`);
    } catch {
      cleanup();
    }
  }, 20_000);

  const client: SseClient = { id, userId, role, res, heartbeat };
  clients.set(id, client);

  const cleanup = () => {
    clearInterval(heartbeat);
    clients.delete(id);
  };

  res.on('close', cleanup);
  res.on('error', cleanup);

  return cleanup;
}

export function broadcastSyncEvent(event: SyncEventPayload) {
  if (clients.size === 0) return;
  const targets = new Set(event.targetUserIds || []);
  for (const client of clients.values()) {
    const isAdminClient = ADMIN_ROLES.includes(client.role);
    const shouldReceive =
      (event.notifyAdmins && isAdminClient) ||
      targets.has(client.userId) ||
      event.type === 'CLOUD_SYNCED';
    if (shouldReceive) {
      writeSseFrame(client.res, 'sync', event);
    }
  }
}
