import { beforeEach, describe, expect, it } from 'vitest';
import { Currency, KycStatus, Role, TransactionType, UserStatus } from '../src/shared/types.ts';
import { generateLuhnAccountNumber, isValidLuhnAccountNumber } from '../src/shared/luhn.ts';
import { calculateFeeMinor } from '../src/shared/money.ts';
import { isTrivialPin } from '../src/shared/validation.ts';
import { dbStore } from '../src/server/db/store.ts';
import { pinService } from '../src/server/modules/pin/pin.service.ts';
import { rulesService } from '../src/server/modules/rules/rules.service.ts';
import { approvalsService } from '../src/server/modules/approvals/approvals.service.ts';

describe('Security, Luhn Account Numbers, Fee/Limit Rules, PIN Lockout, and Dual Approvals', () => {
  beforeEach(() => {
    dbStore.resetForTests();
    dbStore.users.set('u1', {
      id: 'u1',
      email: 'u1@example.zw',
      phone: '+263771111111',
      passwordHash: null,
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
      legalAcceptedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });
    dbStore.userProfiles.set('u1', {
      userId: 'u1',
      fullName: 'Tatenda Moyo',
      dateOfBirth: '1994-08-15',
      nationalIdEncrypted: 'enc',
      address: 'Harare',
      country: 'ZW',
      updatedAt: new Date().toISOString(),
    });
  });

  it('generates valid random 10-digit Luhn account numbers', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const num = generateLuhnAccountNumber(seen);
      expect(num).toMatch(/^\d{10}$/);
      expect(isValidLuhnAccountNumber(num)).toBe(true);
      seen.add(num);
    }
    // Flipping last digit invalidates Luhn check
    const sample = [...seen][0];
    const tampered = sample.slice(0, 9) + String((Number(sample[9]) + 1) % 10);
    expect(isValidLuhnAccountNumber(tampered)).toBe(false);
  });

  it('calculates integer minor-unit fees accurately with min/max bounds', () => {
    const rule = { flatMinor: 10, percentBps: 50, minMinor: 15, maxMinor: 250, active: true };
    // $20.00 = 2000 -> 0.5% = 10 + 10 flat = 20 minor ($0.20)
    expect(calculateFeeMinor(2000, rule)).toBe(20);
    // $0.50 = 50 -> 0.5% = 0 + 10 flat = 10 -> clamped to min 15
    expect(calculateFeeMinor(50, rule)).toBe(15);
    // $1,000.00 = 100000 -> 0.5% = 500 + 10 = 510 -> clamped to max 250
    expect(calculateFeeMinor(100000, rule)).toBe(250);
  });

  it('rejects trivial and DOB-matching PINs', async () => {
    expect(isTrivialPin('000000').trivial).toBe(true);
    expect(isTrivialPin('123456').trivial).toBe(true);
    expect(isTrivialPin('654321').trivial).toBe(true);
    expect(isTrivialPin('121212').trivial).toBe(true);
    expect(isTrivialPin('150894', '1994-08-15').trivial).toBe(true);
    expect(isTrivialPin('482910', '1994-08-15').trivial).toBe(false);

    await expect(pinService.setPin('u1', '123456')).rejects.toThrow(/TRIVIAL_PIN/);
    await expect(pinService.setPin('u1', '150894')).rejects.toThrow(/TRIVIAL_PIN/);
  });

  it('locks PIN for 30 minutes after 3 failed attempts and flags repeated lockouts for compliance review', async () => {
    await pinService.setPin('u1', '482910');
    const t0 = Date.now();

    await expect(pinService.verifyPinAndIssueStepUp({ userId: 'u1', pin: '111112', scope: 'view', nowMs: t0 })).rejects.toThrow(/INVALID_PIN/);
    await expect(pinService.verifyPinAndIssueStepUp({ userId: 'u1', pin: '111112', scope: 'view', nowMs: t0 })).rejects.toThrow(/INVALID_PIN/);
    await expect(pinService.verifyPinAndIssueStepUp({ userId: 'u1', pin: '111112', scope: 'view', nowMs: t0 })).rejects.toThrow(/PIN_LOCKED/);

    // Even correct PIN fails during 30m lockout
    await expect(pinService.verifyPinAndIssueStepUp({ userId: 'u1', pin: '482910', scope: 'view', nowMs: t0 + 60_000 })).rejects.toThrow(/PIN_LOCKED/);

    // After 31m, lockout expires; 3 more wrong attempts trigger repeated lockout compliance review
    const tAfter = t0 + 31 * 60_000;
    await expect(pinService.verifyPinAndIssueStepUp({ userId: 'u1', pin: '999991', scope: 'view', nowMs: tAfter })).rejects.toThrow(/INVALID_PIN/);
    await expect(pinService.verifyPinAndIssueStepUp({ userId: 'u1', pin: '999991', scope: 'view', nowMs: tAfter })).rejects.toThrow(/INVALID_PIN/);
    await expect(pinService.verifyPinAndIssueStepUp({ userId: 'u1', pin: '999991', scope: 'view', nowMs: tAfter })).rejects.toThrow(/PIN_LOCKED/);

    // Now even after 31m more, requires compliance review
    await expect(pinService.verifyPinAndIssueStepUp({ userId: 'u1', pin: '482910', scope: 'view', nowMs: tAfter + 31 * 60_000 })).rejects.toThrow(/PIN_REVIEW_REQUIRED/);
  });

  it('enforces dual-control approval where requester cannot approve their own rule change', () => {
    const apr = approvalsService.requestChange({
      entityType: 'FEE_RULE',
      entityId: 'fee_transfer_USD',
      payload: {
        transactionType: TransactionType.TRANSFER,
        currency: Currency.USD,
        flatMinor: 25,
        percentBps: 50,
        minMinor: 25,
        maxMinor: 300,
        active: true,
      },
      requestedBy: 'admin_1',
    });

    expect(() => approvalsService.decideChange(apr.id, 'admin_1', 'APPROVED')).toThrow(/DUAL_CONTROL_VIOLATION/);
    const approved = approvalsService.decideChange(apr.id, 'admin_2', 'APPROVED');
    expect(approved.status).toBe('APPROVED');
    expect(rulesService.computeFee(TransactionType.TRANSFER, Currency.USD, 2000)).toBe(35);
  });
});
