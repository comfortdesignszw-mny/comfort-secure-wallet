import { CloudflareEnv, handleEdgeApiRequest } from '../../src/edge/wallet-edge-app.ts';

interface CloudflarePagesContext {
  request: Request;
  env: CloudflareEnv;
}

function shouldProxyToExternalOrigin(apiOriginRaw: string | undefined, incomingUrl: URL): string | null {
  const trimmed = (apiOriginRaw || '').trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    // Guard against self-looping onto the same Cloudflare Pages host (which triggers HTTP 405 on static origin)
    if (parsed.host.toLowerCase() === incomingUrl.host.toLowerCase()) {
      return null;
    }
    return trimmed;
  } catch {
    return null;
  }
}

export async function onRequest(context: CloudflarePagesContext): Promise<Response> {
  const { request, env } = context;
  const incomingUrl = new URL(request.url);
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

    try {
      const upstream = await fetch(targetUrl, init);
      // If upstream mistakenly points at static hosting returning 405, handle natively in Cloudflare Edge
      if (upstream.status !== 405) {
        return upstream;
      }
    } catch {
      // Fall through to native Cloudflare Edge handler if upstream is unreachable
    }
  }

  return handleEdgeApiRequest(request, env);
}
