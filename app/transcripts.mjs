// Harness-neutral transcript handling: the harness registry, reading JSON lines, session summaries
// and search. Pure functions only; nothing here touches the file system.
//
// Each harness module (claude.mjs, codex.mjs) normalizes its own transcripts into the viewer's
// record model and exports the same interface:
//   NAME                     harness label shown in the interface ('Claude', 'Codex')
//   createParser()           { add(record, sourceLine), finish() } returning records, or null when
//                            the transcript is not in this harness's format
//   classifyUserText(raw, { isMeta })
//                            what a user text block is: prompt, command, received, notification,
//                            coordinator, or system
//   findAgentIds(records)    subagent ids the transcript itself references
//   toolEvent(name, input)   the agent role of a tool call (spawn, message, stop, handback) or null
//   toolTitle(name, input)   a short title for an ordinary tool call, or undefined
//   spawnedAgentId(record, block), stopsAgent(record)
//                            what a tool result says about the agent a spawn or stop addressed
//   SHOW_UNPAIRED_RESULTS    whether a tool result without its call becomes a system event
//   TOKEN_NOTE               extra wording for the total-tokens tooltip
// Filesystem discovery for each harness lives in the matching *-fs.mjs module.

import * as claude from './claude.mjs';
import * as codex from './codex.mjs';

/** Supported harnesses in detection order. Claude, the original format, is the fallback. */
export const HARNESSES = [codex, claude];

/** The harness module for a harness label; unknown or missing labels mean Claude. */
export function harnessNamed(name) {
  return HARNESSES.find((h) => h.NAME === name) || claude;
}

/** Parse JSON-lines text into records of the first harness that claims it. Partial (unparseable) lines are skipped. */
export function parseLines(text) {
  const parsers = HARNESSES.map((h) => h.createParser());
  let start = 0;
  let sourceLine = 0;
  const n = text.length;
  while (start < n) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = n;
    const line = text.slice(start, end).trim();
    sourceLine++;
    start = end + 1;
    if (line.length < 2 || line.charCodeAt(0) !== 123) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r && typeof r === 'object') for (const p of parsers) p.add(r, sourceLine);
  }
  for (const p of parsers) {
    const records = p.finish();
    if (records) return records;
  }
  return [];
}

/** Count of spawns (tool calls the harness treats as spawning an agent) in a record list. */
export function countSpawns(records, harness) {
  const h = harnessNamed(harness);
  let n = 0;
  for (const r of records) {
    if (r.type !== 'assistant') continue;
    for (const b of r.message.content) if (b.type === 'tool_use' && h.toolEvent(b.name, b.input || {})?.type === 'spawn') n++;
  }
  return n;
}

/** Does this user text block count as a prompt or command for the session list? */
export function isPromptText(raw, isMeta, harness) {
  const c = harnessNamed(harness).classifyUserText(raw, { isMeta });
  return c.kind === 'prompt' || c.kind === 'command';
}

function firstLine(s, max = 160) {
  const line = s.replace(/\s+/g, ' ').trim();
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

/** Build a session summary from the records of a session's main transcript. */
export function summarizeRecords(records, harness) {
  const h = harnessNamed(harness);
  let title = '';
  let firstPrompt = '';
  let prompts = 0;
  let cwd = '';
  let model = '';
  let effort = '';
  let context = 0;
  for (const r of records) {
    if (r.type === 'session-meta') cwd = r.cwd;
    if (r.type === 'turn-context') { model = r.model || model; effort = r.effort || effort; }
    if (r.type === 'usage' && r.context) context = r.context;
    if (r.type === 'custom-title' && r.customTitle) title = r.customTitle;
    if (r.type === 'assistant') {
      // The latest reply decides the session's current model, effort, and context size.
      if (r.message.model) model = r.message.model;
      if (r.effort) effort = r.effort;
      if (r.message.usage?.context) context = r.message.usage.context;
    }
    if (r.type !== 'user') continue;
    for (const b of r.message.content) {
      if (b.type !== 'text') continue;
      const c = h.classifyUserText(b.text, { isMeta: r.isMeta });
      if (c.kind === 'prompt' || c.kind === 'command') {
        prompts++;
        if (!firstPrompt) firstPrompt = c.kind === 'command' ? firstLine(c.shell ? c.title : c.title.startsWith('/') ? c.title : '/' + c.title) : firstLine(c.title || c.text);
      }
    }
  }
  return { title, firstPrompt, prompts, cwd, model, effort, context, spawns: countSpawns(records, h.NAME), agentIds: h.findAgentIds(records) };
}

/** Extract cwd from raw JSON-lines text cheaply (first record carrying it). */
export function sniffCwd(text) {
  const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(text);
  if (!m) return '';
  try {
    return JSON.parse('"' + m[1] + '"');
  } catch {
    return m[1];
  }
}

export function matchesFilter(summary, q) {
  if (!q) return true;
  const needle = q.toLowerCase();
  const hay = [summary.title, summary.firstPrompt, summary.id, summary.cwd, summary.project, summary.harness].filter(Boolean).join('\n').toLowerCase();
  return hay.includes(needle);
}
