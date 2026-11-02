---
name: claude-session-parsing
description: Locate, parse and summarize Claude Code session transcripts (the .jsonl files under ~/.claude/projects, plus their subagents/ and tool-results/ sidecars). Use this whenever the user gives a session id (a UUID like 3dd0f104-60f1-...), a subagent id (agent-xxxx), or a path into ~/.claude/projects, or asks what happened in a past Claude Code session, what a subagent did, how long or how much a run cost, which tools were called, what the user prompted, or wants session data extracted for a timeline, report, dashboard or app. Also use it when a task needs to read raw transcript JSON for any reason, even if the user never says "session" or "transcript", because the raw format has traps (duplicated usage, injected user turns, split messages) that this skill knows how to avoid.
---

# Claude session parsing

Claude Code writes one JSON-lines transcript per session under `~/.claude/projects/<project-slug>/<session-id>.jsonl`.
A session with subagents also has a sidecar directory of the same name holding `subagents/agent-<id>.jsonl`
(plus `.meta.json`) and `tool-results/*.txt` for tool outputs too large to inline.

Reading those files naively gives wrong answers, so start with the bundled script and only drop to raw
JSON when you need a field the script does not surface. The reference file explains the format in
detail; read it when you need to go raw.

- `scripts/session_tool.py` resolves ids, groups split messages, pairs tool calls with results, and walks the subagent tree.
- `references/format.md` catalogs every record type seen in real transcripts, with the traps.

## Workflow

1. **Locate.** Run `find` with whatever the user gave: a full session id, a prefix, a subagent id, or a path.
   It prints the file path, project slug, title, first prompt, cwd, version, time span and subagent count.
   If the id is ambiguous the script lists candidates; if nothing matches, check `~/.claude/history.jsonl`
   (one line per prompt with `sessionId` and `project`) and `sessions-index.json` in the project directory.
2. **Orient.** Run `summary` before anything else. It gives the turn counts, tool mix, models, token usage,
   the `cost-state` totals, and every human prompt on one screen. Most questions ("what was this session
   about", "how much did it cost", "what tools did it use") are answered here.
3. **Go deeper only as needed.**
   - `tree -v` for anything involving subagents: who spawned whom, agent type, model, duration, tool
     counts, the spawn prompt and the hand-back report.
   - `timeline` for the chronological story. Add `--agents` to interleave subagent transcripts,
     `--agent <prefix>` to focus on one, `--full` for untruncated text, `--injected` to see harness
     messages (task notifications, peer messages, skill bodies), `--no-tools` for a prompts-and-replies view.
   - `export -o file.json` when the output feeds another program (a timeline app, a report generator).
     Each event has `ts`, `kind` (human / assistant / tool_use / thinking / injected / system:*), `agent`,
     and for tools `tool`, `input`, `result_text`, `result_ts`, `is_error`, `spawned_agent`.
4. **Answer in the user's terms.** Quote prompts and replies, name tools and agents by their description,
   give durations and costs. Do not echo raw JSON unless asked.

```bash
python -I scripts/session_tool.py find 3dd0f104
python -I scripts/session_tool.py summary 3dd0f104
python -I scripts/session_tool.py tree 3dd0f104 -v
python -I scripts/session_tool.py timeline 3dd0f104 --agents --width 200
python -I scripts/session_tool.py export 3dd0f104 --agents -o session.json
```

The script path is relative to this skill directory; run it from here or give the absolute path.
Use `-I` so Python ignores stray modules in the working directory. Pipe long output through
`head` or redirect to a file; a session with many subagents produces thousands of timeline lines.

## Things that bite when reading the raw files

Know these before writing any ad-hoc parser, because each one has produced wrong numbers in practice.

- **One API response spans several lines.** Each content block (thinking, text, tool_use) is its own
  `assistant` record with the same `message.id` and `apiBlockIndex`. Every copy repeats the full `usage`
  object. Sum tokens per distinct `message.id`, never per line.
- **The `user` role is not the user.** Tool results arrive as `user` records with a `tool_result` block.
  Subagent hand-backs, task notifications, skill bodies and local-command output also arrive as `user`
  records. A real human prompt has `origin.kind == "human"` (newer versions) or, in older files, is a
  non-`isMeta` text record that does not start with `<task-notification>` or
  `"Another Claude session sent a message:"`. Slash commands appear wrapped in `<command-message>` and
  IDE context in `<ide_opened_file>`; those are still human turns.
- **Half the lines are bookkeeping.** `attachment`, `api-request`, `api-request-blob`, `api-request-shape`,
  `queue-operation`, `atis-latch`, `last-prompt`, `ai-title`, `file-history-*` carry no conversation.
  Skip them unless you need system-prompt snapshots, titles or file-backup info.
- **Subagent transcripts live elsewhere.** The main file only shows the `Agent` tool call and a short
  "launched" result. The conversation is in `<session-dir>/subagents/agent-<agentId>.jsonl`; the
  `agentId` is in `toolUseResult.agentId` of the result record. `agent-<id>.meta.json` gives
  `agentType`, `description`, `parentAgentId` and `spawnDepth`, which is how the tree is built. A
  subagent's final report is the `SubagentHandback` tool call in its own file, and it reappears in the
  parent as a `user` record with `origin.kind == "peer"`.
- **Large tool outputs are on disk.** A result starting with `<persisted-output>` is a 2 KB preview; the
  full text is at `toolUseResult.persistedOutputPath` (under `tool-results/`).
- **`cost-state` is cumulative across the session and its subagents**; per-file token sums are not.
  Report cost from `cost-state`, and say which one you used.
- **Timestamps are not monotonic in file order** because records are appended when they complete.
  Sort by `timestamp` for a timeline. Thinking blocks are usually empty strings with only a signature.
- **Compaction** inserts a `system` record with `subtype: compact_boundary`; conversation before it is
  still in the file but was summarized for the model. `continued-in` points to a successor session.

## Reporting

Lead with what the session was about (title, first prompt, outcome from the last assistant message).
Then give the facts the user asked for. For subagent-heavy sessions, present the tree with one line per
agent (type, description, duration, model). When the user asks for data to build something, hand them
the export JSON and describe its event schema rather than describing the raw file format.
