# Agent Timeline

Observe what your coding agents actually do, while they work or long after. Agent Timeline turns transcripts from agent harnesses such as Claude Code and Codex (with more to come) into an interactive map and timeline of every agent in a session: who spawned whom, what each one was asked, which tools it ran, and how work and messages flowed between them.

Explore a long multi-agent run at a glance, inspect any prompt, reply or tool call in full, replay the session step by step, or monitor one live as it unfolds. With the whole run laid out, it is easy to analyse where time and context went and take those insights into the next session.

## What it shows

- **Agent map**: the main session and every subagent it spawned, the messages that passed between them, and each agent's context size.
- **Conversation**: every agent's events merged in time order, played back step by step.
- **Details**: the selected event in full, from prompts and replies to tool calls with their results and edits as before and after.
- **Timeline**: one row per agent, showing when each was active and the flow of messages between them.
- **Context chart**: how much context every agent held across the session, compactions included.

Tick several sessions in the list to open them together, their agents and events interleaved by time on one timeline.

## Works with what you already have

Agent Timeline reads the transcripts your agents already write: Claude Code's under `~/.claude/projects`, and Codex's under `~/.codex/sessions` and `~/.codex/archived_sessions` (or your custom `CODEX_HOME`). There are no hooks, MCP servers, plugins or telemetry to set up, so sessions recorded before you found it work just as well. Add both harnesses' directories to browse them side by side, each session labeled with its harness. Support for more agent harnesses is on the way.

Everything runs privately and directly in your browser from plain HTML, CSS and JavaScript modules, with no build step and no dependencies. Transcripts are only ever read, and nothing is uploaded anywhere.

## Web Interface: https://cerlancism.github.io/agent-timeline/app

No setup needed. In Chrome or Edge, choose "Add directory" and paste the suggested Claude or Codex path into the picker; in other browsers, open transcript files (see [Opening transcript files](#opening-transcript-files)). Transcripts are read in the browser and never uploaded.

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

Run it where the transcripts are and open the printed URL. For transcripts inside a WSL distribution, start the server in that distribution and open the same localhost URL from the Windows browser. The server exposes the transcripts under its root without authentication, so leave it on the loopback address unless you trust the network; `--host` binds elsewhere and prints a warning.

### Opening transcript files

On the web interface and in either local mode, "Open files" or drag and drop opens one session from its transcript files as a static copy without live updates, for example files copied from another machine:

- **Claude Code**: the session's `.jsonl` together with its `agent-*.jsonl` and `agent-*.meta.json` files; filenames identify each file's role.
- **Codex**: a root rollout and its descendant rollout files; filenames may be changed because identity comes from session metadata. Codex CLI `exec --json` output and analysis exports are not rollout files. Forks can include inherited events; recorded token totals are not deduplicated family usage or billing figures.

A session, or a combination of sessions, can be linked directly with the `session` query parameter, for example `/app/?session=<id>` or `/app/?session=<id>,<id>`.

## Documentation

[docs/specification.md](docs/specification.md) describes every feature, how the transcript format is interpreted, the server's API, and the known limitations. The code lives in [app/](app/), with the server in [server.mjs](server.mjs).
[docs/design.md](docs/design.md) records the visual direction of the compact, black interface and its component and color inventory.
