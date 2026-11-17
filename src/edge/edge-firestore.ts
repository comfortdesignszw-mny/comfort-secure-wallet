import firebaseConfig from '../../firebase-applet-config.json';

export interface EdgeCloudKvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export interface EdgeCloudEnv {
  FIREBASE_SERVICE_ACCOUNT_JSON?: string;
  WALLET_KV?: EdgeCloudKvLike;
}

interface ServiceAccountCreds {
  client_email: string;
  private_key: string;
  project_id?: string;
}

let cachedAccessToken: { token: string; expiresAtMs: number; clientEmail: string } | null = null;

function base64UrlEncode(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function pemToDer(pem: string): ArrayBuffer {
  const stripped = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const bin = atob(stripped);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function parseServiceAccount(env: EdgeCloudEnv): ServiceAccountCreds | null {
  const raw = env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ServiceAccountCreds;
    if (!parsed.client_email || !parsed.private_key) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function getCloudBackendType(env: EdgeCloudEnv): 'firestore' | 'kv' | 'memory' {
  if (parseServiceAccount(env)) return 'firestore';
  if (env.WALLET_KV) return 'kv';
  return 'memory';
}

async function getGoogleAccessToken(creds: ServiceAccountCreds): Promise<string> {
  if (
    cachedAccessToken &&
    cachedAccessToken.clientEmail === creds.client_email &&
    Date.now() < cachedAccessToken.expiresAtMs - 60_000
  ) {
    return cachedAccessToken.token;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64UrlEncode(
    JSON.stringify({
      iss: creds.client_email,
      sub: creds.client_email,
      aud: 'https://oauth2.googleapis.com/token',
      scope: 'https://www.googleapis.com/auth/datastore',
      iat: nowSec,
      exp: nowSec + 3600,
    }),
  );
  const unsigned = `${header}.${payload}`;

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(creds.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned)),
  );
  const assertion = `${unsigned}.${base64UrlEncode(sig)}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) {
    throw new Error(`Firestore OAuth token exchange failed (${res.status})`);
  }
  const data = (await res.json()) as { access_token: string; expires_in?: number };
  cachedAccessToken = {
    token: data.access_token,
    expiresAtMs: Date.now() + (data.expires_in || 3600) * 1000,
    clientEmail: creds.client_email,
  };
  return data.access_token;
}

type FirestoreValue =
  | { nullValue: null }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number }
  | { stringValue: string }
  | { arrayValue: { values?: FirestoreValue[] } }
  | { mapValue: { fields?: Record<string, FirestoreValue> } };

function encodeFirestoreValue(val: unknown): FirestoreValue {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number') {
    if (Number.isInteger(val) && Number.isSafeInteger(val)) {
      return { integerValue: String(val) };
    }
    return { doubleValue: val };
  }
  if (typeof val === 'string') return { stringValue: val };
  if (Array.isArray(val)) {
    return { arrayValue: { values: val.map((item) => encodeFirestoreValue(item)) } };
  }
  if (typeof val === 'object') {
    const fields: Record<string, FirestoreValue> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (v !== undefined) {
        fields[k] = encodeFirestoreValue(v);
      }
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

function decodeFirestoreValue(val: Record<string, unknown> | undefined): unknown {
  if (!val) return null;
  if ('nullValue' in val) return null;
  if ('booleanValue' in val) return Boolean(val.booleanValue);
  if ('integerValue' in val) return Number(val.integerValue);
  if ('doubleValue' in val) return Number(val.doubleValue);
  if ('stringValue' in val) return String(val.stringValue);
  if ('timestampValue' in val) return String(val.timestampValue);
  if ('arrayValue' in val) {
    const arr = (val.arrayValue as { values?: Array<Record<string, unknown>> })?.values || [];
    return arr.map((item) => decodeFirestoreValue(item));
  }
  if ('mapValue' in val) {
    const fields = (val.mapValue as { fields?: Record<string, Record<string, unknown>> })?.fields || {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      out[k] = decodeFirestoreValue(v);
    }
    return out;
  }
  return null;
}

function encodeFields(data: Record<string, unknown>): Record<string, FirestoreValue> {
  const fields: Record<string, FirestoreValue> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) {
      fields[k] = encodeFirestoreValue(v);
    }
  }
  return fields;
}

function decodeDoc(doc: { name?: string; fields?: Record<string, Record<string, unknown>> }): { id: string; data: Record<string, unknown> } | null {
  if (!doc.name) return null;
  const parts = doc.name.split('/');
  const id = parts[parts.length - 1];
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc.fields || {})) {
    data[k] = decodeFirestoreValue(v);
  }
  return { id, data };
}

function firestoreBaseUrl(creds: ServiceAccountCreds): string {
  const projectId = creds.project_id || firebaseConfig.projectId;
  const databaseId = firebaseConfig.firestoreDatabaseId || '(default)';
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${databaseId}/documents`;
}

export interface EdgeCloudWrite {
  collection: string;
  id: string;
  data: Record<string, unknown>;
  mustNotExist?: boolean;
}

export async function listCloudCollection(
  env: EdgeCloudEnv,
  collectionName: string,
): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
  const creds = parseServiceAccount(env);
  if (creds) {
    const token = await getGoogleAccessToken(creds);
    const base = firestoreBaseUrl(creds);
    const results: Array<{ id: string; data: Record<string, unknown> }> = [];
    let pageToken = '';
    for (let page = 0; page < 10; page++) {
      const qs = new URLSearchParams({ pageSize: '500' });
      if (pageToken) qs.set('pageToken', pageToken);
      const res = await fetch(`${base}/${encodeURIComponent(collectionName)}?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        if (res.status === 404) return [];
        throw new Error(`Firestore list ${collectionName} failed (${res.status})`);
      }
      const json = (await res.json()) as {
        documents?: Array<{ name?: string; fields?: Record<string, Record<string, unknown>> }>;
        nextPageToken?: string;
      };
      for (const d of json.documents || []) {
        const decoded = decodeDoc(d);
        if (decoded) results.push(decoded);
      }
      if (!json.nextPageToken) break;
      pageToken = json.nextPageToken;
    }
    return results;
  }

  if (env.WALLET_KV) {
    try {
      const idxRaw = await env.WALLET_KV.get(`col_idx:${collectionName}`);
      const ids: string[] = idxRaw ? (JSON.parse(idxRaw) as string[]) : [];
      if (!Array.isArray(ids) || ids.length === 0) return [];
      const docs = await Promise.all(
        ids.map(async (id) => {
          const raw = await env.WALLET_KV!.get(`doc:${collectionName}:${id}`);
          if (!raw) return null;
          return { id, data: JSON.parse(raw) as Record<string, unknown> };
        }),
      );
      return docs.filter((d): d is { id: string; data: Record<string, unknown> } => d !== null);
    } catch {
      return [];
    }
  }

  return [];
}

export async function getCloudDoc(
  env: EdgeCloudEnv,
  collectionName: string,
  docId: string,
): Promise<Record<string, unknown> | null> {
  const creds = parseServiceAccount(env);
  if (creds) {
    const token = await getGoogleAccessToken(creds);
    const base = firestoreBaseUrl(creds);
    const res = await fetch(`${base}/${encodeURIComponent(collectionName)}/${encodeURIComponent(docId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Firestore get ${collectionName}/${docId} failed (${res.status})`);
    const decoded = decodeDoc(
      (await res.json()) as { name?: string; fields?: Record<string, Record<string, unknown>> },
    );
    return decoded?.data || null;
  }

  if (env.WALLET_KV) {
    const raw = await env.WALLET_KV.get(`doc:${collectionName}:${docId}`);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  }

  return null;
}

/**
 * Atomically commit one or more writes to Cloud Firestore (or WALLET_KV fallback).
 * If any write has `mustNotExist: true` and already exists in the cloud DB, returns `{ ok: false, conflict: true }`.
 */
export async function commitCloudWrites(
  env: EdgeCloudEnv,
  writes: EdgeCloudWrite[],
): Promise<{ ok: true } | { ok: false; conflict: boolean; error?: string }> {
  if (writes.length === 0) return { ok: true };

  const creds = parseServiceAccount(env);
  if (creds) {
    const token = await getGoogleAccessToken(creds);
    const projectId = creds.project_id || firebaseConfig.projectId;
    const databaseId = firebaseConfig.firestoreDatabaseId || '(default)';
    const docPrefix = `projects/${projectId}/databases/${databaseId}/documents`;

    const firestoreWrites = writes.map((w) => ({
      update: {
        name: `${docPrefix}/${w.collection}/${w.id}`,
        fields: encodeFields(w.data),
      },
      ...(w.mustNotExist ? { currentDocument: { exists: false } } : {}),
    }));

    const res = await fetch(`https://firestore.googleapis.com/v1/${docPrefix}:commit`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ writes: firestoreWrites }),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      if (res.status === 409 || txt.includes('ALREADY_EXISTS') || txt.includes('FAILED_PRECONDITION')) {
        return { ok: false, conflict: true, error: txt };
      }
      return { ok: false, conflict: false, error: `Firestore commit failed (${res.status}): ${txt}` };
    }
    return { ok: true };
  }

  if (env.WALLET_KV) {
    for (const w of writes) {
      if (w.mustNotExist) {
        const existing = await env.WALLET_KV.get(`doc:${w.collection}:${w.id}`);
        if (existing !== null) {
          return { ok: false, conflict: true };
        }
      }
    }

    const idxUpdates = new Map<string, Set<string>>();
    for (const w of writes) {
      await env.WALLET_KV.put(`doc:${w.collection}:${w.id}`, JSON.stringify(w.data));
      let set = idxUpdates.get(w.collection);
      if (!set) {
        const raw = await env.WALLET_KV.get(`col_idx:${w.collection}`);
        set = new Set(raw ? (JSON.parse(raw) as string[]) : []);
        idxUpdates.set(w.collection, set);
      }
      set.add(w.id);
    }
    for (const [col, set] of idxUpdates.entries()) {
      await env.WALLET_KV.put(`col_idx:${col}`, JSON.stringify([...set]));
    }
    return { ok: true };
  }

  return { ok: true };
}
