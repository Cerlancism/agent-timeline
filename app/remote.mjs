// Server mode: the page is served by server.mjs, which reads the transcripts directory and answers a
// small read-only JSON API under api/ next to the page. This module detects that server and wraps
// its API in the same source interface app.js uses for a mounted directory.

async function getJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body && body.error) msg = body.error;
    } catch {
      /* plain error */
    }
    throw new Error(msg);
  }
  return res.json();
}

const apiUrl = (route, params) => {
  const url = new URL('api/' + route, location.href);
  for (const [k, v] of Object.entries(params || {})) if (v !== '' && v != null) url.searchParams.set(k, v);
  return url;
};

/** The Server-Timing metric server.mjs attaches to the files it serves, naming itself. */
export const SERVER_MARK = 'agent-timeline-server';

/**
 * Who served this page, read from the Server-Timing metrics of its own navigation, which needs no
 * request: 'server' when server.mjs marked it, 'static' when the metrics are readable but unmarked,
 * and null when the browser does not expose them (an insecure origin such as plain HTTP on a LAN
 * address, or an older browser).
 */
export function pageServedBy(perf = globalThis.performance) {
  const nav = perf && perf.getEntriesByType ? perf.getEntriesByType('navigation')[0] : null;
  const timing = nav && nav.serverTiming;
  if (!Array.isArray(timing)) return null;
  return timing.some((t) => t.name === SERVER_MARK) ? 'server' : 'static';
}

/**
 * Return a source backed by the server, or null when the page is not served by server.mjs. A page
 * known to be statically hosted makes no request; otherwise api/source is probed, which plain
 * static hosting answers with an error or with a non-JSON document.
 */
export async function connectServer() {
  if (pageServedBy() === 'static') return null;
  let info;
  try {
    const res = await fetch(apiUrl('source'), { cache: 'no-store' });
    if (!res.ok || !(res.headers.get('content-type') || '').includes('application/json')) return null;
    info = await res.json();
    if (!info || info.mode !== 'server') return null;
  } catch {
    return null;
  }
  const source = {
    kind: 'server',
    root: (info.roots || []).join(', '),
    count: info.sessions,
    async list(opts) {
      const page = await getJson(apiUrl('sessions', opts));
      source.count = page.total;
      return page;
    },
    async load(id) {
      return getJson(apiUrl(`session/${encodeURIComponent(id)}`));
    },
    async changed(loaded) {
      return (await getJson(apiUrl(`session/${encodeURIComponent(loaded.id)}/changed`))).changed;
    },
    async stat(id) {
      return getJson(apiUrl(`session/${encodeURIComponent(id)}/stat`));
    },
    async rescan() {
      const page = await getJson(apiUrl('sessions', { rescan: '1', limit: 1 }));
      source.count = page.total;
    },
  };
  return source;
}
