# Repository Guidelines

## Project Structure & Module Organization

Agent Timeline is a browser-only viewer for Claude Code and Codex transcripts, built with plain HTML, CSS, and JavaScript ES modules. Keep application code and assets in `app/`:

- `app.js`: session models, rendering, playback, filters, and live updates; harness-neutral.
- `transcripts.mjs`: harness registry and interface, JSON-lines reading, summaries, and search; pure.
- `claude.mjs`, `codex.mjs`: each harness's pure transcript normalization, user-text classification, and agent tool roles.
- `localfs.mjs`: harness-neutral directory layer: stored handles, layout detection, combined sources, session list, and change checks; also used by the server over Node filesystem handles.
- `claude-fs.mjs`, `codex-fs.mjs`: each harness's directory layout, discovery, session loading, and file snapshots; `handles.mjs` holds their shared handle helpers.
- `remote.mjs`: detection of the Node server and the page's source interface over its API.
- `highlight.js`: syntax highlighting using spans and text nodes.
- `index.html` and `styles.css`: interface markup and styling.

`server.mjs` at the repository root is the optional dependency-free Node server for browsers without directory mounting and for remote or WSL transcripts; it reuses `app/localfs.mjs` and must stay read-only. `docs/specification.md` is the source of truth for all features, behavior, transcript interpretation, and implementation details. Document these in prose, without code samples; file names and paths are welcome. Update the specification alongside every relevant change, including its file table when adding or renaming files. Root hosting files configure static serving and redirects. `tests/` holds the dependency-free checks; there is no dedicated asset directory.

`docs/design.md` sets out the proposed visual direction and staged design plan. Consult it for interface changes, while treating the specification as the source of truth for implemented behavior. Preserve the pure black, compact interface, readable transcript content, event and agent colors, and existing workflows.

## Build, Test, and Development Commands

- `npx serve -l tcp://127.0.0.1:8765`: run from the repository root, then open `http://127.0.0.1:8765/app/`. `serve.json` serves only viewer files; the page mounts the directory itself.
- `node server.mjs [--root <directory>] [--port 8765] [--host 127.0.0.1]`: server mode, which reads the directory for the page; open the printed URL. Use a spare port while `serve` is running.
- `node --check app/app.js`: check JavaScript syntax; repeat for each changed `.js` or `.mjs` file.
- `node tests/check.mjs`: synthetic parser and filesystem checks for both harnesses; reads no personal transcripts.

There is no build step. Use Chrome or Edge for directory mounting, or server mode for any browser. Avoid Python's `http.server` on Windows because incorrect JavaScript MIME types can break modules.

## Coding Style & Naming Conventions

Match existing two-space indentation, semicolons, and single-quoted JavaScript strings. Use camelCase for functions and variables, uppercase snake case for constants, and kebab-case for CSS classes and custom properties. No formatter or linter is configured.

Keep harness-specific rules in that harness's modules: transcript formats, text wrappers, and tool names in `claude.mjs` or `codex.mjs`, directory layouts in `claude-fs.mjs` or `codex-fs.mjs`. `app.js`, `transcripts.mjs`, `localfs.mjs`, and `server.mjs` should only go through the harness interfaces described at the top of `transcripts.mjs` and `localfs.mjs`; extend those interfaces rather than branching on a harness name. A new harness adds both modules and registers them in `transcripts.mjs` and `localfs.mjs`. Keep transcript modules pure and filesystem access in the directory modules. Preserve the flow from files to normalized records to model to DOM, with incremental playback updates. Reuse `--ev-*` color variables and the existing dark theme.

## Testing Guidelines

There is no test framework, test naming convention, or coverage threshold; `tests/check.mjs` holds dependency-free synthetic checks with a section per harness, so add cases to the harness you change. Verify affected behavior in a browser with a real session of each affected harness: loading, nested agents, playback, filtering, scrolling, and live updates as applicable. Parser and scanner checks can import `.mjs` modules in Node with mock handles. Browser automation can use `#file-input` or `window.__agentTimeline`.

For visual changes, also check the landing page and populated viewer at desktop and narrow widths, including selection, keyboard focus, reduced motion, zoom, and long content as relevant. Preserve legibility and existing interactions in dense sessions.

## Commit & Pull Request Guidelines

Follow [CONTRIBUTING.md](CONTRIBUTING.md) for commit, pull request, and AI co-author attribution guidelines.

## Agent Memory

Persistent agent memory lives in `.memory/` at the repository root and is shared by every agent harness; it is gitignored and stays local. `.memory/MEMORY.md` is the index, with one line per memory linking to its file. Each memory is a separate Markdown file holding one fact, with frontmatter giving a kebab-case `name`, a one-line `description`, and a `metadata.type` of `user`, `feedback`, `project`, or `reference`. Claude Code loads this directory automatically through `autoMemoryDirectory` in `.claude/settings.local.json`. Other harnesses, such as Codex, should read `.memory/MEMORY.md` at the start of a session, open the memories relevant to the task, and save new memories in the same format, adding the index line and updating an existing file rather than duplicating it. Do not record what the code, git history, or this file already captures.

## Security & Configuration

Keep the app dependency-free, with no backend or build step. Never upload transcripts or write to their directory. Bind local serving to loopback. Render transcript highlighting through text nodes, never untrusted HTML.
