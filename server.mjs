#!/usr/bin/env node
// Agent Timeline server mode: a dependency-free Node server that serves the viewer and reads the
// transcripts directory on its behalf, for browsers without the File System Access API and for
// watching sessions from another machine or environment (for example transcripts inside WSL
// viewed from a Windows browser). Everything is read-only; nothing is written to the directory.
//
//   node server.mjs [--root <directory>] [--port 8765] [--host 127.0.0.1]
//
// The root defaults to ~/.claude/projects. The host defaults to loopback; binding another
// address exposes every transcript under the root to that network without authentication.

import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { scanDirectory, listSessions, loadSession, sessionChanged } from './app/localfs.mjs';

const APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'app');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_NAME_RE = /^[^/\\]+$/;

// ---- Command line ----------------------------------------------------------

function parseArgs(argv) {
  const opts = { root: '', port: 8765, host: '127.0.0.1' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--root' || a === '-r') opts.root = next();
    else if (a.startsWith('--root=')) opts.root = a.slice(7);
    else if (a === '--port' || a === '-p') opts.port = parseInt(next(), 10);
    else if (a.startsWith('--port=')) opts.port = parseInt(a.slice(7), 10);
    else if (a === '--host' || a === '-H') opts.host = next();
    else if (a.startsWith('--host=')) opts.host = a.slice(7);
    else if (a === '--help' || a === '-h') {
      console.log('usage: node server.mjs [--root <directory>] [--port 8765] [--host 127.0.0.1]');
      process.exit(0);
    } else {
      console.error(`unknown option: ${a}`);
      process.exit(2);
    }
  }
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
    console.error('invalid port');
    process.exit(2);
  }
  return opts;
}

async function defaultRoot() {
  const projects = path.join(homedir(), '.claude', 'projects');
  try {
    if ((await fs.stat(projects)).isDirectory()) return projects;
  } catch {
    /* fall through */
  }
  return path.join(homedir(), '.claude');
}

// ---- Filesystem handles -----------------------------------------------------
// Minimal stand-ins for the browser's directory and file handles, so the scanner and loader in
// app/localfs.mjs run unchanged on top of node:fs.

class FileHandle {
  constructor(p) {
    this.kind = 'file';
    this.path = p;
    this.name = path.basename(p);
  }
  async getFile() {
    const st = await fs.stat(this.path);
    const p = this.path;
    return { size: st.size, lastModified: Math.round(st.mtimeMs), text: () => fs.readFile(p, 'utf8'),
      slice: (start, end) => ({ text: async () => {
        const file = await fs.open(p, 'r');
        try {
          const buffer = Buffer.alloc(Math.min(end - start, Math.max(0, st.size - start)));
          const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
          return buffer.toString('utf8', 0, bytesRead);
        } finally { await file.close(); }
      } }),
    };
  }
}

class DirectoryHandle {
  constructor(p) {
    this.kind = 'directory';
    this.path = p;
    this.name = path.basename(p) || p;
  }
  async *entries() {
    for (const d of await fs.readdir(this.path, { withFileTypes: true })) {
      const p = path.join(this.path, d.name);
      if (d.isDirectory()) yield [d.name, new DirectoryHandle(p)];
      else if (d.isFile()) yield [d.name, new FileHandle(p)];
    }
  }
  async getDirectoryHandle(name) {
    if (!SAFE_NAME_RE.test(name) || name === '.' || name === '..') throw new Error('NotFoundError');
    const p = path.join(this.path, name);
    if (!(await fs.stat(p)).isDirectory()) throw new Error('NotFoundError');
    return new DirectoryHandle(p);
  }
}

// ---- Source state ----------------------------------------------------------

const source = { root: null, dir: null, scan: null, scanning: null, loaded: new Map() };

async function rescan() {
  if (!source.scanning) {
    source.scanning = scanDirectory(source.dir).then((scan) => {
      source.scan = scan;
      return scan;
    }).finally(() => {
      source.scanning = null;
    });
  }
  return source.scanning;
}

async function ensureScan() {
  return source.scan || rescan();
}

/** The loaded structure without handles, as the browser expects it from the API. */
function wire(loaded) {
  return {
    id: loaded.id,
    harness: loaded.harness,
    project: loaded.project,
    meta: loaded.meta,
    records: loaded.records,
    agents: loaded.agents,
    files: loaded.files.map((f) => ({ name: f.name, size: f.size, mtime: f.mtime })),
  };
}

// ---- HTTP ------------------------------------------------------------------

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

function json(res, status, value) {
  send(res, status, JSON.stringify(value));
}

async function serveStatic(res, rel) {
  const file = path.normalize(path.join(APP_DIR, rel || 'index.html'));
  if (!file.startsWith(APP_DIR + path.sep) && file !== APP_DIR) return send(res, 404, 'not found', 'text/plain');
  try {
    const data = await fs.readFile(file);
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
    res.end(data);
  } catch {
    send(res, 404, 'not found', 'text/plain');
  }
}

async function api(req, res, route, url) {
  const parts = route.split('/').filter(Boolean);
  if (parts[0] === 'source' && parts.length === 1) {
    const scan = await ensureScan();
    return json(res, 200, { mode: 'server', name: source.dir.name, root: source.root, sessions: scan.sessions.length });
  }
  if (parts[0] === 'sessions' && parts.length === 1) {
    if (url.searchParams.get('rescan') === '1') await rescan();
    const scan = await ensureScan();
    const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
    const limit = Math.max(1, Math.min(200, parseInt(url.searchParams.get('limit') || '20', 10) || 20));
    const filter = url.searchParams.get('filter') || '';
    const page = await listSessions(scan, { offset, limit, filter });
    return json(res, 200, { ...page, total: scan.sessions.length });
  }
  if (parts[0] === 'session' && parts.length >= 2) {
    const id = parts[1];
    if (!SESSION_ID_RE.test(id)) return json(res, 400, { error: 'invalid session id' });
    const scan = await ensureScan();
    if (parts.length === 2) {
      const loaded = await loadSession(scan, id);
      source.loaded.set(id, loaded);
      return json(res, 200, wire(loaded));
    }
    if (parts[2] === 'stat' && parts.length === 3) {
      const session = scan.sessions.find((s) => s.id === id);
      if (!session) return json(res, 404, { error: 'session not found' });
      const f = await session.file.getFile();
      return json(res, 200, { mtime: f.lastModified, size: f.size });
    }
    if (parts[2] === 'changed' && parts.length === 3) {
      // Compared against the copy this server last sent; after a restart everything counts as changed.
      const loaded = source.loaded.get(id);
      const changed = loaded ? await sessionChanged(scan, loaded) : true;
      return json(res, 200, { changed });
    }
  }
  return json(res, 404, { error: 'not found' });
}

async function handle(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed', 'text/plain');
  const url = new URL(req.url, 'http://localhost');
  let p = decodeURIComponent(url.pathname);
  if (p === '/' || p === '/app') {
    res.writeHead(302, { location: '/app/' + url.search });
    return res.end();
  }
  // The viewer lives under /app/ and reaches the API relative to its own URL.
  if (p.startsWith('/app/')) p = p.slice(4);
  if (p.startsWith('/api/')) {
    try {
      return await api(req, res, p.slice(4), url);
    } catch (e) {
      return json(res, 500, { error: String(e && e.message ? e.message : e) });
    }
  }
  return serveStatic(res, p.replace(/^\/+/, ''));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  source.root = path.resolve(opts.root || (await defaultRoot()));
  try {
    if (!(await fs.stat(source.root)).isDirectory()) throw new Error('not a directory');
  } catch (e) {
    console.error(`cannot read transcripts directory ${source.root}: ${e.message}`);
    process.exit(1);
  }
  source.dir = new DirectoryHandle(source.root);
  const scan = await rescan();
  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      try {
        send(res, 500, String(e), 'text/plain');
      } catch {
        /* response already ended */
      }
    });
  });
  server.listen(opts.port, opts.host, () => {
    const shown = opts.host.includes(':') ? `[${opts.host}]` : opts.host;
    console.log(`Agent Timeline: ${scan.sessions.length} sessions under ${source.root}`);
    console.log(`Open http://${shown}:${server.address().port}/app/`);
    if (opts.host !== '127.0.0.1' && opts.host !== 'localhost' && opts.host !== '::1') {
      console.log('Warning: this address is reachable by other machines; the transcripts are served without authentication.');
    }
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
