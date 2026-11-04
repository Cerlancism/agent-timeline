// Agent Timeline: loading, turning transcripts into agents and events, rendering, playback,
// filters and live mode.

import { harnessNamed, summarizeRecords, HARNESSES } from './transcripts.mjs';
import {
  supportsMount, mountDirectory, rememberedDirectories, suggestedPath, removeDirectory, permissionState, requestPermission,
  scanDirectory, combineScans, listSessions, loadSession, sessionChanged, loadFiles,
} from './localfs.mjs';
import { languageForPath, guessLanguage, renderCode } from './highlight.js';
import { connectServer } from './remote.mjs';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

const PAGE = 20;
const LIVE_WINDOW_MS = 10 * 60 * 1000;
const PALETTE = ['#3fa0ff', '#34d17a', '#ff9f43', '#c77dff', '#2ed3c6', '#ffd166', '#ff6b78', '#7cc4ff', '#9fd38b', '#ffb86c', '#9a7bd6', '#74d6e2'];
const LINK_TYPES = new Set(['spawn', 'message', 'stop', 'handback', 'notification', 'received']);
const TYPE_COLORS = {
  operator: '--ev-operator', command: '--ev-command', reply: '--ev-reply', thinking: '--ev-thinking', tool: '--ev-tool',
  spawn: '--ev-spawn', message: '--ev-message', stop: '--ev-stop', handback: '--ev-handback', notification: '--ev-notification',
  received: '--ev-received', system: '--ev-system',
};
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

// ---------------------------------------------------------------------------
// State

const state = {
  directories: [], // remembered { handle, scan }, including sources waiting for permission
  scan: null,
  source: null, // where sessions come from: a mounted directory or the server (see localSource/remote.mjs)
  sessions: null, // raw loaded sessions (records per agent), one per session shown together
  model: null, // { agents, agentList, events, links, sessions }
  pos: -1, // index of the current event
  reach: -1, // furthest event shown so far; cards up to it stay visible when moving back
  playing: false,
  timer: null,
  focus: null, // agent id or null
  filters: { thinking: false, tools: true, deliveries: true, system: true },
  autoscroll: true,
  liveBehind: false,
  selected: -1,
  live: false,
  liveTimer: null,
  reloading: false,
  reloadAgain: false,
  list: { offset: 0, filter: '', done: false, token: 0 },
  picked: new Map(), // session summaries ticked on the landing page, in picking order
  landing: true,
};

// ---------------------------------------------------------------------------
// Utilities

function fmtRel(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
function fmtSize(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}
function fmtDur(ms) {
  if (!(ms >= 0)) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
function fmtTime(ms) {
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}
function fmtNum(n) {
  return n.toLocaleString();
}
function firstLine(s, max = 90) {
  const line = (s || '').replace(/\s+/g, ' ').trim();
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}
function shortId(id) {
  return id.length > 12 ? id.slice(0, 8) : id;
}
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// ---------------------------------------------------------------------------
// Model: agents and events

/** A short title for an ordinary tool call: the harness's own, else its description or first string input. */
function toolTitle(harness, name, input) {
  if (typeof input === 'string') return firstLine(input);
  const i = input || {};
  const own = harness.toolTitle(name, i);
  if (own !== undefined) return firstLine(own);
  if (typeof i.description === 'string') return firstLine(i.description);
  const v = Object.values(i).find((x) => typeof x === 'string');
  return v ? firstLine(v) : '';
}

function buildSessionModel(loaded) {
  const mainId = loaded.id;
  // The harness that wrote the session decides how its user text, tools and results read.
  const harness = harnessNamed(loaded.harness);
  const agents = new Map();
  const mkAgent = (id) => ({
    id, label: id, type: '', model: '', efforts: [], parentId: null, children: [], events: [], color: '', meta: null,
    firstIndex: -1, lastIndex: -1, stopIndex: -1, spawnIndex: -1, spawnedBy: null, row: 0, depth: 0,
  });
  const main = mkAgent(mainId);
  main.isMain = true;
  main.label = loaded.meta?.description || 'main';
  main.type = loaded.meta?.agentType || 'session';
  main.meta = loaded.meta || null;
  agents.set(mainId, main);
  const metaByToolUse = new Map();
  for (const a of loaded.agents) {
    const ag = mkAgent(a.id);
    ag.meta = a.meta;
    ag.label = a.meta?.description || a.id;
    ag.type = a.meta?.agentType || '';
    ag.model = a.meta?.model || '';
    ag.parentId = a.meta?.parentAgentId || null;
    agents.set(a.id, ag);
    if (a.meta?.toolUseId) metaByToolUse.set(a.meta.toolUseId, a.id);
  }
  const labelToId = new Map();
  for (const a of agents.values()) {
    labelToId.set(a.label, a.id);
    if (a.meta?.agentPath) {
      labelToId.set(a.meta.agentPath, a.id);
      labelToId.set(a.meta.agentPath.split('/').at(-1), a.id);
    }
  }
  const resolveAgentRef = (ref) => {
    if (!ref || typeof ref !== 'string') return null;
    if (agents.has(ref)) return ref;
    const m = /^(.*?)\s*\[([a-z0-9]+)\]$/.exec(ref);
    if (m && agents.has(m[2])) return m[2];
    if (labelToId.has(ref)) return labelToId.get(ref);
    for (const id of agents.keys()) if (id.startsWith(ref) && ref.length >= 6) return id;
    return null;
  };

  const events = [];
  let seq = 0;
  const dedupe = new Set();

  const processAgent = (agentId, records) => {
    const pending = new Map(); // call IDs are scoped to a thread
    const ag = agents.get(agentId);
    const seenMsg = new Set();
    let lastTime = 0;
    let firstPrompt = true;
    const push = (ev) => {
      ev.agentId = agentId;
      ev.seq = seq++;
      if (!ev.time) ev.time = lastTime;
      lastTime = ev.time;
      events.push(ev);
      return ev;
    };
    const timeOf = (r) => {
      const t = Date.parse(r.timestamp);
      return Number.isFinite(t) ? t : lastTime;
    };
    const handleText = (text, time, record, fromAttachment) => {
      const c = harness.classifyUserText(text, { isMeta: record?.isMeta });
      if (c.skip) return;
      const key = agentId + '|' + c.kind + '|' + (c.from || '') + '|' + (c.text || '');
      if ((c.kind === 'received' || c.kind === 'notification') && dedupe.has(key)) return;
      dedupe.add(key);
      if (c.kind === 'received') {
        push({ type: 'received', time, title: c.title, text: c.text, from: resolveAgentRef(c.from) || c.from, to: agentId, delivery: true, handback: c.handback, record });
      } else if (c.kind === 'notification') {
        push({
          type: 'notification', time, title: c.title, text: c.result || c.summary, raw: c.text, taskId: c.taskId, status: c.status,
          from: agents.has(c.taskId) ? c.taskId : null, to: agentId, record,
        });
      } else if (c.kind === 'coordinator') {
        push({ type: 'received', time, title: 'message', text: c.text, from: '__parent__', to: agentId, delivery: true, record });
      } else if (c.kind === 'command') {
        push({ type: 'command', time, title: c.title, text: c.text, record });
      } else if (c.kind === 'system') {
        push({ type: 'system', time, title: c.title, text: c.text, record });
      } else if (c.kind === 'prompt') {
        if (ag.isMain) {
          push({ type: 'operator', time, title: firstLine(c.title || c.text), text: c.text, record });
        } else if (firstPrompt) {
          push({ type: 'operator', time, title: 'task prompt: ' + firstLine(c.text, 70), text: c.text, record });
        } else {
          push({ type: 'system', time, title: 'injected text', text: c.text, record });
        }
        firstPrompt = false;
      }
      void fromAttachment;
    };

    for (const r of records) {
      const time = timeOf(r);
      if (r.type === 'turn-context') {
        ag.model = r.model || ag.model;
        if (r.effort && !ag.efforts.includes(r.effort)) ag.efforts.push(r.effort);
      } else if (r.type === 'usage') {
        push({ type: 'system', time, title: 'token usage', text: r.content, tokens: r.tokens, context: r.context, record: r });
      } else if (r.type === 'peer-message') {
        push({ type: 'received', time, title: 'message', text: r.content, from: resolveAgentRef(r.from), to: agentId, delivery: true, record: r });
      } else if (r.type === 'assistant') {
        const m = r.message;
        if (m.model) ag.model = m.model;
        if (r.effort && !ag.efforts.includes(r.effort)) ag.efforts.push(r.effort);
        let tokens = 0;
        let context = 0;
        if (m.id && !seenMsg.has(m.id)) {
          seenMsg.add(m.id);
          tokens = m.usage?.output_tokens || 0;
          context = m.usage?.context || 0;
        }
        m.content.forEach((b, bi) => {
          let ev;
          if (b.type === 'text') ev = push({ type: 'reply', time, title: firstLine(b.text), text: b.text, record: r, block: bi });
          else if (b.type === 'thinking') ev = push({ type: 'thinking', time, title: 'thinking', text: b.text, record: r, block: bi });
          else if (b.type === 'tool_use') {
            const name = b.name;
            const input = b.input || {};
            const role = harness.toolEvent(name, input);
            if (!role) {
              ev = push({ type: 'tool', time, title: toolTitle(harness, name, input), text: '', tool: name, input, record: r, block: bi });
            } else {
              // A spawn's child comes from subagent metadata now or from its result later; a
              // handback goes to the parent; messages and stops name their target.
              const to = role.type === 'spawn' ? metaByToolUse.get(b.id) || null : role.type === 'handback' ? '__parent__' : resolveAgentRef(role.target);
              ev = push({ type: role.type, time, title: firstLine(role.title), text: role.text, tool: name, input, from: agentId, to, record: r, block: bi });
              if (role.target !== undefined) ev.toRef = role.target;
              if (role.child) ev.child = role.child;
            }
            if (b.id) pending.set(b.id, ev);
          }
          if (ev && tokens) {
            ev.tokens = tokens;
            ev.model = m.model;
            tokens = 0;
          }
          if (ev && context) {
            ev.context = context;
            context = 0;
          }
        });
      } else if (r.type === 'user') {
        for (const b of r.message.content) {
          if (b.type === 'tool_result') {
            const ev = pending.get(b.tool_use_id);
            if (!ev) {
              if (harness.SHOW_UNPAIRED_RESULTS) push({ type: 'system', time, title: 'unpaired tool result', text: b.text, record: r });
              continue;
            }
            ev.result = ev.result == null ? b.text : ev.result + '\n\n' + b.text;
            ev.isError = ev.isError || !!b.is_error;
            ev.endTime = time;
            ev.toolUseResult = r.toolUseResult;
            if (ev.type === 'spawn' && !ev.to) {
              const id = harness.spawnedAgentId(r, b);
              if (id && agents.has(id)) ev.to = id;
            }
            if (ev.type === 'stop' && !harness.stopsAgent(r)) ev.to = null;
          } else if (b.type === 'text') {
            handleText(b.text, time, r, false);
          }
        }
      } else if (r.type === 'attachment') {
        handleText(r.prompt, time, { isMeta: false, uuid: r.uuid, timestamp: r.timestamp }, true);
      } else if (r.type === 'system' && r.compact) {
        const { trigger, preTokens } = r.compact;
        const text = `Conversation compacted${trigger ? ` (${trigger})` : ''}.` + (preTokens ? ` Context before: ${fmtNum(preTokens)} tokens.` : '');
        push({ type: 'system', time, title: 'compacted' + (trigger ? ` (${trigger})` : ''), text, compact: r.compact, record: r });
      } else if (r.type === 'system') {
        push({ type: 'system', time, title: r.title || 'error: ' + (r.subtype || 'api'), text: r.content || '', isError: r.level === 'error', record: r });
      }
    }
  };

  processAgent(mainId, loaded.records);
  for (const a of loaded.agents) processAgent(a.id, a.records);

  events.sort((a, b) => a.time - b.time || a.seq - b.seq);
  events.forEach((e, i) => (e.index = i));

  // Parents: from meta, else the spawner, else main.
  for (const e of events) {
    if (e.type === 'spawn' && e.to && agents.has(e.to)) {
      const t = agents.get(e.to);
      t.spawnedBy = e.agentId;
      if (t.spawnIndex < 0) t.spawnIndex = e.index;
      const child = e.child || {};
      if (!t.label || t.label === t.id) t.label = child.label || t.label;
      if (!t.type) t.type = child.type || '';
      if (!t.model && child.model) t.model = child.model;
    }
  }
  for (const a of agents.values()) {
    if (a.isMain) continue;
    if (!a.parentId || !agents.has(a.parentId)) a.parentId = a.spawnedBy && agents.has(a.spawnedBy) ? a.spawnedBy : mainId;
    if (a.parentId === a.id) a.parentId = mainId;
    const ancestry = new Set([a.id]);
    let parent = agents.get(a.parentId);
    while (parent && !parent.isMain) {
      if (ancestry.has(parent.id)) { a.parentId = mainId; break; }
      ancestry.add(parent.id);
      parent = agents.get(parent.parentId);
    }
  }
  for (const e of events) {
    if (e.to === '__parent__') e.to = agents.get(e.agentId).parentId;
    if (e.from === '__parent__') e.from = agents.get(e.agentId).parentId;
    if (e.from && !agents.has(e.from)) e.from = null;
    if (e.to && !agents.has(e.to)) e.to = null;
    if (e.type === 'spawn' && e.to && agents.get(e.to).parentId !== e.agentId) {
      // keep meta parent; spawn link still drawn between spawner and child
    }
    const ag = agents.get(e.agentId);
    ag.events.push(e);
    if (ag.firstIndex < 0) ag.firstIndex = e.index;
    ag.lastIndex = e.index;
    if (e.type === 'stop' && e.to && agents.has(e.to)) {
      const t = agents.get(e.to);
      if (t.stopIndex < 0 || e.index < t.stopIndex) t.stopIndex = e.index;
    }
  }
  // Tree order: children sorted by their first event time.
  for (const a of agents.values()) a.children = [];
  for (const a of agents.values()) if (!a.isMain) agents.get(a.parentId).children.push(a);
  const startOf = (a) => (a.firstIndex >= 0 ? events[a.firstIndex].time : Infinity);
  const agentList = [];
  const walk = (a, depth) => {
    a.depth = depth;
    a.row = agentList.length;
    agentList.push(a);
    a.children.sort((x, y) => startOf(x) - startOf(y) || x.id.localeCompare(y.id));
    for (const c of a.children) walk(c, depth + 1);
  };
  walk(main, 0);
  agentList.forEach((a, i) => (a.color = PALETTE[i % PALETTE.length]));

  // Links (undirected keys).
  const links = new Map();
  for (const e of events) {
    if (!LINK_TYPES.has(e.type) || !e.from || !e.to || e.from === e.to) continue;
    const key = [e.from, e.to].sort().join('|');
    e.linkKey = key;
    if (!links.has(key)) {
      const [a, b] = key.split('|');
      const pa = agents.get(a);
      const pb = agents.get(b);
      const parentChild = pa.parentId === b || pb.parentId === a;
      links.set(key, { key, a, b, parentChild, count: 0 });
    }
  }
  const totalTokens = events.reduce((s, e) => s + (e.tokens || 0), 0);
  return { agents, agentList, events, links, main, totalTokens };
}

/**
 * Build one model from one or more loaded sessions. Each session is built on its own, so
 * references resolve only within it; the parts are then merged into one event order by time,
 * with each session's main agent as a root. An agent id already taken by an earlier session
 * (a resumed session can reference its predecessor's subagents) is kept once: the later copy
 * and its events are dropped, and references to it point at the kept agent.
 */
function buildModel(loadedList) {
  const list = Array.isArray(loadedList) ? loadedList : [loadedList];
  const parts = list.map((loaded) => ({ loaded, model: buildSessionModel(loaded) }));
  const startOf = (p) => (p.model.events.length ? p.model.events[0].time : Infinity);
  parts.sort((a, b) => startOf(a) - startOf(b) || a.loaded.id.localeCompare(b.loaded.id));
  const multi = parts.length > 1;
  const agents = new Map();
  const events = [];
  const links = new Map();
  const sessions = [];
  let seqBase = 0;
  parts.forEach((p, si) => {
    const m = p.model;
    const summary = summarizeRecords(p.loaded.records, p.loaded.harness);
    const title = summary.title || summary.firstPrompt || p.loaded.id;
    const session = { id: p.loaded.id, harness: harnessNamed(p.loaded.harness).NAME, index: si, short: shortId(p.loaded.id), title, main: m.main, loaded: p.loaded };
    if (multi) m.main.label = firstLine(title, 48);
    const dropped = new Set();
    for (const a of m.agentList) {
      if (agents.has(a.id)) {
        dropped.add(a.id);
        continue;
      }
      a.session = session;
      agents.set(a.id, a);
    }
    for (const a of m.agentList) if (!dropped.has(a.id)) a.children = a.children.filter((c) => !dropped.has(c.id));
    for (const e of m.events) {
      if (dropped.has(e.agentId)) continue;
      e.seq += seqBase;
      events.push(e);
    }
    seqBase += m.events.length;
    for (const [k, l] of m.links) if (!links.has(k)) links.set(k, l);
    sessions.push(session);
  });
  events.sort((a, b) => a.time - b.time || a.seq - b.seq);
  events.forEach((e, i) => (e.index = i));
  for (const a of agents.values()) {
    a.events = [];
    a.firstIndex = a.lastIndex = a.stopIndex = a.spawnIndex = -1;
  }
  for (const e of events) {
    const ag = agents.get(e.agentId);
    ag.events.push(e);
    if (ag.firstIndex < 0) ag.firstIndex = e.index;
    ag.lastIndex = e.index;
    if (e.to && agents.has(e.to)) {
      const t = agents.get(e.to);
      if (e.type === 'spawn' && t.spawnIndex < 0) t.spawnIndex = e.index;
      if (e.type === 'stop' && (t.stopIndex < 0 || e.index < t.stopIndex)) t.stopIndex = e.index;
    }
  }
  const agentList = [];
  const walk = (a, depth) => {
    a.depth = depth;
    a.row = agentList.length;
    agentList.push(a);
    for (const c of a.children) walk(c, depth + 1);
  };
  for (const s of sessions) walk(s.main, 0);
  agentList.forEach((a, i) => (a.color = PALETTE[i % PALETTE.length]));
  const totalTokens = events.reduce((s, e) => s + (e.tokens || 0), 0);
  return { agents, agentList, events, links, main: sessions[0].main, sessions, multi, totalTokens };
}

// ---------------------------------------------------------------------------
// Visibility

function isVisible(ev) {
  const f = state.filters;
  if (ev.type === 'thinking' && !f.thinking) return false;
  if (ev.type === 'tool' && !f.tools) return false;
  if (ev.type === 'system' && !f.system) return false;
  if (state.focus) {
    if (ev.agentId !== state.focus) return false;
  } else if (ev.delivery && !f.deliveries) return false;
  return true;
}
function nextVisible(from, dir) {
  const ev = state.model.events;
  for (let i = from + dir; i >= 0 && i < ev.length; i += dir) if (isVisible(ev[i])) return i;
  return -1;
}

// ---------------------------------------------------------------------------
// Agent map

const map = { boxes: new Map(), paths: new Map(), counts: new Map(), dot: null, activeKey: null, anim: 0 };
const BOX_H = 60;
const ROW_GAP = 12;
const INDENT = 22;

function renderMap() {
  const { agentList, links, agents } = state.model;
  const boxes = $('map-boxes');
  const svg = $('map-svg');
  boxes.textContent = '';
  svg.textContent = '';
  map.boxes.clear();
  map.paths.clear();
  map.counts.clear();
  const maxDepth = Math.max(...agentList.map((a) => a.depth));
  const peerCount = [...links.values()].filter((l) => !l.parentChild).length;
  const panelW = $('map').clientWidth - 24;
  const BOX_W = Math.max(180, Math.min(300, panelW - maxDepth * INDENT - (peerCount ? 60 : 8)));
  const width = maxDepth * INDENT + BOX_W + (peerCount ? 60 : 0);
  // With several sessions, a short heading names each session above its tree.
  const SESSION_H = state.model.multi ? 22 : 0;
  const ys = new Map();
  let height = 0;
  for (const a of agentList) {
    if (a.isMain) height += SESSION_H;
    ys.set(a.id, height);
    height += BOX_H + ROW_GAP;
  }
  boxes.style.width = width + 'px';
  boxes.style.height = height + 'px';
  svg.setAttribute('width', width + 24);
  svg.setAttribute('height', height + 24);
  const pos = (a) => ({ x: a.depth * INDENT, y: ys.get(a.id) });

  for (const a of agentList) {
    const p = pos(a);
    if (a.isMain && SESSION_H) {
      const head = el('div', 'map-session', `session ${a.session.index + 1} · ${a.session.harness} · ${a.session.short}`);
      head.title = `${a.session.title}\n${a.session.id}`;
      head.style.top = p.y - SESSION_H + 'px';
      head.style.width = width + 'px';
      boxes.appendChild(head);
    }
    const box = el('div', 'agent-box not-started');
    box.style.setProperty('--agent-color', a.color);
    box.style.setProperty('--box-w', BOX_W + 'px');
    box.style.setProperty('--box-h', BOX_H + 'px');
    box.style.left = p.x + 'px';
    box.style.top = p.y + 'px';
    box.tabIndex = 0;
    box.setAttribute('role', 'button');
    box.setAttribute('aria-pressed', 'false');
    box.dataset.agent = a.id;
    box.title = [
      a.label,
      a.type && `type: ${a.type}`,
      a.model && `model: ${a.model}`,
      a.efforts.length && `effort: ${a.efforts.join(', ')}`,
      a.id,
    ].filter(Boolean).join('\n');
    const label = el('div', 'label');
    label.append(el('span', 'dot'), el('span', '', a.label), el('span', 'status', 'wait'));
    const sub = el('div', 'sub', [a.type, a.model].filter(Boolean).join(' · ') || shortId(a.id));
    const counts = el('div', 'counts');
    counts.innerHTML = '<b class="c-ev">0</b> ev · <b class="c-tok">0</b> out · <b class="c-ctx">0</b> ctx';
    box.append(label, sub, counts);
    box.addEventListener('click', () => toggleFocus(a.id));
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        toggleFocus(a.id);
      }
    });
    boxes.appendChild(box);
    map.boxes.set(a.id, box);
  }

  // offset for svg: map has 12px padding and svg sits at 0,0 of #map
  const OX = 12;
  const OY = 12;
  const ns = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs) => {
    const n = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };
  // parent-child links
  for (const a of agentList) {
    if (a.isMain) continue;
    const parent = agents.get(a.parentId);
    const pp = pos(parent);
    const cp = pos(a);
    const x0 = OX + pp.x + 10;
    const y0 = OY + pp.y + BOX_H;
    const y1 = OY + cp.y + BOX_H / 2;
    const x1 = OX + cp.x;
    const key = [a.id, parent.id].sort().join('|');
    const d = `M ${x0} ${y0} V ${y1} H ${x1}`;
    const path = mk('path', { d, class: 'map-link' });
    svg.appendChild(path);
    map.paths.set(key, { path, start: parent.id, end: a.id });
    const link = links.get(key) || { key, a: parent.id, b: a.id, parentChild: true, count: 0, implicit: true };
    links.set(key, link);
    addCounter(svg, mk, key, x0 - 4, y1 - 6);
  }
  // peer links (not parent-child) as dashed curves on the right
  let k = 0;
  for (const link of links.values()) {
    if (map.paths.has(link.key)) continue;
    const A = agents.get(link.a);
    const B = agents.get(link.b);
    const pa = pos(A);
    const pb = pos(B);
    const xa = OX + pa.x + BOX_W;
    const ya = OY + pa.y + BOX_H / 2;
    const xb = OX + pb.x + BOX_W;
    const yb = OY + pb.y + BOX_H / 2;
    const bulge = 36 + (k++ % 4) * 14;
    const cx = Math.max(xa, xb) + bulge;
    const d = `M ${xa} ${ya} C ${cx} ${ya}, ${cx} ${yb}, ${xb} ${yb}`;
    const path = mk('path', { d, class: 'map-link peer' });
    svg.appendChild(path);
    map.paths.set(link.key, { path, start: link.a, end: link.b });
    addCounter(svg, mk, link.key, Math.max(xa, xb) + bulge * 0.75 - 4, (ya + yb) / 2 + 3);
  }
  map.dot = mk('circle', { r: 4, class: 'map-dot', visibility: 'hidden' });
  svg.appendChild(map.dot);

  function addCounter(svg, mk, key, x, y) {
    const bg = mk('rect', { x: x - 2, y: y - 9, width: 16, height: 11, rx: 2, class: 'map-link-count-bg' });
    const t = mk('text', { x, y, class: 'map-link-count' });
    t.textContent = '0';
    svg.append(bg, t);
    map.counts.set(key, { text: t, bg });
  }
  $('show-all-btn').hidden = !state.focus;
}

function updateMap(agentStats, linkCounts) {
  const { agentList, events } = state.model;
  const cur = state.pos >= 0 ? events[state.pos] : null;
  const ctxSeries = contextSeries();
  for (const a of agentList) {
    const box = map.boxes.get(a.id);
    if (!box) continue;
    const st = agentStats.get(a.id);
    // Compact figures fit the narrow box; the line's tooltip carries the exact values.
    const ctxRow = ctxSeries.byId.get(a.id);
    const ctxNow = (state.pos >= 0 && ctxRow && ctxRow.values[state.pos]) || 0;
    box.querySelector('.c-ev').textContent = fmtNum(st.events);
    box.querySelector('.c-tok').textContent = fmtTokens(st.tokens);
    box.querySelector('.c-ctx').textContent = fmtTokens(ctxNow);
    box.querySelector('.counts').title = `${fmtNum(st.events)} events and ${fmtNum(st.tokens)} output tokens so far\n${fmtNum(ctxNow)} context tokens at its latest call`;
    let cls = 'not-started';
    if (cur && cur.agentId === a.id) cls = 'current';
    else if (a.firstIndex >= 0 && state.pos >= a.firstIndex) {
      const stopped = a.stopIndex >= 0 && state.pos >= a.stopIndex;
      cls = state.pos > a.lastIndex || stopped ? 'finished' : 'running';
    } else if (a.spawnIndex >= 0 && state.pos >= a.spawnIndex) cls = 'running';
    box.classList.remove('not-started', 'running', 'current', 'finished');
    box.classList.add(cls);
    box.classList.toggle('focused', state.focus === a.id);
    const status = { 'not-started': 'Not started', running: 'Running', current: 'Current event', finished: 'Finished' }[cls];
    box.querySelector('.status').textContent = { 'not-started': 'wait', running: 'run', current: 'now', finished: 'done' }[cls];
    box.setAttribute('aria-label', `${a.label}: ${status}`);
    box.setAttribute('aria-pressed', String(state.focus === a.id));
  }
  for (const [key, c] of map.counts) {
    const n = linkCounts.get(key) || 0;
    c.text.textContent = String(n);
    const w = 6 * String(n).length + 6;
    c.bg.setAttribute('width', w);
  }
  // active link highlight
  const key = cur && cur.linkKey;
  if (map.activeKey && map.activeKey !== key) {
    const p = map.paths.get(map.activeKey);
    if (p) p.path.classList.remove('active');
    const c = map.counts.get(map.activeKey);
    if (c) c.text.classList.remove('active');
  }
  map.activeKey = key || null;
  if (key && map.paths.has(key)) {
    const p = map.paths.get(key);
    const color = cssVar(TYPE_COLORS[cur.type]);
    p.path.style.setProperty('--link-color', color);
    p.path.classList.add('active');
    const c = map.counts.get(key);
    if (c) c.text.classList.add('active');
  }
}

/** Scroll the agent map so the box owning the current event is visible. */
function revealMapBox() {
  if (!state.model || state.pos < 0) return;
  const box = map.boxes.get(state.model.events[state.pos].agentId);
  const panel = $('map');
  if (!box || panel.scrollHeight <= panel.clientHeight) return;
  const top = box.offsetTop;
  const bottom = top + box.offsetHeight;
  if (top < panel.scrollTop + 12) panel.scrollTop = Math.max(0, top - 12);
  else if (bottom > panel.scrollTop + panel.clientHeight - 12) panel.scrollTop = bottom + 12 - panel.clientHeight;
}

function animateDot(ev) {
  cancelAnimationFrame(map.anim);
  const dot = map.dot;
  if (!dot) return;
  const p = ev && ev.linkKey && map.paths.get(ev.linkKey);
  if (!p || reducedMotion.matches) {
    if (dot) dot.setAttribute('visibility', 'hidden');
    return;
  }
  const path = p.path;
  const len = path.getTotalLength();
  const forward = p.start === ev.from;
  dot.style.setProperty('--link-color', cssVar(TYPE_COLORS[ev.type]));
  dot.setAttribute('visibility', 'visible');
  const dur = 650;
  const t0 = performance.now();
  const step = (now) => {
    let f = Math.min(1, (now - t0) / dur);
    const pt = path.getPointAtLength((forward ? f : 1 - f) * len);
    dot.setAttribute('cx', pt.x);
    dot.setAttribute('cy', pt.y);
    if (f < 1) map.anim = requestAnimationFrame(step);
    else dot.setAttribute('visibility', 'hidden');
  };
  map.anim = requestAnimationFrame(step);
}

// ---------------------------------------------------------------------------
// Conversation feed

let cards = [];

function cardPreview(ev) {
  switch (ev.type) {
    case 'tool':
      return ev.result != null ? ev.result : '(no result)';
    case 'spawn':
      return ev.text;
    case 'thinking':
      return ev.text || '(thinking not recorded)';
    case 'notification':
      return ev.text || ev.raw;
    default:
      return ev.text || '';
  }
}

function renderFeed() {
  const feed = $('feed');
  feed.textContent = '';
  cards = [];
  const { events, agents, multi } = state.model;
  const frag = document.createDocumentFragment();
  for (const ev of events) {
    const ag = agents.get(ev.agentId);
    const card = el('div', 'card future');
    card.tabIndex = -1;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `${multi ? 'session ' + ag.session.short + ', ' : ''}${ag.label}, ${ev.type}: ${ev.title}, ${fmtTime(ev.time)}`);
    card.dataset.index = ev.index;
    card.dataset.type = ev.type;
    card.dataset.agent = ev.agentId;
    if (ev.delivery) card.dataset.delivery = '1';
    if (ev.isError) card.classList.add('error');
    card.style.setProperty('--agent-color', ag.color);
    card.style.setProperty('--type-color', `var(${TYPE_COLORS[ev.type]})`);
    const top = el('div', 'top');
    const who = el('span', 'who');
    if (LINK_TYPES.has(ev.type) && ev.from && ev.to) {
      const a = agents.get(ev.from);
      const b = agents.get(ev.to);
      const s1 = el('span', '', a.label);
      s1.style.color = a.color;
      const s2 = el('span', '', b.label);
      s2.style.color = b.color;
      who.append(s1, el('span', 'arrow', '→'), s2);
    } else who.textContent = ag.label;
    if (multi) {
      const tag = el('span', 'session', ag.session.short);
      tag.title = `${ag.session.title}\n${ag.session.id}`;
      top.appendChild(tag);
    }
    top.append(who, el('span', 'time', fmtTime(ev.time)));
    const kind = el('div', 'kind');
    kind.append(el('span', 'type', ev.type), el('span', 'title', ev.type === 'tool' ? `${ev.tool}: ${ev.title}` : ev.title));
    const prev = el('div', 'preview', cardPreview(ev).slice(0, 1200));
    card.append(top, kind, prev);
    card.addEventListener('click', () => {
      setFollow(false);
      seek(ev.index, { select: true, manual: true });
    });
    card.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();
      card.click();
    });
    frag.appendChild(card);
    cards.push(card);
  }
  feed.appendChild(frag);
  applyFilterClasses();
}

function applyFilterClasses() {
  const feed = $('feed');
  feed.classList.toggle('hide-thinking', !state.filters.thinking);
  feed.classList.toggle('hide-tools', !state.filters.tools);
  feed.classList.toggle('hide-system', !state.filters.system);
  feed.classList.toggle('hide-deliveries', !state.filters.deliveries);
  feed.classList.toggle('focused', !!state.focus);
}

let focusStyle = null;
function applyFocusRule() {
  if (!focusStyle) {
    focusStyle = document.createElement('style');
    document.head.appendChild(focusStyle);
  }
  focusStyle.textContent = state.focus ? `#feed .card:not([data-agent="${CSS.escape(state.focus)}"]) { display: none !important; }` : '';
  $('show-all-btn').hidden = !state.focus;
  $('clear-focus-btn').hidden = !state.focus;
  for (const [id, box] of map.boxes) {
    box.classList.toggle('focused', state.focus === id);
    box.setAttribute('aria-pressed', String(state.focus === id));
  }
}

/**
 * After filters or agent focus change which events show: re-measure the feed's tail, and keep a
 * live session that was following at its latest visible event (unfocusing reveals newer events).
 */
function viewChanged() {
  if (!state.model) return;
  keepFeedPlace($('feed').scrollTop);
  if (!state.live) return;
  const last = nextVisible(state.model.events.length, -1);
  if (!state.liveBehind && !state.playing && last > state.pos) seek(last, { select: true });
  if (state.liveBehind && nextVisible(state.pos, 1) < 0) state.liveBehind = false;
  setLiveBehind();
  if (!state.liveBehind) scrollToCurrent();
}

function toggleFocus(id) {
  state.focus = state.focus === id ? null : id;
  applyFilterClasses();
  applyFocusRule();
  viewChanged();
  drawTimeline();
  scrollToCurrent(true);
}

function updateFeed(oldPos, newPos) {
  // Cards up to the furthest position reached stay visible; those past the current one are dimmed.
  if (newPos > state.reach) {
    for (let i = state.reach + 1; i <= newPos; i++) cards[i].classList.remove('future');
    state.reach = newPos;
  }
  if (newPos > oldPos) for (let i = oldPos + 1; i <= newPos; i++) cards[i].classList.remove('ahead');
  else for (let i = newPos + 1; i <= Math.min(oldPos, state.reach); i++) cards[i].classList.add('ahead');
  if (oldPos >= 0 && cards[oldPos]) {
    cards[oldPos].classList.remove('current');
    cards[oldPos].removeAttribute('aria-current');
    cards[oldPos].tabIndex = -1;
  }
  if (newPos >= 0 && cards[newPos]) {
    cards[newPos].classList.add('current');
    cards[newPos].setAttribute('aria-current', 'true');
    cards[newPos].tabIndex = 0;
  }
}

function setFollow(on) {
  state.autoscroll = on;
}

/**
 * Size the spacer after the last shown card so the feed's scroll position stays valid when
 * later cards are hidden: a card you click stays where it was instead of dropping to the bottom.
 */
function keepFeedPlace(scrollTop) {
  const feed = $('feed');
  // Measure the last card actually shown: the reach card itself may be hidden by a filter or
  // agent focus, and a hidden card's zero offsets would turn the tail into a large empty gap.
  const shown = state.model ? nextVisible(state.reach + 1, -1) : -1;
  const card = shown >= 0 ? cards[shown] : null;
  let tail = 6;
  if (card) {
    const bottom = card.offsetTop - feed.offsetTop + card.offsetHeight;
    tail = Math.max(6, Math.round(scrollTop + feed.clientHeight - bottom));
  }
  feed.style.setProperty('--feed-tail', tail + 'px');
  feed.scrollTop = scrollTop;
}

function scrollToCurrent(force) {
  if (!state.autoscroll && !force) return;
  const card = cards[state.pos];
  if (card && card.offsetParent !== null) card.scrollIntoView({ block: 'nearest', behavior: 'auto' });
}

// ---------------------------------------------------------------------------
// Context usage popup

const ctxChart = { series: null, forModel: null, layout: null, hover: -1 };
const CTX_PAD = { left: 52, right: 14, top: 12, bottom: 22 };

/**
 * Per-agent context sizes by event index. An agent holds the prompt size of its latest API call
 * from that call onwards; once it and all its subagents have finished (`end`), its final size
 * stays as a flat band, so the stack shows the session's accumulated context.
 */
function contextSeries() {
  const model = state.model;
  if (ctxChart.forModel === model) return ctxChart.series;
  const { events, agentList } = model;
  const N = events.length;
  const endOf = (a) => a.children.reduce((m, c) => Math.max(m, endOf(c)), a.lastIndex);
  const rows = agentList.map((a) => ({ agent: a, end: endOf(a), values: new Float64Array(N), peak: 0 }));
  const cur = new Map();
  const totals = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const e = events[i];
    if (e.context) cur.set(e.agentId, e.context);
    for (const r of rows) {
      const v = cur.get(r.agent.id) || 0;
      r.values[i] = v;
      totals[i] += v;
      if (v > r.peak) r.peak = v;
    }
  }
  let max = 0;
  for (const t of totals) if (t > max) max = t;
  ctxChart.series = { rows, byId: new Map(rows.map((r) => [r.agent.id, r])), totals, max };
  ctxChart.forModel = model;
  return ctxChart.series;
}

function fmtTokens(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(Math.round(n));
}

/** Round gridline values from zero to at least max, about four steps. */
function niceTicks(max) {
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const ticks = [];
  for (let v = 0; v < max + step; v += step) ticks.push(v);
  return ticks;
}

function drawContextChart() {
  const dlg = $('context-dialog');
  if (!dlg.open || !state.model) return;
  const canvas = $('context-canvas');
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const s = contextSeries();
  const { events } = state.model;
  const N = events.length;
  const x0 = CTX_PAD.left;
  const x1 = W - CTX_PAD.right;
  const y0 = H - CTX_PAD.bottom;
  const y1 = CTX_PAD.top;
  const X = (i) => (N <= 1 ? x0 : x0 + (i / (N - 1)) * (x1 - x0));
  ctxChart.layout = { x0, x1, N };
  const faint = cssVar('--text-faint');
  g.font = '11px ' + cssVar('--mono');
  if (!s.max) {
    g.fillStyle = faint;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('No context usage recorded in this session', W / 2, H / 2);
    renderContextTable();
    return;
  }
  const ticks = niceTicks(s.max);
  const top = ticks[ticks.length - 1];
  const Y = (v) => y0 - (v / top) * (y0 - y1);

  // Recessive gridlines and value labels.
  g.lineWidth = 1;
  g.strokeStyle = cssVar('--line');
  g.fillStyle = faint;
  g.textAlign = 'right';
  g.textBaseline = 'middle';
  for (const t of ticks) {
    const y = Math.round(Y(t)) + 0.5;
    g.beginPath();
    g.moveTo(x0, y);
    g.lineTo(x1, y);
    g.stroke();
    g.fillText(fmtTokens(t), x0 - 6, y);
  }
  g.textBaseline = 'top';
  g.textAlign = 'left';
  g.fillText('event 1', x0, y0 + 6);
  g.textAlign = 'right';
  g.fillText(`event ${N}`, x1, y0 + 6);

  // Stacked bands, bottom-up in map order; values hold until the next event (steps).
  const base = new Float64Array(N);
  const bg = cssVar('--bg');
  for (const r of s.rows) {
    if (!r.peak) continue;
    const v = r.values;
    const edge = new Path2D();
    const band = new Path2D();
    for (let i = 0; i < N; i++) {
      const xa = X(i);
      const xb = i < N - 1 ? X(i + 1) : xa;
      const y = Y(base[i] + v[i]);
      if (i === 0) { edge.moveTo(xa, y); band.moveTo(xa, y); } else { edge.lineTo(xa, y); band.lineTo(xa, y); }
      edge.lineTo(xb, y);
      band.lineTo(xb, y);
    }
    for (let i = N - 1; i >= 0; i--) {
      const xa = X(i);
      const xb = i < N - 1 ? X(i + 1) : xa;
      band.lineTo(xb, Y(base[i]));
      band.lineTo(xa, Y(base[i]));
    }
    band.closePath();
    g.globalAlpha = 0.7;
    g.fillStyle = r.agent.color;
    g.fill(band);
    g.globalAlpha = 1;
    g.strokeStyle = r.agent.color;
    g.lineWidth = 1.5;
    g.stroke(edge);
    // A thin surface-colored rule keeps neighboring bands apart.
    g.strokeStyle = bg;
    g.lineWidth = 1;
    g.translate(0, -1.25);
    g.stroke(edge);
    g.translate(0, 1.25);
    for (let i = 0; i < N; i++) base[i] += v[i];
  }

  // Playback cursor, then the hover crosshair.
  const line = (i, color, dash) => {
    const x = Math.round(X(i)) + 0.5;
    g.save();
    g.strokeStyle = color;
    g.lineWidth = 1;
    g.setLineDash(dash);
    g.beginPath();
    g.moveTo(x, y1);
    g.lineTo(x, y0);
    g.stroke();
    g.restore();
  };
  // Compactions: a dotted rule and a small agent-colored marker at the top of the plot.
  for (const e of events) {
    if (!e.compact) continue;
    line(e.index, faint, [1, 3]);
    const x = Math.round(X(e.index)) + 0.5;
    g.fillStyle = state.model.agents.get(e.agentId).color;
    g.beginPath();
    g.moveTo(x - 4, y1 - 2);
    g.lineTo(x + 4, y1 - 2);
    g.lineTo(x, y1 + 4);
    g.closePath();
    g.fill();
  }
  if (state.pos >= 0) line(state.pos, cssVar('--text'), []);
  if (ctxChart.hover >= 0) line(ctxChart.hover, faint, [3, 3]);
  renderContextTable();
}

function contextRows(i) {
  const rows = contextSeries().rows.filter((r) => i >= 0 && r.values[i] > 0);
  return rows.reverse();
}

function ctxRow(color, name, value, cls = '') {
  const row = el('div', 'ctx-row' + (cls ? ' ' + cls : ''));
  const chip = el('span', 'ctx-chip');
  if (color) chip.style.setProperty('--chip', color);
  else chip.style.visibility = 'hidden';
  row.append(chip, el('span', 'name', name), el('span', 'val', fmtNum(value)));
  return row;
}

function showContextTip(i, mx) {
  const tip = $('context-tip');
  if (i < 0) {
    tip.hidden = true;
    return;
  }
  const ev = state.model.events[i];
  tip.textContent = '';
  tip.append(el('div', 'tip-head', `#${i + 1} · ${fmtTime(ev.time)} · ${state.model.agents.get(ev.agentId).label}`));
  if (ev.compact) tip.append(el('div', 'tip-note', ev.text));
  const rows = contextRows(i);
  // Running agents are listed; finished agents keep their final size in the stack but fold
  // into one muted line so a session with many subagents keeps a readable tooltip.
  const done = rows.filter((r) => i > r.end);
  for (const r of rows) if (i <= r.end) tip.append(ctxRow(r.agent.color, r.agent.label, r.values[i]));
  if (done.length === 1) tip.append(ctxRow(done[0].agent.color, done[0].agent.label + ' (done)', done[0].values[i], 'done'));
  else if (done.length) tip.append(ctxRow('', `${done.length} finished agents`, done.reduce((s, r) => s + r.values[i], 0), 'done'));
  if (!rows.length) tip.append(el('div', 'muted', 'No context recorded yet'));
  else tip.append(ctxRow('', 'Total', contextSeries().totals[i], 'total'));
  tip.hidden = false;
  const box = $('context-chart').clientWidth;
  const w = tip.offsetWidth;
  tip.style.left = (mx + 14 + w > box ? Math.max(4, mx - 14 - w) : mx + 14) + 'px';
}

function renderContextTable() {
  const body = $('context-table').tBodies[0];
  body.textContent = '';
  const s = contextSeries();
  const i = state.pos;
  for (const r of s.rows) {
    if (!r.peak) continue;
    const now = i >= 0 ? r.values[i] : 0;
    const tr = el('tr', now && i <= r.end ? '' : 'zero');
    const name = el('td', 'agent');
    const chip = el('span', 'ctx-chip');
    chip.style.setProperty('--chip', r.agent.color);
    name.append(chip, el('span', '', r.agent.label));
    tr.append(name, el('td', 'num', now ? fmtNum(now) : '–'), el('td', 'num', fmtNum(r.peak)));
    body.appendChild(tr);
  }
  const total = el('tr');
  total.append(el('td', 'agent', 'Total'), el('td', 'num', fmtNum(i >= 0 ? s.totals[i] : 0)), el('td', 'num', fmtNum(s.max)));
  body.appendChild(total);
  $('context-sub').textContent = `Prompt tokens of each agent's latest call, stacked; finished agents stay at their final size · event ${i + 1} of ${state.model.events.length}`;
}

function contextIndexAt(e) {
  const L = ctxChart.layout;
  if (!L || !L.N) return -1;
  const rect = $('context-canvas').getBoundingClientRect();
  const t = (e.clientX - rect.left - L.x0) / (L.x1 - L.x0);
  return Math.max(0, Math.min(L.N - 1, Math.round(t * (L.N - 1))));
}

function openContextChart() {
  if (!state.model) return;
  ctxChart.hover = -1;
  $('context-tip').hidden = true;
  $('context-dialog').showModal();
  drawContextChart();
}

// ---------------------------------------------------------------------------
// Details

function section(title, body, { open = true, error = false } = {}) {
  const d = el('details', 'section' + (error ? ' error' : ''));
  d.open = open;
  const s = el('summary', '', title);
  const b = el('div', 'body');
  if (typeof body === 'string') b.appendChild(renderCode(body, ''));
  else b.appendChild(body);
  d.append(s, b);
  return d;
}

function codeFor(text, lang, opts) {
  return renderCode(text, lang || guessLanguage(text), opts);
}

function renderDetails(ev) {
  const root = $('details');
  root.textContent = '';
  const jump = $('jump-btn');
  jump.hidden = true;
  if (!ev) {
    root.appendChild(el('p', 'muted', 'Select an event.'));
    return;
  }
  const { agents } = state.model;
  const ag = agents.get(ev.agentId);
  const dl = el('dl', 'summary');
  const row = (k, v, cls) => {
    const dt = el('dt', '', k);
    const dd = el('dd', cls || '', '');
    if (v instanceof Node) dd.appendChild(v);
    else dd.textContent = v;
    dl.append(dt, dd);
  };
  if (state.model.multi) {
    const s = el('span', '', `${ag.session.harness} · ${ag.session.short} · ${firstLine(ag.session.title, 60)}`);
    s.title = ag.session.id;
    row('session', s);
  }
  const agentCell = el('span', '', ag.label);
  agentCell.style.color = ag.color;
  row('agent', agentCell);
  row('type', ev.type);
  if (ev.tool) row('tool', ev.tool);
  row('time', new Date(ev.time).toISOString().replace('T', ' ').replace('Z', ' UTC'));
  // A result recorded earlier than its call (clocks can differ between a harness's time sources) has no known duration.
  if (ev.endTime != null && ev.endTime >= ev.time) row('duration', fmtDur(ev.endTime - ev.time));
  if (ev.tokens) row('output tokens', fmtNum(ev.tokens) + (ev.model ? ` (${ev.model})` : ''));
  if (LINK_TYPES.has(ev.type)) {
    const span = el('span');
    const a = ev.from ? agents.get(ev.from) : null;
    const b = ev.to ? agents.get(ev.to) : null;
    const s1 = el('span', '', a ? a.label : ev.type === 'notification' ? ev.taskId || '?' : '?');
    if (a) s1.style.color = a.color;
    const s2 = el('span', '', b ? b.label : ev.toRef || '?');
    if (b) s2.style.color = b.color;
    span.append(s1, document.createTextNode(' → '), s2);
    row('link', span);
    if (ev.status) row('status', ev.status);
    const other = ev.agentId === ev.from ? ev.to : ev.from;
    if (other && agents.has(other) && other !== ev.agentId) {
      jump.hidden = false;
      jump.textContent = `Jump to ${agents.get(other).label}`;
      jump.onclick = () => {
        state.focus = other;
        applyFilterClasses();
        applyFocusRule();
        viewChanged();
        if (matchMedia('(max-width: 1100px)').matches) setDetailsView(false, true);
        drawTimeline();
        scrollToCurrent(true);
      };
    }
  }
  if (ev.isError) row('result', 'error', 'error');
  root.appendChild(dl);

  const inp = ev.input || {};
  if (ev.tool === 'Bash' && typeof inp.command === 'string') {
    root.appendChild(section('Command', codeFor(inp.command, 'shell')));
  } else if ((ev.tool === 'Edit' || ev.tool === 'MultiEdit') && (inp.old_string != null || Array.isArray(inp.edits))) {
    const body = el('div');
    const lang = languageForPath(inp.file_path);
    const edits = Array.isArray(inp.edits) ? inp.edits : [inp];
    edits.forEach((e, i) => {
      if (edits.length > 1) body.appendChild(el('div', 'diff-head', `edit ${i + 1}`));
      const rem = renderCode(e.old_string || '', lang);
      rem.classList.add('removed');
      const add = renderCode(e.new_string || '', lang);
      add.classList.add('added');
      body.append(rem, add);
    });
    root.appendChild(section('Change: ' + (inp.file_path || ''), body));
  } else if (ev.tool === 'Write' && typeof inp.content === 'string') {
    root.appendChild(section('Content: ' + (inp.file_path || ''), codeFor(inp.content, languageForPath(inp.file_path))));
  } else if (ev.type === 'spawn') {
    const opts = { ...inp };
    delete opts.prompt;
    root.appendChild(section('Prompt', codeFor(ev.text, 'markdown')));
    root.appendChild(section('Options', codeFor(JSON.stringify(opts, null, 2), 'json')));
  } else if (ev.type === 'message' || ev.type === 'handback' || ev.type === 'received' || ev.type === 'reply') {
    root.appendChild(section('Content', codeFor(ev.text || '', 'markdown')));
  } else if (ev.type === 'notification') {
    if (ev.text) root.appendChild(section('Result', codeFor(ev.text, '')));
    root.appendChild(section('Notification', codeFor(ev.raw || '', ''), { open: !ev.text }));
  } else if (ev.text) {
    root.appendChild(section('Content', codeFor(ev.text, ev.type === 'operator' ? 'markdown' : '')));
  }
  if (ev.input && ev.tool !== 'SubagentHandback') {
    const open = !(ev.tool === 'Bash' || ev.tool === 'Edit' || ev.tool === 'MultiEdit' || ev.tool === 'Write' || ev.type === 'spawn' || ev.type === 'message');
    root.appendChild(section('Input', codeFor(JSON.stringify(ev.input, null, 2), 'json'), { open }));
  }
  if (ev.result != null) {
    let node;
    if (ev.tool === 'Read') node = renderCode(ev.result, languageForPath(inp.file_path), { numbered: true });
    else node = codeFor(ev.result, ev.tool === 'Bash' ? '' : guessLanguage(ev.result), { numbered: ev.tool === 'Bash' });
    root.appendChild(section(ev.isError ? 'Result (error)' : 'Result', node, { error: ev.isError }));
  }
}

// ---------------------------------------------------------------------------
// Timeline

// The canvas is only ever as wide as the panel and sticks to its left edge; a track element
// behind it carries the full graph width so the panel gets a native horizontal scrollbar.
const tl = { canvas: null, ctx: null, layout: null, drag: null };

const TL_ROW_H = 18;
const TL_MIN_STEP = 7; // minimum pixels between consecutive events before the graph scrolls
const TL_LEFT = 120;
const TL_RIGHT = 14;
const TL_PAD = 8; // space before the first event so its dot is not cut by the label column
const TL_TOP = 8;
const TL_BOTTOM = 6;

function timelineLayout() {
  const canvas = tl.canvas;
  const panel = $('timeline-panel');
  const dpr = window.devicePixelRatio || 1;
  const rows = state.model.agentList.length;
  const rowH = TL_ROW_H;
  const W = panel.clientWidth;
  const H = Math.max(panel.clientHeight, TL_TOP + rows * rowH + TL_BOTTOM);
  const N = state.model.events.length;
  // Stretch to the panel; once events would sit closer than TL_MIN_STEP, widen and scroll.
  const fitW = W - TL_LEFT - TL_PAD - TL_RIGHT;
  const graphW = Math.max(fitW, (N - 1) * TL_MIN_STEP);
  const trackW = TL_LEFT + TL_PAD + graphW + TL_RIGHT;
  // Allow a scrollbar only on an axis that really overflows, so sub-pixel rounding at fractional
  // scaling can never toggle scrollbars on and off through the resize observer.
  const overflowX = graphW > fitW ? 'auto' : 'hidden';
  const overflowY = TL_TOP + rows * rowH + TL_BOTTOM > panel.clientHeight ? 'auto' : 'hidden';
  if (panel.style.overflowX !== overflowX) panel.style.overflowX = overflowX;
  if (panel.style.overflowY !== overflowY) panel.style.overflowY = overflowY;
  const track = $('timeline-track');
  if (track.style.width !== trackW + 'px') track.style.width = trackW + 'px';
  if (track.style.height !== H + 'px') track.style.height = H + 'px';
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
  }
  const step = N <= 1 ? 0 : graphW / (N - 1);
  const scroll = panel.scrollLeft;
  // Track coordinates (independent of scrolling) and canvas coordinates (what is drawn).
  const trackX = (i) => TL_LEFT + TL_PAD + i * step;
  const xOf = (i) => trackX(i) - scroll;
  const iOf = (x) => (step ? Math.round((x + scroll - TL_LEFT - TL_PAD) / step) : 0);
  return { W, H, dpr, rows, rowH, step, scroll, graphW, trackW, trackX, xOf, iOf };
}

function drawTimeline() {
  if (!state.model || !tl.canvas) return;
  const L = timelineLayout();
  tl.layout = L;
  const ctx = tl.ctx;
  ctx.setTransform(L.dpr, 0, 0, L.dpr, 0, 0);
  ctx.clearRect(0, 0, L.W, L.H);
  const { agentList, events, agents } = state.model;
  const yOf = (row) => TL_TOP + row * L.rowH;
  const cy = (row) => yOf(row) + L.rowH / 2;
  const bg = cssVar('--bg') || '#000';
  // Row highlight for the focused agent.
  for (const a of agentList) {
    if (state.focus !== a.id) continue;
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fillRect(0, yOf(a.row), L.W, L.rowH);
  }
  // Everything in event space is clipped to the graph area so it never runs under the labels.
  ctx.save();
  ctx.beginPath();
  ctx.rect(TL_LEFT, 0, L.W - TL_LEFT, L.H);
  ctx.clip();
  // Token areas: a faint fill that climbs with each agent's output tokens over its run.
  for (const a of agentList) {
    if (!a.events.length) continue;
    let total = 0;
    for (const e of a.events) total += e.tokens || 0;
    if (!total) continue;
    const base = yOf(a.row) + L.rowH - 1;
    ctx.fillStyle = a.color;
    ctx.globalAlpha = 0.13;
    ctx.beginPath();
    ctx.moveTo(L.xOf(a.firstIndex), base);
    let acc = 0;
    for (const e of a.events) {
      acc += e.tokens || 0;
      ctx.lineTo(L.xOf(e.index), base - (acc / total) * (L.rowH - 3));
    }
    ctx.lineTo(L.xOf(a.lastIndex), base);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  // Lanes: each agent is a branch, a line in its colour from its first event to its last.
  // The part already played is bright; the rest is dim.
  const lane = (a, from, to, alpha) => {
    if (to <= from) return;
    ctx.strokeStyle = a.color;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.moveTo(L.xOf(from), cy(a.row));
    ctx.lineTo(L.xOf(to), cy(a.row));
    ctx.stroke();
  };
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  for (const a of agentList) {
    if (a.firstIndex < 0) continue;
    const split = Math.max(a.firstIndex, Math.min(a.lastIndex, state.pos));
    lane(a, a.firstIndex, split, 0.9);
    lane(a, split, a.lastIndex, 0.3);
  }
  // Links: a curve that leaves the sender's lane at the sending event and joins the receiver's
  // lane at the event where it picked the message up, like a branch forking off or merging back.
  const curve = (x0, y0, x1, y1) => {
    const mx = (x0 + x1) / 2;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.bezierCurveTo(mx, y0, mx, y1, x1, y1);
    ctx.stroke();
  };
  const drawLink = (e, emphasis) => {
    const a = agents.get(e.from);
    const b = agents.get(e.to);
    const next = b.events.find((ev) => ev.index > e.index);
    const x0 = L.xOf(e.index);
    const x1 = next ? L.xOf(next.index) : x0;
    const y0 = cy(a.row);
    const y1 = cy(b.row);
    if (Math.max(x0, x1) < TL_LEFT - 4 || Math.min(x0, x1) > L.W + 4) return;
    // Spawns and reports back are branch lines in the child's colour; other traffic keeps its
    // event colour.
    const branch = e.type === 'spawn' ? b : e.type === 'handback' ? a : null;
    const color = emphasis ? '#fff' : branch ? branch.color : cssVar(TYPE_COLORS[e.type]);
    ctx.strokeStyle = color;
    ctx.lineWidth = emphasis ? 2.5 : branch ? 2 : 1.25;
    ctx.globalAlpha = emphasis ? 1 : e.index <= state.pos ? 0.9 : 0.3;
    if (next) curve(x0, y0, x1, y1);
    else {
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x0, y1);
      ctx.stroke();
    }
  };
  // Delivery copies are not drawn: the sending side already shows the transfer.
  for (const e of events) if (e.linkKey && !e.delivery && e.index !== state.pos) drawLink(e, false);
  if (state.pos >= 0 && events[state.pos].linkKey && !events[state.pos].delivery) drawLink(events[state.pos], true);
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1;
  // Events: a dot in the event colour on the agent's lane, ringed in the background so dots
  // stay separate from the lane and from each other.
  const first = Math.max(0, L.iOf(TL_LEFT) - 1);
  const last = Math.min(events.length - 1, L.iOf(L.W) + 1);
  ctx.strokeStyle = bg;
  ctx.lineWidth = 1;
  for (let i = first; i <= last; i++) {
    const e = events[i];
    const a = agents.get(e.agentId);
    ctx.fillStyle = cssVar(TYPE_COLORS[e.type]);
    ctx.globalAlpha = e.index <= state.pos ? 1 : 0.4;
    ctx.beginPath();
    ctx.arc(L.xOf(e.index), cy(a.row), 2.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  // Cursor: a line through the current position with a ring around the current event.
  if (state.pos >= 0) {
    const x = Math.round(L.xOf(state.pos)) + 0.5;
    const e = events[state.pos];
    ctx.strokeStyle = '#fff';
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, L.H);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, cy(agents.get(e.agentId).row), 4.5, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
  // Labels sit on top in a fixed column.
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, TL_LEFT, L.H);
  ctx.fillStyle = cssVar('--line') || '#222';
  ctx.fillRect(TL_LEFT - 1, 0, 1, L.H);
  // Several sessions: a rule across the whole graph separates one session's rows from the next.
  if (state.model.multi) {
    ctx.fillStyle = cssVar('--line-strong') || '#383838';
    for (const a of agentList) if (a.isMain && a.row) ctx.fillRect(0, yOf(a.row), L.W, 1);
  }
  ctx.font = '11px ' + cssVar('--mono');
  ctx.textBaseline = 'middle';
  for (const a of agentList) {
    if (state.focus === a.id) {
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.fillRect(0, yOf(a.row), TL_LEFT, L.rowH);
    }
    const dimmed = state.focus && state.focus !== a.id;
    ctx.fillStyle = dimmed ? '#808080' : state.model.multi && a.isMain ? '#e0e0e0' : '#b0b0b0';
    const x = 6 + a.depth * 6;
    let label = a.label;
    const available = Math.max(0, TL_LEFT - x - 6);
    if (ctx.measureText(label).width > available) {
      while (label && ctx.measureText(label + '…').width > available) label = label.slice(0, -1);
      label += '…';
    }
    ctx.fillText(label, x, cy(a.row), Math.max(1, available));
  }
}

/** Scroll the timeline panel so the current event's agent row is visible. */
function revealTimelineRow() {
  if (!state.model || state.pos < 0) return;
  const panel = $('timeline-panel');
  if (panel.scrollHeight <= panel.clientHeight) return;
  const a = state.model.agents.get(state.model.events[state.pos].agentId);
  const y = TL_TOP + a.row * TL_ROW_H;
  if (y < panel.scrollTop) panel.scrollTop = y - TL_ROW_H;
  else if (y + TL_ROW_H > panel.scrollTop + panel.clientHeight) panel.scrollTop = y + TL_ROW_H * 2 - panel.clientHeight;
}

/**
 * Keep the cursor in view when the graph is wider than the panel. Once the cursor passes the
 * middle of the visible graph it is held there, so playback scrolls the graph past it; when
 * `edge` is set (a click or scrub on the timeline) the view only moves if the cursor would be hidden.
 */
function revealTimelineCursor(edge = false) {
  if (!state.model || state.pos < 0 || !tl.layout || (tl.drag && tl.drag.pan)) return;
  const panel = $('timeline-panel');
  const L = tl.layout;
  if (L.trackW <= L.W) return;
  const cx = L.trackX(state.pos);
  const viewW = L.W - TL_LEFT;
  const visible = cx >= panel.scrollLeft + TL_LEFT && cx <= panel.scrollLeft + L.W - TL_RIGHT;
  if (edge && visible) return;
  const mid = panel.scrollLeft + TL_LEFT + viewW / 2;
  if (edge || cx > mid || !visible) {
    const target = Math.max(0, Math.min(L.trackW - L.W, cx - TL_LEFT - viewW / 2));
    if (Math.abs(target - panel.scrollLeft) >= 1) panel.scrollLeft = target;
  }
}

/** Seek to the event under the pointer; used for a left press and while it is held. */
function timelineSeekAt(clientX) {
  const rect = tl.canvas.getBoundingClientRect();
  const N = state.model.events.length;
  const i = Math.max(0, Math.min(N - 1, tl.layout.iOf(clientX - rect.left)));
  if (i !== state.pos) seek(i, { select: true, manual: true, edge: true });
}

// Left button: seek, and keep seeking while held (scrubbing). Right button: drag to pan.
function timelinePointerDown(e) {
  if (!tl.layout || !state.model || tl.drag) return;
  if (e.button === 2) {
    tl.drag = { pan: true, x: e.clientX, scroll: $('timeline-panel').scrollLeft, id: e.pointerId };
    tl.canvas.classList.add('dragging');
  } else if (e.button === 0) {
    const rect = tl.canvas.getBoundingClientRect();
    if (e.clientX - rect.left < TL_LEFT) return;
    tl.drag = { pan: false, id: e.pointerId };
    timelineSeekAt(e.clientX);
  } else return;
  tl.canvas.setPointerCapture(e.pointerId);
}

function timelinePointerMove(e) {
  const d = tl.drag;
  if (!d || e.pointerId !== d.id) return;
  if (d.pan) $('timeline-panel').scrollLeft = d.scroll - (e.clientX - d.x);
  else timelineSeekAt(e.clientX);
}

function timelinePointerUp(e) {
  const d = tl.drag;
  if (!d || e.pointerId !== d.id) return;
  tl.drag = null;
  tl.canvas.classList.remove('dragging');
}

// ---------------------------------------------------------------------------
// Position and playback

const stats = { agents: new Map(), links: new Map() };

function resetStats() {
  stats.agents.clear();
  stats.links.clear();
  for (const a of state.model.agentList) stats.agents.set(a.id, { events: 0, tokens: 0 });
  for (const k of state.model.links.keys()) stats.links.set(k, 0);
}

function applyDelta(oldPos, newPos) {
  const events = state.model.events;
  const step = (i, sign) => {
    const e = events[i];
    const s = stats.agents.get(e.agentId);
    s.events += sign;
    s.tokens += sign * (e.tokens || 0);
    if (e.linkKey) stats.links.set(e.linkKey, (stats.links.get(e.linkKey) || 0) + sign);
  };
  if (newPos > oldPos) for (let i = oldPos + 1; i <= newPos; i++) step(i, 1);
  else for (let i = newPos + 1; i <= oldPos; i++) step(i, -1);
}

function seek(i, { select = false, manual = false, animate = false, edge = false } = {}) {
  if (!state.model) return;
  const N = state.model.events.length;
  i = Math.max(-1, Math.min(N - 1, i));
  const old = state.pos;
  if (i !== old) {
    const feedTop = $('feed').scrollTop;
    applyDelta(old, i);
    state.pos = i;
    updateFeed(old, i);
    keepFeedPlace(feedTop);
    updateMap(stats.agents, stats.links);
    drawTimeline();
    drawContextChart();
    revealTimelineRow();
    revealTimelineCursor(edge);
    revealMapBox();
    $('scrubber').value = i;
    $('position').textContent = `${i + 1} / ${N}`;
    if (animate && i >= 0) animateDot(state.model.events[i]);
    // Explicit navigation always reveals the current card; playback respects the follow toggle.
    scrollToCurrent(manual);
  }
  // Moving back by hand leaves the live edge; reaching the last visible event returns to it.
  const atEnd = nextVisible(i, 1) < 0;
  if (atEnd) state.liveBehind = false;
  else if (manual) {
    state.liveBehind = true;
    // Live playback of incoming events would carry the selection away from where the reader looked back.
    if (state.live && state.playing) setPlaying(false);
  }
  setLiveBehind();
  if (select || manual) {
    state.selected = i;
    renderDetails(i >= 0 ? state.model.events[i] : null);
  } else if (state.selected !== i) {
    state.selected = i;
    renderDetails(i >= 0 ? state.model.events[i] : null);
  }
  if (manual && state.playing) {
    /* keep playing from the new place */
    schedule();
  }
}

function stepFwd({ animate = true, manual = true } = {}) {
  const n = nextVisible(state.pos, 1);
  if (n < 0) return false;
  seek(n, { animate, manual });
  return true;
}
function stepBack({ manual = true } = {}) {
  const n = nextVisible(state.pos, -1);
  if (n < 0) return false;
  seek(n, { manual });
  return true;
}

function delayFor(from, to) {
  const speed = parseFloat($('speed').value) || 1;
  if ($('pacing').value === 'real' && from >= 0) {
    const gap = state.model.events[to].time - state.model.events[from].time;
    return Math.max(40, Math.min(2500, gap / speed));
  }
  return 700 / speed;
}

function schedule() {
  clearTimeout(state.timer);
  if (!state.playing) return;
  const n = nextVisible(state.pos, 1);
  if (n < 0) {
    setPlaying(false);
    return;
  }
  state.timer = setTimeout(() => {
    if (!state.playing) return;
    seek(n, { animate: true });
    schedule();
  }, delayFor(state.pos, n));
}

function setPlaying(on) {
  state.playing = on;
  $('play-btn').textContent = on ? '❚❚' : '▶';
  $('play-btn').title = on ? 'Pause (Space)' : 'Play (Space)';
  $('play-btn').setAttribute('aria-label', on ? 'Pause' : 'Play');
  if (on) schedule();
  else clearTimeout(state.timer);
}

function togglePlay() {
  if (!state.model) return;
  if (state.playing) return setPlaying(false);
  if (nextVisible(state.pos, 1) < 0) {
    // playing from the end starts again from the beginning
    seek(-1, {});
    const first = nextVisible(-1, 1);
    if (first >= 0) seek(first, { animate: true });
  }
  setPlaying(true);
}

// ---------------------------------------------------------------------------
// Loading a session into the viewer

function showViewer(on) {
  setDetailsView(false);
  state.landing = !on;
  $('landing').hidden = on;
  $('viewer').hidden = !on;
  document.body.classList.toggle('in-viewer', on);
  // The landing page scrolls the document; the viewer must start from the top.
  window.scrollTo(0, 0);
}

function setDetailsView(open, focus = false) {
  $('grid').classList.toggle('show-details', open);
  $('details-toggle').setAttribute('aria-expanded', String(open));
  if (focus) $(open ? 'details-close' : 'details-toggle').focus();
}

function eventKey(e) {
  return e.agentId + ':' + (e.record?.uuid || '') + ':' + (e.block ?? '') + ':' + e.type;
}

function currentKey() {
  const e = state.model && state.pos >= 0 ? state.model.events[state.pos] : null;
  return e ? eventKey(e) : null;
}

function findKey(model, key) {
  if (!key) return -1;
  for (const e of model.events) if (eventKey(e) === key) return e.index;
  return -1;
}

function installModel(loadedList, { keepState = false } = {}) {
  const prevKey = keepState ? currentKey() : null;
  const prevReachKey = keepState && state.reach >= 0 ? eventKey(state.model.events[state.reach]) : null;
  const prevReach = state.reach;
  const prevPos = state.pos;
  const prevN = state.model ? state.model.events.length : 0;
  const wasAtEnd = keepState && state.model && (state.playing || nextVisible(state.pos, 1) < 0);
  const prevScroll = keepState ? $('feed').scrollTop : 0;
  const prevBehind = state.liveBehind;
  const model = buildModel(loadedList);
  state.sessions = Array.isArray(loadedList) ? loadedList : [loadedList];
  state.model = model;
  if (!keepState || (state.focus && !model.agents.has(state.focus))) state.focus = null;
  clearTimeout(state.timer);
  const N = model.events.length;
  const idEl = $('session-id');
  // The harness label names the tool that wrote the transcripts; several appear when sessions differ.
  $('harness').textContent = [...new Set(model.sessions.map((s) => s.harness))].join(' · ');
  if (model.multi) {
    idEl.textContent = `${model.sessions.length} sessions · ${model.sessions.map((s) => s.short).join(' · ')}`;
    idEl.title = model.sessions.map((s) => `${s.id}\n  ${firstLine(s.title, 80)}`).join('\n');
  } else {
    idEl.textContent = model.sessions[0].id;
    idEl.title = 'Session id';
  }
  $('stat-agents').textContent = model.agentList.length;
  $('stat-events').textContent = fmtNum(N);
  $('stat-span').textContent = N ? fmtDur(model.events[N - 1].time - model.events[0].time) : '0s';
  $('stat-tokens').textContent = fmtNum(model.totalTokens);
  const tokenNotes = HARNESSES.filter((h) => h.TOKEN_NOTE && model.sessions.some((s) => harnessNamed(s.harness) === h)).map((h) => h.TOKEN_NOTE);
  $('stat-tokens').parentElement.title = ['Recorded output tokens across loaded agents.', ...tokenNotes].join(' ');
  const ctxTotals = contextSeries().totals;
  $('stat-context').textContent = fmtNum(N ? ctxTotals[N - 1] : 0);
  $('scrubber').max = Math.max(0, N - 1);
  // Panel height = rows + padding + the 1px top border, so a timeline that fits shows no vertical
  // scrollbar; a graph wider than the panel gets room for its horizontal scrollbar.
  const wide = (N - 1) * TL_MIN_STEP > $('timeline-panel').clientWidth - TL_LEFT - TL_PAD - TL_RIGHT;
  document.documentElement.style.setProperty('--timeline-h', Math.min(260, Math.max(90, 15 + (wide ? 12 : 0) + model.agentList.length * TL_ROW_H)) + 'px');
  renderMap();
  renderFeed();
  applyFocusRule();
  resetStats();
  if (!keepState) state.liveBehind = false;
  state.pos = -1;
  state.reach = -1;
  state.selected = -1;
  let target;
  if (!keepState) target = N ? 0 : -1;
  else {
    const k = findKey(model, prevKey);
    target = k >= 0 ? k : Math.min(prevPos, N - 1);
    const r = findKey(model, prevReachKey);
    const reach = Math.max(target, r >= 0 ? r : Math.min(prevReach, N - 1));
    // Re-show everything up to the previous reach, then step back to the kept place.
    if (reach > target) {
      seek(reach, {});
    }
  }
  seek(target, { select: !keepState });
  if (keepState) {
    // The interim seek to the old reach must not count as returning to the live edge.
    if (prevBehind && nextVisible(state.pos, 1) >= 0) state.liveBehind = true;
    setLiveBehind();
    $('feed').scrollTop = prevScroll;
    // A reload can make the current card taller (a tool result arrives), so following re-reveals it.
    scrollToCurrent();
  }
  if (keepState && wasAtEnd && N > prevN) {
    // new events play automatically and playback stops at the new end
    if (!state.playing) setPlaying(true);
  } else if (keepState && state.playing) schedule();
  drawTimeline();
}

/** Session ids named by the URL's `session` parameter: one id, or several separated by commas. */
function urlSessions() {
  const v = new URL(location.href).searchParams.get('session') || '';
  return [...new Set(v.split(',').map((s) => s.trim()).filter(Boolean))];
}

function setUrlSession(ids, push) {
  const url = new URL(location.href);
  const value = (ids || []).join(',');
  if (value) url.searchParams.set('session', value);
  else url.searchParams.delete('session');
  // Keep the commas between ids readable in the address bar.
  url.search = url.search.replace(/%2C/gi, ',');
  if (url.href === location.href) return;
  if (push) history.pushState({ session: value || null }, '', url);
  else history.replaceState({ session: value || null }, '', url);
}

/** Grey out the landing page while sessions load; the chosen rows stay highlighted. */
function setListLoading(ids) {
  const landing = $('landing');
  landing.classList.toggle('loading', !!(ids && ids.length));
  const chosen = new Set(ids || []);
  for (const li of document.querySelectorAll('.session-row')) li.classList.toggle('chosen', chosen.has(li.dataset.id));
}

function openSession(id, opts) {
  return openSessions([id], opts);
}

/** Open one mounted session, or several together in one time-ordered view. */
async function openSessions(ids, { push = true } = {}) {
  ids = [...new Set(ids)];
  if (!state.source || state.opening || !ids.length) return;
  state.opening = true;
  stopLive();
  setPlaying(false);
  setListLoading(ids);
  try {
    const list = [];
    for (const id of ids) list.push(await state.source.load(id));
    showMsg('');
    showViewer(true);
    state.playing = false;
    installModel(list);
    setUrlSession(ids, push);
    const newest = Math.max(...list.flatMap((l) => l.files.map((f) => f.mtime)));
    $('live-btn').hidden = false;
    if (Date.now() - newest < LIVE_WINDOW_MS) startLive();
    else setLiveButton();
  } catch (e) {
    showMsg((ids.length > 1 ? 'Could not load sessions: ' : 'Could not load session: ') + (e.message || e), true);
  } finally {
    state.opening = false;
    setListLoading(null);
  }
}

async function openFileList(files) {
  stopLive();
  setPlaying(false);
  try {
    const loaded = await loadFiles(files);
    showMsg('');
    showViewer(true);
    installModel([loaded]);
    $('live-btn').hidden = true;
    setUrlSession(null, false);
  } catch (e) {
    showMsg('Could not open files: ' + (e.message || e), true);
  }
}

// ---------------------------------------------------------------------------
// Live mode

function setLiveButton(status) {
  const b = $('live-btn');
  b.classList.toggle('on', state.live && status !== 'reconnecting');
  b.classList.toggle('reconnecting', state.live && status === 'reconnecting');
  b.textContent = state.live ? (status === 'reconnecting' ? 'Live (reconnecting)' : '● Live') : 'Live';
  b.setAttribute('aria-pressed', String(state.live));
  setLiveBehind();
}

/** A live session viewed away from its latest event shows a white, still Live button. */
function setLiveBehind() {
  const b = $('live-btn');
  const behind = state.live && state.liveBehind;
  b.classList.toggle('behind', behind);
  b.title = behind ? 'Jump to the latest event and follow updates' : state.live ? 'Stop following this session' : 'Follow this session as it is written';
  if (!behind) setSnapArmed(false);
}

/** Show or hide the "scroll again" hint once a behind-live reader reaches the feed's bottom. */
let snapArmed = false;
function setSnapArmed(on) {
  if (snapArmed === on) return;
  snapArmed = on;
  $('feed-hint').hidden = !on;
}

/** Return a live session to its latest event and resume following the conversation. */
function snapToLive() {
  const last = nextVisible(state.model.events.length, -1);
  setFollow(true);
  if (last >= 0) seek(last, { select: true, manual: true });
  scrollToCurrent(true);
}

function startLive() {
  if (state.live || !state.sessions || state.sessions.some((s) => s.fromFiles)) return;
  state.live = true;
  setLiveButton();
  // jump to the latest event
  const N = state.model.events.length;
  if (N) seek(N - 1, { select: true });
  state.liveTimer = setInterval(liveTick, 1000);
}

function stopLive() {
  if (!state.live) return;
  state.live = false;
  clearInterval(state.liveTimer);
  setLiveButton();
}

async function liveTick() {
  if (!state.live || !state.sessions) return;
  if (state.reloading) {
    state.reloadAgain = true;
    return;
  }
  const changed = [];
  try {
    for (const s of state.sessions) if (await state.source.changed(s)) changed.push(s.id);
    setLiveButton();
  } catch {
    setLiveButton('reconnecting');
    return;
  }
  if (!changed.length) return;
  await liveReload(changed);
}

/** Reload the named sessions (all of them when none are named) and rebuild the combined model. */
async function liveReload(ids) {
  state.reloading = true;
  try {
    const want = new Set(ids && ids.length ? ids : state.sessions.map((s) => s.id));
    const list = [];
    for (const s of state.sessions) list.push(want.has(s.id) ? await state.source.load(s.id) : s);
    if (!state.live) return;
    installModel(list, { keepState: true });
  } catch {
    setLiveButton('reconnecting');
  } finally {
    state.reloading = false;
    if (state.reloadAgain) {
      state.reloadAgain = false;
      if (state.live) liveReload();
    }
  }
}

// ---------------------------------------------------------------------------
// Landing page

function showMsg(text, error = false) {
  const m = $('landing-msg');
  m.hidden = !text;
  m.textContent = text;
  m.classList.toggle('error', error);
}

function setSourceLabel() {
  const src = $('source');
  const server = state.source && state.source.kind === 'server';
  if (server) {
    src.textContent = `Source: server · ${state.source.root} (${state.source.count} sessions)`;
    src.title = 'The transcripts directory is read by the Node server that serves this page';
  } else if (state.scan) {
    const count = state.directories.filter((f) => f.scan).length;
    src.textContent = `${count} ${count === 1 ? 'directory' : 'directories'} connected · ${state.scan.sessions.length} sessions`;
  }
  else src.textContent = supportsMount ? 'Add a Claude or Codex directory to list sessions.' : 'This browser cannot mount directories; use Open files….';
  // In server mode the directory is chosen on the command line, so the mounting controls stay hidden.
  $('mount-btn').hidden = server || !supportsMount;
  const list = $('directory-sources');
  list.replaceChildren();
  list.hidden = server || !state.directories.length;
  for (const directory of state.directories) {
    const item = el('li', 'directory-source');
    const label = [directory.scan?.harness, directory.handle.name].filter(Boolean).join(' · ');
    item.append(el('span', 'directory-source-name', label + (directory.scan ? ` (${directory.scan.sessions.length} sessions)` : ' · needs reconnecting')));
    if (!directory.scan) {
      const reconnect = el('button', 'small', 'Reconnect');
      reconnect.type = 'button';
      reconnect.setAttribute('aria-label', 'Reconnect ' + label);
      reconnect.addEventListener('click', () => connect(directory.handle, { ask: true }));
      item.append(reconnect);
    }
    const remove = el('button', 'small', 'Remove directory');
    remove.type = 'button';
    remove.setAttribute('aria-label', 'Remove directory ' + label);
    remove.addEventListener('click', async () => {
      try {
        await removeDirectory(directory.handle);
        state.directories = state.directories.filter((f) => f !== directory);
        rebuildLocalSource();
        const ids = new Set(state.scan?.sessions.map((s) => s.id) || []);
        for (const id of state.picked.keys()) if (!ids.has(id)) state.picked.delete(id);
        renderPickBar();
        setSourceLabel();
        await loadList();
        $('mount-btn').focus();
      } catch (e) { showMsg('Could not remove directory: ' + e.message, true); }
    });
    item.append(remove);
    list.append(item);
  }
}

function rebuildLocalSource() {
  const scans = state.directories.map((f) => f.scan).filter(Boolean);
  state.scan = scans.length ? combineScans(scans) : null;
  state.source = state.scan ? localSource() : null;
}

/** The source interface over a mounted directory; server mode gets the same shape from remote.mjs. */
function localSource() {
  return {
    kind: 'local',
    list: (opts) => listSessions(state.scan, opts),
    load: (id) => loadSession(state.scan, id),
    changed: (loaded) => sessionChanged(state.scan, loaded),
    async stat(id) {
      const session = state.scan.sessions.find((x) => x.id === id);
      if (!session) return null;
      const f = await session.file.getFile();
      return { mtime: f.lastModified, size: f.size };
    },
    async rescan() {
      for (const directory of state.directories) {
        if (await permissionState(directory.handle) !== 'granted') directory.scan = null;
        else directory.scan = await scanDirectory(directory.handle);
      }
      rebuildLocalSource();
    },
  };
}

function sessionRow(s) {
  const li = el('li', 'session-row');
  li.tabIndex = 0;
  li.dataset.id = s.id;
  li.classList.toggle('picked', state.picked.has(s.id));
  const pick = el('input', 'pick');
  pick.type = 'checkbox';
  pick.checked = state.picked.has(s.id);
  pick.setAttribute('aria-label', 'Select this session to open with others');
  pick.addEventListener('change', () => togglePick(s, pick.checked));
  // The whole leading strip of the row toggles the box, so it need not be hit exactly; its
  // clicks never reach the row, which would open the session.
  const pickArea = el('label', 'pick-area');
  pickArea.title = 'Select to open together with other sessions';
  pickArea.addEventListener('click', (e) => e.stopPropagation());
  pickArea.appendChild(pick);
  li.appendChild(pickArea);
  const title = el('div', 'title');
  const harness = el('span', 'harness', harnessNamed(s.harness).NAME);
  harness.title = 'Harness that wrote the transcript';
  title.append(el('span', 'title-text', s.title || s.firstPrompt || s.id), harness, el('span', 'badge-live', 'live'));
  title.title = s.title || s.firstPrompt || s.id;
  li.appendChild(title);
  if (s.title && s.firstPrompt) li.appendChild(el('div', 'first', s.firstPrompt));
  const meta = el('div', 'meta');
  // Figures are bold like the viewer's top bar; their units stay muted.
  const stat = (value, unit, title) => {
    const span = el('span', 'stat');
    span.append(el('b', '', value), ' ' + unit);
    if (title) span.title = title;
    return span;
  };
  meta.append(el('span', 'mono', s.cwd || s.project));
  meta.append(stat(fmtNum(s.prompts), s.prompts === 1 ? 'prompt' : 'prompts'), stat(fmtNum(s.subagents), s.subagents === 1 ? 'subagent' : 'subagents'));
  if (s.context) meta.append(stat(fmtTokens(s.context), 'context', `Main session context at its latest reply: ${fmtNum(s.context)} tokens`));
  if (s.model) meta.append(el('span', 'model', [s.model, s.effort].filter(Boolean).join(' · ')));
  meta.firstChild.title = s.cwd || s.project;
  li.appendChild(meta);
  const side = el('div', 'side');
  side.append(el('span', 'ago', fmtRel(s.mtime)), el('span', 'size', fmtSize(s.size)), el('span', 'mono', shortId(s.id)));
  li.appendChild(side);
  li._session = s;
  refreshRow(li, s.mtime, s.size);
  const go = () => openSession(s.id);
  // A plain click opens the session; Ctrl/Cmd-click or Space adds it to the selection instead.
  li.addEventListener('click', (e) => {
    if (e.ctrlKey || e.metaKey) togglePick(s);
    else go();
  });
  li.addEventListener('keydown', (e) => {
    if (e.target !== li) return;
    if (e.key === 'Enter') go();
    else if (e.key === ' ') {
      e.preventDefault();
      togglePick(s);
    }
  });
  return li;
}

/** Add a session to, or remove it from, the set opened together; rows and the bar follow. */
function togglePick(s, on = !state.picked.has(s.id)) {
  if (on) state.picked.set(s.id, s);
  else state.picked.delete(s.id);
  for (const li of document.querySelectorAll('.session-row')) {
    if (li.dataset.id !== s.id) continue;
    li.classList.toggle('picked', on);
    li.querySelector('.pick').checked = on;
  }
  renderPickBar();
}

function clearPicks() {
  state.picked.clear();
  for (const li of document.querySelectorAll('.session-row.picked')) {
    li.classList.remove('picked');
    li.querySelector('.pick').checked = false;
  }
  renderPickBar();
}

/**
 * The bar above the list naming the picked sessions, with Open together and Clear. It always
 * occupies its row: empty, it shows a quiet hint, so ticking the first session never shifts the list.
 */
function renderPickBar() {
  const n = state.picked.size;
  const bar = $('pick-bar');
  bar.classList.toggle('empty', !n);
  if (!n) return;
  $('pick-count').textContent = n === 1 ? '1 selected' : `${n} selected`;
  const chips = $('pick-chips');
  chips.textContent = '';
  for (const s of state.picked.values()) {
    const chip = el('button', 'pick-chip');
    chip.type = 'button';
    chip.title = `${s.title || s.firstPrompt || s.id}\nRemove from the selection`;
    chip.append(el('span', 'mono', shortId(s.id)), el('span', 'x', '×'));
    chip.addEventListener('click', () => togglePick(s, false));
    chips.appendChild(chip);
  }
  const open = $('pick-open-btn');
  open.textContent = n === 1 ? 'Open' : `Open ${n} together`;
  open.title = n === 1 ? 'Open the selected session' : 'Open the selected sessions in one time-ordered view';
}

function refreshRow(li, mtime, size) {
  li.classList.toggle('live', Date.now() - mtime < LIVE_WINDOW_MS);
  li.querySelector('.ago').textContent = fmtRel(mtime);
  li.querySelector('.size').textContent = fmtSize(size);
}

/** Re-check the listed files so live badges and "ago" times stay current without a reload. */
async function refreshListStatus() {
  if (!state.landing || !state.source) return;
  for (const li of document.querySelectorAll('.session-row')) {
    const s = li._session;
    try {
      const f = await state.source.stat(s.id);
      if (!f) continue;
      s.mtime = f.mtime;
      s.size = f.size;
    } catch {
      /* keep the old values */
    }
    refreshRow(li, s.mtime, s.size);
  }
}

let listBusyTimer = null;
let listBusySince = 0;
const LIST_BUSY_DELAY_MS = 150;
const LIST_BUSY_MIN_MS = 450;

/**
 * Mark the session list as refreshing. Automatic reloads show the mark only after a short delay,
 * so a quick one swaps the rows without anything flashing; an explicit Refresh (`now`) shows it at
 * once. Once shown, the mark stays long enough to be read.
 */
function setListBusy(on, { now = false } = {}) {
  const landing = $('landing');
  const shown = landing.classList.contains('refreshing');
  const show = () => {
    listBusySince = Date.now();
    landing.classList.add('refreshing');
  };
  $('session-list').setAttribute('aria-busy', on ? 'true' : 'false');
  clearTimeout(listBusyTimer);
  if (on) {
    if (shown) return;
    if (now) show();
    else listBusyTimer = setTimeout(show, LIST_BUSY_DELAY_MS);
    return;
  }
  const left = listBusySince + LIST_BUSY_MIN_MS - Date.now();
  if (shown && left > 0) listBusyTimer = setTimeout(() => landing.classList.remove('refreshing'), left);
  else landing.classList.remove('refreshing');
}

async function loadList({ reset = true } = {}) {
  const token = ++state.list.token;
  if (reset) setListBusy(true);
  try {
    await loadListPage(token, reset);
  } finally {
    if (token === state.list.token) setListBusy(false);
  }
}

async function loadListPage(token, reset) {
  if (!state.source) {
    $('session-list').replaceChildren();
    $('more-btn').hidden = true;
    $('list-end').hidden = true;
    return;
  }
  if (reset) {
    state.list.offset = 0;
    state.list.done = false;
  } else {
    $('more-btn').hidden = true;
    $('list-end').hidden = true;
  }
  $('more-btn').disabled = true;
  try {
    const { items, done, next } = await state.source.list({ offset: state.list.offset, limit: PAGE, filter: state.list.filter });
    if (token !== state.list.token) return;
    const list = $('session-list');
    // A reset keeps the old rows until the new page is ready and swaps them in one step, so
    // returning to the list or refiltering does not flash an empty list.
    const rows = items.map(sessionRow);
    if (reset) list.replaceChildren(...rows);
    else list.append(...rows);
    state.list.offset = next;
    state.list.done = done;
    $('more-btn').hidden = done;
    $('more-btn').disabled = false;
    $('list-end').hidden = !done;
    if (done && !list.children.length) $('list-end').textContent = state.list.filter ? 'No sessions match' : 'No sessions found';
    else $('list-end').textContent = 'No more sessions';
  } catch (e) {
    if (token !== state.list.token) return;
    if (reset) $('session-list').replaceChildren();
    showMsg('Could not list sessions: ' + (e.message || e), true);
  }
}

async function connect(handle, { ask = false, refresh = true } = {}) {
  let directory = state.directories.find((f) => f.handle === handle);
  if (!directory) {
    for (const f of state.directories) if (await f.handle.isSameEntry(handle)) { directory = f; break; }
  }
  if (!directory) { directory = { handle, scan: null }; state.directories.push(directory); }
  let perm = await permissionState(handle);
  if (perm !== 'granted' && ask) perm = (await requestPermission(handle)) ? 'granted' : perm;
  if (perm !== 'granted') {
    directory.scan = null;
    rebuildLocalSource();
    setSourceLabel();
    showMsg(`Click "Reconnect" to restore access to "${handle.name}".`);
    return false;
  }
  showMsg('Scanning directory…');
  try {
    directory.scan = await scanDirectory(handle);
    rebuildLocalSource();
  } catch (e) {
    directory.scan = null;
    rebuildLocalSource();
    setSourceLabel();
    showMsg('Could not read the directory: ' + (e.message || e), true);
    return false;
  }
  showMsg('');
  setSourceLabel();
  if (refresh) await loadList();
  const wanted = urlSessions();
  if (refresh && wanted.length && state.landing) openSessions(wanted, { push: false });
  return true;
}

async function doMount() {
  const button = $('choose-directory-btn');
  button.disabled = true;
  try {
    const h = await mountDirectory();
    $('directory-dialog').close();
    await connect(h, { ask: true });
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    const msg = $('directory-dialog-msg');
    msg.textContent = 'Could not add directory: ' + (e.message || e);
    msg.hidden = false;
  } finally { button.disabled = false; }
}

async function backToSessions({ push = true, announce = false } = {}) {
  stopLive();
  setPlaying(false);
  showViewer(false);
  setUrlSession(null, push);
  if (state.source) {
    setListBusy(true, { now: announce });
    try {
      await state.source.rescan();
    } catch {
      /* keep the old scan */
    }
    setSourceLabel();
    await loadList();
  }
}

// ---------------------------------------------------------------------------
// Wiring

function wire() {
  $('mount-btn').addEventListener('click', () => {
    for (const code of document.querySelectorAll('[data-suggested-path]')) code.textContent = suggestedPath(code.dataset.suggestedPath);
    $('directory-dialog-msg').hidden = true;
    $('directory-dialog').showModal();
  });
  $('choose-directory-btn').addEventListener('click', doMount);
  $('directory-dialog-close').addEventListener('click', () => $('directory-dialog').close());
  $('directory-dialog-cancel').addEventListener('click', () => $('directory-dialog').close());
  $('open-btn').addEventListener('click', () => $('file-input').click());
  for (const b of document.querySelectorAll('[data-copy-path]')) b.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(suggestedPath(b.dataset.copyPath));
      b.textContent = 'Copied';
    } catch {
      b.textContent = 'Copy failed';
    }
    setTimeout(() => (b.textContent = 'Copy'), 1500);
  });
  $('file-input').addEventListener('change', (e) => {
    if (e.target.files.length) openFileList(e.target.files);
    e.target.value = '';
  });
  $('refresh-btn').addEventListener('click', () => backToSessions({ push: false, announce: true }));
  $('more-btn').addEventListener('click', () => loadList({ reset: false }));
  let filterTimer = null;
  $('filter').addEventListener('input', (e) => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => {
      state.list.filter = e.target.value.trim();
      loadList();
    }, 250);
  });
  $('sessions-btn').addEventListener('click', () => backToSessions());
  $('pick-open-btn').addEventListener('click', () => openSessions([...state.picked.keys()]));
  $('pick-clear-btn').addEventListener('click', clearPicks);
  // Browser back and forward move between the session list and sessions.
  window.addEventListener('popstate', () => {
    const ids = urlSessions();
    if (ids.length) {
      const shown = state.sessions && !state.sessions.some((s) => s.fromFiles) ? state.sessions.map((s) => s.id) : [];
      const same = shown.length === ids.length && ids.every((id) => shown.includes(id));
      if (state.landing || !same) openSessions(ids, { push: false });
    } else if (!state.landing) backToSessions({ push: false });
  });
  $('live-btn').addEventListener('click', () => {
    if (state.live && state.liveBehind) snapToLive();
    else if (state.live) stopLive();
    else startLive();
  });
  $('show-all-btn').addEventListener('click', () => {
    state.focus = null;
    applyFilterClasses();
    applyFocusRule();
    viewChanged();
    drawTimeline();
  });
  for (const cb of document.querySelectorAll('[data-filter]')) {
    cb.checked = state.filters[cb.dataset.filter];
    cb.addEventListener('change', () => {
      state.filters[cb.dataset.filter] = cb.checked;
      applyFilterClasses();
      viewChanged();
    });
  }
  // Follow is driven by the reader's own scrolling: scrolling up turns it off and reaching
  // the very bottom turns it back on. Programmatic scrolls never turn it off. In a live session
  // viewed behind its latest event, reaching the bottom by hand only arms a return to the live
  // edge; a second, separate scroll down at the bottom performs it, so peeking never snaps back.
  const feedEl = $('feed');
  let feedTop = 0;
  let feedGrab = false;
  let feedWheelAt = 0;
  const overflows = () => feedEl.scrollHeight > feedEl.clientHeight;
  const atBottom = () => feedEl.scrollTop + feedEl.clientHeight >= feedEl.scrollHeight - 2;
  const userScrolling = () => feedGrab || performance.now() - feedWheelAt < 250;
  const canSnap = () => state.live && state.liveBehind;
  // A downward push at the bottom: the first arms, a later separate gesture snaps back.
  const pushAtBottom = (fresh) => {
    if (!canSnap()) return;
    if (snapArmed && fresh) snapToLive();
    else setSnapArmed(true);
  };
  feedEl.addEventListener('wheel', (e) => {
    const now = performance.now();
    // Wheel and touchpad momentum send a stream of events; a pause marks a new gesture.
    const fresh = now - feedWheelAt > 300;
    feedWheelAt = now;
    if (e.deltaY < 0 && overflows()) setFollow(false);
    else if (e.deltaY > 0 && atBottom()) pushAtBottom(fresh);
  }, { passive: true });
  feedEl.addEventListener('pointerdown', () => { feedGrab = true; });
  feedEl.addEventListener('touchstart', () => { feedGrab = true; }, { passive: true });
  for (const type of ['pointerup', 'touchend', 'touchcancel']) window.addEventListener(type, () => { feedGrab = false; });
  feedEl.addEventListener('scroll', () => {
    const top = feedEl.scrollTop;
    if (atBottom()) {
      setFollow(true);
      if (canSnap() && userScrolling()) setSnapArmed(true);
    } else {
      setSnapArmed(false);
      if (feedGrab && top < feedTop - 1) setFollow(false);
    }
    feedTop = top;
  });
  const ctxDialog = $('context-dialog');
  const ctxCanvas = $('context-canvas');
  $('context-btn').addEventListener('click', openContextChart);
  $('context-btn-narrow').addEventListener('click', openContextChart);
  $('context-close').addEventListener('click', () => ctxDialog.close());
  // A click on the backdrop lands on the dialog element itself.
  ctxDialog.addEventListener('click', (e) => e.target === ctxDialog && ctxDialog.close());
  ctxCanvas.addEventListener('pointermove', (e) => {
    const i = contextIndexAt(e);
    if (i !== ctxChart.hover) {
      ctxChart.hover = i;
      drawContextChart();
    }
    showContextTip(i, e.clientX - ctxCanvas.getBoundingClientRect().left);
  });
  ctxCanvas.addEventListener('pointerleave', () => {
    ctxChart.hover = -1;
    showContextTip(-1);
    drawContextChart();
  });
  ctxCanvas.addEventListener('click', (e) => {
    const i = contextIndexAt(e);
    if (i >= 0) seek(i, { select: true, manual: true });
  });
  new ResizeObserver(() => drawContextChart()).observe($('context-chart'));
  $('details-toggle').addEventListener('click', () => setDetailsView(true, true));
  $('details-close').addEventListener('click', () => setDetailsView(false, true));
  $('clear-focus-btn').addEventListener('click', () => {
    if (state.focus) toggleFocus(state.focus);
    $('feed').focus();
  });
  $('play-btn').addEventListener('click', togglePlay);
  $('step-fwd').addEventListener('click', () => stepFwd());
  $('step-back').addEventListener('click', () => stepBack());
  $('scrubber').addEventListener('input', (e) => seek(parseInt(e.target.value, 10), { manual: true }));
  $('speed').addEventListener('change', () => state.playing && schedule());
  $('pacing').addEventListener('change', () => state.playing && schedule());
  tl.canvas = $('timeline');
  tl.ctx = tl.canvas.getContext('2d');
  tl.canvas.addEventListener('pointerdown', timelinePointerDown);
  tl.canvas.addEventListener('pointermove', timelinePointerMove);
  tl.canvas.addEventListener('pointerup', timelinePointerUp);
  tl.canvas.addEventListener('pointercancel', timelinePointerUp);
  tl.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  // Scrolling the panel sideways shows another part of the graph on the sticky canvas.
  $('timeline-panel').addEventListener('scroll', () => drawTimeline());
  new ResizeObserver(() => drawTimeline()).observe($('timeline-panel'));

  document.addEventListener('keydown', (e) => {
    if (state.landing || !state.model) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    switch (e.key) {
      case ' ':
        if (t && t.closest('button, summary, [role="button"]')) return;
        e.preventDefault();
        togglePlay();
        break;
      case 'ArrowRight':
        e.preventDefault();
        stepFwd();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        stepBack();
        break;
      // Inside the conversation, Up/Down step through events instead of scrolling the pane.
      case 'ArrowUp':
      case 'ArrowDown': {
        if (!t || !t.closest || !t.closest('#feed')) return;
        e.preventDefault();
        if (e.key === 'ArrowUp') stepBack();
        else stepFwd();
        const card = cards[state.pos];
        if (t !== $('feed') && card) card.focus({ preventScroll: true });
        break;
      }
      case 'PageUp':
        if (t && t.closest && t.closest('#feed') && overflows()) setFollow(false);
        break;
      case 'PageDown':
        // Counts as the reader's own scroll; at the bottom each press is a separate push.
        if (t && t.closest && t.closest('#feed')) {
          if (atBottom()) pushAtBottom(true);
          feedWheelAt = performance.now();
        }
        break;
      case 'Home':
        e.preventDefault();
        seek(nextVisible(-1, 1), { select: true, manual: true });
        break;
      case 'End':
        e.preventDefault();
        seek(nextVisible(state.model.events.length, -1), { select: true, manual: true });
        break;
      case 'Escape':
        // The open context popup closes itself; nothing underneath should change too.
        if ($('context-dialog').open) break;
        if ($('grid').classList.contains('show-details') && matchMedia('(max-width: 1100px)').matches) {
          setDetailsView(false, true);
          break;
        }
        if (state.focus) {
          state.focus = null;
          applyFilterClasses();
          applyFocusRule();
          viewChanged();
          drawTimeline();
        }
        break;
    }
  });

  // drag and drop
  let dragDepth = 0;
  document.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
    dragDepth++;
    $('drop-hint').hidden = false;
  });
  document.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      $('drop-hint').hidden = true;
    }
  });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('drop-hint').hidden = true;
    if (e.dataTransfer.files.length) openFileList(e.dataTransfer.files);
  });
}

async function init() {
  wire();
  setInterval(refreshListStatus, 5000);
  setSourceLabel();
  // Served by server.mjs: the server reads the directory, so any browser can list and follow sessions.
  const server = await connectServer();
  if (server) {
    state.source = server;
    setSourceLabel();
    showMsg('');
    await loadList();
    const wanted = urlSessions();
    if (wanted.length && state.landing) openSessions(wanted, { push: false });
    return;
  }
  if (!supportsMount) {
    showMsg('This browser cannot mount directories. Use Open files… or a Chromium-based browser.');
    return;
  }
  for (const h of await rememberedDirectories()) await connect(h, { refresh: false });
  await loadList();
  const wanted = urlSessions();
  if (wanted.length && state.source && state.landing) openSessions(wanted, { push: false });
}

init();

// exposed for tests and debugging
window.__agentTimeline = { state, seek, stepFwd, stepBack, togglePlay, buildModel, openSession, openSessions, loadList, setSourceLabel, startLive, stopLive };
