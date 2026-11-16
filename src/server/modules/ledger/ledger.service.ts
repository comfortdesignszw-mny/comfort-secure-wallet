import { randomUUID } from 'node:crypto';
import {
  Currency,
  JournalDirection,
  JournalEntryRecord,
  JournalLineRecord,
  LedgerAccountRecord,
  LedgerAccountType,
  TransactionRecord,
  TransactionStatus,
  TransactionType,
} from '../../../shared/types.ts';
import { assertMinorUnits } from '../../../shared/money.ts';
import { dbStore } from '../../db/store.ts';

export interface PostingLeg {
  ledgerAccountId: string;
  direction: JournalDirection;
  amountMinor: number;
  currency: Currency;
}

class LedgerService {
  /**
   * Derive balance directly from immutable journal_lines.
   * For user_wallet, withdrawal_hold, fee_revenue: liability/equity convention -> credits - debits.
   * For bank_settlement, suspense: asset/clearing convention -> debits - credits (or net signed balance).
   * Using standard signed ledger balance: credits - debits for liability accounts (user_wallet, withdrawal_hold, fee_revenue),
   * and debits - credits for asset accounts (bank_settlement, suspense) so assets == liabilities + revenue!
   */
  deriveBalanceFromJournal(ledgerAccountId: string): number {
    const account = dbStore.ledgerAccounts.get(ledgerAccountId);
    if (!account) throw new Error(`Ledger account ${ledgerAccountId} not found`);

    const isAsset =
      account.type === LedgerAccountType.BANK_SETTLEMENT ||
      account.type === LedgerAccountType.SUSPENSE;

    let total = 0;
    for (const line of dbStore.journalLines) {
      if (line.ledgerAccountId !== ledgerAccountId) continue;
      if (isAsset) {
        total += line.direction === JournalDirection.DEBIT ? line.amountMinor : -line.amountMinor;
      } else {
        total += line.direction === JournalDirection.CREDIT ? line.amountMinor : -line.amountMinor;
      }
    }
    return total;
  }

  /**
   * Post an atomic double-entry transaction + journal entry + journal lines.
   * Must be invoked inside dbStore.runInTransaction(...) or acquires ordered locks automatically.
   */
  async postAtomicTransaction(params: {
    type: TransactionType;
    amountMinor: number;
    feeMinor: number;
    currency: Currency;
    fromAccountId: string | null;
    toAccountId: string | null;
    reference: string;
    idempotencyKey: string;
    description: string;
    legs: PostingLeg[];
    metadata?: Record<string, unknown>;
  }): Promise<{ transaction: TransactionRecord; journalEntry: JournalEntryRecord; lines: JournalLineRecord[] }> {
    assertMinorUnits(params.amountMinor);
    if (!Number.isSafeInteger(params.feeMinor) || params.feeMinor < 0) {
      throw new Error('Invalid feeMinor');
    }
    if (params.legs.length < 2) {
      throw new Error('Double-entry posting requires at least 2 journal legs');
    }

    // Verify debits == credits per currency BEFORE touching state
    let totalDebits = 0;
    let totalCredits = 0;
    for (const leg of params.legs) {
      assertMinorUnits(leg.amountMinor);
      if (leg.currency !== params.currency) {
        throw new Error(`Cross-currency journal line rejected (${leg.currency} != ${params.currency})`);
      }
      if (leg.direction === JournalDirection.DEBIT) totalDebits += leg.amountMinor;
      else totalCredits += leg.amountMinor;
    }
    if (totalDebits !== totalCredits || totalDebits === 0) {
      throw new Error(`LEDGER_IMBALANCE: Debits (${totalDebits}) must equal Credits (${totalCredits})`);
    }

    const lockKeys = params.legs.map((l) => `ledger:${l.ledgerAccountId}`);

    return dbStore.runInTransaction(lockKeys, async () => {
      // Check idempotency inside the lock
      for (const existingTxn of dbStore.transactions.values()) {
        if (existingTxn.idempotencyKey === params.idempotencyKey) {
          const existingEntry = dbStore.journalEntries.find((e) => e.transactionId === existingTxn.id);
          const existingLines = existingEntry
            ? dbStore.journalLines.filter((l) => l.entryId === existingEntry.id)
            : [];
          return {
            transaction: existingTxn,
            journalEntry: existingEntry!,
            lines: existingLines,
          };
        }
      }

      const now = new Date().toISOString();
      const transaction: TransactionRecord = {
        id: `txn_${randomUUID()}`,
        type: params.type,
        status: TransactionStatus.COMPLETED,
        amountMinor: params.amountMinor,
        feeMinor: params.feeMinor,
        currency: params.currency,
        fromAccountId: params.fromAccountId,
        toAccountId: params.toAccountId,
        reference: params.reference,
        idempotencyKey: params.idempotencyKey,
        metadata: params.metadata || {},
        createdAt: now,
      };

      const journalEntry: JournalEntryRecord = {
        id: `je_${randomUUID()}`,
        transactionId: transaction.id,
        description: params.description,
        createdAt: now,
      };

      const lines: JournalLineRecord[] = [];

      for (const leg of params.legs) {
        const la = dbStore.ledgerAccounts.get(leg.ledgerAccountId);
        if (!la) {
          throw new Error(`Ledger account ${leg.ledgerAccountId} does not exist`);
        }
        if (la.currency !== leg.currency) {
          throw new Error(`Currency mismatch on ledger account ${la.id}`);
        }

        const isAsset =
          la.type === LedgerAccountType.BANK_SETTLEMENT ||
          la.type === LedgerAccountType.SUSPENSE;

        const delta = isAsset
          ? leg.direction === JournalDirection.DEBIT
            ? leg.amountMinor
            : -leg.amountMinor
          : leg.direction === JournalDirection.CREDIT
            ? leg.amountMinor
            : -leg.amountMinor;

        const nextBalance = la.cachedBalanceMinor + delta;

        // Rule 6: No negative balances for user_wallet or withdrawal_hold
        if (
          (la.type === LedgerAccountType.USER_WALLET || la.type === LedgerAccountType.WITHDRAWAL_HOLD) &&
          nextBalance < 0
        ) {
          throw new Error(`INSUFFICIENT_FUNDS: Balance cannot go negative on ${la.type} (${la.id})`);
        }

        la.cachedBalanceMinor = nextBalance;

        const line: JournalLineRecord = {
          id: `jl_${randomUUID()}`,
          entryId: journalEntry.id,
          ledgerAccountId: la.id,
          direction: leg.direction,
          amountMinor: leg.amountMinor,
          currency: leg.currency,
          createdAt: now,
        };
        lines.push(line);
        dbStore.journalLines.push(line);
      }

      dbStore.transactions.set(transaction.id, transaction);
      dbStore.journalEntries.push(journalEntry);

      // Verify cached balance matches derived journal lines for every affected ledger account
      for (const leg of params.legs) {
        const la = dbStore.ledgerAccounts.get(leg.ledgerAccountId)!;
        const derived = this.deriveBalanceFromJournal(la.id);
        if (derived !== la.cachedBalanceMinor) {
          throw new Error(`LEDGER_CORRUPTION: Cached (${la.cachedBalanceMinor}) != Derived (${derived})`);
        }
      }

      dbStore.mirrorDoc('transactions', transaction.id, transaction as unknown as Record<string, unknown>);
      dbStore.mirrorDoc('journal_entries', journalEntry.id, journalEntry as unknown as Record<string, unknown>);

      return { transaction, journalEntry, lines };
    });
  }

  /**
   * Reversal entry: never edits or deletes original journal lines; posts an opposite-direction reversal.
   */
  async reverseTransaction(originalTransactionId: string, reason: string, idempotencyKey: string): Promise<TransactionRecord> {
    const orig = dbStore.transactions.get(originalTransactionId);
    if (!orig) throw new Error('Original transaction not found');
    if (orig.status === TransactionStatus.REVERSED) {
      throw new Error('Transaction has already been reversed');
    }
    const origEntry = dbStore.journalEntries.find((e) => e.transactionId === orig.id);
    if (!origEntry) throw new Error('Original journal entry missing');
    const origLines = dbStore.journalLines.filter((l) => l.entryId === origEntry.id);

    const reversedLegs: PostingLeg[] = origLines.map((l) => ({
      ledgerAccountId: l.ledgerAccountId,
      direction: l.direction === JournalDirection.DEBIT ? JournalDirection.CREDIT : JournalDirection.DEBIT,
      amountMinor: l.amountMinor,
      currency: l.currency,
    }));

    const result = await this.postAtomicTransaction({
      type: TransactionType.REVERSAL,
      amountMinor: orig.amountMinor,
      feeMinor: orig.feeMinor,
      currency: orig.currency,
      fromAccountId: orig.toAccountId,
      toAccountId: orig.fromAccountId,
      reference: `REV-${orig.reference}`,
      idempotencyKey,
      description: `Reversal of ${orig.reference}: ${reason}`,
      legs: reversedLegs,
      metadata: { reversedTransactionId: orig.id, reason },
    });

    orig.status = TransactionStatus.REVERSED;
    return result.transaction;
  }

  /**
   * Global double-entry invariant check across all journal lines per currency.
   */
  verifyGlobalInvariant(): { valid: boolean; byCurrency: Record<string, { debits: number; credits: number; balanced: boolean }> } {
    const totals: Record<string, { debits: number; credits: number }> = {};
    for (const line of dbStore.journalLines) {
      if (!totals[line.currency]) totals[line.currency] = { debits: 0, credits: 0 };
      if (line.direction === JournalDirection.DEBIT) totals[line.currency].debits += line.amountMinor;
      else totals[line.currency].credits += line.amountMinor;
    }
    let valid = true;
    const byCurrency: Record<string, { debits: number; credits: number; balanced: boolean }> = {};
    for (const [cur, pair] of Object.entries(totals)) {
      const balanced = pair.debits === pair.credits;
      if (!balanced) valid = false;
      byCurrency[cur] = { ...pair, balanced };
    }
    return { valid, byCurrency };
  }

  getLedgerAccount(ledgerAccountId: string): LedgerAccountRecord | undefined {
    return dbStore.ledgerAccounts.get(ledgerAccountId);
  }
}

export const ledgerService = new LedgerService();
