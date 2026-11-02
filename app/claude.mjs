// Pure Claude Code transcript support: trimming records to the viewer's record model, finding
// subagent references, classifying user text, and the meaning of Claude's agent tools.
// Implements the harness interface described in transcripts.mjs; nothing here touches the file system.

export const NAME = 'Claude';

/** Claude Code has no unpaired tool results worth showing: they belong to dropped or truncated records. */
export const SHOW_UNPAIRED_RESULTS = false;

/** Extra wording for the total-tokens tooltip. */
export const TOKEN_NOTE = '';

// ---- Records ---------------------------------------------------------------

const DROPPED_TYPES = new Set([
  'api-request', 'api-request-blob', 'api-request-shape', 'file-history-snapshot', 'file-history-delta',
  'last-prompt', 'mode', 'permission-mode', 'cost-state', 'queue-operation', 'atis-latch', 'ai-title',
  'agent-name', 'continued-in', 'summary',
]);

const SCALAR_LIMIT = 4000;

function trimScalars(obj) {
  if (obj == null) return null;
  if (typeof obj === 'string') return obj.length > SCALAR_LIMIT ? obj.slice(0, SCALAR_LIMIT) : obj;
  if (typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v == null || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = v.length > SCALAR_LIMIT ? v.slice(0, SCALAR_LIMIT) : v;
  }
  return out;
}

function blockText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (typeof b === 'string' ? b : b && b.type === 'text' ? b.text : ''))
    .filter(Boolean)
    .join('\n');
}

/** Prompt size of one API call: fresh input plus cache writes and reads. */
function contextTokens(u) {
  return (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
}

/** Trim one parsed record down to what the viewer needs, or return null to drop it. */
export function trimRecord(r) {
  if (!r || typeof r !== 'object') return null;
  const type = r.type;
  if (!type || DROPPED_TYPES.has(type) || type.startsWith('api-request') || type.startsWith('file-history')) return null;
  const base = {
    type,
    uuid: r.uuid,
    parentUuid: r.parentUuid,
    timestamp: r.timestamp,
    isMeta: !!r.isMeta,
    isSidechain: !!r.isSidechain,
  };
  if (type === 'custom-title') return { ...base, customTitle: r.customTitle };
  if (type === 'attachment') {
    const a = r.attachment;
    if (!a || a.type !== 'queued_command' || typeof a.prompt !== 'string') return null;
    return { ...base, timestamp: a.timestamp || r.timestamp, prompt: a.prompt, origin: a.origin || null };
  }
  if (type === 'system') {
    if (r.subtype === 'compact_boundary') {
      const m = r.compactMetadata || {};
      return { ...base, subtype: r.subtype, compact: { trigger: m.trigger || '', preTokens: m.preTokens || 0 } };
    }
    if (r.level !== 'error') return null;
    return { ...base, subtype: r.subtype, level: r.level, content: typeof r.content === 'string' ? r.content : JSON.stringify(r.content) };
  }
  if (type === 'assistant') {
    const m = r.message || {};
    const content = Array.isArray(m.content) ? m.content : [];
    const blocks = [];
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text') blocks.push({ type: 'text', text: b.text || '' });
      else if (b.type === 'thinking') blocks.push({ type: 'thinking', text: b.thinking || '' });
      else if (b.type === 'tool_use') blocks.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} });
    }
    if (!blocks.length) return null;
    return {
      ...base,
      effort: typeof r.effort === 'string' ? r.effort : null,
      message: {
        id: m.id,
        model: m.model,
        usage: m.usage ? { output_tokens: m.usage.output_tokens || 0, context: contextTokens(m.usage) } : null,
        content: blocks,
      },
    };
  }
  if (type === 'user') {
    const m = r.message || {};
    let content = m.content;
    const blocks = [];
    if (typeof content === 'string') blocks.push({ type: 'text', text: content });
    else if (Array.isArray(content)) {
      for (const b of content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text') blocks.push({ type: 'text', text: b.text || '' });
        else if (b.type === 'tool_result') {
          let text = '';
          if (typeof b.content === 'string') text = b.content;
          else if (Array.isArray(b.content)) text = blockText(b.content);
          blocks.push({ type: 'tool_result', tool_use_id: b.tool_use_id, text, is_error: !!b.is_error });
        }
      }
    }
    if (!blocks.length) return null;
    return {
      ...base,
      origin: r.origin ? { kind: r.origin.kind, from: r.origin.from } : null,
      toolUseResult: trimScalars(r.toolUseResult),
      message: { content: blocks },
    };
  }
  return null;
}

/**
 * Claude is the fallback format: every transcript that no other harness claims is read as Claude.
 * Records are trimmed as they arrive so API dumps are never retained for the whole file.
 */
export function createParser() {
  const out = [];
  return {
    add(r) {
      const trimmed = trimRecord(r);
      if (trimmed) out.push(trimmed);
    },
    finish: () => out,
  };
}

// ---- Agent references ------------------------------------------------------

const AGENT_ID_RE = /^[a-z0-9]{8,}$/;
const FROM_RE = /<agent-message from="([a-z0-9]+)"/g;
const RESULT_FROM_RE = /message from "([a-z0-9]{8,})"/;

/** Ids of subagents referenced by a list of trimmed records. */
export function findAgentIds(records) {
  const ids = new Set();
  const spawnIds = new Set();
  const stops = new Map(); // TaskStop tool-use id -> target, kept until a result shows it stopped a shell
  for (const r of records) {
    if (r.type === 'assistant') {
      for (const b of r.message.content) {
        if (b.type !== 'tool_use') continue;
        if (b.name === 'Agent' || b.name === 'Task') spawnIds.add(b.id);
        else if (b.name === 'SendMessage' && typeof b.input.to === 'string' && AGENT_ID_RE.test(b.input.to)) ids.add(b.input.to);
        else if (b.name === 'TaskStop') {
          const id = b.input.task_id || b.input.shell_id;
          if (typeof id === 'string' && AGENT_ID_RE.test(id)) stops.set(b.id, id);
        }
      }
    } else if (r.type === 'user') {
      const tur = r.toolUseResult;
      for (const b of r.message.content) {
        if (b.type === 'tool_result' && stops.has(b.tool_use_id)) {
          if (!stopsAgent(r)) stops.delete(b.tool_use_id);
        } else if (b.type === 'tool_result' && spawnIds.has(b.tool_use_id)) {
          if (tur && typeof tur.agentId === 'string') ids.add(tur.agentId);
          const m = RESULT_FROM_RE.exec(b.text || '');
          if (m) ids.add(m[1]);
        } else if (b.type === 'text') {
          for (const m of b.text.matchAll(FROM_RE)) ids.add(m[1]);
        }
      }
    } else if (r.type === 'attachment') {
      for (const m of r.prompt.matchAll(FROM_RE)) ids.add(m[1]);
    }
  }
  for (const id of stops.values()) ids.add(id);
  return ids;
}

// ---- Tools -----------------------------------------------------------------

/**
 * The agent role of a tool call: spawn, message, stop, or handback, with its title, text, the
 * referenced agent (target) and, for spawns, what the call says about the child. Null for other tools.
 */
export function toolEvent(name, input) {
  if (name === 'Agent' || name === 'Task') {
    return {
      type: 'spawn', title: input.description || input.subagent_type || 'subagent', text: input.prompt || '',
      child: { label: input.description, type: input.subagent_type, model: input.model },
    };
  }
  if (name === 'SendMessage') return { type: 'message', title: input.summary || input.message || '', text: input.message || '', target: input.to };
  if (name === 'TaskStop') {
    const tid = input.task_id || input.shell_id || '';
    return { type: 'stop', title: tid, text: '', target: tid };
  }
  if (name === 'SubagentHandback') return { type: 'handback', title: input.message || '', text: input.message || '' };
  return null;
}

/** A short title for an ordinary tool call, or undefined for the generic fallback. */
export function toolTitle(name, i) {
  switch (name) {
    case 'Bash':
      return i.description || i.command || '';
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return i.file_path || i.notebook_path || '';
    case 'Grep':
    case 'Glob':
      return i.pattern || '';
    case 'Skill':
      return i.skill || '';
    case 'WebFetch':
      return i.url || '';
    case 'WebSearch':
      return i.query || '';
    case 'Monitor':
      return i.description || i.command || '';
    default:
      return undefined;
  }
}

/** The agent a spawn's tool result names, from its result metadata or its text. */
export function spawnedAgentId(record, block) {
  const tur = record.toolUseResult;
  if (tur && typeof tur.agentId === 'string') return tur.agentId;
  return RESULT_FROM_RE.exec(block.text || '')?.[1] || null;
}

/** TaskStop also stops shells and other background tasks; its result says which kind it was. */
export function stopsAgent(record) {
  const kind = record.toolUseResult?.task_type;
  return !kind || kind === 'agent' || kind === 'local_agent';
}

// ---- Classifying user text -------------------------------------------------

const TAG = (name, s) => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`).exec(s);
  return m ? m[1].trim() : '';
};

function stripWrapper(s) {
  return s.replace(/^\s*Another Claude session sent a message:\s*/, '').trim();
}

/**
 * Classify a user text block.
 * Returns { kind, title, text, from?, taskId?, status?, summary?, result?, skip? }.
 * kinds: received, notification, system, command, coordinator, prompt
 */
export function classifyUserText(raw, { isMeta = false } = {}) {
  const s = stripWrapper(raw);
  const trimmed = s.trim();

  // 1. message from another agent
  const am = /^<agent-message from="([^"]+)"[^>]*>([\s\S]*?)(?:<\/agent-message>\s*)?$/.exec(trimmed);
  if (am) {
    let body = am[2].trim();
    const hb = /^\[Subagent hand-back\]/.test(body);
    return { kind: 'received', from: am[1], text: body, title: hb ? 'hand-back' : 'message', handback: hb };
  }
  // 2. task notification
  if (trimmed.startsWith('<task-notification>')) {
    const taskId = TAG('task-id', trimmed);
    const status = TAG('status', trimmed);
    const summary = TAG('summary', trimmed);
    const result = TAG('result', trimmed);
    return { kind: 'notification', taskId, status, summary, result, text: trimmed, title: summary || `task ${taskId}` };
  }
  // 3. command output
  if (trimmed.startsWith('<local-command-stdout>')) {
    const out = TAG('local-command-stdout', trimmed);
    if (!out || out === '(no content)') return { kind: 'system', skip: true };
    return { kind: 'system', title: 'command output', text: out };
  }
  // 4. slash command or shell input
  if (trimmed.includes('<command-name>')) {
    const name = TAG('command-name', trimmed);
    const args = TAG('command-args', trimmed);
    return { kind: 'command', title: (name + (args ? ' ' + args : '')).trim(), text: trimmed };
  }
  if (trimmed.includes('<bash-input>')) {
    return { kind: 'command', title: '! ' + TAG('bash-input', trimmed), text: TAG('bash-input', trimmed), shell: true };
  }
  if (trimmed.startsWith('<bash-stdout>') || trimmed.startsWith('<bash-stderr>')) {
    const out = (TAG('bash-stdout', trimmed) + '\n' + TAG('bash-stderr', trimmed)).trim();
    if (!out) return { kind: 'system', skip: true };
    return { kind: 'system', title: 'shell output', text: out };
  }
  // 5. coordinator message (inside a subagent)
  const coord = /^The coordinator sent a message while you were working:\s*/.exec(trimmed);
  if (coord) return { kind: 'coordinator', title: 'message', text: trimmed.slice(coord[0].length) };
  // 6. system text
  if (trimmed.startsWith('<ide_selection>') || trimmed.startsWith('<ide_opened_file>')) {
    return { kind: 'system', title: 'editor context', text: trimmed };
  }
  if (trimmed.startsWith('<system-reminder>')) return { kind: 'system', title: 'system reminder', text: trimmed };
  if (trimmed.startsWith('<local-command-caveat>')) return { kind: 'system', title: 'command caveat', text: trimmed };
  if (/^Base directory for this skill[:;]/.test(trimmed)) {
    const m = /\n#\s+(.+)/.exec(trimmed);
    return { kind: 'system', title: m ? 'skill: ' + m[1].trim() : 'skill', text: trimmed };
  }
  if (isMeta) return { kind: 'system', title: 'system', text: trimmed };
  // 7. a prompt
  return { kind: 'prompt', text: trimmed, title: '' };
}
