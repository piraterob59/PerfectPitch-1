// Cloudflare Worker: a thin CORS-bypass proxy in front of LALAL.AI's API.
//
// Why this exists: LALAL.AI's API is built for server-side callers
// (Python/Node/curl) — a direct browser fetch() with the required
// X-License-Key header gets rejected at the CORS preflight stage, because
// their Access-Control-Allow-Headers response doesn't allowlist it. That's
// not something client-side code can work around; only a server-to-server
// hop (this Worker) can, since CORS is a browser-only restriction.
//
// This also means the license key now lives here (as a Worker secret,
// never in the deployed app's source) instead of being pasted into the app
// by the end user — a better privacy story than the original
// bring-your-own-key-in-the-browser design, at the cost of one small piece
// of infra beyond GitHub Pages.
//
// Deployment: see worker/README.md. In short — paste this file into a new
// Worker via the Cloudflare dashboard, add a `LALAL_LICENSE_KEY` secret,
// update ALLOWED_ORIGINS below to match where the app is actually hosted.

const ALLOWED_ORIGINS = [
  'https://piraterob59.github.io',
  'http://localhost:8081',
];

const LALAL_BASE = 'https://www.lalal.ai/api/v1/';

// Only these four LALAL.AI endpoints are ever needed — an explicit
// allowlist here is safer than forwarding an arbitrary path straight
// through to LALAL.AI with our license key attached.
const ROUTES = {
  '/proxy/upload': 'upload/',
  '/proxy/split': 'split/stem_separator/',
  '/proxy/check': 'check/',
  '/proxy/delete': 'delete/',
};

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type, Content-Disposition',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: allowed ? 204 : 403, headers: allowed ? corsHeaders(origin) : {} });
    }
    // Rejecting here (not just omitting CORS headers) matters: an
    // unrecognized origin can't even get the Worker to spend the shared
    // license key's quota, not just get blocked from reading the response.
    if (!allowed) {
      return new Response('Forbidden origin', { status: 403 });
    }

    // Download URLs come back from LALAL.AI's /check/ result and may live
    // on a different host than the API itself, with unknown CORS behavior
    // of their own — routing them through here too avoids a second CORS
    // surprise, and keeps every third-party call going through one place.
    if (url.pathname === '/proxy/download') {
      const { url: downloadUrl } = await request.json();
      const upstream = await fetch(downloadUrl);
      const headers = new Headers(upstream.headers);
      Object.entries(corsHeaders(origin)).forEach(([k, v]) => headers.set(k, v));
      return new Response(upstream.body, { status: upstream.status, headers });
    }

    const lalalPath = ROUTES[url.pathname];
    if (!lalalPath) {
      return new Response('Unknown endpoint', { status: 404, headers: corsHeaders(origin) });
    }

    const headers = { 'X-License-Key': env.LALAL_LICENSE_KEY };
    const contentType = request.headers.get('Content-Type');
    if (contentType) headers['Content-Type'] = contentType;
    const contentDisposition = request.headers.get('Content-Disposition');
    if (contentDisposition) headers['Content-Disposition'] = contentDisposition;

    const upstream = await fetch(`${LALAL_BASE}${lalalPath}`, {
      method: 'POST',
      headers,
      body: request.body,
      duplex: 'half',
    });

    const respHeaders = new Headers(upstream.headers);
    Object.entries(corsHeaders(origin)).forEach(([k, v]) => respHeaders.set(k, v));
    return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
  },
};
