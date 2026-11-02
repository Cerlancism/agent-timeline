#!/usr/bin/env python3
"""Read local Codex rollout files; never execute recorded tools or edit sources."""
import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys


INJECTED_PREFIXES = (
  '# AGENTS.md instructions', '<environment_context>', '<permissions instructions>',
  '<skill>', '<skills_instructions>', '<turn_aborted>', '<external_codex_apps_open_page>',
  '<codex_apps_', '<user_instructions>',
)
KNOWN_OUTER = {
  'session_meta', 'turn_context', 'response_item', 'event_msg', 'token_usage_record',
  'compacted', 'world_state', 'inter_agent_communication_metadata',
}


def read_rows(path):
  warnings = []
  rows = []
  with path.open(encoding='utf-8-sig') as stream:
    for line_no, line in enumerate(stream, 1):
      if not line.strip():
        continue
      try:
        row = json.loads(line)
        if not isinstance(row, dict) or not isinstance(row.get('payload'), dict):
          raise ValueError('expected a rollout envelope with an object payload')
        rows.append((line_no, row))
      except ValueError as error:
        warnings.append(f'Line {line_no}: skipped invalid record ({error}).')
  return rows, warnings


def metadata(path):
  # Discovery needs no transcript body, and does not expose account identifiers.
  with path.open(encoding='utf-8-sig') as stream:
    for _, line in zip(range(30), stream):
      try:
        row = json.loads(line)
      except ValueError:
        continue
      if isinstance(row, dict) and row.get('type') == 'session_meta':
        return row.get('payload', {})
  return {}


def identity(meta):
  source = meta.get('source')
  sub = source.get('subagent', {}) if isinstance(source, dict) else {}
  spawn = sub.get('thread_spawn', {}) if isinstance(sub, dict) else {}
  spawn = spawn if isinstance(spawn, dict) else {}
  return {
    'thread_id': meta.get('id') or meta.get('session_id'),
    'session_id': meta.get('session_id'),
    'parent_thread_id': meta.get('parent_thread_id') or spawn.get('parent_thread_id'),
    'agent_path': meta.get('agent_path') or spawn.get('agent_path'),
    'agent_nickname': meta.get('agent_nickname') or spawn.get('agent_nickname'),
    'source': source,
    'cwd': meta.get('cwd'),
    'cli_version': meta.get('cli_version'),
    'forked_from_id': meta.get('forked_from_id'),
  }


def discover(root):
  found = []
  seen = set()
  for folder in ('sessions', 'archived_sessions'):
    for path in sorted((root / folder).rglob('*.jsonl')):
      path = path.resolve()
      if path in seen:
        continue
      seen.add(path)
      try:
        meta = metadata(path)
      except OSError as error:
        print(f'warning: cannot read {path}: {error}', file=sys.stderr)
        continue
      if identity(meta)['thread_id']:
        found.append((path, meta))
  return found


def resolve(target, catalog):
  path = Path(target).expanduser()
  if path.is_file():
    return path.resolve()
  hits = [path for path, meta in catalog
          if str(identity(meta)['thread_id']).startswith(target)]
  if len(hits) != 1:
    details = '\n'.join(str(path) for path in hits)
    raise ValueError(f'{"Ambiguous" if hits else "No matching"} thread ID: {target}'
                     + (f'\n{details}' if details else ''))
  return hits[0]


def visible(value):
  if isinstance(value, str):
    return value
  if isinstance(value, list):
    return '\n'.join(filter(None, (visible(part) for part in value)))
  if isinstance(value, dict):
    if isinstance(value.get('text'), str):
      return value['text']
    kind = value.get('type', 'unknown')
    if kind in ('text', 'input_text', 'output_text', 'summary_text'):
      return ''
    return f'[{kind}: content unavailable]' if 'type' in value else json.dumps(value, ensure_ascii=False)
  return '' if value is None else str(value)


def decode(value):
  if isinstance(value, str):
    try:
      return json.loads(value)
    except ValueError:
      pass
  return value


def iso(value, milliseconds=False):
  try:
    if isinstance(value, (int, float)):
      return datetime.fromtimestamp(value / (1000 if milliseconds else 1), timezone.utc).isoformat()
    if isinstance(value, str):
      dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
      if dt.tzinfo is None:
        return None
      return dt.astimezone(timezone.utc).isoformat()
  except (ValueError, OverflowError, OSError):
    pass
  return None


def event_time(row):
  p = row['payload']
  internal = p.get('internal_chat_message_metadata_passthrough') or {}
  for value, milliseconds, source in (
    (internal.get('create_time'), False, 'create_time'),
    (p.get('completed_at_ms'), True, 'completed_at_ms'),
    (p.get('completed_at'), False, 'completed_at'),
    (p.get('started_at'), False, 'started_at'),
    (row.get('timestamp'), False, 'envelope'),
  ):
    ts = iso(value, milliseconds)
    if ts:
      return ts, source
  return None, 'missing'


def message_kind(role, text, is_child):
  if role == 'assistant':
    return 'assistant'
  if role != 'user' or text.lstrip().startswith(INJECTED_PREFIXES):
    return 'injected'
  if text.startswith('Message Type:'):
    return 'peer'
  return 'task_input' if is_child else 'human'


def parse(path):
  rows, warnings = read_rows(path)
  meta = next((r['payload'] for _, r in rows if r['type'] == 'session_meta'), None)
  if not meta or not identity(meta)['thread_id']:
    raise ValueError(f'Not a supported Codex rollout (missing session_meta identity): {path}')
  info = identity(meta)
  thread = info['thread_id']
  child = bool(info['parent_thread_id'] or isinstance(info['source'], dict))
  if meta.get('forked_from_id') or 'subagent_history_start_ordinal' in meta:
    warnings.append('Fork/inherited history: event attribution may include parent context; no family usage total is inferred.')
  events = []
  messages = [[], [], []]
  models = set()
  efforts = set()
  calls = {}
  response_usage = {}
  latest_usage = None
  fallback_usage = None
  usage_source = None
  turn = None
  unknown = Counter()
  record_types = Counter()
  for line_no, row in rows:
    p = row['payload']
    outer, kind = row.get('type'), p.get('type')
    record_types[f'{outer}:{kind}' if kind else outer] += 1
    ts, time_source = event_time(row)
    internal = p.get('internal_chat_message_metadata_passthrough') or {}
    base = {'ts': ts, 'recorded_ts': row.get('timestamp'), 'time_source': time_source,
            'thread_id': thread, 'turn_id': p.get('turn_id') or internal.get('turn_id') or turn,
            'source_file': str(path), 'source_line': line_no}
    if outer == 'turn_context':
      turn = p.get('turn_id')
      if p.get('model'):
        models.add(p['model'])
      if p.get('effort'):
        efforts.add(p['effort'])
    elif outer == 'world_state':
      model = (p.get('state') or {}).get('model')
      if isinstance(model, str):
        models.add(model)
    elif outer == 'token_usage_record':
      if p.get('thread_id') not in (None, thread):
        continue
      if isinstance(p.get('thread_token_usage'), dict):
        latest_usage = p['thread_token_usage']
        usage_source = 'token_usage_record.thread_token_usage'
      if p.get('response_id') and isinstance(p.get('usage'), dict):
        response_usage[p['response_id']] = p['usage']
    elif outer == 'response_item':
      if kind == 'message':
        text = visible(p.get('content'))
        messages[0].append({**base, 'kind': message_kind(p.get('role'), text, child),
                            'text': text, 'role': p.get('role'), 'phase': p.get('phase')})
      elif kind in ('function_call', 'custom_tool_call'):
        call = {**base, 'kind': 'tool_call', 'call_id': p.get('call_id'),
                'tool': '.'.join(filter(None, (p.get('namespace'), p.get('name')))),
                'input': decode(p.get('arguments') if kind == 'function_call' else p.get('input')),
                'results': []}
        events.append(call)
        if call['call_id']:
          calls[call['call_id']] = call
      elif kind in ('function_call_output', 'custom_tool_call_output'):
        result = {**base, 'kind': 'tool_result', 'call_id': p.get('call_id'),
                  'text': visible(p.get('output')), 'output': p.get('output')}
        call = calls.get(p.get('call_id'))
        result['paired'] = call is not None
        if call is not None:
          result['tool'] = call['tool']
          call['results'].append({'ts': ts, 'source_line': line_no, 'text': result['text']})
        events.append(result)
      elif kind == 'agent_message':
        events.append({**base, 'kind': 'peer', 'text': visible(p.get('content')),
                       'author': p.get('author'), 'recipient': p.get('recipient')})
      elif kind == 'reasoning':
        text = visible(p.get('summary')) or visible(p.get('content'))
        events.append({**base, 'kind': 'reasoning', 'text': text or '[reasoning unavailable]'})
      elif kind == 'compaction':
        events.append({**base, 'kind': 'compaction', 'text': '[opaque compaction item]'})
      elif kind != 'additional_tools':
        unknown[f'{outer}:{kind}'] += 1
    elif outer == 'event_msg':
      if kind == 'token_count':
        usage = (p.get('info') or {}).get('total_token_usage')
        if isinstance(usage, dict):
          fallback_usage = usage
      elif kind == 'item_completed':
        item = p.get('item') or {}
        item_type = item.get('type')
        if item_type in ('UserMessage', 'AgentMessage'):
          role = 'user' if item_type == 'UserMessage' else 'assistant'
          text = visible(item.get('content'))
          messages[1].append({**base, 'kind': message_kind(role, text, child),
                              'text': text, 'role': role, 'phase': item.get('phase')})
        elif item_type != 'Reasoning':
          events.append({**base, 'kind': 'activity', 'activity_type': item_type, 'details': item,
                         'text': str(item_type)})
      elif kind in ('user_message', 'agent_message'):
        role = 'user' if kind == 'user_message' else 'assistant'
        text = visible(p.get('message'))
        messages[2].append({**base, 'kind': message_kind(role, text, child),
                            'text': text, 'role': role, 'phase': p.get('phase')})
      elif kind in ('task_started', 'task_complete', 'turn_aborted'):
        events.append({**base, 'kind': kind, 'text': p.get('reason', ''),
                       'duration_ms': p.get('duration_ms')})
      elif kind != 'thread_settings_applied':
        unknown[f'{outer}:{kind}'] += 1
    elif outer == 'compacted':
      events.append({**base, 'kind': 'compaction', 'text': p.get('message') or '[context compacted]'})
    elif outer not in KNOWN_OUTER:
      unknown[str(outer)] += 1
  # Count per source layer: two identical actual prompts must remain two prompts.
  accepted = Counter()
  for layer in messages:
    remaining = accepted.copy()
    for event in layer:
      key = (event['role'], event['text'])
      if remaining[key]:
        remaining[key] -= 1
      else:
        events.append(event)
        accepted[key] += 1
  events.sort(key=lambda event: event['source_line'])
  totals = Counter()
  for usage in response_usage.values():
    totals.update({k: v for k, v in usage.items() if isinstance(v, (int, float))})
  if latest_usage is None and fallback_usage is not None:
    latest_usage = fallback_usage
    usage_source = 'event_msg.token_count.info.total_token_usage'
  if latest_usage is None and response_usage:
    latest_usage = dict(totals)
    usage_source = 'distinct response_id usage sum (observed responses only)'
  if latest_usage is not None and response_usage and latest_usage != dict(totals):
    warnings.append('Cumulative usage differs from observed response usage; report these sources separately.')
  timestamps = sorted(event['ts'] for event in events if event['ts'])
  if len({event['recorded_ts'] for event in events}) <= 1 and len(events) > 1:
    warnings.append('Envelope timestamps are flattened; embedded times are used where available.')
  prompts = [event for event in events if event['kind'] in ('human', 'task_input')]
  replies = [event for event in events if event['kind'] == 'assistant']
  final = [event for event in replies if event.get('phase') == 'final']
  summary = {**info, 'path': str(path), 'models': sorted(models), 'efforts': sorted(efforts),
             'first_ts': timestamps[0] if timestamps else None,
             'last_ts': timestamps[-1] if timestamps else None,
             'observed_span_seconds': (datetime.fromisoformat(timestamps[-1]) - datetime.fromisoformat(timestamps[0])).total_seconds() if timestamps else None,
             'event_counts': dict(Counter(event['kind'] for event in events)),
             'tools': dict(Counter(event['tool'] for event in events if event['kind'] == 'tool_call')),
             'prompts': [{'ts': e['ts'], 'text': e['text'], 'source_line': e['source_line']} for e in prompts],
             'last_reply': replies[-1]['text'] if replies else None,
             'last_final_reply': final[-1]['text'] if final else None,
             'usage': latest_usage, 'usage_source': usage_source,
             'observed_response_usage': dict(totals) if response_usage else None,
             'distinct_response_count': len(response_usage), 'cost_usd': None,
             'record_types': dict(record_types), 'unsupported_records': dict(unknown),
             'warnings': warnings}
  return summary, events


def family(path, catalog):
  selected = [(path, metadata(path))]
  ids = {identity(selected[0][1])['thread_id']}
  paths = {path}
  while True:
    additions = [(p, m) for p, m in catalog if p not in paths and identity(m)['parent_thread_id'] in ids]
    if not additions:
      return selected
    selected.extend(additions)
    paths.update(p for p, _ in additions)
    ids.update(identity(m)['thread_id'] for _, m in additions)


def write_export(output, data, root, source_paths):
  dest = Path(output).expanduser().resolve()
  protected = [(root / name).resolve() for name in ('sessions', 'archived_sessions')]
  protected.extend(path.resolve().parent for path in source_paths)
  if dest in source_paths or any(dest.is_relative_to(folder) for folder in protected):
    raise ValueError('Export destination must be outside transcript storage.')
  with dest.open('x', encoding='utf-8') as stream:
    json.dump(data, stream, ensure_ascii=False, indent=2)
    stream.write('\n')


def main():
  parser = argparse.ArgumentParser(description=__doc__)
  parser.add_argument('--root', type=Path, default=Path(os.environ.get('CODEX_HOME') or Path.home() / '.codex'), help='Codex home containing sessions/ and archived_sessions/')
  commands = parser.add_subparsers(dest='command', required=True)
  for name in ('find', 'summary', 'tree', 'timeline', 'export'):
    command = commands.add_parser(name)
    command.add_argument('target', help='thread ID, unambiguous prefix, or JSONL path')
    if name in ('timeline', 'export'):
      command.add_argument('--agents', action='store_true', help='include descendants with explicit parent links')
    if name == 'timeline':
      command.add_argument('--injected', action='store_true')
      command.add_argument('--no-tools', action='store_true')
      command.add_argument('--full', action='store_true')
      command.add_argument('--limit', type=int, default=100)
      command.add_argument('--width', type=int, default=180)
    if name == 'export':
      command.add_argument('-o', '--output', required=True)
  args = parser.parse_args()
  root = args.root.expanduser().resolve()
  try:
    catalog = discover(root)
    path = resolve(args.target, catalog)
    if args.command == 'find':
      print(json.dumps({'path': str(path), **identity(metadata(path))}, ensure_ascii=False, indent=2))
      return
    selected = family(path, catalog) if args.command == 'tree' or getattr(args, 'agents', False) else [(path, metadata(path))]
    parsed = [parse(p) for p, _ in selected]
    summaries = [s for s, _ in parsed]
    events = [e for _, group in parsed for e in group]
    events.sort(key=lambda e: (e['ts'] is None, e['ts'] or '', e['thread_id'], e['source_line']))
    if args.command == 'summary':
      print(json.dumps(summaries[0], ensure_ascii=False, indent=2))
    elif args.command == 'tree':
      by_parent = defaultdict(list)
      for summary in summaries[1:]:
        by_parent[summary['parent_thread_id']].append(summary)
      seen = set()

      def show(summary, depth=0):
        if summary['thread_id'] in seen:
          return
        seen.add(summary['thread_id'])
        print('  ' * depth + f"{summary['thread_id']} {summary['agent_path'] or summary['source']} "
              + f"models={','.join(summary['models']) or '?'} span={summary['observed_span_seconds']}s "
              + f"calls={sum(summary['tools'].values())}")
        for warning in summary['warnings']:
          print('  ' * (depth + 1) + 'warning: ' + warning)
        for child_summary in by_parent[summary['thread_id']]:
          show(child_summary, depth + 1)

      show(summaries[0])
    elif args.command == 'timeline':
      if args.limit < 1 or args.width < 1:
        raise ValueError('--limit and --width must be positive.')
      shown = 0
      for event in events:
        if not args.injected and event['kind'] in ('injected', 'peer'):
          continue
        if args.no_tools and event['kind'] in ('tool_call', 'tool_result', 'activity'):
          continue
        text = event.get('text', '')
        if event['kind'] == 'tool_call':
          text = event['tool'] + ' ' + json.dumps(event['input'], ensure_ascii=False)
        if not args.full:
          text = ' '.join(text.split())
          if len(text) > args.width:
            text = text[:args.width] + '...'
        print(f"{event['ts'] or '?'} {event['thread_id']} {event['kind']} {text}")
        shown += 1
        if shown >= args.limit:
          print('Timeline limit reached; use export for complete events.', file=sys.stderr)
          break
      for summary in summaries:
        for warning in summary['warnings']:
          print('warning: ' + warning, file=sys.stderr)
    else:
      write_export(args.output, {'schema_version': 1, 'threads': summaries, 'events': events}, root, {p for p, _ in selected})
      print(f'Exported {len(events)} events across {len(summaries)} thread(s) to {args.output}')
  except (OSError, ValueError) as error:
    print(f'error: {error}', file=sys.stderr)
    sys.exit(2)


if __name__ == '__main__':
  if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
  main()
