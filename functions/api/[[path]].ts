interface CloudflareEnv {
  API_ORIGIN?: string;
  WALLET_JWT_SECRET?: string;
  WALLET_REFRESH_SECRET?: string;
  WALLET_PIN_PEPPER?: string;
  WALLET_FIELD_ENCRYPTION_KEY?: string;
  WALLET_SIGNED_URL_SECRET?: string;
  SUPER_ADMIN_EMAIL?: string;
}

interface CloudflarePagesContext {
  request: Request;
  env: CloudflareEnv;
}

export async function onRequest(context: CloudflarePagesContext): Promise<Response> {
  const { request, env } = context;
  const apiOrigin = (env.API_ORIGIN || '').trim().replace(/\/+$/, '');

  if (!apiOrigin) {
    return new Response(
      JSON.stringify({
        error: {
          code: 'API_ORIGIN_UNCONFIGURED',
          message:
            'Configure API_ORIGIN and wallet secrets (WALLET_JWT_SECRET, WALLET_REFRESH_SECRET, WALLET_PIN_PEPPER) in Cloudflare Pages Environment Variables.',
        },
      }),
      {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  const incomingUrl = new URL(request.url);
  const targetUrl = `${apiOrigin}${incomingUrl.pathname}${incomingUrl.search}`;

  const headers = new Headers(request.headers);
  headers.set('X-Forwarded-Host', incomingUrl.host);
  headers.set('X-Forwarded-Proto', incomingUrl.protocol.replace(':', ''));

  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: 'manual',
  };

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
  }

  return fetch(targetUrl, init);
}
