import { randomUUID } from 'node:crypto';
import { jsPDF } from 'jspdf';
import { Currency, JournalDirection, StatementExportJob } from '../../../shared/types.ts';
import { formatMinorUnits } from '../../../shared/money.ts';
import { dbStore } from '../../db/store.ts';
import { encryptBuffer, signStorageKey } from '../../security/crypto.ts';

export interface StatementLine {
  transactionId: string;
  reference: string;
  type: string;
  description: string;
  direction: 'CREDIT' | 'DEBIT';
  amountMinor: number;
  feeMinor: number;
  runningBalanceMinor: number;
  createdAt: string;
}

export interface StatementReport {
  accountId: string;
  accountNumber: string;
  currency: Currency;
  holderName: string;
  from: string;
  to: string;
  generatedAt: string;
  openingBalanceMinor: number;
  closingBalanceMinor: number;
  entries: StatementLine[];
}

class StatementsService {
  buildStatement(userId: string, accountId: string, fromIso: string, toIso: string): StatementReport {
    const account = dbStore.accounts.get(accountId);
    if (!account || account.userId !== userId) throw new Error('Account not found');
    const userLedger = dbStore.getUserWalletLedgerAccount(account.id);
    if (!userLedger) throw new Error('Ledger wallet not found');
    const profile = dbStore.userProfiles.get(userId);

    const fromMs = Date.parse(fromIso);
    const toMs = Date.parse(toIso);

    // Collect every journal line touching this user's wallet ledger account in chronological order
    const entryById = new Map(dbStore.journalEntries.map((e) => [e.id, e]));
    const txnById = dbStore.transactions;

    const matchingLines = dbStore.journalLines
      .filter((l) => l.ledgerAccountId === userLedger.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    let openingBalanceMinor = 0;
    let running = 0;
    const entries: StatementLine[] = [];

    for (const line of matchingLines) {
      const ts = Date.parse(line.createdAt);
      const signed = line.direction === JournalDirection.CREDIT ? line.amountMinor : -line.amountMinor;
      if (ts < fromMs) {
        openingBalanceMinor += signed;
        running = openingBalanceMinor;
        continue;
      }
      if (ts > toMs) continue;

      running += signed;
      const je = entryById.get(line.entryId);
      const txn = je ? txnById.get(je.transactionId) : undefined;
      entries.push({
        transactionId: txn?.id || line.entryId,
        reference: txn?.reference || line.id,
        type: txn?.type || 'ledger',
        description: je?.description || 'Wallet movement',
        direction: line.direction === JournalDirection.CREDIT ? 'CREDIT' : 'DEBIT',
        amountMinor: line.amountMinor,
        feeMinor: txn?.feeMinor || 0,
        runningBalanceMinor: running,
        createdAt: line.createdAt,
      });
    }

    return {
      accountId: account.id,
      accountNumber: account.accountNumber,
      currency: account.currency,
      holderName: profile?.fullName || 'Verified Account Holder',
      from: fromIso,
      to: toIso,
      generatedAt: new Date().toISOString(),
      openingBalanceMinor,
      closingBalanceMinor: entries.length > 0 ? entries[entries.length - 1].runningBalanceMinor : openingBalanceMinor,
      entries,
    };
  }

  generateCsv(report: StatementReport): Buffer {
    const header = [
      `Comfort Secure Wallet Statement`,
      `Account Number,${report.accountNumber}`,
      `Currency,${report.currency}`,
      `Account Holder,"${report.holderName.replace(/"/g, '""')}"`,
      `Period,${report.from} to ${report.to}`,
      `Generated At,${report.generatedAt}`,
      `Opening Balance,${formatMinorUnits(report.openingBalanceMinor, report.currency)}`,
      `Closing Balance,${formatMinorUnits(report.closingBalanceMinor, report.currency)}`,
      '',
      'Timestamp,Reference,Type,Description,Direction,Amount,Fee,Running Balance',
    ];
    const rows = report.entries.map(
      (e) =>
        `"${e.createdAt}","${e.reference}","${e.type}","${e.description.replace(/"/g, '""')}","${e.direction}","${formatMinorUnits(e.amountMinor, report.currency)}","${formatMinorUnits(e.feeMinor, report.currency)}","${formatMinorUnits(e.runningBalanceMinor, report.currency)}"`,
    );
    return Buffer.from([...header, ...rows].join('\n'), 'utf8');
  }

  generateStatementPdf(report: StatementReport): Buffer {
    const doc = new jsPDF();
    doc.setFontSize(16);
    doc.text('Comfort Secure Wallet — Official Statement', 14, 18);
    doc.setFontSize(10);
    doc.text(`Account Holder: ${report.holderName}`, 14, 28);
    doc.text(`Account Number: ${report.accountNumber} (${report.currency})`, 14, 34);
    doc.text(`Period: ${report.from.slice(0, 10)} to ${report.to.slice(0, 10)}`, 14, 40);
    doc.text(`Generated: ${report.generatedAt}`, 14, 46);
    doc.text(`Opening Balance: ${formatMinorUnits(report.openingBalanceMinor, report.currency)}`, 14, 54);
    doc.text(`Closing Balance: ${formatMinorUnits(report.closingBalanceMinor, report.currency)}`, 110, 54);

    let y = 66;
    doc.setFontSize(9);
    doc.text('Date | Reference | Direction | Amount | Running Balance', 14, y);
    y += 6;
    for (const item of report.entries.slice(0, 35)) {
      const line = `${item.createdAt.slice(0, 10)} | ${item.reference} | ${item.direction} | ${formatMinorUnits(item.amountMinor, report.currency)} | ${formatMinorUnits(item.runningBalanceMinor, report.currency)}`;
      doc.text(line, 14, y);
      y += 6;
      if (y > 280) break;
    }
    const arrayBuffer = doc.output('arraybuffer');
    return Buffer.from(arrayBuffer);
  }

  generateReceiptPdf(userId: string, transactionId: string): Buffer {
    const txn = dbStore.transactions.get(transactionId);
    if (!txn) throw new Error('Transaction not found');
    const userAccountIds = new Set([...dbStore.accounts.values()].filter((a) => a.userId === userId).map((a) => a.id));
    if (
      (!txn.fromAccountId || !userAccountIds.has(txn.fromAccountId)) &&
      (!txn.toAccountId || !userAccountIds.has(txn.toAccountId))
    ) {
      throw new Error('FORBIDDEN: Transaction does not belong to user.');
    }

    const doc = new jsPDF();
    doc.setFontSize(16);
    doc.text('Comfort Secure Wallet — Transaction Receipt', 14, 20);
    doc.setFontSize(11);
    doc.text(`Reference: ${txn.reference}`, 14, 34);
    doc.text(`Type: ${txn.type.toUpperCase()}`, 14, 42);
    doc.text(`Status: ${txn.status}`, 14, 50);
    doc.text(`Amount: ${formatMinorUnits(txn.amountMinor, txn.currency)}`, 14, 58);
    doc.text(`Fee: ${formatMinorUnits(txn.feeMinor, txn.currency)}`, 14, 66);
    doc.text(`Timestamp: ${txn.createdAt}`, 14, 74);
    doc.text(`Transaction ID: ${txn.id}`, 14, 82);
    return Buffer.from(doc.output('arraybuffer'));
  }

  enqueueExportJob(params: {
    userId: string;
    accountId: string;
    from: string;
    to: string;
    format: 'CSV' | 'PDF';
  }): { job: StatementExportJob; downloadUrl: string } {
    const report = this.buildStatement(params.userId, params.accountId, params.from, params.to);
    const buffer = params.format === 'CSV' ? this.generateCsv(report) : this.generateStatementPdf(report);
    const mimeType = params.format === 'CSV' ? 'text/csv' : 'application/pdf';
    const storageKey = `private/statements/${params.userId}/${randomUUID()}.${params.format.toLowerCase()}`;
    dbStore.privateBlobs.set(storageKey, {
      storageKey,
      mimeType,
      encryptedPayload: encryptBuffer(buffer),
      ownerUserId: params.userId,
      createdAt: new Date().toISOString(),
    });
    const signed = signStorageKey(storageKey, 300);
    const job: StatementExportJob = {
      id: `exp_${randomUUID()}`,
      userId: params.userId,
      accountId: params.accountId,
      from: params.from,
      to: params.to,
      format: params.format,
      status: 'READY',
      downloadToken: signed.url,
      createdAt: new Date().toISOString(),
    };
    dbStore.statementJobs.set(job.id, job);
    return { job, downloadUrl: signed.url };
  }
}

export const statementsService = new StatementsService();
