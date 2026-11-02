# Agent Timeline design reference

Agent Timeline is a reading instrument for agent work. Its identity comes from a pure-black canvas, closely spaced information, and colored traces of activity. The interface should help someone answer three questions quickly: who is working, what happened, and what the event actually contains.

This document owns the visual direction, component inventory, and color reference. [Specification](specification.md) owns implemented behavior, transcript interpretation, and technical details. The reference below describes the current implementation in `app/styles.css`, `app/index.html`, `app/app.js`, and `app/favicon.svg`; the final section records possible later work, not promised features. Values written directly in selectors or canvas drawing code are identified alongside reusable tokens so the reference does not imply a token system that the code does not have.

## Contents

- [Design judgment](#design-judgment)
- [Visual foundation](#visual-foundation)
- [Surface by surface](#surface-by-surface)
- [Component inventory](#component-inventory)
- [Color reference](#color-reference)
- [Typography and geometry](#typography-and-geometry)
- [Interaction and accessibility](#interaction-and-accessibility)
- [Verification standard](#verification-standard)
- [Later exploration](#later-exploration)

## Design judgment

The existing three-panel workspace and branch timeline are the right foundation. Keep their simultaneous view of agent relationships, conversation, and evidence. The strongest improvement is hierarchy: use fewer enclosing boxes, give current selection a clear boundary, and make supporting information readable without making it compete with the transcript.

The running app was inspected with a real 66-agent, 2,652-event session. At that scale, repeated rounded cards and faint metadata make the interface harder to scan. Long agent names also reveal why truncation must account for actual available width. These observations motivate a continuous session ledger and transcript log, with the map retaining discrete nodes because those boundaries explain relationships.

## Visual foundation

### Black, rules, and selective emphasis

Keep the page, conversation, details, and timeline at `#000`. Near-black fills mark panel headings and map nodes; a slightly brighter surface appears on hover. Use one-pixel rules to separate regions. Small three-pixel corners belong to controls and map nodes; session rows and transcript entries have square edges.

Selection has a blue outline and a very dark blue fill. Keyboard focus uses a stronger two-pixel outline. Hover changes the surface without resembling selection or shifting content. A light neutral fill identifies the landing page's Add directory action and the viewer's play button. Live, error, event, and agent colors retain their existing meanings. Avoid gradients, glows, large color fields, and decorative illustrations.

### Density with legibility

Use system sans for titles and transcript reading; use the existing monospace stack for panel labels, identifiers, timestamps, counters, and code. Preserve the existing body and code sizes. Panel labels are small uppercase anchors, while transcript content keeps its original case. Raise metadata and code-comment contrast instead of making everything bold.

Keep six-to-twelve-pixel interior spacing, compact controls, and independent panel scrolling. The conversation uses two-pixel gaps between entries. Density should come from removing redundant framing, not reducing line height or hiding information.

### Color as information

Preserve every `--ev-*` mapping and each agent's consistent color across the map, conversation, details, and timeline. Neutral rules provide structure; color identifies activity. Current selection and keyboard focus remain blue. Green and amber retain their live and running meanings, and red remains an error or stop signal.

Agent state also has a short text label: wait, run, now, or done. The accessible label spells out the state. Pending agents use hollow dots and readable muted names; completed agents use a dark square dot. The current dot retains its existing animation with a static reduced-motion alternative.

## Surface by surface

### Session ledger

The landing page is an index, not a marketing page. A small “Local session explorer” label introduces the title, followed immediately by the mounted source and directory actions. Keep connected directory rows and their Remove directory actions below the heading. Put copyable Claude and Codex path hints in the Add directory dialog, before opening the system picker; keep errors next to the relevant action.

The search bar leads into a ruled Sessions / Latest activity heading. Rows share a common grid: title and optional prompt preview on the left, time, size, and short identifier on the right. The working path occupies its own metadata line, followed by prompt and subagent counts. Long titles and paths truncate with their complete values available in native tooltips. A narrow green rule and the existing live badge identify recent sessions. Hover adds a quiet surface; keyboard focus adds a visible boundary. A loading row stays readable while the surrounding controls and rows fade.

### Workspace frame

Keep the slim top bar and compact statistics; the Live action sits in the playback rail beside the scrubber. Panel headings share padding, a ruled baseline, a near-black surface, and a common monospaced treatment. Controls wrap when necessary rather than forcing the viewport wider. The session identifier truncates at narrow widths, and numerical readouts use tabular figures to reduce movement.

### Agent map

Keep the tree geometry, indentation, peer curves, counters, agent stripes, and animated directional transfer dot. Refine the nodes into small rectangular diagram elements with clear connectors. Keep pending labels readable instead of fading the entire node. The focused node has an agent-colored boundary; a node owning the current event has its own status treatment. Focus and playback position are different states and can coexist.

### Conversation log

Each entry keeps its agent stripe, sender/receiver, time, event type, title, and seven-line preview. Replace the repeated enclosing cards with quiet bottom rules. The selected entry has the strongest boundary in the log, and timestamps retain enough contrast to read comfortably. Error previews retain their error color.

Preserve the existing reveal, future-dimming, filter, follow, and scroll-position behavior. The current entry is keyboard reachable without placing thousands of entries in the Tab sequence. Enter or Space selects it; the existing navigation shortcuts move through events. Space on a native control performs that control's action.

### Event details

Details should feel like a document reader inside the workspace. Keep the summary's aligned labels and values. Separate collapsible sections with horizontal rules and distinguish their headings from their content. Preserve full text, code highlighting, line numbers, JSON input, error states, and old/new edit blocks.

At 1100 pixels and below, a Details button below the conversation opens the details panel in the conversation's place. The map remains alongside it where space allows. A “Conversation” button or Escape returns to the log and restores focus. This retains access to evidence without squeezing all three panels onto a narrow screen.

Jumping to another agent returns to its conversation. When the map is hidden, an All agents button below the feed clears the agent filter so touch users can return to the full log.

### Timeline and playback

Keep the timeline's event-order axis, 18-pixel rows, agent lanes, transfer curves, token areas, and white cursor. Its visual density is meaningful. Do not add ornamental grid lines or marks that could look like events. Measure truncated labels against their available width after indentation so names stay out of the graph area.

Play has a clear neutral filled treatment, stepping stays secondary, and the position readout remains close to the scrubber. At narrow widths the controls wrap into compact rows; the timeline height is capped so conversation content still has room. In short windows, use a smaller timeline with its existing vertical scroll.

## Component inventory

Components here are HTML/CSS groupings, generated DOM, or canvas/SVG marks, not framework components. Selector names locate their implementation. Shared states and colors are specified in the tables that follow.

### Shared primitives

| Component | Implementation | Appearance and states |
| --- | --- | --- |
| Page canvas | Body and `#viewer` | Pure black, dark browser color scheme; landing scrolls with the document, viewer panels scroll independently |
| Standard button | Native button | Raised black surface, strong one-pixel border, three-pixel corners; hover, active, disabled, and visible keyboard-focus states |
| Primary action | `#mount-btn`, `#play-btn` | Light neutral fill with dark text; white hover; Add directory opens its guidance dialog, and play changes to pause |
| Small action | `.small`, `.panel-head button` | Compact Copy or panel action, with reduced padding and 11 px type |
| Text/search field | Search and text inputs | Standard control surface and border; search fills available width, with native clearing and focus behavior |
| Select | `#speed`, `#pacing` | Native dropdown using standard control styling; muted adjacent label |
| Checkbox | `.filters input` | Native checkbox with blue accent; label and input form one clickable filter |
| Range | `#scrubber` | Native slider with blue accent, flexible width, and an accessible event-position label |
| Panel | `.panel`, `.panel-head`, `.panel-body`, `.panel-foot` | Ruled boundary, raised heading strip, independently scrolling body, optional wrapping footer |
| Metadata and identifiers | `.muted`, `.mono`, `.stat` | Muted hierarchy; monospace for identifiers, tabular figures for statistics and timestamps |
| Text selection | Selection pseudo-element | Blue selected-text background and white foreground |
| Scrollbars | `.panel-body`, `#timeline-panel` | Thin native scrollbars; panel bodies specify a grey thumb on black, timeline retains native color rendering |
| Native tooltip | Title attributes on controls, rows, and nodes | Browser-rendered; provides full truncated labels or action hints without a custom tooltip surface |

### Landing page

| Component | Implementation | Appearance and states |
| --- | --- | --- |
| Heading and source | `.landing-head`, `.landing-title`, `.eyebrow`, `#source` | Small Local session explorer label, main title, wrapping source description, and bottom divider |
| Source actions | `.landing-actions`; `#mount-btn`, `#open-btn`; `.directory-sources`, `.directory-source` | Add directory and Open files above a list of connected directories, each with Remove directory and Reconnect when needed |
| Add directory dialog | `#directory-dialog`, `.directory-path`, `[data-suggested-path]`, `[data-copy-path]`, `#choose-directory-btn` | Black modal with copyable Claude and Codex paths, muted guidance, Cancel and Choose directory actions; wraps at narrow widths and scrolls within short viewports |
| Feedback message | `#landing-msg`, `.msg.error` | Full-width raised strip; neutral loading/setup feedback or pink text and dark-red border for errors |
| Search toolbar | `.landing-tools`, `#filter`, `#refresh-btn` | Flexible filter input beside Refresh, aligned with the ledger |
| Selection bar | `#pick-bar`, `.pick-bar.empty`, `.pick-hint`, `.pick-count`, `.pick-chips`, `.pick-chip`, `#pick-open-btn`, `#pick-clear-btn` | Always-present 40 px row: a borderless faint hint while nothing is ticked, otherwise a sticky raised strip with uppercase monospaced count, short-id chips whose × turns red on hover, light-filled Open together, and quiet Clear |
| Column heading | `.list-heading` | Uppercase monospaced Sessions and Latest activity labels above a strong rule |
| Session ledger | `#session-list`, `.session-row` | Continuous black rows, bottom rules, and a two-pixel leading rule; hover and keyboard focus reveal the row |
| Row content | `.pick-area`, `.pick`, `.title`, `.title-text`, `.harness`, `.first`, `.meta`, `.side` within a row | Leading blue-accented checkbox centred on the row, inside a label strip that spans the row height and makes the whole leading column clickable; strong title followed by a quiet bordered monospaced harness chip; optional prompt preview; working path and counts; right-aligned age, size, and short id |
| Selected row | `.session-row.picked` | Blue leading rule and a faint blue surface, deepening on hover or focus; takes precedence over the green live rule |
| Recent-session badge | `.badge-live`, `.session-row.live` | Compact green badge with pulsing dot and green leading row rule; distinct from the viewer's Live toggle |
| Session-loading state | `#landing.loading`, `.session-row.chosen` | Other controls and rows fade to 35% opacity and reject pointer input; chosen row stays opaque with a moving blue top edge |
| Pagination and empty result | `.landing-foot`, `#more-btn`, `#list-end` | Centered Load more action or muted end/empty/search-result message |

### Viewer frame and agent map

| Component | Implementation | Appearance and states |
| --- | --- | --- |
| Session bar | `#topbar`, `#sessions-btn`, `#harness`, `#session-id`, `.stat` | Slim wrapping row with navigation, harness chip, truncated id (or session count and short ids for a combined view), and agent/event/duration/token statistics |
| Live toggle | `#live-btn` | Muted outlined off state; green pulsing on state; white, nonanimated state when viewing behind the live edge; amber, nonanimated reconnecting state; hidden for file snapshots |
| Workspace grid | `#grid` | Three columns on desktop, two at the middle breakpoint, one on narrow screens |
| Agent-map heading | `#map-panel .panel-head`, `#show-all-btn`, `#context-btn` | Agent map label, conditional Show all agents action, and the Context popup button at the right |
| Context popup | `#context-dialog`, `.dialog-head`, `#context-chart`, `#context-tip`, `#context-table`, `#context-btn-narrow` | Modal over a dimmed backdrop: raised heading strip, stacked agent-colored step areas with recessive gridlines, white cursor and dashed hover crosshair, raised tooltip with color chips, and a ruled table with tabular figures; the narrow button sits below the conversation at 760 px and below |
| Map drawing area | `#map`, `#map-svg`, `#map-boxes` | Scrollable tree with SVG links behind absolutely positioned nodes |
| Agent node | `.agent-box` | Near-black rectangular node, three-pixel agent-color stripe, description, type/model, counts, and short status |
| Session heading | `.map-session` | Small muted monospaced line above each session's tree in a combined view, with a thin top rule; absent for a single session |
| Node state indicator | `.dot`, `.status` | wait: hollow grey circle; run: amber circle; now: blinking green circle; done: dark-green square; accessible name spells out the state |
| Focused node | `.agent-box.focused` | Agent-colored border and one-pixel inset outline; independent of the current-event state |
| Tree and peer connector | `.map-link`, `.map-link.peer` | Thin solid parent-child line or dashed peer curve; active connector becomes thicker and event-colored |
| Connector count | `.map-link-count`, `.map-link-count-bg` | Small monospace count on a black backing; active text brightens |
| Transfer marker | `.map-dot` | Event-colored moving dot showing communication direction; suppressed under reduced motion |

### Conversation and details

| Component | Implementation | Appearance and states |
| --- | --- | --- |
| Conversation heading and filters | `#feed-panel .panel-head`, `.filters` | Heading with wrapping Thinking, Tools, Deliveries, and System checkboxes |
| Feed and scroll spacer | `#feed`, its trailing pseudo-element | Vertical log with two-pixel gaps, eight-pixel scroll padding, and a minimum six-pixel tail that can grow to preserve position |
| Event entry | `.card`, `.top`, `.session`, `.kind`, `.preview` | Agent stripe; faint monospaced session short id (combined view only), sender/receiver, and timestamp; event type and title; up to seven preview lines |
| Current entry | `.card.current` | Blue one-pixel inset outline and dark-blue fill; two-pixel inset outline when keyboard focused |
| Ahead or unreached entry | `.card.ahead`, `.card.future` | Previously reached future entries are dimmed; hover raises their opacity; unreached entries remain hidden |
| Error or thinking entry | `.card.error`, thinking data type | Error title/preview use pink; thinking preview is italic |
| Feed action rail | `#feed-bar` | Shown only at 1100 px and below, holding the narrow-screen actions; stepping uses Up/Down keys and follow is driven by scrolling, so neither has a button |
| Narrow-screen actions | `#details-toggle`, `#clear-focus-btn`, `#details-close` | Details replaces the feed at 1100 px and below; Conversation returns; All agents resets focus when the map is hidden |
| Details heading and jump | `#details-panel .panel-head`, `#jump-btn` | Details label, conditional return action, and truncated jump-to-agent action |
| Details empty state | `#details .muted` | Quiet Select an event prompt |
| Event summary | `.summary` | Compact definition grid for agent, type, tool, timestamp, duration, usage, link, and status; agent identity retains its color |
| Disclosure section | `details.section`, its summary and `.body` | Ruled section with native disclosure marker; raised strip when open; error heading uses pink |
| Content variants | Sections created by `renderDetails` | Content, command, prompt, options, input, result/error result, raw notification, file content, and edit changes share the same disclosure shell |
| Code block | `pre.code`, `.hl-*` | Monospace source text on black with safe token highlighting and long-text wrapping |
| Numbered listing | `.numbered`, `.linenos`, `.lines` | Separate nonselectable numbers and nonwrapping code, with horizontal scrolling |
| Edit comparison | `.diff-head`, `.removed`, `.added` | Small edit label; old text on dark red followed by new text on dark green, with matching side rules |

### Timeline, playback, and entry assets

| Component | Implementation | Appearance and states |
| --- | --- | --- |
| Timeline scroller | `#timeline-panel`, `#timeline-track`, `#timeline` | Black ruled panel with a sticky viewport-width canvas over a full-width scroll track; grabbing cursor during pan |
| Agent label column | Canvas labels and separator | Fixed 120 px column, depth indentation, measured ellipsis, muted nonfocused labels |
| Lane and event mark | Canvas strokes and circles | Agent-colored lane and event-colored dots, with future portions dimmed |
| Transfer curve | Canvas links | Child-colored spawn/handback or event-colored other transfer; white current link; delivery copies omitted |
| Token area | Canvas fill | Faint agent-colored cumulative output-token area |
| Current position | Canvas cursor and ring | White vertical line and white ring around the current event |
| Focused row | Canvas fill | Subtle white overlay across the focused agent's row and label area |
| Playback rail | `#controls`, `.step-group`, `#position`, `#step-back`, `#step-fwd` | Primary play/pause, secondary stepping, flexible scrubber, position readout, Live toggle, speed, and pacing; wraps at narrow widths |
| File selection | `#file-input` | Hidden native multi-file input invoked by Open files; the picker itself uses browser/OS appearance |
| Drop overlay | `#drop-hint` | Full-screen translucent black veil, dashed blue border, centered blue instruction; does not intercept pointer input |
| Browser icon | `app/favicon.svg` | Black tile with blue main lane, green branch, and a light event dot |
| Root forwarding page | Root `index.html` | Minimal black fallback page with muted text and a blue link to the app; shares the favicon |

## Color reference

The application has one implemented dark scheme. There is no light theme or theme switcher. These tables record the current palette rather than introducing additional themes. CSS custom properties are reusable tokens; other values are currently local to selectors, canvas drawing, or the favicon.

### Foundation tokens

| Token | Value | Role |
| --- | --- | --- |
| `--bg` | `#000000` | Main canvas, feed, details, timeline, and backing for map counters |
| `--bg-raised` | `#070707` | Controls, panel headers, open disclosure headings, and feedback strips |
| `--bg-card` | `#050505` | Agent nodes and inline mounting-path chips |
| `--bg-hover` | `#121212` | Hover surface |
| `--line` | `#242424` | Quiet dividers and region boundaries |
| `--line-strong` | `#383838` | Control/node borders and stronger section rules |
| `--text` | `#d6d6d6` | Default foreground |
| `--text-dim` | `#a0a0a0` | Supporting prose, labels, previews, and metadata |
| `--text-faint` | `#808080` | Timestamps, arrows, counters, and line numbers |
| `--accent` | `#3fa0ff` | Keyboard focus, selection outlines, range/checkbox accent, and loading marker |
| `--danger` | `#ff4d5e` | Summary error status |
| `--warn` | `#ffb020` | Running agent and reconnecting text |
| `--ok` | `#34d17a` | Current-agent dot and recent-session leading rule |

### Event colors

Event color describes what happened, not which agent owns the event. Agent stripes, names, and lanes use the separate agent palette.

| Event | Token | Value |
| --- | --- | --- |
| Operator | `--ev-operator` | `#ff9f43` |
| Command | `--ev-command` | `#ffd166` |
| Reply | `--ev-reply` | `#b9b9b9` |
| Thinking | `--ev-thinking` | `#6e6e6e` |
| Tool | `--ev-tool` | `#3fa0ff` |
| Spawn | `--ev-spawn` | `#34d17a` |
| Message | `--ev-message` | `#c77dff` |
| Stop | `--ev-stop` | `#ff4d5e` |
| Handback | `--ev-handback` | `#2ed3c6` |
| Notification | `--ev-notification` | `#ffd166` |
| Received | `--ev-received` | `#9a7bd6` |
| System | `--ev-system` | `#5f6b7a` |

### Agent identity palette

`PALETTE` in `app/app.js` assigns these colors in depth-first tree order, starting with the main agent. The sequence repeats after twelve agents. Colors are consistent across views within the constructed model; they are not a permanent id-to-color mapping across unrelated sessions or model rebuilds that change tree order. Dynamic `--agent-color` carries identity into CSS; `--type-color` and `--link-color` carry event semantics.

| Position | Color description | Value |
| --- | --- | --- |
| 1 | Blue | `#3fa0ff` |
| 2 | Green | `#34d17a` |
| 3 | Orange | `#ff9f43` |
| 4 | Purple | `#c77dff` |
| 5 | Teal | `#2ed3c6` |
| 6 | Yellow | `#ffd166` |
| 7 | Coral | `#ff6b78` |
| 8 | Light blue | `#7cc4ff` |
| 9 | Soft green | `#9fd38b` |
| 10 | Peach | `#ffb86c` |
| 11 | Muted purple | `#9a7bd6` |
| 12 | Cyan | `#74d6e2` |

### Component and state colors

| Use | Foreground or line | Background or additional treatment |
| --- | --- | --- |
| Primary action | `#080808` text | `#dedede` fill/border; `#ffffff` on hover |
| Standard button hover | `#3a3a3a` border | Hover surface token |
| Standard button pressed | Default foreground | `#202020` fill; more-specific primary/status styles can override it |
| Strong session title | `#e8e8e8` | Black |
| Agent name | `#e6e6e6` | Node surface; pending names use muted text instead |
| Current entry | Accent outline | `#071019` fill |
| Selected text | `#ffffff` | `#174e7d` selection fill |
| Live badge / active Live | `#34d17a` text/dot, `#1f5a34` border | `#03140a` fill |
| Reconnecting Live | Warning text, `#6b4a10` border | `#140e02` fill |
| Error message / error content | `#ff8a94` | Error message border `#5a1f26`; code retains its normal surface unless shown as a removed block |
| Pending agent | Faint hollow-dot border | Transparent dot; stripe mixes 45% agent color with 55% black in sRGB |
| Current-agent node | `#52665a` top/bottom rules | Current dot uses success token |
| Finished agent | `#1f3d2b` square dot | One-pixel dot corner radius |
| Unclassified base dot | `#2a2a2a` | Replaced by a named state when the node updates |
| Parent-child connector | `#404040` | No fill |
| Peer connector | `#333333` | No fill; four-pixel dash and gap |
| Active connector / moving dot | Event link color, accent fallback | No extra surface |
| Plain code | `#cfcfcf` | Black |
| Removed edit | `#ff9aa3` text, `#5a1f26` side rule | `#170507` fill |
| Added edit | `#8fe3b0` text, `#1f5a34` side rule | `#04170c` fill |
| Panel scrollbar | `#3b3b3b` thumb | `#000000` track |
| Drop overlay | Accent instruction and dashed border | Black at 80% opacity |
| Root fallback page | `#8a8a8a` text, `#3fa0ff` link | `#000000` |

### Syntax-highlighting colors

These classes style source text and Markdown syntax rather than a rendered Markdown document. Italic and bold treatments supplement color. The same palette is reused inside recognized fenced code blocks.

| Token class | Meaning | Foreground and treatment |
| --- | --- | --- |
| `.hl-kw` | Keyword | `#c77dff` |
| `.hl-st` | String | `#9fd38b` |
| `.hl-cm` | Comment | `#89939e`, italic |
| `.hl-num` | Number | `#ffb86c` |
| `.hl-lit` | Literal | `#ff9f43` |
| `.hl-fn` | Function | `#7cc4ff` |
| `.hl-attr` | Attribute | `#74d6e2` |
| `.hl-var` | Variable | `#ffd166` |
| `.hl-op` | Operator | `#8a8a8a` |
| `.hl-meta` | Metadata | `#8a8a8a` |
| `.hl-add` | Added diff line | `#8fe3b0` on `#04170c`, full-width line background |
| `.hl-del` | Removed diff line | `#ff9aa3` on `#170507`, full-width line background |
| `.hl-h` | Markdown heading | `#ffd166`, weight 700 |
| `.hl-b` | Bold emphasis | `#e8e8e8`, weight 700 |
| `.hl-i` | Italic emphasis | Inherited color, italic |
| `.hl-code` | Inline code | `#9fd38b` on `#111111`, three-pixel corners |
| `.hl-codeblock` | Code-block text | `#bfbfbf` |
| `.hl-fence` | Code fence | `#555555` |
| `.hl-link` | Link syntax | `#7cc4ff`, underline in `#2a4a66` |
| `.hl-tag` | Tag | `#5f6b7a` |
| `.hl-bullet` | List marker | `#ffb86c` |
| `.hl-quote` | Quoted text | `#8a8a8a`, italic |

### Canvas colors and opacity

Canvas values are set in `drawTimeline`, separately from CSS card opacity. They preserve visibility of future activity without making it appear already played.

| Mark | Color | Opacity and geometry |
| --- | --- | --- |
| Played lane | Agent color | 90%; two-pixel stroke |
| Future lane | Agent color | 30%; two-pixel stroke |
| Played transfer | Child or event color | 90%; two-pixel branch stroke or 1.25 px other transfer |
| Future transfer | Child or event color | 30%; same geometry |
| Current transfer | `#ffffff` | 100%; 2.5 px stroke |
| Played / future event | Event color | 100% / 40%; 2.6 px radius, one-pixel background-colored outline |
| Token area | Agent color | 13% fill |
| Cursor line | `#ffffff` | 80%; one-pixel stroke |
| Current-event ring | `#ffffff` | 100%; 4.5 px radius, 1.5 px stroke |
| Focused row | `#ffffff` | 5% fill, including label area |
| Normal label | `#b0b0b0` | 100% |
| Other labels while focused | `#808080` | 100% |
| Label backing and separator | Background and line tokens | Black / `#242424`; code fallbacks are `#000000` / `#222222` |

### Opacity and motion outside the canvas

| State | Treatment |
| --- | --- |
| Disabled button | 40% opacity and default cursor |
| Background rows/controls during session loading | 35% opacity; chosen row remains 100% |
| Revealed entry ahead of playback | 45% opacity; 80% on hover |
| Live pulse | Green at 45% alpha fades to transparent while its shadow expands from zero to four pixels; 1.6-second loop |
| Current-agent blink | One-second stepped visibility cycle |
| Current-agent reduced-motion indication | Static two-pixel green ring at 40% alpha |
| Loading sweep | Two-pixel-high blue bar, 40% of row width, moving across in a 1.1-second loop; full-width static bar under reduced motion |
| Node and link transitions | 150 milliseconds for supported border, background, or stroke changes; disabled under reduced motion |
| Map transfer animation | Four-pixel-radius dot traveling for 650 milliseconds; disabled under reduced motion |

### Favicon palette

The favicon has a 32-by-32 view box, black fill, `#383838` outline, and six-unit tile corners. Its three-unit strokes and endpoint circles use `#3fa0ff` for the main lane, `#34d17a` for the child branch, and `#e8e8e8` for the light event. It is intentionally simpler than the full graph so it remains recognizable at tab size. Both entry pages use this local SVG.

## Typography and geometry

### Type scale

The sans stack is system-ui, Segoe UI, Roboto, Helvetica, Arial, then generic sans-serif. The monospace stack is ui-monospace, Cascadia Code, JetBrains Mono, Consolas, SF Mono, Menlo, then generic monospace. No fonts are downloaded.

| Role | Size and treatment |
| --- | --- |
| Base content and standard controls | 13 px sans; body line height 1.45 |
| Landing title | 22 px, weight 600, letter spacing −0.04 em |
| Eyebrow and ledger heading | 10 px mono, uppercase, letter spacing 0.1 em |
| Panel title | 11 px mono, uppercase, letter spacing 0.08 em |
| Source, row metadata, filters, event heading, detail summary | 12 px |
| Session id and top-bar statistics | 11 px; id uses mono |
| Node title | Base size, weight 600 |
| Node type/model and counts | 11 px; counts use mono |
| Node state | 9 px mono |
| Map connector count | 10 px mono |
| Event time | 11 px mono |
| Event preview | 11.5 px mono, line height 1.4, seven-line clamp |
| Detail code | 11.5 px mono, line height 1.45 |
| Disclosure heading | 11 px mono, uppercase, letter spacing 0.05 em |
| Edit label | 11 px |
| Timeline label | 11 px mono, vertically centered |
| Playback position and select labels | 12 px; position uses mono |
| Drop instruction | 20 px sans |
| Root fallback page | 14 px system sans |

### Layout dimensions

| Region | Current geometry |
| --- | --- |
| Landing | Centered, maximum width 1100 px; 24 px vertical padding, horizontal padding from 16 to 64 px based on viewport width |
| Session row | 10 px by 12 px padding; two-pixel row gap and 16 px column gap; no rounded container |
| Standard control | Four-pixel vertical and ten-pixel horizontal padding, one-pixel border, three-pixel corner radius |
| Top bar | Six-pixel vertical and twelve-pixel horizontal padding; 12 px gap |
| Desktop columns | Map 260–340 px; conversation and details each at least 360 px, sharing remaining width |
| Panel heading | Minimum height 36 px; six-pixel vertical and twelve-pixel horizontal padding |
| Panel footer | Five-pixel vertical and ten-pixel horizontal padding; six-pixel gap; buttons at least 32 px wide |
| Map | 12 px inset; nodes 60 px high and 180–300 px wide; 12 px vertical gap, 22 px depth indentation |
| Node | Padding 6 px top/bottom, 8 px right, 10 px left; three-pixel identity stripe; eight-pixel status dot |
| Conversation | Eight-pixel top/side inset; entries use 7 px by 10 px padding and two-pixel identity stripes |
| Details | 10 px by 12 px inset; summary grid gap 2 px by 12 px; sections separated by 10 px |
| Code sections | Eight-pixel content inset; numbered columns have a 12 px gap |
| Timeline | 18 px rows; 120 px label column; minimum seven-pixel event spacing; 8 px top/start padding, 6 px bottom, 14 px right allowance |
| Playback rail | Six-pixel vertical and twelve-pixel horizontal padding, 10 px gap; buttons at least 34 px wide; position reserves 90 px on desktop |
| Timeline height | CSS default 170 px; loaded session requests 90–260 px based on row count and horizontal-scroll allowance |

At 1100 px and below, the map column becomes 220–280 px and details shares the conversation's place. At 760 px and below, the map is hidden, the ledger has 16 px outer padding, row padding becomes 10 px by 8 px, filter gaps shrink to eight pixels, and playback wraps with smaller horizontal insets. The timeline cap becomes 20% of dynamic viewport height constrained to 90–140 px. At heights of 540 px or less, the cap is 80 px. These are space-preserving adaptations of the same component set, not separate visual themes.

## Interaction and accessibility

- Keep every action available through visible controls. Preserve existing keyboard shortcuts and native checkbox, select, range, and disclosure behavior.
- Use meaningful accessible names for search, playback, stepping, the scrubber, agent states, and event selection. Agent buttons expose their focused state.
- Keep focus, hover, current event, and focused agent distinguishable. Avoid layout shifts on these state changes.
- Respect reduced motion for loading, live indicators, current-agent dots, transitions, and existing message animation behavior.
- Preserve browser zoom, text selection, long-content wrapping, and horizontal scrolling for numbered code. Check 320-pixel layouts as well as both existing panel breakpoints.
- Keep all transcript handling local, read-only, and dependency-free. Render transcript content through the existing text-node and highlighting pipeline.

## Verification standard

Review the landing page with and without results, and the populated viewer at desktop and narrow widths. Exercise a real dense session with nested agents, beginning/end navigation, selection, filters, agent focus, playback, follow, timeline scrolling, and details disclosure. Check keyboard focus, reduced motion, zoom, and long content. Run syntax checks for changed JavaScript. Keep review screenshots local unless publication is requested.

## Later exploration

Potential improvements are user-adjustable panel widths, an explicit event-type legend, and searching within a loaded conversation. These would change interaction and state management; each needs its own specification and implementation pass. They are not part of this visual refinement. Prioritize evidence from actual reading sessions before adding more permanent toolbar controls.
