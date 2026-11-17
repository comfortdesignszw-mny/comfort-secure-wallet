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

  it('persists Add Money requests immediately to Back-Office queue, enforces Idempotency-Key + Maker-Checker + expectedStatus, and reports /sync snapshots', async () => {
    const kvStore = new Map<string, string>();
    const kvEnv = {
      ...env,
      WALLET_KV: {
        async get(key: string) {
          return kvStore.get(key) ?? null;
        },
        async put(key: string, value: string) {
          kvStore.set(key, value);
        },
      },
    };

    const reqJson = async (
      path: string,
      opts: { method?: string; token?: string; stepUp?: string; idemKey?: string; body?: unknown } = {},
    ) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
      if (opts.stepUp) headers['X-Step-Up-Token'] = opts.stepUp;
      if (opts.idemKey) headers['Idempotency-Key'] = opts.idemKey;
      return worker.fetch(
        new Request(`https://comfort-secure-wallet.workers.dev/api/v1${path}`, {
          method: opts.method || 'GET',
          headers,
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        }),
        kvEnv,
      );
    };

    const getStepUp = async (token: string, pin: string, adminAction: string) => {
      const r = await reqJson('/pin/verify', {
        method: 'POST',
        token,
        body: { pin, scope: 'admin_action', adminAction },
      });
      expect(r.status).toBe(200);
      const j = (await r.json()) as { stepUpToken: string };
      return j.stepUpToken;
    };

    // 1. Register / authenticate Super Admin and set PIN
    const saReg = await reqJson('/auth/staff/register', {
      method: 'POST',
      body: {
        email: 'comfort.designszw@gmail.com',
        password: 'StrongSuperPassword!2026',
        fullName: 'Comfort Super',
        requestedRole: Role.SUPER_ADMIN,
        legalAccepted: true,
      },
    });
    const saRegData = (await saReg.json()) as { accessToken?: string };
    let saToken = saRegData.accessToken;
    if (!saToken) {
      const saLogin = await reqJson('/auth/login', {
        method: 'POST',
        body: { email: 'comfort.designszw@gmail.com', password: 'StrongSuperPassword!2026' },
      });
      saToken = ((await saLogin.json()) as { accessToken: string }).accessToken;
    }
    await reqJson('/pin/set', { method: 'POST', token: saToken, body: { pin: '491725', confirmPin: '491725' } });

    // 2. Register second staff (Finance Checker) and approve them
    const checkerReg = await reqJson('/auth/staff/register', {
      method: 'POST',
      body: {
        email: 'checker.edge@wallet.zw',
        password: 'StrongCheckerPassword!2026',
        fullName: 'Edge Checker',
        requestedRole: Role.FINANCE_CHECKER,
        legalAccepted: true,
      },
    });
    expect(checkerReg.status).toBe(201);
    const checkerRegJson = (await checkerReg.json()) as { accessToken: string; user: { id: string } };
    const checkerToken = checkerRegJson.accessToken;
    await reqJson('/pin/set', { method: 'POST', token: checkerToken, body: { pin: '739152', confirmPin: '739152' } });

    const saApproveStep = await getStepUp(saToken!, '491725', 'staff_approve');
    const approveStaffRes = await reqJson(`/admin/staff/${checkerRegJson.user.id}/approve`, {
      method: 'POST',
      token: saToken,
      stepUp: saApproveStep,
      body: { decision: 'APPROVED', assignedRole: Role.FINANCE_CHECKER },
    });
    expect(approveStaffRes.status).toBe(200);

    // 3. Register customer, submit KYC, and approve KYC to create USD wallet
    const custReg = await reqJson('/auth/register', {
      method: 'POST',
      body: {
        email: 'addmoney.edge@wallet.zw',
        password: 'StrongCustomerPass!2026',
        fullName: 'Nyasha Banda',
        legalAccepted: true,
      },
    });
    expect(custReg.status).toBe(201);
    const custJson = (await custReg.json()) as { accessToken: string; user: { id: string } };
    const custToken = custJson.accessToken;

    const kycRes = await reqJson('/kyc/documents', {
      method: 'POST',
      token: custToken,
      body: {
        fullName: 'Nyasha Banda',
        dateOfBirth: '1994-06-15',
        nationalIdNumber: '63-1122334-A-12',
        address: '12 Samora Machel Ave, Harare',
        country: 'ZW',
        documentType: 'NATIONAL_ID',
        idDocumentDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ',
        selfieDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ',
      },
    });
    expect(kycRes.status).toBe(201);

    const kycStep = await getStepUp(saToken!, '491725', 'kyc_decide');
    const kycDec = await reqJson(`/admin/kyc/${custJson.user.id}/decision`, {
      method: 'POST',
      token: saToken,
      stepUp: kycStep,
      body: { decision: 'APPROVED' },
    });
    expect(kycDec.status).toBe(200);
    const kycDecJson = (await kycDec.json()) as { accounts: Array<{ id: string; currency: string }> };
    const usdAccount = kycDecJson.accounts.find((a) => a.currency === 'USD')!;
    expect(usdAccount).toBeTruthy();

    // 4. Customer submits Add Money request with Idempotency-Key
    const depPayload = {
      accountId: usdAccount.id,
      amountMinor: 15000,
      currency: 'USD',
      method: 'ECOCASH',
      paymentReference: 'ECO-EDGE-9901',
      proofDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ',
    };
    const depRes1 = await reqJson('/deposits/requests', {
      method: 'POST',
      token: custToken,
      idemKey: 'idem_edge_dep_1',
      body: depPayload,
    });
    expect(depRes1.status).toBe(201);
    const dep1 = ((await depRes1.json()) as { deposit: { id: string; version: number; status: string } }).deposit;
    expect(dep1.id).toMatch(/^dep_/);
    expect(dep1.version).toBe(1);

    // Exact replay returns same deposit without duplicating
    const depReplay = await reqJson('/deposits/requests', {
      method: 'POST',
      token: custToken,
      idemKey: 'idem_edge_dep_1',
      body: depPayload,
    });
    expect(depReplay.status).toBe(201);
    const depReplayJson = (await depReplay.json()) as { deposit: { id: string } };
    expect(depReplayJson.deposit.id).toBe(dep1.id);

    // Same Idempotency-Key with modified amount returns 409 IDEMPOTENCY_CONFLICT
    const depConflict = await reqJson('/deposits/requests', {
      method: 'POST',
      token: custToken,
      idemKey: 'idem_edge_dep_1',
      body: { ...depPayload, amountMinor: 25000 },
    });
    expect(depConflict.status).toBe(409);

    // Duplicate paymentReference with a new Idempotency-Key returns 409 DUPLICATE_REFERENCE
    const depDupRef = await reqJson('/deposits/requests', {
      method: 'POST',
      token: custToken,
      idemKey: 'idem_edge_dep_2',
      body: depPayload,
    });
    expect(depDupRef.status).toBe(409);

    // 5. Immediately visible in Back-Office /admin/deposits and /sync counts
    const adminDepsRes = await reqJson('/admin/deposits', { token: saToken });
    expect(adminDepsRes.status).toBe(200);
    const adminDeps = ((await adminDepsRes.json()) as { deposits: Array<{ id: string; status: string }> }).deposits;
    expect(adminDeps.some((d) => d.id === dep1.id && d.status === 'PENDING')).toBe(true);

    const syncRes = await reqJson('/sync', { method: 'POST', token: saToken });
    expect(syncRes.status).toBe(200);
    const syncJson = (await syncRes.json()) as {
      cloudBackend: string;
      ledgerBalanced: boolean;
      counts?: { pendingDeposits: number };
    };
    expect(syncJson.cloudBackend).toBe('kv');
    expect(syncJson.ledgerBalanced).toBe(true);
    expect(syncJson.counts?.pendingDeposits).toBeGreaterThanOrEqual(1);

    // 6. Maker Approve -> Stale Conflict Check -> Maker != Checker Violation -> Checker Post
    const makerStep = await getStepUp(saToken!, '491725', 'deposit_approve');
    const makerRes = await reqJson(`/admin/deposits/${dep1.id}/approve`, {
      method: 'POST',
      token: saToken,
      stepUp: makerStep,
      idemKey: 'idem_maker_1',
      body: { expectedStatus: 'PENDING' },
    });
    expect(makerRes.status).toBe(200);
    const makerDep = ((await makerRes.json()) as { deposit: { status: string; version: number } }).deposit;
    expect(makerDep.status).toBe('MAKER_APPROVED');
    expect(makerDep.version).toBe(2);

    // Second stale click expecting PENDING must fail with 409 STATE_CONFLICT
    const staleMakerRes = await reqJson(`/admin/deposits/${dep1.id}/approve`, {
      method: 'POST',
      token: saToken,
      stepUp: await getStepUp(saToken!, '491725', 'deposit_approve'),
      idemKey: 'idem_maker_stale',
      body: { expectedStatus: 'PENDING' },
    });
    expect(staleMakerRes.status).toBe(409);

    // Same Maker cannot also act as Checker
    const sameCheckerRes = await reqJson(`/admin/deposits/${dep1.id}/approve`, {
      method: 'POST',
      token: saToken,
      stepUp: await getStepUp(saToken!, '491725', 'deposit_approve'),
      idemKey: 'idem_same_checker',
      body: { expectedStatus: 'MAKER_APPROVED' },
    });
    expect(sameCheckerRes.status).toBe(403);

    // Different staff (FINANCE_CHECKER) approves and posts double-entry ledger transaction
    const checkerStep = await getStepUp(checkerToken, '739152', 'deposit_approve');
    const checkerRes = await reqJson(`/admin/deposits/${dep1.id}/approve`, {
      method: 'POST',
      token: checkerToken,
      stepUp: checkerStep,
      idemKey: 'idem_checker_1',
      body: { expectedStatus: 'MAKER_APPROVED' },
    });
    expect(checkerRes.status).toBe(200);
    const finalDep = ((await checkerRes.json()) as { deposit: { status: string; version: number } }).deposit;
    expect(finalDep.status).toBe('APPROVED');
    expect(finalDep.version).toBe(3);

    // Ledger remains balanced in /sync
    const postSync = await reqJson('/sync', { method: 'GET', token: saToken });
    const postSyncJson = (await postSync.json()) as { ledgerBalanced: boolean };
    expect(postSyncJson.ledgerBalanced).toBe(true);
  });
});

