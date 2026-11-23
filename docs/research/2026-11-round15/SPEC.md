# Round 15 SPEC: an RBAC switch, honest setup copy, team activity, and a stronger Case Manager

Status: binding for every Round 15 work package. Owner: orchestrator. Branch: `claude/round15`
(starts at `c4227bd` on `Testing`, which carries Round 14, its follow-ups and the documentation
refresh; reaches `Testing` through a pull request). Version stays `0.1.13` (no `VERSION`
change; `CHANGELOG.md` gets entries under the one `[Unreleased]` section).

This document replaces nothing in `AGENTS.md`. Where it is silent, `AGENTS.md`,
`docs/development/ui-standard.md`, `docs/development/design-system.md` and the Round 12, 13 and
14 specs stay binding. Every override of those documents is listed in §6.3.

Inputs (the evidence base; read the parts your package cites). Seven code maps and one
completeness critique, written read-only against `b49780c`, are committed beside this file:

- `understand/rbac-wizard.md` **[rbac]**: the RBAC model, the settings path, re-auth, the wizard.
- `understand/activity-data.md` **[act]**: the audit log, case data, per-user stores.
- `understand/casemanager-ui.md` **[cmui]**: the Case Manager and case workspace, every test.
- `understand/close-flow.md` **[close]**: the case lifecycle, close flow, ground truth.
- `understand/qa-sampling.md` **[qa]**: where auto-close happens, review design constraints.
- `understand/storage-attachments.md` **[files]**: storing images within the KV rules.
- `understand/platform.md` **[plat]**: registry, entry bundle, routers, docs, CI, Demo Mode.
- `understand/critic.md` **[crit]**: contradictions settled, gaps (G1 to G18), decisions D1 to
  D11, ranked risks. Every headline in [crit] §0 is resolved by a decision below.

Copy rule for every string that reaches a screen: plain, specific, sentence case, no em dashes
or en dashes used as dashes, numbers with thousands separators, only the product name "Agentic
SOC", never the word "playbook" in Console-authored copy.

---

## 1. Operator asks (Round 15)

Verbatim: "fix the rbac switch and the wizard wording, add another feature to track user
activity in the app, ie the soc analyst etc etc, i hope we have a role for that. Secondly,
analysts working and all, I want another place to be added in the side panel or something idk.
Atleast where in the admin can easily track all the work they have done, you know what I mean ?
I dont know but like daily work done etc etc. Also, can we improve case manager ? IE how an
analyst closes a case etc etc. Ability to add screenshots etc. And randomly maybe a case should
be sent to the analyst for manual review even though the case has been automatically closed to
collect their feedback ? i dont know, just a stronger overall pipeline is all im asking. CAse
manager looks very cluttered ui and ugly too, get to work on fixing it go open pr into testing"

Read as six deliverables:

1. **A1 RBAC switch.** There is no Console switch for `rbac.enabled` today ([crit] G14); add one.
2. **A2 Wizard wording.** The setup wizard says a live workspace without a key uses "the limited
   mock runtime"; that is false ([rbac] e.1, e.2). Make it true.
3. **A3 Team activity.** One navigation destination where a manager tracks what each person did,
   per day, with a permission a SOC manager holds. Asks 3 and 4 of the operator's message are one
   surface ([crit] headline 7).
4. **A4 Close flow and screenshots.** A cleaner, stronger close; screenshots on a case.
5. **A5 Auto-close review.** A small, random, auditable sample of automatically closed cases goes
   to a person for review, and their answer is recorded as independent ground truth.
6. **A6 Case Manager redesign.** Less clutter, one home per fact, a calmer queue and header.

---

## 2. Decisions

Each decision names the [crit] item it settles.

### 2.1 RBAC switch (A1; [crit] D1, G13, G14)

- **D1.1 Home.** The switch lives on **Roles & permissions** (`#/settings?s=roles`), in a
  "Role-based access" panel at the top that replaces today's "Role-based access is off" callout.
  The Security posture row (**Settings → Security & access → Single sign-on & policy**, Posture,
  "Role-based access") keeps its status text and gains a **Manage** link to that panel. One save
  path ([crit] G14, `ui-standard.md` "one save path").
- **D1.2 Endpoint.** New feature router `backend/app/api/routes_rbac.py`:
  - `GET /api/rbac` (`roles:read`) returns `RbacStatus`:
    `{enabled, auth_enabled, can_change, blockers: [code], caller_stored_role,
    super_admin_count, role_counts: {role: n} | null}`. `role_counts` is filled only for a caller
    who holds `users:manage` (computed from the user store; never personal data beyond counts).
    `blockers` codes: `auth_off`, `not_super_admin`, `read_only_settings`.
  - `PUT /api/rbac` body `{enabled: bool}`; dependencies `require_auth` and
    `require_fresh_auth()`. Rules, checked in this order:
    1. sign-in off → `409 rbac_auth_required` ("Turn on sign-in first. Role-based access has no
       effect while sign-in is off.");
    2. the caller's **stored** role (not the masked one, [rbac] a.2) must be `super_admin`, or the
       caller is the environment administrator → else `403 rbac_super_admin_only`;
    3. read-only settings mode honoured exactly as `PUT /api/settings` honours it;
    4. turning on requires at least one active stored `super_admin` or a configured environment
       administrator (the caller satisfies this by rule 2; keep the check as defence);
    5. no change → `200` with `changed: false` and no audit row;
    6. otherwise write through `audited_prefs_write` (action `settings.updated`, target label
       "RBAC", `changes=[{field: "rbac.enabled", before, after}]`), audit before visible, CAS
       `409 settings_conflict` on a race, `503 audit_unavailable` when the audit is down.
  - Demo Mode: allowed. It is real state: real `Preferences`, `control_audit`.
- **D1.3 Protect the old path.** `PUT /api/settings` answers `409 rbac_switch_moved` when the body
  carries an `rbac.enabled` that differs from the stored value (detail: "Turn role-based access
  on or off in Roles & permissions, or with PUT /api/rbac."). An equal value, or any other `rbac`
  field (`roles`, `custom_roles`, `denies`, ...), still saves as today
  (`test_runbook_permissions.py:308` keeps passing). This closes the `settings:manage` bypass
  ([crit] G13). The documented curl recipe changes to `PUT /api/rbac`; a script that signs in and
  calls it at once passes fresh auth (sign-in stamps `last_authn_at`).
- **D1.4 Console flow.** The panel shows: state ("On" / "Off: every signed-in account is treated
  as Super admin"), the account count per role when available, and one button.
  - **Turn on role-based access**: `ConfirmDialog` (not destructive). Copy names the effects: each
    account gets its role's permissions on its next request; background jobs started by an
    account that loses a permission stop at their next item; open live streams keep their topics
    until they reconnect; Remember me eligibility follows the role policy. It shows the caller's
    own role ("You stay Super admin").
  - **Turn off role-based access**: `ConfirmDialog destructive`, copy: "Every signed-in account
    will be treated as Super admin, whatever its role."
  - The call passes `reauthPurpose` ("Confirm your identity to change role-based access.") so the
    global `ReauthDialog` handles the 401. On success: `auth.refresh()`, refetch the panel, a
    toast.
  - Disabled with the reason as visible text when a blocker applies (sign-in off; not Super
    admin; read-only settings).
- **D1.5 Remove "no switch" wording** everywhere ([rbac] d): `Roles.tsx` callout, the Remember-me
  note in `SessionPolicyEditor.tsx` if it says so, every doc listed in [rbac] d.

### 2.2 Wizard wording (A2; [crit] D2)

- **D2.1 Truthful readiness.** The backend computes whether the investigation roles can call a
  model: the provider of the router and investigator role models has a configured credential
  (`Secrets.configured_status`, including Azure, Bedrock, Vertex and LiteLLM where those are the
  configured providers). Add `ai_runtime_ready: bool` and `ai_runtime_provider: str` to the
  **authenticated** payload the wizard already reads for `configured` (WP2 finds it); if only the
  public `/api/setup/status` is available at that point, add only `ai_runtime_ready` there (no
  provider or model name on a public route). The wizard's `hasProvider` becomes
  `ai_runtime_ready` when the field is present, else today's rule.
- **D2.2 Exact strings** (live mode; Demo strings stay, "mock runtime" is true in Demo):

  | Place | Old | New |
  |---|---|---|
  | `STEPS[2].description` | Add a provider credential for live investigations, or use the mock runtime. | Add a provider key so the agent can investigate cases. |
  | Keys alert title, no usable key | A live provider is recommended | No usable AI provider yet |
  | Keys alert body, no key | You can continue without a key, but live investigations will use the limited mock runtime until a provider is added. | You can continue without a key. Until you add one, every case waits for a person as Needs human and nothing closes automatically. |
  | Keys alert body, key present but not for the default models | (new) | The default investigation models use {provider}. Add a {provider} key, or choose other models in Settings, Models after launch. |
  | Review readiness row, live, no usable key | No provider configured · mock runtime only | No usable provider · cases wait as Needs human |
  | Review heading | Ready for live triage when any key | Ready for live triage only when a source and `ai_runtime_ready` |

  No new string may contain "Needs attention" (`Wizard.onboarding.test.tsx:265,294`). New tests
  assert each new string and that no live-mode string contains "mock runtime".
- **D2.3 Docs.** Remove every "Known issue in 0.1.13: the mock runtime wording" note and the
  README/INSTALL mentions ([rbac] e.2); re-capture `install-05-setup-ai-runtime.webp` and
  `install-06-setup-review.webp` in WP8.

### 2.3 Team activity (A3; [crit] D3 to D6, G9 to G12, headline 7 and 8)

- **D3.1 One surface.** Name **Team activity**, a child of **Analytics** placed second (Metrics,
  Team activity, Agent effectiveness, Cost, Models, Baseline, Jobs). Page id `team`, route
  `#/team`, page title "Team activity" (equals the nav label, `nav-titles.round14.test.ts`).
- **D3.2 Permission.** New resource `team` with one action `view`, granted by default to
  `soc_manager` and `auditor` (`super_admin` is automatic). This is the answer to "i hope we have
  a role for that": a **SOC manager** tracks the team; an **Auditor** may read it. Analysts do
  not hold it. Mirrors: `RESOURCES`, `_SOC_MANAGER`, `_AUDITOR`, `Roles.api.ts RESOURCE_ACTIONS`,
  truth tables, `docs/reference/permissions.md`, `users-rbac.md`. Stored `rbac.roles` overrides
  replace only the resources they name, so upgraded installs get the default (WP1 verifies and
  pins it with a test).
- **D3.3 Operator switch.** `Preferences.team_activity.enabled` (default `true`), one switch row
  in **Settings → Security & access** ("Team activity page"). Off: the team routes answer
  `409 team_activity_off` and the page shows an `unavailable` empty state naming the switch.
  For jurisdictions or works councils that restrict per-person monitoring ([crit] G9).
- **D3.4 Privacy and incentives** ([crit] G9). Counts with context; no ranking badge,
  leaderboard, "top performer" or composite productivity score (the `agent_improvement` "never a
  composite" rule). Columns may be sorted; the default order is by name. Never an IP address or
  user agent on this page (those stay in the Audit log under `audit:view`). Retention follows
  audit retention. With RBAC off, the page shows a warning `Callout`: "Role-based access is off,
  so every signed-in account can open this page." with a link to Roles & permissions. With
  sign-in off, the page shows `unavailable`: "Sign-in is off, so work cannot be attributed to
  people." Review counts sit beside close counts so rubber-stamping is visible, not rewarded.
- **D3.5 Source of truth: the audit log** ([act] §7). Counts are an exact fold over the audit
  rows in the window. No KV counter projection. Push-down aggregation (ES composite, SQL
  `GROUP BY`) is **not** built this round (§7); the fold streams `search_page` inside its
  snapshot and is exact on the bundled stores. Bounds: window at most 92 days
  (`422 team_window_too_long`); at most 250,000 rows scanned, beyond which the answer is marked
  `partial` with "at least" counts.
- **D3.6 Day.** Calendar days in the operator zone (`SlaPolicy.timezone`, the `time_windows`
  rule). The page states the zone. Shift views are not built (§7).
- **D3.7 Self-describing rows** (built in WP1, §2.7). Every human case-work row gets a structured
  `action`, a `target`, the request context and a bulk marker; legacy rows are still counted by
  reading their positional `result_summary` ([act] §7 step 3 "Fold").
- **D3.8 What is counted per person** (window and per day): acknowledged; closed, split by
  disposition (true positive, false positive, benign, duplicate, other); reopened; escalated;
  commented; assigned (as the actor); screenshots added; auto-close reviews completed (agreed,
  disagreed); runbook steps completed; sign-ins. Plus "of which in bulk jobs" for every lifecycle
  count ([crit] G11), last active (latest row of any kind), median time to acknowledge (for cases
  the person acknowledged first in the window: acknowledgement time minus case creation; exact
  when the window holds at most 5,000 such acknowledgements, else `partial` and omitted), and
  median review time (sample to completion, from the review ledger).
- **D3.9 Roster** ([crit] G12). `GET /api/team/people` under `team:view` returns a narrow
  projection: username, display name, role, active. People with no rows in the window still
  appear (zeros). Deleted users who appear in rows are listed by username with "Deleted account".
  Legacy rows whose actor is the literal `analyst`, `default` or empty are grouped under
  "Not attributed" with the explanation "Recorded before sign-in attribution, or with sign-in
  off."
- **D3.10 Endpoints** (new router `routes_team.py`, every route `require_permission("team",
  "view")` explicitly, [rbac] a.6):
  - `GET /api/team/activity?window=<time_windows token>` → `TeamActivity`
    `{window, timezone, days: [iso date], people: [PersonActivity], team: Totals, exact,
    partial_reason, scanned_rows, auth_enabled, rbac_enabled}`.
  - `GET /api/team/people` → roster.
  - `GET /api/team/people/{username}/events?window=&cursor=&limit=` → plain events
    `{ts, kind, label, case_id, case_number, detail}`, newest first, signed cursor, at most 200 per
    page. `label` is server-worded plain text; `detail` is plain text (#9: case titles are
    untrusted strings rendered as text nodes, never in a prompt).
  - Reads write one coalesced `team.viewed` row per viewer per 10 minutes (the
    `routes_audit._note_view` pattern).
- **D3.11 Page** (lazy, `webui/src/soc/pages/TeamActivity.tsx`, client calls in a lazy
  `lib/api-team.ts`, types in a type-only `lib/types-team.ts`): `PageHeader` with a
  `TimeRangePicker` (Today, Yesterday, Last 7 days, Last 30 days, custom up to 92 days); one KPI
  strip (people active, cases closed by people, acknowledged, reviews completed, median time to
  acknowledge); a per-day stacked bar chart of the team's work kinds (Okabe-Ito ramp, legend,
  tooltip, `dataviz` rules); a `DataTable` of people; a person side sheet (`SPRING_PANE`) with
  their per-day table, review agreement, and the paged event timeline with case links and, for a
  viewer with `audit:view`, "Open in Audit log" (`#/audit?actor=<username>`). Honest states:
  `partial` shows a visible caveat; empty windows show `no-data`. Client-side "Download CSV" of
  the people table (no server call).
- **D3.12 Demo Mode** ([crit] C8, D6). Seeding writes backdated Demo audit rows (`record_strict`
  with `ts=`) for the seeded human work by `DEMO_SOC_ANALYSTS`, matching the seeded cases'
  `status_history` times: acknowledgements, closes with dispositions, comments, assignments and
  the seeded reviews (§2.6). Wrapped so a failure never blocks Demo enable.

### 2.4 Close flow (A4; [crit] D7, G7, G8, G5)

- **D4.1 One classification question.** The close dialog asks "what was it" once: the
  disposition (required, empty until chosen, `disposition_declared: true`). The separate "What
  actually happened?" select and the overlapping Resolution select are removed. The existing
  wire stays: `close_disposition` maps to `close` (`wireAction`), the picker opens empty (G1).
- **D4.2 Actions taken** (structured, optional). New additive `CaseAction.actions_taken:
  list[str] | None` from a fixed vocabulary, at most 8, unknown values `422`:
  `no_action_needed, blocked_indicator, isolated_host, disabled_account, reset_credentials,
  removed_malware, patched_or_hardened, notified_owner, escalated_externally, tuned_detection,
  other`. Stored on the `analyst_action` history entry (`history` is not mapped on ES) and in the
  new structured audit row's `changes`. Shown in the Collaboration History and in the case
  Markdown export. Never model text (§2.8).
- **D4.3 Note.** Optional, except the Console requires it when the chosen disposition disagrees
  with the AI verdict (true positive against an AI false positive or benign verdict, or false
  positive or benign against an AI true positive). Inline reason: "Say why you disagree with the
  AI. Your note is kept as precedent for future investigations." The backend is unchanged; API and
  bulk callers are unaffected. The existing `DURABLE_CONTEXT_NOTE` disclosure stays.
- **D4.4 Rate the AI (optional).** A collapsed disclosure with the three 1 to 5 star rows and
  "What did the AI miss?". The agreement is computed from the disposition against the AI verdict
  and shown as text ("Your classification agrees with the AI"), never asked. If the analyst gives
  any rating, the Console posts one feedback entry whose `actual_outcome` is derived from the
  disposition they just chose (true positive → `true_positive`; false positive and benign →
  `false_positive`; others → `unknown`) and whose `assessment` is the computed agreement. No
  rating, no grade (as today when the grade is skipped), so the grading population does not shift
  ([crit] G8).
- **D4.5 Unrated stars.** `feedback_stats` averages each sub-score over entries that rated it;
  `0.0` means unrated (the Console scale is 1 to 5 stars mapped above zero; WP1 verifies).
  The stored shape does not change, so a previous build reads it unchanged.
- **D4.6 Tags leave the close dialog** (edited in the facts rail). **Screenshots join it**: an
  "Add screenshots" drop zone that uploads each file at once through the files API (§2.5); the
  close never waits for or rolls back an upload, and uploads stay allowed on closed cases
  ([crit] G7). No "evidence required" gate. `BulkCloseDialog` keeps its shape, without
  screenshots (stated in its help text).
- **D4.7 Set disposition on auto-closed cases** ([crit] G5). On a case the agent closed
  (`decision_by == agent`, terminal), the Console offers **Review this auto-close** (§2.6) and
  hides Set disposition, so an analyst never flips `decision_by` to `analyst` by confirming an
  auto-close. The backend `set_disposition` verb is unchanged for API callers.

### 2.5 Screenshots (A4; [crit] D9, G4, G15; [files] §7)

- **D5.1 Storage** (#12, KV only): namespace `case_files`; per-case index doc `case:<case_id>`
  (strict CAS, opaque `case_file_index_json`, at most 20 live entries) and write-once content
  docs `blob:<file_id>` and `thumb:<file_id>`; optional org `usage` doc. Fixed
  `case_file_`-prefixed top-level fields only; raw ids only inside opaque JSON or as `case:<id>`.
  Never on the `Case` document. Never a `CaseActivity` entry (the ES `case_activity` document is
  keyed by case id and grows the shared mapping, [crit] G4).
- **D5.2 Limits**: PNG, JPEG, WebP only, by magic bytes; 2 MiB decoded per image after stripping;
  at most 8,192 px a side and 40 megapixels (parsed from headers, no pixel decode); 20 images and
  20 MiB per case; 2 GiB per organisation (`409 case_files_storage_full`); 30 uploads per minute
  and 2 concurrent per user (`429 case_files_busy`, `Retry-After`); caption at most 200
  characters, filename at most 120, plain text. Thumbnails at most 48 KiB WebP or PNG, generated
  in the browser.
- **D5.3 Validation** in a pure stdlib module `backend/app/engine/case_images.py` exactly as
  [files] §7.3 (PNG chunk walk with CRC, JPEG marker walk, WebP RIFF walk; metadata stripped;
  trailing bytes refused; SVG, GIF, BMP, TIFF, HEIC, ICO, PDF and animations refused). The server
  does not decode pixels; the limitation is documented (a crafted image aimed at a browser decoder
  is mitigated by the allowlist, structure checks, dimension caps, authenticated uploads and
  audit).
- **D5.4 API** (`routes_case_files.py`): `GET /api/cases/{id}/files` (`cases:read`, metadata);
  `POST /api/cases/{id}/files` (`cases:comment`; JSON base64 body; a bounded route class capping
  the request at 3 MiB; dedup by SHA-256 on the case returns the existing entry); `DELETE
  /api/cases/{id}/files/{file_id}` (`cases:comment`, and the uploader or a `cases:close` holder,
  with an Access denied row on refusal); `GET /api/cases/{id}/files/{file_id}/content?variant=
  full|thumb&download=1` (`cases:read`, `get_strict`, the strict headers of [files] §7.4).
  Explicit `require_permission` on every GET.
- **D5.5 nginx**: a regex location for `^/api/cases/[^/]+/files$` with `client_max_body_size
  3m` and the same proxy headers and timeouts as `/api/`. The frozen base covers only the
  Compose file ([crit] C6), so `webui/nginx.conf` may change.
- **D5.6 Elasticsearch**: bootstrap adds `case_file_data: {type: binary}` to the config index
  mapping as an additive new-field mapping before the first write (the `extend_audit_mapping`
  precedent). If the put fails or the field already exists as text, writes still work.
- **D5.7 Prerequisite fix**: `factory_purge_strict` must not load every KV value into memory
  ([files] §6.1) on either backend; values are read only for the protected rows it proves. A test
  fails on any full-source read of a non-protected document.
- **D5.8 Lifecycle**: cases-tier reset clears the namespace (receipt `kv:case_files:<n>`);
  factory reset purges it; data export lists metadata per case and excludes the bytes with an
  `_EXCLUDED` line; user deletion keeps evidence; rollback lane plants an attachment and proves a
  previous build ignores it.
- **D5.9 Audit**: `audited_write` with `case.file_attached` and `case.file_deleted` (failures
  `case.file_attach_failed`, `case.file_delete_failed`), target the case, `changes` naming the
  file, never bytes.
- **D5.10 Never to a model** (#9, #3): no chat tool, report digest, standup, starter, RAG chunk or
  investigator prompt reads the store or its captions. A static test bans importing the store from
  `app/agents/**`, `app/engine/report_digest.py`, `app/engine/chat_starters.py` and `app/tools/**`;
  a sentinel test proves a caption and filename never reach a gateway prompt.
- **D5.11 Console**: a **Files** section in the Collaboration tab (thumbnail grid; caption,
  uploader, time; a Radix `Dialog` lightbox with the caption as the accessible name; download;
  delete with confirm for the uploader or a moderator); paste (Ctrl or Cmd+V) while the
  Collaboration tab or the close dialog has focus, drag and drop, and a file picker. The browser
  re-encodes through a canvas (strips metadata, applies orientation), downscales to at most 3,840
  px, encodes PNG then WebP 0.92 then JPEG 0.9 until under 2 MiB. Content is fetched as a blob
  through the API client (so 401 and re-auth work) and revoked on unmount. Demo Mode: allowed,
  stored in the Demo KV, gone when Demo ends.

### 2.6 Auto-close review (A5; [crit] D8, G2, G3, G5, G6, G16)

- **D6.1 What.** A deterministic, seeded, capped sample of the cases the agent closed
  automatically is queued for a person to classify. Their answer is recorded as an independent
  `FeedbackEntry` and becomes ground truth; nothing about the case's status, decider or
  disposition changes unless the person reopens it.
- **D6.2 Config** `Preferences.auto_close_review` (`AutoCloseReviewConfig`): `enabled: true`,
  `sample_rate: 0.05` (0 to 0.5), `daily_cap: 10` (0 to 200), `per_rule_daily_cap: 3` (1 to 50),
  `expiry_days: 7` (1 to 30). Repaired (clamped) on load, rejected on write (`422`). Default on
  for new and upgraded installs (#10: $0, bounded human work, `decide()` untouched). No
  autopilot version bump. Settings home: **Settings → Detection**, an "Auto-close review" group
  beside the auto-close bars; key added to `CURATED_SECTIONS`.
- **D6.3 Sampler.** A post-decision hook in `agents/pipeline.py` after `apply()` and `save()`
  (the existing hook point, [qa] a.4), for a terminal case with `decision_by == agent`. Analyst
  policy closes return earlier and are never sampled. Pure selection in
  `backend/app/engine/auto_close_review.py`: score `sha256("auto-close-review:v1:" + case_id)`,
  first 8 bytes over 2^64; selected when `score < sample_rate`, the day's count is below
  `daily_cap` and the rule's count (`precedent.case_rule_identity`) is below
  `per_rule_daily_cap`. Day in the operator zone. Once per case: a case already in the ledger is
  never sampled again while its entry is kept; after ring eviction a re-closed case may be
  re-selected (documented). The hook is fail-soft: an error logs a warning and never touches the
  case. The module never imports `case_manager` (guards updated).
- **D6.4 Ledger** (#12): namespace `auto_close_review`, one strict-CAS document `ledger` with
  fields `acr_store`, `acr_schema`, `acr_json` (canonical opaque JSON: a ring of at most 2,000
  entries `{review_id, case_id, case_number, rule, sampled_at, day, score, state, reviewer,
  completed_at, classification, agrees, ai_verdict}` and per-day sampled counts, overall and per
  rule, for 90 days). Written only when a case is sampled or reviewed ([crit] G16: no write per
  auto-close). States: `pending`, `completed`; `expired` is computed on read (pending older than
  `expiry_days`). Eviction drops the oldest completed or expired entries first. Demo instance over
  the Demo KV.
- **D6.5 Sample audit.** One `case.review_requested` row per selection (actor system, Agent
  activity scope) with score, rate, the day's counts and the rule. One SSE frame on the case and
  the `cases` topic so open queues refresh their review count.
- **D6.6 Recording a review.** `POST /api/cases/{id}/review` (`cases:write`, audit-first
  `case.review_recorded`, failure `case.review_record_failed`) with body `{classification:
  "true_positive"|"false_positive"|"benign"|"unsure", note: str (at most 1,000), accuracy,
  reasoning_quality, action_appropriateness: optional floats 0..1}`. Accepted for any terminal
  agent-decided case (D4.7); `origin` is `auto_close_review` and `review_id` is set when the case
  is in the ledger, else both are empty (an ordinary grade). It appends one `FeedbackEntry` with
  `analyst` from the verified principal, `actual_outcome` mapped (true positive → `true_positive`;
  false positive and benign → `false_positive`; unsure → `unknown`), `assessment` computed against
  the snapshotted AI verdict (`agree` or `disagree`; empty for unsure), and one `history` event
  `{event: "auto_close_review", review_id, feedback_ts, analyst, ts, agrees}`. It never sets
  `status`, `decision_by` or `disposition`. It re-fetches the case before writing, marks the
  ledger entry completed, and indexes the resolved case exactly as the feedback route does. The
  response carries `agrees` and `can_reopen` (the caller holds `cases:close`).
- **D6.7 Rollback-safe marker** ([crit] G3). `FeedbackEntry` gains `origin: str = ""` and
  `review_id: str = ""`. A previous build drops them on its next full save, but keeps the
  `history` event (history is a list of free dicts). One pure helper,
  `engine/review_origin.py::is_review_grade(case, entry)`, returns true when `entry.origin ==
  "auto_close_review"` or a history event with the same `feedback_ts` and `analyst` exists. Every
  consumer below uses it. The rollback lane plants a review and proves the marker survives a save
  by the previous build.
- **D6.8 What a review grade feeds.** Included as ground truth: `analyst_confirmed_outcome`, the
  threshold tuner, the precedent corpus, `ground_truth_supply` (that is the point; FP reviews can
  promote precedent, documented). **Excluded** from `feedback_stats` and the `agent_improvement`
  comparisons (a sampled population would read as "improving", [crit] headline 9). Never a new
  `PROVENANCE_COUNT_KEYS` entry, never a `PrecedentWindowConfig` field ([crit] risk 3).
- **D6.9 Disagreement.** The review is always recorded. A reviewer with `cases:close` is offered
  **Reopen case** and **Reopen and escalate** (the normal `reopen` and `escalate` verbs, with a new
  additive `CaseAction.via` value `"auto_close_review"` recorded on the history entry and audit
  row so reopens can be told apart). Nothing reopens automatically. A reviewer without
  `cases:close` sees "Someone who can close cases has been asked to look at this." and the backend
  sends one Inbox item per disagreement to holders of `cases:close` (the
  `eligible_batch_audience` precedent, at most 200 recipients, category `assignment`, the
  category's first producer). With RBAC off that is every active account; the daily cap bounds
  it.
- **D6.10 Reinvestigation carry-over** ([crit] G2, headline 1). `_assemble_case` carries over,
  for an in-place reinvestigation of an open case: `assignee`, `comments`, `feedback`,
  `status_history` (appended to, not replaced), `acknowledged_at`, `escalation_level`,
  `status_reason`, `notifications_sent`, and an analyst-set `disposition`. `decide()` is
  untouched; `apply()` already fills `disposition` only when it is `None`, so a carried analyst
  disposition survives a re-verdict. This is a behaviour change, stated in the CHANGELOG. The
  review card never offers Reinvestigate on a closed case (reopen first; the duplicate-case
  defect on closed reinvestigation is a follow-up, §7).
- **D6.11 Blindness.** Full blind review is not built. The review card asks the reviewer's own
  classification with no preselection, before it shows "Compare with the AI", and records the
  time from opening the card to submitting. The independence caveat is documented, and Team
  activity shows each reviewer's agreement rate and median review time.
- **D6.12 Where it shows.**
  - **Case Manager**: a fourth queue scope **Review** with a count badge (pending), backed by a
    server filter `GET /api/cases?review=pending|completed|disagreed|expired` resolved from the
    ledger's case ids (ES `terms`, SQL `IN`, at most 2,000 ids) with the existing loaded-versus-
    total semantics; deep link `#/case_manager?review=pending`. A pending case shows a band under
    the header ("Picked at random for auto-close review. Classify it yourself, then compare with
    the AI.") with **Start review** as the primary action. A completed review shows its result in
    the facts rail Outcome section.
  - `GET /api/auto-close-review/summary` (`cases:read`): `{enabled, pending, disagreed_open,
    sampled_today, daily_cap}` for the badge.
  - **Agent effectiveness**: an "Auto-close review" module from `GET
    /api/metrics/auto-close-review?window=` (`metrics:view`): sampled, reviewed, pending,
    expired; agreement with a Wilson 95% interval when at least 30 reviews, else "Not enough
    reviews yet"; missed threats (reviewer said true positive on an automatic false-positive
    close) with case links; per-rule table (top 10); median review time; the eligible count of
    automatic closes from `case_aggregate` by creation day, labelled as such. Never a composite.
  - **Team activity**: reviews per person (D3.8).
  - **webui `caseOutcome`** reads the feedback branch first, exactly like the backend authority
    ([close] fact 10), so a reviewed auto-close renders "Reviewed: false positive" (agree) or
    "Review disagreed: true positive".
- **D6.13 Demo Mode.** Seeding samples about six seeded automatic closes: three pending, two
  completed and agreeing, one completed and disagreeing (with its FeedbackEntry, history event,
  ledger entries and Demo audit rows by Demo analysts).

### 2.7 Audit rows for human case work (foundation for A3, A5; [crit] G1, G11; [act] §7)

- **D7.1 Structured actions on new rows** (no backfill, #2). `_perform_case_action` rows get
  `action` from: `case.acknowledged`, `case.closed`, `case.fp_confirmed`, `case.resolved`,
  `case.reopened`, `case.escalated`, `case.deescalated`, `case.held`, `case.resumed`,
  `case.disposition_set`, `case.status_set`. Collab rows: `case.assigned`, `case.tagged`,
  `case.commented`. Feedback rows: `case.graded`. Each row also gets `target={type: "case", id,
  label: case_number}` and the request context (`audit_context(request).record_fields()`).
  `action_type`, `surface` and `result_summary` stay byte-identical (positional readers and
  `test_audit_route_outcomes.py`, `test_g1_ground_truth_intake.py:303`).
- **D7.2 Attribution fix** ([act] headline 3). Comment, tags, assign and the reinvestigate summary
  take the audit actor (and the `history[].analyst` of the "assigned" entry) from the verified
  principal when sign-in is on; the body value only when sign-in is off (the `case_feedback`
  pattern). Older rows cannot be re-attributed (append-only; D3.9 groups them).
- **D7.3 Bulk marker.** Rows written by a bulk job carry the job id in `run_id`; the fold counts
  them as bulk.
- **D7.4 Legacy filter compatibility** ([crit] G1). The audit event predicate gains a
  family-to-actions alias table: the legacy family `status` also matches the new lifecycle
  actions, `collab` matches `case.assigned|tagged|commented`, `feedback` matches `case.graded`,
  in the Python reference, the ES compile and the SQL compile together, with a test per family
  holding one old-shape and one new-shape row. Saved links such as `#/audit?event=status` keep
  their meaning; the Audit export filter and the chat ops audit tool inherit it.
- **D7.5 Event catalog.** Every new action has an exact entry in
  `backend/app/audit/event_categories.json` (category `case_work`; `team.viewed` in the access
  category) and its mirror in `webui/src/soc/components/audit/events.ts` (contract test). New
  base verbs are added where `_BASE_VERBS` lacks them.
- **D7.6 Failure semantics unchanged.** Lifecycle and collab rows stay best-effort after the save
  (moving them audit-first would turn an audit outage into a failed close). Team activity states
  that counts come from the audit log. New writers this round (files, reviews) are audit-first.

### 2.8 Case Manager redesign (A6; [crit] D10, G17; [cmui] §6, §7)

Target, measured against today's clutter ([cmui] §2.4, §6): about 11 controls above the first
queue row, three-line rows with nine facts, a header with up to 22 tab stops, seven tabs, ten
rail sections and facts repeated two to five times.

- **D8.1 Queue pane.**
  - Control band, two rows at most: row one is the scope `SegmentedControl` (Active, Mine,
    Review with its count, All) and a **Filters** button with the active filter count (a
    `Popover` holding Severity, Status, Closed by and density, with Clear all); row two is the
    search field (with the `/` hint). Active filters show as removable chips under the search only
    when set. Live and Refresh stay in the page header.
  - "Select visible" becomes the checkbox at the start of row two for bulk roles only; the
    selection count appears in the bulk bar only. The scope line ("12 of 68 active, 50 loaded")
    moves to the list footer beside Load more.
  - Rows are two lines: line one, title (one line, full value accessible) and age; line two,
    severity word (glyph plus word, the 3 px rail reinforces it), "Risk N", case number, then
    **status for an open case or the outcome badge for a closed case, never both**, and the owner
    monogram at the end. The primary fact and the runbook chip leave the row (both stay in the
    detail). The chat activity glyph stays. Risk bands use `scoreBand`, not the private 74/48/22
    cut-offs. Compact density keeps one line.
- **D8.2 Header.** Line one: the title (one line, never squeezed) and, at the end, one primary
  contextual action (Acknowledge, Close case, Start review, or Reopen), **Take action** (every
  other verb), and an overflow menu (copy link, open in new tab). Line two, one meta row: case
  number with copy, severity, status or outcome, the AI verdict chip, owner (the one editable
  home of the owner, a popover), opened age, and the SLA while open. Tags, campaign, risk info,
  Ask AI and the Demo badge move to the facts rail. About 10 tab stops before the tabs.
- **D8.3 Tabs: five.** Overview, Investigation, Runbook, Collaboration, Chat. `CASE_TABS`
  becomes `['overview', 'investigation', 'runbook', 'collab', 'chat']`. Old deep links redirect:
  `tab=timeline` opens Overview at its "What happened" section; `tab=threat` opens
  Investigation at its "Threat context" section. Alt+1 to Alt+5. Counts only on Collaboration
  (comments plus files) and Runbook (open steps).
  - Overview: the AI summary in two or three sentences, "What happened" (the stage timeline,
    formerly the Timeline tab), key entities, and nothing the header or rail already shows.
  - Investigation: AI assessment (the model's reading only; G17: no fallback to the code's
    `decision_rationale`, pinned by a test), the decision card (what code decided, the authority
    sentence once), Threat context (MITRE and reputation, formerly its own tab), inputs, and the
    trace (collapsed).
  - Runbook: unchanged in behaviour.
  - Collaboration: Thread, Files (D5.11), Tasks, History (lifecycle with who, when and actions
    taken). No owner picker here.
- **D8.4 Facts rail.** Seven sections, hairline-divided, no icon headings: Outcome (outcome of
  record, AI verdict and confidence, decided by, objection window, review result), Signal (risk
  meter, severity provenance, priority), Times (opened, acknowledged, SLA, closed), Tags (editable)
  and campaign, Source and primary entity, Related cases, Record. Each fact has one home across
  header, rail and tab bodies; the docs claim (`case-manager.md:157`) becomes true.
- **D8.5 Visual rules** ([cmui] §7): tokens only; no `Card` inside a `Panel` (`PanelCard` goes
  from the case files); no `tracking-tight`; underline `Tabs` (`TabsList variant="underline"`,
  13 px labels, no icons); one 16 to 24 px rail shared by header, tabs and panels; content text at
  least 12 px; `text-2xs` only for badges and timestamps; `SPRING_UI` and `SPRING_PANE`; reduced
  motion honoured; WCAG AA in both themes.
- **D8.6 Kept contracts.** Server-backed queue; roving focus (J/K, arrows, X, Space, Shift, Enter
  to `[data-case-title]`, `/`, `?`, Esc); focus after dialogs (`resolveDialogFocus`, "Close and
  next"); selection only for bulk roles; durable bulk jobs; `closedBy` chip; the Sheet host for
  the Overview dashboard and Investigate keeps working with the same layout.
- **D8.7 Dead code removed**: panel `'default'` presentation branches (tests that loop both
  presentations move to the one presentation), unused `close` and `confirm_fp` action defs,
  `HeadlinePanel`, `BriefChip`, stale "footer" comments (the test file
  `CaseDetail.footer.test.tsx` is renamed to `CaseDetail.header-actions.test.tsx`), the
  `BULK_DISPOSITIONS` duplicate.
- **D8.8 Docs**: `docs/analyst/case-manager.md`, `docs/analyst/cases.md` where it describes the
  workspace, and `docs/development/ui-standard.md` (queue row and header grammar, §6.3).

### 2.9 Pre-existing defects (D11)

Fixed in this round: D7.2 attribution; D6.10 reinvestigation carry-over; G17 AI assessment
fallback; `caseOutcome` feedback branch (D6.12); the stale `settings-sections-meta.ts` comment
([crit] C1); stale Case Manager comments. Spawned as follow-up tasks (§7): duplicate case on a
closed reinvestigation; lifecycle notifications ignoring `triggers.on_closed`;
`first_response_at` never written; `case_activity` and `case_tasks` opaque rows on ES; audit
push-down aggregation.

---

## 3. Shared contracts

### 3.1 Entry bundle ([plat] b)

Today: 337,163 B against a 337,240 B budget (about 31 B in CI). Plan:

- WP3 first removes the 11 hidden `FEATURES` entries that duplicate a visible child of the same id
  and label (dashboard, investigate, cost, models, standup, knowledge, runbooks, memory, personas,
  roles, users; about 818 B, [plat] b.5), repointing `registry-router-round6.test.tsx:121`. Keep
  catalog, playbooks, account, sessions, security and admin_sessions.
- Spends, all lazy where possible: the Team activity child and route (about 230 B), the
  `review` deep-link key (about 40 B), `CASE_TABS` (about minus 20 B), wizard copy (net about 0).
  New client calls go in lazy `lib/api-*.ts` modules, never `lib/api.ts`; new mirrors in
  type-only `types-*.ts`.
- No upward rebase is planned. If the integrated entry is more than 1 KiB under the baseline, the
  orchestrator may ratchet `PRE_REVAMP_ENTRY_BYTES` down once, recorded in §8 and in the
  `test_docs_round12_records.py` pin. The 400,000 B ceiling never moves.

### 3.2 Demo Mode (every new store and writer)

| Store or writer | Demo behaviour |
|---|---|
| `case_files` store | Demo KV instance while Demo Mode is on; Demo audit sink |
| `auto_close_review` ledger | Demo KV instance; seeded (D6.13) |
| Review endpoint | writes the Demo case and Demo audit |
| Team activity reads | read the merged audit sources (Round 14 `_sources` split) |
| RBAC switch | real `Preferences`, `control_audit` |
| `team_activity` and `auto_close_review` settings | real `Preferences` (as every Settings save) |

A test per new writer asserts the sink with Demo Mode on and off.

### 3.3 Permissions

| Grant | Who (built-in defaults) | Used by |
|---|---|---|
| `team:view` (new) | super_admin, soc_manager, auditor | Team activity page and routes |
| `roles:read` | every role | `GET /api/rbac` |
| stored `super_admin` + fresh auth | super admins | `PUT /api/rbac` |
| `cases:comment` | every role but auditor | add a screenshot; delete own |
| `cases:close` | super_admin, soc_manager, analyst_tier2 | delete others' screenshots; reopen from a review |
| `cases:write` | every role but auditor | record a review |
| `cases:read` | every role | list and view screenshots; review summary |
| `metrics:view` | every role | Auto-close review module |
| `settings:manage` | super_admin, soc_manager | the two new settings |

### 3.4 Storage (#12) and Elasticsearch mapping budget ([crit] G4)

New KV namespaces: `case_files`, `auto_close_review`. Every new KV document uses a fixed,
namespace-prefixed set of at most six top-level fields with the payload in opaque JSON (or the
base64 field); no dict keyed by case, user, date or rule outside opaque JSON. New `Preferences`
blocks: `team_activity` (1 field), `auto_close_review` (5 fields). No new index, table or
migration. Register any version stamp in `MIGRATION_STAMP_KEYS` (none planned).

### 3.5 Non-negotiables cross-check

- #2: every new writer audits (files and reviews audit-first; the switch through
  `audited_prefs_write`); lifecycle rows keep best-effort semantics (D7.6).
- #3: `decide()` byte-identical; the sampler runs after `apply()` and `save()` and never imports
  `case_manager`; the review never writes `status`, `decision_by` or `disposition`; the close
  dialog posts only existing verbs; no new close gate.
- #6: no new model call in this round.
- #7, #9: screenshots, captions, team counts and review notes never reach a prompt (D5.10); review
  notes are plain text, fenced if a later round ever retrieves them.
- #10: smart defaults: review on at 5% and 10 a day; team page on behind its permission.
- #12: KV only.

---

## 4. Work packages

### 4.1 Rules

- Ownership is exclusive per wave (§4.6). A package touches only files it owns, plus new files it
  creates. Shared-file edits are done in WP1 so later packages only add code in their own
  modules.
- Each package: implement, run its focused tests and the affected suites until green, run
  `npm run lint`, `npm run gates` and `npm run check:types` for any webui change, scan every
  changed file for em dashes, en dashes used as dashes, U+00A0 and Cf characters, and return a
  report ending with a Journal entry (no em dashes).
- Parallel packages run in their own git worktrees, commit on a local branch `r15-<wp>` (never
  push), and report the branch and commit. The orchestrator merges.
- Worktree setup: `ln -s /home/user/Kavach-AgenticSOC/webui/node_modules webui/node_modules`;
  run Python tests with `/home/user/Kavach-AgenticSOC/backend/.venv/bin/python -m pytest -q -p
  no:cacheprovider` from the worktree's `backend/`; docs tools with
  `/home/user/Kavach-AgenticSOC/.docs-venv/bin/python`.

### 4.2 Wave 1: foundation (sequential, main tree)

**WP1 Foundation** (backend schema plus shared registries):
- `models.py`: `FeedbackEntry.origin`, `FeedbackEntry.review_id`; the new response models
  (`RbacStatus`, `TeamActivity` and parts, `CaseFileEntry`, `AutoCloseReviewEntry`,
  `AutoCloseReviewSummary`); mirrors in `webui/src/lib/types.ts` or type-only modules.
- `routes.py`: `CaseAction.actions_taken` (vocabulary constant in `constants.py`) and
  `CaseAction.via`; D7.1 structured actions, target and context on lifecycle, collab and
  feedback rows; D7.2 attribution; D7.3 bulk marker (`engine/jobs.py` call site);
  `actions_taken` and `via` on the history entry.
- `audit/query.py` (Python, ES, SQL) D7.4 alias table; `audit/event_categories.json` and
  `webui/src/soc/components/audit/events.ts` entries for **every** Round 15 action (D7.1,
  D5.9, D6.5, D6.6, `team.viewed`).
- `config.py`: `TeamActivityConfig`, `AutoCloseReviewConfig` with clamps and write rejections;
  `Preferences.team_activity`, `Preferences.auto_close_review`.
- `rbac/policy.py`: resource `team: ["view"]` for soc_manager and auditor;
  `webui/src/soc/pages/Roles.api.ts` mirror; truth tables.
- `constants.py`: `CASE_FILES_NS`, `AUTO_CLOSE_REVIEW_NS`, the actions-taken vocabulary.
- `engine/review_origin.py` (`is_review_grade`); `engine/metrics.py::feedback_stats` (D4.5 and
  the D6.8 exclusion); `engine/agent_improvement.py` (D6.8 exclusion).
- `agents/pipeline.py::_assemble_case` carry-over (D6.10) with tests (open-case reinvestigate
  keeps assignee, comments, feedback, status history, acknowledgement, escalation, status reason,
  notifications and an analyst disposition).
- Regenerate `webui/openapi.json` and `api-types.gen.ts` if schemas changed (`npm run gen:types`,
  `check:types`).
- Acceptance: the full backend suite green; `decide()` source guards untouched and green.

### 4.3 Wave 2: features (parallel worktrees from the WP1 commit)

**WP2 RBAC switch and wizard** (A1, A2): `routes_rbac.py`; the D1.3 guard and D2.1 fields in
`routes.py` (only those two regions); `Roles.tsx` panel; `security.tsx` Manage link;
`SessionPolicyEditor.tsx` note; `Wizard.tsx` (D2.2, byte-neutral or shorter in total);
tests (backend route tests for every rule in D1.2 and D1.3, webui tests for the panel, dialogs,
blockers and every new wizard string). Docs it owns: `docs/administration/users-rbac.md`
(Console steps plus the `PUT /api/rbac` recipe), `docs/getting-started/first-run.md`.

**WP3 Team activity** (A3): `engine/team_activity.py` (pure fold, legacy parsing, roster
merge, honesty flags), `api/routes_team.py`, Demo audit-row seeding (a new function in
`engine/demo_generator.py` called from the Demo seeding sequence in `state.py`), the D3.3
settings row (Security & access section file), `TeamActivity.tsx`, `lib/api-team.ts`,
`lib/types-team.ts`, `registry.tsx` (the child and the removal in §3.1), `router.tsx` (the
`team` route only), console map regeneration, tests. Docs it owns: a new Help Center page
`docs/analyst/team-activity.md` (nav entry in `mkdocs.yml` under User and analyst guide).

**WP4 Screenshots** (A4, D5): `engine/case_images.py`, `stores/case_files.py`,
`api/routes_case_files.py`, `state.py` wiring (real and Demo properties), `engine/reset.py`,
`api/routes_export.py`, the factory purge fix in `stores/memory.py` and
`stores/sql/repositories.py`, `es/indices.py` mapping, `webui/nginx.conf`, rollback lane plant,
tests (validator corpus, caps, dedup, headers, permissions, Demo sinks, never-to-a-model). Webui
kit, not mounted: `webui/src/soc/pages/casedetail/files/` (`CaseFiles.tsx` gallery and
lightbox, `useCaseFileUpload.ts` with canvas re-encode and thumbnail, `FileDropZone.tsx`),
`lib/api-case-files.ts`, tests. Docs it owns: `docs/administration/reset.md`,
`docs/operations/health-backup.md` (backup size note).

**WP5 Auto-close review** (A5, D6): `engine/auto_close_review.py`, `stores/auto_close_review.py`,
the pipeline hook (one call site in `agents/pipeline.py`, after the existing post-decision
hooks), `api/routes_auto_close_review.py` (review endpoint, summary, metrics module), the
`review=` filter in the cases list route (`routes.py`, that region only), the disagreement Inbox
fan-out, `state.py` wiring, reset and export wiring, Demo seeding, the Settings Detection group,
the Agent effectiveness module (`AgentEffectiveness.tsx` plus a lazy module), the webui kit not
mounted in Case Manager: `webui/src/soc/pages/casedetail/review/ReviewCard.tsx` and
`lib/api-reviews.ts`; `webui/src/soc/components/outcome.ts` feedback branch (D6.12) with tests.
Docs it owns: `docs/automation/auto-close-review.md` (new, nav under Automation),
`docs/analyst/analytics.md` (the module), `docs/concepts/deterministic-decisions.md` (one
paragraph: review never decides).

**WP6 Case Manager redesign** (A6, D4 UI, D8), two agents in sequence on one worktree branch:
- **WP6a** queue pane, header, tabs consolidation (`case-tabs.ts`, router `tab` redirect and the
  `review` deep-link key in the `case_manager` block of `router.tsx`), facts rail, dead code,
  and the tests they move.
- **WP6b** tab bodies (Overview absorbs Timeline, Investigation absorbs Threat context, the G17
  fix, Collaboration without the owner picker and with a placeholder slot for Files), the close
  dialog (D4.1 to D4.6, with a slot for the drop zone), and the tests they move.
- Owns `CaseManager.tsx`, `CaseDetail.tsx`, `casedetail/**` except `files/` and `review/`,
  `ConfirmActionDialog.tsx`, `DispositionPicker.tsx`, `case-tabs.ts`, the Case Manager region of
  `router.tsx`, `docs/development/ui-standard.md` (queue and header grammar),
  `docs/analyst/case-manager.md`.

### 4.4 Wave 3: integration (sequential, main tree, after merging WP2 to WP6)

**WP7 Integration**: mount the WP4 kit (Collaboration Files section, close dialog drop zone,
paste handling) and the WP5 kit (Review scope with count, the pending-review band and Start
review primary action, Review this auto-close and hidden Set disposition on agent-decided
terminal cases, the review result in the rail), wire SSE refresh, update the tests these touch,
regenerate types and the console map.

### 4.5 Wave 4 and 5: review, records, gates

- **Review** (workflow): adversarial reviewers per dimension (backend correctness and #3, security
  of uploads and the switch, statistics integrity, UI against the standard with screenshots, test
  honesty), each finding verified before it is fixed.
- **WP8 Records and docs**: `CHANGELOG.md`, `Journal.md`, `AGENTS.md` (§4 layout, §10 Round 15 is
  the newest, router count), `docs/HANDOFF.md`, `README.md` and `INSTALL.md` (RBAC switch, wizard
  copy, new features), `docs/reference/api.md`, `docs/reference/permissions.md`,
  `docs/reference/configuration.md`, the knowledge corpus (`npm run gen:console-map`, then
  `scripts/build_app_knowledge.py`), refreshed screenshots (§5.3), this SPEC's §8.

### 4.6 Ownership of shared files

| File | Owner |
|---|---|
| `backend/app/models.py`, `config.py`, `constants.py`, `rbac/policy.py`, `audit/*` | WP1 only |
| `backend/app/api/routes.py` | WP1; then WP2 (settings guard, wizard fields), WP5 (cases list filter), by region |
| `backend/app/state.py` | WP3 (Demo seeding call), WP4 (store wiring), WP5 (store wiring and seeding), by region |
| `backend/app/agents/pipeline.py` | WP1 (`_assemble_case`), WP5 (one hook call) |
| `webui/src/soc/registry.tsx` | WP3 |
| `webui/src/soc/router.tsx` | WP3 (`team` route), WP6 (`case_manager` block) |
| `webui/src/soc/pages/casedetail/**`, `CaseManager.tsx`, `CaseDetail.tsx` | WP6, then WP7 |
| `webui/src/soc/components/outcome.ts` | WP5 |
| `webui/src/soc/pages/settings/*` | WP2 (security posture link), WP3 (team switch row), WP5 (detection group), by file region |
| `mkdocs.yml` | WP3 and WP5 add one nav line each; WP8 reconciles |
| `backend/app/knowledge/*.json`, `CHANGELOG.md`, `AGENTS.md`, `HANDOFF.md` | WP8 |

---

## 5. Verification

### 5.1 Tests per package

Each package adds offline tests for every rule it introduces (backend pytest with the fake ES and
the SQLite store; Vitest for the Console). Specific must-haves: D1.2 rules 1 to 6 and D1.3; every
wizard string; the team fold against a hand-built row set (new and legacy shapes, unattributed,
bulk, deleted user, partial at the row cap, window too long, the 409 switch); the image validator
corpus (valid, stripped metadata, trailing bytes, SVG, polyglot, oversize dimensions, animation);
the sampler's determinism, caps and once-per-case rule; the review's no-touch rule (status,
decider, disposition unchanged); `is_review_grade` with and without the entry marker; the
exclusion from `feedback_stats` and `agent_improvement`; the rollback plants; the audit alias
table on all three stores; the carry-over; the `caseOutcome` feedback branch; the G17 fix.

### 5.2 Gates (on the integrated tree)

`pytest -q` (record the count); ruff fatal; `npm run test:strict` (zero stderr); `npm run lint`;
`npm run gates`; `npm run check:types`; `npm run build` (docs plus app; entry within budget);
`npm run docs:check`; `scripts/check_docs.py`; `scripts/build_app_knowledge.py --check`;
`scripts/check_version.py`; `scripts/check_ci_contract.py`; the docs bundle and theme tests.

### 5.3 Screenshots

Light and dark captures from the seeded Demo at 1440 by 900: Case Manager (queue and Overview,
Investigation, Collaboration with Files, the close dialog, a pending review), Team activity (page
and person sheet), Roles & permissions with the switch panel and both dialogs, the wizard AI step
and review step, Agent effectiveness with the review module, Settings Detection review group.
Before captures are kept in the build scratchpad for comparison. Docs screenshots in
`docs/assets/screenshots/` are refreshed where the surface changed.

---

## 6. Documentation

### 6.1 Help Center pages

New: `docs/analyst/team-activity.md`, `docs/automation/auto-close-review.md`. Changed:
`docs/analyst/case-manager.md`, `docs/analyst/cases.md`, `docs/administration/users-rbac.md`,
`docs/administration/settings.md`, `docs/administration/reset.md`,
`docs/getting-started/first-run.md`, `docs/getting-started/install.md`,
`docs/getting-started/quickstart.md`, `docs/reference/api.md`, `docs/reference/permissions.md`,
`docs/reference/configuration.md`, `docs/operations/health-backup.md`,
`docs/releases/known-limitations.md`.

### 6.2 Repository docs

`README.md`, `INSTALL.md`, `DEPLOY.md` (RBAC recipe, nginx upload size), `docs/USAGE.md`,
`AGENTS.md`, `docs/HANDOFF.md`, `CHANGELOG.md`, `Journal.md`, `ROADMAP.md` (§7 items).

### 6.3 Amendments to earlier documents

- `docs/development/ui-standard.md`: the queue row (two lines; status or outcome, never both),
  the queue control band (scope, Filters popover, search), the case header (one meta row; owner
  edited only there), five case tabs.
- Round 14 SPEC §11.1 "Entry bundle" record: updated only if §3.1's ratchet happens.
- The documented RBAC curl recipe (Round 14 follow-up docs) is replaced by `PUT /api/rbac`.

---

## 7. Not built this round

- Audit push-down aggregation for Team activity (ES composite, SQL `GROUP BY`); the fold is exact
  within its bounds.
- Shift-based day buckets for Team activity.
- Full blind review (hiding the AI verdict across the whole case page while a review is pending).
- Reinvestigating a closed case updates it in place (today it creates a second case).
- Lifecycle notifications honouring `triggers.on_closed` and risk floors.
- `first_response_at` written on the first human response.
- `case_activity` and `case_tasks` as opaque rows on Elasticsearch.
- Server-side image re-encoding (no image library is added).

---

## 8. As built

Filled by the orchestrator after integration: contract resolutions, per-package notes, gate
results, entry bytes, known limitations.
