import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { argon2id, argon2Verify } from 'hash-wasm';
import { getSecrets } from '../config/env.ts';
import { Currency, Role } from '../../shared/types.ts';

function b64urlEncode(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function b64urlDecode(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return argon2id({
    password,
    salt,
    parallelism: 1,
    iterations: 2,
    memorySize: 16384,
    hashLength: 32,
    outputType: 'encoded',
  });
}

export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  try {
    return await argon2Verify({ password, hash: encodedHash });
  } catch {
    return false;
  }
}

export async function hashPin(pin: string, perUserSalt?: string): Promise<{ hash: string; salt: string }> {
  const salt = perUserSalt || randomBytes(16).toString('hex');
  const { pinPepper } = getSecrets();
  const pepperedInput = createHmac('sha256', pinPepper).update(`${salt}:${pin}`).digest('hex');
  const hash = await argon2id({
    password: pepperedInput,
    salt: Buffer.from(salt, 'hex'),
    parallelism: 1,
    iterations: 2,
    memorySize: 16384,
    hashLength: 32,
    outputType: 'encoded',
  });
  return { hash, salt };
}

export async function verifyPinHash(pin: string, salt: string, storedHash: string): Promise<boolean> {
  try {
    const { pinPepper } = getSecrets();
    const pepperedInput = createHmac('sha256', pinPepper).update(`${salt}:${pin}`).digest('hex');
    return await argon2Verify({ password: pepperedInput, hash: storedHash });
  } catch {
    return false;
  }
}

export function generateNumericOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function encryptField(plaintext: string): string {
  const { fieldEncryptionKey } = getSecrets();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', fieldEncryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function decryptField(payload: string): string {
  const { fieldEncryptionKey } = getSecrets();
  const parts = payload.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted field payload');
  }
  const [ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, 'base64url');
  const tag = Buffer.from(tagB64, 'base64url');
  const data = Buffer.from(dataB64, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', fieldEncryptionKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export function encryptBuffer(buffer: Buffer): string {
  return encryptField(buffer.toString('base64'));
}

export function decryptBuffer(payload: string): Buffer {
  return Buffer.from(decryptField(payload), 'base64');
}

interface SignedPayload {
  exp: number;
  iat: number;
  [key: string]: unknown;
}

function signToken(payload: Record<string, unknown>, secret: Buffer, ttlSeconds: number): string {
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: SignedPayload = {
    ...payload,
    iat: now,
    exp: now + ttlSeconds,
  };
  const header = b64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64urlEncode(JSON.stringify(fullPayload));
  const signingInput = `${header}.${body}`;
  const sig = createHmac('sha256', secret).update(signingInput).digest('base64url');
  return `${signingInput}.${sig}`;
}

function verifyToken<T extends SignedPayload>(token: string, secret: Buffer): T | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    const expectedSig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
    const sigBuf = Buffer.from(sig);
    const expectedBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
      return null;
    }
    const parsed = JSON.parse(b64urlDecode(body).toString('utf8')) as T;
    if (typeof parsed.exp !== 'number' || parsed.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export interface AccessTokenClaims extends SignedPayload {
  sub: string;
  sid: string;
  role: Role;
  twoFactorVerified: boolean;
}

export function signAccessToken(claims: { sub: string; sid: string; role: Role; twoFactorVerified: boolean }): string {
  const { jwtSecret } = getSecrets();
  // Short-lived access token: 15 minutes
  return signToken(claims, jwtSecret, 15 * 60);
}

export function verifyAccessToken(token: string): AccessTokenClaims | null {
  const { jwtSecret } = getSecrets();
  return verifyToken<AccessTokenClaims>(token, jwtSecret);
}

export interface StepUpTokenClaims extends SignedPayload {
  jti: string;
  sub: string;
  scope: 'view' | 'transaction' | 'admin_action';
  action?: 'transfer' | 'withdrawal';
  adminAction?: string;
  amountMinor?: number;
  currency?: Currency;
}

export function signStepUpToken(claims: {
  jti: string;
  sub: string;
  scope: 'view' | 'transaction' | 'admin_action';
  action?: 'transfer' | 'withdrawal';
  adminAction?: string;
  amountMinor?: number;
  currency?: Currency;
}): string {
  const { jwtSecret } = getSecrets();
  const ttl = claims.scope === 'view' ? 5 * 60 : 2 * 60;
  return signToken({ ...claims, kind: 'step_up' }, jwtSecret, ttl);
}

export function verifyStepUpToken(token: string): StepUpTokenClaims | null {
  const { jwtSecret } = getSecrets();
  const claims = verifyToken<StepUpTokenClaims & { kind?: string }>(token, jwtSecret);
  if (!claims || claims.kind !== 'step_up') return null;
  return claims;
}

export function signStorageKey(storageKey: string, ttlSeconds = 60): { url: string; expiresAt: number; signature: string } {
  const { signedUrlSecret } = getSecrets();
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const signature = createHmac('sha256', signedUrlSecret).update(`${storageKey}:${expiresAt}`).digest('base64url');
  const url = `/api/v1/storage/signed?key=${encodeURIComponent(storageKey)}&exp=${expiresAt}&sig=${encodeURIComponent(signature)}`;
  return { url, expiresAt, signature };
}

export function verifyStorageSignature(storageKey: string, expStr: string, sig: string): boolean {
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const { signedUrlSecret } = getSecrets();
  const expected = createHmac('sha256', signedUrlSecret).update(`${storageKey}:${exp}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

export function generateCsrfToken(): string {
  return randomBytes(24).toString('base64url');
}
