// Run with node tests/check.mjs. Synthetic fixtures for each harness; no personal transcripts are read.
import assert from 'node:assert/strict';
import { parseLines, summarizeRecords, harnessNamed } from '../app/transcripts.mjs';
import { scanDirectory, combineScans, listSessions, loadSession, loadFiles, sessionChanged } from '../app/localfs.mjs';

const rootId = '11111111-1111-1111-1111-111111111111';
const childId = '22222222-2222-2222-2222-222222222222';
const grandId = '33333333-3333-3333-3333-333333333333';
const row = (type, payload) => ({ timestamp: '2026-11-01T12:00:00Z', type, payload });
const meta = (id, parent) => row('session_meta', { id, session_id: rootId, cwd: '/workspace', parent_thread_id: parent });
const msg = (text, role = 'user') => row('response_item', { type: 'message', role, content: [{ type: 'input_text', text }] });
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n');
const rows = [
  meta(rootId), row('turn_context', { model: 'codex-test', effort: 'high' }),
  msg('# AGENTS.md instructions\nsetup'), msg('<skill>setup</skill>'),
  msg('repeat'), msg('repeat'),
  row('event_msg', { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'repeat' }] } }),
  row('event_msg', { type: 'user_message', message: 'repeat' }),
  row('event_msg', { type: 'user_message', message: 'repeat' }),
  row('response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'same-id', input: 'await tools.command();' }),
  row('response_item', { type: 'custom_tool_call_output', call_id: 'same-id', output: 'first' }),
  row('response_item', { type: 'custom_tool_call_output', call_id: 'same-id', output: 'second' }),
  row('response_item', { type: 'function_call_output', call_id: 'orphan', output: 'unpaired' }),
  row('response_item', { type: 'reasoning', encrypted_content: 'DO-NOT-RENDER' }),
  msg('done', 'assistant'), row('event_msg', { type: 'agent_message', message: 'done' }),
  row('compacted', { replacement_history: [msg('must not be emitted')] }),
  row('token_usage_record', { thread_id: rootId, response_id: 'r1', thread_token_usage: { output_tokens: 10 }, usage: { input_tokens: 100, cached_input_tokens: 50 } }),
  row('token_usage_record', { thread_id: rootId, response_id: 'r1', thread_token_usage: { output_tokens: 10 }, usage: { input_tokens: 100 } }),
  row('token_usage_record', { thread_id: childId, thread_token_usage: { output_tokens: 999 } }),
  row('event_msg', { type: 'token_count', info: { total_token_usage: { output_tokens: 777 } } }),
  row('event_msg', { type: 'token_count', info: null }),
  row('token_usage_record', { thread_id: rootId, thread_token_usage: { output_tokens: 25 }, usage: { input_tokens: 200 } }),
];
// ---- Codex ----------------------------------------------------------------

const records = parseLines('\uFEFF' + jsonl(rows) + '\n{"type":');
const summary = summarizeRecords(records, 'Codex');
assert.equal(summary.prompts, 2);
assert.equal(summary.model, 'codex-test');
assert.equal(summary.effort, 'high');
assert.equal(summary.context, 200);
assert.equal(summary.cwd, '/workspace');
assert.equal(records.filter((r) => r.type === 'assistant' && r.message.content[0].type === 'text').length, 1);
assert.equal(records.filter((r) => r.type === 'usage').reduce((n, r) => n + r.tokens, 0), 25);
assert.ok(!JSON.stringify(records).includes('DO-NOT-RENDER'));
assert.ok(!JSON.stringify(records).includes('must not be emitted'));
assert.equal(records.filter((r) => r.type === 'user' && r.message.content[0].type === 'tool_result').length, 3);
assert.throws(() => parseLines(jsonl([row('thread.started', {})])), /Unsupported Codex/);

const old = parseLines(jsonl([meta(rootId), msg('hi'), row('event_msg', { type: 'token_count', info: { total_token_usage: { output_tokens: 20 }, last_token_usage: { input_tokens: 50, cached_input_tokens: 10 } } }), row('event_msg', { type: 'token_count', info: null })]));
assert.equal(summarizeRecords(old, 'Codex').context, 50);
assert.equal(old.find((r) => r.type === 'usage').tokens, 20);
const embedded = parseLines(jsonl([meta(rootId), row('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'timed' }], internal_chat_message_metadata_passthrough: { create_time: 1000 } })]));
assert.equal(embedded.at(-1).timestamp, '1970-01-01T00:16:40.000Z');

function file(name, text) {
  const handle = { name, kind: 'file', text, mtime: 1, async getFile() {
    return { name, size: this.text.length, lastModified: this.mtime, text: async () => this.text, slice: (a, b) => ({ text: async () => this.text.slice(a, b) }) };
  } };
  return handle;
}
function dir(name, children = []) {
  return { name, kind: 'directory', children, async *entries() { for (const h of this.children) yield [h.name, h]; },
    async getDirectoryHandle(n) { const h = this.children.find((c) => c.name === n && c.kind === 'directory'); if (!h) throw new Error('missing'); return h; } };
}
const rootFile = file('copied.jsonl', jsonl(rows));
const childFile = file('rollout-child.jsonl', jsonl([meta(childId, rootId), msg('task')]));
const grandFile = file('rollout-grand.jsonl', jsonl([meta(grandId, childId), msg('nested task')]));
const day = dir('01', [rootFile, childFile]);
const home = dir('.codex', [dir('sessions', [dir('2026', [dir('11', [day])])]), dir('archived_sessions', [grandFile]),
  { name: 'auth.json', kind: 'file', getFile() { throw new Error('must not read auth'); } }]);
const scan = await scanDirectory(home);
assert.equal(scan.harness, 'Codex');
assert.equal(scan.sessions.length, 1);
assert.equal(scan.sessions[0].id, rootId);
assert.equal((await listSessions(scan)).items[0].subagents, 2);
let loaded = await loadSession(scan, rootId);
assert.equal(loaded.harness, 'Codex');
assert.deepEqual(loaded.agents.map((a) => a.id), [childId, grandId]);
assert.equal(await sessionChanged(scan, loaded), false);
childFile.text += '\n' + JSON.stringify(msg('new work'));
childFile.mtime++;
assert.equal(await sessionChanged(scan, loaded), true);
loaded = await loadSession(scan, rootId);
const newer = file('new.jsonl', jsonl([meta('44444444-4444-4444-4444-444444444444', grandId), msg('new agent')]));
day.children.push(newer);
assert.equal(await sessionChanged(scan, loaded), true);
assert.equal((await loadSession(scan, rootId)).agents.length, 3);
const snapshot = await loadFiles(await Promise.all([childFile, rootFile, grandFile].map((f) => f.getFile())));
assert.equal(snapshot.id, rootId);
assert.equal(snapshot.agents.length, 2);
assert.equal((await loadFiles([await childFile.getFile()])).id, childId);
await assert.rejects(() => loadFiles([rootFile, file('other.jsonl', jsonl([meta('other'), msg('other')]))].map((f) => ({ name: f.name, text: async () => f.text }))), /one Codex root/);

// Codex reads its own tool vocabulary and text formats, not Claude's.
const codex = harnessNamed('Codex');
assert.equal(codex.toolEvent('collab.spawn_agent', { task_name: 'review', message: 'go', model: 'm' }).type, 'spawn');
assert.equal(codex.toolEvent('close_agent', { target: 'review' }).target, 'review');
assert.equal(codex.toolEvent('Agent', { description: 'x' }), null);
assert.equal(codex.classifyUserText('Message Type: note\nSender: reviewer\nhi').from, 'reviewer');
assert.equal(codex.classifyUserText('<command-name>/x</command-name>').kind, 'prompt');
assert.equal(codex.classifyUserText('# Context from my IDE setup:\n## My request: fix it').title, 'fix it');

// ---- Claude ---------------------------------------------------------------

const claude = harnessNamed('Claude');
const agentId = 'a1b2c3d4e5f6a7b8';
const nestedId = 'b1b2c3d4e5f6a7b8';
const user = (content, extra = {}) => ({ type: 'user', timestamp: '2026-11-01T12:00:00Z', message: { content }, ...extra });
const assistant = (content) => ({ type: 'assistant', timestamp: '2026-11-01T12:00:01Z', message: { id: 'm' + Math.random(), model: 'claude-test', content, usage: { output_tokens: 5, input_tokens: 1, cache_read_input_tokens: 9 } } });
const claudeRows = [
  { type: 'file-history-snapshot', snapshot: {} }, { type: 'custom-title', customTitle: 'Titled' },
  user('<command-name>/review</command-name><command-args>now</command-args>'), user('<system-reminder>ctx</system-reminder>'),
  user('Message Type: note'), user('injected', { isMeta: true }),
  assistant([{ type: 'tool_use', id: 'spawn1', name: 'Agent', input: { description: 'helper', subagent_type: 'Explore', prompt: 'look' } }]),
  user([{ type: 'tool_result', tool_use_id: 'spawn1', content: 'started' }], { toolUseResult: { agentId } }),
  // Stopping a background shell and an agent: only the agent's id is a subagent reference.
  assistant([{ type: 'tool_use', id: 'stop1', name: 'TaskStop', input: { task_id: 'shellabc1' } }]),
  user([{ type: 'tool_result', tool_use_id: 'stop1', content: 'stopped' }], { toolUseResult: { task_id: 'shellabc1', task_type: 'local_bash' } }),
  assistant([{ type: 'tool_use', id: 'stop2', name: 'TaskStop', input: { task_id: nestedId } }]),
  user([{ type: 'tool_result', tool_use_id: 'stop2', content: 'stopped' }], { toolUseResult: { task_id: nestedId, task_type: 'local_agent' } }),
];
const claudeRecords = parseLines(jsonl(claudeRows));
assert.ok(!claudeRecords.some((r) => r.type === 'file-history-snapshot'));
const claudeSummary = summarizeRecords(claudeRecords, 'Claude');
assert.equal(claudeSummary.title, 'Titled');
assert.equal(claudeSummary.firstPrompt, '/review now');
assert.equal(claudeSummary.prompts, 2); // the command and the plain "Message Type:" text; reminders and meta text are system
assert.equal(claudeSummary.spawns, 1);
assert.equal(claudeSummary.context, 10);
assert.deepEqual([...claudeSummary.agentIds], [agentId, nestedId]); // the stopped shell is not a subagent
assert.equal(claude.toolEvent('SendMessage', { to: agentId, message: 'hi' }).target, agentId);
assert.equal(claude.toolEvent('collab.spawn_agent', {}), null);
assert.equal(claude.stopsAgent({ toolUseResult: { task_type: 'local_bash' } }), false);
assert.equal(claude.classifyUserText(`<agent-message from="${agentId}">done</agent-message>`).kind, 'received');

const agentFile = file(`agent-${agentId}.jsonl`, jsonl([user('look'), assistant([{ type: 'tool_use', id: 's', name: 'SendMessage', input: { to: nestedId, message: 'hi' } }])]));
const agentMeta = file(`agent-${agentId}.meta.json`, JSON.stringify({ description: 'helper', agentType: 'Explore' }));
const nestedFile = file(`agent-${nestedId}.jsonl`, jsonl([user('nested')]));
const subagents = dir('subagents', [agentFile, agentMeta]);
const mainFile = file(rootId + '.jsonl', jsonl(claudeRows));
const projectDir = dir('project', [mainFile, dir(rootId, [subagents]), dir('other', [dir('subagents', [nestedFile])])]);
const nestedScan = await scanDirectory(dir('.claude', [dir('projects', [projectDir])]));
assert.equal(nestedScan.harness, 'Claude');
assert.equal((await listSessions(nestedScan)).items[0].subagents, 2); // the spawned agent and the stopped agent, not the stopped shell
const claudeLoaded = await loadSession(nestedScan, rootId);
assert.deepEqual(claudeLoaded.agents.map((a) => a.id), [agentId, nestedId]); // nested agents are found by reference across directories
assert.equal(claudeLoaded.agents[0].meta.agentType, 'Explore');
assert.equal(await sessionChanged(nestedScan, claudeLoaded), false);
subagents.children.push(file('agent-c1b2c3d4e5f6a7b8.jsonl', jsonl([user('late')])));
assert.equal(await sessionChanged(nestedScan, claudeLoaded), true);
assert.equal((await loadSession(nestedScan, rootId)).agents.length, 3);
const claudeSnapshot = await loadFiles(await Promise.all([agentFile, mainFile].map((f) => f.getFile())));
assert.equal(claudeSnapshot.harness, 'Claude');
assert.equal(claudeSnapshot.id, rootId);
await assert.rejects(() => loadFiles([{ name: 'notes.txt', text: async () => '' }]), /No transcript files/);

// ---- Both harnesses ---------------------------------------------------------

const claudeFile = file(rootId + '.jsonl', jsonl([{ type: 'user', message: { content: 'Claude prompt' } }]));
const claudeScan = await scanDirectory(dir('projects', [dir('project', [claudeFile])]));
assert.equal((await listSessions(claudeScan)).items[0].harness, 'Claude');
assert.equal((await loadSession(claudeScan, rootId)).records[0].message.content[0].text, 'Claude prompt');
const combined = combineScans([scan, claudeScan, scan]);
assert.equal(combined.sessions.length, 1); // overlapping directories do not duplicate sessions
assert.equal((await loadSession(combined, rootId)).harness, 'Codex');
const secondClaude = await scanDirectory(dir('project', [file('55555555-5555-5555-5555-555555555555.jsonl', claudeFile.text)]));
const mixed = combineScans([scan, secondClaude]);
assert.deepEqual(new Set((await listSessions(mixed)).items.map((s) => s.harness)), new Set(['Codex', 'Claude']));
assert.equal((await loadSession(mixed, '55555555-5555-5555-5555-555555555555')).harness, 'Claude');
console.log('Claude and Codex parsing, classification, tool roles, summaries, discovery, nested loading, snapshots, live checks, and combined sources passed.');
