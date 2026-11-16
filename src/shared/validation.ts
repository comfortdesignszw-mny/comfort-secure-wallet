import { z } from 'zod';
import { Currency, TransactionType } from './types.ts';

const BREACHED_PASSWORDS = new Set([
  'password123',
  'password1234',
  'qwerty12345',
  '1234567890',
  'comfortwallet',
  'zimbabwe2025',
  'letmein1234',
  'welcome1234',
  'admin123456',
  'passw0rd123',
]);

export function validatePasswordStrength(password: string): { valid: boolean; reason?: string } {
  if (password.length < 10) {
    return { valid: false, reason: 'Password must be at least 10 characters long.' };
  }
  if (password.length > 128) {
    return { valid: false, reason: 'Password exceeds maximum length of 128 characters.' };
  }
  if (BREACHED_PASSWORDS.has(password.toLowerCase())) {
    return { valid: false, reason: 'This password appears in known breach lists. Choose a stronger password.' };
  }
  const hasLetter = /[a-zA-Z]/.test(password);
  const hasDigit = /\d/.test(password);
  if (!hasLetter || !hasDigit) {
    return { valid: false, reason: 'Password must include both letters and numbers.' };
  }
  return { valid: true };
}

export function isTrivialPin(pin: string, dateOfBirth?: string | null): { trivial: boolean; reason?: string } {
  if (!/^\d{6}$/.test(pin)) {
    return { trivial: true, reason: 'PIN must be exactly 6 digits.' };
  }

  // All identical digits (e.g., 000000, 111111)
  if (/^(\d)\1{5}$/.test(pin)) {
    return { trivial: true, reason: 'PIN cannot repeat the same digit.' };
  }

  // Repeating 2-digit or 3-digit pairs (e.g., 121212, 123123)
  if (/^(\d{2})\1{2}$/.test(pin) || /^(\d{3})\1$/.test(pin)) {
    return { trivial: true, reason: 'PIN cannot use repeating digit patterns.' };
  }

  // Ascending or descending sequences (e.g., 123456, 654321, 012345)
  const digits = pin.split('').map(Number);
  let asc = true;
  let desc = true;
  for (let i = 1; i < digits.length; i++) {
    if (digits[i] !== (digits[i - 1] + 1) % 10) asc = false;
    if (digits[i] !== (digits[i - 1] + 9) % 10) desc = false;
  }
  if (asc || desc) {
    return { trivial: true, reason: 'PIN cannot be a sequential pattern.' };
  }

  // Common trivial PINs
  const common = new Set(['123456', '654321', '112233', '123321', '000111', '102030', '258000', '199000', '200000']);
  if (common.has(pin)) {
    return { trivial: true, reason: 'PIN is too common. Choose a less predictable 6-digit code.' };
  }

  // Check against date of birth digits (YYYYMMDD / DDMMYY / MMDDYY)
  if (dateOfBirth) {
    const dobDigits = dateOfBirth.replace(/\D/g, '');
    if (dobDigits.length === 8) {
      const yyyy = dobDigits.slice(0, 4);
      const mm = dobDigits.slice(4, 6);
      const dd = dobDigits.slice(6, 8);
      const yy = yyyy.slice(2, 4);
      const candidates = new Set([
        `${dd}${mm}${yy}`,
        `${mm}${dd}${yy}`,
        `${yy}${mm}${dd}`,
        `${yyyy}${mm}`,
        `${mm}${yyyy}`,
      ]);
      if (candidates.has(pin)) {
        return { trivial: true, reason: 'PIN cannot match your date of birth.' };
      }
    }
  }

  return { trivial: false };
}

export const registerSchema = z
  .object({
    email: z.string().trim().email().max(254).optional(),
    phone: z
      .string()
      .trim()
      .regex(/^\+[1-9]\d{7,14}$/, 'Phone must be in E.164 format (e.g. +263771234567)')
      .optional(),
    password: z.string().min(10).max(128),
    fullName: z.string().trim().min(2).max(120).optional(),
    deviceFingerprint: z.string().min(8).max(128).optional(),
    deviceLabel: z.string().min(2).max(120).optional(),
    legalAccepted: z.boolean().optional(),
  })
  .refine((d) => Boolean(d.email || d.phone), {
    message: 'Either email or phone number is required.',
  });

export const staffRegisterSchema = z
  .object({
    email: z.string().trim().email().max(254).optional(),
    phone: z
      .string()
      .trim()
      .regex(/^\+[1-9]\d{7,14}$/, 'Phone must be in E.164 format (e.g. +263771234567)')
      .optional(),
    password: z.string().min(10).max(128),
    fullName: z.string().trim().min(2).max(120),
    requestedRole: z.enum([
      'SUPPORT_AGENT',
      'KYC_OFFICER',
      'FINANCE_MAKER',
      'FINANCE_CHECKER',
      'COMPLIANCE_OFFICER',
      'AUDITOR',
      'SUPER_ADMIN',
    ]),
    deviceFingerprint: z.string().min(8).max(128).optional(),
    deviceLabel: z.string().min(2).max(120).optional(),
    legalAccepted: z.boolean().refine((v) => v === true, {
      message: 'You must read and confirm the legal terms before registering.',
    }),
  })
  .refine((d) => Boolean(d.email || d.phone), {
    message: 'Either email or phone number is required.',
  });

export const loginSchema = z
  .object({
    email: z.string().trim().email().max(254).optional(),
    phone: z.string().trim().regex(/^\+[1-9]\d{7,14}$/).optional(),
    password: z.string().min(1).max(128),
    deviceFingerprint: z.string().min(8).max(128).optional(),
    deviceLabel: z.string().min(2).max(120).optional(),
    otpCode: z.string().regex(/^\d{6}$/).optional(),
  })
  .refine((d) => Boolean(d.email || d.phone), {
    message: 'Email or phone is required.',
  });

export const pinLoginSchema = z
  .object({
    email: z.string().trim().email().max(254).optional(),
    phone: z.string().trim().regex(/^\+[1-9]\d{7,14}$/).optional(),
    pin: z.string().regex(/^\d{6}$/, 'PIN must be exactly 6 digits'),
    deviceFingerprint: z.string().min(8).max(128).optional(),
    deviceLabel: z.string().min(2).max(120).optional(),
    otpCode: z.string().regex(/^\d{6}$/).optional(),
  })
  .refine((d) => Boolean(d.email || d.phone), {
    message: 'Email or phone is required.',
  });

export const otpSendSchema = z.object({
  target: z.string().trim().min(4).max(254),
  channel: z.enum(['SMS', 'EMAIL']),
  purpose: z.enum(['REGISTER', 'LOGIN_2FA', 'NEW_DEVICE', 'PIN_RESET', 'HIGH_RISK']),
});

export const otpVerifySchema = z.object({
  target: z.string().trim().min(4).max(254),
  channel: z.enum(['SMS', 'EMAIL']),
  purpose: z.enum(['REGISTER', 'LOGIN_2FA', 'NEW_DEVICE', 'PIN_RESET', 'HIGH_RISK']),
  code: z.string().regex(/^\d{6}$/, 'OTP must be 6 digits'),
});

export const pinSetSchema = z.object({
  pin: z.string().regex(/^\d{6}$/, 'PIN must be 6 digits'),
  confirmPin: z.string().regex(/^\d{6}$/, 'Confirmation PIN must be 6 digits').optional(),
}).refine((d) => !d.confirmPin || d.pin === d.confirmPin, {
  message: 'PIN and confirmation PIN do not match.',
});

export const pinVerifySchema = z.object({
  pin: z.string().regex(/^\d{6}$/, 'PIN must be 6 digits'),
  scope: z.enum(['view', 'transaction', 'admin_action']),
  action: z.enum(['transfer', 'withdrawal']).optional(),
  adminAction: z.string().min(3).max(64).optional(),
  amountMinor: z.number().int().positive().optional(),
  currency: z.nativeEnum(Currency).optional(),
});

export const kycSubmitSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date of birth must be YYYY-MM-DD'),
  nationalIdNumber: z.string().trim().min(5).max(40),
  address: z.string().trim().min(5).max(250),
  country: z.string().trim().min(2).max(3).default('ZW'),
  documentType: z.enum(['NATIONAL_ID', 'PASSPORT']).default('NATIONAL_ID'),
  idDocumentDataUrl: z.string().min(20).max(2_500_000),
  selfieDataUrl: z.string().min(20).max(2_500_000),
});

export const depositRequestSchema = z.object({
  accountId: z.string().min(4).max(128),
  amountMinor: z.number().int().positive().max(100_000_000),
  currency: z.nativeEnum(Currency),
  method: z.enum(['BANK_TRANSFER', 'ECOCASH', 'INNBUCKS', 'ZIPIT']),
  paymentReference: z.string().trim().min(4).max(64),
  proofDataUrl: z.string().min(20).max(2_500_000),
});

export const transferSchema = z.object({
  fromAccountId: z.string().min(4).max(128),
  toAccountNumber: z.string().regex(/^\d{10}$/, 'Recipient account number must be 10 digits'),
  amountMinor: z.number().int().positive().max(100_000_000),
  note: z.string().trim().max(140).optional(),
});

export const withdrawalRequestSchema = z.object({
  accountId: z.string().min(4).max(128),
  amountMinor: z.number().int().positive().max(100_000_000),
  method: z.enum(['BANK_TRANSFER', 'ECOCASH', 'INNBUCKS']),
  destinationLabel: z.string().trim().min(4).max(160),
});

export const feeRuleUpdateSchema = z.object({
  transactionType: z.nativeEnum(TransactionType),
  currency: z.nativeEnum(Currency),
  flatMinor: z.number().int().min(0).max(100_000),
  percentBps: z.number().int().min(0).max(1000),
  minMinor: z.number().int().min(0).max(100_000),
  maxMinor: z.number().int().min(0).max(1_000_000),
  active: z.boolean(),
});

export const limitRuleUpdateSchema = z.object({
  scope: z.enum(['TIER_1', 'TIER_2', 'USER']),
  scopeId: z.string().min(1).max(128),
  transactionType: z.nativeEnum(TransactionType),
  currency: z.nativeEnum(Currency),
  perTxnMaxMinor: z.number().int().positive(),
  dailyMaxMinor: z.number().int().positive(),
  monthlyMaxMinor: z.number().int().positive(),
});
