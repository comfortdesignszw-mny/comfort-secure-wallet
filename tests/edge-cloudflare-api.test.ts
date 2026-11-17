import { describe, expect, it } from 'vitest';
import { onRequest } from '../functions/api/[[path]].ts';
import worker from '../src/worker.ts';
import { Role } from '../src/shared/types.ts';

function extractCookieHeader(res: Response, existingCookieHeader = ''): string {
  const map = new Map<string, string>();
  for (const part of existingCookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) map.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim());
  }
  const setCookies = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() || [];
  if (setCookies.length === 0) {
    const single = res.headers.get('set-cookie');
    if (single) setCookies.push(single);
  }
  for (const raw of setCookies) {
    const first = raw.split(';')[0];
    const idx = first.indexOf('=');
    if (idx > 0) {
      map.set(first.slice(0, idx).trim(), first.slice(idx + 1).trim());
    }
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

describe('Cloudflare Pages & Workers Edge API', () => {
  const env = {
    WALLET_JWT_SECRET: 'test-jwt-secret-123',
    WALLET_REFRESH_SECRET: 'test-refresh-secret-456',
    WALLET_PIN_PEPPER: 'test-pin-pepper-789',
    // Simulate a misconfigured self-loop API_ORIGIN pointing back to the Cloudflare host
    API_ORIGIN: 'https://comfort-secure-wallet.pages.dev',
  };

  it('registers user, sets PIN, persists via encrypted vault cookie, and signs in with 6-digit PIN without 405 (Pages Function)', async () => {
    const regReq = new Request('https://comfort-secure-wallet.pages.dev/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'edge.customer@wallet.zw',
        password: 'StrongEdgePassword!2026',
        fullName: 'Edge Customer',
        legalAccepted: true,
      }),
    });

    const regRes = await onRequest({ request: regReq, env });
    expect(regRes.status).toBe(201);
    const regJson = (await regRes.json()) as {
      accessToken: string;
      otpSent: boolean;
      requiresPinSetup: boolean;
      user: { role: Role };
    };
    expect(regJson.accessToken).toBeTruthy();
    expect(regJson.otpSent).toBe(false);
    expect(regJson.requiresPinSetup).toBe(true);
    expect(regJson.user.role).toBe(Role.USER);

    let cookieHeader = extractCookieHeader(regRes);
    expect(cookieHeader).toContain('csw_vault=');
    expect(cookieHeader).toContain('csw_refresh=');

    const pinSetReq = new Request('https://comfort-secure-wallet.pages.dev/api/v1/pin/set', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${regJson.accessToken}`,
        Cookie: cookieHeader,
      },
      body: JSON.stringify({ pin: '582914', confirmPin: '582914' }),
    });
    const pinSetRes = await onRequest({ request: pinSetReq, env });
    expect(pinSetRes.status).toBe(200);
    cookieHeader = extractCookieHeader(pinSetRes, cookieHeader);

    const pinLoginReq = new Request('https://comfort-secure-wallet.pages.dev/api/v1/auth/pin-login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader,
      },
      body: JSON.stringify({
        email: 'edge.customer@wallet.zw',
        pin: '582914',
      }),
    });
    const pinLoginRes = await onRequest({ request: pinLoginReq, env });
    expect(pinLoginRes.status).toBe(200);
    const pinLoginJson = (await pinLoginRes.json()) as { accessToken: string };
    expect(pinLoginJson.accessToken).toBeTruthy();
  });

  it('routes /api/* via Cloudflare Worker entrypoint (src/worker.ts) without 405 and injects COOP on HTML assets', async () => {
    const workerEnv = {
      ...env,
      API_ORIGIN: 'https://comfort-secure-wallet.workers.dev',
      ASSETS: {
        async fetch() {
          return new Response('<html><body>App</body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          });
        },
      },
    };

    const regReq = new Request('https://comfort-secure-wallet.workers.dev/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'worker.customer@wallet.zw',
        password: 'StrongWorkerPassword!2026',
        fullName: 'Worker Customer',
        legalAccepted: true,
      }),
    });
    const regRes = await worker.fetch(regReq, workerEnv);
    expect(regRes.status).toBe(201);

    const htmlRes = await worker.fetch(new Request('https://comfort-secure-wallet.workers.dev/'), workerEnv);
    expect(htmlRes.status).toBe(200);
    expect(htmlRes.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin-allow-popups');
  });

  it('auto-provisions comfort.designszw@gmail.com as APPROVED SUPER_ADMIN and returns complete AdminConsole schemas', async () => {
    const req = new Request('https://comfort-secure-wallet.pages.dev/api/v1/auth/staff/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'comfort.designszw@gmail.com',
        password: 'StrongSuperPassword!2026',
        fullName: 'Comfort Designs',
        requestedRole: Role.FINANCE_MAKER,
        legalAccepted: true,
      }),
    });
    const res = await onRequest({ request: req, env });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { accessToken: string; user: { role: Role; staffStatus: string } };
    expect(json.user.role).toBe(Role.SUPER_ADMIN);
    expect(json.user.staffStatus).toBe('APPROVED');

    const overviewRes = await worker.fetch(
      new Request('https://comfort-secure-wallet.pages.dev/api/v1/admin/overview', {
        headers: { Authorization: `Bearer ${json.accessToken}` },
      }),
      env,
    );
    expect(overviewRes.status).toBe(200);
    const overview = (await overviewRes.json()) as {
      ledgerInvariant: { valid: boolean };
      balancesByCurrency: { USD: { userLiabilitiesMinor: number } };
    };
    expect(overview.ledgerInvariant.valid).toBe(true);
    expect(typeof overview.balancesByCurrency.USD.userLiabilitiesMinor).toBe('number');

    const staffRes = await worker.fetch(
      new Request('https://comfort-secure-wallet.pages.dev/api/v1/admin/staff', {
        headers: { Authorization: `Bearer ${json.accessToken}` },
      }),
      env,
    );
    expect(staffRes.status).toBe(200);
    const staffJson = (await staffRes.json()) as { staff: Array<{ role: Role }>; approvals: unknown[] };
    expect(Array.isArray(staffJson.approvals)).toBe(true);
    expect(staffJson.staff.some((s) => s.role === Role.SUPER_ADMIN)).toBe(true);
  });
});
