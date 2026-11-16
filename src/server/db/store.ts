import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, Firestore } from 'firebase-admin/firestore';
import firebaseConfig from '../../../firebase-applet-config.json' with { type: 'json' };
import {
  AccountRecord,
  ApprovalRecord,
  AuditLogRecord,
  Currency,
  DepositRequestRecord,
  FeeRuleRecord,
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
} from '../../shared/types.ts';

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

class WalletDatabaseStore {
  private lockManager = new OrderedLockManager();
  private firestoreDb: Firestore | null = null;
  private firestoreMirrorEnabled = false;

  users = new Map<string, UserRecord>();
  userProfiles = new Map<string, UserProfileRecord>();
  kycDocuments = new Map<string, KycDocumentRecord>();
  pins = new Map<string, PinRecord>();
  sessions = new Map<string, SessionRecord>();
  otps = new Map<string, OtpRecord>();
  accounts = new Map<string, AccountRecord>();
  ledgerAccounts = new Map<string, LedgerAccountRecord>();
  transactions = new Map<string, TransactionRecord>();
  idempotencyResponses = new Map<string, { statusCode: number; body: unknown; userId: string }>();
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
    // Best-effort non-blocking mirror to Firestore when Admin credentials are active in Cloud Run
    this.firestoreDb
      .collection(collectionName)
      .doc(docId)
      .set(data, { merge: true })
      .catch(() => {
        // Suppress background mirror noise if sandbox lacks ADC IAM
      });
  }
}

export const dbStore = new WalletDatabaseStore();
