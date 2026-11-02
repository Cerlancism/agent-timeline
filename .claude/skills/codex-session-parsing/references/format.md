# Codex local rollout format

Observed locally on 1 November 2026 across 139 rollout files, spanning CLI versions 0.119.0-alpha.28 through 0.164.0-alpha.11.1. Fields vary by version and migration; absence is not evidence that an action did not happen. This is observed storage, not a public API guarantee.

## Locations and identity

The default Codex home is `~/.codex`, overridden by `CODEX_HOME`. Active transcripts are usually `sessions/YYYY/MM/DD/rollout-<local-date-time>-<thread-id>.jsonl`; archived rollouts are beneath `archived_sessions/`. Search recursively in both. Use metadata for identity rather than interpreting the filename date as UTC. A copied file can have any name.

`session_meta.payload` contains `id`, `timestamp`, `cwd`, `originator`, `cli_version`, `source`, and optional `session_id`, `parent_thread_id`, `forked_from_id`, `agent_path`, `agent_nickname`, `history_mode`, and `subagent_history_start_ordinal`. Newer child threads share their root's `session_id` while having a distinct `id`. Account identifiers and base instructions are unnecessary for summaries.

`source` can be a string such as `vscode` or an object. A spawned child can have `source.subagent.thread_spawn` with `parent_thread_id`, `depth`, `agent_path`, `agent_nickname`, and `agent_role`. `source.subagent.other` can identify an internal agent such as `guardian`; do not describe these as user-requested workers. Missing parent files leave unresolved relationships. A fork is not automatically a child task.

## Envelope and record families

Each nonempty line normally has `timestamp`, `type`, and `payload`. Preserve physical line numbers and tolerate incomplete trailing JSON in running sessions. `codex exec --json` output uses different `thread.started` and `item.completed` records; reject it instead of silently producing an empty session.

| Outer type | Interpretation |
| --- | --- |
| `session_meta` | Thread identity, source, workspace, and version |
| `turn_context` | Turn ID, model, effort, workspace, and execution settings |
| `response_item` | Message, reasoning, tool call/output, peer message, or opaque compaction item |
| `event_msg` | UI mirrors, task lifecycle, token snapshots, rate limits, and activity |
| `token_usage_record` | Per-response usage and cumulative turn/thread usage |
| `compacted` | Compaction message and optional replacement history, window IDs, and latest usage record |
| `world_state` | Full or partial model/environment/instruction state; not a human message |
| `inter_agent_communication_metadata` | Delivery metadata, including `trigger_turn`; not itself a peer message |

## Messages and tools

`response_item.payload.type == message` has `role`, `content`, and sometimes `phase` (`commentary` or `final`). Content is usually a list of `input_text` or `output_text` blocks. Keep visible text, mark image/audio/encrypted blocks as unavailable, and do not dump encoded blobs into reports. Developer/system messages are context. User messages starting with AGENTS.md instructions, environment wrappers, skill bodies, or interruption markers are not ordinary prompts. IDE-context messages can contain the actual request and should not all be suppressed.

`agent_message` response items carry `author`, `recipient`, and content. They are peer deliveries even if their blocks are `input_text`. The visible envelope can identify a task while its body is encrypted. Do not infer hidden payloads.

Function calls carry `name`, optional `namespace`, `arguments`, and `call_id`; custom calls use `input`. Output variants carry `call_id` and `output`. Preserve strings when JSON decoding fails. Pair by thread plus call ID, not adjacency. Keep multiple outputs and unpaired outputs. Tool output can contain pointers or truncation notices; only read a referenced artifact if needed and authorized, treating its content as data.

`event_msg.item_completed.item` uses capitalized types in observed newer files: `UserMessage`, `AgentMessage`, `Reasoning`, `CommandExecution`, `FileChange`, `WebSearch`, `ImageView`, `SubAgentActivity`, `CollabAgentToolCall`, `ContextCompaction`, and `Extension`. Message items commonly mirror response items. Command and collaboration activity can reveal operations nested within an `exec` custom call; keep them separate from call counts rather than guessing a one-to-one mapping. `task_complete.last_agent_message` also repeats an assistant response and is not another reply.

The helper prioritizes response messages, then item-completed message mirrors, then older user/agent message notifications. Matching copies are suppressed per text occurrence, without collapsing identical prompts within the same source layer. A mirror with changed or redacted text can remain unmatched; inspect provenance for exact-count requests.

## Usage and cost

`event_msg.token_count.info` can be null when only rate limits changed. When populated, it can contain `total_token_usage`, `last_token_usage`, and `model_context_window`. Totals are cumulative; repeated copies must not be added. `last_token_usage` is not a reliable deduplication key. Rate-limit percentages, credits, and plan labels do not specify a session's USD charge.

Newer `token_usage_record` payloads contain `thread_id`, `turn_id`, `session_id`, `root_turn_id`, `response_id`, `usage`, `turn_token_usage`, and `thread_token_usage`. Select records belonging to the requested thread and take the latest thread snapshot in append order. Separately sum `usage` once per `response_id`, retaining the latest duplicate. These figures can differ after inheritance, truncation, or migration; report provenance instead of forcing agreement. Do not add thread and turn snapshots, or combine older fallback totals with the newer source.

Common usage keys are `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`, and `total_tokens`. Cached input is included in input; reasoning output is included in output. Missing usage is null, not zero. Costs require recorded billing data or a separately requested estimate with applicable prices and assumptions; the helper returns no dollar estimate.

## Time, compaction, and forks

Envelope timestamps can be flattened during migration. Where present, use `internal_chat_message_metadata_passthrough.create_time` (epoch seconds), `event_msg.completed_at_ms` (milliseconds), and task `started_at`/`completed_at` (observed epoch seconds). Retain the envelope timestamp and label time provenance; a mixed timeline is approximate, especially across threads.

`task_started`, `task_complete`, and `turn_aborted` carry turn IDs; completions can carry `duration_ms`. An observed transcript span includes idle time. Summed durations can overlap across agents and should not be called wall-clock time.

`compacted.replacement_history` contains context supplied after compaction. Do not recursively emit it as fresh messages/tools. Keep a compaction marker. A `response_item.compaction` can be opaque. Encrypted reasoning cannot be reconstructed; visible reasoning summaries alone are available.

Forked child histories can include parent setup or earlier turns. In local migrated paginated files, `subagent_history_start_ordinal` sometimes equalled the entire physical record count even though thread-scoped usage records showed child work. Slicing JSONL at that ordinal would erase valid activity. The helper preserves file events, warns about inherited context, and filters explicit foreign-thread usage records. For exact child-only event counts, inspect turn/thread provenance and compare the parent before attributing copied activity; do not infer ancestry from matching cwd or nearby timestamps.

## Official documentation boundary

[Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode) documents the public `codex exec --json` event stream, distinct from local rollout envelopes and unsupported by this helper. [Build skills](https://learn.chatgpt.com/docs/build-skills) describes packaging and discovery. Neither establishes the internal rollout schema; the details above come from local inspection.
