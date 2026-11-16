import { randomUUID } from 'node:crypto';
import { NotificationChannel, NotificationPreferences, NotificationRecord } from '../../../shared/types.ts';
import { dbStore } from '../../db/store.ts';

export interface SmsAdapter {
  readonly providerName: string;
  sendSms(phone: string, message: string): Promise<{ providerId: string }>;
}

export interface EmailAdapter {
  readonly providerName: string;
  sendEmail(email: string, subject: string, body: string): Promise<{ providerId: string }>;
}

export interface PushAdapter {
  readonly providerName: string;
  sendPush(subscription: { endpoint: string; keys: Record<string, string> }, title: string, body: string): Promise<{ delivered: boolean }>;
}

/**
 * Africa's Talking SMS adapter (sandbox/live configurable via AFRICASTALKING_API_KEY).
 */
export class AfricasTalkingSmsAdapter implements SmsAdapter {
  readonly providerName = "Africa's Talking";

  async sendSms(phone: string, message: string): Promise<{ providerId: string }> {
    const apiKey = process.env.AFRICASTALKING_API_KEY;
    const username = process.env.AFRICASTALKING_USERNAME || 'sandbox';
    if (apiKey && process.env.NODE_ENV === 'production') {
      // Production hook for Africa's Talking REST API
      const res = await fetch('https://api.africastalking.com/version1/messaging', {
        method: 'POST',
        headers: {
          apiKey,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          username,
          to: phone,
          message,
          from: process.env.AFRICASTALKING_SENDER_ID || 'COMFORTPAY',
        }),
      });
      if (!res.ok) {
        throw new Error(`Africa's Talking SMS failed with HTTP ${res.status}`);
      }
    }
    return { providerId: `at_msg_${randomUUID().slice(0, 12)}` };
  }
}

export class TransactionalEmailAdapter implements EmailAdapter {
  readonly providerName = 'Resend/SES Adapter';
  async sendEmail(_email: string, _subject: string, _body: string): Promise<{ providerId: string }> {
    return { providerId: `em_${randomUUID().slice(0, 12)}` };
  }
}

export class WebPushVapidAdapter implements PushAdapter {
  readonly providerName = 'WebPush VAPID';
  async sendPush(_subscription: { endpoint: string; keys: Record<string, string> }, _title: string, _body: string): Promise<{ delivered: boolean }> {
    return { delivered: true };
  }
}

const TEMPLATES: Record<string, { version: string; title: string; mandatorySecurity?: boolean; mandatoryTransactionPush?: boolean }> = {
  OTP_CODE_v1: { version: 'v1', title: 'Verification Code', mandatorySecurity: true },
  NEW_DEVICE_LOGIN_v1: { version: 'v1', title: 'New Device Sign-In Alert', mandatorySecurity: true, mandatoryTransactionPush: true },
  PIN_LOCKOUT_v1: { version: 'v1', title: 'Wallet PIN Temporarily Locked', mandatorySecurity: true, mandatoryTransactionPush: true },
  ACCOUNT_FROZEN_v1: { version: 'v1', title: 'Account Security Restriction', mandatorySecurity: true, mandatoryTransactionPush: true },
  STAFF_PROMOTED_v1: { version: 'v1', title: 'Staff Role & Access Update', mandatorySecurity: true, mandatoryTransactionPush: true },
  KYC_DECISION_v1: { version: 'v1', title: 'Identity Verification Update', mandatoryTransactionPush: true },
  DEPOSIT_SUBMITTED_v1: { version: 'v1', title: 'Deposit Request Received', mandatoryTransactionPush: true },
  DEPOSIT_APPROVED_v1: { version: 'v1', title: 'Deposit Credited', mandatoryTransactionPush: true },
  DEPOSIT_REJECTED_v1: { version: 'v1', title: 'Deposit Request Declined', mandatoryTransactionPush: true },
  TRANSFER_SENT_v1: { version: 'v1', title: 'Money Sent', mandatoryTransactionPush: true },
  TRANSFER_RECEIVED_v1: { version: 'v1', title: 'Money Received', mandatoryTransactionPush: true },
  WITHDRAWAL_REQUESTED_v1: { version: 'v1', title: 'Withdrawal Hold Placed', mandatoryTransactionPush: true },
  WITHDRAWAL_APPROVED_v1: { version: 'v1', title: 'Withdrawal Approved', mandatoryTransactionPush: true },
  WITHDRAWAL_PAID_v1: { version: 'v1', title: 'Withdrawal Paid Out', mandatoryTransactionPush: true },
  WITHDRAWAL_REJECTED_v1: { version: 'v1', title: 'Withdrawal Declined & Released', mandatoryTransactionPush: true },
  TRANSACTION_REVERSED_v1: { version: 'v1', title: 'Transaction Reversed', mandatoryTransactionPush: true },
  LIMIT_REACHED_v1: { version: 'v1', title: 'Transaction Limit Notice', mandatorySecurity: true, mandatoryTransactionPush: true },
};

class NotificationQueueService {
  private smsAdapter: SmsAdapter = new AfricasTalkingSmsAdapter();
  private emailAdapter: EmailAdapter = new TransactionalEmailAdapter();
  private pushAdapter: PushAdapter = new WebPushVapidAdapter();

  getPreferences(userId: string): NotificationPreferences {
    const existing = dbStore.notificationPreferences.get(userId);
    if (existing) return { ...existing, pushTransactions: true, mandatorySecurityAlerts: true };
    const defaults: NotificationPreferences = {
      userId,
      emailReceipts: true,
      pushTransactions: true,
      smsTransactions: true,
      mandatorySecurityAlerts: true,
    };
    dbStore.notificationPreferences.set(userId, defaults);
    return defaults;
  }

  updatePreferences(
    userId: string,
    patch: Partial<Pick<NotificationPreferences, 'emailReceipts' | 'pushTransactions' | 'smsTransactions'>>,
  ): NotificationPreferences {
    const current = this.getPreferences(userId);
    const updated: NotificationPreferences = {
      ...current,
      ...patch,
      // Transaction push notifications and security alerts are strictly enforced for every user
      pushTransactions: true,
      mandatorySecurityAlerts: true,
    };
    dbStore.notificationPreferences.set(userId, updated);
    return updated;
  }

  async enqueue(params: {
    userId: string;
    channels: NotificationChannel[];
    template: keyof typeof TEMPLATES | string;
    title?: string;
    body: string;
  }): Promise<NotificationRecord[]> {
    const tpl = TEMPLATES[params.template] ?? { version: 'v1', title: params.title || 'Wallet Notice', mandatorySecurity: false };
    const prefs = this.getPreferences(params.userId);
    const user = dbStore.users.get(params.userId);
    const results: NotificationRecord[] = [];

    // Enforce PUSH and IN_APP on all transaction events
    const effectiveChannels = new Set<NotificationChannel>(params.channels);
    if (tpl.mandatoryTransactionPush) {
      effectiveChannels.add(NotificationChannel.PUSH);
      effectiveChannels.add(NotificationChannel.IN_APP);
    }

    for (const channel of effectiveChannels) {
      if (!tpl.mandatorySecurity) {
        if (channel === NotificationChannel.EMAIL && !prefs.emailReceipts) continue;
        if (channel === NotificationChannel.SMS && !prefs.smsTransactions) continue;
        // PUSH is enforced for every account transaction
      }

      const record: NotificationRecord = {
        id: `ntf_${randomUUID()}`,
        userId: params.userId,
        channel,
        template: String(params.template),
        title: params.title || tpl.title,
        body: params.body,
        status: 'QUEUED',
        attempts: 0,
        readAt: null,
        sentAt: null,
        createdAt: new Date().toISOString(),
      };
      dbStore.notifications.set(record.id, record);

      // Process asynchronously with bounded retries (max 3)
      await this.deliverWithRetry(record, user?.phone || null, user?.email || null);
      dbStore.mirrorDoc('notifications', record.id, record as unknown as Record<string, unknown>);
      results.push(record);
    }

    return results;
  }

  private async deliverWithRetry(record: NotificationRecord, phone: string | null, email: string | null) {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      record.attempts = attempt;
      try {
        if (record.channel === NotificationChannel.SMS && phone) {
          await this.smsAdapter.sendSms(phone, record.body);
        } else if (record.channel === NotificationChannel.EMAIL && email) {
          await this.emailAdapter.sendEmail(email, record.title, record.body);
        } else if (record.channel === NotificationChannel.PUSH) {
          const sub = dbStore.pushSubscriptions.get(record.userId);
          if (sub) {
            await this.pushAdapter.sendPush(sub, record.title, record.body);
          }
        }
        record.status = 'SENT';
        record.sentAt = new Date().toISOString();
        return;
      } catch {
        if (attempt === maxAttempts) {
          record.status = 'FAILED';
        }
      }
    }
  }

  listForUser(userId: string): NotificationRecord[] {
    return [...dbStore.notifications.values()]
      .filter((n) => n.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  markRead(userId: string, notificationId: string) {
    const item = dbStore.notifications.get(notificationId);
    if (item && item.userId === userId && !item.readAt) {
      item.readAt = new Date().toISOString();
    }
  }
}

export const notificationService = new NotificationQueueService();
