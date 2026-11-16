import { beforeEach, describe, expect, it } from 'vitest';
import {
  AccountStatus,
  Currency,
  JournalDirection,
  LedgerAccountType,
  TransactionType,
} from '../src/shared/types.ts';
import { dbStore } from '../src/server/db/store.ts';
import { ledgerService } from '../src/server/modules/ledger/ledger.service.ts';

function setupWalletPair() {
  dbStore.resetForTests();
  dbStore.accounts.set('acc_a', {
    id: 'acc_a',
    userId: 'u_a',
    accountNumber: '1000000009',
    currency: Currency.USD,
    status: AccountStatus.ACTIVE,
    createdAt: new Date().toISOString(),
  });
  dbStore.accounts.set('acc_b', {
    id: 'acc_b',
    userId: 'u_b',
    accountNumber: '2000000007',
    currency: Currency.USD,
    status: AccountStatus.ACTIVE,
    createdAt: new Date().toISOString(),
  });
  dbStore.ledgerAccounts.set('la_a', {
    id: 'la_a',
    type: LedgerAccountType.USER_WALLET,
    accountId: 'acc_a',
    currency: Currency.USD,
    cachedBalanceMinor: 0,
  });
  dbStore.ledgerAccounts.set('la_b', {
    id: 'la_b',
    type: LedgerAccountType.USER_WALLET,
    accountId: 'acc_b',
    currency: Currency.USD,
    cachedBalanceMinor: 0,
  });
}

describe('Double-Entry Ledger Unit & Property Tests', () => {
  beforeEach(() => {
    setupWalletPair();
  });

  it('rejects unbalanced journal entries where debits != credits', async () => {
    const bank = dbStore.getSystemLedgerAccount(LedgerAccountType.BANK_SETTLEMENT, Currency.USD);
    await expect(
      ledgerService.postAtomicTransaction({
        type: TransactionType.DEPOSIT,
        amountMinor: 5000,
        feeMinor: 0,
        currency: Currency.USD,
        fromAccountId: null,
        toAccountId: 'acc_a',
        reference: 'REF-UNBALANCED',
        idempotencyKey: 'idem_unbalanced',
        description: 'Unbalanced test',
        legs: [
          { ledgerAccountId: bank.id, direction: JournalDirection.DEBIT, amountMinor: 5000, currency: Currency.USD },
          { ledgerAccountId: 'la_a', direction: JournalDirection.CREDIT, amountMinor: 4999, currency: Currency.USD },
        ],
      }),
    ).rejects.toThrow(/LEDGER_IMBALANCE/);
    expect(dbStore.journalLines.length).toBe(0);
  });

  it('prevents negative user wallet balances atomically', async () => {
    await expect(
      ledgerService.postAtomicTransaction({
        type: TransactionType.TRANSFER,
        amountMinor: 1000,
        feeMinor: 0,
        currency: Currency.USD,
        fromAccountId: 'acc_a',
        toAccountId: 'acc_b',
        reference: 'REF-NEG',
        idempotencyKey: 'idem_neg',
        description: 'Overdraft attempt',
        legs: [
          { ledgerAccountId: 'la_a', direction: JournalDirection.DEBIT, amountMinor: 1000, currency: Currency.USD },
          { ledgerAccountId: 'la_b', direction: JournalDirection.CREDIT, amountMinor: 1000, currency: Currency.USD },
        ],
      }),
    ).rejects.toThrow(/INSUFFICIENT_FUNDS/);
    expect(ledgerService.deriveBalanceFromJournal('la_a')).toBe(0);
    expect(ledgerService.deriveBalanceFromJournal('la_b')).toBe(0);
  });

  it('supports immutable reversals instead of editing original entries', async () => {
    const bank = dbStore.getSystemLedgerAccount(LedgerAccountType.BANK_SETTLEMENT, Currency.USD);
    const dep = await ledgerService.postAtomicTransaction({
      type: TransactionType.DEPOSIT,
      amountMinor: 10000,
      feeMinor: 0,
      currency: Currency.USD,
      fromAccountId: null,
      toAccountId: 'acc_a',
      reference: 'DEP-1',
      idempotencyKey: 'idem_dep_1',
      description: 'Deposit 100.00',
      legs: [
        { ledgerAccountId: bank.id, direction: JournalDirection.DEBIT, amountMinor: 10000, currency: Currency.USD },
        { ledgerAccountId: 'la_a', direction: JournalDirection.CREDIT, amountMinor: 10000, currency: Currency.USD },
      ],
    });
    expect(ledgerService.deriveBalanceFromJournal('la_a')).toBe(10000);

    await ledgerService.reverseTransaction(dep.transaction.id, 'Bank recalled credit', 'rev_1');
    expect(ledgerService.deriveBalanceFromJournal('la_a')).toBe(0);
    // Original journal lines remain untouched + reversal lines appended
    expect(dbStore.journalEntries.length).toBe(2);
    expect(ledgerService.verifyGlobalInvariant().valid).toBe(true);
  });

  it('property test: total debits ALWAYS equal total credits across 100 random ledger operations', async () => {
    const bank = dbStore.getSystemLedgerAccount(LedgerAccountType.BANK_SETTLEMENT, Currency.USD);
    const feeRev = dbStore.getSystemLedgerAccount(LedgerAccountType.FEE_REVENUE, Currency.USD);
    const hold = dbStore.getSystemLedgerAccount(LedgerAccountType.WITHDRAWAL_HOLD, Currency.USD);

    // Deterministic PRNG for reproducible property test
    let seed = 424242;
    const nextRand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };

    for (let i = 0; i < 100; i++) {
      const op = Math.floor(nextRand() * 3);
      const amount = 100 + Math.floor(nextRand() * 4000);

      if (op === 0) {
        // Deposit to A or B
        const target = nextRand() < 0.5 ? 'la_a' : 'la_b';
        await ledgerService.postAtomicTransaction({
          type: TransactionType.DEPOSIT,
          amountMinor: amount,
          feeMinor: 0,
          currency: Currency.USD,
          fromAccountId: null,
          toAccountId: target === 'la_a' ? 'acc_a' : 'acc_b',
          reference: `PROP-DEP-${i}`,
          idempotencyKey: `prop_dep_${i}`,
          description: 'Property deposit',
          legs: [
            { ledgerAccountId: bank.id, direction: JournalDirection.DEBIT, amountMinor: amount, currency: Currency.USD },
            { ledgerAccountId: target, direction: JournalDirection.CREDIT, amountMinor: amount, currency: Currency.USD },
          ],
        });
      } else if (op === 1) {
        // Transfer between A and B with fee, expecting clean failure if insufficient funds
        const fee = Math.max(10, Math.floor(amount * 0.005));
        const fromA = nextRand() < 0.5;
        const fromLa = fromA ? 'la_a' : 'la_b';
        const toLa = fromA ? 'la_b' : 'la_a';
        try {
          await ledgerService.postAtomicTransaction({
            type: TransactionType.TRANSFER,
            amountMinor: amount,
            feeMinor: fee,
            currency: Currency.USD,
            fromAccountId: fromA ? 'acc_a' : 'acc_b',
            toAccountId: fromA ? 'acc_b' : 'acc_a',
            reference: `PROP-TRF-${i}`,
            idempotencyKey: `prop_trf_${i}`,
            description: 'Property transfer',
            legs: [
              { ledgerAccountId: fromLa, direction: JournalDirection.DEBIT, amountMinor: amount + fee, currency: Currency.USD },
              { ledgerAccountId: toLa, direction: JournalDirection.CREDIT, amountMinor: amount, currency: Currency.USD },
              { ledgerAccountId: feeRev.id, direction: JournalDirection.CREDIT, amountMinor: fee, currency: Currency.USD },
            ],
          });
        } catch (err) {
          expect(String(err)).toMatch(/INSUFFICIENT_FUNDS/);
        }
      } else {
        // Withdrawal hold attempt
        const fromLa = nextRand() < 0.5 ? 'la_a' : 'la_b';
        try {
          await ledgerService.postAtomicTransaction({
            type: TransactionType.WITHDRAWAL,
            amountMinor: amount,
            feeMinor: 0,
            currency: Currency.USD,
            fromAccountId: fromLa === 'la_a' ? 'acc_a' : 'acc_b',
            toAccountId: null,
            reference: `PROP-WDR-${i}`,
            idempotencyKey: `prop_wdr_${i}`,
            description: 'Property withdrawal hold',
            legs: [
              { ledgerAccountId: fromLa, direction: JournalDirection.DEBIT, amountMinor: amount, currency: Currency.USD },
              { ledgerAccountId: hold.id, direction: JournalDirection.CREDIT, amountMinor: amount, currency: Currency.USD },
            ],
          });
        } catch (err) {
          expect(String(err)).toMatch(/INSUFFICIENT_FUNDS/);
        }
      }

      const invariant = ledgerService.verifyGlobalInvariant();
      expect(invariant.valid).toBe(true);
      expect(ledgerService.deriveBalanceFromJournal('la_a')).toBeGreaterThanOrEqual(0);
      expect(ledgerService.deriveBalanceFromJournal('la_b')).toBeGreaterThanOrEqual(0);
    }
  });
});
