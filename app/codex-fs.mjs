// Codex rollout directories: discovery under a Codex home by rollout metadata, loading a root thread
// with its descendants, live checks for new descendants, and opening chosen files.
// Implements the directory interface described in localfs.mjs. Read-only.

import { NAME, codexMetadata } from './codex.mjs';
import { parseLines } from './transcripts.mjs';
import { entries, fileInfo } from './handles.mjs';

export const HARNESS = NAME;

/** Where Codex keeps rollouts, for the directory dialog. A custom CODEX_HOME must be supplied by the reader. */
export const DIRECTORY_HINT = { windows: '%USERPROFILE%\\.codex', posix: '~/.codex' };

const STORES = ['sessions', 'archived_sessions'];
const HOME_NAMES = [...STORES, '.codex'];
const DATED_DIR_RE = /^\d{2,4}$/;

const metaCache = new WeakMap();
const scanCaches = new WeakMap();

async function readMeta(handle, cache = metaCache, cacheKey = handle) {
  const f = await handle.getFile();
  const key = `${f.size}:${f.lastModified}`;
  const cached = cache.get(cacheKey);
  if (cached?.key === key) return cached.meta;
  // Only inspect transcript headers during discovery, never Codex configuration/auth files.
  const text = f.slice ? await f.slice(0, 262144).text() : (await f.text()).slice(0, 262144);
  const rows = [];
  for (const line of text.split('\n').slice(0, 30)) {
    try { rows.push(JSON.parse(line.replace(/^﻿/, ''))); } catch { /* partial header */ }
  }
  const meta = codexMetadata(rows);
  cache.set(cacheKey, { key, meta });
  return meta;
}

/**
 * Scan a Codex home, store, or dated subtree, or return null when the directory does not look like one:
 *   sessions: root threads [{ id, harness, project, file, dir, meta }]
 *   threads: Map id -> every discovered thread, children included
 */
async function scanHome(root) {
  if (!scanCaches.has(root)) scanCaches.set(root, new Map());
  const cache = scanCaches.get(root);
  const top = await entries(root);
  const stores = top.filter(([name, h]) => h.kind === 'directory' && STORES.includes(name));
  const likely = stores.length || HOME_NAMES.includes(root.name) ||
    top.some(([name, h]) => (h.kind === 'file' && name.endsWith('.jsonl')) || (h.kind === 'directory' && DATED_DIR_RE.test(name)));
  if (!likely) return null;
  const threads = new Map();
  const visit = async (dir, prefix = '') => {
    for (const [name, h] of await entries(dir)) {
      const key = prefix + '/' + name;
      if (h.kind === 'directory' && DATED_DIR_RE.test(name)) await visit(h, key);
      else if (h.kind === 'file' && name.endsWith('.jsonl')) {
        try {
          const meta = await readMeta(h, cache, key);
          if (meta && !threads.has(meta.id)) threads.set(meta.id, { id: meta.id, harness: NAME, project: meta.cwd, file: h, dir, meta });
        } catch { /* unreadable transcript */ }
      }
    }
  };
  if (stores.length) for (const [name, h] of stores) await visit(h, name);
  else await visit(root);
  if (!threads.size && !stores.length && !HOME_NAMES.includes(root.name)) return null;
  const sessions = [...threads.values()].filter((s) => !s.meta.parentAgentId || !threads.has(s.meta.parentAgentId));
  return { harness: NAME, sessions, threads, root };
}

export { scanHome as scan };

/** Descendants of a thread, breadth first, from discovered metadata. */
function family(scan, id) {
  const out = [];
  const seen = new Set([id]);
  const queue = [id];
  while (queue.length) {
    const parent = queue.shift();
    for (const s of scan.threads.values()) {
      if (s.meta.parentAgentId !== parent || seen.has(s.id)) continue;
      seen.add(s.id);
      out.push(s);
      queue.push(s.id);
    }
  }
  return out;
}

/** Descendant threads known for a session without reading any file, for its summary. */
export function agentCount(scan, session) {
  return family(scan, session.id).length;
}

/** Load a root thread and every discovered descendant, refreshing discovery first. */
export async function load(scan, id) {
  const fresh = await scanHome(scan.root);
  if (fresh) Object.assign(scan, fresh);
  const main = scan.threads.get(id);
  if (!main) throw new Error('Session not found: ' + id);
  const files = [];
  const read = async (s) => {
    const info = await fileInfo(s.file);
    files.push({ name: s.file.name, handle: s.file, size: info.size, mtime: info.mtime });
    return { id: s.id, records: parseLines(await info.file.text()), meta: s.meta };
  };
  const loaded = await read(main);
  const agents = [];
  for (const s of family(scan, id)) agents.push(await read(s));
  return { ...loaded, harness: NAME, project: main.project, agents, files };
}

/** Live check beyond known files: rescan metadata for descendants created since loading. */
export async function hasNewAgents(scan, loaded) {
  const fresh = await scanHome(scan.root);
  if (!fresh) return false;
  const before = loaded.agents.map((a) => a.id).sort().join(',');
  const after = family(fresh, loaded.id).map((a) => a.id).sort().join(',');
  Object.assign(scan, fresh);
  return before !== after;
}

/**
 * Build a loaded session from chosen File objects, identified by rollout metadata rather than
 * filename; null when none is a Codex rollout. The rollouts must be one root and its descendants.
 */
export async function loadFiles(files) {
  const threads = [];
  for (const f of files) {
    if (!f.name.endsWith('.jsonl')) continue;
    const meta = await readMeta({ getFile: async () => f });
    if (meta) threads.push({ id: meta.id, meta, records: parseLines(await f.text()) });
  }
  if (!threads.length) return null;
  const ids = new Set(threads.map((a) => a.id));
  const roots = threads.filter((a) => !ids.has(a.meta.parentAgentId));
  if (roots.length !== 1 || threads.length !== files.filter((f) => f.name.endsWith('.jsonl')).length) {
    throw new Error('Select one Codex root and its descendants. Use the mounted session list to open unrelated sessions together.');
  }
  const main = roots[0];
  const agents = family({ threads: new Map(threads.map((a) => [a.id, a])) }, main.id);
  if (agents.length !== threads.length - 1) throw new Error('Selected Codex threads do not form one family.');
  return { ...main, harness: NAME, project: main.meta.cwd, agents, files: [], fromFiles: true };
}
