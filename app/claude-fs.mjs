// Claude Code transcript directories: discovery under ~/.claude/projects, loading a session with its
// nested subagents, live checks for new subagent files, and opening chosen files.
// Implements the directory interface described in localfs.mjs. Read-only.

import { NAME, findAgentIds } from './claude.mjs';
import { parseLines } from './transcripts.mjs';
import { entries, fileInfo } from './handles.mjs';

export const HARNESS = NAME;

/** Where Claude Code keeps transcripts, for the directory dialog. */
export const DIRECTORY_HINT = { windows: '%USERPROFILE%\\.claude\\projects', posix: '~/.claude/projects' };

const SESSION_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const AGENT_FILE_RE = /^agent-([a-z0-9]+)\.jsonl$/;
const AGENT_META_RE = /^agent-([a-z0-9]+)\.meta\.json$/;

// ---- Scanning --------------------------------------------------------------

/** Find the projects directory inside whatever the user picked. */
async function projectsRoot(root) {
  const items = await entries(root);
  for (const [name, h] of items) if (name === 'projects' && h.kind === 'directory') return { dir: h, mode: 'projects' };
  if (items.some(([name, h]) => h.kind === 'file' && SESSION_FILE_RE.test(name))) return { dir: root, mode: 'project' };
  return { dir: root, mode: 'projects' };
}

/**
 * Scan the directory. Claude is the fallback layout, so this always returns a scan:
 *   sessions: [{ id, harness, project, file (handle), dir (handle of the project directory) }]
 *   agentFiles: Map agentId -> { jsonl, meta, project, sessionId }
 *   sessionAgentDirs: Map sessionId -> directory handle of <session>/subagents
 *   agentCounts: Map sessionId -> number of subagent transcripts in that directory
 */
export async function scan(root) {
  const { dir, mode } = await projectsRoot(root);
  const projects = mode === 'project' ? [[dir.name, dir]] : (await entries(dir)).filter(([, h]) => h.kind === 'directory');
  const sessions = [];
  const agentFiles = new Map();
  const sessionAgentDirs = new Map();
  const agentCounts = new Map();
  const sessionDirs = new Map();
  for (const [project, pdir] of projects) {
    const items = await entries(pdir);
    for (const [name, h] of items) {
      if (h.kind === 'file') {
        const m = SESSION_FILE_RE.exec(name);
        if (m) sessions.push({ id: m[1], harness: NAME, project, file: h, dir: pdir });
      } else if (h.kind === 'directory') {
        sessionDirs.set(name, { handle: h, project });
      }
    }
  }
  for (const [sessionId, { handle, project }] of sessionDirs) {
    let subDir = null;
    try {
      subDir = await handle.getDirectoryHandle('subagents');
    } catch {
      continue;
    }
    sessionAgentDirs.set(sessionId, subDir);
    agentCounts.set(sessionId, (await collectAgentFiles(subDir, project, sessionId, agentFiles)).length);
  }
  return { harness: NAME, sessions, agentFiles, sessionAgentDirs, agentCounts, root: dir, mode };
}

/** Subagent transcripts known for a session without reading any file, for its summary. */
export function agentCount(scan, session) {
  return scan.agentCounts.get(session.id) || 0;
}

async function collectAgentFiles(subDir, project, sessionId, agentFiles) {
  const found = [];
  for (const [name, h] of await entries(subDir)) {
    if (h.kind !== 'file') continue;
    let m = AGENT_FILE_RE.exec(name);
    if (m) {
      const rec = agentFiles.get(m[1]) || { project, sessionId };
      rec.jsonl = h;
      agentFiles.set(m[1], rec);
      found.push(m[1]);
      continue;
    }
    m = AGENT_META_RE.exec(name);
    if (m) {
      const rec = agentFiles.get(m[1]) || { project, sessionId };
      rec.meta = h;
      agentFiles.set(m[1], rec);
    }
  }
  return found;
}

async function findSubagentsDir(projectDir, id) {
  try {
    const d = await projectDir.getDirectoryHandle(id);
    return await d.getDirectoryHandle('subagents');
  } catch {
    return null;
  }
}

// ---- Loading a session -----------------------------------------------------

async function readMeta(handle) {
  try {
    return JSON.parse(await (await handle.getFile()).text());
  } catch {
    return null;
  }
}

/**
 * Load a session with its subagents, found by id across all directories and followed into nested ones.
 * Subagent ids come from the session's own subagents directory and from references in each transcript.
 */
export async function load(scan, id) {
  const session = scan.sessions.find((s) => s.id === id);
  if (!session) throw new Error('Session not found: ' + id);
  // Pick up subagent files that appeared since the scan.
  const ownDir = scan.sessionAgentDirs.get(id) || (await findSubagentsDir(session.dir, id));
  if (ownDir) {
    scan.sessionAgentDirs.set(id, ownDir);
    scan.agentCounts.set(id, (await collectAgentFiles(ownDir, session.project, id, scan.agentFiles)).length);
  }
  const files = [];
  const { file, size, mtime } = await fileInfo(session.file);
  files.push({ name: id + '.jsonl', handle: session.file, size, mtime });
  const records = parseLines(await file.text());
  const agents = [];
  const queue = [...findAgentIds(records)];
  const seen = new Set();
  if (ownDir) for (const [aid, rec] of scan.agentFiles) if (rec.sessionId === id && !queue.includes(aid)) queue.push(aid);
  while (queue.length) {
    const aid = queue.shift();
    if (seen.has(aid)) continue;
    seen.add(aid);
    const rec = scan.agentFiles.get(aid);
    if (!rec || !rec.jsonl) continue;
    let info;
    try {
      info = await fileInfo(rec.jsonl);
    } catch {
      continue;
    }
    files.push({ name: `agent-${aid}.jsonl`, handle: rec.jsonl, size: info.size, mtime: info.mtime });
    const arecords = parseLines(await info.file.text());
    const meta = rec.meta ? await readMeta(rec.meta) : null;
    if (rec.meta) {
      const mi = await fileInfo(rec.meta);
      files.push({ name: `agent-${aid}.meta.json`, handle: rec.meta, size: mi.size, mtime: mi.mtime });
    }
    agents.push({ id: aid, records: arecords, meta });
    for (const child of findAgentIds(arecords)) if (!seen.has(child)) queue.push(child);
  }
  return { id, harness: NAME, project: session.project, records, agents, files, ownDir };
}

/** Live check beyond known files: a new subagent transcript in the session's own directory. */
export async function hasNewAgents(scan, loaded) {
  const session = scan.sessions.find((s) => s.id === loaded.id);
  const ownDir = loaded.ownDir || (session && (await findSubagentsDir(session.dir, loaded.id)));
  if (ownDir) {
    loaded.ownDir = ownDir;
    const known = new Set(loaded.files.map((f) => f.name));
    for (const [name, h] of await entries(ownDir)) {
      if (h.kind === 'file' && AGENT_FILE_RE.test(name) && !known.has(name)) return true;
    }
  }
  return false;
}

// ---- Opening files ---------------------------------------------------------

/** Build a loaded session from chosen File objects, recognized by filename; null when none is a Claude transcript. */
export async function loadFiles(files) {
  let main = null;
  const agentMap = new Map();
  for (const f of files) {
    const name = f.name;
    if (SESSION_FILE_RE.test(name)) main = f;
    let m = AGENT_FILE_RE.exec(name);
    if (m) {
      const rec = agentMap.get(m[1]) || {};
      rec.jsonl = f;
      agentMap.set(m[1], rec);
      continue;
    }
    m = AGENT_META_RE.exec(name);
    if (m) {
      const rec = agentMap.get(m[1]) || {};
      rec.meta = f;
      agentMap.set(m[1], rec);
    }
  }
  const agents = [];
  for (const [aid, rec] of agentMap) {
    if (!rec.jsonl) continue;
    const records = parseLines(await rec.jsonl.text());
    let meta = null;
    if (rec.meta) {
      try {
        meta = JSON.parse(await rec.meta.text());
      } catch {
        /* ignore */
      }
    }
    agents.push({ id: aid, records, meta });
  }
  if (!main) {
    if (!agents.length) return null;
    // A single subagent transcript shown as the main agent.
    const first = agents.shift();
    return { id: first.id, harness: NAME, project: '', records: first.records, agents, files: [], fromFiles: true, meta: first.meta };
  }
  const id = SESSION_FILE_RE.exec(main.name)[1];
  return { id, harness: NAME, project: '', records: parseLines(await main.text()), agents, files: [], fromFiles: true };
}
