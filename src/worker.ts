import { CloudflareEnv, handleEdgeApiRequest } from './edge/wallet-edge-app.ts';

interface AssetFetcher {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

export interface WorkerEnv extends CloudflareEnv {
  ASSETS?: AssetFetcher;
}

function shouldProxyToExternalOrigin(apiOriginRaw: string | undefined, incomingUrl: URL): string | null {
  const trimmed = (apiOriginRaw || '').trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    // Guard against self-looping onto the same Cloudflare host (which triggers HTTP 405 on static origin)
    if (parsed.host.toLowerCase() === incomingUrl.host.toLowerCase()) {
      return null;
    }
    return trimmed;
  } catch {
    return null;
  }
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const incomingUrl = new URL(request.url);

    if (incomingUrl.pathname === '/api' || incomingUrl.pathname.startsWith('/api/')) {
      const externalOrigin = shouldProxyToExternalOrigin(env.API_ORIGIN, incomingUrl);
      if (externalOrigin) {
        const targetUrl = `${externalOrigin}${incomingUrl.pathname}${incomingUrl.search}`;
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

        const upstream = await fetch(targetUrl, init);
        if (upstream.status !== 405) {
          return upstream;
        }
      }

      return handleEdgeApiRequest(request, env);
    }

    if (env.ASSETS) {
      const assetRes = await env.ASSETS.fetch(request);
      const contentType = assetRes.headers.get('content-type') || '';
      if (contentType.includes('text/html')) {
        const headers = new Headers(assetRes.headers);
        headers.set('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
        return new Response(assetRes.body, {
          status: assetRes.status,
          statusText: assetRes.statusText,
          headers,
        });
      }
      return assetRes;
    }

    return new Response('Not found', { status: 404 });
  },
};
