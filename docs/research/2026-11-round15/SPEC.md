# Round 15 SPEC: an RBAC switch, honest setup copy, team activity, and a stronger Case Manager

Status: binding for every Round 15 work package. Owner: orchestrator. Branch: `claude/round15`
(starts at `c4227bd` on `Testing`, which carries Round 14, its follow-ups and the documentation
refresh; reaches `Testing` through a pull request). Version stays `0.1.13` (no `VERSION`
change; `CHANGELOG.md` gets entries under the one `[Unreleased]` section). Revised once after
three adversarial reviews against the code (backend contracts, Console and UI, safety and
statistics); every finding is resolved in the sections below and indexed in Appendix A.

This document replaces nothing in `AGENTS.md`. Where it is silent, `AGENTS.md`,
`docs/development/ui-standard.md`, `docs/development/design-system.md` and the Round 12, 13 and
14 specs stay binding. Every override of those documents is listed in §6.3.

Inputs (the evidence base; read the parts your package cites). Seven code maps and one
completeness critique, written read-only against `b49780c`, are committed beside this file, with
the three review reports:

- `understand/rbac-wizard.md` **[rbac]**: the RBAC model, the settings path, re-auth, the wizard.
- `understand/activity-data.md` **[act]**: the audit log, case data, per-user stores.
- `understand/casemanager-ui.md` **[cmui]**: the Case Manager and case workspace, every test.
- `understand/close-flow.md` **[close]**: the case lifecycle, close flow, ground truth.
- `understand/qa-sampling.md` **[qa]**: where auto-close happens, review design constraints.
- `understand/storage-attachments.md` **[files]**: storing images within the KV rules.
- `understand/platform.md` **[plat]**: registry, entry bundle, routers, docs, CI, Demo Mode.
- `understand/critic.md` **[crit]**: contradictions settled, gaps (G1 to G18), decisions D1 to
  D11, ranked risks. Every headline in [crit] §0 is resolved by a decision below.
- `review/backend.md` **[rb]**, `review/ui.md` **[ru]**, `review/safety.md` **[rs]**: the SPEC
  reviews, cited by finding id (for example [rb] H3, [ru] M5, [rs] 12).

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
   per day, with a permission a SOC manager holds. Two of the operator's sentences describe this
   one surface ([crit] headline 7).
4. **A4 Close flow and screenshots.** A cleaner, stronger close; screenshots on a case.
5. **A5 Auto-close review.** A small, random, auditable sample of automatically closed cases goes
   to a person for review, and their answer is recorded as independent ground truth.
6. **A6 Case Manager redesign.** Less clutter, one home per fact, a calmer queue and header.

---

## 2. Decisions

### 2.1 RBAC switch (A1; [crit] D1, G13, G14)

- **D1.1 Home.** The switch lives on **Roles & permissions** (`#/settings?s=roles`), in a
  "Role-based access" panel at the top that replaces today's "Role-based access is off" callout
  (`Roles.tsx:348-355`, pinned by `roles.page.round14.test.tsx`). The Security posture row
  (**Settings → Security & access → Single sign-on & policy**, Posture, "Role-based access")
  keeps its status text and gains a **Manage** action (`SettingRow variant="status"` with
  `action`) that opens that panel. One save path ([crit] G14).
- **D1.2 Endpoint.** New feature router `backend/app/api/routes_rbac.py`:
  - `GET /api/rbac` (`require_permission("roles", "read")`) returns `RbacStatus`:
    `{enabled, auth_enabled, can_change, blockers: [code], caller_role, super_admin_count,
    role_counts: {role: n} | null}`. `role_counts` only for a caller holding `users:manage`.
    `blockers`: `auth_off`, `not_super_admin`, `read_only_settings`.
  - `PUT /api/rbac` body `{enabled: bool}`. Rules, checked in this order ([rb] L1, [rs] 16):
    1. sign-in off → `409 rbac_auth_required` ("Turn on sign-in first. Role-based access has no
       effect while sign-in is off.");
    2. strict fresh sign-in: a registered session with a known recent re-authentication; a
       missing or unknown session id, or a session-store failure, answers `401 reauth_required`
       (precedent `require_system_update_operator`, `deps.py:1111-1180`; the plain
       `require_fresh_auth()` treats an unknown sid as fresh and is not enough here);
    3. the verified principal's `role` is `super_admin` (`AuthService.verify` returns the stored
       role, `auth/service.py:599-630`; the environment administrator's base record is
       `super_admin`); otherwise `403 rbac_super_admin_only` and an Access denied row
       (`record_access_denied`, `deps.py:902`);
    4. read-only settings mode → `403 "Settings are in read-only mode"`, exactly as
       `PUT /api/settings` (`routes.py:1976-1980`); there is no unlock body;
    5. turning on requires at least one active persisted `super_admin` or a configured
       environment administrator (`auth_admin_username in secrets.auth_user_map()` and no
       persisted user of that name); rule 3 normally guarantees it;
    6. no change → `200 {..., changed: false}`, checked **before** `audited_prefs_write` (which
       appends a row even when nothing changes, `prefs_write.py:160-176`);
    7. otherwise `audited_prefs_write` (action `settings.updated`, target label "RBAC" from
       `settings_target`, `changes=[{field: "rbac.enabled", before, after}]`): audit before
       visible, `409 settings_conflict` after its retries, `503 audit_unavailable`.
  - Demo Mode: allowed; real `Preferences`, `control_audit`.
- **D1.3 Protect the old path** ([rs] 6, [rb] L2). Inside `put_settings._apply`, after the
  read-only gate, compare the validated merged `rbac` block with `current.rbac`:
  - a changed `rbac.enabled` answers `409 rbac_switch_moved` ("Turn role-based access on or off
    in Roles & permissions, or with PUT /api/rbac.");
  - any other changed `rbac.*` field (`roles`, `resources`, `custom_roles`, `denies`,
    `default_role`) additionally requires `roles:manage` (in-body `_enforce`, which writes the
    Access denied row) and a fresh sign-in (the in-body freshness check that `routes_jobs.py:515-536`
    uses). With sign-in off both are no-ops, so `test_runbook_permissions.py:308` and
    `test_settings_roundtrip.py` (which sends an equal `rbac.enabled`) keep passing.
  - The Console never sends `rbac` through `PUT /api/settings` (`rbac` is in
    `CURATED_SECTIONS`), so no Console save is affected.
- **D1.4 Console flow.** The panel shows the state ("On" / "Off: every signed-in account is
  treated as Super admin"), the account count per role when available, and one button.
  - **Turn on role-based access**: `ConfirmDialog` (not destructive). Copy names the effects:
    each account gets its role's permissions on its next request; background jobs started by an
    account that loses a permission stop at their next item; open live streams keep their topics
    until they reconnect; Remember me eligibility follows the role policy; "You stay Super admin."
  - **Turn off role-based access**: `ConfirmDialog destructive`: "Every signed-in account will be
    treated as Super admin, whatever its role."
  - The call goes through the exported `request('PUT', 'rbac', {body, reauthPurpose})` (the
    `api.put` helper cannot carry a purpose, [ru] L5) with `reauthPurpose` "Sign in again to
    change role-based access." On success: `auth.refresh()`, re-run the Roles page `load()`, a
    toast.
  - Disabled with the reason as visible text when a blocker applies.
  - `Security.tsx` passes `useAuth().rbacEnabled` to the Remember-me note instead of
    `rbacEnabledOf(prefs)` so the note is right after the switch ([ru] M7). The note's text does
    not change.
- **D1.5 Remove "no switch" wording**: `Roles.tsx` callout and its test, and every doc in
  [rbac] d (WP2 owns `users-rbac.md` and `first-run.md`; WP8 the rest).

### 2.2 Wizard wording (A2; [crit] D2; [rb] H5; [ru] H4, M1, M12, L11)

- **D2.1 Truthful readiness.** `ai_runtime_ready` is true when both `prefs.router_model` and
  `prefs.investigator_model` (`Preferences.model_for`, `config.py:4613-4623`) can be called:
  - `anthropic`, `openai`: their key is set (`Secrets.provider_key`);
  - `openai_compatible`: `litellm_api_key` or `openai_api_key`, or a resolvable base URL
    (`ModelConfig.base_url`, the registry `base_url_for`, `CustomModelStore.base_url_for`,
    `gateway.py:1254-1264`);
  - `azure`: a key (`azure_openai_api_key` or `openai_api_key`) and an endpoint;
  - `bedrock`: access key id and secret;
  - `vertex`: token and project;
  - `mock`: never ready outside Demo Mode.
  One pure helper `backend/app/llm/readiness.py::ai_runtime_status(secrets, prefs, custom_models)`
  returns `{ready, provider}` with `provider` a token from a fixed enum (`openai`, `anthropic`,
  `openai_compatible`, `azure`, `bedrock`, `vertex`, `mock`).
- **D2.2 Where it is read.** Public `GET /api/setup/status` gains only `ai_runtime_ready: bool`.
  The authenticated `POST /api/setup/secrets` response gains `ai_runtime_ready` and
  `ai_runtime_provider`. The wizard patches both into its status in both `setStatus` calls after
  saving a key (`Wizard.tsx:292-316`). The wizard learns the default provider from the
  authenticated `GET /api/settings` (`investigator_model.provider`) when it can read it, else it
  omits the provider sentence. All three readiness sites change: `Wizard.tsx:275`
  (`hasProvider`), `:1312` (`anyConfigured`), `:1397`.
- **D2.3 Exact strings** (live mode; Demo strings stay, "mock runtime" is true in Demo):

  | Place | New |
  |---|---|
  | `STEPS[2].description` | Add a provider key so the AI agent can investigate cases. |
  | Keys alert, ready (success) | title "Live provider configured" (unchanged), body unchanged |
  | Keys alert, a key present but not usable by the default models (warning) | title "Your key does not match the default models"; body "The default investigation models use {provider label}. Add a key for {provider label}, or choose other models in Settings → Models after launch." (provider sentence omitted when unknown) |
  | Keys alert, no key (warning) | title "No usable AI provider yet"; body "You can continue without a key. Until you add one, the AI agent investigates nothing: new cases wait for a person as Needs human review." |
  | Review readiness row, live, not ready | "No usable provider · cases wait for a person" |
  | Review readiness row, ready | "Configured: {labels of the configured providers}" (all families, not only Anthropic and OpenAI) |
  | Review heading | "Ready for live triage" only when a source exists and `ai_runtime_ready` |

  Provider labels: OpenAI, Anthropic, OpenAI-compatible endpoint, Azure OpenAI, Amazon Bedrock,
  Google Vertex AI. No new string contains "Needs attention" (`Wizard.onboarding.test.tsx:265,
  294`). New tests assert each string and that no live-mode string contains "mock runtime".
  Entry cost about +150 B (Wizard is eager), covered by §3.1.
- **D2.4 Docs.** Remove every "Known issue in 0.1.13: the mock runtime wording" note and the
  README/INSTALL mentions ([rbac] e.2); re-capture `install-05-setup-ai-runtime.webp` and
  `install-06-setup-review.webp` in WP8.

### 2.3 Team activity (A3; [crit] D3 to D6, G9 to G12; [rb] H3, M11, L5, L11; [rs] 13, 17, 24, 25, 28; [ru] M5, L1 to L3, L13)

- **D3.1 One surface.** **Team activity**, a child of **Analytics** placed second (Metrics,
  Team activity, Agent effectiveness, Cost, Models, Baseline, Jobs). Page id `team`, route
  `#/team`, page title "Team activity" (`nav-titles.round14.test.ts` gets
  `team: ['pages/TeamActivity.tsx']`; `console-map.contract.test.ts` `PAGE_KEYWORDS` gets `team`
  keywords such as "team activity", "analyst work", "who did what"). The page wraps its body in
  `PageAccess resource="team" action="view" title="Team activity"` (Round 14 roles-02).
- **D3.2 Permission.** New resource `team` with one action `view`, default for `soc_manager` and
  `auditor` (`super_admin` automatic). This answers "i hope we have a role for that": a **SOC
  manager** tracks the team, an **Auditor** may read it, analysts do not. Mirrors: `RESOURCES`,
  `_SOC_MANAGER`, `_AUDITOR`, `Roles.api.ts RESOURCE_ACTIONS`, truth tables,
  `docs/reference/permissions.md`, `users-rbac.md`. A stored `rbac.roles` override replaces only
  the resources it names (`_merge_grants(additive=False)`), so upgraded installs get the default
  (WP1 pins it with a test).
- **D3.3 Privacy floor while RBAC is off** ([rs] 17). With role-based access off every account
  holds every grant, so the team routes additionally require a stored role of `super_admin`,
  `soc_manager` or `auditor` (`principal.role`) while RBAC is off; otherwise
  `403 team_activity_role_required` with an Access denied row. The page also shows a warning
  `Callout`: "Role-based access is off. Only Super admins, SOC managers and Auditors can open
  this page until it is on." with a link to Roles & permissions.
- **D3.4 Operator switch.** `Preferences.team_activity.enabled` (default `true`). WP3 adds a
  "Team activity" group with one switch row ("Team activity page") after Posture in
  `settings/security.tsx`, adds `team_activity` to `CURATED_SECTIONS`
  (`advanced-schema.tsx:55-84`, with a test like `advanced-schema.test.tsx:129`), to the
  `security` section's `ownedKeys` and a `SETTING_ANCHORS` entry. Off: the team routes answer
  `409 team_activity_off`; the page shows `unavailable` naming the switch.
- **D3.5 Privacy and incentives** ([crit] G9). Counts with context; no ranking badge,
  leaderboard, "top performer" or composite productivity score. Columns may be sorted; the
  default order is by name. Never an IP address, user agent, session or settings row on this page
  (the Audit log keeps those under `audit:view`). Retention follows audit retention. Sign-in off:
  `unavailable` "Sign-in is off, so work cannot be attributed to people." Review counts sit
  beside close counts.
- **D3.6 Source of truth: the audit log** ([act] §7). Exact fold over the audit rows in the
  window; no KV counter projection; no push-down this round (§7).
  - The fold streams `search_page` inside its snapshot. WP3 adds a `count: bool = True` option
    to `search_page` on the audit stores (ES `audit_log.py`, SQL repository, base fallback) so
    later pages skip the exact `COUNT` ([rb] M11).
  - Bounds: window at most 92 days (`422 team_window_too_long`); at most 250,000 rows scanned;
    an ES offset-paged cursor (no point in time) or the third-party fallback that reaches its
    10,000-row limit marks the answer `partial` with "at least" counts.
  - The result is cached per viewer and window for 60 seconds.
  - Demo Mode ([rb] L11): case-work counts come from the Demo audit only; sign-ins come from the
    control audit. The page says "Demo Mode: showing Demo work."
- **D3.7 Day.** Calendar days in the operator zone (`SlaPolicy.timezone`, `time_windows`). The
  zone is named in a help tip (not a `PageHeader` description, which the grammar guard bans).
- **D3.8 What is counted per person** (window and per day), from these row kinds only:
  - acknowledged; closed, split by disposition (true positive, false positive, benign,
    duplicate, other); reopened; escalated; commented; assigned (as the actor); screenshots
    added; auto-close reviews completed (agreed, disagreed); runbook steps completed (a row whose
    `changes` hold `steps.<id>.status` with after `done`, across `step.updated`,
    `step.decision_recorded`, `step.action_recorded`, `step.approved`); sign-ins;
  - "of which in bulk jobs" for each lifecycle count (rows whose `run_id` starts with `bulk-`);
  - last active (latest counted row);
  - median time to acknowledge: for cases this person acknowledged first (human only) in the
    window, acknowledgement time minus `metrics._created_dt(case)` (the metrics MTTA rule), read
    through `get_many`, exact up to 5,000 such cases, else `partial` and omitted ([rs] 25);
  - reviews: "N of M agreed" always; an agreement rate only when M is at least 30; "Time spent
    reviewing" (median client-measured `elapsed_ms`) and, labelled separately, "Time to review"
    (sampled to completed) ([rs] 9, 24).
- **D3.9 People** ([rb] H3, [rs] 13). The fold keys people by `actor.strip().lower()` (the user
  store's `_norm`). `GET /api/team/people` (under the team gate) returns a narrow projection:
  username, display name, role, active, `kind`:
  - `account` (user store), `environment` (keys of `Secrets.auth_user_map()` with no persisted
    record; labelled "Environment account"), `demo` (`DEMO_SOC_ANALYSTS` while Demo Mode is on;
    labelled "Demo analyst"), `deleted` (seen in rows only; "Deleted account");
  - legacy rows whose actor is `analyst`, `default` or empty are grouped as "Not attributed"
    ("Recorded before sign-in attribution, or with sign-in off."), with no events link.
  People with no rows in the window appear with zeros.
- **D3.10 Endpoints** (`api/routes_team.py`; every route `require_permission("team", "view")`
  explicitly, plus D3.3 and D3.4):
  - `GET /api/team/activity?window=<time_windows token>` → `TeamActivity`
    `{window, timezone, days: [iso date], people: [PersonActivity], team: Totals, exact,
    partial_reason, scanned_rows, auth_enabled, rbac_enabled, demo}`.
  - `GET /api/team/people` → roster.
  - `GET /api/team/people/{username}/events?window=&cursor=&limit=` → events
    `{ts, kind, label, case_id, case_number, detail}`, newest first, signed cursor, at most 200
    a page. The query matches every spelling of the actor seen in the window (`In("actor",
    variants)`). Only D3.8 kinds appear. `label` is server-worded; `detail` is built from
    structured fields only (case number, disposition, actions taken), never from
    `result_summary`, `client` or `session_ref` ([rs] 28). Case titles are untrusted strings
    rendered as text nodes.
  - Reads write one coalesced `team.viewed` row per viewer per 10 minutes. WP1 parameterises
    `audit/views.py` `ViewRecorder` with `action`, `surface` and `window` ([rb] M7.4).
- **D3.11 Page** (lazy `webui/src/soc/pages/TeamActivity.tsx`; calls in lazy
  `lib/api-team.ts`; types in type-only `lib/types-team.ts`):
  - `PageHeader` with a range control: presets Today (`today`), Yesterday (`yesterday`), Last 7
    days, Last 30 days (whole calendar days in the operator zone), mapped to `window` tokens by
    the page itself (never `resolveRange`, which speaks ES date math), and a page-local Custom
    range following `AuditCustomRange` (`AuditFilters.tsx:447`), at most 92 days ([ru] M5).
  - One KPI strip: people active, cases closed by people, acknowledged, reviews completed, median
    time to acknowledge.
  - A per-day stacked bar chart of at most seven kinds (closed, acknowledged, commented,
    reviewed, escalated, reopened, other), recharts `stackId` inside the lazy chunk, the
    Okabe-Ito ramp, a legend and a tooltip.
  - A `DataTable` of people; a person side `Sheet` (`SPRING_PANE`) with their per-day table,
    review counts and the paged events with case links and, for a viewer with `audit:view`,
    "Open in Audit log" (`#/audit?actor=<username>`).
  - Honest states: `partial` shows a visible caveat; empty windows show `no-data`.
  - Client "Download CSV" of the people table through `webui/src/lib/csv.ts` (`csvField`,
    formula defusal; display names are user text).
- **D3.12 Demo Mode** ([crit] C8). Seeding writes backdated Demo audit rows (`record_strict`
  with `ts=`, `outcome` and `actor_type` set, registered in `_SPLAT_PRODUCERS` if splatted,
  [rs] 12) for the seeded human work by `DEMO_SOC_ANALYSTS`, matching the seeded cases'
  `status_history` times: acknowledgements, closes with dispositions, comments, assignments and
  the seeded reviews (§2.6). Wrapped so a failure never blocks Demo enable.

### 2.4 Close flow (A4; [crit] D7, G5, G7, G8; [rs] 1, 5; [ru] H1, H3, M3, M11)

- **D4.1 One classification question.** The close dialog asks "what was it" once: the
  disposition (required, empty until chosen, `disposition_declared: true`). The separate "What
  actually happened?" select and the overlapping Resolution select leave the dialog. The wire
  stays: `close_disposition` maps to `close` (`wireAction`).
- **D4.2 Actions taken** (structured, optional). Additive `CaseAction.actions_taken:
  list[str] | None` from a fixed vocabulary (`constants.py`), at most 8, unknown values `422`:
  `no_action_needed, blocked_indicator, isolated_host, disabled_account, reset_credentials,
  removed_malware, patched_or_hardened, notified_owner, escalated_externally, tuned_detection,
  other`. Stored on the `analyst_action` history entry and in the new structured audit row's
  `changes`. The Collaboration History reads `case.history` `analyst_action` entries and shows
  the actions under the matching lifecycle event (the activity endpoint is unchanged, [ru] M8).
  Also in the case Markdown export. Never model text.
- **D4.3 Note.** Optional, except the Console requires it when
  `deriveAgreement(verdict, disposition).kind === 'override'` (`grading.tsx:203-225`). A Needs
  human review resolution and a duplicate never require it. Inline reason: "Say why you
  disagree with the AI. Your note is kept as precedent for future investigations." The backend
  is unchanged. The `DURABLE_CONTEXT_NOTE` disclosure stays.
- **D4.4 Grading keeps today's rule** ([rs] 1, [ru] H1, H3). On a close, resolve or
  set_disposition whose disposition matches or overrides the AI verdict, the Console posts one
  feedback entry with the derived assessment, with or without stars, exactly as today
  (`CaseDetail.tsx:1257-1282`, `CaseDetail.grading.test.tsx:114-155` keeps passing). Stars and
  "What did the AI miss?" sit in a collapsed "Rate the AI (optional)" disclosure. The computed
  agreement is shown as text ("Your classification agrees with the AI"), never asked. The Console
  **never** sets `actual_outcome` from the disposition: the declared disposition already labels
  the case (`explicit_analyst_disposition`), and a feedback label would pin ground truth against
  later reclassification.
- **D4.5 Unrated stars** ([rb] L6, [rs] 20). `feedback_stats` averages each sub-score over the
  entries that rated it (value above 0; Console stars map to 0.2 to 1.0) and returns
  `accuracy_rated`, `reasoning_quality_rated`, `action_appropriateness_rated` counts; an average
  stays `0.0` when nothing was rated; the chat feedback tool shows "not rated" when the count is
  0. Documented: 0.0 from an API caller means unrated. The stored shape does not change.
- **D4.6 Tags and screenshots.** Tags leave the close dialog (edited in the facts rail).
  Screenshots join it: an "Add screenshots" drop zone uploading each file at once through the
  files API (§2.5). The close never waits for or rolls back an upload; uploads stay allowed on
  closed cases. No "evidence required" gate. `BulkCloseDialog` keeps its shape, without
  screenshots (its help text says so).
- **D4.7 Agent-closed cases** ([crit] G5, [rs] 5). On a case whose first decision record
  (`metrics.decision_record`, first anchor) is an agent close and which is terminal, the Console
  offers **Review this auto-close** (§2.6) and hides Set disposition. Bulk set_disposition and
  set_status in Case Manager and Cases leave such cases out (the help text says "Cases the AI
  agent closed are left out; review them instead."). The backend verbs are unchanged.

### 2.5 Screenshots (A4; [crit] D9, G4, G15; [files] §7; [rb] H4, M9, L13; [rs] 14; [ru] L4, L10)

- **D5.1 Storage** (#12, KV only): namespace `case_files`; documents:
  - `case:<case_id>` per-case index (strict CAS, opaque `case_file_index_json`, at most 20 live
    entries);
  - `blob:<file_id>` and `thumb:<file_id>` write-once content, created with `_rev: 1` through
    `put_if_strict(..., expected_rev=0)` so a second create fails ([rb] L13);
  - optional `usage` org totals (strict CAS).
  Every document carries `case_file_store: "case_files"` (counted in the six-field budget) so
  the cases-tier reset can find it on ES. Never on the `Case` document; never a `CaseActivity`
  entry ([crit] G4).
- **D5.2 KV delete.** WP4 adds `delete_strict(namespace, key)` to `EsKVStore` and `SqlKVStore`
  ([rb] M9). File delete marks the index entry deleted (metadata tombstone kept), deletes the
  `blob:` and `thumb:` documents and updates `usage`.
- **D5.3 Limits**: PNG, JPEG, WebP only, by magic bytes; 2 MiB decoded per image after
  stripping; at most 8,192 px a side and 40 megapixels (headers only); 20 images and 20 MiB per
  case; 2 GiB per organisation (`409 case_files_storage_full`); Demo Mode and the in-memory store
  fallback: 64 MiB in total and 5 images per case ([rs] 14); 30 uploads per minute and 2
  concurrent per user (`429 case_files_busy`, `Retry-After`); caption at most 200 characters,
  filename at most 120, plain text; thumbnails at most 48 KiB.
- **D5.4 Validation** in pure stdlib `backend/app/engine/case_images.py` as [files] §7.3. The
  server does not decode pixels; the limitation is documented.
- **D5.5 API** (`api/routes_case_files.py`): `GET /api/cases/{id}/files` (`cases:read`);
  `POST /api/cases/{id}/files` (`cases:comment`; JSON base64; a bounded route class capping the
  request at 3 MiB, the `_RunbookRoute` precedent; SHA-256 dedup on the case returns the existing
  entry); `DELETE /api/cases/{id}/files/{file_id}` (`cases:comment`, and the uploader or a
  `cases:close` holder, Access denied row on refusal); `GET /api/cases/{id}/files/{file_id}/
  content?variant=full|thumb&download=1` (`cases:read`, `get_strict` so an outage is 503, the
  strict headers of [files] §7.4). Explicit `require_permission` on every GET.
- **D5.6 nginx**: a regex location for `^/api/cases/[^/]+/files$` with `client_max_body_size
  3m` and the same proxy headers and timeouts as `/api/` (the frozen base covers only the
  Compose file).
- **D5.7 Elasticsearch mapping** ([rb] H4). Fresh installs create `CONFIG_INDEX` with
  `{"dynamic": true, "properties": {"case_file_data": {"type": "binary"}}}`
  (`es/indices.py:405-407`). Upgrades: WP4 adds `get_index_mapping` and `put_index_mapping` to
  `BaseESClient` and `ESClient` and puts the new-field mapping at bootstrap before the first
  write. If that fails or the field already exists as text, writes still work; the indexing cost
  is stated in the docs.
- **D5.8 Prerequisite fix**: `factory_purge_strict` must not load every KV value into memory on
  either backend ([files] §6.1); a test fails on a full-source read of a non-protected document.
- **D5.9 Lifecycle**: cases-tier reset clears the namespace (receipt `kv:case_files:<n>`);
  factory reset purges it; data export lists metadata per case and excludes the bytes with an
  `_EXCLUDED` line; user deletion keeps evidence.
- **D5.10 Audit**: `audited_write` with `case.file_attached` and `case.file_deleted` (failures
  `case.file_attach_failed`, `case.file_delete_failed`), target the case, `changes` naming the
  file. `result_summary` carries ids and codes only, never a filename or caption: the chat
  `audit_search` tool forwards `result_summary` to the model ([rb] M3, [rs] 2).
- **D5.11 Never to a model** (#9, #3): no chat tool, report digest, standup, starter, RAG chunk
  or investigator prompt reads the store or its captions. Static import bans in §3.6. A sentinel
  test proves a caption and filename never reach a gateway prompt, including through
  `audit_search`.
- **D5.12 Console**: a **Files** section in the Collaboration tab (thumbnail grid; caption,
  uploader, time; a Radix `Dialog` lightbox that always renders a `DialogTitle`, visually hidden
  when needed, falling back to "Screenshot N of M"; download; delete with confirm for the uploader
  or a moderator); paste while the Collaboration tab or the close dialog has focus, drag and
  drop, a file picker. Canvas helpers live in the lazy kit, never in the entry `lib/avatar.ts`.
  Re-encode: downscale to at most 3,840 px, PNG then WebP 0.92 then JPEG 0.9 until under 2 MiB,
  then step down to 2,560 and 1,920 px, then refuse with a message. Content is fetched with the
  exported `requestResponse` (`api.ts:657`) as a blob, revoked on unmount. Demo Mode: allowed
  in the Demo KV within the Demo caps.

### 2.6 Auto-close review (A5; [crit] D8, G2, G3, G5, G6, G16; [rb] M1, M4, M7.5, M10, M12, L4, L8, L9; [rs] 3, 4, 7, 8, 9, 10, 11, 21, 23, 24, 26)

- **D6.1 What.** A deterministic, seeded, capped sample of the cases the agent closed
  automatically is queued for a person to classify. Their answer is recorded as an independent
  `FeedbackEntry` and becomes ground truth; the case's status, decider and disposition do not
  change unless the person reopens it.
- **D6.2 Config** `Preferences.auto_close_review` (`AutoCloseReviewConfig`): `enabled: true`,
  `sample_rate: 0.05` (0 to 0.5), `daily_cap: 10` (0 to 200), `per_rule_daily_cap: 3` (1 to 50),
  `expiry_days: 7` (1 to 30). Clamped on load; a body-level
  `_reject_out_of_range_auto_close_review(body)` in `put_settings`, beside
  `_reject_out_of_range_caps`, answers `422` on write (WP1). Default on (#10). No autopilot
  version bump. Settings home: **Settings → Detection**, an "Auto-close review" group beside the
  auto-close bars; key in `CURATED_SECTIONS` and the section's `ownedKeys`.
- **D6.3 Sampler.** `backend/app/engine/auto_close_review.py` (pure selection: score
  `sha256("auto-close-review:v1:" + case_id)`, first 8 bytes over 2^64; selected when `score <
  sample_rate`, the day's count is below `daily_cap` and the rule's count
  (`precedent.case_rule_identity`) is below `per_rule_daily_cap`; day in the operator zone).
  - Called through a post-settable pipeline attribute `pipeline.review_sampler` (like
    `runbook_attacher`, `pipeline.py:316`), invoked after the existing post-decision hooks
    (`pipeline.py:1203-1222`) for a terminal case with `decision_by == agent`. It is `None` in
    the replay stack (`engine/replay/stack.py:563`), so replay never samples. The Demo pipeline
    (`engine/demo_runtime.py`) gets the Demo sampler.
  - Analyst policy closes return earlier and are never sampled.
  - Once per case while its ledger entry is kept; after ring eviction a re-closed case may be
    re-selected (documented). No backfill: sampling starts with the first decision after upgrade.
  - Fail-soft: an error logs a warning and never touches the case.
- **D6.4 Ledger** (#12): namespace `auto_close_review`, one strict-CAS document `ledger` with
  fields `acr_store`, `acr_schema`, `acr_json` (canonical opaque JSON: a ring of at most 2,000
  entries `{review_id, case_id, case_number, rule, sampled_at, day, score, state, reviewer,
  completed_at, classification, agrees, ai_verdict, elapsed_ms}` and per-day sampled counts,
  overall and per rule, for 90 days). Written only when a case is sampled or reviewed. States
  `pending`, `completed`; `expired` is computed on read. Eviction drops the oldest completed or
  expired entries first. Demo instance over the Demo KV. Cases-tier reset clears it (receipt
  `kv:auto_close_review:<n>`); factory reset purges it; data export includes the ledger
  metadata ([rs] 26).
- **D6.5 Sample audit.** One `case.review_requested` row per selection (actor `system`,
  `actor_type` system, exact catalog entry in category **`system`** so it lands in Agent
  activity, [rb] M1, [rs] 7) with score, rate, the day's counts and the rule in structured
  fields; `result_summary` carries ids and codes only. One SSE frame on `cases:{id}` and `cases`
  so open queues refresh their review count.
- **D6.6 Recording a review.** `POST /api/cases/{id}/review` (`cases:write`) with body
  `{classification: "true_positive"|"false_positive"|"benign"|"unsure", note: str (at most
  1,000), accuracy, reasoning_quality, action_appropriateness: optional floats gt 0 and le 1,
  elapsed_ms: int | None (0 to 86,400,000)}`.
  - Accepted when the case is terminal and its first decision record is an agent close, else
    `409 review_not_agent_closed`. A second review of a completed ledger entry answers
    `409 review_already_recorded`. An unsampled agent-closed case may be reviewed (D4.7); that
    review is an ordinary grade.
  - Order ([rb] M10, [rs] 23): audit row `case.review_recorded` first (failure
    `case.review_record_failed`; `result_summary` ids and codes only), then re-fetch the case and
    save it with one appended `FeedbackEntry` (`analyst` = verified principal; `actual_outcome`
    mapped true positive → `true_positive`, false positive and benign → `false_positive`, unsure
    → `unknown`; `assessment` computed against the snapshotted AI verdict, `agree` or
    `disagree`, empty for unsure; `comment` = the note), then the ledger CAS (logged and retried
    once on failure; the review stands; a later read repairs the ledger from the case's history
    event).
  - **Only when the case is in the ledger**: the entry gets `origin = "auto_close_review"` and
    `review_id`, and the case gets one `history` event `{event: "auto_close_review", review_id,
    feedback_ts, analyst, ts, agrees}` ([rs] 3). Otherwise both stay empty and no history event
    is written.
  - Never sets `status`, `decision_by` or `disposition`. Indexes the resolved case as the feedback
    route does, so the note becomes fenced untrusted precedent text like any grading comment (#9)
    ([rb] M2, [rs] 2).
  - Response: `{agrees, can_reopen}` (`can_reopen`: the caller holds `cases:close`).
- **D6.7 Rollback-safe marker** ([crit] G3). `FeedbackEntry` gains `origin: str = ""` and
  `review_id: str = ""`. A previous build drops them on its next full save but keeps `history`
  dicts. `engine/review_origin.py::is_review_grade(case, entry)` is true when `entry.origin ==
  "auto_close_review"`, or when a history event `auto_close_review` with a non-empty `review_id`
  matches the entry's `ts` and `analyst`. Every consumer below uses it; the Console has a
  TypeScript mirror `isReviewGrade` ([rs] 21).
- **D6.8 What a review grade feeds** ([rs] 10). Included as ground truth:
  `analyst_confirmed_outcome`, the threshold tuner, the precedent corpus, `ground_truth_supply`
  (FP reviews can promote precedent; documented). **Excluded** from `feedback_stats`, the
  `agent_improvement` comparisons, and `_agent_reopen_summary` (a reopen whose same-timestamp
  `analyst_action` history entry carries `review_via`). Never a `PROVENANCE_COUNT_KEYS` entry,
  never a `PrecedentWindowConfig` field.
- **D6.9 Disagreement** ([rb] H1, L8, L9; [rs] 11).
  - The review is always recorded. A reviewer with `cases:close` is offered **Reopen case** and
    **Reopen and escalate** (two calls: `reopen`, then `escalate`; if the second fails, the case
    stays reopened and the card says so). Both carry a new additive
    `CaseAction.review_via: Literal["auto_close_review"] | None` (any other value `422`), recorded
    on the history entry and the audit row's `changes` only. It never sets the internal `via=`
    parameter of `_perform_case_action` and is never read by the open-steps logic; bulk bodies do
    not accept it.
  - Nothing reopens automatically.
  - A reviewer without `cases:close` sees "Someone who can close cases has been asked to look at
    this." and the backend sends one Inbox item per disagreement to holders of `cases:close`
    through a new parameterised `eligible_audience(state, resource, action)` (generalising
    `eligible_batch_audience`, at most 200 recipients), category `assignment`, honouring each
    recipient's category preference.
- **D6.10 Carry-over on reinvestigation** ([crit] G2; [rb] M4; [rs] 4). One shared helper
  `_carry_case_work(existing, new)` in `agents/pipeline.py`, used by `_assemble_case`,
  `_fail_to_human_case` and `_register_candidate_locked`, carries `assignee`, `comments`,
  `feedback`, `status_history` (appended to), `acknowledged_at`, `status_reason`,
  `notifications_sent`, and the disposition only when
  `analyst_outcomes.standing_analyst_disposition(existing)` is not None. `status` is carried
  only as `apply()`'s previous status (as the analyst-policy path does,
  `pipeline.py:1382-1383`), so the appended transition names the real previous status.
  `escalation_level` is not carried. `decide()` is untouched; `apply()` fills `disposition`
  only when it is `None`, so a carried analyst disposition survives a re-verdict. A behaviour
  change, stated in the CHANGELOG. The review card never offers Reinvestigate on a closed case.
- **D6.11 Blindness.** Not a full blind review. The card asks the reviewer's own classification
  with no preselection before it shows "Compare with the AI", and measures `elapsed_ms` from
  opening the card to submitting. Team activity shows "N of M agreed" and the time spent per
  reviewer.
- **D6.12 Where it shows.**
  - **Case Manager**: a fourth scope **Review** with a pending count badge, backed by
    `GET /api/cases?review=pending|completed|disagreed|expired`: the route reads the ledger's case
    ids, fetches them through `_queue_cases_by_id` (`get_many`; ES `terms`, SQL `IN`), applies the
    other queue filters in Python, then sorts, pages and counts, and echoes `review_applied`
    ([rb] L4). Review behaves like All for the status options; a `cases` frame in Review scope
    re-reads the window ([ru] L14). Default `review=pending`; a "Show completed reviews" link in
    the list footer switches to `completed`; `disagreed` and `expired` are deep links. Deep link
    `#/case_manager?review=pending` (`NavOpts.review`).
  - A pending case shows a band under the header: "Picked at random for auto-close review.
    Classify it yourself, then compare with the AI." with **Start review** as the primary action.
    A completed review shows its result in the facts rail Outcome section.
  - `GET /api/auto-close-review/summary` (`cases:read`): `{enabled, pending, disagreed_open,
    sampled_today, daily_cap}`.
  - **Agent effectiveness**: an "Auto-close review" module from
    `GET /api/metrics/auto-close-review?window=` (`metrics:view`): sampled, reviewed, pending,
    expired; agreement with a Wilson 95% interval when at least 30 reviews, else "Not enough
    reviews yet"; missed threats (reviewer said true positive on an automatic false-positive
    close) with case links; per-rule table (top 10); median time spent; the eligible count of
    automatic closes by first agent decision day (`metrics.decision_record`). The module states:
    "Agreement describes the sampled cases only, unweighted. It is not an estimate of auto-close
    precision." ([rs] 24). Never a composite.
  - **Team activity**: reviews per person (D3.8).
  - **`caseOutcome`** gains `OutcomeSource` `review`, applied only to `isReviewGrade` entries on
    agent-decided cases: agree renders "Reviewed: {label}", disagree "Review disagreed:
    {label}". Ordinary feedback labels keep today's rendering (the divergence from the backend
    authority for ordinary feedback labels is recorded in §7) ([ru] M9, [rs] 21).
- **D6.13 Demo Mode.** Seeding samples about six seeded automatic closes: three pending, two
  completed and agreeing, one completed and disagreeing (FeedbackEntry, history event, ledger
  entries and Demo audit rows by Demo analysts).

### 2.7 Audit rows for human case work (foundation for A3, A5; [crit] G1, G11; [act] §7; [rb] M5, M6, L3; [rs] 12, 15)

- **D7.1 Structured actions on new rows** (no backfill, #2). `_perform_case_action` rows:
  `case.acknowledged`, `case.closed`, `case.fp_confirmed`, `case.resolved`, `case.reopened`,
  `case.escalated`, `case.deescalated`, `case.held`, `case.resumed`, `case.disposition_set`,
  `case.status_set`. Collab rows: `case.assigned`, `case.tagged`, `case.commented`. Feedback rows:
  `case.graded`. Each also gets `target={type: "case", id, label: case_number}` and the request
  context (`audit_context(request).record_fields()` when a request exists). `action_type`,
  `surface` and `result_summary` stay byte-identical. Every audit call passes `outcome` and
  `actor_type` (`test_audit_writer_outcomes.py:1371-1424`).
- **D7.2 Attribution fix.** Comment, tags and assign take the audit actor (and the
  `history[].analyst` of the "assigned" entry) from the verified principal when the request has
  one, else the body or caller value (jobs pass `job.actor`, verified at submit). Reinvestigate:
  only the name inside `result_summary` changes; `actor` stays `reinvestigate`. Older rows cannot
  be re-attributed (D3.9 groups them).
- **D7.3 Bulk marker.** `run_id` = the existing `batch_id` (`bulk-<job_id>` in the
  `case_lifecycle` job, `bulk-<id>` in `POST /api/cases/bulk`; the `case_assign` and `case_tag`
  jobs stamp `bulk-<job_id>`), carried through a private helper or contextvar, never a route or
  query parameter. Legacy rows are never bulk. The `AuditDoc.run_id` comment is updated
  (`inv-`, `run-` or `bulk-`).
- **D7.4 Legacy filter compatibility** ([crit] G1). `audit/query.py::event_predicate` gains a
  family-to-actions alias table (one place; the ES, SQL and Python compilers interpret the same
  predicate tree): `status` also matches the new lifecycle actions, `collab` matches
  `case.assigned|tagged|commented`, `feedback` matches `case.graded`. A test per store holds one
  old-shape and one new-shape row per family.
- **D7.5 Event catalog.** Exact entries in `audit/event_categories.json` and the mirror in
  `webui/src/soc/components/audit/events.ts` for every Round 15 action: `case_work` for the case
  actions above and `case.file_*` and `case.review_recorded*`; `system` for
  `case.review_requested`; `access` for `team.viewed`. `_BASE_VERBS` already covers the failure
  names.
- **D7.6 Failure semantics unchanged.** Lifecycle and collab rows stay best-effort after the
  save; Team activity says counts come from the audit log. New writers this round (files,
  reviews) are audit-first.

### 2.8 Case Manager redesign (A6; [crit] D10, G17; [cmui] §6, §7; [ru] H2, H5, M3, M4, M10, L6, L8, L9, L12, L15, L16)

Target, against today's clutter ([cmui] §2.4, §6): about 11 controls above the first queue row,
three-line rows with nine facts, a header with up to 22 tab stops, seven tabs, ten rail sections,
facts repeated two to five times.

- **D8.1 Queue pane.**
  - Control band, two rows: row one, the scope `SegmentedControl` (Active, Mine, Review with its
    count, All) and a view menu (Sort, density) outside the filter count; row two, a `FilterBar`
    with the search and `primaryCount={0}` (Severity, Status, Closed by behind its "Filters (n)"
    control, chips and Clear all, as `ui-standard.md:403-414` requires). Live and Refresh stay in
    the page header.
  - "Select visible" is the checkbox at the start of row two for bulk roles only; the selection
    count appears in the bulk bar only. The scope line ("1 of 68 active · 50 loaded") moves to the
    list footer beside Load more.
  - Rows are two lines: line one, title (one line, full value accessible) and age; line two,
    severity word (glyph and word; the 3 px rail reinforces it), "Risk N", case number, then
    **status for an open case or the outcome badge for a terminal case, never both**, and the
    owner monogram at the end. The primary fact and the runbook chip leave the row. The chat
    activity glyph stays. Risk bands use `scoreBand` (the queue's cut-offs already equal it).
    Compact density keeps one line.
- **D8.2 Header.** Line one: the title (one line, never squeezed), then one primary contextual
  action, **Take action** (every other verb), an overflow menu (copy link, open in new tab), and
  below 60rem the **Details** button. Line two, one meta row: case number with copy, severity,
  status or outcome, the AI verdict chip, owner (its one editable home), opened age, SLA while
  open. Tags, campaign, risk info, Ask AI and the Demo badge move to the facts rail; `T` and
  "Edit tags" open the Details sheet first when the rail is hidden ([ru] M4). About 10 tab stops
  before the tabs. Primary action per state ([ru] M3):

  | State | Primary | Notes |
  |---|---|---|
  | new | Acknowledge | |
  | open, investigating, needs_human | Close case | Escalate moves to Take action; the secondary Close button goes; `C` still opens the close dialog |
  | on_hold | Resume | |
  | escalated | Mark resolved | |
  | resolved | Close case | |
  | terminal, agent-closed, pending review | Start review | Reopen in Take action |
  | terminal, agent-closed, no pending review | Reopen | Review this auto-close replaces Set disposition in Take action |
  | terminal, otherwise | Reopen | |

- **D8.3 Tabs: five** ([ru] H2, H5). Overview, Runbook, Investigation, Collaboration, Chat.
  `CASE_TABS = ['overview', 'runbook', 'investigation', 'collab', 'chat']` (Runbook stays second,
  so Alt+2 is still Runbook and its "Runbook 4/11" trigger chip stays). Legacy deep links:
  `case-tabs.ts` adds `LEGACY_CASE_TABS = {timeline: 'overview', threat: 'investigation'}`; the
  router's `case_manager` `tab` validator accepts both sets; `redirectRoute` rewrites a legacy
  value with `replaceState` and carries an in-memory section request (`NavOpts.section`);
  CaseDetail scrolls to `[data-section="what-happened"]` or `[data-section="threat-context"]`.
  Stages load when Overview opens; threat context loads when Investigation opens. OverviewPanel's
  `OverviewTab` type and its `onOpenTab('timeline'|'threat')` calls are updated. Alt+1 to Alt+5;
  every "Alt 7" label and comment is updated (`CaseDetail.tsx:146, 1430, 1801`,
  `CaseManager.tsx:622`, `case-tabs.ts:7`, `docs/USAGE.md:553`). A test proves an old link keeps
  its `caseId` and lands on the new tab and section.
  - Overview: the AI summary in two or three sentences, "What happened" (the stage timeline,
    formerly the Timeline tab), key entities, nothing the header or rail already shows.
  - Runbook: unchanged.
  - Investigation: AI assessment (the model's reading only; no fallback to the code's
    `decision_rationale`, G17, pinned by a test), the decision card (the authority sentence once),
    Threat context (formerly its own tab), inputs, the trace (collapsed).
  - Collaboration: Thread, Files (D5.12), Tasks, History (lifecycle with who, when and actions
    taken). No owner picker.
- **D8.4 Facts rail.** Eight sections, hairline-divided, no icon headings: Outcome (outcome of
  record, AI verdict and confidence, decided by, objection window, review result), Signal (risk
  meter, severity provenance, priority), Runbook (kept, Round 14 §4.10.11), Times (opened,
  acknowledged, SLA, closed), Tags (editable) and campaign, Source and primary entity, Related
  cases, Record. Each fact has one home across header, rail and tab bodies.
- **D8.5 Visual rules** ([cmui] §7): tokens only; no `Card` inside a `Panel` (`PanelCard` leaves
  the case files); no `tracking-tight`; underline `Tabs` (`TabsList variant="underline"`, 13 px
  labels, no icons); one 16 to 24 px rail shared by header, tabs and panels; content text at
  least 12 px; `text-2xs` only for badges and timestamps; `SPRING_UI` and `SPRING_PANE`; reduced
  motion; WCAG AA in both themes; the console-grammar guard has zero allowances for these files.
- **D8.6 Kept contracts.** Server-backed queue; roving focus (J/K, arrows, X, Space, Shift, Enter
  to `[data-case-title]`, `/`, `?`, Esc); focus after dialogs (`resolveDialogFocus`, "Close &
  next"); selection only for bulk roles; durable bulk jobs; the `closedBy` chip; the Sheet host
  for the Overview dashboard and Investigate with the same layout.
- **D8.7 Dead code removed**: panel `'default'` presentation branches (tests that loop both
  presentations move to the one), unused `close` and `confirm_fp` action defs (history reads of
  `confirm_fp` stay), `HeadlinePanel`, `BriefChip`, stale "footer" comments (the test file is
  renamed `CaseDetail.header-actions.test.tsx`), `BULK_DISPOSITIONS` in `CaseManager.tsx`.
- **D8.8 Docs**: `docs/analyst/case-manager.md` (keep the `work-the-runbook` and `keyboard`
  anchors and the "Work the runbook" second chunk that `test_app_knowledge.py:1338-1341,
  1427-1430` pins), `docs/analyst/investigation.md` (runbook tab text), `docs/analyst/cases.md`
  where it describes the workspace, `docs/development/ui-standard.md` (§6.3).

### 2.9 Pre-existing defects (D11)

Fixed this round: D7.2 attribution; D6.10 carry-over; G17 AI assessment fallback; the stale
`settings-sections-meta.ts` comment ([crit] C1); stale Case Manager comments. Recorded as
follow-ups (§7): duplicate case on a closed reinvestigation; lifecycle notifications ignoring
`triggers.on_closed`; `first_response_at` never written; `case_activity` and `case_tasks` opaque
rows on ES; audit push-down aggregation; `caseOutcome` for ordinary feedback labels.

---

## 3. Shared contracts

### 3.1 Entry bundle ([plat] b; [ru] M1, L7)

Today 337,163 B against a 337,240 B budget (about 31 B in CI). WP3 first removes the 11 hidden
`FEATURES` entries that duplicate a visible child of the same id and label (dashboard,
investigate, cost, models, standup, knowledge, runbooks, memory, personas, roles, users; about
818 B), repointing `registry-router-round6.test.tsx:128`; catalog, playbooks, account, sessions,
security and admin_sessions stay. Spends: Team activity child, perm constant and route (about
270 B), wizard copy (about +150 B), `review` deep-link key and `NavOpts` (about 40 B), legacy tab
alias (about 50 B), `CASE_TABS` (about minus 20 B). New client calls go in lazy `lib/api-*.ts`
modules, mirrors in type-only `types-*.ts`. No upward rebase. If the integrated entry is more than
1 KiB under the baseline, the orchestrator may ratchet `PRE_REVAMP_ENTRY_BYTES` down once,
recorded in §8 and in the `test_docs_round12_records.py` pin. The 400,000 B ceiling never moves.

### 3.2 Demo Mode

| Store or writer | Demo behaviour |
|---|---|
| `case_files` | Demo KV instance; Demo caps (D5.3); Demo audit sink |
| `auto_close_review` ledger and sampler | Demo KV instance and Demo pipeline sampler; seeded (D6.13) |
| Review endpoint | the Demo case and Demo audit |
| Team activity reads | case work from the Demo audit; sign-ins from the control audit (D3.6) |
| RBAC switch | real `Preferences`, `control_audit` |
| New settings | real `Preferences` |

A test per new writer asserts the sink with Demo Mode on and off.

### 3.3 Permissions

| Grant | Who (built-in defaults) | Used by |
|---|---|---|
| `team:view` (new) | super_admin, soc_manager, auditor | Team activity (plus D3.3 while RBAC is off) |
| `roles:read` | every role | `GET /api/rbac` |
| verified `super_admin` + strict fresh sign-in | super admins | `PUT /api/rbac` |
| `roles:manage` + fresh sign-in | super_admin, soc_manager | other `rbac.*` changes through `PUT /api/settings` |
| `cases:comment` | every role but auditor | add a screenshot; delete own |
| `cases:close` | super_admin, soc_manager, analyst_tier2 | delete others' screenshots; reopen from a review |
| `cases:write` | every role but auditor | record a review |
| `cases:read` | every role | list and view screenshots; review summary |
| `metrics:view` | every role | Auto-close review module |
| `settings:manage` | super_admin, soc_manager | the two new settings |

### 3.4 Storage (#12) and the Elasticsearch mapping budget ([crit] G4)

New KV namespaces: `case_files`, `auto_close_review`. Every new KV document uses a fixed,
namespace-prefixed set of at most six top-level fields with the payload in opaque JSON (or the
base64 field); no dict keyed by case, user, date or rule outside opaque JSON. New `Preferences`
blocks: `team_activity` (1 field), `auto_close_review` (5 fields). No new index, table or
migration.

### 3.5 Non-negotiables cross-check

- #2: every new writer audits (files and reviews audit-first; the switch through
  `audited_prefs_write`); lifecycle rows keep best-effort semantics (D7.6).
- #3: `decide()` byte-identical; the sampler runs after `apply()` and `save()`; the review never
  writes `status`, `decision_by` or `disposition`; the close dialog posts only existing verbs; no
  new close gate.
- #6: no new model call.
- #7: team counts, screenshots and captions never reach a prompt.
- #9: review notes become fenced untrusted precedent text exactly as grading comments do
  (D6.6); new audit rows keep filenames, captions and notes out of `result_summary` (D5.10).
- #10: review on at 5% and 10 a day; Team activity on behind its permission and D3.3.
- #12: KV only.

### 3.6 Static guards ([rs] 22)

- Import bans: `stores/case_files`, `engine/team_activity` and `stores/auto_close_review` may not
  be imported from `app/agents/**`, `app/tools/**`, `engine/report_digest.py`,
  `engine/chat_starters.py` or `agents/standup.py`; `engine/auto_close_review` only from
  `agents/pipeline.py`, `state.py`, `engine/demo_runtime.py` and its route.
- No `case_manager` import in `engine/auto_close_review.py`, `engine/review_origin.py`,
  `engine/team_activity.py`, `engine/case_images.py`, `api/routes_auto_close_review.py`,
  `api/routes_case_files.py` (pattern `test_overhaul_b2_autopilot.py:307-316`).

### 3.7 Rollback ([rs] 8)

- The pinned previous release (`45a4c31`) has no preferences forward contract and rewrites the
  preferences document at shutdown, so a rollback resets `team_activity` and
  `auto_close_review` to their defaults. Documented as a known limitation and in the rollback
  docs.
- Lane plants (owned by WP7, `scripts/rollback_lane.py` and `scripts/test_rollback_lane.py`), in
  `phase_n` (unconditional): write a terminal agent case through the SQL case repository, post a
  review and upload a screenshot; have the previous release make a full save (`POST
  /api/cases/{id}/comment`); in `phase_return`, assert through `/api/feedback/stats` that the
  grade stays excluded and that the screenshot lists and serves.

---

## 4. Work packages

### 4.1 Rules

- A package touches only the files and regions it owns (§4.6), plus new files it creates.
  Shared-file schema edits are done in WP1.
- Each package: implement, run its focused tests and the affected suites until green; for webui
  changes `npm run lint`, `npm run gates`, `npm run check:types`; scan changed files for em
  dashes, en dashes used as dashes, U+00A0 and Cf characters; a package that changes
  `registry.tsx`, `settings-sections-meta.ts` or Settings anchors runs `npm run gen:console-map`
  and `scripts/build_app_knowledge.py` in its branch ([ru] M2); return a report ending with a
  Journal entry (no em dashes).
- Router counts in `AGENTS.md` and `HANDOFF.md` (`test_docs_round13_records.py:51-54, 174-180`)
  are updated by the orchestrator at merge; packages list that test as expected-red ([rb] M8).
- Parallel packages run in their own git worktrees, commit on a local branch `r15-<wp>` (never
  push), and report the branch and commit. The orchestrator merges and regenerates generated
  files on conflict.
- Worktree setup: `ln -s /home/user/Kavach-AgenticSOC/webui/node_modules webui/node_modules`;
  Python tests with `/home/user/Kavach-AgenticSOC/backend/.venv/bin/python -m pytest -q -p
  no:cacheprovider` from the worktree's `backend/`; docs tools with
  `/home/user/Kavach-AgenticSOC/.docs-venv/bin/python`.

### 4.2 Wave 1: foundation (sequential, main tree)

**WP1 Foundation**:
- `models.py`: `FeedbackEntry.origin`, `.review_id`; response models (`RbacStatus`,
  `TeamActivity` and parts, `CaseFileEntry`, `AutoCloseReviewEntry`, `AutoCloseReviewSummary`);
  mirrors in type-only webui modules.
- `routes.py`: `CaseAction.actions_taken` and `CaseAction.review_via`; D7.1 to D7.3 on lifecycle,
  collab and feedback rows; `engine/jobs.py` bulk stamping; `actions_taken` and `review_via` on
  the history entry; `_reject_out_of_range_auto_close_review` in `put_settings`.
- `audit/query.py` D7.4; `audit/event_categories.json` and `webui/.../audit/events.ts` D7.5;
  `audit/views.py` parameterised `ViewRecorder`.
- `config.py`: `TeamActivityConfig`, `AutoCloseReviewConfig` (clamps); the two `Preferences`
  blocks.
- `rbac/policy.py`: `team: ["view"]`; `Roles.api.ts` mirror; truth tables.
- `constants.py`: `CASE_FILES_NS`, `AUTO_CLOSE_REVIEW_NS`, the actions-taken vocabulary.
- `engine/review_origin.py`; `engine/metrics.py::feedback_stats` (D4.5, D6.8);
  `engine/agent_improvement.py` (D6.8 including `_agent_reopen_summary`); the chat feedback tool
  "not rated".
- `agents/pipeline.py`: `_carry_case_work` in the three builders (D6.10) with tests.
- `npm run gen:types` and `check:types` if schemas changed.
- Acceptance: the full backend suite green; `decide()` guards untouched and green.

### 4.3 Wave 2: features (parallel worktrees from the WP1 commit)

- **WP2 RBAC switch and wizard** (A1, A2): `routes_rbac.py`; `llm/readiness.py`; in `routes.py`
  the D1.3 guard (`put_settings._apply`) and the D2.2 fields (`setup/status`, `setup/secrets`)
  only; `Roles.tsx`, `settings/security.tsx` (Manage action), `Security.tsx` (Remember-me input),
  `Wizard.tsx`; tests for every rule in D1.2, D1.3 and D2.1 and every string in D2.3. Docs:
  `docs/administration/users-rbac.md` (Console steps and the `PUT /api/rbac` recipe),
  `docs/getting-started/first-run.md`.
- **WP3 Team activity** (A3): `engine/team_activity.py` (pure fold, legacy parsing, people,
  honesty flags), `api/routes_team.py`, the `search_page` `count` option (ES `audit_log.py`, SQL
  `search_page`, base fallback), Demo audit-row seeding (`engine/demo_generator.py`, its own
  function, called from the Demo seeding sequence in `state.py`), the D3.4 settings group
  (`settings/security.tsx`, `advanced-schema.tsx`, `settings-sections-meta.ts`),
  `TeamActivity.tsx`, `lib/api-team.ts`, `lib/types-team.ts`, `registry.tsx` (the child and the
  §3.1 removal), `router.tsx` (`team` route only), `nav-titles.round14.test.ts`,
  `console-map.contract.test.ts`, the console map and corpus, tests. Docs:
  `docs/analyst/team-activity.md` (new; `mkdocs.yml` nav under User and analyst guide).
- **WP4 Screenshots** (A4, D5): `engine/case_images.py`, `stores/case_files.py`,
  `api/routes_case_files.py`, `state.py` and `engine/demo_runtime.py` wiring (store regions),
  `engine/reset.py` and `api/routes_export.py` (files regions), the factory purge fix and
  `delete_strict` in `stores/memory.py` and `stores/sql/repositories.py`, `es/base.py`,
  `es/client.py`, `es/indices.py`, `webui/nginx.conf`, tests (validator corpus, caps, dedup,
  headers, permissions, Demo sinks and caps, never-to-a-model, static guards). Webui kit, not
  mounted: `webui/src/soc/pages/casedetail/files/` (`CaseFiles.tsx` gallery and lightbox,
  `useCaseFileUpload.ts`, `FileDropZone.tsx`), `lib/api-case-files.ts`, tests. Docs:
  `docs/administration/reset.md`, `docs/operations/health-backup.md`.
- **WP5 Auto-close review** (A5, D6): `engine/auto_close_review.py`,
  `stores/auto_close_review.py`, the `review_sampler` attribute and its one call in
  `agents/pipeline.py`, `engine/demo_runtime.py` (Demo sampler and store region),
  `api/routes_auto_close_review.py` (review endpoint, summary, metrics module), the `review=`
  filter in the cases list route (`routes.py`, that region), `eligible_audience` (in
  `engine/batch_inbox.py`, keeping `eligible_batch_audience` as a wrapper), `state.py` wiring,
  `engine/reset.py` and `api/routes_export.py` (ledger regions), Demo seeding
  (`engine/demo_generator.py`, its own function), the Settings Detection group, the Agent
  effectiveness module (`AgentEffectiveness.tsx` plus a lazy module), the kit not mounted:
  `casedetail/review/ReviewCard.tsx`, `lib/api-reviews.ts`; `components/outcome.ts`
  (`OutcomeSource` `review`, `isReviewGrade`), tests. Docs: `docs/automation/auto-close-review.md`
  (new; `mkdocs.yml` nav under Automation), `docs/analyst/analytics.md`,
  `docs/concepts/deterministic-decisions.md` (one paragraph: review never decides).
- **WP6 Case Manager redesign** (A6, D4 UI, D8), two agents in sequence on one worktree branch:
  - **WP6a**: queue pane, header, the primary-action table, tabs consolidation (`case-tabs.ts`,
    the `case_manager` block of `router.tsx`, `nav-types.ts`), facts rail, dead code, and the
    tests they move.
  - **WP6b**: tab bodies (Overview absorbs Timeline, Investigation absorbs Threat context, G17,
    Collaboration without the owner picker and with a Files slot, History with actions taken), the
    close dialog (D4.1 to D4.6, with a drop-zone slot), Case Manager bulk exclusion (D4.7), and the
    tests they move.
  - Owns `CaseManager.tsx`, `CaseDetail.tsx`, `casedetail/**` except `files/` and `review/`,
    `ConfirmActionDialog.tsx`, `DispositionPicker.tsx`, `case-tabs.ts`, `nav-types.ts`, the
    `case_manager` block of `router.tsx`, `soc/runbooks/run/__tests__/case-surfaces.test.tsx`,
    `docs/development/ui-standard.md` (Case Manager parts), `docs/analyst/case-manager.md`,
    `docs/analyst/investigation.md`.

### 4.4 Wave 3: integration (main tree, after merging WP2 to WP6)

**WP7 Integration**: mount the WP4 kit (Files section, close dialog drop zone, paste) and the WP5
kit (Review scope and count, the pending band and Start review, Review this auto-close and the
hidden Set disposition, the review result in the rail); `Cases.tsx` bulk exclusion (D4.7); SSE
refresh; the rollback lane plants (§3.7); the tests these touch; regenerate types and the console
map.

### 4.5 Waves 4 and 5: review, records, gates

- **Review** (workflow): adversarial reviewers per dimension (backend correctness and #3, upload
  and switch security, statistics integrity, UI against the standard with screenshots, test
  honesty); each finding verified before it is fixed.
- **WP8 Records and docs**: `CHANGELOG.md`, `Journal.md`, `AGENTS.md` (§4 layout, §10, router
  count), `docs/HANDOFF.md`, `README.md`, `INSTALL.md`, `DEPLOY.md`, `docs/USAGE.md`,
  `docs/reference/api.md`, `permissions.md`, `configuration.md`, `docs/releases/known-limitations.md`,
  the remaining [rbac] d docs, the knowledge corpus on the integrated tree, refreshed screenshots
  (§5.3), this SPEC's §8.

### 4.6 Ownership of shared files

| File | Owner |
|---|---|
| `models.py`, `config.py`, `constants.py`, `rbac/policy.py`, `audit/*` | WP1 only |
| `api/routes.py` | WP1; then WP2 (`put_settings._apply` guard, setup status and secrets), WP5 (cases list filter), by region |
| `state.py`, `engine/demo_runtime.py`, `engine/reset.py`, `api/routes_export.py` | WP3, WP4, WP5 by region (each adds its own function and one call) |
| `engine/demo_generator.py` | WP3 and WP5, each its own function |
| `agents/pipeline.py` | WP1 (carry helper), WP5 (sampler attribute and call) |
| `stores/sql/repositories.py`, `stores/memory.py` | WP3 (`search_page` count option), WP4 (purge fix, `delete_strict`), by function |
| `webui/src/soc/registry.tsx` | WP3 |
| `webui/src/soc/router.tsx` | WP3 (`team` route), WP6a (`case_manager` block) |
| `casedetail/**`, `CaseManager.tsx`, `CaseDetail.tsx` | WP6, then WP7 |
| `components/outcome.ts` | WP5 |
| `pages/settings/security.tsx` | WP2 (Manage action), WP3 (Team activity group), by region |
| other `pages/settings/*` | WP3 (meta and advanced schema for its key), WP5 (detection group, meta for its key) |
| `mkdocs.yml` | WP3 and WP5 one nav line each; WP8 reconciles |
| `scripts/rollback_lane.py`, `scripts/test_rollback_lane.py` | WP7 |
| `backend/app/knowledge/*.json` | each package regenerates; the orchestrator regenerates on merge |
| `CHANGELOG.md`, `AGENTS.md`, `HANDOFF.md` | WP8 (router counts by the orchestrator at merge) |

---

## 5. Verification

### 5.1 Tests per package

Offline tests for every rule each package introduces. Must-haves: D1.2 rules 1 to 7 and D1.3;
every wizard string and the readiness helper per provider; the team fold against hand-built rows
(new and legacy shapes, mixed-case actors, environment, Demo, deleted and unattributed people,
bulk, partial at the row cap and at the offset limit, window too long, the switch, the RBAC-off
role floor); the image validator corpus; the sampler's determinism, caps and once-per-case rule;
the review's no-touch rule; `is_review_grade` with and without the entry marker and with an
ordinary grade; the exclusions; the audit alias table on all three stores; the carry-over in all
three builders; the `caseOutcome` review source; G17; the legacy tab links; the static guards.

### 5.2 Gates (integrated tree)

`pytest -q` (record the count); ruff fatal; `npm run test:strict` (zero stderr); `npm run lint`;
`npm run gates`; `npm run check:types`; `npm run build` (docs plus app; entry within budget);
`npm run docs:check`; `scripts/check_docs.py`; `scripts/build_app_knowledge.py --check`;
`scripts/check_version.py`; `scripts/check_ci_contract.py`; the docs bundle and theme tests.

### 5.3 Screenshots

Light and dark captures from the seeded Demo at 1440 by 900: Case Manager (queue, Overview,
Investigation, Collaboration with Files, the close dialog, a pending review), Team activity (page
and person sheet), Roles & permissions with the switch panel and both dialogs, the wizard AI and
review steps, Agent effectiveness with the review module, Settings Detection review group. Docs
screenshots in `docs/assets/screenshots/` are refreshed where the surface changed.

---

## 6. Documentation

### 6.1 Help Center pages

New: `docs/analyst/team-activity.md`, `docs/automation/auto-close-review.md`. Changed:
`docs/analyst/case-manager.md`, `docs/analyst/investigation.md`, `docs/analyst/cases.md`,
`docs/analyst/analytics.md`, `docs/administration/users-rbac.md`,
`docs/administration/settings.md`, `docs/administration/reset.md`,
`docs/getting-started/first-run.md`, `install.md`, `quickstart.md`,
`docs/concepts/deterministic-decisions.md`, `docs/reference/api.md`, `permissions.md`,
`configuration.md`, `docs/operations/health-backup.md`, `docs/operations/upgrades.md` (rollback
note), `docs/releases/known-limitations.md`.

### 6.2 Repository docs

`README.md`, `INSTALL.md`, `DEPLOY.md` (RBAC recipe, upload size), `docs/USAGE.md`, `AGENTS.md`,
`docs/HANDOFF.md`, `CHANGELOG.md`, `Journal.md`, `ROADMAP.md` (§7 items).

### 6.3 Amendments to earlier documents

- `docs/development/ui-standard.md` ([ru] L16): the Case Manager scope list gains Review
  (`:573-575`); queue rows are two lines and show status or outcome, never both (the comfortable
  third line at `:577-579` goes); the header meta-row list no longer names risk, tags or campaign
  (`:616-618`); the "Case outcome" section gains the review source (`:604-612`); five case tabs.
  The grading-agreement sentence (`:629-632`) stays (D4.4 keeps today's rule).
- Round 14 SPEC §4.10.11: the runbook chip leaves the queue row; the Runbook tab stays second
  with its chip; the facts-rail Runbook section stays.
- The documented RBAC curl recipe (Round 14 follow-up docs) is replaced by `PUT /api/rbac`.
- Round 14 SPEC §11.1 "Entry bundle" record: updated only if §3.1's ratchet happens.

---

## 7. Not built this round (follow-ups)

- Audit push-down aggregation for Team activity (ES composite, SQL `GROUP BY`).
- Shift-based day buckets for Team activity.
- Full blind review (hiding the AI verdict across the whole case page while a review is pending).
- Reinvestigating a closed case updates it in place (today it creates a second case).
- Lifecycle notifications honouring `triggers.on_closed` and risk floors.
- `first_response_at` written on the first human response.
- `case_activity` and `case_tasks` as opaque rows on Elasticsearch.
- `caseOutcome` rendering of ordinary (non-review) feedback labels to match the backend
  authority.
- Server-side image re-encoding (no image library is added).

---

## 8. As built

Filled by the orchestrator after integration: contract resolutions, per-package notes, gate
results, entry bytes, known limitations.

---

## Appendix A. Review resolutions

Every finding of the three reviews and where it is resolved. Findings marked "kept" were checked
and the SPEC already matched.

| Finding | Resolution |
|---|---|
| [rb] H1, [rs] 11 | D6.9 `review_via` Literal, never the internal `via` |
| [rb] H2, [ru] H1, [rs] 1 | D4.4 keeps today's grading rule; no derived `actual_outcome` |
| [ru] H3 | D4.4 (no feedback label from a close) |
| [rb] H3, [rs] 13 | D3.9 normalised people, environment and Demo kinds, Not attributed |
| [rb] H4 | D5.7 mapping for fresh installs and new client methods for upgrades |
| [rb] H5, [ru] H4, M12 | D2.1 to D2.3 readiness helper, payloads, three states, strings |
| [ru] H2 | D8.3 legacy tab aliases, section scroll, loaders |
| [ru] H5 | D8.3 Runbook stays second; D8.4 rail Runbook kept; §6.3 |
| [rb] M1, [rs] 7 | D6.5 and D7.5 `case.review_requested` in `system` |
| [rb] M2, [rs] 2 | D6.6 note is fenced precedent; §3.5 |
| [rb] M3 | D5.10 ids and codes only in `result_summary` |
| [rb] M4, [rs] 4 | D6.10 shared carry helper, `status`, no `escalation_level`, disposition rule |
| [rb] M5, [rs] 15 | D7.3 `batch_id` as `run_id`, never a parameter |
| [rb] M6 | D7.2 principal else caller value |
| [rb] M7 | §4.6 ownership rows; D3.10 `ViewRecorder`; D6.3 sampler attribute, replay `None` |
| [rb] M8 | §4.1 router counts at merge |
| [rb] M9 | D5.2 `delete_strict`, store tag |
| [rb] M10, [rs] 3 | D6.6 history event only for ledger cases; D6.7 matching rule |
| [rb] M11 | D3.6 `count` option, partial on offset limit, 60 s cache |
| [rb] M12, [rs] 9 | D6.6 `elapsed_ms`; D3.8 two labelled times |
| [rb] L1, [rs] 16 | D1.2 rules 2 to 6 |
| [rb] L2 | D1.3 placement and comparison |
| [rb] L3 | D7.4 one place; chat tool not involved |
| [rb] L4, [ru] L14 | D6.12 `_queue_cases_by_id`, Review like All, refresh rule |
| [rb] L5, [rs] 25 | D3.8 runbook steps definition; MTTA rule |
| [rb] L6, [rs] 20 | D4.5 rated counts, 0.0 unrated documented |
| [rb] L7, [rs] 19 | D6.2 body-level rejection in WP1 |
| [rb] L8 | D6.9 two calls |
| [rb] L9 | D6.9 `eligible_audience`, category preference |
| [rb] L10, [ru] L11 | D2.3 wording |
| [rb] L11 | D3.6 Demo sources |
| [rb] L12, [rs] 18, [ru] M6 | D3.4 `CURATED_SECTIONS`, owned keys, anchors |
| [rb] L13 | D5.1 `_rev: 1` create-only |
| [rs] 5 | D4.7 bulk exclusion, first decision record |
| [rs] 6 | D1.3 `roles:manage` and fresh sign-in for other `rbac.*` changes |
| [rs] 8 | §3.7 rollback limitation and lane plants |
| [rs] 10 | D6.8 `_agent_reopen_summary` exclusion |
| [rs] 12 | D7.1 and D3.12 `outcome`, `actor_type`, `_SPLAT_PRODUCERS` |
| [rs] 14 | D5.3 Demo and in-memory caps |
| [rs] 17 | D3.3 role floor while RBAC is off |
| [rs] 21, [ru] M9 | D6.7 `isReviewGrade`; D6.12 review source only; §7 |
| [rs] 22 | §3.6 static guards |
| [rs] 23 | D6.6 order and 409s |
| [rs] 24 | D6.12 module statement, decision day; D3.8 N of M |
| [rs] 26 | D6.4 reset and export |
| [rs] 27, [ru] L13 | D3.11 `lib/csv.ts` |
| [rs] 28 | D3.10 kinds and structured detail |
| [ru] M1, L7 | §3.1 spends and the test line |
| [ru] M2 | §4.1 regeneration per package |
| [ru] M3 | D8.2 primary-action table |
| [ru] M4 | D8.2 Details button, `T` |
| [ru] M5 | D3.11 range control |
| [ru] M7 | D1.4 `useAuth().rbacEnabled` |
| [ru] M8 | D4.2 History reads `case.history` |
| [ru] M10 | D8.1 `FilterBar` with `primaryCount={0}`, view menu |
| [ru] M11 | D4.3 `deriveAgreement` override rule |
| [ru] L1, L2 | D3.1 nav titles, keywords, `PageAccess` |
| [ru] L3 | D3.11 seven kinds, recharts `stackId` |
| [ru] L4, L10 | D5.12 lazy canvas helpers, `requestResponse`, ladder, `DialogTitle` |
| [ru] L5 | D1.4 purpose wording and `request` |
| [ru] L6 | D8.1, D8.6 exact copy |
| [ru] L8 | D8.3 Alt labels |
| [ru] L9 | D8.3 `NavOpts`; §4.6 `nav-types.ts` |
| [ru] L12 | D8.8 pinned anchors and chunk |
| [ru] L15 | D8.7 `CaseManager.tsx` only |
| [ru] L16 | §6.3 |
