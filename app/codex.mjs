// Pure Codex support: adapting local rollout envelopes to the viewer's record model, classifying
// user text, and the meaning of Codex's agent tools. Implements the harness interface described in
// transcripts.mjs; nothing here touches the file system.
// This is an observed storage format, not the codex exec --json event stream.

export const NAME = 'Codex';

/** Codex results without a matching call stay visible, because rollouts can record them on their own. */
export const SHOW_UNPAIRED_RESULTS = true;

/** Extra wording for the total-tokens tooltip. */
export const TOKEN_NOTE = 'Codex cumulative snapshots are not added repeatedly. Inherited histories can overlap; this is not deduplicated family usage or a bill.';

// ---- Records ---------------------------------------------------------------


export function codexMetadata(rows) {
  const p = rows.find((r) => r?.type === 'session_meta')?.payload;
  if (!p || typeof p.id !== 'string') return null;
  const spawn = p.source?.subagent?.thread_spawn || {};
  return {
    id: p.id, cwd: p.cwd || '', parentAgentId: p.parent_thread_id || spawn.parent_thread_id || null,
    description: p.agent_nickname || spawn.agent_nickname || p.agent_path || spawn.agent_path || '',
    agentPath: p.agent_path || spawn.agent_path || '', agentType: spawn.agent_role || 'Codex',
    inherited: !!p.forked_from_id || p.subagent_history_start_ordinal != null,
  };
}

const ROLLOUT_TYPES = new Set(['session_meta', 'turn_context', 'response_item', 'event_msg', 'token_usage_record', 'compacted', 'world_state', 'inter_agent_communication_metadata', 'thread.started', 'item.completed']);
const UNSUPPORTED_TYPES = ['thread.started', 'item.completed', 'response_item', 'session_meta'];

/**
 * Keep rollout envelopes (every row once session metadata appears) and adapt them at the end.
 * Returns null from finish when the transcript is not a Codex rollout.
 */
export function createParser() {
  const rows = [];
  let seen = false;
  return {
    add(r, sourceLine) {
      if (r.type === 'session_meta') seen = true;
      if (seen || ROLLOUT_TYPES.has(r.type)) rows.push({ ...r, sourceLine });
    },
    finish() {
      const meta = codexMetadata(rows);
      if (meta) return parseCodex(rows, meta);
      if (rows.some((r) => UNSUPPORTED_TYPES.includes(r.type))) {
        throw new Error('Unsupported Codex transcript. Open a local rollout JSONL with session_meta.id; codex exec --json and analysis exports are not supported.');
      }
      return null;
    },
  };
}

function visible(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(visible).filter(Boolean).join('\n');
  if (!value || typeof value !== 'object') return '';
  if (typeof value.text === 'string') return value.text;
  return value.type ? `[${value.type}: content unavailable]` : JSON.stringify(value);
}

function decode(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function eventTime(row) {
  const p = row.payload;
  for (const [v, scale, source] of [
    [p.internal_chat_message_metadata_passthrough?.create_time, 1000, 'create_time'],
    [p.completed_at_ms, 1, 'completed_at_ms'], [p.completed_at, 1000, 'completed_at'],
    [p.started_at, 1000, 'started_at'], [row.timestamp, 1, 'envelope'],
  ]) {
    if (v == null) continue;
    const ms = typeof v === 'number' ? v * scale : Date.parse(v);
    if (Number.isFinite(ms) && Math.abs(ms) <= 8640000000000000) return { timestamp: new Date(ms).toISOString(), timeSource: source };
  }
  return { timestamp: null, timeSource: 'missing' };
}

const INJECTED = /^(# AGENTS\.md instructions|<environment_context>|<permissions instructions>|<skill>|<skills_instructions>|<turn_aborted>|<external_codex_apps_open_page>|<codex_apps_|<user_instructions>)/;

export function parseCodex(rows, meta = codexMetadata(rows)) {
  if (!meta) throw new Error('Not a supported Codex rollout: missing session_meta.id.');
  const out = [{ type: 'session-meta', ...meta }];
  const layers = [[], [], []];
  const snapshots = [];
  const fallback = [];
  const responses = new Map();
  let model = '';
  let effort = '';
  let turnId = null;
  const unknown = new Set();
  rows.forEach((row, index) => {
    const p = row.payload;
    if (!p || typeof p !== 'object') return;
    const kind = p.type;
    const base = {
      uuid: `${meta.id}:${row.sourceLine || index + 1}`, sourceLine: row.sourceLine || index + 1,
      recordedTimestamp: row.timestamp, ...eventTime(row),
      turnId: p.turn_id || p.internal_chat_message_metadata_passthrough?.turn_id || turnId,
    };
    const system = (title, content, extra = {}) => out.push({ ...base, type: 'system', title, content, ...extra });
    const assistant = (content) => ({ ...base, type: 'assistant', effort, message: { id: base.uuid, model, content } });
    const message = (role, text, layer, phase) => {
      if (!text) return;
      const record = role === 'assistant' ? assistant([{ type: 'text', text }]) : {
        ...base, type: 'user', isMeta: role !== 'user' || INJECTED.test(text.trimStart()), message: { content: [{ type: 'text', text }] },
      };
      record.phase = phase;
      layers[layer].push({ role, text, record });
    };
    if (row.type === 'turn_context') {
      model = p.model || model;
      effort = p.effort || effort;
      turnId = p.turn_id || turnId;
      out.push({ ...base, type: 'turn-context', model, effort });
    } else if (row.type === 'world_state') {
      if (typeof p.state?.model === 'string') model = p.state.model;
    } else if (row.type === 'response_item') {
      if (kind === 'message') message(p.role, visible(p.content), 0, p.phase);
      else if (kind === 'reasoning') out.push(assistant([{ type: 'thinking', text: visible(p.summary) || visible(p.content) || '[reasoning unavailable]' }]));
      else if (kind === 'function_call' || kind === 'custom_tool_call') {
        const input = decode(kind === 'function_call' ? p.arguments : p.input);
        out.push(assistant([{ type: 'tool_use', id: p.call_id, name: [p.namespace, p.name].filter(Boolean).join('.'), input: input ?? {} }]));
      } else if (kind === 'function_call_output' || kind === 'custom_tool_call_output') {
        const result = decode(p.output);
        out.push({ ...base, type: 'user', toolUseResult: result && typeof result === 'object' ? { agentId: result.agent_id || result.id } : null,
          message: { content: [{ type: 'tool_result', tool_use_id: p.call_id, text: visible(p.output), is_error: !!p.is_error }] } });
      } else if (kind === 'agent_message') {
        out.push({ ...base, type: 'peer-message', from: p.author, to: p.recipient, content: visible(p.content) });
      } else if (kind === 'compaction') system('compacted', '[opaque compaction item]', { compact: { trigger: '', preTokens: 0 } });
      else if (kind !== 'additional_tools') unknown.add(`${row.type}:${kind}`);
    } else if (row.type === 'token_usage_record') {
      if (p.thread_id && p.thread_id !== meta.id) return;
      if (p.thread_token_usage) snapshots.push({ base, usage: p.thread_token_usage, context: p.usage?.input_tokens, source: 'thread_token_usage' });
      if (p.response_id && p.usage) responses.set(p.response_id, { base, usage: p.usage, context: p.usage.input_tokens, source: 'distinct response usage' });
    } else if (row.type === 'event_msg') {
      if (kind === 'user_message' || kind === 'agent_message') message(kind === 'user_message' ? 'user' : 'assistant', visible(p.message), 2, p.phase);
      else if (kind === 'item_completed') {
        const item = p.item || {};
        if (item.type === 'UserMessage' || item.type === 'AgentMessage') message(item.type === 'UserMessage' ? 'user' : 'assistant', visible(item.content), 1, item.phase);
        else if (item.type !== 'Reasoning') system(`activity: ${item.type || 'unknown'}`, JSON.stringify(item, null, 2));
      } else if (kind === 'token_count') {
        if (p.info?.total_token_usage) fallback.push({ base, usage: p.info.total_token_usage, context: p.info.last_token_usage?.input_tokens, source: 'total_token_usage' });
      } else if (['task_started', 'task_complete', 'turn_aborted'].includes(kind)) {
        system(kind.replaceAll('_', ' '), p.reason || (p.duration_ms != null ? `Recorded duration: ${p.duration_ms} ms` : ''));
      } else if (kind === 'error') system('error', visible(p.message), { level: 'error' });
      else if (kind !== 'thread_settings_applied') unknown.add(`${row.type}:${kind}`);
    } else if (row.type === 'compacted') system('compacted', p.message || '', { compact: { trigger: '', preTokens: 0 } });
    else if (!['session_meta', 'inter_agent_communication_metadata'].includes(row.type)) unknown.add(row.type);
  });

  // Prefer response messages, then completed items, then legacy UI notifications.
  // Match copies per occurrence so repeated real prompts remain repeated prompts.
  const accepted = new Map();
  for (const layer of layers) {
    const remaining = new Map(accepted);
    for (const { role, text, record } of layer) {
      const key = JSON.stringify([role, text]);
      if (remaining.get(key)) remaining.set(key, remaining.get(key) - 1);
      else {
        out.push(record);
        accepted.set(key, (accepted.get(key) || 0) + 1);
      }
    }
  }
  const usage = snapshots.length ? snapshots : fallback.length ? fallback : [...responses.values()];
  let previous = 0;
  for (const s of usage) {
    const output = s.usage.output_tokens;
    const tokens = typeof output === 'number' ? output - (s.source === 'distinct response usage' ? 0 : previous) : 0;
    if (typeof output === 'number') previous = output;
    out.push({ ...s.base, type: 'usage', tokens, context: s.context || 0,
      content: `${s.source}\n${JSON.stringify(s.usage, null, 2)}\nCached input and reasoning output are included in input and output totals.`, usageSource: s.source });
  }
  if (meta.inherited || unknown.size) out.push({ type: 'system', uuid: `${meta.id}:notes`, sourceLine: 0,
    timestamp: rows[0]?.timestamp, title: 'Transcript notes', content: [
      meta.inherited ? 'Fork or inherited history: events may include parent context. Per-thread usage is recorded usage; combined totals are not deduplicated family usage.' : '',
      unknown.size ? `Unsupported records omitted: ${[...unknown].join(', ')}` : '',
    ].filter(Boolean).join('\n') });
  return out.sort((a, b) => (a.sourceLine || 0) - (b.sourceLine || 0));
}

// ---- Agent references ------------------------------------------------------

/** Codex relatives are found from rollout metadata, not from references in the transcript. */
export function findAgentIds() {
  return new Set();
}

// ---- Tools -----------------------------------------------------------------

/**
 * The agent role of a tool call: spawn, message, or stop, with its title, text, the referenced
 * agent (target) and, for spawns, what the call says about the child. Null for other tools.
 * Tool names can carry a namespace prefix.
 */
export function toolEvent(name, input) {
  const tool = name.split('.').at(-1);
  if (tool === 'spawn_agent') {
    return { type: 'spawn', title: input.task_name || input.agent_type || 'subagent', text: input.message || '', child: { model: input.model } };
  }
  if (['send_message', 'send_input', 'followup_task'].includes(tool)) {
    return { type: 'message', title: input.message || '', text: input.message || '', target: input.target || input.id };
  }
  if (['close_agent', 'interrupt_agent'].includes(tool)) {
    const target = input.target || input.id;
    return { type: 'stop', title: target, text: '', target };
  }
  return null;
}

/** Codex tools take the generic title. */
export function toolTitle() {
  return undefined;
}

/** The agent a spawn_agent result names. */
export function spawnedAgentId(record) {
  const tur = record.toolUseResult;
  return tur && typeof tur.agentId === 'string' ? tur.agentId : null;
}

/** Codex stop tools only address agents. */
export function stopsAgent() {
  return true;
}

// ---- Classifying user text -------------------------------------------------

/**
 * Classify a user text block (see classifyUserText in claude.mjs for the result shape).
 * Inter-agent deliveries are received messages; injected context is system text; IDE-wrapped
 * prompts are titled by their request.
 */
export function classifyUserText(raw, { isMeta = false } = {}) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('Message Type:')) {
    const from = /^Sender:\s*(.+)$/m.exec(trimmed)?.[1];
    return { kind: 'received', from, title: 'message', text: trimmed };
  }
  if (isMeta) return { kind: 'system', title: 'system', text: trimmed };
  const request = trimmed.startsWith('# Context from my IDE setup:') ? /(?:^|\n)## My request:\s*([\s\S]*)/.exec(trimmed)?.[1] : '';
  return { kind: 'prompt', text: trimmed, title: request || '' };
}
