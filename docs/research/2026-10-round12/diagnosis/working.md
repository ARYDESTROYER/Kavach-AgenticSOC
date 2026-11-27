# D4: "agent is working" indicator on the left side (diagnosis + design)

Operator ask: a small icon or animated logo on the left side, like Claude's animated
mark, whenever the agent is working.

All paths are under `webui/src/soc/` unless they are marked otherwise. Probes are in
`r12/diag/scripts/working_probe*.mjs`. Screenshots are in `r12/shots/diag-working-*.png`.

---

## 1. TL;DR

- **Nothing outside the chat page shows that the agent is working.** While a turn runs,
  the only signals are inside the page. The run log says "Working" and the composer
  shows Stop. In the rail, 6 of 7 rows and New chat become *disabled*. Nothing else
  changes: no nav glyph, no brand motion, no row spinner, no `aria-busy`, and no tab
  title change (live probe; see §3).
- **Turn state is component-local, so it does not survive leaving the page.**
  `useChatEngine` keeps the transcript and the run in React state and refs
  (`chat/useChatEngine.ts:710-736`, `RunState` at 649-667). The routed content is
  re-keyed per page (`AppShell.tsx:1799`, `1803`). Navigating away therefore unmounts
  Chat, and the unmount effect aborts the stream (`useChatEngine.ts:888-897`). The
  probe saw `POST /api/chat/stream` fail with `net::ERR_ABORTED` at the instant of the
  nav click.
- **The server keeps going, but the client cannot re-attach.** The turn is a registry
  task that completes and persists after a disconnect (`backend/app/api/routes_chat.py:16-21`).
  Once the reader is gone, its events are dropped (`ChatTurnHandle.detached`, 150-189).
  The only routes are `POST /chat/stream`, `POST /chat/turns/{id}/cancel`,
  `GET /chat/context` and `GET /chat/topics/{id}` (1056, 1099, 1330, 1443). There is no
  way to list running turns or to re-attach to one.
- **Case Manager chat shares the engine and loses its whole transcript on any tab
  switch.** It is the same `useChatEngine` with `caseId` (`pages/casedetail/CaseChat.tsx:70-76`).
  Radix Tabs unmounts inactive panels (`pages/casedetail/CaseChatPanel.tsx:7-8`), so a
  tab switch drops even completed answers: the probe went from 2,517 transcript
  characters to 0 after Overview → Chat
  (`shots/diag-working-6-case-chat-after-tab-switch.png`). The answer survives only in
  the case thread (Collaboration). The next case turn is sent with empty history.
- **Recommended fix:** move the run out of the component into a tiny eager
  external store plus a module-level turn runner. Engines *detach* on unmount instead
  of aborting, and *re-attach* on return. All indicators read the store:
  - an animated glyph on the chat nav item;
  - an optional animated ring around the brand tile;
  - a spinner on the running history row, plus an "unseen answer" dot;
  - a tab-title prefix;
  - a shell-level announcer and an "Answer ready — Open" toast.
- **Optional additive backend endpoint `GET /api/chat/turns`** (owner-scoped list of
  running turns) keeps the indicator honest after a full page reload.

---

## 2. Current plumbing (evidence)

### 2.1 Where turn state lives

- `useChatEngine` is described as "the ONE client turn engine behind both chat entry
  points" (`chat/useChatEngine.ts:1-5`). It owns `items`, `busy` and `conversationId`
  as `useState` (710-718), and the run as `runRef: RunState` (727, 649-667: the
  AbortController, turnId, requestKey, conversationId and startedAt).
- Other state is per instance:
  - the generation guard `generationRef` (724), bumped by reset, hydration and unmount;
  - the live projection `ChatLiveTurn`: steps, usage, text, stopping and connection
    (166-185);
  - announcements, which go through `useTurnAnnouncer` and only while the host is
    mounted (`chat/message/useTurnAnnouncer.ts:34-47`).
- Host wiring:
  - `pages/Chat.tsx:117-139` (Workspace): `onBusyChange` feeds
    `useChatConversations.setBusy` (108-115).
  - `pages/casedetail/CaseChat.tsx:70-76` (case): `onBusyChange` only mirrors into
    local state, and its "Working…/Ready" status line is local to the panel (109-119).

### 2.2 What happens when the analyst leaves mid-turn

1. AppShell re-keys the content slot on `page` (`AppShell.tsx:1799` `RouteMotion
   routeKey={page}`, `1803` `<div key={page}>`). Workspace mounts Chat only for the
   chat tab (`pages/Workspace.tsx:45-53`). Every route change, including Chat →
   Entity investigation and Chat → Reports, unmounts the engine.
2. The unmount effect bumps the generation, calls `abandonRun()` (which aborts the
   controller) and reports `onBusyChange(false)` (`useChatEngine.ts:888-897`). The
   comment states the intent: "a disconnect is not a Stop; the server turn completes
   and persists".
3. On the server, the turn task continues and persists. Events go to nobody once the
   relay detaches (`routes_chat.py:150-189`, `emit()` drops when `detached`). A
   same-key re-POST gets 409 `chat_request_in_progress` while the turn runs, and a
   completed-key replay afterwards (`_prepare`, 603-660). The replay needs the
   identical body fingerprint (`chat_request_fingerprint`, 413). No endpoint lists or
   streams a running turn.
4. On return, `useChatConversations` starts fresh: the first load selects the
   **newest** thread (`chat/useChatConversations.ts:6-9`). It does not select "the
   thread that was running". What the analyst then sees depends on the thread:
   - **New thread, first turn:** the server stores only an idempotency `requests[key]`
     record until `complete_exchange` (`backend/app/stores/chat_conversations.py:1566-1590`).
     There is no conversation row, so nothing in the rail shows the question at all.
   - **Existing thread:** the row exists, but the saved transcript lacks the pending
     prompt until completion.
   - **Either case:** `ChatConversationSummary` has no in-progress field
     (`backend/app/models.py:2326-2350`). The composer is enabled, so the analyst can
     send a second question. The server allows 2 concurrent turns per user
     (`backend/app/config.py:1588`).
   - **When the background answer finishes,** nothing tells the client. It appears only
     on the next focus or visibility refresh, or on a BroadcastChannel refresh
     (`useChatConversations.ts:14-16`, 558-590).
5. **Thread switch mid-turn is blocked by design.** Switching would make the engine
   abandon the turn, so the controller refuses `select`, `startNew` and
   `openSearchHit` while busy (`useChatConversations.ts:664-690`) and refuses deleting
   the running thread (804-812). The rail renders those refusals as disabled rows and
   a disabled New chat (`chat/workspace/HistoryRail.tsx:390`, `448`, `544`, `683`).
   Today, that disabled state is the *only* "working" signal in the rail.

### 2.3 Left-side surfaces today

| Surface | File | Today |
|---|---|---|
| Brand tile (top-left) | `components/NavSidebar.tsx:797-817` | Static `Shield` in a 36px `bg-primary/10` tile, or the white-label `<img logoUrl>`. Also inside the mobile Sheet (`AppShell.tsx:1294-1308`). |
| Chat nav item | `registry.tsx:268-282` (`id:'chat'`, label "Workspace", children Chat · Entity investigation · Reports) | Collapsed: `railButton` 40px, already `relative` (`NavSidebar.tsx:553-592`), with a flyout for children. Expanded: `ExpandedItem` disclosure plus `ChildLink` (243-276, 283-412). No badge or count support. |
| History rail row | `chat/workspace/HistoryRail.tsx:525-575` | Title plus a 28px relative-time box that the ⋯ menu replaces on hover. No running or unread state. |
| History strip (48px) | `HistoryRail.tsx:675-702` | New chat (disabled while busy), Search, Expand. |
| Mobile top bar | `AppShell.tsx:1355-1366` | The hamburger is the only left-side affordance on mobile. |
| Tab title | `theme.tsx:106-116` (`applyDocumentTitle`), `index.html:17` | Static "Agentic SOC", or org · product when branded. |
| Favicon | `index.html:20` (`data:,` empty), `theme.tsx:93-104`, `components/BrandingEditor.tsx:298-310` | Empty by default; branding can replace it. |
| Shell announcer | `components/announcer.tsx`, mounted by `AppShell.tsx:1244` | Chat speaks "Working" and "Answer ready" only while mounted. |
| Job precedent | `jobs/JobMonitor.tsx` (mounted at `AppShell.tsx:1252`) | A global observer plus deduplicated terminal toasts: the pattern to copy. |

The motion primitives already exist:

- `LoadingGlyph` (`design-system/loading.tsx:18-62`) is an indeterminate ring.
- Its animation runs only under `prefers-reduced-motion: no-preference`
  (`styles/theme.css:380-387`); reduced motion shows a static partial arc. Forced
  colors are handled at 390-400.
- A global reduced-motion reset sits at `theme.css:1334-1342`.
- `NavSidebar` already takes a `reducedMotion` prop (721-722, from
  `hooks/usePrefersReducedMotion.ts`).

---

## 3. Live evidence (Demo, 1440×900, dark)

Demo turns finish in about 0.6 s. Probe 2 therefore lets the server answer and then
holds the response for 9 s with `route.fetch()` before fulfilling, which reproduces a
slow real-LLM turn on the client.

- **During a turn** (`shots/diag-working-1-during-turn-chat.png`, and `-1b-` with the
  nav expanded):
  - Present: the run log "Working · No lookups yet" and the Stop button.
  - Rail: `railRowsDisabled: 6/7` and `newChatDisabled: true`.
  - Absent: `navChatHTMLHasMotion: false`, `brandHasMotion: false`,
    `activeRowHasSpinner: false`, `ariaBusy: []`.
  - The title stays "Agentic SOC".
- **Navigate away mid-turn** (`-2-away-mid-turn.png`):
  - The log shows `19.65s FAILED stream net::ERR_ABORTED`, then `19.66s NAVIGATED AWAY`.
    The client dropped the stream at once.
  - On the Overview page, the left side gives no sign that a question is still running.
- **Back while the turn is still out** (`-3-back.png`):
  - The newest thread is selected (it happened to be the one with the turn, because
    the server had already persisted it).
  - `stopButton: false`: there is no live run log and no way to Stop.
- **Case Manager chat** (`-5-case-chat-answered.png` → `-6-case-chat-after-tab-switch.png`):
  - Transcript characters went 2,517 → 0 after one Overview → Chat tab switch.
- **Side check:** Enter right after switching threads sent every time (5/5,
  `working_enter_probe.mjs`). One earlier miss was a harness artefact and is not a bug.

---

## 4. Gaps to close

- **G1.** No global "working" signal: nav, brand, rows, title and assistive technology
  all lack one.
- **G2.** Leaving the page aborts the client stream. Returning shows no live state and
  no Stop, and lands on "newest" rather than the running thread.
- **G3.** A finished background answer is invisible until a focus or visibility
  refresh. There is no toast and no unread marker.
- **G4.** The rail disables every other thread while one turn runs. This is a
  workaround for G2. The server allows 2 parallel turns per user.
- **G5.** Case chat loses its transcript and history on a tab switch or a case
  re-open, and loses an in-flight turn.
- **G6.** After a full reload, the client cannot know that a turn is still running
  server-side.

---

## 5. Design

### 5.1 `chat/activity-store.ts`: a tiny external store (eager-safe)

The store is a plain module: `subscribe`, `getSnapshot`, and mutators that replace an
immutable snapshot. It is read through `React.useSyncExternalStore`, following the
existing precedent in `hooks/useMediaQuery.ts` and `useLiveAnnouncer.ts`.

**Imports must stay at zero beyond React.** NavSidebar, AppShell and the title hook
are on the eager first-paint graph. The entry budget is under 400 kB
(`__tests__/bundle-first-paint.test.ts:119`), so the store must not import
`chat-api`, `stream-events` or `useChatEngine`.

```ts
type ChatActivityScope =
  | `conv:${string}`  // a saved Workspace thread
  | `draft:${string}` // a new thread before turn.start names its conversation_id
  | `case:${string}`; // a case-scoped chat

interface ChatActivity {
  scope: ChatActivityScope;
  kind: 'workspace' | 'case';
  conversationId: string | null;
  caseId: string | null;
  // display text only (the stream-events normaliser output), ≤ 80 chars
  title: string;
  requestKey: string;
  turnId: string | null;
  startedAt: number;
  phase: 'starting' | 'running' | 'stopping' | 'recovering' | 'done' | 'error' | 'stopped';
  // latest step label ("Searching logs"), display text only
  stepLabel: string | null;
  lookups: number;
  // settled while the analyst was not looking at it
  unseen: boolean;
}
```

The API:

- **Mutators:** `begin`, `patch`, `rekey(draft → conv)`, `settle`, `markSeen(scope)`,
  `clearAll()`.
- **Selectors:** `useChatActivity()`, `useWorkingCount()`, `useUnseenCount()` and
  `useScopeActivity(scope)`.

Two hard rules:

- **Memory only.** Never persist to localStorage: titles are prompt-derived (#9
  untrusted text).
- **Clear on logout and on user change.** Hook this into `auth.tsx` `logout` (119)
  and the 401 handler (197).

### 5.2 `chat/turn-runner.ts`: keep the stream alive across unmounts

Lift the turn loop out of the component:

- **Move into the runner:** `runTurn`, `handleEvent`, the `settle*` functions,
  recovery and Stop (`useChatEngine.ts:901-1248`, `1422-1441`).
- **Runner model:** a module-level `Map<scope, Run>`. Each `Run` holds the
  `RunState`, the `ChatLiveTurn` projection, the pending user/assistant pair, and the
  final response or failure. The runner writes progress to the activity store.
- **The engine becomes a view of its scope's run.** On send, it calls
  `runner.start(scope, request)`. While mounted, it subscribes to the run and commits
  the run's pair into `items`; the existing settle rules for history and
  persistence run on settle.
- **Unmount = `detach()`, not abort.** The `useChatEngine.ts:888-897` effect stops
  calling `abandonRun()`. Abort happens only on:
  - a forced Stop;
  - logout, a 401 or a factory reset (`runner.abortAll()`);
  - an explicit New chat discard of a draft whose turn has not started.

  The engine module lives in the lazy chat chunk, and ES modules stay cached after
  first load, so module scope survives every route change.
- **Re-attach on mount or hydration.** When the selected conversation (or case) has a
  run, the engine:
  1. hydrates the saved transcript;
  2. appends the run's pending user item plus the live assistant item;
  3. sets `busy` for this scope;
  4. offers Stop (the runner knows `turnId`) and keeps streaming.

  If the run already settled while detached, apply its result once (dedupe by
  `requestKey` against the hydrated messages), then call `markSeen`.
- **Settle while detached.** The runner:
  1. writes `phase: done | error | stopped` with `unseen: true`;
  2. posts `{type:'history-changed'}` on `HISTORY_CHANNEL`
     (`useChatConversations.ts:55`), so every open rail refreshes;
  3. updates the store, and the shell monitor turns that into the toast and the
     announcement (§5.4).
- **Selection on return.** `useChatConversations` prefers, in order:
  1. a route-requested thread;
  2. the most recent running or unseen Workspace activity;
  3. the newest thread.

  This stops "newest" hiding the running thread. A `draft:` run shows as a synthetic
  top row in Today ("<prompt title> · answering") until `turn.start` or `turn.done`
  provides the conversation id (`rekey`).
- **Parallel threads.** Once switching no longer aborts, drop the busy-disable of
  *other* rows and of New chat (`HistoryRail.tsx:390`, `448`, `544`, `683`;
  `useChatConversations.ts:664-690`). `busy` becomes per scope.
  - Keep the refusal to delete a thread whose turn is running (804-812).
  - A third concurrent send meets the existing 429 `chat_busy` handling. The
    composer can pre-empt it with "2 questions already running".
  - The existing invariants carry over unchanged: idempotency keys, D1 unsaved turns,
    Retry same key, case runs never auto-replayed (A4), `turn.done` as the truth, and
    the stale-guard semantics, now scoped by `scope` + `requestKey` instead of one
    global generation.
- **Case chat.** The runner also keeps a bounded per-case session transcript (last 20
  cases × 50 items, memory only). `CaseChat` re-hydrates from it, which fixes G5 for
  tab switches and case re-opens within the session. It also keeps model history, so
  the next case question carries its context.

### 5.3 Visual indicators

All indicators use CSS keyframes only, with no motion.dev on the eager graph, and
animate `transform` and `opacity` only. Apple-design restraint applies: one calm
ambient motion, no bounce, and a static equivalent under reduced motion.

1. **Chat nav glyph (required; this is the operator's "small icon").**
   - **Collapsed rail** (`NavSidebar.tsx:553-592`; `railButton` is already
     `relative`): add `<AgentActivityBadge>` at top-right of the 40px button. While
     working, it is a 10px ring (a mini `console-progress-ring` arc on a
     `bg-surface` knock-out). When an answer is unseen, it is a solid `bg-primary`
     8px dot.
   - **Expanded drawer:** a trailing `LoadingGlyph size="sm"` (`size-3.5`), or the
     dot, on the "Workspace" parent row and on its "Chat" `ChildLink`. Use
     `ml-auto shrink-0`; never truncate the label.
   - **Flyout:** the same glyph next to "Chat".
   - **Tooltip and accessible description:** "Workspace — agent working on 1
     question", or "— 1 new answer". Render it as a visually-hidden span via
     `aria-describedby`; the accessible name stays the label. Do not put `aria-busy`
     on a nav button.
   - **Mobile:** the same badge on the top-bar hamburger (`AppShell.tsx:1355-1366`)
     and inside the Sheet.
2. **Animated brand mark ("like Claude"; recommended, with a Settings toggle
   defaulting ON).** Wrap the 36px brand tile (`NavSidebar.tsx:804-810`):
   - **Working:** a thin conic arc orbits the tile edge (`rotate` 1.6 s linear,
     `opacity` 0.6→1) while the `Shield` "breathes" (scale 0.96↔1, 2.4 s ease-in-out).
   - **White-label logos:** animate only the ring, never the operator's `<img>`.
   - **Settled with an unseen answer:** a static ring at full opacity plus a primary
     dot.
   - **Reduced motion:** a static ring segment in `--primary` plus the dot.
   - **Forced colors:** `Highlight`.
   - **Click** does nothing new (it stays decorative, `aria-hidden`). The nav badge
     carries the accessible information.
3. **History rail row (`HistoryRail.tsx:525-575`).**
   - **Running row:** replace the 28px time box with `LoadingGlyph size-3.5`. Keep
     the ⋯ hover swap. Append ", answering" to `aria-label`.
   - **Unseen row:** a primary 6px dot before the time, and ", new answer" in the
     name.
   - **`draft:` run:** a synthetic row (above).
   - **History strip (48px):** a dot on "Show history" when a non-visible thread is
     running or unseen.
4. **Case surfaces.**
   - A glyph on the case Chat tab trigger (`pages/CaseDetail.tsx:2009-2020`), so the
     state is visible from Overview or Timeline.
   - The same glyph on the Case Manager queue row for that case.
   - The panel's own status line (`CaseChat.tsx:109-119`) reads the store, so it is
     correct after a re-mount.
5. **Tab title.** Show `● ` + base while working, and `✓ ` + base when an answer is
   unseen and the tab is hidden or the analyst is elsewhere.
   - **Implementation:** `theme.tsx:106-116` must call a shared
     `setBaseDocumentTitle()` instead of writing `document.title`. A
     `useDocumentTitleBadge()` hook in AppShell composes `prefix + base`, so a
     branding refresh never wipes the prefix and the prefix never leaks into a saved
     branding value.
   - **Clearing:** the `✓` clears on `visibilitychange` to visible while the chat for
     that scope is shown (`markSeen`).
   - **Favicon badge:** deferred. The default favicon is empty (`index.html:20`) and
     it conflicts with the branding favicon writers (`theme.tsx:93-104`,
     `BrandingEditor.tsx:298-310`). It needs canvas compositing; the title prefix is
     enough for v1.

### 5.4 Shell monitor, announcements and toasts

Add `<ChatActivityMonitor>` beside `JobMonitor` (`AppShell.tsx:1252`). It is eager,
lightweight, and reads only the store:

- **Announcements:** through `useAnnouncer()`, and only when no mounted engine owns
  the scope (`useTurnAnnouncer` keeps the mounted case):
  - "Answer ready: <title>"
  - "Stopped: <title>"
  - "Error: <title>"
  - Do not announce on start: the analyst just pressed Send.
- **Toast:** a `sonner` toast "Answer ready — <title>" with an **Open** action,
  `navigate('chat', { conversationId })` (`nav-types.ts:49-50`). Case scopes open the
  case on the Chat tab instead. Deduplicate by `requestKey`, as JobMonitor does.
- **Title prefix:** sets the prefix of §5.3 item 5.
- **Inside chat,** the transcript `role="log"` gets `aria-busy="true"` while its
  scope runs. That is valid on a log region and pairs with the existing
  `aria-live="off"` (`message/Transcript.tsx:417`).

### 5.5 Navigate-away walkthrough (target behaviour)

1. **Send.** `runner.start(conv:X)` sets the store to running. The nav glyph and the
   brand ring animate, and the title becomes "● Agentic SOC".
2. **Leave for Overview.** Chat unmounts and the engine detaches. The NDJSON read
   continues and the store tracks step labels. The nav tooltip reads "Agent working —
   Searching logs (3 lookups)".
3. **Come back while it runs.** The selection prefers X. The transcript is restored
   with the pending prompt and a live run log, and Stop works.
4. **Or it finishes while away.** The rail refreshes via the broadcast; X's row and
   the nav get the unseen dot; the toast shows "Answer ready — Open"; the title
   becomes "✓ Agentic SOC". Opening X shows the saved answer and clears the dot.
5. **Full reload mid-turn (needs the optional backend endpoint, §5.6).** The client
   stream is lost. On load, `GET /api/chat/turns` lists X as running, so the badge
   shows. The client polls every 3 s while any are listed (or reacts to an SSE
   nudge), then refreshes the list when the turn is gone.

### 5.6 Optional backend additions (additive; no schema or migration)

- **`GET /api/chat/turns`** (cases:read, owner-scoped from
  `ChatTurnRegistry.running()`, `routes_chat.py:292`). It returns `{turn_id,
  conversation_id, case_id, started_at, model, stream_mode}` with **no prompt text**.
  It is process-local, as the registry already documents. This fixes G6 and lets
  another tab show the badge.
- **Later: `GET /api/chat/turns/{turn_id}/events`** to re-attach the live run log
  after a reload. It would replace the drop-when-detached behaviour (`emit`, 184-188)
  with a bounded per-turn event ring replayed from `turn.start`, and would extend the
  contract test `chat-stream-events.contract.json`. This is not needed for the left
  indicator itself.

---

## 6. Work package sketch (sizes are rough)

| WP | Scope | Files | Tests |
|---|---|---|---|
| D4-a | activity store + selectors + logout clear | new `chat/activity-store.ts` (~120 LOC), `auth.tsx` | vitest store; bundle-first-paint stays < 400 kB |
| D4-b | turn runner; engine detach/re-attach; per-scope busy; selection preference; draft row | `chat/useChatEngine.ts`, new `chat/turn-runner.ts`, `useChatConversations.ts`, `HistoryRail.tsx`, `pages/Chat.tsx` | engine: unmount mid-turn → no abort, remount re-attaches, settles once; recovery 409 path detached; StrictMode double mount; two parallel scopes; Stop after re-attach |
| D4-c | case chat session transcript + tab glyph + queue glyph | `CaseChat.tsx`, `CaseChatPanel.tsx`, `CaseDetail.tsx`, CaseManager row | tab switch keeps transcript and history; case run never auto-replays (A4) |
| D4-d | nav badge, brand ring, strip dot, mobile hamburger dot, reduced-motion and forced-colors CSS | `NavSidebar.tsx`, `AppShell.tsx`, `styles/theme.css`, new `components/AgentActivityBadge.tsx` | render states (idle/working/unseen) × (collapsed/expanded/flyout/mobile); reduced-motion static; jest-axe |
| D4-e | `ChatActivityMonitor`: announcer, toast, title prefix (`theme.tsx` base-title setter) | `AppShell.tsx`, `theme.tsx`, new `chat/ChatActivityMonitor.tsx` (eager, store-only) | announce only when unmounted; toast dedupe; prefix survives a branding refresh |
| D4-f (opt.) | `GET /api/chat/turns` + client poll after reload | `routes_chat.py`, `chat-api.ts`, `types.ts` | pytest owner scoping (other users' turns invisible; no prompt text) |

Docs to update in the same change: SPEC §6.4 and §10.8 (a disconnect on navigation is
now a detach), §10.9 (new announcements and `aria-busy`),
`docs/development/ui-standard.md` (nav badge grammar), and the user chat docs.

## 7. Risks and open questions

- **Bundle.** Store, badge and monitor must be eager-safe. Keep them free of imports
  from chat modules; the runner stays in the lazy chunk and only *writes* to the store.
- **Privacy.** Run state holds untrusted answer text in memory. Clear it on logout,
  user switch and factory reset. Never write it to storage.
- **Over-signalling.** Show one ambient motion at a time. The brand ring and the nav
  glyph are redundant when the rail is visible, so a toggle should let the operator
  keep only the nav glyph. Only the toast is interruptive, and only for answers that
  finished while away.
- **Process-local registry.** With more than one backend replica (not supported
  today), `GET /api/chat/turns` would under-report; it matches the documented
  single-replica stance.
