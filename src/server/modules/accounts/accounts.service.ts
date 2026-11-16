import { randomUUID } from 'node:crypto';
import {
  AccountRecord,
  AccountStatus,
  Currency,
  KycStatus,
  LedgerAccountRecord,
  LedgerAccountType,
} from '../../../shared/types.ts';
import { generateLuhnAccountNumber, maskRecipientName } from '../../../shared/luhn.ts';
import { dbStore } from '../../db/store.ts';
import { ledgerService } from '../ledger/ledger.service.ts';

class AccountsService {
  /**
   * Provisions USD and ZWG wallet accounts + unique 10-digit Luhn account numbers
   * ONLY after KYC approval.
   */
  provisionWalletsForApprovedUser(userId: string): AccountRecord[] {
    const user = dbStore.users.get(userId);
    if (!user) throw new Error('User not found');
    if (user.kycStatus !== KycStatus.APPROVED) {
      throw new Error('KYC_REQUIRED: Wallet accounts can only be provisioned after KYC approval.');
    }

    const existingAccounts = [...dbStore.accounts.values()].filter((a) => a.userId === userId);
    if (existingAccounts.length > 0) return existingAccounts;

    const existingNumbers = new Set([...dbStore.accounts.values()].map((a) => a.accountNumber));
    const created: AccountRecord[] = [];
    const now = new Date().toISOString();

    for (const currency of [Currency.USD, Currency.ZWG]) {
      const accountNumber = generateLuhnAccountNumber(existingNumbers);
      existingNumbers.add(accountNumber);

      const account: AccountRecord = {
        id: `acc_${randomUUID()}`,
        userId,
        accountNumber,
        currency,
        status: AccountStatus.ACTIVE,
        createdAt: now,
      };
      dbStore.accounts.set(account.id, account);
      dbStore.mirrorDoc('accounts', account.id, account as unknown as Record<string, unknown>);

      const ledgerAccount: LedgerAccountRecord = {
        id: `la_${randomUUID()}`,
        type: LedgerAccountType.USER_WALLET,
        accountId: account.id,
        currency,
        cachedBalanceMinor: 0,
      };
      dbStore.ledgerAccounts.set(ledgerAccount.id, ledgerAccount);
      created.push(account);
    }

    return created;
  }

  listUserAccounts(userId: string) {
    return [...dbStore.accounts.values()]
      .filter((a) => a.userId === userId)
      .map((a) => ({
        id: a.id,
        accountNumber: a.accountNumber,
        currency: a.currency,
        status: a.status,
        createdAt: a.createdAt,
      }));
  }

  getVerifiedBalance(userId: string, accountId: string): {
    accountId: string;
    accountNumber: string;
    currency: Currency;
    balanceMinor: number;
    holdMinor: number;
  } {
    const account = dbStore.accounts.get(accountId);
    if (!account || account.userId !== userId) {
      throw new Error('Account not found');
    }
    const ledgerAcc = dbStore.getUserWalletLedgerAccount(account.id);
    if (!ledgerAcc) {
      throw new Error('Ledger wallet account missing');
    }
    const derived = ledgerService.deriveBalanceFromJournal(ledgerAcc.id);

    // Sum active withdrawal holds for this account
    let holdMinor = 0;
    for (const w of dbStore.withdrawalRequests.values()) {
      if (
        w.accountId === account.id &&
        (w.status === 'PENDING' || w.status === 'MAKER_APPROVED' || w.status === 'CHECKER_APPROVED')
      ) {
        holdMinor += w.amountMinor;
      }
    }

    return {
      accountId: account.id,
      accountNumber: account.accountNumber,
      currency: account.currency,
      balanceMinor: derived,
      holdMinor,
    };
  }

  lookupByAccountNumber(accountNumber: string): {
    accountNumber: string;
    currency: Currency;
    maskedName: string;
    status: AccountStatus;
  } {
    const account = [...dbStore.accounts.values()].find((a) => a.accountNumber === accountNumber);
    if (!account) {
      throw new Error('RECIPIENT_NOT_FOUND: No wallet found for that 10-digit account number.');
    }
    const profile = dbStore.userProfiles.get(account.userId);
    const maskedName = maskRecipientName(profile?.fullName || 'Wallet User');
    return {
      accountNumber: account.accountNumber,
      currency: account.currency,
      maskedName,
      status: account.status,
    };
  }
}

export const accountsService = new AccountsService();
