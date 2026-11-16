import { randomUUID } from 'node:crypto';
import { Currency, NotificationChannel, PinRecord, RiskSeverity } from '../../../shared/types.ts';
import { isTrivialPin } from '../../../shared/validation.ts';
import { dbStore } from '../../db/store.ts';
import { hashPin, signStepUpToken, verifyPassword, verifyPinHash } from '../../security/crypto.ts';
import { recordAuditLog } from '../../security/audit.ts';
import { authService } from '../auth/auth.service.ts';
import { notificationService } from '../notifications/notifications.service.ts';
import { riskService } from '../risk/risk.service.ts';

const PIN_MAX_ATTEMPTS = 3;
const PIN_LOCKOUT_MS = 30 * 60 * 1000; // 30 minutes

class PinService {
  async setPin(userId: string, pin: string): Promise<void> {
    const profile = dbStore.userProfiles.get(userId);
    const trivialCheck = isTrivialPin(pin, profile?.dateOfBirth);
    if (trivialCheck.trivial) {
      throw new Error(`TRIVIAL_PIN: ${trivialCheck.reason}`);
    }

    const { hash, salt } = await hashPin(pin);
    const record: PinRecord = {
      userId,
      pinHash: hash,
      salt,
      failedAttempts: 0,
      lockoutCount: 0,
      lockedUntil: null,
      requiresComplianceReview: false,
      updatedAt: new Date().toISOString(),
    };
    dbStore.pins.set(userId, record);

    recordAuditLog({
      actorId: userId,
      actorType: 'USER',
      action: 'PIN_SET',
      entity: `pin:${userId}`,
    });
  }

  async verifyPinAndIssueStepUp(params: {
    userId: string;
    pin: string;
    scope: 'view' | 'transaction' | 'admin_action';
    action?: 'transfer' | 'withdrawal';
    adminAction?: string;
    amountMinor?: number;
    currency?: Currency;
    nowMs?: number;
  }): Promise<{ stepUpToken: string; expiresInSeconds: number; scope: 'view' | 'transaction' | 'admin_action' }> {
    const pinRecord = dbStore.pins.get(params.userId);
    if (!pinRecord) {
      throw new Error('PIN_NOT_SET: Please configure your 6-digit security PIN first.');
    }

    const now = params.nowMs ?? Date.now();
    if (pinRecord.requiresComplianceReview) {
      throw new Error('PIN_REVIEW_REQUIRED: Repeated PIN lockouts detected. Verify via OTP and contact compliance support.');
    }

    if (pinRecord.lockedUntil && now < Date.parse(pinRecord.lockedUntil)) {
      const remainingMins = Math.ceil((Date.parse(pinRecord.lockedUntil) - now) / 60000);
      throw new Error(`PIN_LOCKED: Too many failed attempts. Try again in ${remainingMins} minute(s).`);
    }

    // Clear expired lockout window automatically if single lockout elapsed
    if (pinRecord.lockedUntil && now >= Date.parse(pinRecord.lockedUntil)) {
      pinRecord.lockedUntil = null;
      pinRecord.failedAttempts = 0;
    }

    const valid = await verifyPinHash(params.pin, pinRecord.salt, pinRecord.pinHash);
    if (!valid) {
      pinRecord.failedAttempts += 1;
      pinRecord.updatedAt = new Date(now).toISOString();

      if (pinRecord.failedAttempts >= PIN_MAX_ATTEMPTS) {
        pinRecord.lockoutCount += 1;
        pinRecord.lockedUntil = new Date(now + PIN_LOCKOUT_MS).toISOString();

        if (pinRecord.lockoutCount >= 2) {
          pinRecord.requiresComplianceReview = true;
          riskService.raiseFlag({
            userId: params.userId,
            rule: 'REPEATED_PIN_LOCKOUT',
            severity: RiskSeverity.HIGH,
            details: `User triggered ${pinRecord.lockoutCount} PIN lockouts. Account requires OTP + compliance review.`,
          });
        } else {
          riskService.raiseFlag({
            userId: params.userId,
            rule: 'PIN_LOCKOUT',
            severity: RiskSeverity.MEDIUM,
            details: '3 consecutive failed PIN attempts; locked for 30 minutes.',
          });
        }

        await notificationService.enqueue({
          userId: params.userId,
          channels: [NotificationChannel.PUSH, NotificationChannel.SMS, NotificationChannel.EMAIL, NotificationChannel.IN_APP],
          template: 'PIN_LOCKOUT_v1',
          body: 'Your Comfort Secure Wallet PIN was locked for 30 minutes after 3 failed attempts.',
        });

        recordAuditLog({
          actorId: params.userId,
          actorType: 'USER',
          action: 'PIN_LOCKED_OUT',
          entity: `pin:${params.userId}`,
          after: { lockoutCount: pinRecord.lockoutCount, requiresComplianceReview: pinRecord.requiresComplianceReview },
        });

        throw new Error('PIN_LOCKED: PIN locked for 30 minutes after 3 failed attempts.');
      }

      const attemptsLeft = PIN_MAX_ATTEMPTS - pinRecord.failedAttempts;
      throw new Error(`INVALID_PIN: Incorrect PIN. ${attemptsLeft} attempt(s) remaining before lockout.`);
    }

    if (params.scope === 'transaction') {
      if (!params.action || !params.amountMinor || !params.currency) {
        throw new Error('INVALID_STEPUP_PARAMS: Transaction scope requires action, amountMinor, and currency.');
      }
    }
    if (params.scope === 'admin_action' && !params.adminAction) {
      throw new Error('INVALID_STEPUP_PARAMS: Admin step-up requires adminAction.');
    }

    pinRecord.failedAttempts = 0;
    pinRecord.updatedAt = new Date(now).toISOString();

    const jti = `stp_${randomUUID()}`;
    const stepUpToken = signStepUpToken({
      jti,
      sub: params.userId,
      scope: params.scope,
      action: params.action,
      adminAction: params.adminAction,
      amountMinor: params.amountMinor,
      currency: params.currency,
    });

    return {
      stepUpToken,
      expiresInSeconds: params.scope === 'view' ? 300 : 120,
      scope: params.scope,
    };
  }

  async changePin(userId: string, currentPin: string, newPin: string) {
    await this.verifyPinAndIssueStepUp({ userId, pin: currentPin, scope: 'view' });
    await this.setPin(userId, newPin);
    recordAuditLog({
      actorId: userId,
      actorType: 'USER',
      action: 'PIN_CHANGED',
      entity: `pin:${userId}`,
    });
  }

  async resetPin(params: {
    userId: string;
    password: string;
    otpCode: string;
    target: string;
    channel: 'SMS' | 'EMAIL';
    newPin: string;
  }) {
    const user = dbStore.users.get(params.userId);
    if (!user || !user.passwordHash) {
      throw new Error('PASSWORD_REQUIRED: Password verification required for PIN reset.');
    }
    const pwOk = await verifyPassword(params.password, user.passwordHash);
    if (!pwOk) {
      throw new Error('INVALID_CREDENTIALS: Incorrect password.');
    }
    await authService.verifyOtp({
      target: params.target,
      channel: params.channel,
      purpose: 'PIN_RESET',
      code: params.otpCode,
    });
    await this.setPin(params.userId, params.newPin);
    recordAuditLog({
      actorId: params.userId,
      actorType: 'USER',
      action: 'PIN_RESET',
      entity: `pin:${params.userId}`,
    });
  }
}

export const pinService = new PinService();
