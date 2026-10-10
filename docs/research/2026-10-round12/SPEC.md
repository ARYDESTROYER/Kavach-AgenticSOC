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
  Comfortable 64rem / Wide 88rem (default) / Full (no cap). The 24px side strips go.
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
  ring (text deltas coalesced) then live tail; owner-checked; 404 for others.
- `GET /api/chat/conversations/{id}/messages/{message_id}/steps/{index}` → the stored observation
  the model saw for that step (owner-scoped; fenced display; never raw log rows).
- `POST /api/chat/feedback` → 204; per-user KV + audit row; never used for training.
- Realtime: targeted `chat.turn` events `{turn_id, conversation_id, case_id, phase: started |
  progress | finished | failed | needs_input, label, lookups, tokens}` on the existing EventBus with
  `audience = {owner}`. When auth is disabled the client polls `turns/active` every 5 s while a
  turn is known to run.
- Remember me: `POST /api/auth/login` accepts `remember: bool = False` and returns
  `remembered: bool` plus `remember_reason` when refused (`role_excluded`, `insecure_transport`,
  `disabled`); the MFA pending token carries a signed `rm` claim. `GET /api/setup/status` adds
  `remember_me {enabled, duration_seconds, insecure_blocked}`. `GET /api/auth/me` runs the
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
