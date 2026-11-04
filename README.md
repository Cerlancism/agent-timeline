# Agent Timeline

Observe what your coding agents actually do, while they work or long after a session ends. Agent Timeline is a session viewer for agent observability across agent harnesses such as Claude Code and Codex (with more to come). It turns their transcripts into an interactive map and timeline of the main agent and every subagent: who spawned whom, what each one was asked, which tools it ran, and how work and messages flowed between them.

Explore a long multi-agent run at a glance, from the orchestrator down to its parallel subagents, then inspect any prompt, reply or tool call in full. Replay the session step by step to debug what went wrong, or monitor one live as it unfolds. With the whole run laid out, it is easy to review what each agent changed and analyze where time, tokens and context went. Carry those insights back into your context engineering: prompts, skills, docs, and how you orchestrate agents.

<img width="800" height="409" alt="agent-timeline-demo-v1-small" src="https://github.com/user-attachments/assets/87d6fadf-fce6-43a8-9ba4-5196aaf3d315" />

## Web Interface: https://cerlancism.github.io/agent-timeline/app

No setup or sign-up needed. In Chrome or Edge, choose "Add directory", paste the suggested Claude or Codex path into the picker, and click "Allow" when the browser asks to let the site view and copy files. In other browsers, open transcript files (see [Opening transcript files](#opening-transcript-files)). Transcripts are read in the browser and never uploaded.

## What it shows

- **Agent map**: the main session and every subagent it spawned, the messages that passed between them, and each agent's context size and token usage.
- **Conversation**: every agent's events merged in time order, played back step by step.
- **Details**: the selected event in full, from prompts and replies to tool calls with their results and edits shown before and after.
- **Timeline**: one row per agent, showing when each was active and the flow of messages between them.
- **Context chart**: how full every agent's context window grew across the session, compactions included.

Tick several sessions in the list to compare them on one timeline, with their agents and events interleaved by time.

## Works with what you already have

Agent Timeline reads the transcripts your agents already write:

- **Claude Code**: `~/.claude/projects`.
- **Codex**: `~/.codex`, covering `sessions` and `archived_sessions`, or your custom `CODEX_HOME`. Token totals are the recorded figures: forks can inherit events, so they are not deduplicated family usage or billing figures.

There are no hooks, MCP servers, plugins or telemetry to set up, so sessions recorded before you found it work just as well. Add both harnesses' directories to browse them side by side, each session labeled with its harness. Support for more agent harnesses is on the way.

Agent Timeline is free, open source and local-first: the viewer runs privately and directly in your browser from plain HTML, CSS and JavaScript modules, with no build step and no dependencies. Transcripts are only ever read, and nothing is uploaded anywhere.

## Running it locally

Run the viewer yourself to keep it entirely offline, or use server mode when the browser cannot mount the transcripts directory.

### Directory mode

Chrome or Edge. Serve the repository with any static server, open `http://127.0.0.1:8765/app/`, and add directories as on the web interface.

```
npx serve -l tcp://127.0.0.1:8765
```

### Server mode

Any browser, including for remote or WSL transcripts. A small dependency-free Node server serves the page and reads the directory for it, so no directory mounting is needed.

```
node server.mjs # ~/.claude/projects on http://127.0.0.1:8765/app/
node server.mjs --root /path/to/projects --port 8766
node server.mjs --root /path/to/.codex --port 8766
```

Run it where the transcripts are and open the printed URL. For transcripts inside a WSL distribution, start the server in that distribution and open the same localhost URL from the Windows browser. The server exposes the transcripts under its root without authentication, so leave it on the loopback address unless you trust the network. Use `--host` to bind elsewhere, which prints a warning.

## Opening transcript files

On the web interface and in either local mode, "Open files" or drag and drop opens one session from its transcript files as a static copy without live updates, for example files copied from another machine:

- **Claude Code**: the session's `.jsonl` together with its `agent-*.jsonl` and `agent-*.meta.json` files. Filenames identify each file's role.
- **Codex**: a root rollout and its descendant rollout files. Filenames may be changed because identity comes from session metadata. Codex CLI `exec --json` output and analysis exports are not rollout files.

## Documentation

| Document | Description |
| --- | --- |
| [docs/specification.md](docs/specification.md) | Every feature, how the transcript format is interpreted, the server's API, and the known limitations. |
| [docs/design.md](docs/design.md) | The visual direction of the compact, black interface and its component and color inventory. |

The code lives in [app/](app/), with the server in [server.mjs](server.mjs).

## License

[MIT](LICENSE)
