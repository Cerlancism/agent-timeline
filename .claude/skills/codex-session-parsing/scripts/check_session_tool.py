#!/usr/bin/env python3
"""Synthetic regression checks; all fixtures and exports stay in a temporary folder."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('session_tool', Path(__file__).with_name('session_tool.py'))
tool = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(tool)


def row(kind, payload, timestamp='2026-01-01T00:00:00Z'):
  return {'type': kind, 'timestamp': timestamp, 'payload': payload}


def message(role, text):
  return row('response_item', {'type': 'message', 'role': role,
                              'content': [{'type': 'input_text', 'text': text}]})


class SessionChecks(unittest.TestCase):
  def setUp(self):
    self.temp = tempfile.TemporaryDirectory()
    self.addCleanup(self.temp.cleanup)
    self.root = Path(self.temp.name)

  def write(self, name, rows, meta=None):
    path = self.root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    records = [row('session_meta', meta or {'id': 'root-one', 'source': 'cli'})] + rows
    path.write_text('\n'.join(json.dumps(r) for r in records) + '\n', encoding='utf-8')
    return path

  def test_mirrors_preserve_repeated_prompts(self):
    raw = message('user', 'Repeat this')
    mirror = row('event_msg', {'type': 'item_completed', 'item': {
      'type': 'UserMessage', 'content': [{'type': 'text', 'text': 'Repeat this'}]}})
    older = row('event_msg', {'type': 'user_message', 'message': 'Repeat this'})
    path = self.write('messages.jsonl', [raw, mirror, older, raw, mirror, older,
                                       message('user', '# AGENTS.md instructions for repo')])
    summary, events = tool.parse(path)
    self.assertEqual(len(summary['prompts']), 2)
    self.assertEqual(summary['event_counts']['injected'], 1)
    self.assertEqual(len(events), 3)

  def test_ui_only_messages_are_retained(self):
    path = self.write('ui.jsonl', [row('event_msg', {'type': 'user_message', 'message': 'Hello'})])
    self.assertEqual(tool.parse(path)[0]['prompts'][0]['text'], 'Hello')

  def test_tool_pairing_multiple_results_and_missing_results(self):
    path = self.write('tools.jsonl', [
      row('response_item', {'type': 'custom_tool_call', 'name': 'exec', 'call_id': 'a', 'input': 'raw(code)'}),
      message('assistant', 'Still running'),
      row('response_item', {'type': 'custom_tool_call_output', 'call_id': 'a', 'output': 'first'}),
      row('response_item', {'type': 'custom_tool_call_output', 'call_id': 'a', 'output': 'second'}),
      row('response_item', {'type': 'function_call_output', 'call_id': 'missing', 'output': 'orphan'}),
      row('response_item', {'type': 'function_call', 'name': 'pending', 'call_id': 'b', 'arguments': '{"x":1}'}),
    ])
    summary, events = tool.parse(path)
    calls = [e for e in events if e['kind'] == 'tool_call']
    self.assertEqual(calls[0]['input'], 'raw(code)')
    self.assertEqual([r['text'] for r in calls[0]['results']], ['first', 'second'])
    self.assertEqual(calls[1]['input'], {'x': 1})
    self.assertEqual(calls[1]['results'], [])
    self.assertFalse(next(e for e in events if e.get('text') == 'orphan')['paired'])
    self.assertEqual(summary['tools'], {'exec': 1, 'pending': 1})

  def test_new_usage_is_scoped_and_deduplicated(self):
    def usage(response, count, total, thread='root-one'):
      return row('token_usage_record', {'thread_id': thread, 'response_id': response,
                 'usage': {'total_tokens': count}, 'thread_token_usage': {'total_tokens': total}})
    path = self.write('usage.jsonl', [usage('r1', 10, 10), usage('r1', 12, 12),
      usage('r2', 8, 20), usage('other', 500, 500, 'another-thread'),
      row('event_msg', {'type': 'token_count', 'info': {'total_token_usage': {'total_tokens': 900}}})])
    summary, _ = tool.parse(path)
    self.assertEqual(summary['usage'], {'total_tokens': 20})
    self.assertEqual(summary['observed_response_usage'], {'total_tokens': 20})
    self.assertEqual(summary['distinct_response_count'], 2)
    self.assertIsNone(summary['cost_usd'])

  def test_old_usage_snapshots_are_not_summed(self):
    usage = row('event_msg', {'type': 'token_count', 'info': {
      'total_token_usage': {'input_tokens': 20, 'cached_input_tokens': 10, 'output_tokens': 5}}})
    path = self.write('old.jsonl', [usage, usage, row('event_msg', {'type': 'token_count', 'info': None})])
    self.assertEqual(tool.parse(path)[0]['usage'], usage['payload']['info']['total_token_usage'])

  def test_compaction_fork_and_encrypted_peer(self):
    path = self.write('child.jsonl', [
      row('compacted', {'replacement_history': [message('user', 'old request')['payload']]}),
      message('user', 'Child task'),
      row('response_item', {'type': 'agent_message', 'author': '/root', 'recipient': '/root/child',
          'content': [{'type': 'encrypted_content', 'encrypted_content': 'secret-blob'}]}),
    ], {'id': 'child', 'session_id': 'root-one', 'source': {'subagent': {'thread_spawn': {
      'parent_thread_id': 'root-one'}}}, 'subagent_history_start_ordinal': 500})
    summary, events = tool.parse(path)
    self.assertEqual(summary['thread_id'], 'child')
    self.assertEqual(summary['parent_thread_id'], 'root-one')
    self.assertEqual(summary['event_counts']['task_input'], 1)
    self.assertEqual(len(events), 3)
    self.assertNotIn('secret-blob', json.dumps(events))
    self.assertTrue(any('inherited' in w for w in summary['warnings']))

  def test_embedded_time_and_malformed_tail(self):
    path = self.write('time.jsonl', [row('event_msg', {'type': 'task_complete',
      'completed_at': 1767225605}, '2026-01-01T01:00:00Z')])
    with path.open('a', encoding='utf-8') as stream:
      stream.write('{unfinished')
    summary, events = tool.parse(path)
    self.assertEqual(events[0]['ts'], '2026-01-01T00:00:05+00:00')
    self.assertEqual(events[0]['time_source'], 'completed_at')
    self.assertTrue(summary['warnings'])

  def test_archives_ambiguity_and_explicit_parentage(self):
    root = self.write('sessions/root.jsonl', [])
    child = self.write('archived_sessions/child.jsonl', [], {'id': 'child-one', 'parent_thread_id': 'root-one'})
    self.write('sessions/fork.jsonl', [], {'id': 'root-two', 'forked_from_id': 'root-one'})
    catalog = tool.discover(self.root)
    self.assertEqual(tool.resolve('child', catalog), child)
    with self.assertRaisesRegex(ValueError, 'Ambiguous'):
      tool.resolve('root', catalog)
    self.assertEqual({p for p, _ in tool.family(root, catalog)}, {root, child})

  def test_export_cannot_overwrite_or_write_to_session_storage(self):
    source = self.write('sessions/root.jsonl', [])
    with self.assertRaises(ValueError):
      tool.write_export(self.root / 'sessions/output.json', {}, self.root, {source})
    output = self.root / 'result.json'
    tool.write_export(output, {'ok': True}, self.root, {source})
    self.assertEqual(json.loads(output.read_text()), {'ok': True})
    with self.assertRaises(FileExistsError):
      tool.write_export(output, {}, self.root, {source})

  def test_reject_public_exec_stream(self):
    path = self.root / 'exec.jsonl'
    path.write_text('{"type":"thread.started","thread_id":"x"}\n', encoding='utf-8')
    with self.assertRaisesRegex(ValueError, 'Not a supported Codex rollout'):
      tool.parse(path)


if __name__ == '__main__':
  unittest.main()
