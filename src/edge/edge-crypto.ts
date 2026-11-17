import { Currency, Role } from '../shared/types.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toB64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function fromB64Url(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((input.length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function randomHex(byteLen = 16): string {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomToken(byteLen = 24): string {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  return toB64Url(bytes);
}

export function generateNumericOtpEdge(): string {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return String(arr[0] % 1_000_000).padStart(6, '0');
}

export async function sha256HexEdge(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Bytes(input: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', encoder.encode(input));
}

function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

export async function hmacSha256B64Url(secretRaw: string, message: string): Promise<string> {
  const keyBytes = await sha256Bytes(secretRaw);
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return toB64Url(new Uint8Array(sig));
}

export async function hashPasswordEdge(password: string): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const iterations = 100_000;
  const baseKey = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-512' },
    baseKey,
    256,
  );
  return `pbkdf2_sha512$${iterations}$${toB64Url(salt)}$${toB64Url(new Uint8Array(bits))}`;
}

export async function verifyPasswordEdge(password: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split('$');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha512') return false;
    const iterations = Number(parts[1]);
    const salt = fromB64Url(parts[2]);
    const expected = fromB64Url(parts[3]);
    const baseKey = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-512' },
      baseKey,
      expected.length * 8,
    );
    return timingSafeEqualBytes(new Uint8Array(bits), expected);
  } catch {
    return false;
  }
}

export async function hashPinEdge(
  pin: string,
  pinPepper: string,
  existingSalt?: string,
): Promise<{ hash: string; salt: string }> {
  const salt = existingSalt || randomHex(16);
  const peppered = await hmacSha256B64Url(pinPepper, `${salt}:${pin}`);
  const hash = await hashPasswordEdge(peppered);
  return { hash, salt };
}

export async function verifyPinEdge(
  pin: string,
  salt: string,
  storedHash: string,
  pinPepper: string,
): Promise<boolean> {
  const peppered = await hmacSha256B64Url(pinPepper, `${salt}:${pin}`);
  return verifyPasswordEdge(peppered, storedHash);
}

export async function encryptFieldEdge(plaintext: string, encryptionSecret: string): Promise<string> {
  const keyBytes = await sha256Bytes(encryptionSecret);
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(plaintext),
  );
  return `${toB64Url(iv)}.${toB64Url(new Uint8Array(encrypted))}`;
}

export async function decryptFieldEdge(payload: string, encryptionSecret: string): Promise<string> {
  const parts = payload.split('.');
  if (parts.length !== 2) throw new Error('Malformed encrypted payload');
  const iv = fromB64Url(parts[0]);
  const data = fromB64Url(parts[1]);
  const keyBytes = await sha256Bytes(encryptionSecret);
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    data as BufferSource,
  );
  return decoder.decode(plain);
}

export interface EdgeAccessClaims {
  sub: string;
  sid: string;
  role: Role;
  twoFactorVerified: boolean;
  iat: number;
  exp: number;
}

export interface EdgeStepUpClaims {
  jti: string;
  sub: string;
  scope: 'view' | 'transaction' | 'admin_action';
  action?: 'transfer' | 'withdrawal';
  adminAction?: string;
  amountMinor?: number;
  currency?: Currency;
  kind: 'step_up';
  iat: number;
  exp: number;
}

export async function signJwtEdge(
  payload: Record<string, unknown>,
  secret: string,
  ttlSeconds: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const full = { ...payload, iat: now, exp: now + ttlSeconds };
  const header = toB64Url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = toB64Url(encoder.encode(JSON.stringify(full)));
  const sig = await hmacSha256B64Url(secret, `${header}.${body}`);
  return `${header}.${body}.${sig}`;
}

export async function verifyJwtEdge<T extends { exp?: number }>(
  token: string,
  secret: string,
): Promise<T | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    const expectedSig = await hmacSha256B64Url(secret, `${header}.${body}`);
    if (!timingSafeEqualBytes(encoder.encode(sig), encoder.encode(expectedSig))) {
      return null;
    }
    const parsed = JSON.parse(decoder.decode(fromB64Url(body))) as T;
    if (typeof parsed.exp !== 'number' || parsed.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

interface JwkCache {
  keys: Array<JsonWebKey & { kid?: string; alg?: string }>;
  expiresAt: number;
}

let cachedGoogleJwks: JwkCache | null = null;

async function fetchFirebaseSecureTokenJwks(): Promise<Array<JsonWebKey & { kid?: string; alg?: string }>> {
  if (cachedGoogleJwks && Date.now() < cachedGoogleJwks.expiresAt) {
    return cachedGoogleJwks.keys;
  }
  const res = await fetch(
    'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com',
  );
  if (!res.ok) {
    throw new Error('Could not fetch Google public signing keys');
  }
  const data = (await res.json()) as { keys?: Array<JsonWebKey & { kid?: string; alg?: string }> };
  const keys = data.keys || [];
  cachedGoogleJwks = { keys, expiresAt: Date.now() + 30 * 60 * 1000 };
  return keys;
}

export interface VerifiedFirebaseClaims {
  uid: string;
  email: string | null;
  email_verified: boolean;
  name?: string;
}

export async function verifyFirebaseIdTokenEdge(
  idToken: string,
  expectedProjectId: string,
): Promise<VerifiedFirebaseClaims> {
  const parts = idToken.split('.');
  if (parts.length !== 3) {
    throw new Error('INVALID_GOOGLE_TOKEN: Malformed ID token.');
  }
  const [headerB64, payloadB64, sigB64] = parts;
  const header = JSON.parse(decoder.decode(fromB64Url(headerB64))) as { alg?: string; kid?: string };
  const payload = JSON.parse(decoder.decode(fromB64Url(payloadB64))) as {
    aud?: string;
    iss?: string;
    sub?: string;
    exp?: number;
    iat?: number;
    email?: string;
    email_verified?: boolean;
    name?: string;
  };

  const now = Math.floor(Date.now() / 1000);
  if (
    header.alg !== 'RS256' ||
    !header.kid ||
    payload.aud !== expectedProjectId ||
    payload.iss !== `https://securetoken.google.com/${expectedProjectId}` ||
    !payload.sub ||
    typeof payload.exp !== 'number' ||
    payload.exp <= now
  ) {
    throw new Error('INVALID_GOOGLE_TOKEN: Token claims invalid or expired.');
  }

  const jwks = await fetchFirebaseSecureTokenJwks();
  const jwk = jwks.find((k) => k.kid === header.kid);
  if (!jwk) {
    throw new Error('INVALID_GOOGLE_TOKEN: Unknown Google signing key.');
  }

  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    fromB64Url(sigB64) as BufferSource,
    encoder.encode(`${headerB64}.${payloadB64}`),
  );
  if (!valid) {
    throw new Error('INVALID_GOOGLE_TOKEN: Signature verification failed.');
  }

  return {
    uid: payload.sub,
    email: payload.email ? payload.email.toLowerCase() : null,
    email_verified: Boolean(payload.email_verified),
    name: payload.name,
  };
}
