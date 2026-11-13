/* © 2026 pemdem. All rights reserved.
   Forum reader for the app: browsers can't read forum.nationstates.net from another site,
   so the app asks this same-site endpoint, which fetches the public page for it.
   Only nationstates.net pages, only for requests coming from the app itself. */
export async function onRequestGet({ request }) {
  const site = request.headers.get('Sec-Fetch-Site');
  if (site && site !== 'same-origin') return new Response('forbidden', { status: 403 });
  const u = new URL(request.url).searchParams.get('url');
  if (!u) return new Response('missing url', { status: 400 });
  let target;
  try { target = new URL(u); } catch (e) { return new Response('bad url', { status: 400 }); }
  if (target.protocol !== 'https:' || !/(^|\.)nationstates\.net$/.test(target.hostname)) {
    return new Response('forbidden', { status: 403 });
  }
  const r = await fetch(target.toString(), {
    headers: { 'User-Agent': 'NS Advisor forum reader (ns-advisor.pages.dev)' },
    cf: { cacheTtl: 60, cacheEverything: true }
  });
  return new Response(r.body, {
    status: r.status,
    headers: { 'Content-Type': r.headers.get('Content-Type') || 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
