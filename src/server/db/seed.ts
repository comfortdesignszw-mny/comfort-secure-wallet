import {
  AccountStatus,
  Currency,
  DepositStatus,
  JournalDirection,
  KycStatus,
  LedgerAccountType,
  RiskSeverity,
  Role,
  TransactionType,
  UserStatus,
  WithdrawalStatus,
} from '../../shared/types.ts';
import { generateLuhnAccountNumber } from '../../shared/luhn.ts';
import { dbStore } from './store.ts';
import { encryptField, hashPassword, hashPin } from '../security/crypto.ts';
import { recordAuditLog } from '../security/audit.ts';
import { ledgerService } from '../modules/ledger/ledger.service.ts';
import { rulesService } from '../modules/rules/rules.service.ts';
import { rbacService } from '../modules/rules/rbac.service.ts';
import { adminService } from '../modules/admin/admin.service.ts';
import { riskService } from '../modules/risk/risk.service.ts';

let seeded = false;

/**
 * Bootstraps mandatory database rules (RBAC permissions, fees, limits) in every environment,
 * and seeds demo/sandbox accounts ONLY in non-production dev environments.
 */
export async function seedStagingData() {
  // Always populate database RBAC & default financial rules in ALL environments (including production)
  rulesService.ensureDefaultRules();
  rbacService.ensureRbacRulesInDb();

  // Never seed demo users or staff accounts in production or test runners
  if (seeded || process.env.NODE_ENV === 'production' || process.env.VITEST) return;
  seeded = true;

  const demoPasswordHash = await hashPassword('ComfortWallet#2026');
  const pin1 = await hashPin('482910');
  const pin2 = await hashPin('739104');

  const now = new Date().toISOString();

  // 1. Primary Demo User: Tendai Moyo (KYC Approved, USD & ZWG wallets)
  const tendaiId = 'usr_demo_tendai';
  dbStore.users.set(tendaiId, {
    id: tendaiId,
    email: 'tendai@comfortwallet.zw',
    phone: '+263771234567',
    passwordHash: demoPasswordHash,
    googleId: null,
    role: Role.USER,
    staffStatus: 'NONE',
    requestedRole: null,
    status: UserStatus.ACTIVE,
    freezeReason: null,
    kycStatus: KycStatus.APPROVED,
    kycTier: 1,
    emailVerified: true,
    phoneVerified: true,
    totpEnabled: false,
    legalAcceptedAt: now,
    createdAt: now,
  });
  dbStore.userProfiles.set(tendaiId, {
    userId: tendaiId,
    fullName: 'Tendai Moyo',
    dateOfBirth: '1993-04-18',
    nationalIdEncrypted: encryptField('63-1482910-F-42'),
    address: '14 Samora Machel Ave, Harare, Zimbabwe',
    country: 'ZW',
    updatedAt: now,
  });
  dbStore.pins.set(tendaiId, {
    userId: tendaiId,
    pinHash: pin1.hash,
    salt: pin1.salt,
    failedAttempts: 0,
    lockoutCount: 0,
    lockedUntil: null,
    requiresComplianceReview: false,
    updatedAt: now,
  });

  // 2. Second KYC-Approved User: Rumbidzai Chikwanda (Recipient for P2P transfer tests)
  const rumbiId = 'usr_demo_rumbidzai';
  dbStore.users.set(rumbiId, {
    id: rumbiId,
    email: 'rumbidzai@comfortwallet.zw',
    phone: '+263772345678',
    passwordHash: demoPasswordHash,
    googleId: null,
    role: Role.USER,
    staffStatus: 'NONE',
    requestedRole: null,
    status: UserStatus.ACTIVE,
    freezeReason: null,
    kycStatus: KycStatus.APPROVED,
    kycTier: 1,
    emailVerified: true,
    phoneVerified: true,
    totpEnabled: false,
    legalAcceptedAt: now,
    createdAt: now,
  });
  dbStore.userProfiles.set(rumbiId, {
    userId: rumbiId,
    fullName: 'Rumbidzai Chikwanda',
    dateOfBirth: '1995-09-22',
    nationalIdEncrypted: encryptField('63-2291045-K-19'),
    address: '88 Fife Street, Bulawayo, Zimbabwe',
    country: 'ZW',
    updatedAt: now,
  });
  dbStore.pins.set(rumbiId, {
    userId: rumbiId,
    pinHash: pin2.hash,
    salt: pin2.salt,
    failedAttempts: 0,
    lockoutCount: 0,
    lockedUntil: null,
    requiresComplianceReview: false,
    updatedAt: now,
  });

  // 3. Pending KYC User: Chipo Ndlovu (for KYC Officer review queue)
  const chipoId = 'usr_demo_chipo';
  dbStore.users.set(chipoId, {
    id: chipoId,
    email: 'chipo@comfortwallet.zw',
    phone: '+263773456789',
    passwordHash: demoPasswordHash,
    googleId: null,
    role: Role.USER,
    staffStatus: 'NONE',
    requestedRole: null,
    status: UserStatus.ACTIVE,
    freezeReason: null,
    kycStatus: KycStatus.PENDING,
    kycTier: 0,
    emailVerified: true,
    phoneVerified: true,
    totpEnabled: false,
    legalAcceptedAt: now,
    createdAt: now,
  });
  dbStore.userProfiles.set(chipoId, {
    userId: chipoId,
    fullName: 'Chipo Ndlovu',
    dateOfBirth: '1998-01-12',
    nationalIdEncrypted: encryptField('08-9182736-G-21'),
    address: '21 Jason Moyo Rd, Mutare, Zimbabwe',
    country: 'ZW',
    updatedAt: now,
  });

  // 4. Staging-Only Staff Accounts (omitted completely when NODE_ENV === 'production')
  const staffDefs: Array<{ id: string; email: string; role: Role; name: string }> = [
    { id: 'stf_super_admin', email: 'superadmin@comfortwallet.zw', role: Role.SUPER_ADMIN, name: 'Tariro Gumbo (Super Admin)' },
    { id: 'stf_fin_maker', email: 'maker@comfortwallet.zw', role: Role.FINANCE_MAKER, name: 'Kudzai Ncube (Finance Maker)' },
    { id: 'stf_fin_checker', email: 'checker@comfortwallet.zw', role: Role.FINANCE_CHECKER, name: 'Farai Sibanda (Finance Checker)' },
    { id: 'stf_kyc_officer', email: 'kyc@comfortwallet.zw', role: Role.KYC_OFFICER, name: 'Nyasha Banda (KYC Officer)' },
    { id: 'stf_support', email: 'support@comfortwallet.zw', role: Role.SUPPORT_AGENT, name: 'Tatenda Dube (Support Agent)' },
    { id: 'stf_compliance', email: 'compliance@comfortwallet.zw', role: Role.COMPLIANCE_OFFICER, name: 'Vimbai Mutasa (Compliance)' },
    { id: 'stf_auditor', email: 'auditor@comfortwallet.zw', role: Role.AUDITOR, name: 'Blessing Zhou (Auditor)' },
  ];

  for (const stf of staffDefs) {
    dbStore.users.set(stf.id, {
      id: stf.id,
      email: stf.email,
      phone: null,
      passwordHash: demoPasswordHash,
      googleId: null,
      role: stf.role,
      staffStatus: 'APPROVED',
      requestedRole: stf.role,
      status: UserStatus.ACTIVE,
      freezeReason: null,
      kycStatus: KycStatus.APPROVED,
      kycTier: 2,
      emailVerified: true,
      phoneVerified: true,
      totpEnabled: true,
      legalAcceptedAt: now,
      createdAt: now,
    });
    dbStore.userProfiles.set(stf.id, {
      userId: stf.id,
      fullName: stf.name,
      dateOfBirth: '1988-05-05',
      nationalIdEncrypted: encryptField('63-0000001-S-01'),
      address: 'Comfort Secure Wallet HQ, Harare',
      country: 'ZW',
      updatedAt: now,
    });
    dbStore.pins.set(stf.id, {
      userId: stf.id,
      pinHash: pin1.hash,
      salt: pin1.salt,
      failedAttempts: 0,
      lockoutCount: 0,
      lockedUntil: null,
      requiresComplianceReview: false,
      updatedAt: now,
    });
  }

  // Provision deterministic Luhn wallet accounts for Tendai & Rumbidzai
  const existingSet = new Set<string>();
  const tendaiUsdAccNum = generateLuhnAccountNumber(existingSet);
  existingSet.add(tendaiUsdAccNum);
  const tendaiZwgAccNum = generateLuhnAccountNumber(existingSet);
  existingSet.add(tendaiZwgAccNum);
  const rumbiUsdAccNum = generateLuhnAccountNumber(existingSet);
  existingSet.add(rumbiUsdAccNum);

  const tendaiUsdAcc = {
    id: 'acc_tendai_usd',
    userId: tendaiId,
    accountNumber: tendaiUsdAccNum,
    currency: Currency.USD,
    status: AccountStatus.ACTIVE,
    createdAt: now,
  };
  const tendaiZwgAcc = {
    id: 'acc_tendai_zwg',
    userId: tendaiId,
    accountNumber: tendaiZwgAccNum,
    currency: Currency.ZWG,
    status: AccountStatus.ACTIVE,
    createdAt: now,
  };
  const rumbiUsdAcc = {
    id: 'acc_rumbi_usd',
    userId: rumbiId,
    accountNumber: rumbiUsdAccNum,
    currency: Currency.USD,
    status: AccountStatus.ACTIVE,
    createdAt: now,
  };

  dbStore.accounts.set(tendaiUsdAcc.id, tendaiUsdAcc);
  dbStore.accounts.set(tendaiZwgAcc.id, tendaiZwgAcc);
  dbStore.accounts.set(rumbiUsdAcc.id, rumbiUsdAcc);

  dbStore.ledgerAccounts.set('la_tendai_usd', {
    id: 'la_tendai_usd',
    type: LedgerAccountType.USER_WALLET,
    accountId: tendaiUsdAcc.id,
    currency: Currency.USD,
    cachedBalanceMinor: 0,
  });
  dbStore.ledgerAccounts.set('la_tendai_zwg', {
    id: 'la_tendai_zwg',
    type: LedgerAccountType.USER_WALLET,
    accountId: tendaiZwgAcc.id,
    currency: Currency.ZWG,
    cachedBalanceMinor: 0,
  });
  dbStore.ledgerAccounts.set('la_rumbi_usd', {
    id: 'la_rumbi_usd',
    type: LedgerAccountType.USER_WALLET,
    accountId: rumbiUsdAcc.id,
    currency: Currency.USD,
    cachedBalanceMinor: 0,
  });

  // Post initial double-entry deposit of $250.00 USD to Tendai and $120.00 USD to Rumbidzai
  const bankUsd = dbStore.getSystemLedgerAccount(LedgerAccountType.BANK_SETTLEMENT, Currency.USD);
  const feeUsd = dbStore.getSystemLedgerAccount(LedgerAccountType.FEE_REVENUE, Currency.USD);

  await ledgerService.postAtomicTransaction({
    type: TransactionType.DEPOSIT,
    amountMinor: 25000,
    feeMinor: 0,
    currency: Currency.USD,
    fromAccountId: null,
    toAccountId: tendaiUsdAcc.id,
    reference: 'ZB-2026-00412',
    idempotencyKey: 'seed_dep_tendai_usd',
    description: 'Initial verified bank settlement deposit (ZB-2026-00412)',
    legs: [
      { ledgerAccountId: bankUsd.id, direction: JournalDirection.DEBIT, amountMinor: 25000, currency: Currency.USD },
      { ledgerAccountId: 'la_tendai_usd', direction: JournalDirection.CREDIT, amountMinor: 25000, currency: Currency.USD },
    ],
  });

  await ledgerService.postAtomicTransaction({
    type: TransactionType.DEPOSIT,
    amountMinor: 12000,
    feeMinor: 0,
    currency: Currency.USD,
    fromAccountId: null,
    toAccountId: rumbiUsdAcc.id,
    reference: 'ECO-2026-88120',
    idempotencyKey: 'seed_dep_rumbi_usd',
    description: 'Initial verified EcoCash settlement deposit (ECO-2026-88120)',
    legs: [
      { ledgerAccountId: bankUsd.id, direction: JournalDirection.DEBIT, amountMinor: 12000, currency: Currency.USD },
      { ledgerAccountId: 'la_rumbi_usd', direction: JournalDirection.CREDIT, amountMinor: 12000, currency: Currency.USD },
    ],
  });

  // Post a sample $20.00 transfer with $0.20 fee from Tendai to Rumbidzai
  await ledgerService.postAtomicTransaction({
    type: TransactionType.TRANSFER,
    amountMinor: 2000,
    feeMinor: 20,
    currency: Currency.USD,
    fromAccountId: tendaiUsdAcc.id,
    toAccountId: rumbiUsdAcc.id,
    reference: 'TRF-SEED-901A',
    idempotencyKey: 'seed_trf_tendai_rumbi',
    description: `Transfer to ${rumbiUsdAcc.accountNumber}: Harare invoice settlement`,
    legs: [
      { ledgerAccountId: 'la_tendai_usd', direction: JournalDirection.DEBIT, amountMinor: 2020, currency: Currency.USD },
      { ledgerAccountId: 'la_rumbi_usd', direction: JournalDirection.CREDIT, amountMinor: 2000, currency: Currency.USD },
      { ledgerAccountId: feeUsd.id, direction: JournalDirection.CREDIT, amountMinor: 20, currency: Currency.USD },
    ],
  });

  // Seed 1 pending deposit request for Maker-Checker demo queue
  dbStore.depositRequests.set('dep_seed_pending_1', {
    id: 'dep_seed_pending_1',
    userId: tendaiId,
    accountId: tendaiUsdAcc.id,
    amountMinor: 5000,
    currency: Currency.USD,
    method: 'ECOCASH',
    proofStorageKey: 'private/seed/sample-proof',
    paymentReference: 'ECO-2026-99301',
    status: DepositStatus.PENDING,
    makerId: null,
    checkerId: null,
    decidedAt: null,
    notes: null,
    createdAt: now,
  });

  // Seed 1 pending withdrawal request in hold for Maker-Checker demo queue
  const holdUsd = dbStore.getSystemLedgerAccount(LedgerAccountType.WITHDRAWAL_HOLD, Currency.USD);
  await ledgerService.postAtomicTransaction({
    type: TransactionType.WITHDRAWAL,
    amountMinor: 3000,
    feeMinor: 0,
    currency: Currency.USD,
    fromAccountId: tendaiUsdAcc.id,
    toAccountId: null,
    reference: 'WDR-SEED-301',
    idempotencyKey: 'seed_wdr_hold_1',
    description: 'Withdrawal hold (INNBUCKS)',
    legs: [
      { ledgerAccountId: 'la_tendai_usd', direction: JournalDirection.DEBIT, amountMinor: 3000, currency: Currency.USD },
      { ledgerAccountId: holdUsd.id, direction: JournalDirection.CREDIT, amountMinor: 3000, currency: Currency.USD },
    ],
  });
  dbStore.withdrawalRequests.set('wdr_seed_pending_1', {
    id: 'wdr_seed_pending_1',
    userId: tendaiId,
    accountId: tendaiUsdAcc.id,
    amountMinor: 3000,
    currency: Currency.USD,
    destinationDetailsEncrypted: encryptField('INNBUCKS|+263771234567'),
    destinationPreview: 'INNBUCKS: ••••4567',
    status: WithdrawalStatus.PENDING,
    makerId: null,
    checkerId: null,
    payoutReference: null,
    decidedAt: null,
    rejectionReason: null,
    createdAt: now,
  });

  // Seed a sample daily reconciliation run & risk flag
  adminService.runDailyReconciliation(Currency.USD);
  riskService.raiseFlag({
    userId: chipoId,
    rule: 'NEW_DEVICE_SIGNIN',
    severity: RiskSeverity.LOW,
    details: 'Initial onboarding session flagged for baseline KYC correlation.',
  });

  recordAuditLog({
    actorId: 'system',
    actorType: 'SYSTEM',
    action: 'STAGING_SEED_INITIALIZED',
    entity: 'system:staging',
    after: { accountsCreated: 3, usersSeeded: 10 },
  });
}
