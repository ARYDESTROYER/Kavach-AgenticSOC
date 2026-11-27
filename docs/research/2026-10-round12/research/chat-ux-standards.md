# General AI chat UX standards (leaders, 2025-2026) — for the Agentic SOC chat (Round 12)

Researched 2026-10-10. Scope: Claude.ai / Claude apps / Claude Code, ChatGPT, Gemini, Perplexity,
Microsoft (365) Copilot, Cursor, plus Apple HIG + the local `apple-design` skill. Purpose: give the
Round-12 SPEC concrete, cited patterns for (1) using the full width when the left menus collapse,
(2) a "working" indicator in the navigation, (3) removing per-message truncation / "continue where
this stopped", and (4) more chat functionality.

**Evidence labels** (used throughout so marketing is not mistaken for behaviour):

- **[Doc]** vendor documentation / help centre / developer docs read in this session.
- **[Ann]** vendor announcement or message-centre item (states intent, may lag the product).
- **[Press]** press coverage of a vendor feature.
- **[3P]** third-party guide, forum or community post (anecdotal).
- **[Obs]** widely observed product behaviour that I could NOT re-verify in this session (the shared
  web-search budget ran out mid-research). Treat as a hypothesis to confirm in a browser.

Several primary pages (help.openai.com, openai.com, perplexity.ai help centre, some Medium posts)
returned HTTP 403 to the fetcher; where that happened the claim is sourced from search-result
extracts of those pages or press, and labelled accordingly.

---

## 0. TL;DR for the SPEC author

1. **Width.** No leader widens *prose* on big screens. ChatGPT keeps "a narrow fixed-width column"
   (users are asking for compact/comfortable/wide/full modes and wider tables/code while prose stays
   readable) [3P, OpenAI forum, Jul–Sep 2026]. The leaders use extra width by opening a **side panel
   or full-screen viewer** (Claude artifacts, ChatGPT canvas, Gemini canvas, ChatGPT deep-research
   full-screen viewer) [Doc]. Recommendation: keep prose at ~48rem (WCAG 1.4.8 says ≤ 80 characters;
   Bringhurst 45–75, 66 ideal) but let **blocks (tables, charts, timelines) break out to the full
   lane width** that the collapsed nav frees, add an **Expand → full-screen** view per block, and
   offer a per-user **width preference** (Comfortable / Wide / Full). Today our lane hard-caps blocks
   at 64rem (`webui/src/soc/chat/message/lane.ts`), which is exactly why the chat looks unused at
   1920 px with the nav collapsed.
2. **Working indicator in navigation.** The clearest documented model is Claude Code's agent view:
   animated icon = working, yellow = needs input, dimmed = idle, green = completed, red = failed,
   grey = stopped; terminal tab title carries a count; notifications fire when a background session
   needs input, finishes or fails [Doc]. Claude Desktop sends an OS notification when a session
   finishes and you are not viewing it; Projects show a **dot on the Overview button** when a thread
   waits on you [Doc]. Gemini shows **"a notice next to the chat thread"** when a Deep Research report
   is ready [Doc]. Claude.ai's *Chat* tab has no such indicator and a request for one was closed "not
   planned" (Jun 2026) [3P] — so this is a place to beat the leader, not copy it.
3. **No truncation / no "continue where this stopped".** Leaders replace hard caps with
   **automatic summarisation (compaction)**: Claude.ai ("summarizes earlier messages to continue the
   conversation seamlessly", shown as "organizing its thoughts") [Doc]; Claude Code (auto-compact,
   "Conversation compacted", `/compact` with instructions, `/context`) [Doc]; Cursor (chose
   "summarize the oldest messages" over truncating or forcing a new chat, and made it visible)
   [Doc/3P staff]. For output length, Anthropic's own guidance is to **continue automatically when
   `stop_reason == max_tokens`** (append partial answer, ask to continue, stitch) and to loop on
   `pause_turn` [Doc]. Long work runs **in the background** with progress and a notification
   (ChatGPT deep research 5–30 min, Gemini Deep Research ~5–10 min, Claude Code cloud sessions)
   [Doc/Press].
4. **More functionality worth copying** (all documented): edit-plan-before-run research mode with a
   full-screen report viewer (TOC + sources + activity history) and MD/DOCX/PDF export (ChatGPT,
   Gemini, M365 Researcher); branch-in-new-chat from any message (ChatGPT, Sep 2025); chat search
   that shows up as a visible tool call (Claude); projects/notebooks as folders (ChatGPT, Claude,
   Gemini); adaptive follow-up suggestions that back off when ignored (Claude Code); side questions
   that don't disturb the main thread (Claude Code `/btw`); "recap when you come back" (Claude Code).

---

## 1. Transcript width and layout

### 1.1 Reading measure — the fixed point

| Source | Rule |
|---|---|
| WCAG 2.2 SC 1.4.8 Visual Presentation (AAA) [Doc] | "Width is no more than 80 characters or glyphs (40 if CJK)." Rationale: "long lines of text can become a significant barrier" for some readers; "a narrow block of text makes it easier for them to continue on to the next line." |
| Bringhurst via webtypography.net [Doc] | "Anything from 45 to 75 characters is widely regarded as a satisfactory length of line"; "The 66-character line … is widely regarded as ideal"; multi-column 40–50. |
| Apple HIG Layout [Doc] | "predefined layout guides … restrict the width of text for optimal readability"; at very large window sizes "prefer to keep content horizontally centered". |

Implication: our prose track (`min(48rem,100%)` ≈ 768 px; with Inter at 15–16 px that is roughly
80–95 average characters) is already at the upper edge of the readable band. **Do not widen prose**
when the sidebar collapses; widen everything that is *not* running prose.

### 1.2 What the leaders actually do with wide screens

| Product | Prose column | How extra width is used | Evidence |
|---|---|---|---|
| ChatGPT | "narrow fixed-width column" on large/ultrawide displays | Canvas opens beside chat (download top-right); deep research opens a **full-screen viewer** "apart from the chat, with a table of contents on the left and sources on the right"; desktop app file previews beside chat | [3P] forum request 2026-07-31 + OpenAI_Support reply 2026-09-07 (no timeline for adjustable widths); [Press]/[Doc-extract] deep research viewer |
| Claude.ai | fixed centred column (≈ `max-w-3xl`) | **Artifacts** "open in its own window beside the conversation"; all artifacts collected in an **Artifacts tab in the sidebar**; template artifacts open on an editable canvas/page | [Doc] support 9487310; column width [Obs] |
| Gemini | fixed centred column | **Canvas** "appears in a panel beside your chat"; Deep Research report opens in Canvas | [Doc] support 16047321, 15719111 |
| Claude Code Desktop | session pane | drag-and-drop pane layout, side chats, Browser pane, tasks pane | [Doc] code.claude.com/docs/en/desktop |

The community request against ChatGPT is a useful spec for us because it is the users' own wording
[3P]: "Offer compact, comfortable, wide, and full-width modes, plus draggable boundaries"; "Keep
prose at a readable line length, but let tables, code, images, and other artifacts use more
horizontal space"; "Split view"; "Save the layout separately for laptops, desktops, and ultrawide
monitors". OpenAI has not shipped it — an opportunity.

### 1.3 Sidebar collapse behaviour (Apple HIG Sidebars [Doc])

- "People sometimes want to hide the sidebar to create more room for content details" — i.e.
  collapsing a sidebar is a request for **more content room**; content that stays the same width
  after a collapse violates that expectation.
- macOS: "Consider automatically hiding and revealing a sidebar when its container window resizes
  … making more room for message content."
- "Avoid hiding the sidebar by default to ensure that it remains discoverable."
- "Avoid putting critical information or actions at the bottom of a sidebar" (macOS).

### 1.4 Recommendation for Agentic SOC (maps to the user's complaint #1)

Current: `LANE_GRID = minmax(0,1fr) | minmax(0,8rem) | min(48rem,100%) | minmax(0,8rem) | minmax(0,1fr)`
→ blocks max 64rem regardless of available width; the 1fr gutters absorb everything else.

Proposed "breakout" lane (container-query driven, not viewport):

- Prose / user bubble / meta row / composer: keep `min(48rem, 100%)` (optionally a `Comfortable`
  48rem vs `Wide` 56rem prose choice — still ≤ ~95 chars).
- **Wide track for blocks**: grow with the lane, e.g. `min(100%, max(64rem, 100cqi - 2*gutter))`
  capped at ~120rem, so a table/chart uses the room freed by the collapsed nav and docked/strip rail.
- **Full-bleed option** per block type: tables with > 6 columns, timelines and charts default to the
  wide track; KPI rows wrap to more tiles per row instead of stretching.
- Per-block **Expand** → full-screen sheet (Claude artifact full screen, ChatGPT deep-research
  viewer pattern), with Esc to close and focus returned to the trigger.
- Per-viewer **width preference** in the thread toolbar ⋯ menu: Comfortable (today) / Wide (blocks to
  lane) / Full (prose 56rem, blocks full lane); persisted per viewer (localStorage is acceptable
  for a convenience, per our UI rules).
- Keep the report panel as a **split** (the leaders' canvas pattern) — that is the other legitimate
  way to consume wide screens.

---

## 2. Working / streaming indicators

### 2.1 In-message indicators

| Product | Indicator | Evidence |
|---|---|---|
| Claude.ai web | "hand-drawn spinner animation that plays while it's thinking" (the Claude spark/glyph) | [3P] Medium reverse-engineering article (403 to fetcher; quoted from search extract) |
| Claude Code CLI | animated glyph cycle (community-reported sequence `· ✢ ✳ ✶ ✻ ✽ ✻ ✶ ✳ ✢`) + rotating verbs + tips; per-turn duration line ("Cooked for …") | Settings index [Doc]: `spinnerVerbs` "Add or replace the verbs shown while a turn runs"; `spinnerTipsEnabled`; `spinnerTipsOverride`; `showTurnDuration` "Hide the 'Cooked for' duration after each response"; `prefersReducedMotion` "Reduce or turn off spinner, shimmer, and flash animations". Glyph sequence [3P] |
| Claude.ai long chats | "organizing its thoughts" while auto context management runs | [Doc] support 11647753 |
| ChatGPT deep research | side panel "with a summary of the steps taken and sources used"; toggle between source list and activity log; activity history kept in the finished report | [Press] launch coverage; [Doc-extract] help 10500283 |
| M365 Copilot Researcher | "Watch it work" stage; may ask clarifying questions first ("answer … or just say 'Go ahead'") | [Doc] support.microsoft.com |
| Gemini Deep Research | plan → **Edit plan** → **Start research**; "about 5–10 minutes" | [Doc] support 15719111 |
| Apple HIG Generative AI | "instead of 'Processing…', say 'Finding substitutions for ingredients' … Specific feedback reduces uncertainty and makes waiting feel purposeful." | [Doc] |
| Apple HIG Progress indicators | "Keep progress indicators moving"; "When possible, use a determinate progress indicator"; "Display a progress indicator in a consistent location"; "When it's feasible, let people halt processing"; avoid vague terms like *loading* | [Doc] |

### 2.2 Indicators in navigation (per conversation / per session)

| Product | What the nav shows | Evidence |
|---|---|---|
| Claude Code agent view | **State icons**: Working = animated; Needs input = yellow; Idle = dimmed; Completed = green; Failed = red; Stopped = grey. Shape: `✻`/animated `✽` = running or needs input; `∙` = exited. Groups ordered Pinned → Ready for review → Needs input → Working → Completed. Row summary refreshed ≤ every 15 s while working. Terminal tab title: "2 awaiting input · claude agents". Footer in a regular session: "← 2 agents", briefly "← 2 done". Notifications when a background session "starts needing your input, finishes, or fails". | [Doc] code.claude.com/docs/en/agent-view |
| Claude Desktop (Code tab) | "sends an OS notification when a Code session finishes a task and you aren't currently viewing that session" | [Doc] desktop |
| Claude Projects (Code) | **Overview** button "shows a dot when a thread is waiting on you"; threads grouped Ready for review / Waiting on you / Working; desktop notifications on post, error, needs input | [Doc] claude-projects |
| Claude Desktop (Chat tab) | No working indicator; feature request #70113 (2026-06-22) closed "not planned" 2026-06-25; separate bug reports that navigating away mid-generation interrupted/discarded the response (Feb 2026, closed) | [3P] claudeissues.com |
| Gemini | Deep Research: "Gemini shows a notice next to the chat thread when the report is ready" (web); device notification on mobile. Deep Think: "Gemini will let you know when your response is ready" | [Doc] support 15719111; release notes 2025-12-04, 2026-02-12 |
| ChatGPT deep research | "you can step away … you'll get a notification once the research is complete" | [Press] launch coverage |
| ChatGPT (ordinary chats) | No official doc found for a per-chat running indicator in the sidebar | — (gap) |

### 2.3 Recommendation (maps to user ask #2 "small icon or animating logo on the LHS like Claude")

- **App nav rail (LHS)**: the Chat item shows the product mark animating (small, ≤ 16 px, a
  morph/rotate of our logo glyph, ~1–1.5 s cycle) while *any* of the viewer's turns runs; a static
  accent dot when an answer finished while the viewer was elsewhere (unread); a warning dot when a
  turn failed or needs attention. Works in both the expanded (240 px) and collapsed (64 px) rail —
  the collapsed rail is precisely when the user asked for it.
- **History rail rows**: same grammar per conversation (Claude Code agent-view states, simplified):
  Working (animated glyph), Done-unread (dot), Failed (error glyph), Stopped (muted). Group order
  stays chronological; optionally float Working to the top like Claude Code's grouping.
- **Document title / favicon**: prefix a count while hidden, e.g. "(1) Chat · Agentic SOC" or "✓"
  when done, mirroring Claude Code's tab title count. Optional opt-in browser Notification on
  completion when the tab is hidden (Claude Desktop/Gemini/ChatGPT DR precedent), never by default.
- **Run must survive navigation**: the turn keeps running server-side when the user switches
  conversation or page and re-attaches on return (leaders treat interrupt-on-navigate as a bug).
- **Accessibility**: text alternative on the nav item ("Chat — 1 answer in progress" via
  `aria-description`/sr-only), one polite announcement "Answer ready in ‹title›" through the shell
  announcer; no announcement per animation frame.
- **Reduced motion**: replace the animation with a static glyph + the word "Working" (Claude Code
  `prefersReducedMotion` precedent; apple-design §14). Avoid slow looping oscillation near 0.2 Hz
  (one cycle per 5 s) — apple-design §14 calls this out.
- **Specific labels**, not "Thinking…": "Searching Wazuh logs (24h)…", "Enriching 3 indicators…"
  (HIG generative-AI guidance). Keep the location consistent (HIG progress indicators).

---

## 3. Long-running, multi-step answers: no truncation, auto-continue, background runs

### 3.1 What leaders do

| Pattern | Who | Evidence |
|---|---|---|
| Continue automatically after `max_tokens` | Anthropic API guidance: "Ensuring complete responses" loop — append the partial text as the assistant turn, send "Please continue from where you left off.", concatenate, stop when `stop_reason != max_tokens`; truncated `tool_use` → retry with higher `max_tokens`; if you must stop, "append a notice so the reader knows the output is incomplete" | [Doc] platform.claude.com handling-stop-reasons |
| `pause_turn` → resend as-is | Anthropic: server-tool loop hit its iteration limit (default 10); "continue the conversation by sending the response back as-is"; "Your application should handle `pause_turn` in any agent loop" | [Doc] |
| Request max output without computing input size | `model_context_window_exceeded` stop reason; treat as truncated | [Doc] |
| Auto-continue after a limit resets | Claude Code: "Continuing automatically at 3:45pm · esc to cancel"; re-arms at most twice; cancellable | [Doc] interactive-mode |
| Background runs + progress + notify | ChatGPT deep research (5–30 min; sidebar steps/sources; notify; interrupt to adjust focus; update sources mid-run) ; Gemini Deep Research (~5–10 min; can leave the chat; notice by thread); Claude Code cloud sessions "continue even if you close the app"; Claude Code `Ctrl+B` moves work to background | [Press]/[Doc-extract]; [Doc] |
| Steer mid-run without stopping | Claude Code Desktop: "type a correction and press Enter to send it without stopping the running action"; Esc interrupts but "Claude keeps the work done so far"; queued messages sent next | [Doc] desktop, interactive-mode |
| Recap on return | Claude Code: one-line recap after ≥ 3 min unfocused, ≥ 3 turns | [Doc] interactive-mode |

### 3.2 Context-window management: compaction instead of hard caps

| Product | Behaviour | Evidence |
|---|---|---|
| Claude.ai | "When your conversation approaches the context window limit, Claude summarizes earlier messages to continue the conversation seamlessly." "Your full chat history is preserved." Shown as "organizing its thoughts". Requires code execution; "Longer conversations … consume more of your usage limit." | [Doc] support 11647753 |
| Claude Code | Auto-compaction "summarizes conversation history when approaching context limits"; configurable auto-compact window (`/autocompact 500k`, `autoCompactWindow`, `--autocompact`); `/compact <focus>` for custom instructions; "Compact instructions" section in CLAUDE.md; `/context` shows what consumes space; status line exposes `context_window.used_percentage` / `remaining_percentage` (input tokens only); after compaction: "Conversation compacted" + restored files/skills; summary keeps "your requests and intent, key technical concepts, files … errors and how they were fixed, pending tasks, and current work" | [Doc] costs, model-config, statusline, context-window |
| Cursor | "Cursor has always chosen" to "summarize the oldest messages" (rejected: cut the top off; force a new chat); made summarisation visible because it "can have a significant effect on your workflow"; context ring next to the input (3.3: per-category breakdown — [3P]) ; users complain when it triggers too early | [3P staff reply]; [3P] forum/blog |
| Anthropic API | Server-side compaction (beta): on-demand or at a token threshold; can keep recent turns verbatim; can run in the background; "response quality degrades as a conversation grows" | [Doc] compaction overview |

### 3.3 Recommendation (maps to user ask #3 "no truncations, no 'continue where stopped', no token limits on chats")

Our current bounds (SPEC §4.2): `max_model_calls 5`, `max_tool_calls 10`, `turn_token_ceiling 60 000`,
`final_max_tokens 4 000`, `observation_chars 6 000`, `turn_timeout_s 90`, history "last 12 exchanges;
older are not sent", and a user-facing "Continue where this stopped (≈ +N tokens)" chip.

- **Output**: request the model's maximum output (or use `model_context_window_exceeded` where the
  provider supports it); on `max_tokens`, **auto-continue server-side** and stitch into the same
  answer (Anthropic pattern). Remove the "Continue where this stopped" chip; keep a single quiet
  run-log row "Continued (part 2)". Provider-agnostic: the continuation prompt is plain text, so it
  fits our text-JSON protocol and every call still goes through the ONE gateway (#6) and ledger.
- **Steps**: drop the hard `max_model_calls`/`max_tool_calls` stop for chat; keep a **no-progress /
  loop breaker** (same tool+params repeated, no new evidence) and the existing per-tool timeouts —
  these are correctness guards, not token limits.
- **History**: replace "last 12 exchanges" with **rolling compaction** — summarise older exchanges
  into a fenced, provenance-labelled summary (log-derived content stays UNTRUSTED inside it, #9),
  keep the full transcript stored and searchable, and show one quiet line: "Earlier messages were
  summarised to keep going" (Cursor/Claude.ai precedent: make it visible).
- **Observations**: keep the structural shrink (valid JSON) but let the agent page further instead of
  losing rows; never cut characters.
- **Wall clock**: no 90 s turn ceiling for chat; long turns run in the background with live run-log
  progress, survive navigation, and notify on completion (ChatGPT/Gemini/Claude Code precedent).
- **Meter**: switch the composer meter from "per-question limit" to **context used %** (Cursor ring,
  Claude Code `used_percentage`) plus spend; show "summarises at ~N%" as Claude Code's "context left
  until auto-compact" does.
- **Tension to resolve explicitly in the SPEC**: the product-wide daily AI **budget** (#10 default
  $10/day, `on_exceed="block"`) is an operator spend policy shared with automatic investigations, not
  a per-chat token limit. The user's "exception this once" should remove chat-specific caps; whether
  chat also bypasses the global budget is an operator decision (Settings) — recommend: chat exempt
  from per-turn caps, still metered, and the budget alert stays informative. Every call still goes
  through the gateway and ledger (#6).

---

## 4. Report / document generation and export

| Product | Output surface | Export | Evidence |
|---|---|---|---|
| ChatGPT canvas | panel beside chat; edit in place; highlight-to-edit; version arrows | **PDF, Markdown, Word**; code exported with its language extension (.py/.js/.sql) — Download button top-right | [Doc-extract] help 9930697 |
| ChatGPT deep research | full-screen report view: TOC, sources used, activity history | **Markdown, Word, PDF**; PDF export (May 2025) via share icon → "Download as PDF" for new and past reports (easy to miss — not in main share menu) | [Doc-extract] help 10500283; [Ann] OpenAI on X; [Press] TechRadar, VentureBeat |
| Gemini Canvas / Deep Research | panel beside chat; Create → Audio Overview / Visualize | Share & export: **Export to Docs**, Export to Slides, PDF (Workspace), Copy contents, Export to Colab (Python) | [Doc] support 16047321, 15719111; Gemini Enterprise docs |
| M365 Copilot Researcher | report with "visuals, charts, and graphs", organised sections, cited sources, next steps | **Word, Pages, PowerPoint, PDF, Infographic, Audio Overview** (GA Apr 2026); Copilot Pages → Word one-click | [Doc] learn.microsoft.com; [Ann] MC RM546246 |
| Perplexity | thread / research report | thread ⋯ More options → **PDF, Markdown, DOCX**; "Convert to Page" temporarily retired | [3P] guides; [Doc-extract] help "Perplexity Pages" |
| Claude artifacts | own window beside chat; Artifacts tab in sidebar collects everything | download/copy (legacy); template artifacts "Export" with per-type formats; publish/share (private by default) | [Doc] support 9487310 |

Recommendation (maps to user ask "reports downloading is heavily glitchy"): treat export as a
first-class, tested surface — one export menu (PDF, DOCX, Markdown, HTML, plus CSV/JSON per data
block) available from the report panel, the Reports library and a **full-screen report viewer with
TOC + sources + activity history** (ChatGPT deep-research pattern). Prefer deterministic generation
(print stylesheet / server-assembled file) over screenshotting the DOM; verify every format in tests
(file opens, all sections present, charts rendered as images/tables, no clipped tables).

---

## 5. Charts in chat

- **M365 Researcher**: final responses include "Visuals, charts, and graphs to make content easier
  to understand" [Doc].
- **Gemini**: Deep Research visuals "such as charts, diagrams, and interactive simulators" (Ultra
  only; not with Workspace sources); Canvas "Create → Visualize" from a prompt [Doc].
- **ChatGPT**: interactive charts from data analysis (switch to static, change colours, download) —
  [Obs] from the 2024 "improvements to data analysis" announcement; not re-verified here.
- **Claude**: dashboards/diagrams as artifacts beside the chat [Doc].

Our blocks (charts, KPI tiles, tables, timelines) already exceed most leaders' inline-chart support.
The gaps are presentation: width (§1.4), Expand/full screen, and robust export of the chart as an
image + its data.

---

## 6. Follow-up suggestions

- **Claude Code prompt suggestions** [Doc]: generated by "a short background request to the same
  model", "mostly cache reads plus a few output tokens"; skipped near usage limits; **adaptive back-
  off**: "Showing fewer prompt suggestions · use one to bring them back" when many go unused; can be
  turned off org-wide.
- **M365 Researcher**: report ends with "key findings and next steps to act on" [Doc].
- **Perplexity "Related"** questions under answers; **ChatGPT** follow-up chips — [Obs].
- Ours: ≤ 3 chips on the latest turn (SPEC §10.3). Consider the Claude Code back-off and making chips
  scope-aware (carry source + window).

---

## 7. History: search, pinning, folders, branching, memory

| Feature | Leader behaviour | Evidence |
|---|---|---|
| Chat search | Gemini: keyword search of past chats, global on web + mobile (2025-08-21). Claude: ask naturally; RAG search over past chats **shown as a tool call**; scoped per project; toggle "Search and reference chats"; incognito chats excluded; crossed-out memory icon on chats with memory off | [Doc] Gemini release notes; [Doc] Claude 11817273 |
| Pinning | Gemini (Bard) pin/rename since 2023-07-13; ChatGPT native pin, reportedly max 3 pinned on all tiers | [Doc] Gemini notes; [3P] AI Toolbox (vendor of competing tool) |
| Folders / projects | ChatGPT Projects: chats + files + instructions (override global), project memory; Claude Projects: knowledge, instructions, grouped chat history, RAG mode "up to 10x" capacity, sharing (Team/Ent), free = 5 projects; Gemini study notebooks (desktop Jun 2026, mobile 2026-08-19) | [Doc-extract] OpenAI 10169521; [Doc] Claude 9517075; [Doc] Gemini notes |
| Branching | ChatGPT "Branch in new chat" from any message (2025-09-04, web): new chat with history up to that point, original intact | [Press] BGR/TechRadar/Ars via search |
| Editing earlier prompt | Claude: editing an earlier message creates a separate version of the chat with its own artifacts | [Doc] 9487310 |
| Memory | ChatGPT: "Saved memories" (explicit) vs "Reference chat history" (implicit); manage/delete; Temporary Chat neither reads nor writes memory | [Doc-extract] OpenAI 8590148, 11146739 |

Ours already has: server-side content search with snippet + scroll-to-message, pin, date groups,
rename, export, approved-memory with human review. Candidate additions: **branch from message**,
**case/project folders** (group conversations by case or hunt), **edit-and-resend** earlier prompt
creating a version, temporary/"don't save" chat.

---

## 8. Keyboard shortcuts

| Action | ChatGPT [3P lists; in-app panel via Ctrl/Cmd+/] | Claude Code [Doc] | Ours (SPEC §10.4a) |
|---|---|---|---|
| New chat | Ctrl/Cmd+Shift+O | `/clear` | Ctrl/Cmd+Shift+O ✓ |
| Toggle sidebar | Ctrl/Cmd+Shift+S | — | Ctrl/Cmd+Shift+S ✓ |
| Focus input | Shift+Esc | — | Shift+Esc ✓ |
| Show shortcuts | Ctrl/Cmd+/ | `?` | Ctrl/Cmd+/ ✓ |
| Copy last response | Ctrl/Cmd+Shift+C | — | gap |
| Copy last code block | Ctrl/Cmd+Shift+; | — | gap (copy last query?) |
| Delete chat | Ctrl/Cmd+Shift+Backspace | — | gap (confirming dialog) |
| Stop | Esc (stop button) | Esc — "Claude keeps the work done so far" | Esc in composer ✓ |
| Recall last prompt | ↑ | ↑ / Esc Esc saves draft | ↑ in empty composer ✓ |
| Search history | — | Ctrl+R | palette "Search chats" ✓ |
| Background a run | — | Ctrl+B | gap (runs should simply keep going) |
| Transcript detail | — | Ctrl+O (timestamps, model per message) | run-log disclosure ✓ |

Recommend adding Copy last answer (Ctrl/Cmd+Shift+C) and Delete chat (with confirm) to match the
ChatGPT muscle memory (apple-design "Familiarity"); avoid Ctrl+K/Ctrl+B conflicts (already a rule).

---

## 9. Accessibility for streaming chat

- `role="log"`: "new information is added in a meaningful order"; implicit `aria-live="polite"` and
  `aria-atomic="false"`; needs an accessible name; append only at the end [Doc MDN]. Caveat:
  rapid updates may not all be read.
- `aria-busy="true"` while "multiple parts of a live region need to be loaded", then `false` so the
  completed update is announced once [Doc MDN] — apply to the in-progress turn so screen readers are
  not spammed token-by-token.
- Our SPEC (role=log + explicit `aria-live="off"` + shell announcer with debounced progress and
  "Answer ready") is consistent with this; add `aria-busy` on the running turn and give the new nav
  working-indicator a text equivalent.
- Motion: Claude Code ships `prefersReducedMotion` to "Reduce or turn off spinner, shimmer, and flash
  animations" [Doc]; apple-design §14: reduced motion → cross-fades, drop overshoot; honour
  `prefers-reduced-transparency` and `prefers-contrast: more` for any translucent chrome.
- Line length: WCAG 1.4.8 ≤ 80 chars (see §1.1).

---

## 10. Apple design principles relevant to a chat surface

From the local `apple-design` skill (`scratchpad/r12/apple-design-SKILL.md`, WWDC-derived) and the
Apple HIG pages read in this session.

**Response and interruptibility**
- Feedback on pointer-down (`:active { transform: scale(0.97) }`, 100 ms) for Send/Stop/chips; audit
  every debounce or artificial delay on the input path (skill §1).
- "Never lock out input during a transition" (skill §3): the composer stays editable while a turn
  runs (our SPEC already does this); Stop must be available instantly; steering mid-run (Claude Code
  Desktop) is the fluid version of this.
- HIG progress: "let people halt processing"; warn when halting loses work.

**Motion**
- Default springs critically damped (damping 1.0, response 0.3–0.4 s) for rail collapse, report
  panel, block expand; bounce only after momentum gestures (skill §4).
- Spatial consistency: the report panel enters from the right and leaves to the right; popovers and
  menus scale from their trigger (`transform-origin`) (skill §7).
- Animate only `transform`/`opacity`; motion is designed with the visuals, not added afterwards
  (skill §11, §17).

**Materials and depth** (skill §12)
- Sticky thread toolbar and composer as translucent layers (`backdrop-filter: blur(20px)
  saturate(180%)`) with content scrolling underneath; **scroll-edge fade instead of 1 px dividers**
  where the composer overlaps the transcript.
- Never stack light translucent surfaces; heavier material for structural regions (nav, history
  rail), lighter for interactive elements; parallel non-blocking panels (report split) use
  translucency **without** a scrim; modal tasks (Delete confirm) use a dimming scrim.
- Honour `prefers-reduced-transparency` (solid backgrounds) and `prefers-contrast: more`.

**Typography** (skill §15)
- Size-specific tracking: tighten large headings (~-0.02em), body near 0, small labels slightly
  positive; tight leading on headings, ~1.5 on body; build hierarchy from weight+size+leading; scale
  spacing in rem so user text-size settings do not break the transcript.

**Principles → chat decisions** (skill §16 "eight principles")
- *Purpose*: every per-turn chrome element must earn its place (our ≤ 40 px/turn target).
- *Agency*: Stop, Retry, Edit, Ask again near the content (HIG generative AI: "surfacing controls
  like Edit, Undo, Retry, or Adjust near generated content"); confirmation only for destructive acts.
- *Responsibility*: disclose AI and its limits up front (our "Read-only … Answers can be wrong; log
  content is untrusted data"); HIG: "clearly communicate that AI-generated content may contain
  errors".
- *Familiarity*: ChatGPT/Claude shortcut and layout conventions (§8).
- *Flexibility*: width modes, per-device layout (§1.4); let people personalise.
- *Simplicity, not minimalism*: show the common path; advanced (exact query, token breakdown) one
  level deeper — our run-log disclosure.
- *Craft*: no jittery scroll (our follow-latest rules), aligned edges (the lane grid), adaptive
  light/dark.
- *Delight*: the outcome of the other seven — e.g. the animated working mark — not confetti.
- Feedback comes in four kinds — status, completion, warning, error; wayfinding — "Where am I? Where
  can I go? … How do I get out?"; direct, specific labels.

**HIG Generative AI specifics** [Doc]
- "design a loading experience or generate in the background while a person uses another part of the
  app" → background runs + nav indicator.
- Specific progress text instead of "Processing…".
- Voluntary, unobtrusive feedback (thumbs up/down).
- Coach on blocked/limited output with example requests.

---

## 11. Gap list vs current Agentic SOC chat (SPEC v2) — prioritised

| # | Gap | Leader precedent | Priority |
|---|---|---|---|
| G1 | Blocks capped at 64rem; collapsed nav frees space that goes unused | ChatGPT users' wide-mode request; Claude/ChatGPT/Gemini side panels; HIG sidebars "more room for content" | P0 (user complaint) |
| G2 | No working indicator in the app nav or per-conversation history rows | Claude Code agent view states; Claude Projects Overview dot; Gemini notice next to thread | P0 (user ask) |
| G3 | Per-turn caps (5 model calls, 10 tools, 60k tokens, 4k output, 90 s) + "Continue where this stopped" chip | Anthropic auto-continue pattern; ChatGPT/Gemini background research | P0 (user ask) |
| G4 | History window "last 12 exchanges" instead of summarisation | Claude.ai, Claude Code, Cursor compaction | P0 |
| G5 | Turn should continue server-side across navigation and re-attach; notify on completion when hidden | ChatGPT DR, Gemini DR, Claude Code cloud/desktop | P1 |
| G6 | Export reliability; no full-screen report viewer with TOC/sources/activity | ChatGPT DR viewer + MD/DOCX/PDF; M365 Researcher formats | P0 (user ask) |
| G7 | Research mode: plan → edit plan → run in background → report | Gemini DR, ChatGPT DR, M365 Researcher clarifying questions | P1 |
| G8 | Branch from message; edit-and-resend versions | ChatGPT branch (2025-09); Claude edit creates version | P2 |
| G9 | Case/project folders for conversations | ChatGPT/Claude Projects, Gemini notebooks | P2 |
| G10 | Context-used meter + "summarises at N%" | Cursor ring, Claude Code `/context`, status line | P1 |
| G11 | Copy-last-answer / delete-chat shortcuts | ChatGPT shortcut set | P2 |
| G12 | `aria-busy` on running turn; text equivalent for nav indicator; reduced-motion swap | MDN; Claude Code `prefersReducedMotion` | P1 |
| G13 | Adaptive follow-up suggestion back-off | Claude Code prompt suggestions | P3 |
| G14 | Mid-run steering (send a correction without stopping) and "recap when you return" | Claude Code Desktop / interactive mode | P3 |

---

## Sources

Claude / Anthropic
- Claude Help: How do usage and length limits work? (auto context management) — https://support.claude.com/en/articles/11647753
- Claude Help: What are artifacts and how do I use them? — https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them
- Claude Help: Using Research on Claude — https://support.claude.com/en/articles/11088861-using-research-on-claude
- Claude Help: Chat search and memory — https://support.claude.com/en/articles/11817273-using-claude-s-chat-search-and-memory-to-build-on-previous-context
- Claude Help: What are projects? — https://support.claude.com/en/articles/9517075-what-are-projects
- Claude Code: Manage costs (auto-compaction, /compact, /context) — https://code.claude.com/docs/en/costs
- Claude Code: Model configuration (auto-compact window) — https://code.claude.com/docs/en/model-config
- Claude Code: Status line (context_window fields) — https://code.claude.com/docs/en/statusline
- Claude Code: Interactive mode (shortcuts, prompt suggestions, auto-continue, recap) — https://code.claude.com/docs/en/interactive-mode
- Claude Code: Settings reference (spinnerVerbs, spinnerTipsEnabled, showTurnDuration, prefersReducedMotion) — https://code.claude.com/docs/en/settings-reference
- Claude Code: Explore the context window (what survives compaction) — https://code.claude.com/docs/en/context-window
- Claude Code: Desktop application (notifications, background tasks, cloud sessions) — https://code.claude.com/docs/en/desktop
- Claude Code: Agent view (state icons, grouping, notifications) — https://code.claude.com/docs/en/agent-view
- Claude Code: Projects (Overview dot, thread states) — https://code.claude.com/docs/en/claude-projects
- Claude API: Compaction overview — https://platform.claude.com/docs/en/build-with-claude/compaction
- Claude API: Handling stop reasons (max_tokens continuation, pause_turn) — https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons
- [3P] Reverse engineering Claude's ASCII spinner (403 to fetcher) — https://medium.com/@kyletmartinez/reverse-engineering-claudes-ascii-spinner-animation-eec2804626e0
- [3P] Pi Claude shimmer package (glyph sequence) — https://pi.dev/packages/pi-claude-shimmer?page=112
- [3P] Feature request: working indicator in Claude Desktop Chat tab (#70113) — https://claudeissues.com/issue/70113-feature-show-a-working-activity-indicator-in-the-claude-desktop-chat-tab-while-a
- [3P] Bug: navigating mid-generation discards the response — https://claudeissues.com/issue/28787-bug-navigating-to-a-different-project-mid-generation-interrupts-and-discards-the

OpenAI / ChatGPT
- Deep research in ChatGPT (help; extract via search, 403 to fetcher) — https://help.openai.com/en/articles/10500283-deep-research-faq
- Canvas (help; extract via search) — https://help.openai.com/en/articles/9930697-what-is-the-canvas-feature-in-chatgpt-and-how-do-i-use-it
- Projects in ChatGPT — https://help.openai.com/en/articles/10169521-projects-in-chatgpt
- Memory FAQ / Reference saved memories — https://help.openai.com/en/articles/8590148-memory-faq , https://help.openai.com/en/articles/11146739-how-does-reference-saved-memories-work
- [Ann] OpenAI on X: deep research PDF export — https://x.com/OpenAI/status/1921998278628901322
- [Press] Deep research viewer update — https://www.bespacific.com/?p=121833 ; https://letsdatascience.com/news/openai-updates-chatgpt-deep-research-viewer-8778744e
- [Press] TechRadar on PDF export — https://www.techradar.com/computing/artificial-intelligence/this-new-chatgpt-feature-solves-the-most-annoying-thing-about-deep-research
- [Press] Deep research launch (sidebar, 5–30 min, notification) — https://www.tomsguide.com/ai/ai-image-video/chatgpt-just-got-openais-most-powerful-upgrade-yet-meet-deep-research ; https://www.notebookcheck.net/OpenAI-ChatGPT-gains-ability-to-create-complex-well-documented-answers-using-new-deep-research-capabilities.956876.0.html
- [Press] Branch in new chat — https://bgr.com/1959993/chatgpt-branch-conversations-new-feature-now-available/ ; https://www.techradar.com/ai-platforms-assistants/chatgpt/chatgpt-has-added-a-great-new-feature-and-its-one-i-know-ill-be-using-a-lot
- [3P] Feature request: better use of large-screen space — https://community.openai.com/t/feature-request-better-use-of-large-screen-space-in-chatgpt-chats/1388551
- [3P] Keyboard shortcuts — https://www.hongkiat.com/blog/chatgpt-keyboard-shortcuts/ ; https://www.ai-toolbox.co/chatgpt-management-and-productivity/chatgpt-keyboard-shortcuts-guide
- [3P] Pin chats (3-pin limit claim) — https://ai-toolbox.co/ai-toolbox-chatgpt-features/how-to-pin-chats-in-chatgpt

Google / Gemini
- Use Deep Research in Gemini Apps — https://support.google.com/gemini/answer/15719111
- Create docs, apps & more with Canvas — https://support.google.com/gemini/answer/16047321?hl=en
- Gemini Enterprise Canvas (Docs/DOCX/PDF export) — https://docs.cloud.google.com/gemini/enterprise/docs/assistant-canvas
- Gemini release notes (chat search 2025-08-21, notebooks 2026-08-19, Deep Think notify, pin 2023-07-13) — https://gemini.google/release-notes/

Microsoft
- What is Researcher agent (Learn) — https://learn.microsoft.com/microsoft-365/copilot/researcher-agent
- Get started with Researcher — https://support.microsoft.com/en-us/topic/get-started-with-researcher-in-microsoft-365-copilot-e63ab760-f3de-4c47-ae87-dad601b0e9c4
- [Ann] MC RM546246 Researcher output formats — https://mc.merill.net/message/RM546246

Perplexity
- Introducing Perplexity Deep Research (export to PDF/doc, Pages) — https://www.perplexity.ai/hub/blog/introducing-perplexity-deep-research
- Help: What is Research mode? (403 to fetcher) — https://www.perplexity.ai/help-center/en/articles/10738684-what-is-research-mode
- Help: Perplexity Pages (Convert to Page retired) — https://www.perplexity.ai/help-center/en/articles/10352968-perplexity-pages
- [3P] Export thread as DOCX/PDF — https://www.guideflow.com/tutorial/how-to-export-a-thread-as-a-docx-in-perplexity

Cursor
- Managing Context (redirects to cursor.com/docs) — https://docs.cursor.com/context/management
- [3P staff] Summarizing chat context — why? — https://forum.cursor.com/t/summarizing-chat-context-why/102842/2
- [3P] Context keeps summarizing at 10–20% — https://forum.cursor.com/t/context-keeps-summarizing-at-10-20-of-total-context-window/163850
- [3P] Cursor 3.3 context breakdown — https://vantaige.io/blog/cursor-3-3-context-breakdown-what-to-cut-first

Standards / Apple
- WCAG 2.2 Understanding SC 1.4.8 Visual Presentation — https://www.w3.org/WAI/WCAG22/Understanding/visual-presentation.html
- The Elements of Typographic Style Applied to the Web 2.1.2 (measure) — https://webtypography.net/2.1.2
- MDN ARIA `log` role — https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/log_role
- MDN `aria-busy` — https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-busy
- Apple HIG Progress indicators — https://developer.apple.com/design/human-interface-guidelines/progress-indicators
- Apple HIG Loading — https://developer.apple.com/design/human-interface-guidelines/loading
- Apple HIG Generative AI — https://developer.apple.com/design/human-interface-guidelines/generative-ai
- Apple HIG Sidebars — https://developer.apple.com/design/human-interface-guidelines/sidebars
- Apple HIG Layout — https://developer.apple.com/design/human-interface-guidelines/layout
- apple-design skill (local copy) — scratchpad/r12/apple-design-SKILL.md (source: https://github.com/emilkowalski/skills/blob/main/skills/apple-design/SKILL.md)

Research limits: the shared WebSearch budget was exhausted before Perplexity "Related" questions,
ChatGPT interactive charts, ChatGPT/Claude.ai exact column widths and Claude.ai keyboard shortcuts
could be verified; those items are marked [Obs] and should be confirmed in a browser before they
drive a requirement.
