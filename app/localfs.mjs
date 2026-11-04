// Reading mounted transcript directories through the File System Access API, independent of harness:
// remembered directories and permissions, combining sources, the session list, and dispatch to each
// harness's directory module. Everything here is read-only; nothing is ever written to the directory.
//
// Each harness directory module (claude-fs.mjs, codex-fs.mjs) exports the same interface:
//   HARNESS                  the harness label, matching NAME in its transcript module
//   DIRECTORY_HINT           { windows, posix } default directory, for the Add directory dialog and
//                            for server mode, which looks for the POSIX path under the home directory
//   scan(root)               a scan { harness, sessions, root, ... } of the picked directory, or null
//                            when it does not look like this harness's layout
//   agentCount(scan, session)
//                            subagents known from discovery alone, for the session list
//   load(scan, id)           { id, harness, project, records, meta?, agents, files }
//   hasNewAgents(scan, loaded)
//                            whether agents appeared since loading, beyond changes to known files
//   loadFiles(files)         a loaded session from chosen File objects, or null when none belong
//                            to this harness

import { summarizeRecords, sniffCwd, matchesFilter, parseLines } from './transcripts.mjs';
import { fileInfo } from './handles.mjs';
import * as claudeDirectories from './claude-fs.mjs';
import * as codexDirectories from './codex-fs.mjs';

/** Harness directory layouts in discovery order. Claude, the original layout, is the fallback. */
const DIRECTORIES = [codexDirectories, claudeDirectories];
const directoriesFor = (harness) => DIRECTORIES.find((f) => f.HARNESS === harness) || claudeDirectories;

const DB_NAME = 'agent-timeline';
const STORE = 'handles';
const KEY = 'transcripts';

export const supportsMount = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGet() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function dbSet(value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    if (value) tx.objectStore(STORE).put(value, KEY);
    else tx.objectStore(STORE).delete(KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** A harness's transcripts path on this platform, for a hint next to the picker. */
export function suggestedPath(harness) {
  const p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  const hint = directoriesFor(harness).DIRECTORY_HINT;
  return /win/i.test(p) ? hint.windows : hint.posix;
}

/**
 * Every harness's default directory as path segments under the home directory, taken from the POSIX
 * form of its hint, for server mode to find transcripts without being told where they are.
 */
export function homeDirectories() {
  return DIRECTORIES.map((d) => ({ harness: d.HARNESS, segments: d.DIRECTORY_HINT.posix.replace(/^~\/?/, '').split('/').filter(Boolean) }));
}

/** Ask the user for the transcripts directory and remember it. */

export async function mountDirectory(startIn = null) {
  // The picker cannot be pointed at a path: `startIn` only takes a well-known directory name or a
  // handle we already hold, and `id` makes the browser reopen at the last directory picked under it.
  // The id predates other harnesses and is kept so browsers still remember that directory.
  const opts = { mode: 'read', id: 'claude-transcripts' };
  if (startIn) opts.startIn = startIn;
  const handle = await window.showDirectoryPicker(opts);
  const handles = await rememberedDirectories();
  let exists = false;
  for (const h of handles) if (await h.isSameEntry(handle)) exists = true;
  if (!exists) await dbSet([...handles, handle]);
  return handle;
}

/** Return remembered handles without checking permission, migrating the old single handle. */
export async function rememberedDirectories() {
  try {
    const value = await dbGet();
    return Array.isArray(value) ? value : value ? [value] : [];
  } catch {
    return [];
  }
}

export async function removeDirectory(handle) {
  const keep = [];
  for (const h of await rememberedDirectories()) if (!(await h.isSameEntry(handle))) keep.push(h);
  await dbSet(keep.length ? keep : null);
}

/** 'granted' | 'prompt' | 'denied' */
export async function permissionState(handle) {
  try {
    return await handle.queryPermission({ mode: 'read' });
  } catch {
    return 'denied';
  }
}

export async function requestPermission(handle) {
  try {
    return (await handle.requestPermission({ mode: 'read' })) === 'granted';
  } catch {
    return false;
  }
}

// ---- Scanning --------------------------------------------------------------

/** Scan the directory with the first harness whose layout it matches; sessions carry their harness. */
export async function scanDirectory(root) {
  for (const directories of DIRECTORIES) {
    const scan = await directories.scan(root);
    if (scan) return scan;
  }
  throw new Error('Unrecognized transcripts directory.'); // unreachable: the Claude layout accepts any directory
}

/** Merge independently mounted sources, retaining each session's discovery scope. */
export function combineScans(scans) {
  const sessions = new Map();
  const sources = new Map();
  for (const scan of scans) for (const session of scan.sessions) {
    if (sessions.has(session.id)) continue;
    sessions.set(session.id, session);
    sources.set(session.id, scan);
  }
  return { mode: 'multiple', sessions: [...sessions.values()], sources };
}

const sourceOf = (scan, id) => (scan.mode === 'multiple' ? scan.sources.get(id) : scan);

// ---- Session list ----------------------------------------------------------

const summaryCache = new WeakMap(); // file handle -> { key, summary }

async function summarize(session, scan) {
  const { file, size, mtime } = await fileInfo(session.file);
  const known = directoriesFor(scan.harness).agentCount(scan, session);
  const key = size + ':' + mtime + ':' + known;
  const cached = summaryCache.get(session.file);
  if (cached && cached.key === key) return cached.summary;
  const text = await file.text();
  const s = summarizeRecords(parseLines(text), session.harness);
  const summary = {
    id: session.id,
    harness: session.harness,
    project: session.project,
    title: s.title,
    firstPrompt: s.firstPrompt,
    prompts: s.prompts,
    subagents: Math.max(s.spawns, s.agentIds.size, known),
    model: s.model,
    effort: s.effort,
    context: s.context,
    cwd: s.cwd || sniffCwd(text.slice(0, 20000)) || session.project,
    size,
    mtime,
  };
  summaryCache.set(session.file, { key, summary });
  return summary;
}

/**
 * List sessions newest first. Reads files lazily: only as many as needed for the page,
 * unless a filter is given, in which case every session is read.
 */
export async function listSessions(scan, { offset = 0, limit = 20, filter = '' } = {}) {
  const withTimes = [];
  for (const s of scan.sessions) {
    try {
      const f = await s.file.getFile();
      withTimes.push({ ...s, mtime: f.lastModified, size: f.size });
    } catch {
      /* skip unreadable */
    }
  }
  withTimes.sort((a, b) => b.mtime - a.mtime);
  const items = [];
  let seen = 0;
  let i = 0;
  for (; i < withTimes.length && items.length < limit; i++) {
    const s = withTimes[i];
    let summary;
    try {
      summary = await summarize(s, sourceOf(scan, s.id));
    } catch {
      continue;
    }
    if (summary.prompts === 0 && summary.subagents === 0) continue;
    if (filter && !matchesFilter(summary, filter)) continue;
    if (seen++ < offset) continue;
    items.push(summary);
  }
  return { items, done: i >= withTimes.length, next: offset + items.length };
}

// ---- Loading a session -----------------------------------------------------

/**
 * Load a session with its subagents through its harness.
 * Returns { id, harness, project, records, meta?, agents: [{ id, records, meta }], files }
 * where files lists every file read with its size and mtime for live change checks.
 */
export async function loadSession(scan, id) {
  const source = sourceOf(scan, id);
  if (!source) throw new Error('Session not found: ' + id);
  return directoriesFor(source.harness).load(source, id);
}

/**
 * Live change check. Returns true if any known file changed, or the harness finds new agents.
 * Throws if the directory cannot be read.
 */
export async function sessionChanged(scan, loaded) {
  const source = sourceOf(scan, loaded.id);
  for (const f of loaded.files) {
    const file = await f.handle.getFile();
    if (file.size !== f.size || file.lastModified !== f.mtime) return true;
  }
  return directoriesFor(source.harness).hasNewAgents(source, loaded);
}

// ---- Opening files ---------------------------------------------------------

/** Build a loaded-session structure from File objects chosen by the user, with the first harness that recognizes them. */
export async function loadFiles(fileList) {
  const files = [...fileList];
  for (const directories of DIRECTORIES) {
    const loaded = await directories.loadFiles(files);
    if (loaded) return loaded;
  }
  throw new Error('No transcript files found among the selected files.');
}
