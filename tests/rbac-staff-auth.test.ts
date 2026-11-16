import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Currency,
  NotificationChannel,
  Role,
} from '../src/shared/types.ts';
import { dbStore } from '../src/server/db/store.ts';
import { seedStagingData } from '../src/server/db/seed.ts';
import { authService } from '../src/server/modules/auth/auth.service.ts';
import { adminService } from '../src/server/modules/admin/admin.service.ts';
import { pinService } from '../src/server/modules/pin/pin.service.ts';
import { rbacService } from '../src/server/modules/rules/rbac.service.ts';
import { notificationService } from '../src/server/modules/notifications/notifications.service.ts';
import { kycService } from '../src/server/modules/kyc/kyc.service.ts';
import { accountsService } from '../src/server/modules/accounts/accounts.service.ts';
import { transactionsService } from '../src/server/modules/transactions/transactions.service.ts';
import { requireAdminPinStepUp, requirePermission, AuthenticatedRequest } from '../src/server/security/middleware.ts';

function mockRes() {
  const res: Record<string, unknown> = {
    statusCode: 200,
    body: null as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    getHeader(name: string) {
      return (this.headers as Record<string, string>)[name];
    },
    setHeader(name: string, val: string) {
      (this.headers as Record<string, string>)[name] = val;
    },
  };
  return res as unknown as Parameters<ReturnType<typeof requirePermission>>[1] & { statusCode: number; body: unknown };
}

describe('Production Seeding, DB RBAC, Staff Onboarding, Returning 6-Digit PIN Login & Enforced Push', () => {
  const origNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    dbStore.resetForTests();
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    process.env.NODE_ENV = origNodeEnv;
  });

  it('populates DB RBAC rules without seeding any demo or staff users when NODE_ENV=production', async () => {
    process.env.NODE_ENV = 'production';
    await seedStagingData();

    expect(dbStore.users.size).toBe(0);
    expect(dbStore.accounts.size).toBe(0);
    expect(dbStore.rbacRules.size).toBe(Object.values(Role).length);
    expect(rbacService.hasPermission(Role.SUPER_ADMIN, 'staff:write')).toBe(true);
    expect(rbacService.hasPermission(Role.FINANCE_MAKER, 'staff:write')).toBe(false);
    expect(dbStore.feeRules.size).toBeGreaterThan(0);
    expect(dbStore.limitRules.size).toBeGreaterThan(0);
  });

  it('auto-provisions comfort.designszw@gmail.com as APPROVED SUPER_ADMIN and enforces Super Admin approval & RBAC for other staff', async () => {
    const superReg = await authService.registerStaff({
      email: 'comfort.designszw@gmail.com',
      password: 'StrongAdminPassword!2026',
      fullName: 'Comfort Designs Super Admin',
      requestedRole: Role.SUPPORT_AGENT, // Even if lower requested, designated email gets SUPER_ADMIN
      legalAccepted: true,
    });
    expect(superReg.user.role).toBe(Role.SUPER_ADMIN);
    expect(superReg.user.staffStatus).toBe('APPROVED');
    expect(superReg.tokens.requiresPinSetup).toBe(true);

    const applicantReg = await authService.registerStaff({
      email: 'maker.applicant@comfortwallet.zw',
      password: 'StrongStaffPassword!2026',
      fullName: 'Tariro Applicant',
      requestedRole: Role.FINANCE_MAKER,
      legalAccepted: true,
    });
    expect(applicantReg.user.staffStatus).toBe('PENDING_APPROVAL');

    // Pending staff cannot pass requirePermission middleware
    let nextCalled = false;
    const reqPending = {
      authUser: {
        id: applicantReg.user.id,
        sessionId: applicantReg.tokens.sessionId,
        role: applicantReg.user.role,
        twoFactorVerified: true,
      },
      correlationId: 'corr_pending',
    } as unknown as AuthenticatedRequest;
    const resPending = mockRes();
    requirePermission('deposits:make')(reqPending, resPending, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(false);
    expect(resPending.statusCode).toBe(403);
    expect((resPending.body as { error: { code: string } }).error.code).toBe('STAFF_APPROVAL_PENDING');

    // Super Admin approves & promotes applicant to FINANCE_CHECKER
    const promoted = await adminService.approveOrPromoteStaff({
      targetUserId: applicantReg.user.id,
      superAdminId: superReg.user.id,
      decision: 'APPROVED',
      assignedRole: Role.FINANCE_CHECKER,
      reason: 'Verified treasury team member',
    });
    expect(promoted.staffStatus).toBe('APPROVED');
    expect(promoted.role).toBe(Role.FINANCE_CHECKER);

    // Audit log written
    const audit = dbStore.auditLogs.find((a) => a.action === 'STAFF_APPROVED_PROMOTED' && a.entity === `user:${applicantReg.user.id}`);
    expect(audit).toBeDefined();

    // Promoted FINANCE_CHECKER can pass CHECKER permission, but is denied SUPER_ADMIN staff:write
    let checkerNext = false;
    const reqChecker = {
      authUser: {
        id: promoted.id,
        sessionId: applicantReg.tokens.sessionId,
        role: promoted.role,
        twoFactorVerified: true,
      },
      correlationId: 'corr_checker_ok',
    } as unknown as AuthenticatedRequest;
    const resCheckerOk = mockRes();
    requirePermission('deposits:check')(reqChecker, resCheckerOk, () => {
      checkerNext = true;
    });
    expect(checkerNext).toBe(true);

    let promoteNext = false;
    const resCheckerForbidden = mockRes();
    requirePermission('staff:write')(reqChecker, resCheckerForbidden, () => {
      promoteNext = true;
    });
    expect(promoteNext).toBe(false);
    expect(resCheckerForbidden.statusCode).toBe(403);
    expect((resCheckerForbidden.body as { error: { code: string } }).error.code).toBe('INSUFFICIENT_PERMISSIONS');
  });

  it('supports returning 6-digit PIN login for users & staff, 3-attempt lockout, and single-use admin_action step-up tokens', async () => {
    // Register normal user & set PIN
    const userReg = await authService.register({
      email: 'returning.user@wallet.zw',
      password: 'StrongUserPassword!2026',
      legalAccepted: true,
    });
    await pinService.setPin(userReg.user.id, '482910');

    // Returning user logs in directly with 6-digit PIN
    const pinLogin = await authService.loginWithPin({
      email: 'returning.user@wallet.zw',
      pin: '482910',
    });
    expect(pinLogin.accessToken).toBeTruthy();
    expect(pinLogin.user.id).toBe(userReg.user.id);

    // 3 failed PIN login attempts trigger 30-minute PIN lockout
    await expect(authService.loginWithPin({ email: 'returning.user@wallet.zw', pin: '111112' })).rejects.toThrow(/INVALID_PIN/);
    await expect(authService.loginWithPin({ email: 'returning.user@wallet.zw', pin: '111112' })).rejects.toThrow(/INVALID_PIN/);
    await expect(authService.loginWithPin({ email: 'returning.user@wallet.zw', pin: '111112' })).rejects.toThrow(/PIN_LOCKED/);
    await expect(authService.loginWithPin({ email: 'returning.user@wallet.zw', pin: '482910' })).rejects.toThrow(/PIN_LOCKED/);

    // Super admin PIN login requires 2FA OTP step and supports single-use admin_action step-up
    const adminReg = await authService.registerStaff({
      email: 'comfort.designszw@gmail.com',
      password: 'StrongAdminPassword!2026',
      fullName: 'Comfort Designs Super Admin',
      requestedRole: Role.SUPER_ADMIN,
      legalAccepted: true,
    });
    await pinService.setPin(adminReg.user.id, '739204');

    const step1 = await authService.loginWithPin({
      email: 'comfort.designszw@gmail.com',
      pin: '739204',
    });
    expect(step1.requiresOtp).toBe(true);
    expect(step1.devOtpPreview).toMatch(/^\d{6}$/);

    const step2 = await authService.loginWithPin({
      email: 'comfort.designszw@gmail.com',
      pin: '739204',
      otpCode: step1.devOtpPreview,
    });
    expect(step2.accessToken).toBeTruthy();

    const stepUp = await pinService.verifyPinAndIssueStepUp({
      userId: adminReg.user.id,
      pin: '739204',
      scope: 'admin_action',
      adminAction: 'staff_approve',
    });

    const middleware = requireAdminPinStepUp('staff_approve');
    const reqAdmin = {
      authUser: {
        id: adminReg.user.id,
        sessionId: step2.sessionId,
        role: Role.SUPER_ADMIN,
        twoFactorVerified: true,
      },
      headers: { 'x-step-up-token': stepUp.stepUpToken },
      correlationId: 'corr_admin_pin',
    } as unknown as AuthenticatedRequest;

    let passedFirst = false;
    const resFirst = mockRes();
    middleware(reqAdmin, resFirst, () => {
      passedFirst = true;
    });
    expect(passedFirst).toBe(true);

    // Replay of single-use admin_action token must fail
    let passedReplay = false;
    const resReplay = mockRes();
    middleware(reqAdmin, resReplay, () => {
      passedReplay = true;
    });
    expect(passedReplay).toBe(false);
    expect(resReplay.statusCode).toBe(403);
    expect((resReplay.body as { error: { code: string } }).error.code).toBe('STEPUP_TOKEN_REUSED');
  });

  it('enforces mandatory PUSH notifications for every transaction regardless of preference attempts', async () => {
    const u1 = await authService.register({ email: 'sender.push@wallet.zw', password: 'StrongPushPassword!2026', legalAccepted: true });
    const u2 = await authService.register({ email: 'recv.push@wallet.zw', password: 'StrongPushPassword!2026', legalAccepted: true });

    // Even if user attempts to turn off pushTransactions, server keeps it enforced = true
    const prefs = notificationService.updatePreferences(u1.user.id, { pushTransactions: false, emailReceipts: false });
    expect(prefs.pushTransactions).toBe(true);
    expect(prefs.emailReceipts).toBe(false);

    await kycService.decideKyc({ targetUserId: u1.user.id, officerId: 'kyc_officer', decision: 'APPROVED' });
    await kycService.decideKyc({ targetUserId: u2.user.id, officerId: 'kyc_officer', decision: 'APPROVED' });

    const acc1 = accountsService.listUserAccounts(u1.user.id).find((a) => a.currency === Currency.USD)!;
    const acc2 = accountsService.listUserAccounts(u2.user.id).find((a) => a.currency === Currency.USD)!;

    const dep = await transactionsService.submitDepositRequest({
      userId: u1.user.id,
      accountId: acc1.id,
      amountMinor: 10000,
      currency: Currency.USD,
      method: 'ECOCASH',
      paymentReference: 'PUSH-REF-001',
      proofDataUrl: 'data:text/plain;base64,cHJvb2Y=',
      idempotencyKey: 'idem_push_dep_1',
    });
    await transactionsService.makerApproveDeposit(dep.id, 'maker_push');
    await transactionsService.checkerApproveDeposit(dep.id, 'checker_push');

    await transactionsService.executeTransfer({
      userId: u1.user.id,
      fromAccountId: acc1.id,
      toAccountNumber: acc2.accountNumber,
      amountMinor: 1500,
      idempotencyKey: 'idem_push_trf_1',
    });

    const senderNotifications = notificationService.listForUser(u1.user.id);
    const recvNotifications = notificationService.listForUser(u2.user.id);

    expect(
      senderNotifications.some((n) => n.template === 'DEPOSIT_APPROVED_v1' && n.channel === NotificationChannel.PUSH),
    ).toBe(true);
    expect(
      senderNotifications.some((n) => n.template === 'TRANSFER_SENT_v1' && n.channel === NotificationChannel.PUSH),
    ).toBe(true);
    expect(
      recvNotifications.some((n) => n.template === 'TRANSFER_RECEIVED_v1' && n.channel === NotificationChannel.PUSH),
    ).toBe(true);
  });
});
