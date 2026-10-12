# Round 12 SPEC: chat without limits, working indicator, Remember me, reports, Overview, Case Manager

Status: binding for every Round 12 work package. Owner: orchestrator. Branch: `claude/round12`
(PR into `Testing` at the end of the round).

Inputs (read the parts your package cites; they are the evidence base):

- Research: `research/SYNTHESIS-chat.md` (chat features, P0-1 … P0-11, P1-1 … P1-9, D-1 … D-4),
  `research/SYNTHESIS-ux.md` (Apple translation §1, Overview §2, Case Manager §3, Remember me §4,
  report downloads §5), plus the per-topic briefs in `research/` and the Apple design skill
  (`research/apple-design-SKILL.md`).
- Diagnosis (code-level, file:line): `diagnosis/limits.md`, `diagnosis/routing.md`,
  `diagnosis/layout.md`, `diagnosis/working.md`, `diagnosis/disposition.md`,
  `diagnosis/reports.md`, `diagnosis/overview.md`, `diagnosis/casemanager.md`.
- Previous chat spec: `docs/research/2026-10-chat-revamp/SPEC.md` and `BLOCKS.md` (still binding
  where this document does not override them; every override below is an amendment and must be
  recorded there as A39+ by WP-DOC).

## 1. Operator asks (this round)

1. Chat does not use the full width when the side menus are collapsed.
2. A small icon or animated logo on the left side while the agent works (like Claude).
3. No truncation, no "Continue where this stopped", no token or step limits on chat answers or
   conversations. Chat is an explicit exception.
4. More chat functionality, benchmarked against Palo Alto, Amazon, Google, Microsoft, CrowdStrike,
   SentinelOne, Qualys and Splunk.
5. Fix the UI glitches in the screenshots and the queries that do not work.
6. "Remember me" on login, with a warning; remembers the username and (via the browser) the
   password; re-authentication still required about once a day or every 6 hours.
7. Report downloads are glitchy.
8. The Overview dashboard looks clamped; clean it up without removing any data.
9. The Case Manager needs UI/UX work without losing any data.
10. The SOC analyst's bug: after closing a case as false positive the case still shows
    "Undetermined" / "Needs human review — closed".
11. Apple design language (the apple-design skill) across the work.

## 2. Decisions

- **D1 Chat limits.** `ChatAgentConfig.limits_mode: Literal["unlimited", "bounded"] = "unlimited"`.
  In `unlimited` mode the per-question caps (`max_model_calls`, `max_tool_calls`,
  `turn_token_ceiling`, `turn_timeout_s`, `final_max_tokens`, `observation_chars` as a hard cap) do
  not apply. `bounded` keeps today's behaviour and today's knobs for operators who want it. A
  one-time `chat_limits_version` migration sets stored configs to `unlimited` unless an operator
  explicitly changed a limit knob away from the shipped default (then keep `bounded` and their
  values). The Settings → General → Chat assistant editor shows the mode switch first and the
  knobs only in `bounded` mode.
- **D2 Correctness guards, not caps (unlimited mode).** The loop ends when the model writes its
  final answer or the user presses Stop. Guards that exist to end pathological loops, never to cut
  a working answer: (a) an identical `(tool, canonical params)` call is not re-executed, the model
  gets "already ran, reuse mK.aJ"; (b) three consecutive model steps that add no new artifact and
  request no new tool force one final-answer step (notice "Stopped repeating the same lookup");
  (c) a per-call stall timeout (`model_step_timeout_s` default 300 s; a stall is a failed call,
  retried once); (d) a hidden runaway fuse of 200 model calls or 60 minutes per question that,
  when reached, forces one final-answer step that synthesises what was gathered (no "Partial" chip,
  no Continue chip; a run-log row says "Wrapped up after a very long investigation"). None of these
  is a token limit.
- **D3 Output length.** Every model step requests the model's maximum output (model catalogue).
  On `finish_reason == "length"` the engine runs a continuation step through the same gateway call
  path, stitches the body, keeps streaming, and never shows a cut answer. Three continuation steps
  that add under 50 characters each end the answer with a `partial` notice (true failure only).
- **D4 Context window, not caps.** Cross-turn: a running conversation summary replaces the replay
  drop rule once replay text passes ~35% of the model context window (one gateway call,
  `surface="chat"`, purpose `compaction`; stored on the conversation; injected inside a new
  `CONVERSATION_SUMMARY` UNTRUSTED fence; taint ledger treats summary values like prior-answer
  values). Intra-turn: when the projected prompt passes ~60% of the window, older observations
  become their artifact-manifest lines and the new read-only tool `recall_observation(ref)` returns
  the stored (aggregate, fenced, shrunk) observation (#7: never raw log rows). Per-observation
  budgets scale with the context window. `/compact` forces a summary.
- **D5 Daily budget and chat (SYNTHESIS-chat D-1 option b).** Chat is not blocked by the daily AI
  budget; chat spend does not consume the pipeline budget; an optional chat daily cap exists and
  is off by default. Every chat call still goes through the one gateway and is written to the
  ledger (#6), and live cost stays visible. AGENTS.md's "the daily budget is the GLOBAL spend
  bound" sentence is updated in the same change.
- **D6 Concurrency.** Defaults rise to 4 questions per user and 16 per backend. This is a capacity
  bound, not a token limit. Over the bound the client shows "Waiting for another answer to finish"
  and retries with backoff (no queue service this round).
- **D7a TimeRange.** `models.TimeRange.MAX_SPAN_DAYS = 90` no longer applies to chat scope
  windows (WP-TOOLS lifts it for chat; other callers keep their own bounds).
- **D7 Time windows.** Every aggregate tool accepts all time, `now-N[d|w|M|y]`, calendar tokens
  (`today`, `yesterday`, `this_week`, `last_week`, `this_month`, `last_month`, `this_quarter`,
  `last_quarter`, `ytd`, `this_year`, `last_year`) and ISO ranges, resolved in the operator
  timezone (`SlaPolicy.timezone`, default UTC; labels name the zone). The 720-hour / 90-day clamps
  are removed for aggregate tools. A Scope chip still clamps a model-requested wider window; an
  "All time" chip never clamps.
- **D8 Exact aggregates.** No sampling presented as exact anywhere in chat. New
  `engine/case_aggregate.py` (push-down where possible, else a streaming fold over `export_page`
  that keeps only counters) powers the new `case_stats` tool, the counts/totals of `search_cases`,
  and the case-derived `soc_metrics` kinds. Cost uses the same pattern over the usage ledger.
  Dashboards move to the same aggregator where they currently read the 5,000-case page, so chat
  and dashboard numbers agree. A store failure mid-scan gives a `partial` notice with the counted
  share, never a smaller number presented as exact.
- **D9 Routing honesty.** `unsupported: true` in the final header is honoured only when no data
  tool ran; otherwise it becomes the new notice kind `limited` ("Answered with what chat can
  read") and `answer_kind` follows the model's own value. "Product help" is shown only for
  `product_help` answers where no data tool ran. The `unsupported` body names a console link only
  when one resolved.
- **D10 Clarify.** A new final variant `clarify: {question, options[≤4], allow_custom}`; option
  picks send `origin: "clarify"` (same taint class as `follow_up`, #9). Zero-match observations
  carry engine-built `suggestions[]` rendered as one-click chips.
- **D11 Reports from chat.** The final header may carry `report: {title, template}`; after the
  message persists, the server (never the model) creates the report from the persisted message
  through the existing server-resolved add path and returns `ChatResponse.saved_report`.
  Templates gain `executive`, `monthly`, `infographic`, `investigation_brief`. Item/leaf limits
  rise to 60. Case-scoped turns never create reports.
- **D12 Layout.** One lane, two edges (`diagnosis/layout.md` width model): prose ≤ 48rem
  left-aligned on the lane's left edge; blocks span the lane from the same edge (card text aligned
  with prose); the user bubble aligns to the lane's right edge; the composer spans the lane. Lane
  = min(conversation − 2·clamp(1rem, 2.5cqi, 2.5rem), cap) with a per-viewer width preference
  Comfortable 64rem / Wide 88rem / Full (no cap). The 24px side strips go. *Amended in the final
  review (§7.2 decision 18):* Full is the default; it was Wide 88rem.
- **D13 Working indicator.** A tiny dependency-free app-level activity store (entry chunk,
  `useSyncExternalStore`), a module-level turn runner in the lazy chat chunk (navigating away
  detaches instead of aborting; returning re-attaches), an animated chat-nav glyph (ring while
  working, accent dot unread, amber needs input, red failed) on every nav form, an optional
  animated brand ring (Settings toggle, default on; white-label logos never animated), history-row
  statuses, a tab-title prefix, a one-time "Answer ready" announcement and toast when the chat is
  not on screen. Server: `GET /api/chat/turns/active` (owner-scoped) and
  `GET /api/chat/turns/{turn_id}/events?after=<seq>` (owner-checked bounded per-turn event ring,
  then live tail). Reduced motion: static mark plus the word "Working". Process-local registry, as
  today (documented).
- **D14 Remember me (SYNTHESIS-ux §4, one design).** Persistent, server-bounded remembered session
  (admin presets 6/12/24 h, default 24 h, maximum 24 h) plus a remembered username; the password
  is remembered only by the browser's password manager (`autocomplete` attributes, a hidden
  username field in the password step, Chromium `PasswordCredential` store when available), never
  by the app. Unchecked: a non-persistent session cookie plus the existing idle and absolute
  limits. MFA and step-up are never bypassed. Warning dialog on check (warning tone, Cancel
  focused). Shown disabled with a reason when the admin turned it off or the console is on plain
  HTTP (hidden only when auth is disabled). Prerequisite: `/auth/me` becomes registry-aware and
  returns a `reason` when a session ended.
- **D15 Case outcome headline.** Once a human classifies a case, the analyst's classification is
  the headline ("Closed as false positive"), with "AI verdict: Needs human review (75%)" as a
  labelled secondary line. One shared `caseOutcome(c)` helper (gated on the classification history
  entry exactly like the backend ground-truth authority) drives the case header, Case Manager
  rows, Cases list, hover cards and grading. Every terminal path (single, bulk) captures a
  disposition. `decide()` is untouched (#3).
- **D16 Apple design (SYNTHESIS-ux §1).** Restraint through space, type and one material recipe
  for floating chrome only; tracking per size (Inter dynamic metrics); concentric radii (menus
  10px, items 6px); one spring vocabulary (critically damped default, 0.3 s; bounce only after a
  momentum release); overlays scale from their trigger; `prefers-reduced-motion`,
  `prefers-reduced-transparency`, `prefers-contrast` honoured. `docs/development/ui-standard.md`
  is amended in the same package that changes the rule.
- **D17 Not built this round** (SYNTHESIS-chat §5 plus): response actions from chat, chat verdicts
  feeding decisions, free-form NL→raw query execution, raw rows to the model, training on
  feedback, MCP, background deep-investigation Jobs (P1-2, backlog), saving charts to dashboards
  (P2-1, backlog), conversation sharing/branching/folders/scheduling (P2, backlog). Record them in
  `ROADMAP.md`.

## 3. Contracts (shared; packages implement their side exactly)

### 3.1 Backend models (`backend/app/models.py`) and web mirrors (`webui/src/lib/types.ts`)

Additive only. Names are binding:

- `TurnNoticeKind` adds `"limited"`, `"stopped_repeating"`, `"compacted"`.
- `ChatOrigin` adds `"clarify"`, `"retry_step"`.
- `ChatResponse` adds:
  - `clarify: ChatClarify | None` where `ChatClarify {question: str (≤200), options: list[str]
    (≤4, each ≤80), allow_custom: bool = True}`.
  - `saved_report: ChatSavedReport | None` where `ChatSavedReport {id: str, title: str,
    items: int}`.
  - `continued: int = 0` (continuation steps used for the final answer).
  - `compacted: bool = False` (a compaction happened in this turn).
- `ChatStep` adds `observation_ref: str | None` (owner-scoped key for the step inspector) and
  `progress: ChatStepProgress | None` (`{done: int, total: int | None, unit: str}`).
- `ChatContextInfo` adds `limits_mode: Literal["unlimited", "bounded"]` and `timezone: str`
  (the existing `context_window` drives the context-use ring).
- `ChatConversationSummary` adds `status: Literal["idle", "running", "needs_input", "failed"] =
  "idle"` and `unread: bool = False`; `ChatConversation` adds `summary_covers_through: str | None`.
- New `ChatActiveTurn {turn_id, conversation_id: str | None, case_id: str | None, started_at,
  label, lookups: int, tokens: int, status: Literal["running", "needs_input"]}`.
- New `ChatFeedbackRequest {conversation_id, message_id, rating: Literal["up", "down"],
  reason: Literal["wrong", "incomplete", "slow", "other"] | None, comment: str (≤1000)}`.
- Prompt library: the existing saved prompts (`UserPrefs.chat_prompts`, `ChatPrompt`, stored via
  `/api/prefs`, max 50) gain `category: ChatPromptCategory | None` (`triage`, `hunt`, `ioc`,
  `posture`, `reporting`, `app_help`) and `favorite: bool`; `{name}` placeholders in `text` are
  filled by the composer before sending. No new store or endpoint.
- `ReportTemplateName` adds `"executive"`, `"monthly"`, `"infographic"`, `"investigation_brief"`.
- `ChatAgentConfig` (config.py) adds `limits_mode`, `chat_daily_cap_usd: float | None = None`,
  `animated_brand: bool = True`; concurrency defaults 4 / 16; `model_step_timeout_s` default 300.
- `SessionPolicyConfig` adds `remember_me: RememberMePolicy {enabled: bool = True,
  duration_seconds: int = 86_400 (3_600..86_400), idle_seconds: int | None = None,
  excluded_roles: list[str] = [], allow_insecure_http: bool = False}`.

### 3.2 Endpoints

- `GET /api/chat/turns/active` → `list[ChatActiveTurn]` (owner-scoped; `cases:read` like chat).
- `GET /api/chat/turns/{turn_id}/events?after=<seq>` → NDJSON replay of the bounded per-turn event
  ring (text deltas coalesced) then live tail; owner-checked; 404 for others. *Amended in the PR
  #131 review:* the ring bounds its answer text as well as its entries (§7.3, "Rejoin buffer"); a
  rejoin from before dropped answer text gets one `text.reset` line in its place.
- `GET /api/chat/conversations/{id}/messages/{message_id}/steps/{index}` → the stored observation
  the model saw for that step (owner-scoped; fenced display; never raw log rows).
- `POST /api/chat/feedback` → 204; per-user KV + audit row; never used for training.
- Realtime: targeted `chat.turn` events `{turn_id, conversation_id, case_id, phase: started |
  progress | finished | failed | needs_input, label, lookups, tokens}` on the existing EventBus with
  `audience = {owner}`; `POST …/read` adds a targeted `chat.read` event `{conversation_id}`, and
  `POST /api/chat/turns/{turn_id}/seen` (204 for any well-formed id, stores nothing; the
  conversation or case is named only from the caller's own record) the same event naming a turn
  whose outcome is on screen, `{turn_id, conversation_id | case_id}` (§7.2 decision 17). When auth is disabled the client polls `turns/active` every 5 s while a turn is known to
  run.
- Remember me: `POST /api/auth/login` accepts `remember: bool = False` and returns
  `remembered: bool` plus `remember_reason` when refused (`role_excluded`, `insecure_transport`,
  `disabled`); the MFA pending token carries a signed `rm` claim. `GET /api/setup/status` adds
  `remember_me {enabled, duration_seconds, insecure_blocked}` (plus, as built,
  `idle_seconds`, `secure_cookies`, `secure_cookies_configured` and
  `standard_session_seconds`). `GET /api/auth/me` runs the
  session-registry check, clears the cookie when the session ended and returns `reason`
  (`revoked | idle_expired | absolute_expired | tv_mismatch`).
- Cases: bulk close/resolve requests accept `disposition` (required for terminal statuses in the
  UI; optional on the wire for compatibility).

### 3.3 Stream events (`webui/src/soc/chat/chat-stream-events.contract.json` + `chat_events.py`)

Add `step.progress {index, done, total?, unit}` and `text.continued {part}` (a quiet run-log row;
the text keeps streaming without `text.reset`). Remove nothing (old clients keep working).

### 3.4 Blocks (`answer-blocks.contract.json` + `blocks.py` + renderers)

Add chart kind `grouped_bar` (views `grouped_bar`, `hbar`, `table`), artifact kind `comparison`
(materialised to `kpi_group` with deltas, `grouped_bar` and a delta `table`), `allowed_rebin` on
time series (finest calendar bucket ≤ 200 points), and the Brief `layout: "infographic"`
(hero KPI row with sparklines, 2-up chart grid, highlight callouts). Δ% on a zero baseline is
"new", never ∞ or NaN.

### 3.5 Aggregation core (`backend/app/engine/case_aggregate.py`, `engine/time_windows.py`)

```python
@dataclass(frozen=True)
class ResolvedWindow:
    start: datetime | None      # None = all time
    end: datetime               # aware UTC
    label: str                  # "all time (since 3 Nov 2025)", "Q3 2026", "last 90 days"
    tz: str                     # IANA name used for calendar math
    token: str                  # the normalised input ("all", "now-90d", "last_month", ISO…)

def resolve_window(spec: str | dict | None, *, tz: str = "UTC", now: datetime | None = None,
                   default: str = "all") -> ResolvedWindow: ...
def calendar_buckets(window: ResolvedWindow, unit: Literal["hour","day","week","month",
                     "quarter","year"]) -> list[tuple[datetime, datetime, str, bool]]:
    """(start, end, label, in_progress) zero-filled, ISO weeks Monday-based, in window.tz."""
def auto_bucket(window: ResolvedWindow, max_points: int = 200) -> str: ...

@dataclass(frozen=True)
class CaseAggregateSpec:
    window: ResolvedWindow
    filters: dict[str, Any]           # the search_cases filters, incl. status_group
    group_by: tuple[str, ...] = ()    # ≤2 of verdict,status,status_group,severity,priority,rule,
                                      # assignee,source,surface,disposition,mitre_tactic,
                                      # mitre_technique,decided_by,closed_by
    bucket: str | None = None         # None|hour|day|week|month|quarter|year (created_at)
    metrics: tuple[str, ...] = ("count",)  # count,auto_closed,human_closed,fp_rate,tp_rate,
                                      # analyst_fp,mtta_p50,mtta_p90,mttr_p50,mttr_p90,
                                      # mttd_p50,mttd_p90,mean_risk,open_now
    top_n: int | None = None          # with an exact "Other" remainder

@dataclass
class AggregateResult:
    total: int
    groups: list[dict[str, Any]]      # {"key": {...}, "bucket": label|None, "metrics": {...}}
    buckets: list[tuple[str, bool]]   # (label, in_progress) in order, zero-filled
    exact: bool
    consistency: str                  # "point_in_time" | "bounded_at_start" | "unverified"
    scanned: int
    missing_created: int              # cases with no parseable created_at (own bucket, never dropped)

async def aggregate_cases(store, spec: CaseAggregateSpec, *,
                          progress: Callable[[int, int | None], Awaitable[None]] | None = None,
                          cancel: asyncio.Event | None = None) -> AggregateResult: ...
async def aggregate_usage(store, spec: UsageAggregateSpec, ...) -> AggregateResult: ...
```

Optional repository push-down: `CaseRepository.aggregate(spec) -> AggregateResult | None`
(non-abstract default returns `None`; detected like `PullConnector.aggregate`), so third-party
repositories keep working through the fold.

### 3.6 Engine ↔ routes seams (WP-ENG ↔ WP-API)

- The interface stubs `backend/app/engine/time_windows.py` and `engine/case_aggregate.py` are the
  authoritative §3.5 contract (orchestrator-written; WP-AGG fills them in).
- Conversation summary (D4): the routes layer loads the stored summary
  (`summary_text`, `summary_covers_through`) and passes it into the engine with the replay
  history; the engine returns a new summary (text + newest folded message id) in its turn outcome
  when it compacted, and the routes layer persists it on the conversation document. The engine
  never reads or writes the conversation store directly.
- Turn lifecycle: the engine reports progress through the existing event callback; WP-API's
  registry buffers the per-turn event ring for reattach and publishes `chat.turn` realtime events.
- A backend package that changes a shared contract JSON (`chat-stream-events.contract.json`,
  `answer-blocks.contract.json`) also updates the matching web enum/normaliser lists
  (`stream-events.ts`, `blocks/schema.ts`) in the same change so both contract tests stay green;
  rendering new kinds is the wave-2/3 web package's job (unknown kinds keep their safe fallback).

## 4. Work packages

Every package runs implement → independent adversarial review (two lenses) → fix → re-review →
final fix, and ends with its own tests green plus the repo gates it touches. Owned files are
exclusive during the wave; touching another package's file needs the orchestrator. Shared
contract files (`models.py`, `types.ts`, `config.py`) take additive edits only in the sections
named.

### Wave 1

- **WP-AGG Aggregation core and metrics (backend).** Owns `engine/time_windows.py` (new),
  `engine/case_aggregate.py` (new), `stores/base.py` (aggregate hooks), `stores/cases.py`,
  `stores/sql/**`, `stores/usage.py`, `es/fake.py` (calendar `date_histogram` fix),
  `engine/metrics.py`, `api/metrics_shared.py`, `api/routes_metrics.py`. Delivers §3.5; ES
  composite + `date_histogram` (`calendar_interval`, `time_zone`) push-down on aggregatable
  fields else fold; SQL `GROUP BY` over JSON docs else fold; memory fold; usage aggregate; SLA
  attainment `null` (not 0%) when nothing was evaluated; dashboards read exact aggregates instead
  of the 5,000-case page where they summarise the corpus; additive `analyst_confirmed_fp` count
  next to the AI-verdict FP rate. Acceptance: SYNTHESIS-chat P0-3/P0-4/P0-5 criteria;
  `diagnosis/limits.md` aggregation section.
- **WP-ENG Chat engine (backend).** Owns `agents/chat.py`, `agents/chat_protocol.py`,
  `agents/chat_events.py`, `config.py` (`ChatAgentConfig` only), `llm/gateway.py` (chat budget
  exemption only), the chat additions to `models.py` (§3.1 chat fields). Delivers D1–D5, D9 (engine
  side), D10 (parse), D11 (header parse + hand-off), continuation events, `recall_observation`,
  compaction (calls a conversation-summary port that WP-API implements on the store),
  `_answer_kind` fix, `limited`/`stopped_repeating`/`compacted` notices, removal of the `cap`
  notice in unlimited mode, `step.progress` plumbing. Acceptance: SYNTHESIS-chat P0-1, P0-2,
  P0-11 (engine), `diagnosis/limits.md` fixes, `diagnosis/routing.md` §5 engine items.
- **WP-TOOLS Chat tools, prompts and blocks (backend).** Owns `agents/chat_tools/**`,
  `agents/prompts.py`, `agents/blocks.py`. Delivers `case_stats` (on WP-AGG's API), all-time and
  calendar windows on every aggregate tool, buckets, comparisons (`compare`), exact counts in
  `search_cases` and the "Still open" fix, humanised window labels, zero-result `suggestions[]`,
  visible rejection of unknown inputs (no silent `extra="ignore"` drops), `cost_usage` over the
  usage aggregate, `log_stats` calendar intervals (`1w`, `1M`, `1q`, `1y`) in the bundled
  connectors' `aggregate`, the `comparison` artifact and `grouped_bar`/`allowed_rebin`/
  `infographic` materialisation, the prompt fixes (no false "24 hours" default; "lifetime" means
  all time; report recipe; answer what can be read and say what is missing; clarify instead of
  guessing when no reasonable default exists; the `clarify`/`report`/`unsupported` header rules),
  report templates. Acceptance: SYNTHESIS-chat P0-3 … P0-8 tool criteria; `diagnosis/routing.md`.
- **WP-API Chat routes, persistence and library (backend).** Owns `api/routes_chat.py`,
  `stores/chat_conversations.py`, `realtime.py` (chat.turn audience only), `api/routes_reports.py`,
  `stores/reports.py`, new `api/routes_chat_library.py` (feedback, step inspector), new
  `stores/chat_feedback.py`, the `ChatPrompt` repair in `api/routes_prefs.py` if it needs more than
  the model change. Delivers unbounded answer storage
  (full answer text always persisted; per-exchange KV documents under the existing namespace if
  needed; no new index/table), conversation summary storage for WP-ENG, turn lease heartbeat,
  concurrency defaults, `turns/active`, per-turn event ring + reattach, `chat.turn` SSE, the
  server-side report save from the header (D11), the §3.2 library endpoints, conversation
  `status`/`unread`, a temporary "answering" row for a new thread. Acceptance: SYNTHESIS-chat
  P0-1 persistence, P0-7, P0-9 backend, P1-1/P1-4/P1-8 backend.
- **WP-DS Apple design foundations (web).** Owns `webui/src/styles/theme.css`,
  `webui/tailwind.config.*`, `webui/src/ui/**`, `webui/src/design-system/**`,
  `webui/src/soc/components/KpiTile.tsx`, motion helpers, `docs/development/ui-standard.md`
  (foundation sections). Delivers SYNTHESIS-ux §1 (spacing, radii, materials, tracking, springs,
  media queries, elevation), overlay transform-origin, and KpiTile fixes used by chat, Overview
  and print: numerals never truncate, the context line wraps under the number instead of sharing
  its row, responsive tile grids never leave empty tracks, a size scale for hero numerals.
- **WP-AUTH Remember me (full stack).** Owns `backend/app/auth/**`, `stores/sessions.py`, the
  auth handlers in `api/routes.py` (`/auth/login`, `/auth/me`, MFA verify) and `api/deps.py`
  session checks, `config.py` (`SessionPolicyConfig` only), `api/routes_setup.py` status field,
  the login page, Settings → Security → Session policy editor, Account → Sessions. Delivers D14 and
  `research/remember-me.md` §4 tests.
- **WP-REP Report downloads (web).** Owns `webui/src/soc/chat/report/**`, `webui/src/lib/download.ts`,
  print/static modes of block renderers (`BlockCard.tsx`, `TableView.tsx`, `ReportView.tsx`,
  chart shells' static data tables) but not KpiTile/KpiGroupView (WP-DS / WP-CHATUI). Delivers
  SYNTHESIS-ux §5 R1–R17 and DOCX/XLSX exports generated client-side from the same export AST with
  an in-repo store-only ZIP writer (no new dependency; SYNTHESIS-chat P1-7).

### Wave 2 (after wave 1 lands)

- **WP-CHATUI Chat layout and glitches (web).** Owns `webui/src/soc/chat/message/lane.ts`,
  `workspace/**`, `message/Transcript.tsx`, `blocks/renderers/KpiGroupView.tsx`, composer meter
  files. Delivers D12, `diagnosis/layout.md` (a)–(h): frame `overflow-clip` and relative lane,
  StrictMode-safe geometry, jump pill outside the content, "Report" count only when > 0 and a
  clear name, the composer ring shows context-window use (with a tooltip) and the daily budget
  moves into the options, KPI group grid fixes, width preference.
- **WP-ACT Working indicator and reattach (web).** Owns new `webui/src/soc/chat-activity/**`
  (entry-safe store), `chat/turn-runner.ts`, `chat/useChatEngine.ts`, `chat/useChatConversations.ts`,
  `components/NavSidebar.tsx`, `AppShell.tsx` (monitor mount), `theme.tsx` (title setter),
  history rail rows, `pages/casedetail/CaseChat*.tsx`. Delivers D13 and `diagnosis/working.md`
  §5–6, including case chat keeping its transcript across tab switches.
- **WP-OV Overview redesign (web).** Owns `webui/src/soc/pages/Overview.tsx`, its sub-components
  and tests, `NoiseFunnel*`, the metric-surface section of `ui-standard.md`. Delivers
  SYNTHESIS-ux §2 and `diagnosis/overview.md` §4 with the §2.10 data inventory intact.
- **WP-CM Case Manager redesign and the analyst bug (full stack).** Owns
  `webui/src/soc/pages/CaseManager.tsx`, `CaseDetail.tsx`, `pages/casedetail/**` (except CaseChat,
  WP-ACT), `pages/Cases.tsx`, `components/CaseHoverCard.tsx`, `components/badges.tsx`,
  `ConfirmActionDialog*`, `grading.tsx`, and the backend bulk-disposition and `cases` realtime
  topic. Delivers D15, SYNTHESIS-ux §3, `diagnosis/casemanager.md` CM-1 … CM-9,
  `diagnosis/disposition.md`.
- **WP-BLK Chart and block upgrades (web).** Owns `webui/src/soc/chat/blocks/charts/**` and the
  remaining `blocks/renderers/**` (not KpiGroupView, not the print paths WP-REP changed without
  coordination). Delivers `grouped_bar`, comparison rendering, infographic layout, client re-bin,
  brush zoom, legend toggles, PNG/SVG download, expand to full width (SYNTHESIS-chat P0-8).

### Wave 3

- **WP-FEAT Message-level chat features (web).** Owns `chat/message/**` (except lane/Transcript),
  `chat/composer/**` (except meter files), `chat/empty/**`. Delivers clarify card, zero-result
  chips, removal of the Continue chip and limit "Partial" labels, run-log rows for
  continuation/compaction/progress, step inspector, feedback, prompt library UI (promptbooks with
  `{param}` inputs), "Save as report"/saved-report line, "Add to case" (human-confirmed, existing
  collaboration route), long-answer table of contents, `/compact`, `aria-busy` on the running turn,
  copy-last-answer shortcut.
- **WP-ASK "Ask AI" entity chips (web).** Chips on IP, host, user, hash, rule and case values in
  Cases, Logs and Case Manager that open chat with a server-resolved typed reference (topic
  pattern, taint rules apply).
- **WP-DEMO Demo planner and golden set (backend).** Owns `engine/demo_chat.py` and its tests.
  Every new intent (windows incl. all time and calendar periods, month/week breakdowns, case_stats,
  comparisons, report creation from "create/make … report", clarify, compaction, infographic,
  investigation brief), no write-verb misroute for "create a report", and a golden set of ≥ 120
  analyst questions (including every failing question from the screenshots) run in Demo and
  FakeProvider CI with no `unsupported` or empty answer where data exists.
- **WP-DOC Docs, generated artefacts, records.** Help Center pages (chat, reports, sign-in,
  Overview, Case Manager), SPEC/BLOCKS amendments A39+, CHANGELOG, AGENTS.md (budget sentence,
  layout, new stores/routes), ROADMAP (deferred items), DEPLOY/upgrade notes (limits migration,
  remember-me cookie behaviour change, storage form), regenerate console map, app-knowledge
  corpus, `webui/openapi.json`, `api-types.gen.ts`.

### Wave 4

Whole-round adversarial review (security and non-negotiables, backend, frontend, live-browser UX
at 390/1280/1440/1920/2560 in both themes, contracts and docs) with per-finding skeptic
verification; fixes; all gates; screenshots to the operator; PR into `Testing`.

## 5. Non-negotiables cross-check

- #1 read-only logs: no new log write path; `case_stats` reads own state only.
- #2 audit: every tool call, report save, feedback and prompt-library mutation audited.
- #3 `decide()` untouched; chat never closes or escalates; the Case Manager headline is display.
- #5 one engine; case chat stays case-scoped; Workspace history never receives case turns.
- #6 every model call (continuations, compactions, summaries) through the gateway, one UsageDoc
  each, `surface="chat"`.
- #7 aggregates only to the model; `recall_observation` returns observations, never log rows.
- #9 new fences: `CONVERSATION_SUMMARY`; clarify options and saved-report titles taint-ruled;
  forged-marker tests for each.
- RBAC per tool and per route; owner scoping for turns, events, steps, feedback, prompts, reports.

## 6. Verification

Backend full suite; webui `test:strict`, `tsc`, `eslint` (0/0), design gates, `check:types`,
knowledge `--check`, `check_docs`, `docs:check`, `check_ci_contract`, `check_version`, the CI ruff
fatal selection; `npm run build`; entry chunk within the bundle rule (the activity store is the
only new entry code); live Chromium QA with screenshots at 390/1280/1440/1920/2560 in both themes.

## 7. As built

Recorded by WP-DOC at the end of wave 3 (2026-10-11). Where this section and §2–§4
disagree, this section describes what shipped; the chat-revamp SPEC carries the
detailed amendments (A39–A63) and BLOCKS.md amendments 24–31.

### 7.1 What each package delivered

- **WP-ENG** (chat engine): `limits_mode` (default `unlimited`) with the one-time
  `chat_limits_version` migration; loop guards instead of caps (duplicate-lookup reuse, the
  three-step no-progress stop, the stall timeout with one retry, the hidden 200-call /
  60-minute fuse); automatic continuation on `length`; intra-turn observation compaction
  with `recall_observation` and the cross-turn rolling summary in a `CONVERSATION_SUMMARY`
  untrusted fence; honest `unsupported`/`limited` routing and the `_answer_kind` fix;
  clarify and report header parsing; the chat budget exemption in the gateway and the
  optional chat daily cap; `step.progress` plumbing; Stop abandons the in-flight call; the
  screen context fenced whole (diagnosis T7).
- **WP-TOOLS** (chat tools, prompts, blocks): `case_stats`; all-time and calendar windows on
  every aggregate tool, aligned to whole periods when bucketed; comparisons (`compare`,
  the `comparison` artifact); exact `search_cases` totals and the "still open" fix;
  humanised window labels; zero-result `suggestions[]`; visible refusal of unknown inputs;
  `cost_usage` over the usage aggregate; `log_stats` calendar intervals; `grouped_bar`,
  `allowed_rebin` and infographic materialisation; the routing prompt fixes; the four new
  report templates; `OUTSIDE_SELECTED_RANGE`.
- **WP-AGG** (aggregation core and metrics): `engine/time_windows.py` and
  `engine/case_aggregate.py` (ES composite + calendar `date_histogram`, SQL `GROUP BY`,
  memory and streaming-fold paths; the optional `CaseRepository.aggregate` push-down);
  usage aggregation; the case population for dashboards (exact up to 20,000 cases per
  rollup scope, newest-first, truncation marked); exact `/api/metrics` headline counts with
  `counts_exact`; SLA attainment `null` with a reason; SLA scored on the derived priority;
  `analyst_confirmed_fp`; rollups over 2,000 cases run off the event loop.
- **WP-API** (chat routes and persistence): full-text per-exchange documents, archive pages
  and windowed reads; conversation-summary storage; the 10-minute lease with a 60-second
  heartbeat; concurrency 4/16 with `retry_after`/`scope`/`limit`; `turns/active`, the
  per-turn event ring and rejoin, owner-only `chat.turn` frames bound to the account
  generation (`chat_account_unavailable`); conversation `status`/`unread` with a temporary
  running row and mark-read; reports saved from the answer header and from a conversation;
  the feedback store and routes; the step inspector over a bounded observation ring;
  `chat_request_failed` for a billed turn that ended unsaved.
- **WP-DS** (Apple design foundations): size-specific tracking, concentric radii (menus
  10 px, items 6 px, dialogs and sheets 14 px), one material for floating chrome with
  reduced-transparency, increased-contrast and in-app **Reduce transparency** fallbacks, one
  spring vocabulary, trigger-origin overlays, press feedback, reduced-motion fades, KPI
  tiles whose numerals never truncate.
- **WP-AUTH** (Remember me): server-bounded remembered sessions (6/12/24 h, default and
  maximum 24 h, capped by the absolute lifetime; the standard idle limit unless a separate
  one is set), the remembered username, browser-managed passwords (autocomplete, hidden
  username field, `PasswordCredential` where available), the warning dialog, disabled-with-
  reason states, the signed `rm` claim through MFA and SSO, a browser-session cookie for
  ordinary sign-ins, the registry-aware `/auth/me` with `reason`, the Session policy editor
  group, Remembered badges and Expires columns, and the session-lifetime table in
  `docs/operations/security.md`.
- **WP-REP** (report downloads): reliable PDF/Markdown/HTML/CSV/JSON exports, client-side
  Word and Excel from the same export AST with an in-repo ZIP writer, the flat export menu,
  Download PDF, print fixes, defang coverage, Markdown escaping.
- **WP-CHATUI** (layout and glitches): one lane, two edges; the width preference; frame
  overflow and StrictMode geometry fixes; Jump to latest outside the content; the Report
  count only when > 0; the context-window ring with the budget moved into its card; KPI
  groups on `KpiTileGrid`.
- **WP-ACT** (working indicator and rejoin): the entry-safe activity store, the turn runner
  (detach, park, rejoin, busy-wait with backoff), the chat nav glyph on every nav form, the
  optional brand ring, history-row statuses, the tab-title prefix, the "Answer ready"
  toast, case chat keeping its transcript across tab switches.
- **WP-OV** (Overview): flat titled bands, the fluid KPI strip, **AI-verdict FP rate** and
  **Response time**, one persisted Deeper analytics disclosure with a collapsed summary,
  Noise Reduction and Human vs AI refinements, the Metrics **Total cases (all time)** label,
  print CSS; the §2.10 data inventory kept (DOM inventory test).
- **WP-CM** (Case Manager and the analyst bug): `caseOutcome` (the classification
  headline, gated on the classification history entry like the backend ground-truth
  authority) across header, queue rows, Cases list, hover cards, facts rail and grading; a
  disposition on every terminal path including bulk close and resolve; the server-backed
  queue (Active/Mine/All, exact totals, `q`/`assignee`/`severity`/`verdict`, Load more, the
  `cases` realtime topic); the keyboard model; the sticky header with one primary action;
  the facts rail; de-duplicated tabs; the decision-first Investigation tab; the Close
  dialog with a sticky footer, **Close & next** and **Reopen**; focus restoration;
  agreement statistics over real comparisons only.
- **WP-BLK** (charts and blocks): `grouped_bar`, comparison tiles, calendar labels with the
  time zone and in-progress marker, Group by, zoom, legend toggles, PNG/SVG download,
  per-block Full width, the infographic Brief and the four new templates.
- **WP-DEMO** (Demo planner): every new intent (any window, breakdowns, `case_stats`,
  trends, comparisons with a direct verdict, report creation, clarify, zero-result
  follow-ups, deep investigations), the write-verb misroute fix for "create a report", and a
  230-question golden set checked against the case store.
- **WP-FEAT-A / WP-FEAT-B** (message-level features, split in two): the clarify card,
  zero-result chips, removal of the Continue chip and limit-driven "Partial" labels,
  run-log rows for continuation/compaction/progress/wrap-up, the step inspector with
  visible escapes, Retry and Explain, ratings, the saved-report line, Add to case, the
  answer contents list, Jump to end, the copy-last shortcut; the prompt library with
  promptbooks, `/compact` and `/report` templates, Save conversation as report, and the
  Settings → Chat assistant editor (mode first, bounded knobs only in Bounded, the chat
  spending limit, the animated-logo switch).
- **WP-ASK** ("Ask AI" entity chips): chips on IPs, hosts, users, hashes, domains, URLs,
  e-mail addresses, rules and case ids in Cases, Logs and Case Manager;
  `POST /api/chat/entity-question` with a strict per-kind grammar shared with the client
  through a contract table; the value fenced server-side (`entity_ref`) live and on replay.
- **WP-DOC** (this record): Help Center pages, the chat-revamp amendments, CHANGELOG,
  AGENTS.md, ROADMAP, DEPLOY and upgrade notes. Generated artefacts (console map,
  app-knowledge corpus, `webui/openapi.json`, `api-types.gen.ts`) and the final test
  counts belong to WP-GEN.
- **WP-FIX1** (doc-audit fixes: the scope chip and long conversations; chat-revamp A61):
  the scope chip's presets are **Auto** (the default, no range: no outer limit, each
  lookup keeps its own default window), **1h**, **24h** (an explicit `now-24h`, an outer
  limit like every other preset, never shown for the default), **7d**, **30d**, **90d**,
  **6mo** (`now-6M`), **12mo** (`now-12M`; a stored `now-1y` reads as 12mo) and **All
  time** (`{"from": "all"}`, never clamps), in a three-column grid every arrow key moves
  through; no custom range, because `TimeRangePicker` has none (the Help Center says to
  name dates in the question). The popover hint says what each lookup covers and names
  the exceptions (`timeRangeHint` in `chat/composer/format.ts`; the prompt's window
  table says the same): with Auto, case counts, case searches and ATT&CK coverage cover
  all time, log, metric, cost and audit lookups and the shift brief the last 24 hours;
  with a chosen range, every lookup uses it except the shift brief (at most 7 days) and
  agent improvement (its fixed periods). The chip keeps the range visible when a long
  source name truncates. Long conversations page their older messages in: the existing
  owner-scoped `GET /api/chat/conversations/{id}/messages?before=&limit=` is the cursor
  (no backend route was added), **Show earlier messages · N more** above the first
  message loads 50 at a time in full while the reader keeps their place, with a loading
  state, an error with Retry (a 404 offers **Reopen conversation** instead), and **Start
  of the conversation** at the end. A search hit or link to an older message pages back
  to it (a load already running is waited for; a failed read keeps the request, says
  so in the toast and the control alike, and Retry resumes it; a 404 offers **Reopen
  conversation** in both, and the fresh read seeks the message again; a toast action
  never acts on another conversation or a request no longer pending); a question asked in this session carries its saved id from
  the additive `ChatResponse.user_message_id`, so a hit on it never reads older history.
  Export and report methodology read the whole conversation. The retention notice no
  longer claims a 100-message cap: only a conversation an older version shortened says
  how many of its first messages were removed.

### 7.2 Decisions taken during implementation

1. **Dashboards are exact up to 20,000 cases per rollup scope** (amends D8). Only the
   store-wide counts are exact COUNT push-downs at any size and agree with chat: the
   `/api/metrics` headline counts (`total_cases`, `open_cases`, `needs_human_cases`,
   `closed_cases`, `by_status`, `by_verdict`, `by_disposition`, with `counts_exact`), the
   Open Cases stock (`open_now`), and Metrics' **Total cases (all time)**. Every window
   figure (the posture rollup's `case_count`, `severity_counts`, terminal and auto-closed
   counts and the AI-verdict FP rate behind the Overview's Total Cases, Total Critical,
   Resolved / Closed and Auto Closed tiles) and the heavier rollups (timing, verdict mix,
   ATT&CK coverage, auto-close health, agent improvement, …) read the newest-first prefix
   of their window and stop at 20,000 cases; a larger scope is analysed over its newest
   20,000 with `truncated: true`, `store_total` (cases in the scope) and `fetched` (cases
   analysed), `window_covered: false`, its counts shown as lower bounds (`≥`) and its
   rates withheld. Chat aggregates (`case_stats`, `search_cases` totals) are always exact,
   so beyond 20,000 cases in a window chat and the Overview window tiles differ.
2. **Maximum output is requested only on streaming providers** (amends D3). A blocking
   provider (Azure OpenAI, Bedrock, Vertex, entry-point clients) has a fixed read timeout,
   so it gets 4,000 output tokens per step and longer answers continue in further steps.
3. **Stop abandons the in-flight call** (amends D2 and the revamp's §6.3) in unlimited mode;
   the call is ledgered as `abandoned` with an estimated cost (#6). Bounded mode keeps
   "finish and record".
4. **No report from a stopped or failed answer** (amends D11): notice kinds `cancelled`,
   `partial`, `timeout`, `budget`, `provider` and `breaker` suppress the header's report;
   "Save as report" stays the explicit path.
5. **`OUTSIDE_SELECTED_RANGE`** (amends D7): a tool window wholly outside the scope chip is
   refused inside the turn instead of silently falling back to the chip.
6. **Bounded per-call timeout**: in bounded mode a model call gets at most the question's
   remaining time, never less than 30 s.
7. **Bounded step inspector**: observations are kept for the owner's 100 most recent answers,
   24,000 characters per step; an older answer's inspector says the result is no longer
   stored.
8. **Promptbooks storage form**: no new store or endpoint; a promptbook is a saved
   `ChatPrompt` whose id starts with `book-`, its 2–10 steps separated by a line holding
   only `---`, inside the 2,000-character text limit.
9. **Ask AI sends a server-worded question, never prefilled text.** As built, the chip
   navigates with a typed reference, the chat page resolves it with
   `POST /api/chat/entity-question` and sends the server's question with
   `origin: "starter"` (the topic pattern of "Ask about this"); nothing from the chip is
   placed in the composer, so a held Enter can never send words the analyst did not
   choose. The value is fenced as `entity_ref` in the prompt, live and on replay, and never
   counts as user-authored for indicator lookups. The command palette's free-text "Ask AI"
   only prefills a fresh composer and never sends. The same holds when such a question's
   new chat saved nothing while the analyst was elsewhere: the toast's "Ask again" sends
   it again with its own origin and topic (`NavOpts.resend`, in memory only) and only an
   `origin: "user"` question is ever put back in a composer; "Save prompt" is offered
   only for `origin: "user"` turns (the ↑-recall rule). (The WP-ASK commit message
   describes a prefilled, unsent question; the code and its tests send the server-worded
   question.)
10. **Chat summary inside the conversation store**: the engine never touches the store; the
    route passes the summary in and persists the new one from the turn outcome.
11. **Report summaries stay inside the daily AI budget** (D5 scope): only `surface="chat"`
    calls are exempt.
12. **`max_parallel` is limited to `max_tool_calls` in bounded mode at run time only**, so a
    Bounded → Unlimited → Bounded round trip never loses the operator's value.
13. **Case outcome gate**: a disposition counts as the analyst's classification only with
    `decision_by == "analyst"` and an explicit classification history entry
    (`set_disposition`/`confirm_fp`, or a close/resolve stamped `classified_disposition`
    by `disposition_declared: true`); the disposition picker starts empty. The analyst's
    explicit classification always wins (final review): `confirm_fp` records the
    false-positive class itself (it replaces a model-mapped `true_positive` or any earlier
    value, keeps `benign`, and stamps `classified_disposition`), and an undeclared
    disposition on `close`/`resolve` never replaces a classification the case still
    carries (`analyst_outcomes.standing_analyst_disposition`). Older records are not
    rewritten.
14. **Reopen, not Undo**: the eight-second action after a close is the existing `reopen`
    verb, and the recorded classification stays on file until the case is closed again.
15. **The scope chip's default reads Auto, not 24h** (amends D7; WP-FIX1). No range is
    not the last 24 hours: case counts, case searches and ATT&CK coverage cover all time
    without a window. The default is the **Auto** preset (the chip's accessible name
    starts with what it shows, "Scope: All sources · Auto (default windows, no outer
    limit)…", so a speech-input user can say what they see), and **24h** is a separate
    explicit `now-24h` outer limit, so the two never look the same and Auto can always be
    chosen again.
16. **`ChatResponse.user_message_id`** (additive to §3.1; WP-FIX1): a saved answer names
    the persisted id of its question (the message before it), live, on a completed-key
    replay and from `/chat`; it is never stored on the answer. The live transcript gives
    it to the question, so a search hit or link to a question asked in this session is
    found on screen without paging the conversation's older history.
17. **`chat.turn` frames ride the shell's job stream** (§3.2, D13; final review). The
    console asks for topic `chat` on the job observer's existing stream
    (`GET /api/events?topics=chat,jobs`, `JobMonitor`), so no connection is added, and
    relays every frame through the entry-safe store (`relayChatFrame`, with the `chat.read`
    channel; its entry cost is recorded in §7.3 "Entry bundle") to the lazy `ActivityEffects`. A frame
    is a nudge: a turn this tab does not know is
    looked up in `turns/active` and followed by the runner (nav glyph, brand ring, tab
    title, history rail and the open thread pick it up); a parked run takes a frame's
    step label and is woken by its end (`wakeParkedRun`) to read the outcome from the
    ring; a turn that ended before it could be followed sends the conversation list to be
    read for its mark, and an answer or question the list marks gets the same "Answer
    ready" or "A question needs your input" toast as a followed turn (a failure is marked
    only). While a Workspace question this browser sent has no turn id yet,
    no other Workspace turn is followed until it is named, so a tab never follows its own
    question twice. An answer read on one console is news on no other: `POST …/read` also
    publishes an owner-only, unretained `chat.read` frame `{conversation_id}` on topic
    `chat`, and the other consoles drop that conversation's mark and toast, plus any mark
    for it already on its way (a followed run that ends, a list read before the read),
    with no toast, until a new turn's frame arrives there (30 s at most; an `overflow`
    ends every such hold). Case chat and failed turns keep no stored unread state, so a
    console that shows a turn's outcome (it settles in view, its mark is looked at, or a
    case chat lists its answer: a Case Manager chat posts for every answer in its
    transcript) posts `POST /api/chat/turns/{turn_id}/seen` once per turn (signed in only);
    the route stores nothing and publishes the same owner-only `chat.read` frame naming
    the turn, for any well-formed id (closing review: a look after the 5-minute recent-turn
    window used to be a silent 404), with `conversation_id` or `case_id` added only from
    the caller's own record while the server keeps the finished turn. The other consoles
    drop exactly that turn's mark and toast whenever it lands, never another turn's in
    the same chat (closing review: a case chat's newer settled mark used to go too). A turn a console only follows (it did not start it)
    waits a short grace before it marks or announces anything (`FRAME_TIMING.followGraceMs`,
    2.5 s, still shown as running), so the asking console's "seen" lands first and no
    "Answer ready" flashes on a console nobody is reading. Polling stays the fallback (on
    load, on becoming visible, after an `overflow`, and the 5 s park poll); with
    authentication off no frame is sent, nothing is posted, and nothing waits.
18. **Full width is the default conversation width** (amends D12; final review,
    orchestrator decision on operator ask 1). With Wide 88rem as the default the lane was
    1,408 px and centred at 1920 and 2560 px with every rail collapsed, leaving 200 to 520 px
    empty on each side, which did not meet "use the full screen when the side menus are
    collapsed". `DEFAULT_LANE_WIDTH` is now `full` (no cap): the lane fills the conversation
    minus its gutters. Comfortable 64rem and Wide 88rem stay explicit choices in the thread ⋯
    menu → **Width**, whose Full width entry says "(default)"; a choice already stored (local
    mirror or `UserPrefs.misc.chat_lane_width`) is kept, so only viewers who never chose get
    the new default. Prose, notices and the run log keep their 48rem measure on the lane's
    left edge; framed blocks, the composer, follow-ups and the user bubble reach the right
    edge. Measured live (both themes; nav and history rail collapsed / expanded): 1440 →
    lane 1242 / 869, 1920 → 1708 / 1325, 2560 → 2348 / 1956; prose, card text and the
    composer share one left edge, card text, the composer and the user bubble one right edge,
    no horizontal overflow, and Jump to latest stays centred on the lane 12 px above the
    composer. A block's own **Full width** toggle is then offered only under Comfortable or
    Wide, where there is room to gain. Line chart end labels follow the wider lane: they take
    what the longest label needs up to a quarter of the chart (never fewer than 14
    characters) instead of a fixed 14 (chat-revamp BLOCKS amendment 31).
19. **A clarifying question is news only until it is seen** (amends D13; final review). The
    nav glyph and its text, the Case Manager glyph and the landing choice count a
    `needs_input` question only while the analyst has not looked at it (the activity entry's
    `seen`, the server's `unread`). A question opened and left unanswered keeps **Needs
    input** on its history row (and its activity entry, so an answer elsewhere still drops
    it), but no longer marks Chat amber on every page, and a fresh visit to Chat opens the
    newest conversation instead of that thread: `preferredThread` is running → unread (an
    answer, or a question not yet seen) → newest.
20. **"Add to case" names a clarify pick by the question it answered** (final review). A
    pick sends only the option's label ("Cases"), so the case comment quoted "Question:
    Cases". The snapshot now quotes the clarified question plus the pick, "Show me the trend
    → Cases" (`questionsInContext`, chained across clarifies; the clarify card's own question
    stands in when the clarified question is not on screen). Words typed after "Something
    else…" are quoted as asked, since they cannot be told from a new question. A run-log
    step question keeps quoting the question exactly as sent, because the model and the Demo
    planner find the answer by matching that quote against the conversation.
21. **A `/compact` reply is a command note, not an answer** (additive to §3.1 and D4; final
    review). `ChatResponse.command` (`"compact"`, lenient, `None` otherwise) marks it. Its
    `usage` is always present: the summary call's real totals when one ran (#6, one
    UsageDoc), otherwise a zero `TurnUsage` (Demo Mode, nothing to summarise, bounded, an
    unsaved or case conversation, the chat cap reached), so it reads "No model call · $0"
    instead of the legacy "Usage not recorded". The route stamps no `effective_source_*` on
    it (live, stored, or completed-key replay) and leaves the conversation's source as it
    was. The console renders it as one quiet note (`CommandNote`: the server's sentence and
    the cost) with no run log, meta row, source or answer actions. A command exchange is
    never replayed to the model, folded into a later summary (a second `/compact` with
    nothing new says "Everything earlier in this conversation is already summarised."),
    kept in client history, or saved by "Save conversation as report"; it is dropped after
    `drop_summarised` so a summary that covers through one still finds its place.

22. **A chat turn runs only while its authority lasts** (amends §3.2, D13; final review L1). The
    turn records the session, token version, access-token expiry, account generation and
    grants it was admitted with; the session identity is read before admission awaits
    anything, without the expiry comparison (`require_auth` has just verified the token), so
    a token that expires while the turn is being admitted still binds it to its sign-in
    (closing review). `routes_chat.turn_authority_lost` re-checks them before every model
    step and lookup batch. Sign-out, revoke, sign out everywhere, account disable/delete and
    role changes stop matching turns at once (`stop_chat_turns_for`,
    `recheck_chat_turns_for`); a refresh rebinds them. A stopped turn saves nothing: stream
    `turn.error` (internal, not retryable), blocking `401 session_invalid` (reason
    `session_ended`) or `403 chat_access_changed`.
23. **Remember me off or a role excluded never lengthens a session** (amends D14): the row is
    judged as a standard sign-in, also capped at `AUTH_TOKEN_HOURS` from `created_at`; a
    stricter `remember_me.idle_seconds` keeps applying.
24. **Deleting an account deletes its chat material** (amends chat-revamp §9.1 / A23(i)):
    conversations and every auxiliary document, request receipts, the step-observation ring,
    live state, answer ratings and reports (`purge_user_side_state`).
25. **`ReportListEntry.source_conversation_id`** (additive to §3.1): the one conversation all
    of a report's items name, else the draft's; derived at write time, never stored on the
    report.
26. **The router tells its own hash echo from a traversal** (closing review). It records the
    hash it writes and treats only that `hashchange` (matched by the event's `newURL`) as the
    echo of its navigate, which changes nothing. Any other same-page change (Back/Forward, a
    typed or pasted link, even to the hash it wrote earlier) is reconciled key by key
    (`samePageOpts(…, traversal)`): durable in-memory filters stay, the one-shot requests
    (`newChat`, `ask`, `topic`, `entity`, `resend`) go, so Forward never asks or sends a
    question again, and a hash that names a key the page owns yields a new opts object, so
    a pasted link to the conversation the opts still name (Chat cleared its link with
    `replaceState`) is applied.
27. **Severity, verdict, status and priority breakdowns keep their canonical order**
    (final polish; amends chat-revamp §7.3 "descending total"). A breakdown by severity
    reads Critical, High, Medium, Low, Info; by verdict True positive, False positive,
    Needs human; by status the lifecycle (New … Closed); by priority P1 … P4, in every
    chart, legend, table, comparison, export and report, whatever each value's volume
    (`stats.CANONICAL_ORDER`). When a `top_n` or the series bound applies, the busiest
    values are kept and then shown in that order (`blocks._busiest_kept`: categories by
    value, series by total, "Other" last and kept only under the series bound), so "Top 2
    of 4" of Critical 5, High 6, Medium 2, Low 35 shows High and Low. A severity or verdict series carries its
    palette key (`series[].semantic`, already in the block contract), so Critical is drawn
    in the critical colour, never a categorical green; a case with no verdict is
    `undetermined` (the neutral ink). Status series carry none: that axis shares a colour
    between states (resolved and closed, awaiting analyst and on hold). Artifact data marks
    a canonical order with `ordered: true`, which materialisation keeps, and a stored block
    re-rendered in another view keeps its order. The web renderer uses semantic colours
    for a chart only when every series but "Other" is semantic and no two share a colour;
    otherwise the whole chart keeps the categorical palette. No contract or schema change.
28. **One start per window in an answer** (final polish; amends `align_window` and P0-5's
    "N whole periods of the breakdown"). The start of a relative window depends on the
    window alone, never on how one lookup breaks it down (`time_windows.align_whole_periods`,
    `common.whole_periods`): a span of days or weeks of two days or more counts whole days
    from local midnight ("last 90 days (since 15 Jul 2026)", today and the 89 days before
    it), a span of months or years of two months or more counts whole months ("last 6 months
    (since May 2026)"); a span of hours, a single day or month, minutes, calendar periods,
    ranges and all time are counted exactly as resolved. Every case, metric and cost lookup
    applies it, bucketed or not: `case_stats` (headline, groups, series), `soc_metrics`
    posture, trends, case mix, timing, noise funnel, MITRE coverage and feedback (their
    page cohorts from the exact start, the hourly alert counters from the hour it falls
    in), `cost_usage` and `search_cases`, so the headline, the series, the severity and rule
    breakdowns, the posture tiles and the funnel of one answer count the same cases under
    one stated start and compare with one previous period. That period is the same number
    of whole days or months just before the start, adjacent to the window with no gap
    between them (`[start - N periods, start)`, `periods._aligned_previous`), named by its
    span and its dates at the window's own granularity: "last 90 days (since 15 Jul 2026)"
    is compared with "previous 90 days (16 Apr to 14 Jul 2026)" and "last 6 months (since
    May 2026)" with "previous 6 months (Nov 2025 to Apr 2026)". Polish round 2 replaced the
    earlier rule (the same span cut at the time of day of the question, "16 Apr – 14 Jul
    2026 10:34"), which left 14 Jul 10:34 to 15 Jul 00:00 in neither window and named a
    time of day on one side only. Both bounds are local midnights or month starts in the
    operator timezone, so a clock change makes the 90 days an hour longer or shorter,
    never off midnight. A rolling window that ends now is not a period in progress
    (polish round 3, tour 3 shot 09, which said two 90-day windows compared "a partial
    period"): it is noted as comparing a partial period only when it is materially
    shorter than the period before it, by more than a day or one per cent of that period,
    whichever is larger, the day never counting for more than a tenth of a short period
    (`periods._materially_shorter`). "Last 90 days" asked in the afternoon (hours short of
    90 whole days) and "last 7 days" after mid-morning compare like for like with no note;
    "last 6 months (since May 2026)" in mid October and "last 2 days" just after midnight
    are partial. A calendar period still in progress ("Oct 2026 to date", "today") is
    like for like against the same elapsed time ("2025 to date" against "2024 to date",
    "Q1 2026 to date" against "Q4 2025 to date") even when 29 Feb or a clock change makes
    one span a day or an hour longer, and says so; against an explicit complete period it
    is partial when more than one per cent shorter (`periods.in_progress_note`). A rolling
    window against the same window a year earlier is like for like with no note. The
    narration names each period with its dates once and plainly after ("Cases: 83 in the
    last 90 days vs 0 in the previous 90 days (16 Apr to 14 Jul 2026; new)" when the
    summary opened with "83 cases in the last 90 days (since 15 Jul 2026)"; the same in
    the report, AI spend and compare answers, whose "There is no direction to report"
    line names the period plainly, "in the previous 90 days", before the headline dates
    it; a compared period always keeps its article, "in the same 24 hours a year
    earlier"), and says the
    rows the earlier period has no figure for in one sentence ("False-positive and
    true-positive rates were not measured in the previous 90 days, so there is no change
    to show", `demo_chat._say_unmeasured`); the agent prompt's style rules ask a real model
    for the same. The narration reads "vs 0 in the previous 90
    days (16 Apr to 14 Jul 2026; new)", the KPI change "vs previous 90 days (16 Apr to 14
    Jul 2026)", which a narrow tile wraps between dates, never inside one
    (`KpiTile.keepDatesTogether`). A tile's context keeps the whole dated name and its
    figures ("previous 90 days (16 Apr to 14 Jul 2026): 30 min · -33.3% · n < 20"): a KPI
    context has its own 100-character limit (`MAX_KPI_CONTEXT`, `kpi_context` in the
    blocks contract; BLOCKS.md amendment 29), so an export's Context column and the report
    digest never cut a date. A name that ends in its dates is never followed by a second
    bracket: the compare answer's headline states its method as a sentence ("**Last 90
    days (since 15 Jul 2026) compared with the previous 90 days (16 Apr to 14 Jul
    2026)**. Changes are computed exactly over every case:"), and outside UTC the
    comparison caption names the zone inside those dates ("… vs previous 90 days (16 Apr
    to 14 Jul 2026, Asia/Kolkata)"). A performance report's summary ends with the
    comparison's note when it has one, so a report over "last 6 months" in mid month says
    the change compares a partial period. A breakdown whose periods the start is not
    a boundary of opens with the part of its first period inside the window ("Jul 2026 (from
    15 Jul)", "W38 2026 (from 15 Sep)", "Q4 2025 (from 1 Nov)"), so "last 12 months" by
    quarter is twelve months in five bars rather than nine and a half in four, and "last 24
    hours" by hour is 25 bars, the first cut at the minute the window starts.
    `auto_close_health` and `agent_improvement` compare fixed spans and keep the window as
    resolved; the log tools align only calendar intervals, as before.
29. **A report states each window once** (final polish). An item scope and the report
    header merge the labels one answer gives one window: "all time (since 28 Sep 2026)",
    "all time" and "all time (since 12 Oct 2026)" read "all time (since 28 Sep 2026)", from
    the earliest data; "last 90 days" with "last 90 days (since 15 Jul 2026)" reads the
    dated one; two different starts of one relative window keep the shared phrase only; a
    comparison of a window that is also stated reads inside it, "last 90 days (since 15 Jul
    2026), compared with the previous 90 days (16 Apr to 14 Jul 2026)", never the phrase
    twice (`routes_reports._merge_windows`, mirrored on read by `chat/report/windows.ts` so
    reports saved earlier read the same; a period named "previous …" or "same …" takes
    "the" there, and reports saved with the earlier "16 Apr – 14 Jul 2026 08:02" keep it).
30. **A storyline case can be Critical with a low risk score, by design** (final polish,
    demo data). Severity is the source's own rating; risk is the deterministic cluster
    score of `engine/risk.py` (volume, velocity, reputation, diversity, asset criticality),
    two separate axes that the console names side by side. A Demo Mode storyline alert is
    one native detection per source (count 1, one rule, no velocity), Demo Mode runs with
    external enrichment off and the storyline indicators are documentation addresses the
    enrichment tool skips, so reputation and asset context are 0: the formula gives about
    7 (the syslog burst of four events about 33). That is what the product computes for one
    uncorroborated native alert, so the demo seed keeps it rather than inventing inputs;
    `risk.py` and `decide()` are unchanged (#3). The seeded history cases carry the risk of
    their templates (for example 64 for a high identity case), which is why the two sit
    side by side in the queue.
31. **The top bar compacts by its own width; one chip says "Demo mode"** (final polish,
    shell). The bar is a size container (`@container/topbar`, `TOP_BAR_TIERS`): the
    current page name has priority and never wraps or squeezes on a desktop bar (it took
    "A... / W..." at 1440 with the rail pinned); the search field shrinks first and is an
    icon below 46rem of bar; chips go icon-only below 62rem with a tooltip and their full
    accessible name; the product name leaves the breadcrumb below 72rem; below 40rem
    appearance, the account menu and a source notice move into the Console controls sheet,
    while the notification bell stays in the bar at every desktop width (its unread, jobs
    and health marks showed nowhere when it moved). Width tiers cannot know which chips
    are present (a source notice, "Enable updates", a store outage and a long name squeezed
    the field to 26px at 1280 with the rail pinned), so the bar also measures itself
    (`useTopBarFold`): while the field would get under 11rem, labels fold one at a time,
    product name, account name, source, update, health, Demo mode, and the field reads by
    its own width (full placeholder from 19rem, "Search…" from 9.5rem, else its icon).
    While demo mutes platform health, the health pill leaves the bar (it
    used to read "Demo mode" beside the demo chip) and the demo chip's popover says health
    checks are muted and is the one polite announcer. ui-standard "Navigation".
32. **The material hides what is beneath with its fill** (final polish; amends
    SYNTHESIS-ux §1.4 rule 1, "≥ 0.80"). The bars and the top bar are 0.97 (thick panes
    0.98) in every engine, the scroll-edge fade starts at the same 0.97, and the
    'command' material pack's glass is 0.94: in Chromium the backdrop blur does not reach
    routed content, so at 0.80 chart labels and card text read through the sticky
    Overview header. Text beneath now differs from the bar by at most about 1.07:1 in both
    themes (measured in `foundations.test.ts`). Reduce transparency stays fully opaque.
    Polish round 2 found the cause of the missing blur: the route wrapper's entrance fade
    filled `both`, and a finished filling opacity animation is a backdrop root, so on first
    load the band blurred nothing and a 1.06:1 ghost of the page still showed. Entrances
    now fill `backwards` (`material-gate.test.ts`), the band blurs again, and while a sticky
    `PageHeader` is pinned it sets the document's `scroll-padding-top` to the top bar, its
    measured height and its fade, so keyboard focus (Shift+Tab onto a 24px help button) and
    the page's headings land below it, never under it (WCAG 2.4.11).
33. **A KPI change reads as a one-line chip plus words** (final polish, chat blocks). The
    chip holds only the signed figure ("+87", "no change") and never wraps; the comparison
    ("vs previous 90 days") is plain muted text beside it that drops under the numeral and
    wraps between words on a narrow tile (`KpiDelta.period`). The words and the export's
    text are unchanged; the chip's accessible name still carries both.
34. **A tag is never added on the analyst's behalf, and never cut** (final polish, Case
    Manager). The shared `TagInput` adds a chip only on Enter or a comma: blur no longer
    commits, and typed text that is not added stays in the field with "Not added yet. Press
    Enter to add it." A form that would lose it on submit (the close dialog, Memory,
    Knowledge and threat-intel imports) stops and asks instead ("…, or clear the field"),
    rather than saving it silently or dropping it. A case tag over 40 characters is refused
    where it is typed (close dialog, header tag editor, both bulk tag forms, rule
    automation tags) with "This is longer than 40 characters. Shorten it to add it.", and
    the server answers 422 for a new one on `/cases/{id}/tags` and an action's `tags`
    instead of storing it cut to 40 (`_merge_case_tags`; a tag the case already carries
    passes unchanged). The bulk tag job already refused over-long tags. The 25-tag count
    is kept the same way: new tags past it answer 422 with the reason ("A case can hold
    up to 25 tags, and this would give it 27. …") instead of being left off silently,
    so the bulk tag job fails a full case's item with that reason; the close dialog stops
    Tags at the room the case has left and the header tag editor says when a case is
    full. Case automation's `tag` action reads the Rule editor's `tags` list (it read
    only `tag`/`value`, so editor rules never tagged) and records a tag it could not add,
    whole, instead of cutting it. One module holds both bounds for every writer
    (`engine/case_tags.py`, mirrored by `webui/src/lib/tags.ts`). The field also keeps
    its message in view: a blocked Close scrolls the whole Tags field into the dialog's
    scroll area (at 1440x900 the message sat below it, so Close looked like it did
    nothing), as does typing that makes a hint or refusal appear (`focusTagInput`).
35. **The noise reduction flow is drawn only where its measured labels fit, and a few
    buckets draw a narrower chart** (polish round 3, tour 3 shots 17, 03 and 20). At 768px
    with the nav collapsed the Overview column was 656px, just over the flow's old 38rem
    container query, so the full flow was drawn (letterboxed from a 720px floor) and "Not
    analyst-closed · 10 · 83%" sat on the Escalated node with both right-hand labels hiding
    the escalated ribbons. The panel width, the band height and every label (one line and
    two lines) are now measured by an invisible, `aria-hidden` probe whose text is generated
    content, and `placeFlowLabels` (`noise-flow-labels.ts`) places them: one line first; the
    labels a collision names switch to name over count and share (the right-hand column
    first, a column together); labels sharing a column are spread clear of each other and
    of a label beside them; nothing may touch another label or a node marker, and a run of
    at least 32px of the ribbons a left-hand label sits on stays visible. When that still
    collides the stage rail replaces the graph; before anything has measured the container
    query stands in. The drawing is as wide as its box, never letterboxed. Verified at
    640/656/700/768/900/1024/1280px containers in both themes with no overlap. The
    re-verify found two gaps, both fixed. Full screen measured while its dialog's opening
    animation still scaled it to 95%, so a 1,332px panel drew a 1,266px letterboxed flow
    and labels sat on their node markers; every flow measurement now reads layout sizes
    (`offsetWidth`, `offsetHeight`, the probe's label boxes divided by the panel's paint
    scale). And with analyst-policy closes, "Closed by analyst policy" right of its node lay
    across the escalated ribbons while placement reported a fit: a ribbon that crosses a
    label column now bounds that column like a placed label (the decision labels spread
    above the escalated ribbons), and every case-flow ribbon must keep a 32px stretch no
    label covers, or the covering label stacks and, failing that, the rail replaces the
    graph. Chat column
    charts cap a bucket's slot at six times its marks (`barPlotFrame`), so two months on an
    1,808px lane draw a 264px plot centred in the card instead of two bars 850px apart;
    many-bucket charts are unchanged and the image export does the same. The Session policy
    editor states what AUTH_COOKIE_SECURE actually is ("AUTH_COOKIE_SECURE=false" or "is not
    set, and it defaults to false") from a new public boolean,
    `remember_me.secure_cookies_configured` on `GET /api/setup/status`.

### 7.3 Known limitations

- **Process-local turn registry.** Running turns, their rejoin rings, Stop and the
  questions-at-once bounds live in one backend process; a restart ends running answers and a
  second replica would not see them (single replica, as before).
- **Rejoin buffer keeps the newest answer text** (PR #131 review). Consecutive text deltas are
  coalesced into text entries, so the 2,000-entry bound (`TURN_RING_MAX_ENTRIES`) alone did not
  bound an unlimited answer's text, and a finished turn's ring is kept 5 minutes. The ring now
  also holds at most `TURN_RING_MAX_TEXT_CHARS` (1,000,000) characters in at most
  `TURN_RING_MAX_TEXT_DELTAS` (250,000) deltas, about 250,000 tokens, far beyond any one answer
  (`backend/app/api/routes_chat.py`). Past either bound the OLDEST text is dropped, one sixteenth
  of a bound at a time (a text entry closes at that size, so the seq bookkeeping of every kept
  entry stays exact). A rejoin `after` a line before the dropped text gets one `text.reset`
  tagged with the last dropped seq, in seq order, then the kept text: the live text restarts
  from the kept part rather than being joined across the hole, and `turn.done` still carries the
  whole saved answer. A rejoin at or past that seq resumes exactly; a reader that keeps up never
  sees the reset. The same applies when the 2,000-entry bound drops answer text or a
  `text.reset`; dropped step or usage lines stay simply absent, as before. Worst case per ring:
  1,000,000 characters of text, which is 1 to 4 MB in memory (CPython stores a string at 1, 2
  or 4 bytes per character, depending on the widest character in it), plus about 1 MB of seq
  markers. A finished turn kept for rejoin also keeps its terminal `turn.done`, which carries
  the whole saved answer (the same object as the turn handle's response) until
  `RECENT_TURN_TTL_S` (5 minutes); that answer is not bounded by the ring.
- **The compaction summary is not shown.** No route returns the summary text; the run log
  only says that earlier messages were summarised.
- **Demo bulk actions are unavailable.** Bulk case changes run as background jobs, which
  Demo Mode does not run.
- **Single replica** for everything else that was already process-local (see
  `docs/releases/known-limitations.md`).
- **Case Manager chat keeps no running summary.** The D4 summary is made only when the
  route will store it (a saved Workspace conversation in unlimited mode,
  `can_store_summary`); case chat, an unsaved conversation and bounded mode replay only
  their newest exchanges (unlimited: the fold plan's oldest exchanges are dropped
  without a notice; bounded: `select_replay`). The composer's context note ("Long
  conversations are summarised automatically near the limit … There is no hard cap",
  `contextNote` in `chat/composer/format.ts`) is shown in case chat and in an unsaved
  conversation too, and overstates it there. The Help Center and
  `docs/releases/known-limitations.md` describe the real behaviour; the copy fix (show
  the note only where a summary is stored, otherwise say that only the newest exchanges
  that fit are sent) is a ROADMAP G item.
- **Rollback** to an earlier image shows each message's compact inline copy (answers over
  24,000 characters end there; archived messages are not shown) and ignores the chat
  limits mode and spending limit.
- **Entry bundle.** The round's features grew the first-paint entry chunk from
  392,879 B at the round's branch point (`6769207`) to 399,967 B: +7,088 B, 33 B under
  the 400,000-byte ceiling. Measured sources: Remember me in the Login page, `auth` and the
  api client (WP-AUTH, about 2.8 kB); the per-viewer preference writes (`patchMisc`,
  reduced transparency) in `prefs.tsx` and the chat activity glyph in `NavSidebar.tsx`
  (about 2.6 kB); the chat activity store with its glyph and tab title (WP-ACT, about
  0.8 kB, the only new entry code §6 planned); and the design foundations (WP-DS: the ui
  recipes, `design-system/transparency.ts`, overlay origins, about 0.9 kB net). The turn
  runner, chat views and charts stay lazy. WP-GEN-A then moved code that first paint
  never needs out of the entry, keeping every feature: the command palette body
  (`CommandPalette`, cmdk, `ui/command`, about 20 kB) is a fail-soft lazy chunk that
  AppShell mounts on the first Cmd/Ctrl-K or search click (its chunks are prefetched into
  the browser cache when the browser is idle, never imported early, so a failed warm
  cannot leave search, Chat or Settings unable to load); the Settings section metadata
  (`settings-sections-meta` and `settings-dirty`, about 15.5 kB) left with it once the
  shell's unsaved-changes hook
  took `deepEqual` from the dependency-free `lib/deep-equal.ts`; and the shell's two Blob
  downloads (job artifacts, MFA recovery codes) share `lib/download-blob.ts` (+223 B).
  Measured with `npm run build:app`, the entry is **365,547 B**, 34,420 B less than
  before that pass. That measurement is the rebased baseline,
  `PRE_REVAMP_ENTRY_BYTES = 365_547` in
  `webui/src/soc/__tests__/bundle-first-paint.test.ts`; later work keeps the +1,024-byte
  budget over it (chat-revamp SPEC A59 points here).
  The final review's first-paint fixes then took the entry to 367,234 B, 663 B over that
  budget (98078d4 re-measured 366,517 B the same way): the router's same-page hash
  reconciliation (`samePageOpts`, +788 B), which lets Back leave a report and runs
  synchronously on every hash change of the eager router, so it cannot be lazy; and the
  `chat.read` relay (+124 B). Reading `optsFromHash` from the router's one `hashKeys` table
  instead of its own per-key copy saved 397 B. The measured 366,837 B is the rebased
  baseline (`PRE_REVAMP_ENTRY_BYTES = 366_837`), with the same +1,024-byte budget over it.
  The closing review's fixes then took the entry to 367,201 B (+364 B, measured with
  `npm run build`, inside that budget; the baseline was not rebased): the router telling its
  own hash echo from a traversal (§7.2 decision 26), which must run on every hash change of
  the eager router, and `showChatTurns`, the entry-safe store's signal for every answer a
  case chat lists (§7.2 decision 17).
  The final polish's top bar (§7.2 decision 31) then rebased the baseline twice, each time
  by exactly the bar's own first-paint bytes, measured by building the same tree with and
  without the change (`vite build`): +1,428 B for the bar's container tiers (AppShell.tsx
  +958 B, DemoIndicator.tsx +439 B, SystemUpdateControl.tsx +31 B), then +2,738 B for the
  measured label fold (`top-bar-fold.ts`) and the search field's own-width tiers. The bar
  is the first thing every page paints and the fold decides before that paint (a lazy
  chunk would paint the overflowing bar first), so neither can be a lazy chunk. The
  rebased baseline is `PRE_REVAMP_ENTRY_BYTES = 371_003` (371,003 B), with the same
  +1,024-byte budget over it. The polish gate run measured 371,445 B with `npm run build`
  (371,491 B with CI's commit and build-time stamps): the committed close built 367,201 B
  and the same tree without the three top bar files and the fold 367,279 B, so the bar is
  4,166 B and the rest of the polish 78 B, inside the budget.

- **Source conversation on older reports.** Index rows written before decision 25 read
  `null` (the library shows no source) until the report next changes.
- **Authority expiry is checked at step boundaries.** An idle, absolute or token expiry or a
  policy edit is noticed before the next model step or lookup batch, so a model call already
  running finishes first; explicit revocations stop the turn at once.

### 7.4 Deferred (ROADMAP section G)

Background deep-investigation Jobs, saving a chart to a dashboard, conversation sharing,
branching, folders and scheduling, model tier presets, a multi-replica turn registry,
showing the conversation summary, the context note shown only where a summary is stored,
bulk actions in Demo Mode, and the bounded mapping form for the other id-keyed KV stores
in the Elasticsearch config index.
