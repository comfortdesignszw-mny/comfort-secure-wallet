export enum Role {
  USER = 'USER',
  SUPPORT_AGENT = 'SUPPORT_AGENT',
  KYC_OFFICER = 'KYC_OFFICER',
  FINANCE_MAKER = 'FINANCE_MAKER',
  FINANCE_CHECKER = 'FINANCE_CHECKER',
  COMPLIANCE_OFFICER = 'COMPLIANCE_OFFICER',
  AUDITOR = 'AUDITOR',
  SUPER_ADMIN = 'SUPER_ADMIN',
}

export enum Currency {
  USD = 'USD',
  ZWG = 'ZWG',
  ZAR = 'ZAR',
}

export enum UserStatus {
  ACTIVE = 'ACTIVE',
  FROZEN = 'FROZEN',
  CLOSED = 'CLOSED',
}

export enum KycStatus {
  NOT_SUBMITTED = 'NOT_SUBMITTED',
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  NEEDS_MORE_INFO = 'NEEDS_MORE_INFO',
}

export enum AccountStatus {
  ACTIVE = 'ACTIVE',
  FROZEN = 'FROZEN',
  CLOSED = 'CLOSED',
}

export enum LedgerAccountType {
  USER_WALLET = 'user_wallet',
  BANK_SETTLEMENT = 'bank_settlement',
  FEE_REVENUE = 'fee_revenue',
  WITHDRAWAL_HOLD = 'withdrawal_hold',
  SUSPENSE = 'suspense',
}

export enum JournalDirection {
  DEBIT = 'debit',
  CREDIT = 'credit',
}

export enum TransactionType {
  DEPOSIT = 'deposit',
  WITHDRAWAL = 'withdrawal',
  TRANSFER = 'transfer',
  FEE = 'fee',
  REVERSAL = 'reversal',
}

export enum TransactionStatus {
  PENDING = 'PENDING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  REVERSED = 'REVERSED',
}

export enum DepositStatus {
  PENDING = 'PENDING',
  MAKER_APPROVED = 'MAKER_APPROVED',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

export enum WithdrawalStatus {
  PENDING = 'PENDING',
  MAKER_APPROVED = 'MAKER_APPROVED',
  CHECKER_APPROVED = 'CHECKER_APPROVED',
  PAID = 'PAID',
  REJECTED = 'REJECTED',
}

export enum NotificationChannel {
  SMS = 'SMS',
  EMAIL = 'EMAIL',
  PUSH = 'PUSH',
  IN_APP = 'IN_APP',
}

export enum RiskSeverity {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}

export type Permission =
  | 'kyc:read'
  | 'kyc:decide'
  | 'deposits:read'
  | 'deposits:make'
  | 'deposits:check'
  | 'withdrawals:read'
  | 'withdrawals:make'
  | 'withdrawals:check'
  | 'withdrawals:payout'
  | 'users:read'
  | 'users:note'
  | 'users:freeze'
  | 'users:reset_security'
  | 'transactions:read'
  | 'transactions:reverse'
  | 'fees:read'
  | 'fees:write'
  | 'limits:read'
  | 'limits:write'
  | 'staff:read'
  | 'staff:write'
  | 'approvals:read'
  | 'approvals:decide'
  | 'audit:read'
  | 'reconciliation:read'
  | 'reconciliation:resolve'
  | 'risk:read'
  | 'risk:resolve'
  | 'reports:read';

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  [Role.USER]: [],
  [Role.SUPPORT_AGENT]: ['users:read', 'users:note', 'users:reset_security', 'transactions:read'],
  [Role.KYC_OFFICER]: ['kyc:read', 'kyc:decide', 'users:read'],
  [Role.FINANCE_MAKER]: [
    'deposits:read',
    'deposits:make',
    'withdrawals:read',
    'withdrawals:make',
    'withdrawals:payout',
    'transactions:read',
    'reconciliation:read',
  ],
  [Role.FINANCE_CHECKER]: [
    'deposits:read',
    'deposits:check',
    'withdrawals:read',
    'withdrawals:check',
    'transactions:read',
    'reconciliation:read',
    'reconciliation:resolve',
  ],
  [Role.COMPLIANCE_OFFICER]: [
    'users:read',
    'users:freeze',
    'kyc:read',
    'transactions:read',
    'risk:read',
    'risk:resolve',
    'audit:read',
    'reports:read',
  ],
  [Role.AUDITOR]: [
    'kyc:read',
    'deposits:read',
    'withdrawals:read',
    'users:read',
    'transactions:read',
    'fees:read',
    'limits:read',
    'staff:read',
    'approvals:read',
    'audit:read',
    'reconciliation:read',
    'risk:read',
    'reports:read',
  ],
  [Role.SUPER_ADMIN]: [
    'kyc:read',
    'kyc:decide',
    'deposits:read',
    'deposits:make',
    'deposits:check',
    'withdrawals:read',
    'withdrawals:make',
    'withdrawals:check',
    'withdrawals:payout',
    'users:read',
    'users:note',
    'users:freeze',
    'users:reset_security',
    'transactions:read',
    'transactions:reverse',
    'fees:read',
    'fees:write',
    'limits:read',
    'limits:write',
    'staff:read',
    'staff:write',
    'approvals:read',
    'approvals:decide',
    'audit:read',
    'reconciliation:read',
    'reconciliation:resolve',
    'risk:read',
    'risk:resolve',
    'reports:read',
  ],
};

export const ADMIN_ROLES: Role[] = [
  Role.SUPPORT_AGENT,
  Role.KYC_OFFICER,
  Role.FINANCE_MAKER,
  Role.FINANCE_CHECKER,
  Role.COMPLIANCE_OFFICER,
  Role.AUDITOR,
  Role.SUPER_ADMIN,
];

export type StaffApprovalStatus = 'NONE' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED';

export interface RbacRuleRecord {
  role: Role;
  permissions: Permission[];
  description: string;
  updatedAt: string;
  updatedBy: string;
}

export interface UserRecord {
  id: string;
  email: string | null;
  phone: string | null;
  passwordHash: string | null;
  googleId: string | null;
  role: Role;
  staffStatus: StaffApprovalStatus;
  requestedRole: Role | null;
  status: UserStatus;
  freezeReason: string | null;
  kycStatus: KycStatus;
  kycTier: number;
  emailVerified: boolean;
  phoneVerified: boolean;
  totpEnabled: boolean;
  legalAcceptedAt: string | null;
  createdAt: string;
}

export interface UserProfileRecord {
  userId: string;
  fullName: string;
  dateOfBirth: string;
  nationalIdEncrypted: string;
  address: string;
  country: string;
  updatedAt: string;
}

export interface KycDocumentRecord {
  id: string;
  userId: string;
  type: 'NATIONAL_ID' | 'PASSPORT' | 'SELFIE' | 'PROOF_OF_RESIDENCE';
  storageKey: string;
  mimeType: string;
  status: KycStatus;
  reviewedBy: string | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
  createdAt: string;
}

export interface PinRecord {
  userId: string;
  pinHash: string;
  salt: string;
  failedAttempts: number;
  lockoutCount: number;
  lockedUntil: string | null;
  requiresComplianceReview: boolean;
  updatedAt: string;
}

export interface SessionRecord {
  id: string;
  userId: string;
  deviceFingerprint: string;
  deviceLabel: string;
  ip: string;
  userAgent: string;
  refreshTokenHash: string;
  usedRefreshTokenHashes: string[];
  familyId: string;
  lastSeen: string;
  revokedAt: string | null;
  createdAt: string;
}

export interface OtpRecord {
  id: string;
  userId: string | null;
  target: string;
  channel: 'SMS' | 'EMAIL';
  purpose: 'REGISTER' | 'LOGIN_2FA' | 'NEW_DEVICE' | 'PIN_RESET' | 'HIGH_RISK';
  codeHash: string;
  expiresAt: string;
  attempts: number;
  usedAt: string | null;
  createdAt: string;
}

export interface AccountRecord {
  id: string;
  userId: string;
  accountNumber: string;
  currency: Currency;
  status: AccountStatus;
  createdAt: string;
}

export interface LedgerAccountRecord {
  id: string;
  type: LedgerAccountType;
  accountId: string | null;
  currency: Currency;
  cachedBalanceMinor: number;
}

export interface JournalEntryRecord {
  id: string;
  transactionId: string;
  description: string;
  createdAt: string;
}

export interface JournalLineRecord {
  id: string;
  entryId: string;
  ledgerAccountId: string;
  direction: JournalDirection;
  amountMinor: number;
  currency: Currency;
  createdAt: string;
}

export interface TransactionRecord {
  id: string;
  type: TransactionType;
  status: TransactionStatus;
  amountMinor: number;
  feeMinor: number;
  currency: Currency;
  fromAccountId: string | null;
  toAccountId: string | null;
  reference: string;
  idempotencyKey: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface DepositRequestRecord {
  id: string;
  userId: string;
  accountId: string;
  amountMinor: number;
  currency: Currency;
  method: string;
  proofStorageKey: string;
  paymentReference: string;
  status: DepositStatus;
  makerId: string | null;
  checkerId: string | null;
  decidedAt: string | null;
  notes: string | null;
  createdAt: string;
}

export interface WithdrawalRequestRecord {
  id: string;
  userId: string;
  accountId: string;
  amountMinor: number;
  currency: Currency;
  destinationDetailsEncrypted: string;
  destinationPreview: string;
  status: WithdrawalStatus;
  makerId: string | null;
  checkerId: string | null;
  payoutReference: string | null;
  decidedAt: string | null;
  rejectionReason: string | null;
  createdAt: string;
}

export interface ApprovalRecord {
  id: string;
  entityType: 'FEE_RULE' | 'LIMIT_RULE' | 'STAFF_ROLE' | 'MAKER_CHECKER_THRESHOLD';
  entityId: string;
  payload: Record<string, unknown>;
  requestedBy: string;
  approvedBy: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  reason: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface FeeRuleRecord {
  id: string;
  transactionType: TransactionType;
  currency: Currency;
  flatMinor: number;
  percentBps: number;
  minMinor: number;
  maxMinor: number;
  active: boolean;
  changedBy: string;
  updatedAt: string;
}

export interface LimitRuleRecord {
  id: string;
  scope: 'TIER_1' | 'TIER_2' | 'USER';
  scopeId: string;
  transactionType: TransactionType;
  currency: Currency;
  perTxnMaxMinor: number;
  dailyMaxMinor: number;
  monthlyMaxMinor: number;
  updatedAt: string;
}

export interface NotificationRecord {
  id: string;
  userId: string;
  channel: NotificationChannel;
  template: string;
  title: string;
  body: string;
  status: 'QUEUED' | 'SENT' | 'FAILED';
  attempts: number;
  readAt: string | null;
  sentAt: string | null;
  createdAt: string;
}

export interface NotificationPreferences {
  userId: string;
  emailReceipts: boolean;
  pushTransactions: boolean;
  smsTransactions: boolean;
  // Security alerts are always mandatory and enforced server-side
  mandatorySecurityAlerts: true;
}

export interface AuditLogRecord {
  id: string;
  actorId: string;
  actorType: 'USER' | 'ADMIN' | 'SYSTEM';
  action: string;
  entity: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ip: string;
  userAgent: string;
  correlationId: string;
  createdAt: string;
}

export interface RiskFlagRecord {
  id: string;
  userId: string;
  rule: string;
  severity: RiskSeverity;
  details: string;
  status: 'OPEN' | 'INVESTIGATING' | 'RESOLVED' | 'FALSE_POSITIVE';
  resolvedBy: string | null;
  resolutionNote: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface ReconciliationRunRecord {
  id: string;
  date: string;
  currency: Currency;
  ledgerTotalMinor: number;
  bankTotalMinor: number;
  differenceMinor: number;
  status: 'MATCHED' | 'DISCREPANCY' | 'RESOLVED';
  resolvedBy: string | null;
  note: string | null;
  createdAt: string;
}

export interface SupportNoteRecord {
  id: string;
  userId: string;
  authorId: string;
  note: string;
  createdAt: string;
}

export interface StatementExportJob {
  id: string;
  userId: string;
  accountId: string;
  from: string;
  to: string;
  format: 'CSV' | 'PDF';
  status: 'QUEUED' | 'READY' | 'FAILED';
  downloadToken: string | null;
  createdAt: string;
}
