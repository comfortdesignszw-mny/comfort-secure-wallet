import { createHash, randomBytes } from 'node:crypto';

let runtimeEnvOverrides: Record<string, string | undefined> = {};

/**
 * Hydrate runtime secrets from external platform bindings (e.g., Cloudflare Pages / Workers context.env).
 * Secrets are never hardcoded or requested in the assistant UI.
 */
export function hydrateEnvBindings(bindings: Record<string, unknown>) {
  for (const [k, v] of Object.entries(bindings)) {
    if (typeof v === 'string' && v.length > 0) {
      runtimeEnvOverrides[k] = v;
    }
  }
  cachedSecrets = null;
}

function readEnv(key: string): string | undefined {
  return runtimeEnvOverrides[key] ?? process.env[key];
}

function deriveDevSecret(label: string): Buffer {
  // Deterministic only in non-production local dev/test when KMS/Cloudflare secrets are not injected
  const seed = readEnv('DEV_MASTER_SEED') || `comfort-secure-wallet-dev-${process.pid}`;
  return createHash('sha256').update(`${label}:${seed}`).digest();
}

export function getSuperAdminEmail(): string {
  return (readEnv('SUPER_ADMIN_EMAIL') || 'comfort.designszw@gmail.com').trim().toLowerCase();
}

export function isProductionMode(): boolean {
  return readEnv('NODE_ENV') === 'production';
}

export interface AppSecrets {
  jwtSecret: Buffer;
  refreshSecret: Buffer;
  pinPepper: string;
  fieldEncryptionKey: Buffer;
  signedUrlSecret: Buffer;
  isProduction: boolean;
}

let cachedSecrets: AppSecrets | null = null;

export function getSecrets(): AppSecrets {
  if (cachedSecrets) return cachedSecrets;
  const isProduction = isProductionMode();

  const rawJwt = readEnv('WALLET_JWT_SECRET');
  const jwtSecret = rawJwt
    ? createHash('sha256').update(rawJwt).digest()
    : isProduction
      ? randomBytes(32)
      : deriveDevSecret('jwt');

  const rawRefresh = readEnv('WALLET_REFRESH_SECRET');
  const refreshSecret = rawRefresh
    ? createHash('sha256').update(rawRefresh).digest()
    : isProduction
      ? randomBytes(32)
      : deriveDevSecret('refresh');

  const pinPepper = readEnv('WALLET_PIN_PEPPER') || deriveDevSecret('pin-pepper').toString('hex');

  const rawField = readEnv('WALLET_FIELD_ENCRYPTION_KEY');
  const fieldEncryptionKey = rawField
    ? createHash('sha256').update(rawField).digest()
    : deriveDevSecret('field-aes256');

  const rawSignedUrl = readEnv('WALLET_SIGNED_URL_SECRET');
  const signedUrlSecret = rawSignedUrl
    ? createHash('sha256').update(rawSignedUrl).digest()
    : deriveDevSecret('signed-url');

  cachedSecrets = {
    jwtSecret,
    refreshSecret,
    pinPepper,
    fieldEncryptionKey,
    signedUrlSecret,
    isProduction,
  };
  return cachedSecrets;
}
