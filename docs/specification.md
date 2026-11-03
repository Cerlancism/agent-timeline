# Agent Timeline specification

Agent Timeline is a browser-only viewer for Claude Code transcripts and Codex local rollout transcripts. It reconstructs a session and its subagents as an agent map, a chronological conversation, an event-details reader, and a branch-style timeline. A session can be explored manually, replayed, or followed while its transcript files continue to change. Multiple directories and both harnesses can share the session list and combined viewer.

This document specifies the implemented application, its data interpretation, and its operational limits. It is the source of truth for behavior and implementation. [Design direction](design.md) explains visual decisions and identifies future possibilities; those possibilities are not implemented features unless described here.

## Contents

1. [Product boundaries and architecture](#1-product-boundaries-and-architecture)
2. [Serving the application](#2-serving-the-application)
3. [Opening and finding sessions](#3-opening-and-finding-sessions)
4. [Workspace and visual system](#4-workspace-and-visual-system)
5. [Inspecting agents and events](#5-inspecting-agents-and-events)
6. [Timeline and playback](#6-timeline-and-playback)
7. [Following live sessions](#7-following-live-sessions)
8. [Filesystem discovery and loading](#8-filesystem-discovery-and-loading)
9. [Transcript normalization and classification](#9-transcript-normalization-and-classification)
10. [Session model and relationships](#10-session-model-and-relationships)
11. [Rendering, highlighting, and state](#11-rendering-highlighting-and-state)
12. [Limitations and interpretation caveats](#12-limitations-and-interpretation-caveats)
13. [Source files and verification](#13-source-files-and-verification)

## 1. Product boundaries and architecture

### Purpose

The viewer connects four views of the same session. The map explains agent ownership and communication. The conversation presents events across agents in chronological order. Details expose the selected event's content, inputs, outputs, and metadata. The timeline shows activity and transfers in a compact graph. Playback position coordinates these views, while agent focus and event filters control which conversation events are visible and eligible for stepping.

The viewer reads the transcripts each harness already writes to disk. It does not execute recorded tools, run agents, edit transcripts, or contact a harness or its model provider to reconstruct a conversation. Nothing needs to be installed into a harness either: no hooks, MCP servers, plugins, or configuration changes, so sessions recorded before the viewer was set up, or on another machine, can be explored the same way, and live following works by re-reading the transcript files as they grow.

### Runtime and trust boundary

The application consists of plain HTML, CSS, and JavaScript ES modules, with no build step or third-party runtime libraries. Processing and rendering happen in the browser. Transcripts are never uploaded to any third party, and the application never writes to the transcript directory.

Sessions reach the page from one of two sources. In directory mode the browser mounts the transcripts directory through the File System Access API with read permission only; Chrome and Edge support that complete workflow, and a Chromium-based embedded browser may support it subject to its host environment. In server mode the optional, dependency-free Node script `server.mjs` serves the page and reads the directory on the page's behalf through a small read-only JSON API, so any browser, including one on another machine or outside a WSL distribution that holds the transcripts, can list, open, and follow sessions (see Server mode). Either way, individual file selection and drag and drop remain available as a snapshot path.

Only the browser's remembered directory handles are persisted by the application, in IndexedDB. Parsed sessions, summary caches, playback state, and filters are held in memory; the URL can identify mounted or served sessions to reopen.

### Module responsibilities

The data flow is files, normalized records, session model, then rendered views. Claude Code support came first and Codex support was added alongside it; each harness now lives in its own pair of modules behind shared interfaces, so the layers above them carry no harness-specific rules.

| Layer | Harness-neutral | Claude Code | Codex |
| --- | --- | --- | --- |
| Transcripts (pure) | `app/transcripts.mjs` | `app/claude.mjs` | `app/codex.mjs` |
| Directories (read-only handles) | `app/localfs.mjs`, `app/handles.mjs` | `app/claude-fs.mjs` | `app/codex-fs.mjs` |

A harness transcript module normalizes its own JSON lines into the shared record model and owns everything that depends on how its harness writes transcripts: recognizing its format, classifying user text, the subagent references a transcript makes, which tool calls spawn, message, stop, or hand back to agents, short titles for its ordinary tools, what a tool result says about the agent it addressed, whether unpaired results stay visible, and any caveat added to the token total. `app/transcripts.mjs` registers the harnesses in detection order, with Claude as the fallback; reads JSON lines and hands them to the first harness that claims the transcript; and builds session summaries and search matches through the owning harness.

A harness directory module owns its on-disk layout: whether a picked directory matches it, discovering sessions and their subagents, loading a session with its agents, detecting agents that appear while following live, recognizing chosen files as a snapshot, and its default directory hint for the Add directory dialog. `app/localfs.mjs` keeps what does not depend on the harness: remembered directory handles and permissions, trying each harness's layout in order, combining several directories, the summary cache and paged session list, and checking known files for live changes before asking the owning harness about new agents. `app/handles.mjs` holds the small directory and file helpers both layers share. The scanner and loader also run inside the Node server over equivalent filesystem handles.

Every loaded session and listing summary carries its harness label, and the model builder in `app/app.js` asks that harness how to read the session. Supporting another harness means adding a transcript module and a directory module that implement these interfaces and registering them in `app/transcripts.mjs` and `app/localfs.mjs`; the model builder, rendering, and server need no harness-specific code.

`app/remote.mjs` detects the server and wraps its API in the same source interface the page uses for a mounted directory; `server.mjs` at the repository root implements that server. `app/app.js` constructs the agent/event model, manages application state, and coordinates rendering, playback, and live updates. `app/highlight.js` converts text into safe highlighting spans and text nodes.

Transcript text is treated as data. Highlighting does not insert transcript-derived HTML, and recorded identifiers are resolved against discovered files or loaded agents rather than accepted as arbitrary filesystem paths.

## 2. Serving the application

### Local serving

Serve the application over HTTP; opening its HTML through a file URL is insufficient because the scripts are ES modules. The repository's local serving setup uses the `serve` package through `npx`, with the `-l` listener option set to `tcp://127.0.0.1:8765`. Run it from the repository root and open `http://127.0.0.1:8765/app/`.

The root `serve.json` exposes only `app/`, disables directory listings and clean URLs, redirects the root to `/app/`, and rewrites `/app/` requests to the corresponding viewer files. Keep local serving bound to the loopback address, 127.0.0.1. The transcript directory is accessed separately through browser permission and is not served by this configuration.

Other static servers can serve either the repository with `/app/` as the entry point or the `app/` directory directly. Assets use relative paths. JavaScript files must have JavaScript MIME types; Python's `http.server` can serve `.js` as plain text on Windows, causing module loading to fail.

### Server mode

`node server.mjs` from the repository root starts a Node server (Node 18 or later, no packages) that serves the viewer at `/app/` and reads a transcripts directory for it. Options are `--root` for the directory, defaulting to `~/.claude/projects` of the user running the server (falling back to `~/.claude`), `--port`, defaulting to 8765, and `--host`, defaulting to the loopback address. The server prints the session count, the directory, and the URL to open. Requests to the root redirect to `/app/`, static files are served only from `app/` with the correct JavaScript MIME types, and paths outside it are refused.

The API lives under `api/` relative to the page: a source description with the directory and session count; a session page with offset, limit, and filter, which can also request a rescan; a loaded session as the same trimmed structure the directory loader produces, with file names, sizes, and modification times in place of handles; a file status with the main transcript's size and modification time; and a change check that compares the directory against the copy the server last sent for that session, answering changed after a server restart. Session identifiers are validated before any lookup, and every response is marked as not cacheable. Only GET requests are answered.

On start the page probes that source endpoint. A JSON answer in server mode makes the server the page's source: the landing label reads Source: server followed by the directory path and session count, the mounting controls and picker hint are hidden because the directory was chosen on the command line, and the list loads at once. Any other answer, including the plain 404 that the `serve` package or GitHub Pages return, leaves the page in directory mode. In server mode listing, loading, the five-second row refresh, the one-second live checks, Refresh and returning to Sessions all go through the API; combined views, history URLs, and live following behave as in directory mode.

Serve the transcripts of a WSL distribution by running the server inside that distribution and opening the printed localhost URL from the Windows browser; WSL forwards loopback ports. The server exposes every transcript under its root without authentication, so keep the default loopback host unless the network is trusted; binding another address prints a warning.

### Static hosting

The same files can be hosted without a build or backend. Public hosting must use HTTPS for directory access, and `.mjs` files must be served as JavaScript. GitHub Pages satisfies those requirements. With Pages deploying the repository root from `main`, the application is available at the repository's `/agent-timeline/app/` path under the owner's GitHub Pages domain.

The root `.nojekyll` marker prevents Jekyll processing. The root `index.html` forwards visitors to `app/`; its JavaScript redirect preserves the query string and fragment, while its meta-refresh fallback simply opens `app/`. `serve.json` configures the local `serve` package and has no effect on GitHub Pages.

### Session URLs and browser navigation

The `session` query parameter selects a session from the mounted directory. Several identifiers separated by commas open those sessions together in one combined view (see Opening several sessions together); the commas are kept literal in the address bar, and repeated identifiers are ignored. Use the `/app/` entry point for these links: the local server's root redirect drops the query string. If a remembered directory needs permission, reconnecting allows the requested sessions to open afterward.

Opening mounted sessions updates browser history with their identifiers. Returning to Sessions removes the parameter. Browser history navigation restores the corresponding mounted session or combination, or the landing page; a history entry naming the same set of sessions already shown does not reload them. Opening individual files removes the mounted-session parameter because those files cannot be restored from that URL.

The browser embedded in VS Code can rewrite session query links on forwarded ports. In that environment, choosing the session from the landing page is the fallback.

## 3. Opening and finding sessions

### Adding and removing directories

Claude sources are `~/.claude/projects`, `~/.claude`, or a single project directory. Codex sources are `~/.codex`, a custom Codex home, its `sessions` or `archived_sessions` directory, or a dated subtree. Selecting the Codex home includes active and archived rollouts. Discovery determines the selected layout. When served by `server.mjs`, the source is the single server root chosen with its root option and browser directory controls do not appear.

The landing page provides Add directory and Open files. Add directory opens a modal dialog before invoking any system picker. It explains how to select hidden directories and offers separate Copy buttons for Claude and Codex paths. Choose directory opens the system picker in read mode; Cancel, Close, or Escape dismisses the dialog. Canceling the system picker leaves the dialog available for another attempt. The dialog scrolls within short viewports and wraps paths and controls at narrow widths.

The page cannot initialize the picker with an arbitrary path. The dialog offers `%USERPROFILE%\.claude\projects` and `%USERPROFILE%\.codex` on Windows, or `~/.claude/projects` and `~/.codex` elsewhere. Copy places one path on the clipboard. Custom Codex home paths must be supplied by the reader; a static page cannot read shell environment variables. A stable picker identifier lets the browser remember its last chosen location.

Each added directory is remembered and appears in a source row with its harness, directory name, discovered session count, and Remove directory action. Adding another directory combines its sessions with the existing list. Adding the same directory again does not duplicate its handle, and overlapping sources list the same session identifier once, using the first connected source. Removing one source removes only its saved handle and its sessions from the list, clears selections that no remaining source provides, and preserves the other sources. Removing the last source empties the list. No transcript files are deleted. Discovery and child lookup remain scoped to each selected directory; selecting the common Codex home is necessary to resolve relatives across active and archived storage.

A remembered handle does not guarantee that permission remains granted. After a reload, each unavailable directory has its own Reconnect action, which requests read permission again. Other connected directories remain usable. A browser option to allow access on every visit can avoid subsequent reconnection prompts. Permission denial, unreadable directories, and load failures are reported near the source actions; canceling a picker is not treated as a load error.

The browser can access only directories reachable from its machine, including accessible network shares. A remote SSH or VS Code host is not automatically available to a local browser; use accessible copies or select exported transcript files.

### Opening a snapshot from files

Open files and page-level drag and drop accept transcript and metadata files. Select the main session's JSONL together with the desired subagents' `agent-*.jsonl` and `agent-*.meta.json` files. The application reads this selection as a snapshot and hides Live.

A lone subagent transcript can be opened as the main agent. If the selection has subagent transcripts but no session-named transcript, the first collected subagent is promoted to the main position and the remaining selected subagents are loaded alongside it. Metadata without a corresponding transcript does not create an agent. A selection with no recognized transcript produces an error.

The file-selection loader represents one session, not a session collection. For Claude files, if several session-named main transcripts are selected, the last recognized main file is used; filenames determine their roles. For Codex, session metadata determines identity even when files are renamed. Select one root rollout and its descendants, or a single child as a standalone session. Unrelated Codex roots, mixed Claude/Codex selections, and disconnected child families produce an error rather than silently discarding files. Unrelated JSON files are not automatically interpreted as transcripts. Dragging files over the page displays a drop indicator without changing the underlying session until the files are dropped and loaded.

### Opening several sessions together

Several mounted sessions can be viewed at once in one workspace, with their events interleaved by time. Each session row begins with a checkbox whose hit area is the row's whole leading strip, from the left edge to the title and across the full row height; ticking it adds the session to a selection that survives filtering, paging, and Refresh until the page is reloaded. Ctrl-click or Cmd-click on a row, and Space on a focused row, toggle the same selection. A plain click or Enter still opens that one session.

A selection bar sits between the search bar and the list at all times, so ticking the first session does not move the rows. While nothing is selected it is a plain row holding only the muted hint "Tick sessions to open several together". While at least one session is selected it becomes a raised strip that stays visible at the top of the page as the list scrolls. It states how many sessions are selected and names each one as a chip carrying its short identifier, with the title in a tooltip; clicking a chip removes that session. Open together loads the selected sessions in selection order and shows them combined; with a single selection the button reads Open and opens that session alone. Clear empties the selection. Selected rows have a blue leading rule and a faint blue surface, and while the combination loads every selected row stays highlighted.

The combined view is described under Combined sessions, and the parts of the workspace that change when more than one session is shown are noted in their own sections. The file-selection loader is unaffected: Open files and drag and drop still represent one session.

### Session index

The mounted-directory landing page is a compact ledger of sessions across discovered projects. It sorts sessions by the main transcript's modification time, newest first, and loads 20 matching, nonempty sessions at a time. Load more appends the next page. End states distinguish No more sessions, No sessions found, and No sessions match.

Each row contains the following information:

| Field | Meaning |
| --- | --- |
| Title | Latest recorded custom title, otherwise the first prompt, otherwise the session identifier |
| Harness | A small chip after the title naming the transcript source, Claude or Codex |
| Prompt preview | First prompt shown below the title when a custom title exists |
| Working directory | Recorded working directory, falling back to the project directory name |
| Prompt count | Main-transcript text blocks classified as operator prompts or commands |
| Subagent count | The largest of spawn-call count, distinct referenced-agent count, and transcript count in the session's own subagent directory |
| Context | Latest recorded input context; Claude input plus cache-creation and cache-read tokens, or Codex per-response input tokens with cached input already included; compact, with the exact value in a tooltip |
| Model and effort | Model and reasoning effort of the main session's latest reply, muted |
| Last activity | Relative age of the main transcript's modification time |
| File size | Size of the main transcript, rather than the combined session and subagent files |
| Short identifier | Abbreviated session id for quick recognition |

Counts in the metadata line use bold figures with muted units, matching the viewer's top bar; fields without a value are left out. Every listed figure comes from the main transcript, which the listing already reads; output tokens are left to the viewer because counting them would mean reading every subagent transcript. Sessions with neither prompts nor subagents are omitted. The source label names the mounted directory and reports the number of discovered session files, which can exceed the number of rows eligible for display.

A session whose main transcript was modified within the last ten minutes has a green live badge and a narrow green rule. While the landing page is open, displayed files are checked every five seconds to update relative age, size, and badge state. This lightweight refresh does not re-sort the list or rebuild titles and counts; Refresh or returning to Sessions rebuilds the listing.

### Search, loading, and presentation

The filter matches title, first prompt, session id, working directory, project name, and harness label using a case-insensitive substring search. Input is trimmed, and searching begins 250 milliseconds after typing stops. Search can reach all discovered sessions rather than only rows already displayed; loading additional pages continues through further matching results.

Refresh rescans the source and restarts the list. Returning from the viewer through Sessions also refreshes discovery and the listing. Session rows open by click or Enter. A request token prevents an older asynchronous list response from replacing newer results.

The Local session explorer heading, source actions, search bar, and Sessions / Latest activity labels share the ledger's alignment. Rows use pure black, restrained dividers, and hover/focus feedback. The working path has its own metadata line, followed by counts. Long titles and paths truncate, with full values available through native tooltips.

While a mounted session loads, surrounding rows and controls fade and stop accepting pointer input. The chosen row remains readable with a thin sweeping indicator at its top edge. Reduced motion uses a static line. An opening guard prevents overlapping mounted-session open requests.

## 4. Workspace and visual system

### Frame and information hierarchy

The viewer fills the dynamic viewport. Its top bar contains Sessions, a harness chip (the distinct harness labels of the shown sessions, Claude and/or Codex), the session identifier (for a combined view, the number of sessions followed by their short identifiers, with full identifiers and titles in a tooltip), agent count, event count, elapsed time between the first and last events, total output tokens, and total context: every agent's context at the last event, finished agents included, which is the right edge of the context chart. These totals describe the loaded model; the map's counters instead describe progress up to the playback position.

The central workspace contains the agent map, conversation, and details, with independent scrolling. A full-width timeline sits below them, followed by playback controls. The landing page scrolls with the document; the viewer keeps document scrolling disabled and delegates scrolling to its panels.

Pure black is the dominant background for the page, conversation, details, and timeline. Near-black fills distinguish headings and map nodes. One-pixel rules separate regions. Controls and map nodes have three-pixel corners, while conversation entries and session rows have square edges.

The browser favicon is a small branch graph on a black tile: a blue main lane, a green child branch, and a light current-event dot. The SVG uses a 32-unit view box to scale to browser-tab sizes without raster assets. Both the application and root entry page reference the same local icon through relative paths.

System sans is used for titles and prose; monospace is used for panel labels, identifiers, timestamps, counters, and code. Panel labels are small and uppercase. Normal body text is 13 px, and code and conversation previews are 11.5 px. Metadata and syntax comments use readable muted contrast. Numerical statistics and timestamps use tabular figures.

Hover changes a surface without moving content. The current event uses a blue outline and dark blue fill; keyboard focus uses a stronger two-pixel outline. Agent focus uses that agent's color. Mount/reconnect and play have light neutral fills. Event colors remain mapped through the existing `--ev-*` variables, and each agent keeps the same assigned color across all views. Selection of text uses a blue highlight.

### Responsive panels

| Available viewport | Workspace behavior |
| --- | --- |
| Wider than 1100 px | Map, conversation, and details are shown together |
| 761–1100 px | Map remains visible; Details below the feed replaces the conversation with details |
| 760 px or narrower | Map is hidden; conversation and details share the available panel area |

Opening the narrow details view moves keyboard focus to its Conversation return button. That button or Escape restores the conversation and focuses Details. Loading a session or returning to the list resets this panel choice. Jumping to another agent from details also returns to the conversation at narrow widths.

When the map is hidden and an agent is focused, All agents appears below the conversation. It clears the agent filter and restores keyboard focus to the feed. This provides a visible alternative to Escape.

Headers, filters, feed controls, and playback controls wrap when space is limited. Long session ids and jump-button labels truncate. Long detail-section headings wrap. The timeline's normal requested height is calculated from 18 px agent rows, 15 px of framing allowance, and a further 12 px when horizontal scrolling is expected, bounded to 90–260 px. At widths of 760 px or less, its height is additionally capped at 20 percent of dynamic viewport height, constrained to 90–140 px. Windows no taller than 540 px cap it at 80 px. Timeline scrolling retains access to rows that do not fit. Each timeline scrollbar is enabled only while its axis genuinely overflows, so sub-pixel rounding at fractional display scaling cannot make scrollbars flicker on and off.

### Accessibility and motion

Search, playback, stepping, and the event-position slider have explicit accessible names. Native inputs, selects, buttons, and disclosure summaries retain their normal keyboard behavior. Focusable controls and entries have visible focus indicators.

Agent boxes act as buttons and expose whether their conversation is focused. Their accessible names include full agent labels and playback states. The current conversation entry is the only card in the Tab sequence; the feed itself is also focusable. Enter or Space selects that entry without starting playback.

Reduced-motion preferences disable CSS transitions and blinking/pulsing effects. Loading indicators become static, the current-agent dot receives a static emphasis, and directional map-dot animation is suppressed. Status text and dot shape supplement color.

## 5. Inspecting agents and events

### Agent map

The map is a tree with the main session at the top. Each child is indented under its parent, and siblings are ordered by their first event time. In a combined view each session's tree follows the previous one, under a small ruled heading of 22 px giving the session's ordinal, harness label, and short identifier, with its title and full identifier in a tooltip; the root node of each tree is labeled with the session title. Nodes show the agent description, type and model, plus a compact counts line: events and output tokens through the current position, and the context of the agent's latest call at that position, which a finished agent keeps (see Context usage). Output and context use compact thousands or millions; the line's tooltip gives exact values. Counts include events through the current position, regardless of whether those events are hidden by conversation filters.

Nodes are 60 px tall with 12 px vertical gaps and 22 px indentation per depth. Width is calculated from the panel, tree depth, and space needed for peer links, with a 180–300 px range. Long labels truncate; a native tooltip shows the full label, agent type, model, reasoning effort, and identifier. Effort lists each distinct level the agent's replies recorded, in order of first appearance, and is omitted when no reply records one. The map can scroll when its contents exceed the panel.

| State | Visible indication | Condition |
| --- | --- | --- |
| Not started | wait, hollow grey dot, muted agent stripe and name | Playback has not reached the agent's start or a known spawn |
| Running | run and amber dot | A spawn or first event has been reached, and the agent is not yet finished |
| Current event | now and blinking green dot | The agent owns the event at the current position; this state takes precedence |
| Finished | done and dark square dot | Playback is beyond the last event, or a recorded stop targeting the agent has been reached |

Click, Enter, or Space toggles focus on an agent's conversation. Clicking the focused agent again, Show all agents, All agents on narrow screens, or Escape clears that focus. Focused nodes have an agent-colored border and inset emphasis. Focus does not alter event data or timeline geometry.

Solid connectors join parents and children. Non-parent communication uses dashed curves to the right. Each connector has a running count of linked events through the current position. The current event's connector is highlighted. During animated playback, a dot travels from sender to receiver using the event color for spawn, message, stop, handback, or notification traffic. The map scrolls to reveal the current agent only when its box is outside the visible area.

### Context usage

A Context button in the agent map heading opens a modal popup charting how much context each agent holds across the session. At 760 px and below, where the map is hidden, the same button appears below the conversation. Escape, the close button, or a click on the backdrop closes the popup without affecting agent focus or the narrow details view.

An agent's context at a given event is the prompt size of its latest API call: fresh input tokens plus cache-creation and cache-read input tokens, taken from the first record of each message id. The value holds from that call onwards and contributes zero before it. An agent counts as finished once it and all of its subagents have passed their last events, so a parent waiting on children is still running; a finished agent keeps its final size as a flat band, so the stack shows the session's accumulated context. A compaction lowers an agent's band at its next call, because that call's prompt is smaller. The chart is a stacked area with one band per agent in agent-map order and agent colors, the main session at the bottom. The horizontal axis is event position, matching the timeline and scrubber, and values change in steps at events. Recessive gridlines carry token labels in thousands or millions.

A solid vertical line marks the playback position and follows seeking, playback, and live updates while the popup is open. Hovering shows a dashed crosshair and a tooltip with the event number, time, and owning agent. The tooltip lists each running agent with context there, top band first, with exact token counts; finished agents fold into one muted line giving their count and combined size, or the agent itself when only one has finished; a total follows. Each compaction recorded in a transcript appears as a dotted rule with a small marker in the compacting agent's color along the top of the plot, and hovering it adds the trigger and pre-compaction size to the tooltip in the warning color. Clicking the chart seeks to that event and selects it. Below the chart, a table lists each agent that ever held context with its value at the playback position and its peak, followed by the total at the cursor and the peak total. Agents that are finished or hold no context at the cursor are muted. A session without recorded usage shows a short message in place of the chart.

### Conversation log

All agents' events are merged into one chronological feed. Cards are built when the session loads, but only those through the furthest reached event are revealed. Moving backward keeps previously revealed later cards in place and dims them. Events beyond that furthest position remain hidden.

Each entry retains a narrow stripe in its owning agent's color. Its first line shows the agent, or sender and receiver for linked traffic, plus a local-time timestamp including milliseconds; in a combined view it begins with the owning session's short identifier in muted monospace, with the session title in a tooltip. Its next line shows event type and title. Tool titles include the tool name. A preview follows, limited to the first 1,200 characters and approximately seven rendered lines.

Tool previews use the result or a missing-result placeholder. Spawn previews use the task prompt. Thinking has a placeholder when its text was not recorded. Notifications prefer their result or summary and fall back to raw text. Error previews and titles use error color, and thinking previews are italicized.

| Event type | User-facing meaning |
| --- | --- |
| operator | Main-session prompt or a subagent's initial task prompt |
| command | Slash command or shell-mode input |
| reply | Assistant text |
| thinking | Recorded assistant thinking |
| tool | An ordinary tool call with its matched result when available |
| spawn | Starting a subagent, through Agent or the older Task tool in Claude Code or spawn_agent in Codex |
| message | A message to another agent, such as SendMessage in Claude Code or send_message in Codex |
| stop | Stopping another agent, such as TaskStop in Claude Code or close_agent in Codex |
| handback | A subagent's final report through SubagentHandback; the tool roles of each harness are listed under Events and tool results |
| notification | Task status notification |
| received | Delivered copy of inter-agent communication |
| system | Reminders, skill text, editor context, command output, injected text, compactions, or API errors |

The feed provides four filters:

| Filter | Initial state | Effect |
| --- | --- | --- |
| Thinking | Off | Includes or hides thinking events |
| Tools | On | Includes or hides ordinary tool events; specialized spawn/message/stop events keep their own types |
| Deliveries | On | Includes or hides delivered message copies in the combined feed |
| System | On | Includes or hides system events |

Agent focus restricts the feed to events owned by that agent. Delivery copies remain visible while focused even if Deliveries is off. Filters affect conversation visibility and playback eligibility, not the underlying model, overall totals, map, or timeline.

### Selection and following

Clicking an entry, or activating the current entry by keyboard, seeks to that event, updates details, and turns follow off. Selection has a blue boundary and preserves the selected card's screen position; the trailing space that makes this possible is measured from the last card actually shown, so agent focus or filters never leave a large empty gap below the conversation. Entries use two-pixel gaps and bottom dividers rather than heavy enclosing cards.

While the conversation pane or one of its entries has keyboard focus, for example after clicking an entry, the Up and Down arrow keys move to the previous or next visible event and bring it into view instead of scrolling the pane. Keyboard focus moves with the current entry.

Follow keeps the current card visible during playback and has no visible control; it is driven by the reader's own scrolling. Scrolling the conversation upward with the mouse wheel, by dragging its scrollbar, by touch, or with Page Up turns follow off so the reader can scroll independently. Scrolling to the feed's very bottom turns it back on. Scrolls made by the viewer itself never turn follow off. Manual playback navigation explicitly reveals the current card even when follow is off.

A spacer after the revealed cards prevents a seek from unexpectedly collapsing the scroll range. Its minimum is six pixels, complementing the two-pixel gap and eight-pixel scroll padding, and it grows when needed to retain the previous scroll position.

### Event details

Details reflect the current selection as manual navigation or playback changes it. The summary contains the owning session (harness label, short identifier, and title, in a combined view only), the owning agent, event type, tool name when applicable, UTC timestamp, call-to-result duration when known (omitted when the result's recorded time precedes the call's, which mixed time sources can produce), and output tokens/model when attributed to that event. Linked traffic adds sender, receiver, and any notification status. Error results are marked in the summary and result section.

Content is arranged in independently collapsible sections with ruled boundaries and a near-black heading strip when open. The default is open, except where a specialized presentation already exposes the important input or where raw notification text is supplementary.

| Event or tool | Detail presentation |
| --- | --- |
| Operator, reply, message, handback, received | Text content with Markdown highlighting |
| Thinking and other text | Content section using the applicable plain or inferred treatment |
| Bash | Command highlighted as shell, collapsed JSON input, then result |
| Edit and MultiEdit | Complete old text in red followed by complete new text in green, labeled per edit when there are several; this is not a line-by-line diff |
| Write | File content highlighted according to its extension, with JSON input collapsed |
| Read | JSON input and file-extension-highlighted result; recognizable numbered listings use separate number and code columns |
| Spawn | Prompt and a separate options section excluding the prompt; complete JSON input remains available collapsed |
| Notification | Result or summary when present, plus raw notification text; raw text starts collapsed when a separate result is present |
| Other tools | JSON input and result, with language inference where applicable |

Input is omitted for SubagentHandback. Inputs for Bash, Edit, MultiEdit, Write, spawns, and messages start collapsed; other tool inputs start open. Results are labeled as errors when the matched tool result reports failure. Details do not shorten the full text to the feed's preview limit.

When the other endpoint of a linked event is known, a Jump to agent button focuses that agent's conversation. It changes the conversation filter rather than creating a new session or changing ownership of the selected event. On narrow screens it also closes the details view.

## 6. Timeline and playback

### Branch graph

The timeline is a canvas visualization with one 18 px row per agent, ordered identically to the map. It resembles a branch graph: agent activity occupies lanes, and communication creates forks, joins, and cross-lane curves.

The horizontal axis is global event order, not wall-clock time. Long idle periods therefore do not compress active work. The graph fills available width until consecutive event positions would be closer than seven pixels; beyond that point the scrollable track widens to maintain minimum spacing.

The left label column remains fixed at 120 px while the graph scrolls. Labels are indented by depth, measured with the canvas font, and shortened with an ellipsis to fit the remaining space. Other labels become muted when an agent is focused. In a combined view a one-pixel rule across the full graph width separates each session's rows from the next, and the root rows' labels are brighter than subagent labels.

Each agent lane spans its first to last event in the agent color. The portion through the cursor is bright, and the future portion is dim. Event dots use event-type colors with background-colored outlines to separate neighboring marks. Future dots are dimmed. A faint token area accumulates output tokens across the agent's full run.

Spawn, message, stop, handback, and notification events with known endpoints generate inter-agent links. A curve starts at the sending event and joins the receiver's first later event; this is a next-event heuristic, not an exact delivery correlation. If there is no later receiver event, a vertical connection is drawn at the sender's position. Spawn and handback curves use the child's color; other traffic uses the event color. The current event's link is white. Delivered copies are omitted from timeline links because the sending side already represents the transfer.

A white vertical cursor marks position, with a ring around the current dot. Focus highlights the agent's row. The panel scrolls vertically to reveal the current agent when needed.

### Timeline navigation

Clicking the graph seeks to the corresponding global event index. Holding the left pointer button and dragging scrubs across events. The fixed label area does not initiate a seek. Right-button dragging pans horizontally, and the graph suppresses its context menu.

When playback advances across a graph wider than the viewport, horizontal scrolling keeps the cursor visible. Once it passes the viewport's midpoint, it is held near that point while the graph moves beneath it. Manual clicking or scrubbing shifts the viewport only if the chosen event would otherwise be hidden. Automatic horizontal following is suspended during panning.

The canvas is sticky at the panel's left edge and is only as wide as the visible panel. An underlying track supplies the full scrollable graph width. Canvas dimensions account for device-pixel ratio. A ResizeObserver and panel scroll events trigger redraws; playback seeks also redraw the timeline.

### Playback actions and timing

| Action | Controls and behavior |
| --- | --- |
| Play or pause | Primary playback button or Space; playing from the end restarts at the first visible event |
| Previous or next | Step buttons, Left/Right arrow keys, or Up/Down arrow keys while the conversation has focus; skips events hidden by filters or agent focus |
| First or last visible event | Home or End |
| Arbitrary position | Event-position slider or timeline seek; indexes the full model rather than the filtered sequence |
| Return or clear focus | Escape first exits narrow details, otherwise clears agent focus |
| Speed | 0.5x, 1x, 2x, 4x, 8x, 16x, or 32x; initial value is 2x |
| Even steps | Initial pacing mode; waits 700 milliseconds divided by speed between visible events |
| Real time, capped | Uses the timestamp gap between the current and next visible events divided by speed, constrained to 40–2,500 milliseconds |

The position readout shows the one-based global event position and total model size. Internally, a position before the first event is represented separately. Playback stops when there is no later visible event. Changing speed or pacing while playing reschedules the next step; manual seeking while playing continues from the new position.

Global shortcuts are inactive on the landing page and while an input, textarea, select, or editable region owns keyboard focus. Space on a button, disclosure summary, or button-role entry activates that control instead of toggling playback. Agent-box and event-card activation explicitly consume Enter and Space.

## 7. Following live sessions

### Activation and feedback

Live is available only for sessions opened from a mounted directory or from the server, including a combined view of several. Its button sits in the playback controls, to the right of the scrubber and position readout and to the left of Speed. Opening a session, or a combination, whose newest loaded transcript or metadata file changed within the last ten minutes automatically enables it. This differs from the landing live badge, which reflects only the main transcript's modification time.

Enabling Live manually or automatically seeks to the model's latest event. The active button is green and pulsing, with a pressed accessibility state. An inability to check or reload the session changes it to amber and Live (reconnecting). Successful subsequent checks restore the active appearance. Reduced motion removes pulsing.

While Live is on, moving to an earlier event by hand (scrubber, timeline, entries, or stepping) leaves the live edge: playback of incoming events pauses, the button turns white and stops pulsing, and new events arrive without moving the playback position or selection, including when the new events are hidden by filters. Clicking it in that state returns to the latest visible event, turns the conversation's follow back on, and restores the green pulsing button. Scrolling the conversation by hand to its very bottom does the same in two steps so that peeking at the end never snaps back by accident: reaching the bottom shows a "Scroll down again for latest" hint, and a second, separate downward scroll or Page Down at the bottom returns to the latest event. A continuous wheel or touchpad flick counts as one gesture, and scrolling away from the bottom hides the hint. Reaching the latest visible event by any means, including playback, also restores it. Otherwise clicking Live stops or restarts following. While following at the live edge, new events hidden by agent focus or filters do not move the position; when focus is cleared or a filter reveals newer events, the position moves to the latest visible event and the current card is brought into view. Loading another mounted session, opening individual files, or returning to Sessions stops the previous live loop. Live is independent of the conversation's follow-scroll control.

### Change detection

Every second, the application checks known loaded files for a size or last-modified change; in server mode the server performs the same check against the files it last loaded for that session. The tracked set includes the main transcript, loaded subagent transcripts, and their loaded metadata files. It then asks the session's harness about agents that appeared since loading: Claude looks for newly created subagent transcripts in the current session's own subagent directory, including a directory that appeared after the session was opened, and Codex rescans rollout metadata under the selected source for new descendants.

A detected change reloads the session and reconstructs its model. In a combined view every shown session is checked each second, only the sessions that changed are reloaded, and the combined model is rebuilt from the reloaded and unchanged parts together. This is full-file loading and parsing, not incremental byte-tail parsing. Existing indexed references are followed again so newly referenced agents can be included, and the session's own subagent directory is recollected. The live loop does not perform a complete rescan of every project each second.

### State retained across reloads

Reloading retains conversation filters, agent focus if that agent still exists, follow state, feed scroll position, and playback location. The previous furthest-reached event is restored so previously revealed conversation entries remain available. Details and the map are rebuilt from the refreshed model.

Position and reach are matched using an event key composed of agent identity, source record UUID, content-block index when present, and event type. If the key cannot be recovered, the prior index is bounded to the new model size.

If new events increase the event count and playback was running or had reached the end of the visible sequence, playback continues into the new events and stops at the new end. If the reader had moved backward, their position remains unchanged and later events stay available for subsequent playback rather than forcing a jump.

At most one session reload runs at a time. A tick arriving during a reload sets a pending flag; completion schedules one further reload if Live remains enabled. Read or reload failures preserve the existing view and show reconnecting feedback.

## 8. Filesystem discovery and loading

### Harness detection

A picked directory is offered to each harness's layout in registration order: Codex first, then Claude. Codex accepts a directory that looks like a Codex home, a session store, or a dated subtree; Claude accepts any remaining directory, so it is the fallback. The scan records its harness, and every discovered session carries that label. Files chosen for a snapshot follow the same order: Codex claims them when any is a rollout, otherwise Claude reads them by filename. The scanners, listing, loaders, and change checks run unchanged in the Node server, which supplies directory and file handles backed by the Node filesystem API with the same shape as the browser's handles.

### Claude directory conventions

Claude Code's observed transcript layout, as of October 2026, uses a project directory under `~/.claude/projects`, commonly derived from the working path with separators encoded as hyphens. The transcript format is undocumented and may change.

| Location | Contents |
| --- | --- |
| `<project>/<session-id>.jsonl` | Main transcript, one JSON record per line |
| `<project>/<session-id>/subagents/agent-<agent-id>.jsonl` | Subagent transcript |
| `<project>/<session-id>/subagents/agent-<agent-id>.meta.json` | Agent type, description, spawning tool-use id, and optional model or parent metadata |

The Claude scanner in `app/claude-fs.mjs` recognizes UUID-shaped main transcript names and lowercase alphanumeric agent filenames. It detects a containing `projects` directory first; otherwise a selected directory containing main transcripts is treated as a single project. Remaining directory selections are treated as collections of projects.

Discovery builds a session list, a global agent-id-to-file index, a map of session subagent directories, and the number of subagent transcripts in each, which the session list uses without reading them. Unreadable entries are skipped where scanning permits. Global agent lookup is important for resumed sessions, whose agents may still live under an earlier session directory.

### Claude recursive agent loading

A mounted session must first match a discovered session entry. Its main transcript is loaded and trimmed. The loader refreshes that session's own subagent directory and queues agent ids from the main transcript together with every transcript found in that directory.

Reference discovery includes Agent and older Task results, SendMessage targets, TaskStop targets, and sender ids embedded in delivered messages. A TaskStop target is dropped when its result identifies a non-agent task, such as a background shell, so stopped shells never count as subagents in the session list or queue a lookup. Spawn results can identify the child through `toolUseResult.agentId` or recognizable result text. Targets are treated as references only when they meet the relevant identifier checks.

Each queued agent is resolved through the scan's file index. Its transcript and optional metadata are loaded, its references are added to the queue, and a visited set prevents repeated loading. This discovers nested subagents across indexed projects and sessions. A missing agent transcript is skipped; metadata alone is insufficient. Invalid metadata content is ignored where possible.

Lookup does not turn arbitrary ids from transcript text into paths. Directory access for the current session uses an identifier already obtained from the discovered session entry. Loaded-file handles, sizes, and modification times are retained for live checks. Beyond changes to those files, a live check looks for a new agent transcript in the session's own subagent directory.

For a file snapshot, filenames determine roles: a UUID-named file is the main transcript, and agent-named transcripts and metadata files are its subagents. Without a main transcript, the first subagent is shown as the main agent.

### Codex discovery and live changes

Codex discovery in `app/codex-fs.mjs` inspects JSONL headers for session metadata, traversing the selected store and numeric year/month/day directories. It does not read authentication, settings, databases, or other home files. The first 30 lines within the first 256 KiB are inspected; metadata outside that header is not discovered. Header results are cached by root-relative filename, size, and modification time. The Node file adapter supports bounded reads for this purpose.

Thread identity is session_meta.id, even when session_id names a shared root. Parentage comes only from parent_thread_id or source.subagent.thread_spawn.parent_thread_id. Fork ancestry alone never establishes a spawn relationship. Parentless threads and children whose parent is unavailable appear as independent sessions; available descendants load recursively with a visited set. Agent names, paths, and roles come from metadata. Internal agents are preserved when their explicit parent points into the family. The discovered family size is the subagent count the session list uses without reading descendants.

Live checks stat known files and rescan Codex metadata to detect newly created descendants, including grandchildren and archived relatives under the selected home. Loading refreshes discovery again and reparses the selected family. For a file snapshot, rollout metadata rather than filenames identifies each thread.

### Summary generation and caching

Listing first reads file metadata and orders session candidates by modification time. Full transcript text is read only as needed to find the requested page of eligible matches. Search may require reading many candidates, but summaries are reused afterward when possible.

The summary cache is in memory, keyed by file handle with a signature of the main transcript's size and modification time and the subagent count its harness knows from discovery. An unchanged main transcript with an unchanged discovered count reuses its cached summary. Reloading the page discards the cache. A fresh list scan combines all connected directory indexes and sorts them by the same modification-time rules.

Summaries are built through the session's harness: its classifier decides which text blocks are prompts, its tool roles count spawns, and its reference discovery contributes subagent ids. The subagent count is the largest of the spawn count, the referenced ids, and the discovered count. The working directory is extracted from the first 20,000 characters of raw text; the project name is used when it cannot be found.

The last nonempty custom-title record supplies the title. The first classified prompt or command supplies the prompt preview, normalized to a single line and capped at 160 characters. Terminal string prompts and IDE text-block prompts use the same classification. IDE context preceding a real prompt does not itself count. Slash commands count as prompts and use a slash-prefixed title; shell-mode input counts and uses a leading exclamation mark.

Command and shell output, notifications, agent messages, editor context, and recognized meta/system text do not count as prompts. Interruption-marker handling has a specific caveat described under limitations. Summary counts are derived from the main transcript and available file index; they are not a traversal of every loaded descendant's prompts.

### Remembered access

Directory handles are stored as an array in the `agent-timeline` IndexedDB database, version 1, in the `handles` object store under the `transcripts` key. An existing single handle is read as a one-element array and preserved when adding another directory. Adding writes the updated array; removing writes the remaining handles or deletes the key when none remain. Remembering handles and requesting permission are separate steps. A failure to retrieve remembered handles is treated as no saved source. The picker's remembered-location identifier predates Codex support and keeps its Claude-era name so browsers still reopen at the last chosen directory.

## 9. Transcript normalization and classification

### Reading JSON lines and the shared record model

The JSON-lines reader in `app/transcripts.mjs` processes lines individually, accepts surrounding whitespace and a leading byte-order mark before an object opening brace, and skips malformed or incomplete JSON. A final valid line does not need a trailing newline. Partly written live records can therefore be ignored on one pass and included on a later reload. Each parsed line, with its source line number, is offered to every registered harness parser; when the file ends, the first parser that claims the transcript supplies its records. Codex claims a transcript once it has seen session metadata; Claude, the fallback, claims whatever remains.

Both harnesses produce the same record model, which the model builder and summaries read without knowing the harness. User and assistant records carry text, thinking, tool-use, and tool-result blocks; assistant records also carry message id, model, effort, and usage; system records carry compaction markers, errors, and titled notes; custom-title and queued-command attachment records come from Claude. Records that only Codex currently produces use neutral names so another harness could emit them: session-meta with the thread's identity and working directory, turn-context with model and reasoning effort, usage with recorded output tokens, context size, and provenance, and peer-message for deliveries between agents.

### Codex rollout adaptation

The pure adapter in `app/codex.mjs` converts local rollout envelopes to the shared record model. Codex exec JSON event streams and analysis exports are not supported import formats; a transcript made of their record types without session metadata produces an error rather than an empty session.

Response-item messages are preferred over completed-item and legacy UI message copies. Matching role/text occurrences are suppressed across those layers, while repeated messages within one layer remain separate. Assistant text and visible reasoning become reply and thinking events. Encrypted or non-text message blocks receive unavailable-content placeholders. Repository instructions, environment and skill wrappers, interruption markers, and known injected wrappers are marked as meta. Peer deliveries are peer-message records, and source line numbers, turn IDs, original envelope times, and time provenance are retained in normalized records.

Codex classifies user text with its own rules rather than Claude's wrappers. Text beginning with a Message Type header is a received message whose Sender line names the sender. Other text marked as meta is system context. Remaining text is a prompt; IDE context containing a request remains prompt text, and its request section supplies the list preview and event title while details retain the full context.

Function and custom tool calls retain names, namespaces, call IDs, and decoded arguments or raw input. Results pair in file order within each thread. Multiple results are appended to the call's details; unmatched Codex results appear as system events. A call without a result has unknown completion. Agent tools are listed under Events and tool results. Completed command/file/collaboration items remain separately labeled activity system events because a single exec call can contain several operations; these are not extra tool calls.

Turn context supplies the model and reasoning effort. Task lifecycle records and compaction produce system markers. Replacement history is never emitted as new activity, and inherited histories are not sliced using a physical-line interpretation of the history ordinal. Fork/inheritance metadata produces a transcript note explaining attribution limits. Unknown record types are listed in a note instead of assumed to be conversation.

Usage prefers thread-scoped thread_token_usage snapshots, then legacy total_token_usage snapshots, then latest usage per distinct response ID when neither cumulative source exists. Foreign-thread usage and null rate-limit updates are ignored. Successive cumulative snapshots contribute only their change in output tokens, including a signed correction if the recorded total decreases, so the final per-thread count equals the latest recorded total. Usage is shown as system events with provenance and raw numeric counters; context uses the accompanying per-response input tokens, never the cumulative input total. Cached input and reasoning output are subsets and are not added twice. Missing usage provides no usage events. Combined figures sum recorded per-thread contributions; their tooltip and inheritance notes explain that they are not deduplicated family usage or billing figures.

Embedded message creation or event/task completion/start times take precedence over envelope timestamps, with file order breaking ties within a thread. Those embedded times can come from a different clock than the envelope, so a tool result can be recorded a second or two before its call; the viewer then shows no duration for that call. Migrated files can flatten envelope times, so ordering across threads and observed spans remain approximate. Recorded task duration is displayed separately from the timeline span. No opaque content is decrypted and no recorded command is executed.

### Claude record envelope and retained data

`app/claude.mjs` trims each Claude Code record as it is read, so raw API dumps are never retained for a whole file. Common source fields include `type`, `uuid`, `parentUuid`, `timestamp`, `sessionId`, `isSidechain`, `isMeta`, and `cwd`, plus a `message`, `toolUseResult`, or `attachment` payload. Sidechain status identifies subagent records, while meta status helps distinguish injected text from operator input.

Normalization retains the event-relevant envelope and supported payloads while discarding bulky or irrelevant material. Assistant usage retains output tokens and a single context size: input, cache-creation, and cache-read input tokens summed. User origins retain kind and sender when present. Auxiliary `toolUseResult` data retains scalar properties only, with string values capped at 4,000 characters; nested structures are discarded. Main text, thinking, and tool-input payloads are not subject to that auxiliary scalar limit.

| Source record type | Treatment |
| --- | --- |
| assistant | Retain text, thinking, and tool-use blocks, message id, model, the record's top-level reasoning effort level, and output-token and context-size usage |
| user | Normalize string text or arrays of text/tool-result blocks; retain supported result metadata |
| attachment | Retain only queued-command attachments with string prompts; prefer their own timestamp when supplied |
| system | Retain error-level records, including API failures such as the api_error subtype, and compact_boundary records with their trigger and pre-compaction token count; a compaction becomes a system event titled compacted with its trigger |
| custom-title | Retain the custom title for the session index |
| api-request and related types | Drop raw API request dumps |
| file-history types | Drop snapshots and deltas |
| Bookkeeping types | Drop entries such as last-prompt, mode, permission-mode, cost-state, queue-operation, titles used internally, and continuation/summary bookkeeping |
| Unsupported content or record types | Ignore rather than inventing events |

Tool-result arrays are flattened to text content. Non-text result blocks and unsupported attachments do not become rendered media.

### Claude classification precedence for user text

Each harness classifies user text into the same kinds: prompt, command, received message, notification, coordinator delivery, or system text. Codex's rules are described under Codex rollout adaptation; Claude's follow. Classification operates on each text block, not on an entire user record as though it were necessarily a prompt. The wrapper beginning Another Claude session sent a message is removed before classification. The following order is significant; wrapper names below identify transcript fields, not rendered HTML.

| Priority | Recognition | Classification |
| --- | --- | --- |
| 1 | agent-message wrapper with a from attribute | Received message; a Subagent hand-back prefix is recognized within the body |
| 2 | task-notification wrapper | Notification with task-id, status, summary, result, and raw text |
| 3 | local-command-stdout wrapper | System command output; empty or no-content output is skipped |
| 4 | command-name and command-args fields | Command with combined name and arguments |
| 4 | bash-input wrapper | Shell-mode command, titled with an exclamation mark |
| 4 | bash-stdout or bash-stderr wrapper | System shell output; empty output is skipped |
| 5 | Text beginning The coordinator sent a message while you were working | Coordinator delivery from the parent agent |
| 6 | ide_selection or ide_opened_file wrappers | System editor context |
| 6 | system-reminder or local-command-caveat wrappers | System reminder or caveat |
| 6 | Text beginning Base directory for this skill, followed by a colon or semicolon | Skill system text; a Markdown heading can supply the skill title |
| 6 | Other text on a record flagged as meta | General system text |
| 7 | Remaining text | Prompt, interpreted according to the owning agent |

Coordinator delivery is recognized before the general meta rule because messages sent to a working subagent can be marked as meta. Reversing that order would incorrectly hide communication among system events.

For every harness, remaining prompt text in the main session becomes operator events. In a subagent, the first such prompt becomes its task-prompt operator event; subsequent unclassified prompts become injected-text system events. Queued-command attachment prompts pass through the same classifier without a meta flag. Error-level system records, such as API errors, become system events with an error marker.

## 10. Session model and relationships

### Events and tool results

Each retained assistant text, thinking, or tool-use block becomes an event. Although Claude Code commonly splits a reply into separate records, the viewer also processes multiple supported blocks within one record. Tool calls are indexed by tool-use id within each agent; a matching user-side result enriches the original event with result text, error state, completion timestamp, and retained result metadata. Whether a result without its call becomes an event is the harness's choice: an unmatched Claude tool result does not create a standalone event; unmatched Codex results remain visible as system events.

The session's harness decides which tool calls are agent actions; every other call becomes a tool event, titled by the harness for its own tools (Claude's Bash, file, search, skill, and web tools) and otherwise by a description or the first string input.

| Role | Claude Code | Codex |
| --- | --- | --- |
| Spawn | Agent, or older Task; content from prompt, title from description or subagent_type | spawn_agent, with any namespace prefix; content from message, title from task_name or agent_type |
| Message | SendMessage; content from message, title from summary or message, target from to | send_message, send_input, or followup_task; content and title from message, target from target or id |
| Stop | TaskStop; target from task_id or legacy shell_id | close_agent or interrupt_agent; target from target or id |
| Handback | SubagentHandback; its message is the final report | None |
| Child details from the spawn | Description as label, subagent_type as type, optional model | Optional model |
| Child from the spawn result | Result metadata agentId, or recognizable result text | Result agent id |
| Stop result | A result identifying a non-agent task, such as a shell, clears the agent endpoint | Always addresses an agent |

Received agent-message blocks and notifications with the same receiving agent, classified kind, sender, and text are deduplicated. Coordinator-prefix deliveries do not use this duplicate check. Task id alone is not the deduplication key: one background task may produce distinct notifications each time it stops and resumes. Exactly repeated content can still collapse even if it arrived at a different time.

### Time and token accounting

Events are sorted by parsed timestamp, with processing sequence as the tie-breaker. Records retain their file order within each agent. The main transcript is processed before loaded subagent transcripts, so cross-agent timestamp ties follow that processing order. A missing or invalid timestamp falls back to the previous event time for that agent.

Output usage is counted once for each message id within an agent, because split records can repeat the same model usage. The first encountered record for that reply supplies usage, and its first generated event receives the tokens. Later records with the same message id do not add usage again. A reply without a message id does not contribute to this deduplicated output count.

Tokens drive the session total, map counters, and timeline token areas. Input tokens and cache tokens are not counted. Running counters accumulate all model events through the cursor rather than only currently visible cards.

### Agent identity and parentage

The main agent is labeled main and typed as a session, except when a promoted standalone subagent supplies description and type metadata. Loaded subagents begin with metadata descriptions and agent types, falling back to their ids until spawn information supplies better labels. Metadata can supply model and parent information through model and parentAgentId.

Assistant replies update the agent's model, so the last recorded reply model takes precedence over initial metadata. Spawn options supply a fallback model if none has been found. Spawn metadata can associate a child through its toolUseId; matching result metadata or recognized result text supplies the child id when needed.

A valid metadata parent takes precedence. Otherwise the resolved spawner becomes the parent, with the main session as fallback. Direct self-parenting is redirected to the main agent. Children are traversed depth-first after sorting by first event time, with ids breaking ties. The resulting order drives map rows, timeline rows, and palette assignment. Agent colors cycle through the fixed palette for large sessions.

Message and stop targets of either harness can resolve against a loaded id, a label with a bracketed id, a known metadata label or Codex agent path (whole or its last segment), or an id prefix of at least six characters. Unresolved endpoints are cleared from graph relationships while the event and original reference remain available for inspection.

### Combined sessions

When several sessions are opened together, each is first built on its own with the rules above, so labels, identifier prefixes, and parent fallbacks resolve only within their own session. The parts are then merged: sessions are ordered by their first event time, with identifiers breaking ties, and all events are re-sorted by timestamp with the per-session processing sequence as the tie-breaker, so events of different sessions interleave by time while ties within one session keep their order. Event indexes, each agent's first, last, spawn, and stop positions, map and timeline rows, and palette colors are reassigned over the merged order; agent colors continue through the palette from one session's tree to the next.

Each session's main agent becomes a root, so the agent list holds one tree per session in session order. Each agent records which session it belongs to, with that session's ordinal, harness label, short identifier, and title, where the title is the last custom title, otherwise the first prompt, otherwise the identifier. In a combined view the root agent's label is that title shortened to 48 characters; a single session keeps the label main. Totals in the top bar, the context chart, and the context table span all sessions, and the chart's bands follow the merged agent order.

A subagent transcript can be reached from more than one session, because recursive loading follows references across the whole index and a resumed session can refer to its predecessor's agents. An agent id already present from an earlier session is kept once: the later session's copy and its events are dropped, it is removed from that session's tree, and the later session's references to it point at the kept agent, so the shared agent appears under the session that loaded it first.

### Communication semantics

| Event | Direction and special handling |
| --- | --- |
| Spawn | Calling agent to resolved child |
| Message | Sender to resolved message target |
| Stop | Caller to stopped agent; a result explicitly identifying a non-agent task clears the agent endpoint |
| Handback | Subagent to its resolved parent |
| Notification | Known task/agent id to the receiving agent; unknown task ids do not create agents |
| Received | Sender to receiver, marked as a delivery |
| Coordinator delivery | Parent to receiving subagent, marked as a delivery |

Links are grouped by an unordered endpoint pair so both directions share a connector and counter. Direction remains attached to each event for animation and timeline drawing. Self-links and links missing an endpoint are omitted. Parent-child classification is based on resolved parentage; communication between other pairs becomes peer traffic. The map also creates tree connectors for parent relationships without recorded traffic.

Map link counters count linked events, including delivered copies when they have resolvable endpoints. They are not deduplicated counts of logical messages exchanged. Timeline transfer curves specifically exclude those delivery copies.

## 11. Rendering, highlighting, and state

### Rendering lifecycle

Loading a session constructs its model, builds all feed cards, lays out map nodes and SVG links, initializes counters, and renders the timeline. A new session initially selects its first event, unless live activation moves to the latest event. Agent focus resets for a new load; retained filters continue to apply.

Playback does not rebuild the complete feed or map. It adds or subtracts event and token contributions across the traversed index range, reveals newly reached cards, changes ahead/current classes, updates map states and link counts, renders the selected details, and redraws the timeline canvas. Details are rebuilt when selection changes; canvas marks are drawn again rather than stored as persistent DOM nodes.

Filter visibility uses classes and CSS selectors. Agent focus updates one generated style rule using an escaped agent identifier rather than regenerating cards. This preserves the existing DOM and scrolling workflow in dense sessions. Live reloads are the deliberate exception: they replace the model and view structures, then restore compatible state.

### Highlighting rules

`app/highlight.js` implements small hand-written highlighters for JSON, JavaScript, TypeScript, Python, shell, CSS, HTML, diffs, and Markdown. HTML can highlight embedded style and script content. Markdown is highlighted source text, not a conversion into arbitrary rendered HTML; fenced code content is highlighted using its language tag when recognized.

Language selection uses the file extension for Read, Write, and edit content; normalized code-fence tags for Markdown; explicit shell or JSON treatment for specialized sections; or text-based inference where the caller requests it. Supported extension families include common JS/TS variants, Python, shell/batch/PowerShell, JSON variants, CSS preprocessors, HTML/XML/SVG/Vue, Markdown variants, and diff/patch. Dockerfile and Makefile names receive shell treatment. Unrecognized languages fall back to plain text.

Numbered listings are recognized when every nonempty line begins with a number followed by a supported tab, arrow, or pipe separator. When requested, those listings split into a nonselectable line-number column and a nonwrapping code column, with horizontal scrolling to preserve alignment. Other code wraps long text within the available width.

Text longer than 150,000 characters bypasses syntax highlighting and the separate numbered-column treatment. It is still displayed as plain text. All highlighted output is constructed from text nodes and spans, preventing transcript content from injecting markup into the page.

### Performance and persistence

Session summaries are lazy and cached; session playback uses prebuilt cards and incremental counter changes. The timeline uses a viewport-width canvas over a longer native scroll track rather than a canvas spanning the entire horizontal event space. At the same time, loaded transcript files are read in full, feed cards are not virtualized, and live changes rebuild the session rather than patching individual records.

No transcript content or playback state is written back to the source. Browser persistence is limited to the remembered directory handle; the landing page's session selection is held in memory only. The inspection API also exposes the function that opens a list of mounted sessions together. Runtime inspection and browser automation can use the hidden file input or `window.__agentTimeline`, which exposes application state and selected loading, model, playback, and live-control functions.

## 12. Limitations and interpretation caveats

| Area | Current limitation |
| --- | --- |
| Transcript evolution | Neither Claude Code's transcripts nor Codex's local rollouts are a documented format. The implementation reflects observed records as of October 2026 for Claude and November 2026 for Codex, and can miss newer or unsupported structures. |
| Rewinds and branches | Parent UUIDs are retained but not used to choose an active conversation branch. Rewound or abandoned records remain mixed into the timestamp-ordered view, with file order resolving ties. |
| Interrupted requests | Interruption markers are intended to be excluded from real prompt counts, but there is no dedicated marker rule. Markers classified as meta/system are excluded; unflagged marker text can fall through as an operator prompt and be counted. |
| Edit display | Complete old and new strings are shown sequentially, not as a computed line diff. |
| Usage | Output tokens are counted using the first encountered usage for each message id. Input and cache usage feed only the context chart, as the size of each call rather than a running total, and later revisions of repeated usage are not aggregated. |
| Transfer matching | Timeline links use the receiver's next event rather than proving that the event consumed a specific message. Map counters include resolvable delivery copies. |
| Combined sessions | Sessions are interleaved purely by recorded timestamps; clocks are not reconciled. A subagent reachable from two of the shown sessions is attributed to the one that loaded it first. Opening individual files still represents one session. |
| Repeated messages | Identical received-message or notification content can be collapsed even across distinct occurrences. Distinct notifications for one task id remain separate. |
| Live latency | The one-second polling interval introduces delay before new records appear; filesystem reads and full reloads can add further delay. |
| Discovery during live mode | Claude checks known files and the current session's own subagent directory; new agents elsewhere may require a refreshed scan. Codex rescans metadata under its selected source for new descendants. |
| Listing cost | Building an uncached summary reads the full main transcript. Large sessions and network shares can make listing or broad searches slow. |
| Summary freshness | Cache invalidation uses the main file's size and modification time and the subagent count from the last scan. Subagents that appear after that scan, or changes only inside subagent files, can leave a cached row's counts stale until the list is scanned again. |
| Large sessions | The complete model and all feed cards remain in memory. There is no virtualization or incremental tail parser. |
| Retention | Claude Code's cleanupPeriodDays retention setting can remove older transcripts; retention guidance assumes its documented 30-day default unless configured otherwise. The viewer cannot recover files that are gone. |
| Browser support | Mounted directories require File System Access support. Other browsers use file snapshots, or the full workflow through server mode. |
| Server mode | The server holds one scan and the last loaded copy of each session in memory, so its listing can lag until a rescan and its first change check after a restart always reports a change. It serves transcripts without authentication; keep it on the loopback address unless the network is trusted. |
| Remote environments | The browser cannot mount an inaccessible remote filesystem merely because the IDE is connected to it. |
| Embedded browser links | VS Code forwarded-port handling can rewrite session URLs; the landing list remains the fallback. |
| Source omissions | Unsupported attachments, non-text blocks, ignored bookkeeping, and malformed or incomplete lines do not produce events. |

These limitations describe current interpretation and behavior, not additional promised features. Changes to parsing, navigation, data retention, or presentation should update this specification alongside the implementation.

## 13. Source files and verification

### File reference

All paths below are relative to the repository root.

| File | Responsibility |
| --- | --- |
| `app/index.html` | Landing page, viewer frame, map, conversation, details, timeline track/canvas, playback controls, and hidden file input |
| `app/styles.css` | Pure-black visual system, layout, responsive panels, event and syntax colors, focus/selection states, and reduced-motion rules |
| `app/favicon.svg` | Scalable branch-graph browser icon shared by the app and root entry page |
| `app/app.js` | State, model construction, relationship resolution, rendering, interaction, playback, session navigation, and live orchestration |
| `app/transcripts.mjs` | Harness registry and interface, JSON-lines reading and format detection, harness-aware prompt summaries, working-directory extraction, and search matching |
| `app/claude.mjs` | Pure Claude Code record trimming, subagent reference discovery, user-text classification, tool roles and titles, and spawn and stop result interpretation |
| `app/codex.mjs` | Pure Codex rollout metadata and adaptation, message mirror suppression, usage provenance, source timestamps, user-text classification, and tool roles |
| `app/localfs.mjs` | Harness-neutral directory layer and directory interface: remembered directory handles and permissions, layout detection, combined sources, summary cache and session list, and live change checks; also used by the server over Node filesystem handles |
| `app/claude-fs.mjs` | Claude Code directory layout: project and subagent discovery, recursive session loading, new-subagent detection, file snapshots, and the directory hint |
| `app/codex-fs.mjs` | Codex directory layout: header-only metadata discovery, family loading, new-descendant detection, file snapshots, and the directory hint |
| `app/handles.mjs` | Directory listing and file information helpers shared by the directory modules |
| `app/remote.mjs` | Detection of the Node server and the page's source interface over its API |
| `server.mjs` | Optional dependency-free Node server: static viewer files, transcripts directory scanning and loading, and the read-only JSON API |
| `tests/check.mjs` | Dependency-free synthetic checks for each harness's parsing, classification, tool roles, summaries, discovery, nested loading, snapshots, and live changes, and for combined sources across harnesses |
| `app/highlight.js` | Language selection, tokenization, safe highlighted text, and numbered code presentation |
| `serve.json` | Local static-serving root, route rewrites, redirect, and directory-listing configuration |
| `index.html` | Root entry point forwarding to the app, with link and meta-refresh fallbacks |
| `.nojekyll` | Static GitHub Pages publishing marker |
| `README.md` | Project introduction and documentation entry points |
| `LICENSE` | MIT License |
| `docs/specification.md` | Implemented features, data interpretation, operational requirements, and implementation reference |
| `docs/design.md` | Visual rationale, complete component/state inventory, exact color and typography reference, review standards, and separately identified future design possibilities |

### Verification expectations

There is no build step, test framework, or coverage threshold. Run `node tests/check.mjs` from any directory for synthetic parser and filesystem checks of both harnesses; it never reads personal transcripts. A change to one harness should add or update cases in that harness's section. Changed JavaScript modules should pass Node's syntax check, including `server.mjs`. Server mode can be verified by starting the server on a spare port, requesting its API endpoints, and opening the viewer in a browser without File System Access support. Pure transcript and filesystem modules can be exercised from Node with mock file and directory handles.

Behavioral verification uses Chrome or Edge and a real session, covering loading, nested agents, playback, filters, selection, scrolling, and live updates as relevant to the change. Browser automation can select files through the hidden input or use the exposed inspection API.

Interface changes should be checked on both the landing page and populated viewer at desktop and narrow widths, including the 1100 px and 760 px panel transitions and a 320 px viewport. Review keyboard focus, text selection, reduced motion, zoom/reflow, long labels, large code sections, and dense sessions. Preserve the existing read-only, local-only transcript workflow throughout verification.
