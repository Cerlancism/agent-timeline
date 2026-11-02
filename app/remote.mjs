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

/**
 * Return a source backed by the server, or null when the page is not served by server.mjs
 * (plain static hosting answers api/source with an error or with a non-JSON document).
 */
export async function connectServer() {
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
    name: info.name,
    root: info.root,
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
