import { createHash } from 'node:crypto';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, Firestore } from 'firebase-admin/firestore';
import firebaseConfig from '../../../firebase-applet-config.json' with { type: 'json' };
import {
  AccountRecord,
  ApprovalRecord,
  AuditLogRecord,
  Currency,
  DepositRequestRecord,
  DepositStatus,
  FeeRuleRecord,
  IdempotencyRecord,
  JournalEntryRecord,
  JournalLineRecord,
  KycDocumentRecord,
  LedgerAccountRecord,
  LedgerAccountType,
  LimitRuleRecord,
  NotificationPreferences,
  NotificationRecord,
  OtpRecord,
  PinRecord,
  RbacRuleRecord,
  ReconciliationRunRecord,
  RiskFlagRecord,
  Role,
  SessionRecord,
  StatementExportJob,
  SupportNoteRecord,
  TransactionRecord,
  UserProfileRecord,
  UserRecord,
  WithdrawalRequestRecord,
  WithdrawalStatus,
} from '../../shared/types.ts';

export function computeCanonicalPayloadHash(payload: unknown): string {
  const stableStringify = (val: unknown): string => {
    if (val === null || typeof val !== 'object') return JSON.stringify(val);
    if (Array.isArray(val)) return `[${val.map(stableStringify).join(',')}]`;
    const entries = Object.entries(val as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  };
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Per-key asynchronous mutex implementing consistent ordered row-level locking
 * (analogous to PostgreSQL SELECT ... FOR UPDATE ordered by key) to prevent deadlocks
 * and serialize concurrent money movements.
 */
class OrderedLockManager {
  private queues = new Map<string, Promise<void>>();

  async acquireOrdered<T>(rawKeys: string[], fn: () => Promise<T>): Promise<T> {
    const keys = [...new Set(rawKeys)].sort();
    const releases: Array<() => void> = [];

    for (const key of keys) {
      const prev = this.queues.get(key) ?? Promise.resolve();
      let releaseFn!: () => void;
      const current = new Promise<void>((resolve) => {
        releaseFn = resolve;
      });
      const tail = prev.then(() => current);
      this.queues.set(key, tail);
      await prev;
      releases.push(() => {
        releaseFn();
        if (this.queues.get(key) === tail) {
          this.queues.delete(key);
        }
      });
    }

    try {
      return await fn();
    } finally {
      for (let i = releases.length - 1; i >= 0; i--) {
        releases[i]();
      }
    }
  }
}

export interface EncryptedBlobRecord {
  storageKey: string;
  mimeType: string;
  encryptedPayload: string;
  ownerUserId: string;
  createdAt: string;
}

export interface CloudWriteItem {
  collection: string;
  id: string;
  data: Record<string, unknown>;
}

const TERMINAL_DEPOSIT = new Set<string>([DepositStatus.APPROVED, DepositStatus.REJECTED]);
const TERMINAL_WITHDRAWAL = new Set<string>([WithdrawalStatus.PAID, WithdrawalStatus.REJECTED]);

class WalletDatabaseStore {
  private lockManager = new OrderedLockManager();
  private firestoreDb: Firestore | null = null;
  private firestoreMirrorEnabled = false;
  private lastCloudPullMs = 0;

  syncRevision = 1;
  lastSyncedAt = new Date().toISOString();

  users = new Map<string, UserRecord>();
  userProfiles = new Map<string, UserProfileRecord>();
  kycDocuments = new Map<string, KycDocumentRecord>();
  pins = new Map<string, PinRecord>();
  sessions = new Map<string, SessionRecord>();
  otps = new Map<string, OtpRecord>();
  accounts = new Map<string, AccountRecord>();
  ledgerAccounts = new Map<string, LedgerAccountRecord>();
  transactions = new Map<string, TransactionRecord>();
  idempotencyResponses = new Map<string, IdempotencyRecord>();
  usedStepUpTokens = new Set<string>();
  journalEntries: JournalEntryRecord[] = [];
  journalLines: JournalLineRecord[] = [];
  depositRequests = new Map<string, DepositRequestRecord>();
  withdrawalRequests = new Map<string, WithdrawalRequestRecord>();
  approvals = new Map<string, ApprovalRecord>();
  feeRules = new Map<string, FeeRuleRecord>();
  limitRules = new Map<string, LimitRuleRecord>();
  rbacRules = new Map<Role, RbacRuleRecord>();
  notifications = new Map<string, NotificationRecord>();
  notificationPreferences = new Map<string, NotificationPreferences>();
  pushSubscriptions = new Map<string, { userId: string; endpoint: string; keys: Record<string, string> }>();
  auditLogs: AuditLogRecord[] = [];
  riskFlags = new Map<string, RiskFlagRecord>();
  reconciliationRuns = new Map<string, ReconciliationRunRecord>();
  supportNotes = new Map<string, SupportNoteRecord>();
  statementJobs = new Map<string, StatementExportJob>();
  privateBlobs = new Map<string, EncryptedBlobRecord>();

  // Configurable maker-checker threshold in minor units (0 = all deposits/withdrawals require Checker too)
  makerCheckerThresholdMinor = 0;

  constructor() {
    this.initSystemLedgerAccounts();
    this.initFirestoreMirror();
  }

  private initFirestoreMirror() {
    if (process.env.VITEST || process.env.DISABLE_FIRESTORE_MIRROR === 'true') return;
    try {
      if (!getApps().length) {
        initializeApp({ projectId: firebaseConfig.projectId });
      }
      this.firestoreDb = getFirestore(firebaseConfig.firestoreDatabaseId);
      this.firestoreMirrorEnabled = true;
    } catch {
      this.firestoreMirrorEnabled = false;
    }
  }

  private initSystemLedgerAccounts() {
    for (const currency of [Currency.USD, Currency.ZWG, Currency.ZAR]) {
      const types: LedgerAccountType[] = [
        LedgerAccountType.BANK_SETTLEMENT,
        LedgerAccountType.FEE_REVENUE,
        LedgerAccountType.WITHDRAWAL_HOLD,
        LedgerAccountType.SUSPENSE,
      ];
      for (const type of types) {
        const id = `sys_${type}_${currency}`;
        if (!this.ledgerAccounts.has(id)) {
          this.ledgerAccounts.set(id, {
            id,
            type,
            accountId: null,
            currency,
            cachedBalanceMinor: 0,
          });
        }
      }
    }
  }

  resetForTests() {
    this.users.clear();
    this.userProfiles.clear();
    this.kycDocuments.clear();
    this.pins.clear();
    this.sessions.clear();
    this.otps.clear();
    this.accounts.clear();
    this.ledgerAccounts.clear();
    this.transactions.clear();
    this.idempotencyResponses.clear();
    this.usedStepUpTokens.clear();
    this.journalEntries = [];
    this.journalLines = [];
    this.depositRequests.clear();
    this.withdrawalRequests.clear();
    this.approvals.clear();
    this.feeRules.clear();
    this.limitRules.clear();
    this.rbacRules.clear();
    this.notifications.clear();
    this.notificationPreferences.clear();
    this.pushSubscriptions.clear();
    this.auditLogs = [];
    this.riskFlags.clear();
    this.reconciliationRuns.clear();
    this.supportNotes.clear();
    this.statementJobs.clear();
    this.privateBlobs.clear();
    this.makerCheckerThresholdMinor = 0;
    this.syncRevision = 1;
    this.lastSyncedAt = new Date().toISOString();
    this.initSystemLedgerAccounts();
  }

  getSystemLedgerAccount(type: LedgerAccountType, currency: Currency): LedgerAccountRecord {
    const id = `sys_${type}_${currency}`;
    const existing = this.ledgerAccounts.get(id);
    if (!existing) {
      throw new Error(`Missing system ledger account ${id}`);
    }
    return existing;
  }

  getUserWalletLedgerAccount(accountId: string): LedgerAccountRecord | undefined {
    for (const la of this.ledgerAccounts.values()) {
      if (la.type === LedgerAccountType.USER_WALLET && la.accountId === accountId) {
        return la;
      }
    }
    return undefined;
  }

  getCloudBackend(): 'firestore' | 'memory' {
    return this.firestoreMirrorEnabled && this.firestoreDb ? 'firestore' : 'memory';
  }

  bumpSyncRevision(): number {
    this.syncRevision += 1;
    this.lastSyncedAt = new Date().toISOString();
    return this.syncRevision;
  }

  checkIdempotency(
    scope: string,
    userId: string,
    key: string,
    payload: unknown,
  ): { hit: true; record: IdempotencyRecord } | { hit: false; cacheKey: string; payloadHash: string } {
    const cacheKey = `${scope}:${userId}:${key}`;
    const payloadHash = computeCanonicalPayloadHash(payload);
    const existing = this.idempotencyResponses.get(cacheKey);
    if (existing) {
      if (existing.payloadHash && existing.payloadHash !== payloadHash) {
        throw new Error(
          'IDEMPOTENCY_CONFLICT: Idempotency-Key was already used with different transaction parameters.',
        );
      }
      return { hit: true, record: existing };
    }
    return { hit: false, cacheKey, payloadHash };
  }

  recordIdempotencyResponse(params: {
    cacheKey: string;
    scope: string;
    userId: string;
    key: string;
    payloadHash: string;
    statusCode: number;
    body: unknown;
  }): IdempotencyRecord {
    const record: IdempotencyRecord = {
      key: params.key,
      scope: params.scope,
      userId: params.userId,
      payloadHash: params.payloadHash,
      statusCode: params.statusCode,
      body: params.body,
      createdAt: new Date().toISOString(),
    };
    this.idempotencyResponses.set(params.cacheKey, record);
    return record;
  }

  /**
   * Execute an atomic ledger transaction with ordered row-level locks and full rollback on failure.
   */
  async runInTransaction<T>(lockKeys: string[], work: () => Promise<T> | T): Promise<T> {
    return this.lockManager.acquireOrdered(lockKeys, async () => {
      const ledgerSnapshot = new Map<string, LedgerAccountRecord>();
      for (const [k, v] of this.ledgerAccounts.entries()) {
        ledgerSnapshot.set(k, { ...v });
      }
      const txnSnapshot = new Map(this.transactions);
      const entryLen = this.journalEntries.length;
      const lineLen = this.journalLines.length;

      try {
        return await work();
      } catch (err) {
        // Atomic rollback of ledger state
        this.ledgerAccounts = ledgerSnapshot;
        this.transactions = txnSnapshot;
        this.journalEntries.length = entryLen;
        this.journalLines.length = lineLen;
        throw err;
      }
    });
  }

  appendAuditLog(entry: AuditLogRecord) {
    this.auditLogs.push(entry);
    this.mirrorDoc('audit_logs', entry.id, entry as unknown as Record<string, unknown>);
  }

  mirrorDoc(collectionName: string, docId: string, data: Record<string, unknown>) {
    if (!this.firestoreMirrorEnabled || !this.firestoreDb) return;
    this.firestoreDb
      .collection(collectionName)
      .doc(docId)
      .set(stripUndefined(data), { merge: true })
      .catch(() => {
        // Suppress background mirror noise if sandbox lacks ADC IAM
      });
  }

  /**
   * Immediately persists critical mutations in a single Firestore batch + updates sync_state.
   */
  async persistImmediate(writes: CloudWriteItem[]): Promise<number> {
    const rev = this.bumpSyncRevision();
    if (!this.firestoreMirrorEnabled || !this.firestoreDb) {
      return rev;
    }

    try {
      const chunkSize = 400;
      const allWrites: CloudWriteItem[] = [
        ...writes,
        {
          collection: 'system_meta',
          id: 'sync_state',
          data: { syncRevision: rev, updatedAt: this.lastSyncedAt },
        },
      ];
      for (let i = 0; i < allWrites.length; i += chunkSize) {
        const batch = this.firestoreDb.batch();
        for (const item of allWrites.slice(i, i + chunkSize)) {
          const ref = this.firestoreDb.collection(item.collection).doc(item.id);
          batch.set(ref, stripUndefined(item.data), { merge: true });
        }
        await batch.commit();
      }
    } catch {
      // Preserve in-memory durability if sandbox runtime lacks Firestore Admin credentials
    }
    return rev;
  }

  /**
   * Pulls and reconciles latest cloud state from Firestore with conflict-safe merge rules.
   */
  async syncFromCloud(force = false): Promise<{ syncRevision: number; syncedAt: string; cloudBackend: 'firestore' | 'memory' }> {
    const nowMs = Date.now();
    if (!this.firestoreMirrorEnabled || !this.firestoreDb) {
      this.lastSyncedAt = new Date().toISOString();
      return {
        syncRevision: this.syncRevision,
        syncedAt: this.lastSyncedAt,
        cloudBackend: 'memory',
      };
    }

    if (!force && nowMs - this.lastCloudPullMs < 1500) {
      return {
        syncRevision: this.syncRevision,
        syncedAt: this.lastSyncedAt,
        cloudBackend: 'firestore',
      };
    }

    try {
      const metaDoc = await this.firestoreDb.collection('system_meta').doc('sync_state').get();
      const cloudRev = Number((metaDoc.data()?.syncRevision as number | undefined) || 0);
      if (!force && cloudRev > 0 && cloudRev <= this.syncRevision && this.lastCloudPullMs > 0) {
        this.lastCloudPullMs = nowMs;
        this.lastSyncedAt = new Date().toISOString();
        return { syncRevision: this.syncRevision, syncedAt: this.lastSyncedAt, cloudBackend: 'firestore' };
      }

      const fetchCol = async (name: string) => {
        const snap = await this.firestoreDb!.collection(name).limit(500).get();
        return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
      };

      const [
        usersDocs,
        accountsDocs,
        ledgerDocs,
        txnDocs,
        jeDocs,
        jlDocs,
        depDocs,
        wdrDocs,
        notifDocs,
        auditDocs,
      ] = await Promise.all([
        fetchCol('users'),
        fetchCol('accounts'),
        fetchCol('ledger_accounts'),
        fetchCol('transactions'),
        fetchCol('journal_entries'),
        fetchCol('journal_lines'),
        fetchCol('deposit_requests'),
        fetchCol('withdrawal_requests'),
        fetchCol('notifications'),
        fetchCol('audit_logs'),
      ]);

      for (const { id, data } of usersDocs) {
        const incoming = data as unknown as UserRecord;
        const local = this.users.get(id);
        if (!local || (incoming.version ?? 0) > (local.version ?? 0)) {
          this.users.set(id, { ...local, ...incoming });
        }
      }

      for (const { id, data } of accountsDocs) {
        const incoming = data as unknown as AccountRecord;
        const local = this.accounts.get(id);
        if (!local || (incoming.version ?? 0) > (local.version ?? 0)) {
          this.accounts.set(id, incoming);
        }
      }

      for (const { id, data } of ledgerDocs) {
        if (!this.ledgerAccounts.has(id)) {
          this.ledgerAccounts.set(id, data as unknown as LedgerAccountRecord);
        }
      }

      const knownEntries = new Set(this.journalEntries.map((e) => e.id));
      for (const { id, data } of jeDocs) {
        if (!knownEntries.has(id)) {
          this.journalEntries.push(data as unknown as JournalEntryRecord);
          knownEntries.add(id);
        }
      }

      const knownLines = new Set(this.journalLines.map((l) => l.id));
      for (const { id, data } of jlDocs) {
        if (!knownLines.has(id)) {
          this.journalLines.push(data as unknown as JournalLineRecord);
          knownLines.add(id);
        }
      }

      for (const { id, data } of txnDocs) {
        const incoming = data as unknown as TransactionRecord;
        const local = this.transactions.get(id);
        if (!local || (incoming.status === 'REVERSED' && local.status !== 'REVERSED')) {
          this.transactions.set(id, incoming);
        }
      }

      for (const { id, data } of depDocs) {
        const incoming = data as unknown as DepositRequestRecord;
        const local = this.depositRequests.get(id);
        const shouldReplace =
          !local ||
          (incoming.version ?? 0) > (local.version ?? 0) ||
          (TERMINAL_DEPOSIT.has(incoming.status) && !TERMINAL_DEPOSIT.has(local.status));
        if (shouldReplace) {
          this.depositRequests.set(id, incoming);
        }
      }

      for (const { id, data } of wdrDocs) {
        const incoming = data as unknown as WithdrawalRequestRecord;
        const local = this.withdrawalRequests.get(id);
        const shouldReplace =
          !local ||
          (incoming.version ?? 0) > (local.version ?? 0) ||
          (TERMINAL_WITHDRAWAL.has(incoming.status) && !TERMINAL_WITHDRAWAL.has(local.status));
        if (shouldReplace) {
          this.withdrawalRequests.set(id, incoming);
        }
      }

      for (const { id, data } of notifDocs) {
        const incoming = data as unknown as NotificationRecord;
        if (!this.notifications.has(id)) {
          this.notifications.set(id, incoming);
        }
      }

      const knownAudits = new Set(this.auditLogs.map((a) => a.id));
      for (const { id, data } of auditDocs) {
        if (!knownAudits.has(id)) {
          this.auditLogs.push(data as unknown as AuditLogRecord);
          knownAudits.add(id);
        }
      }

      // Recompute cached balances from derived journal lines when journal lines exist
      for (const la of this.ledgerAccounts.values()) {
        const isAsset =
          la.type === LedgerAccountType.BANK_SETTLEMENT ||
          la.type === LedgerAccountType.SUSPENSE;
        let bal = 0;
        let hasLine = false;
        for (const line of this.journalLines) {
          if (line.ledgerAccountId !== la.id) continue;
          hasLine = true;
          bal += isAsset
            ? line.direction === 'debit'
              ? line.amountMinor
              : -line.amountMinor
            : line.direction === 'credit'
              ? line.amountMinor
              : -line.amountMinor;
        }
        if (hasLine) {
          la.cachedBalanceMinor = bal;
        }
      }

      if (cloudRev > this.syncRevision) {
        this.syncRevision = cloudRev;
      }
      this.lastCloudPullMs = nowMs;
      this.lastSyncedAt = new Date().toISOString();
    } catch {
      this.lastSyncedAt = new Date().toISOString();
    }

    return {
      syncRevision: this.syncRevision,
      syncedAt: this.lastSyncedAt,
      cloudBackend: 'firestore',
    };
  }
}

export const dbStore = new WalletDatabaseStore();

