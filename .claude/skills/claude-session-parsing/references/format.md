# Claude Code session transcript format

Observed on Claude Code 2.1.283 through 2.1.310 (Windows, CLI and VS Code entrypoints), 111 sessions.
Fields appear and disappear between versions, so treat every key as optional.

## Contents

1. Where things live
2. Common envelope fields
3. Conversation records: `user`, `assistant`, `system`
4. Bookkeeping records
5. Attachments (system reminders)
6. `toolUseResult` shapes by tool
7. Subagent files
8. Other global files

## 1. Where things live

```
~/.claude/
  projects/<slug>/                      slug = cwd with ":" "\" "/" replaced by "-"  (z:\AI -> z--AI)
    <session-id>.jsonl                  main transcript
    <session-id>/                       sidecar (only when needed)
      subagents/agent-<agentId>.jsonl   one transcript per spawned agent (any depth, flat)
      subagents/agent-<agentId>.meta.json
      tool-results/<id>.txt             persisted large tool outputs
      custom-title.json                 {"customTitle": ...} if the user renamed the session
      workflows/wf_*.json, scripts/     Workflow tool runs
    sessions-index.json                 (some projects) cached list: sessionId, firstPrompt, created, modified
  history.jsonl                         one line per typed prompt: display, timestamp, project, sessionId
  sessions/<pid>.json                   live-process registry, not transcripts
```

Temp task output (`tasks/<id>.output`, scratchpad) lives under `%LOCALAPPDATA%\Temp\claude\<slug>\<session-id>\`
and is not part of the transcript.

## 2. Common envelope fields

Conversation records (`user`, `assistant`, `attachment`, `system`) carry:

| field | meaning |
|---|---|
| `uuid`, `parentUuid` | linked list of the context the model saw; `parentUuid: null` starts a thread. Every parent resolves inside the same file. |
| `timestamp` | ISO 8601 UTC, written when the record is appended; not monotonic in file order |
| `sessionId` | top-level session id, same in subagent files |
| `agentId` | present only inside subagent files |
| `isSidechain` | true in subagent files |
| `isMeta` | harness-generated content in the user role (skill bodies, peer messages) |
| `cwd`, `gitBranch`, `version`, `entrypoint` (`cli`, `claude-vscode`), `userType` | environment |
| `promptId` | groups everything done in reply to one human prompt |

## 3. Conversation records

### `user`

`message.content` is either a string or a list of blocks (`text`, `image`, `tool_result`).

Classify by:

- **tool result**: any `tool_result` block. Extra fields: `toolUseResult` (structured, tool-specific, see 6),
  `sourceToolAssistantUUID`, `permissionDecision` (`{decision, source}`), `sandboxed`, `classifierBoundary`.
  `tool_result.content` is a string or a list of `text`/`image` blocks; `is_error: true` marks failures.
- **human prompt**: `origin.kind == "human"`, plus `promptSource` (`sdk`, `system`), `turnOrigin`, `turnPosition`
  `{promptIndex, turnIndex}`, `permissionMode`, `imagePasteIds`. Older files lack `origin`; fall back to
  "text content, not isMeta, not starting with a harness marker". Slash commands arrive as
  `<command-message>x</command-message><command-name>/x</command-name>` plus args; IDE context as `<ide_opened_file>`.
- **injected**: `origin.kind == "peer"` (subagent hand-back or SendMessage, body under `origin.body`, sender under
  `origin.from`), `origin.kind == "task-notification"` (text starts `<task-notification>`), `isMeta: true`
  (skill SKILL.md contents right after a `Skill` tool call, `turnCompanion`), queued commands.

### `assistant`

One record per content block of one API response. Shared `message.id` (`msg_...`), `requestId`, `apiBlockIndex`
0..n. `message.content` holds a single block: `thinking` (text usually empty, `signature` present,
`thinkingDurationMs` on the record), `text`, or `tool_use` (`id`, `name`, `input`, `caller`).
`message.usage` is identical on every block of the message:
`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`,
`output_tokens_details.thinking_tokens`, `cache_creation.ephemeral_1h_input_tokens`, `service_tier`, `speed`.
Also `message.model`, `stop_reason` (on the last block), `requestedModel`, `effort`, `perTurnEffort`,
`attributionSkill` (skill that was active), `wireToolInputs` (tool input exactly as sent).

### `system`

`subtype` values seen: `turn_duration` (`durationMs`, `messageCount`), `compact_boundary` (`compactMetadata`
with `trigger`, `preTokens`, `preservedSegment`, `logicalParentUuid`), `stop_hook_summary` (`hookInfos`,
`hookErrors`), `local_command` (`<local-command-stdout>` of slash commands like /output-style),
`away_summary` (recap shown after the user was away), `informational` (notices such as safeguard stops).

## 4. Bookkeeping records (safe to skip)

| type | content |
|---|---|
| `api-request` | per API call: `params` (model, betas, max_tokens, thinking, effort), `shapeHash`, `tail`/`base` hashes into blobs, `querySource` (`sdk`, `agent:custom:<type>`), `cacheControl` |
| `api-request-blob` | a message as sent on the wire, keyed by `hash`; lets the exact request be rebuilt |
| `api-request-shape` | system prompt + tool list snapshot keyed by `shapeHash` |
| `queue-operation` | `enqueue` / `dequeue` / `remove` of pending prompts; `remove` carries the dropped `content` |
| `last-prompt` | `lastPrompt` text and `leafUuid`, rewritten each turn |
| `ai-title` | model-generated title, rewritten as the session evolves; take the last |
| `custom-title`, `agent-name` | user-set title; session name when run as a named agent |
| `atis-latch` | opaque hash |
| `cost-state` | cumulative `totalCostUSD`, `totalAPIDuration` (ms), `totalToolDuration`, `totalDuration`, `totalLinesAdded/Removed`, `modelUsage{model: {inputTokens, outputTokens, thinkingTokens, cacheRead..., cacheCreation..., costUSD}}`, `startTime` (epoch ms). Includes subagents. Appears at end, sometimes several times; take the last |
| `file-history-snapshot`, `file-history-delta` | backups of files Claude edited (`trackingPath`, `backup`) |
| `mode`, `permission-mode` | `normal`/`plan`, `auto`/`default`... |
| `continued-in` | `continuedInSessionId` after a fork or resume into a new file |
| `summary` | legacy (pre-2.1) session summary with `leafUuid` |

## 5. Attachments

`type: attachment`, payload in `attachment.type`. `rendered[].content` holds the `<system-reminder>` text the
model saw. Useful ones: `environment` (platform, cwd), `model` (`identity.modelId`), `instructions` (CLAUDE.md
contents, `files[]`), `skill_listing`, `agent_listing_delta`, `mcp_instructions_delta`, `prompt_snapshot`
(`systemPrompt[]`), `output_style`, `auto_mode`, `queued_command` (text of a prompt that arrived mid-turn),
`skill_mention`, `invoked_skills`, `edited_text_file` (file changed on disk), `file` (file content shown after
compaction), `compact_file_reference`, `hook_additional_context` (hook output such as IDE diagnostics),
`session_context` (userEmail, gitStatus), `date`, `total_tokens_reminder`, `deferred_tools_record`,
`batching_reminder_sent`, `silent_turn_reminder`, `command_permissions`, `plan_mode`/`plan_mode_exit`,
`auto_mode_exit`, `remote_session_change` (commit attribution), `credential_org`, `session_cron_carry`.

## 6. `toolUseResult` shapes by tool

| tool | keys |
|---|---|
| Bash | `stdout`, `stderr`, `interrupted`, `isImage`, `noOutputExpected`; optional `bashEditDiff`, `backgroundTaskId`, `backgroundCwdHint`, `returnCodeInterpretation`, `persistedOutputPath`, `persistedOutputSize`, `staleReadFileStateHint` |
| Read | `type: text`, `file{filePath, content, numLines, startLine, totalLines}` |
| Write | `type: create/update`, `filePath`, `content`, `originalFile`, `structuredPatch` |
| Edit | `filePath`, `oldString`, `newString`, `originalFile`, `replaceAll`, `structuredPatch`, `userModified`, `contentNotInModelContext` |
| Glob / Grep | `filenames`, `numFiles`, `mode`, `content`, `numLines`, `totalLines` |
| Agent (background) | `isAsync: true`, `status: async_launched`, `agentId`, `description`, `resolvedModel`, `prompt`, `outputFile`, `canContinueAgent` |
| Agent (foreground) | `agentId`, `description`, `isAsync: false`, `outputFile`, `prompt`, result text in `tool_result.content` |
| SendMessage | `success`, `message`, `resumedAgentId`, `revivedAgentId`, `pin` |
| Skill | `success`, `commandName` (the SKILL.md body follows as an `isMeta` user record) |
| AskUserQuestion | `questions`, `answers` |
| WebFetch | `bytes`, `code`, `codeText`, `durationMs`, `result`, `url` |
| WebSearch | `query`, `results`, `durationSeconds`, `searchCount` |
| TaskStop | `command`, `message`, `task_id`, `task_type` |
| SubagentHandback | `{"success": true, "message": "Report delivered to your caller."}` as plain content |

`toolUseResult` is `null` for tools without structured output and a plain string for some error cases.

## 7. Subagent files

`agent-<agentId>.meta.json`:

```json
{"agentType": "...", "isBuiltIn": false, "description": "...", "toolUseId": "toolu_...",
 "parentAgentId": "...", "spawnDepth": 2, "requestShape": "foreground|background",
 "requestNonInteractive": true, "finished": true, "launchedWithDefaults": true}
```

No `parentAgentId` means the main session spawned it. The transcript has the same record types as the main
file (its own `attachment`, `api-request`, `assistant`, `user` rows), `isSidechain: true`, `agentId` set,
first `user` record is the spawn prompt, and the final report is a `SubagentHandback` tool call. `api-request.querySource`
is `agent:custom:<agentType>` for user-defined agents. A background agent's hand-back shows up in the parent
as a `user` record with `origin.kind: peer`, `origin.from: <agentId>`, text starting
"Another Claude session sent a message:". Resuming an agent with SendMessage appends to the same file.

## 8. Other global files

- `~/.claude/history.jsonl`: `{display, pastedContents, timestamp(ms), project, sessionId}` per prompt. Fastest way to
  map a remembered prompt to a session id, or list sessions per project.
- `~/.claude/projects/<slug>/sessions-index.json`: `{version, entries[{sessionId, fullPath, firstPrompt, messageCount, created, modified, gitBranch, projectPath}]}`.
