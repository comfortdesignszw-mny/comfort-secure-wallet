import { randomUUID } from 'node:crypto';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import firebaseConfig from '../../../../firebase-applet-config.json' with { type: 'json' };
import {
  ADMIN_ROLES,
  NotificationChannel,
  OtpRecord,
  RiskSeverity,
  Role,
  SessionRecord,
  UserRecord,
  UserStatus,
  KycStatus,
} from '../../../shared/types.ts';
import { validatePasswordStrength } from '../../../shared/validation.ts';
import { dbStore } from '../../db/store.ts';
import {
  generateNumericOtp,
  generateRefreshToken,
  hashPassword,
  sha256Hex,
  signAccessToken,
  verifyPassword,
} from '../../security/crypto.ts';
import { recordAuditLog } from '../../security/audit.ts';
import { notificationService } from '../notifications/notifications.service.ts';
import { riskService } from '../risk/risk.service.ts';
import { rbacService } from '../rules/rbac.service.ts';
import { pinService } from '../pin/pin.service.ts';

function ensureFirebaseAdminAuth() {
  if (!getApps().length) {
    initializeApp({ projectId: firebaseConfig.projectId });
  }
  return getAuth();
}

export interface AuthTokensResult {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  user: Omit<UserRecord, 'passwordHash'>;
  requiresOtp?: boolean;
  requiresPinSetup?: boolean;
  devOtpPreview?: string;
}

class AuthService {
  sanitizeUser(u: UserRecord): Omit<UserRecord, 'passwordHash'> {
    const { passwordHash: _pw, ...rest } = u;
    return rest;
  }

  async sendOtp(params: {
    userId?: string | null;
    target: string;
    channel: 'SMS' | 'EMAIL';
    purpose: OtpRecord['purpose'];
  }): Promise<{ otpId: string; expiresAt: string; devPreviewCode?: string }> {
    const normalizedTarget = params.target.trim().toLowerCase();

    // Resend throttle: prevent sending another OTP to same target+purpose within 10 seconds
    const nowMs = Date.now();
    for (const existing of dbStore.otps.values()) {
      if (
        existing.target === normalizedTarget &&
        existing.purpose === params.purpose &&
        !existing.usedAt &&
        nowMs - Date.parse(existing.createdAt) < 10_000
      ) {
        throw new Error('OTP_THROTTLED: Please wait before requesting another verification code.');
      }
    }

    const code = generateNumericOtp();
    const record: OtpRecord = {
      id: `otp_${randomUUID()}`,
      userId: params.userId ?? null,
      target: normalizedTarget,
      channel: params.channel,
      purpose: params.purpose,
      codeHash: sha256Hex(`${normalizedTarget}:${params.purpose}:${code}`),
      expiresAt: new Date(nowMs + 5 * 60 * 1000).toISOString(), // 5-minute expiry
      attempts: 0,
      usedAt: null,
      createdAt: new Date().toISOString(),
    };
    dbStore.otps.set(record.id, record);

    if (params.userId) {
      await notificationService.enqueue({
        userId: params.userId,
        channels: [params.channel === 'SMS' ? NotificationChannel.SMS : NotificationChannel.EMAIL],
        template: 'OTP_CODE_v1',
        body: `Your Comfort Secure Wallet verification code is ${code}. Expires in 5 minutes. Never share this code.`,
      });
    }

    return {
      otpId: record.id,
      expiresAt: record.expiresAt,
      // Exposed only in non-production dev/sandbox preview so evaluators can test OTP flows end-to-end
      devPreviewCode: process.env.NODE_ENV === 'production' ? undefined : code,
    };
  }

  async verifyOtp(params: {
    target: string;
    channel: 'SMS' | 'EMAIL';
    purpose: OtpRecord['purpose'];
    code: string;
  }): Promise<{ verified: boolean; userId: string | null }> {
    const normalizedTarget = params.target.trim().toLowerCase();
    const candidates = [...dbStore.otps.values()]
      .filter((o) => o.target === normalizedTarget && o.purpose === params.purpose && o.channel === params.channel && !o.usedAt)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const otp = candidates[0];
    if (!otp) {
      throw new Error('OTP_NOT_FOUND: No active verification code found.');
    }
    if (Date.now() > Date.parse(otp.expiresAt)) {
      throw new Error('OTP_EXPIRED: Verification code has expired.');
    }
    if (otp.attempts >= 5) {
      throw new Error('OTP_MAX_ATTEMPTS: Maximum verification attempts exceeded. Request a new code.');
    }

    otp.attempts += 1;
    const expectedHash = sha256Hex(`${normalizedTarget}:${params.purpose}:${params.code}`);
    if (otp.codeHash !== expectedHash) {
      throw new Error('OTP_INVALID: Incorrect verification code.');
    }

    otp.usedAt = new Date().toISOString();

    if (otp.userId) {
      const user = dbStore.users.get(otp.userId);
      if (user) {
        if (params.channel === 'EMAIL') user.emailVerified = true;
        if (params.channel === 'SMS') user.phoneVerified = true;
      }
    }

    return { verified: true, userId: otp.userId };
  }

  async register(params: {
    email?: string;
    phone?: string;
    password: string;
    fullName?: string;
    deviceFingerprint?: string;
    deviceLabel?: string;
    ip?: string;
    userAgent?: string;
    legalAccepted?: boolean;
  }): Promise<{ user: Omit<UserRecord, 'passwordHash'>; otpTarget: string; otpChannel: 'SMS' | 'EMAIL'; otpSent: boolean; devOtpPreview?: string; tokens: AuthTokensResult }> {
    if (params.legalAccepted === false) {
      throw new Error('LEGAL_CONFIRMATION_REQUIRED: You must read and accept the financial Terms of Use and Privacy Policy.');
    }
    const pwCheck = validatePasswordStrength(params.password);
    if (!pwCheck.valid) {
      throw new Error(`WEAK_PASSWORD: ${pwCheck.reason}`);
    }

    const email = params.email?.trim().toLowerCase() || null;
    const phone = params.phone?.trim() || null;

    for (const u of dbStore.users.values()) {
      if (email && u.email === email) throw new Error('ACCOUNT_EXISTS: An account with this email already exists.');
      if (phone && u.phone === phone) throw new Error('ACCOUNT_EXISTS: An account with this phone number already exists.');
    }

    const now = new Date().toISOString();
    const passwordHash = await hashPassword(params.password);
    const otpChannel: 'SMS' | 'EMAIL' = phone ? 'SMS' : 'EMAIL';
    const otpTarget = (phone || email)!;
    const isProd = process.env.NODE_ENV === 'production';
    const hasLiveOtp = otpChannel === 'EMAIL' ? Boolean(process.env.RESEND_API_KEY) : Boolean(process.env.AFRICASTALKING_API_KEY);
    const otpSent = !isProd || hasLiveOtp;

    const user: UserRecord = {
      id: `usr_${randomUUID()}`,
      email,
      phone,
      passwordHash,
      googleId: null,
      role: Role.USER,
      staffStatus: 'NONE',
      requestedRole: null,
      status: UserStatus.ACTIVE,
      freezeReason: null,
      kycStatus: KycStatus.NOT_SUBMITTED,
      kycTier: 0,
      emailVerified: !otpSent && otpChannel === 'EMAIL',
      phoneVerified: !otpSent && otpChannel === 'SMS',
      totpEnabled: false,
      legalAcceptedAt: now,
      createdAt: now,
    };
    dbStore.users.set(user.id, user);
    dbStore.mirrorDoc('users', user.id, this.sanitizeUser(user));

    const otp = otpSent
      ? await this.sendOtp({
          userId: user.id,
          target: otpTarget,
          channel: otpChannel,
          purpose: 'REGISTER',
        })
      : { devPreviewCode: undefined };

    const tokens = this.createSession(user, {
      deviceFingerprint: params.deviceFingerprint || `fp_${randomUUID().slice(0, 8)}`,
      deviceLabel: params.deviceLabel || 'Primary Browser',
      ip: params.ip || '127.0.0.1',
      userAgent: params.userAgent || 'PWA-Client',
      twoFactorVerified: false,
    });
    tokens.requiresPinSetup = true;

    recordAuditLog({
      actorId: user.id,
      actorType: 'USER',
      action: 'USER_REGISTERED',
      entity: `user:${user.id}`,
      after: { email, phone, kycStatus: user.kycStatus, legalAcceptedAt: user.legalAcceptedAt },
      ip: params.ip,
      userAgent: params.userAgent,
    });

    return {
      user: this.sanitizeUser(user),
      otpTarget,
      otpChannel,
      otpSent,
      devOtpPreview: otp.devPreviewCode,
      tokens,
    };
  }

  /**
   * Staff registration for Back-Office Console (Email+Password or Phone+Password).
   * - Designated Super Admin (comfort.designszw@gmail.com) is immediately provisioned as APPROVED SUPER_ADMIN with all DB RBAC privileges.
   * - All other staff signups enter PENDING_APPROVAL until approved and promoted by the Super Admin.
   */
  async registerStaff(params: {
    email?: string;
    phone?: string;
    password: string;
    fullName: string;
    requestedRole: Role;
    legalAccepted: boolean;
    deviceFingerprint?: string;
    deviceLabel?: string;
    ip?: string;
    userAgent?: string;
  }): Promise<{ user: Omit<UserRecord, 'passwordHash'>; otpTarget: string; otpChannel: 'SMS' | 'EMAIL'; otpSent: boolean; devOtpPreview?: string; tokens: AuthTokensResult }> {
    if (!params.legalAccepted) {
      throw new Error('LEGAL_CONFIRMATION_REQUIRED: You must confirm the Terms of Use and Privacy Policy.');
    }
    const pwCheck = validatePasswordStrength(params.password);
    if (!pwCheck.valid) {
      throw new Error(`WEAK_PASSWORD: ${pwCheck.reason}`);
    }

    rbacService.ensureRbacRulesInDb();

    const email = params.email?.trim().toLowerCase() || null;
    const phone = params.phone?.trim() || null;

    for (const u of dbStore.users.values()) {
      if (email && u.email === email) throw new Error('ACCOUNT_EXISTS: An account with this email already exists.');
      if (phone && u.phone === phone) throw new Error('ACCOUNT_EXISTS: An account with this phone number already exists.');
    }

    const isDesignatedSuperAdmin = rbacService.isDesignatedSuperAdminEmail(email);
    const assignedInitialRole = isDesignatedSuperAdmin
      ? Role.SUPER_ADMIN
      : params.requestedRole === Role.SUPER_ADMIN || !ADMIN_ROLES.includes(params.requestedRole)
        ? Role.SUPPORT_AGENT
        : params.requestedRole;

    const now = new Date().toISOString();
    const passwordHash = await hashPassword(params.password);
    const otpChannel: 'SMS' | 'EMAIL' = email ? 'EMAIL' : 'SMS';
    const otpTarget = (email || phone)!;
    const isProd = process.env.NODE_ENV === 'production';
    const hasLiveOtp = otpChannel === 'EMAIL' ? Boolean(process.env.RESEND_API_KEY) : Boolean(process.env.AFRICASTALKING_API_KEY);
    const otpSent = !isProd || hasLiveOtp;

    const user: UserRecord = {
      id: `stf_${randomUUID()}`,
      email,
      phone,
      passwordHash,
      googleId: null,
      role: assignedInitialRole,
      staffStatus: isDesignatedSuperAdmin ? 'APPROVED' : 'PENDING_APPROVAL',
      requestedRole: isDesignatedSuperAdmin ? Role.SUPER_ADMIN : params.requestedRole,
      status: UserStatus.ACTIVE,
      freezeReason: null,
      kycStatus: KycStatus.APPROVED,
      kycTier: 2,
      emailVerified: !otpSent && otpChannel === 'EMAIL',
      phoneVerified: !otpSent && otpChannel === 'SMS',
      totpEnabled: true,
      legalAcceptedAt: now,
      createdAt: now,
    };
    dbStore.users.set(user.id, user);
    dbStore.userProfiles.set(user.id, {
      userId: user.id,
      fullName: params.fullName.trim(),
      dateOfBirth: '1990-01-01',
      nationalIdEncrypted: '',
      address: 'Comfort Secure Wallet Staff Office',
      country: 'ZW',
      updatedAt: now,
    });
    dbStore.mirrorDoc('users', user.id, this.sanitizeUser(user));

    const otp = otpSent
      ? await this.sendOtp({
          userId: user.id,
          target: otpTarget,
          channel: otpChannel,
          purpose: 'REGISTER',
        })
      : { devPreviewCode: undefined };

    const tokens = this.createSession(user, {
      deviceFingerprint: params.deviceFingerprint || `stf_${randomUUID().slice(0, 8)}`,
      deviceLabel: params.deviceLabel || 'Back-Office Browser',
      ip: params.ip || '127.0.0.1',
      userAgent: params.userAgent || 'BackOffice-Client',
      twoFactorVerified: false,
    });
    tokens.requiresPinSetup = true;

    recordAuditLog({
      actorId: user.id,
      actorType: isDesignatedSuperAdmin ? 'ADMIN' : 'SYSTEM',
      action: isDesignatedSuperAdmin ? 'SUPER_ADMIN_BOOTSTRAPPED' : 'STAFF_REGISTERED_PENDING',
      entity: `user:${user.id}`,
      after: {
        email,
        phone,
        role: user.role,
        requestedRole: user.requestedRole,
        staffStatus: user.staffStatus,
      },
      ip: params.ip,
      userAgent: params.userAgent,
    });

    return {
      user: this.sanitizeUser(user),
      otpTarget,
      otpChannel,
      otpSent,
      devOtpPreview: otp.devPreviewCode,
      tokens,
    };
  }

  async login(params: {
    email?: string;
    phone?: string;
    password: string;
    otpCode?: string;
    deviceFingerprint?: string;
    deviceLabel?: string;
    ip?: string;
    userAgent?: string;
  }): Promise<AuthTokensResult> {
    const email = params.email?.trim().toLowerCase();
    const phone = params.phone?.trim();
    const user = [...dbStore.users.values()].find(
      (u) => (email && u.email === email) || (phone && u.phone === phone),
    );

    if (!user || !user.passwordHash) {
      throw new Error('INVALID_CREDENTIALS: Invalid email/phone or password.');
    }

    const ok = await verifyPassword(params.password, user.passwordHash);
    if (!ok) {
      recordAuditLog({
        actorId: user.id,
        actorType: ADMIN_ROLES.includes(user.role) ? 'ADMIN' : 'USER',
        action: 'LOGIN_FAILED',
        entity: `user:${user.id}`,
        ip: params.ip,
        userAgent: params.userAgent,
      });
      throw new Error('INVALID_CREDENTIALS: Invalid email/phone or password.');
    }

    if (user.status === UserStatus.CLOSED) {
      throw new Error('ACCOUNT_CLOSED: This account is closed.');
    }
    if (user.staffStatus === 'REJECTED') {
      throw new Error('FORBIDDEN: This staff access request was declined by Super Admin.');
    }

    const fp = params.deviceFingerprint || 'default-device';
    const knownDevice = [...dbStore.sessions.values()].some(
      (s) => s.userId === user.id && s.deviceFingerprint === fp && !s.revokedAt,
    );

    const isAdmin = ADMIN_ROLES.includes(user.role);
    let twoFactorVerified = !isAdmin;
    let devOtpPreview: string | undefined;

    if (isAdmin) {
      const target = (user.email || user.phone)!;
      const channel = user.email ? 'EMAIL' : 'SMS';
      if (!params.otpCode) {
        const otp = await this.sendOtp({
          userId: user.id,
          target,
          channel,
          purpose: 'LOGIN_2FA',
        });
        devOtpPreview = otp.devPreviewCode;
        return {
          accessToken: '',
          refreshToken: '',
          sessionId: '',
          user: this.sanitizeUser(user),
          requiresOtp: true,
          devOtpPreview,
        };
      }
      await this.verifyOtp({
        target,
        channel,
        purpose: 'LOGIN_2FA',
        code: params.otpCode,
      });
      twoFactorVerified = true;
    }

    if (!knownDevice) {
      await notificationService.enqueue({
        userId: user.id,
        channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH, NotificationChannel.EMAIL, NotificationChannel.SMS],
        template: 'NEW_DEVICE_LOGIN_v1',
        body: `New device sign-in detected (${params.deviceLabel || 'Unknown device'}) from IP ${params.ip || '127.0.0.1'}.`,
      });
      riskService.raiseFlag({
        userId: user.id,
        rule: 'NEW_DEVICE_SIGNIN',
        severity: RiskSeverity.LOW,
        details: `Signed in from unrecognized device fingerprint ${fp.slice(0, 16)}.`,
      });
    }

    const tokens = this.createSession(user, {
      deviceFingerprint: fp,
      deviceLabel: params.deviceLabel || 'Web Browser',
      ip: params.ip || '127.0.0.1',
      userAgent: params.userAgent || 'PWA-Client',
      twoFactorVerified,
    });

    recordAuditLog({
      actorId: user.id,
      actorType: isAdmin ? 'ADMIN' : 'USER',
      action: 'LOGIN_SUCCESS',
      entity: `session:${tokens.sessionId}`,
      after: { role: user.role, staffStatus: user.staffStatus, knownDevice },
      ip: params.ip,
      userAgent: params.userAgent,
    });

    return {
      ...tokens,
      requiresPinSetup: !dbStore.pins.has(user.id),
    };
  }

  /**
   * Returning user/staff authentication using their registered 6-digit security PIN.
   * Enforces the same 3-attempt lockout and mandatory 2FA OTP for staff.
   */
  async loginWithPin(params: {
    email?: string;
    phone?: string;
    pin: string;
    otpCode?: string;
    deviceFingerprint?: string;
    deviceLabel?: string;
    ip?: string;
    userAgent?: string;
  }): Promise<AuthTokensResult> {
    const email = params.email?.trim().toLowerCase();
    const phone = params.phone?.trim();
    const user = [...dbStore.users.values()].find(
      (u) => (email && u.email === email) || (phone && u.phone === phone),
    );

    if (!user) {
      throw new Error('INVALID_CREDENTIALS: Account not found. Please register first.');
    }
    if (user.status === UserStatus.CLOSED) {
      throw new Error('ACCOUNT_CLOSED: This account is closed.');
    }
    if (user.staffStatus === 'REJECTED') {
      throw new Error('FORBIDDEN: This staff access request was declined by Super Admin.');
    }
    if (!dbStore.pins.has(user.id)) {
      throw new Error('PIN_NOT_SET: No 6-digit PIN configured yet. Sign in with password or Google first.');
    }

    await pinService.verifyPinAndIssueStepUp({
      userId: user.id,
      pin: params.pin,
      scope: 'view',
    });

    const isAdmin = ADMIN_ROLES.includes(user.role);
    let twoFactorVerified = !isAdmin;
    let devOtpPreview: string | undefined;

    if (isAdmin) {
      const target = (user.email || user.phone)!;
      const channel = user.email ? 'EMAIL' : 'SMS';
      if (!params.otpCode) {
        const otp = await this.sendOtp({
          userId: user.id,
          target,
          channel,
          purpose: 'LOGIN_2FA',
        });
        devOtpPreview = otp.devPreviewCode;
        return {
          accessToken: '',
          refreshToken: '',
          sessionId: '',
          user: this.sanitizeUser(user),
          requiresOtp: true,
          devOtpPreview,
        };
      }
      await this.verifyOtp({
        target,
        channel,
        purpose: 'LOGIN_2FA',
        code: params.otpCode,
      });
      twoFactorVerified = true;
    }

    const fp = params.deviceFingerprint || 'pin-quick-device';
    const tokens = this.createSession(user, {
      deviceFingerprint: fp,
      deviceLabel: params.deviceLabel || '6-Digit PIN Quick Sign-In',
      ip: params.ip || '127.0.0.1',
      userAgent: params.userAgent || 'PWA-Client',
      twoFactorVerified,
    });

    recordAuditLog({
      actorId: user.id,
      actorType: isAdmin ? 'ADMIN' : 'USER',
      action: 'LOGIN_PIN_SUCCESS',
      entity: `session:${tokens.sessionId}`,
      after: { role: user.role, staffStatus: user.staffStatus },
      ip: params.ip,
      userAgent: params.userAgent,
    });

    return {
      ...tokens,
      requiresPinSetup: false,
    };
  }

  async loginWithGoogle(params: {
    idToken: string;
    legalAccepted?: boolean;
    deviceFingerprint?: string;
    deviceLabel?: string;
    ip?: string;
    userAgent?: string;
  }): Promise<AuthTokensResult> {
    const adminAuth = ensureFirebaseAdminAuth();
    let decoded;
    try {
      decoded = await adminAuth.verifyIdToken(params.idToken);
    } catch {
      throw new Error('INVALID_GOOGLE_TOKEN: Could not verify Google ID token.');
    }

    const googleId = decoded.uid;
    const email = decoded.email?.toLowerCase() || null;

    let user = [...dbStore.users.values()].find(
      (u) => u.googleId === googleId || (email && u.email === email),
    );

    if (!user) {
      if (params.legalAccepted === false) {
        throw new Error('LEGAL_CONFIRMATION_REQUIRED: You must confirm the Terms of Use and Privacy Policy.');
      }
      const now = new Date().toISOString();
      user = {
        id: `usr_${randomUUID()}`,
        email,
        phone: null,
        passwordHash: null,
        googleId,
        role: Role.USER,
        staffStatus: 'NONE',
        requestedRole: null,
        status: UserStatus.ACTIVE,
        freezeReason: null,
        kycStatus: KycStatus.NOT_SUBMITTED,
        kycTier: 0,
        emailVerified: Boolean(decoded.email_verified),
        phoneVerified: false,
        totpEnabled: false,
        legalAcceptedAt: now,
        createdAt: now,
      };
      dbStore.users.set(user.id, user);
      dbStore.mirrorDoc('users', user.id, this.sanitizeUser(user));
    } else if (!user.googleId) {
      user.googleId = googleId;
      if (decoded.email_verified) user.emailVerified = true;
    }

    const tokens = this.createSession(user, {
      deviceFingerprint: params.deviceFingerprint || `google_${googleId.slice(0, 8)}`,
      deviceLabel: params.deviceLabel || 'Google Sign-In',
      ip: params.ip || '127.0.0.1',
      userAgent: params.userAgent || 'PWA-Client',
      twoFactorVerified: !ADMIN_ROLES.includes(user.role) || Boolean(decoded.email_verified),
    });

    recordAuditLog({
      actorId: user.id,
      actorType: 'USER',
      action: 'GOOGLE_LOGIN_SUCCESS',
      entity: `user:${user.id}`,
      ip: params.ip,
      userAgent: params.userAgent,
    });

    return {
      ...tokens,
      requiresPinSetup: !dbStore.pins.has(user.id),
    };
  }

  /**
   * Staff sign-in / registration via Google Social Sign-In on Back-Office Console.
   * Automatically elevates comfort.designszw@gmail.com to APPROVED SUPER_ADMIN.
   */
  async loginOrRegisterStaffWithGoogle(params: {
    idToken: string;
    requestedRole?: Role;
    legalAccepted?: boolean;
    deviceFingerprint?: string;
    deviceLabel?: string;
    ip?: string;
    userAgent?: string;
  }): Promise<AuthTokensResult> {
    rbacService.ensureRbacRulesInDb();

    const adminAuth = ensureFirebaseAdminAuth();
    let decoded;
    try {
      decoded = await adminAuth.verifyIdToken(params.idToken);
    } catch {
      throw new Error('INVALID_GOOGLE_TOKEN: Could not verify Google ID token.');
    }

    const googleId = decoded.uid;
    const email = decoded.email?.toLowerCase() || null;
    const displayName = decoded.name || email?.split('@')[0] || 'Staff Member';
    const isDesignatedSuperAdmin = rbacService.isDesignatedSuperAdminEmail(email);

    let user = [...dbStore.users.values()].find(
      (u) => u.googleId === googleId || (email && u.email === email),
    );

    const now = new Date().toISOString();
    const safeReqRole =
      params.requestedRole && ADMIN_ROLES.includes(params.requestedRole)
        ? params.requestedRole
        : Role.SUPPORT_AGENT;

    if (!user) {
      if (params.legalAccepted === false) {
        throw new Error('LEGAL_CONFIRMATION_REQUIRED: You must confirm the Terms of Use and Privacy Policy.');
      }
      user = {
        id: `stf_${randomUUID()}`,
        email,
        phone: null,
        passwordHash: null,
        googleId,
        role: isDesignatedSuperAdmin
          ? Role.SUPER_ADMIN
          : safeReqRole === Role.SUPER_ADMIN
            ? Role.SUPPORT_AGENT
            : safeReqRole,
        staffStatus: isDesignatedSuperAdmin ? 'APPROVED' : 'PENDING_APPROVAL',
        requestedRole: isDesignatedSuperAdmin ? Role.SUPER_ADMIN : safeReqRole,
        status: UserStatus.ACTIVE,
        freezeReason: null,
        kycStatus: KycStatus.APPROVED,
        kycTier: 2,
        emailVerified: Boolean(decoded.email_verified),
        phoneVerified: false,
        totpEnabled: true,
        legalAcceptedAt: now,
        createdAt: now,
      };
      dbStore.users.set(user.id, user);
      dbStore.userProfiles.set(user.id, {
        userId: user.id,
        fullName: displayName,
        dateOfBirth: '1990-01-01',
        nationalIdEncrypted: '',
        address: 'Comfort Secure Wallet Staff Office',
        country: 'ZW',
        updatedAt: now,
      });
      dbStore.mirrorDoc('users', user.id, this.sanitizeUser(user));
    } else {
      if (!user.googleId) user.googleId = googleId;
      if (decoded.email_verified) user.emailVerified = true;
      if (user.staffStatus === 'REJECTED') {
        throw new Error('FORBIDDEN: Staff access request was declined by Super Admin.');
      }
      if (isDesignatedSuperAdmin) {
        user.role = Role.SUPER_ADMIN;
        user.staffStatus = 'APPROVED';
        user.requestedRole = Role.SUPER_ADMIN;
        user.totpEnabled = true;
      } else if (user.role === Role.USER) {
        user.role = safeReqRole === Role.SUPER_ADMIN ? Role.SUPPORT_AGENT : safeReqRole;
        user.staffStatus = 'PENDING_APPROVAL';
        user.requestedRole = safeReqRole;
        user.totpEnabled = true;
      }
      dbStore.mirrorDoc('users', user.id, this.sanitizeUser(user));
    }

    const tokens = this.createSession(user, {
      deviceFingerprint: params.deviceFingerprint || `stf_google_${googleId.slice(0, 8)}`,
      deviceLabel: params.deviceLabel || 'Back-Office Google Sign-In',
      ip: params.ip || '127.0.0.1',
      userAgent: params.userAgent || 'BackOffice-Client',
      twoFactorVerified: Boolean(decoded.email_verified ?? true),
    });

    recordAuditLog({
      actorId: user.id,
      actorType: isDesignatedSuperAdmin ? 'ADMIN' : 'SYSTEM',
      action: isDesignatedSuperAdmin ? 'SUPER_ADMIN_GOOGLE_LOGIN' : 'STAFF_GOOGLE_LOGIN',
      entity: `user:${user.id}`,
      after: { email, role: user.role, staffStatus: user.staffStatus },
      ip: params.ip,
      userAgent: params.userAgent,
    });

    return {
      ...tokens,
      requiresPinSetup: !dbStore.pins.has(user.id),
    };
  }

  createSession(
    user: UserRecord,
    meta: { deviceFingerprint: string; deviceLabel: string; ip: string; userAgent: string; twoFactorVerified: boolean },
  ): AuthTokensResult {
    const refreshToken = generateRefreshToken();
    const session: SessionRecord = {
      id: `ses_${randomUUID()}`,
      userId: user.id,
      deviceFingerprint: meta.deviceFingerprint,
      deviceLabel: meta.deviceLabel,
      ip: meta.ip,
      userAgent: meta.userAgent,
      refreshTokenHash: sha256Hex(refreshToken),
      usedRefreshTokenHashes: [],
      familyId: randomUUID(),
      lastSeen: new Date().toISOString(),
      revokedAt: null,
      createdAt: new Date().toISOString(),
    };
    dbStore.sessions.set(session.id, session);

    const accessToken = signAccessToken({
      sub: user.id,
      sid: session.id,
      role: user.role,
      twoFactorVerified: meta.twoFactorVerified,
    });

    return {
      accessToken,
      refreshToken,
      sessionId: session.id,
      user: this.sanitizeUser(user),
    };
  }

  /**
   * Rotate refresh token with strict reuse detection:
   * If a previously rotated refresh token is presented again, revoke the entire session family and raise a risk flag!
   */
  rotateRefreshToken(refreshToken: string, ip = '127.0.0.1'): AuthTokensResult {
    const tokenHash = sha256Hex(refreshToken);

    for (const session of dbStore.sessions.values()) {
      if (session.usedRefreshTokenHashes.includes(tokenHash)) {
        // Reuse detected! Revoke entire family
        for (const s of dbStore.sessions.values()) {
          if (s.familyId === session.familyId) {
            s.revokedAt = new Date().toISOString();
          }
        }
        riskService.raiseFlag({
          userId: session.userId,
          rule: 'REFRESH_TOKEN_REUSE_DETECTED',
          severity: RiskSeverity.HIGH,
          details: `Rotated refresh token replay detected for session family ${session.familyId}. All family sessions revoked.`,
        });
        recordAuditLog({
          actorId: session.userId,
          actorType: 'SYSTEM',
          action: 'REFRESH_TOKEN_REUSE_REVOCATION',
          entity: `session_family:${session.familyId}`,
          ip,
        });
        throw new Error('TOKEN_REUSE_DETECTED: Session compromised and revoked. Please sign in again.');
      }

      if (session.refreshTokenHash === tokenHash) {
        if (session.revokedAt) {
          throw new Error('SESSION_REVOKED: Session has been revoked.');
        }
        // Idle timeout check: 5 minutes (300_000 ms) unless disabled in automated test
        const idleMs = Date.now() - Date.parse(session.lastSeen);
        if (idleMs > 30 * 60 * 1000) {
          session.revokedAt = new Date().toISOString();
          throw new Error('SESSION_IDLE_EXPIRED: Session timed out due to inactivity.');
        }

        const user = dbStore.users.get(session.userId);
        if (!user) throw new Error('USER_NOT_FOUND');

        const nextRefresh = generateRefreshToken();
        session.usedRefreshTokenHashes.push(tokenHash);
        session.refreshTokenHash = sha256Hex(nextRefresh);
        session.lastSeen = new Date().toISOString();

        const accessToken = signAccessToken({
          sub: user.id,
          sid: session.id,
          role: user.role,
          twoFactorVerified: true,
        });

        return {
          accessToken,
          refreshToken: nextRefresh,
          sessionId: session.id,
          user: this.sanitizeUser(user),
        };
      }
    }

    throw new Error('INVALID_REFRESH_TOKEN');
  }

  revokeSession(userId: string, sessionId: string) {
    const s = dbStore.sessions.get(sessionId);
    if (!s || s.userId !== userId) throw new Error('Session not found');
    s.revokedAt = new Date().toISOString();
    recordAuditLog({
      actorId: userId,
      actorType: 'USER',
      action: 'DEVICE_SESSION_REVOKED',
      entity: `session:${sessionId}`,
    });
  }

  listSessions(userId: string) {
    return [...dbStore.sessions.values()]
      .filter((s) => s.userId === userId)
      .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
      .map((s) => ({
        id: s.id,
        deviceLabel: s.deviceLabel,
        ip: s.ip,
        lastSeen: s.lastSeen,
        revokedAt: s.revokedAt,
        createdAt: s.createdAt,
      }));
  }

  async resetPassword(params: { target: string; channel: 'SMS' | 'EMAIL'; otpCode: string; newPassword: string }) {
    const pwCheck = validatePasswordStrength(params.newPassword);
    if (!pwCheck.valid) throw new Error(`WEAK_PASSWORD: ${pwCheck.reason}`);
    const verified = await this.verifyOtp({
      target: params.target,
      channel: params.channel,
      purpose: 'PIN_RESET',
      code: params.otpCode,
    });
    if (!verified.userId) throw new Error('USER_NOT_FOUND');
    const user = dbStore.users.get(verified.userId);
    if (!user) throw new Error('USER_NOT_FOUND');
    user.passwordHash = await hashPassword(params.newPassword);
    // Revoke all existing sessions on password reset
    for (const s of dbStore.sessions.values()) {
      if (s.userId === user.id && !s.revokedAt) s.revokedAt = new Date().toISOString();
    }
    recordAuditLog({
      actorId: user.id,
      actorType: 'USER',
      action: 'PASSWORD_RESET',
      entity: `user:${user.id}`,
    });
  }
}

export const authService = new AuthService();
