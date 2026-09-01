# DEMO.md — Guided demo walkthrough

A crisp, copy-pasteable script for **presenting Agentic SOC**.
It brings the suite up locally with **auth enabled** (so the redesigned login,
6-role RBAC, MFA, sessions, and SSO surfaces are all live) and walks a presenter
through every headline feature in order. Budget ~25-30 minutes for the full tour
(trim §3k–§3p for a shorter walkthrough).

> **New here / setting this up cold?** Read **[`docs/HANDOFF.md`](docs/HANDOFF.md)**
> first (the onboarding map: repo layout, the green baseline, how to run it), then
> come back to present from this script. For deploy specifics see
> **[`DEPLOY.md`](DEPLOY.md)**.

> **Fastest path to a great demo:** if you just want a populated, $0, fully
> isolated showcase with no source wiring, skip straight to **§3a — Demo Mode**.
> One click seeds weeks of synthetic cases (and can keep generating new ones
> live), then one click clears it all. Everything else below still works on top of
> it.

> **What you'll show, in order:** the **redesigned 2-column login** + account
> self-service, the **Cmd-K command palette** + global search, **Demo Mode**
> (one-click populated showcase), a **case overview** + **bulk actions**,
> **sessions** (device list + remote sign-out), the **consolidated Settings IA**
> (five groups × 25 sections), **custom RBAC roles**, the **QRadar-style Sources
> table**, **notifications** (incl. Resend + SES + customizable email templates)
> and the **in-app inbox**, **per-user customization** (saved views, table
> columns, terminology, theme), MFA/SSO, the **Detection & Rules** editor
> (test/preview + version rollback), the **self-improving detection loop**
> (campaigns, entity baseline, threshold auto-tuning), **case collaboration**
> (threads/tasks/@mentions), **custom dashboards**, a **local/self-hosted model
> provider**, **MITRE ATT&CK coverage + Navigator export**, the **audit viewer**,
> and the Overview **Cyber Defence Center**.

---

## 0. Prerequisites

- **Python 3.11** and **Node 22** on PATH (no Docker required for the quick path).
- No LLM key is needed for Demo Mode. It **always** substitutes the deterministic
  `$0` mock provider, even when real provider keys are present. A real key is useful
  only if you later exit Demo Mode and deliberately exercise non-demo triage.

---

## 1. Quick start

### Option A — one command (recommended for a live demo)

From the repo root:

```bash
./scripts/run-demo.sh
```

This:
- creates/uses `backend/.venv`, installs backend deps on first run, and starts
  **uvicorn `app.main:app` on :8088** with direct-run **`AUTH_ENABLED=true`** and a
  generated dev **`AUTH_JWT_SECRET`**;
- installs the web UI deps on first run and starts the **Vite dev server on
  :5173** (it proxies `/api/*` to the backend);
- binds both services to `127.0.0.1`, verifies both ports are free, and refuses to
  let Vite silently fall forward to a different port;
- completes local setup and enables the isolated **live four-source demo** by
  default (Splunk-compatible HEC, QRadar-compatible LEEF/offenses, Wazuh JSON,
  and RFC syslog); use `DEMO_MODE=seeded ./scripts/run-demo.sh` for a static run;
- prints the URL and the seeded **`Admin` / `Admin@123`** credentials.

Open **http://127.0.0.1:5173**. Press **Ctrl-C** to stop both.

Exporting a provider key before launch does **not** make Demo Mode paid or call that
provider. The key becomes relevant only after **Exit & clear**, for explicitly
configured non-demo investigation.

### Option B — by hand (two terminals)

```bash
# Terminal 1 — backend with auth on
cd backend
python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt
# NOTE: a DIRECT uvicorn run reads UNPREFIXED env names (the TLSOC_* prefix is the
# .env convention that ONLY the compose file maps). So set the unprefixed names:
export AUTH_ENABLED=true
export AUTH_JWT_SECRET="$(python3 -c 'import secrets;print(secrets.token_hex(24))')"
python -m uvicorn app.main:app --port 8088
```

```bash
# Terminal 2 — web UI dev server (proxies /api -> :8088)
cd webui
npm install
npm run dev          # serves http://localhost:5173
```

### Option C — Docker (full agnostic stack)

```bash
cp .env.example .env                 # set TLSOC_PG_PASSWORD + one LLM key
# Enable the auth demo posture:
#   TLSOC_AUTH_ENABLED=true
#   TLSOC_AUTH_JWT_SECRET=<32+ random bytes>
./scripts/agentic-soc-compose.sh up -d --build
```

Open **http://localhost:8080**. (See `DEPLOY.md` §3 for the full stack and §8/§10
for the auth/MFA/SSO/notification setup.)

---

## 2. Log in (the redesigned login)

Open the web UI. Because auth is enabled and the user store starts empty, the
backend has auto-seeded a demo **super_admin**:

| Username | Password |
|---|---|
| `Admin` | `Admin@123` |

Things to point out on the **redesigned login** before you sign in:
- It's a **2-column split**: a left **brand hero** (org name / logo / tagline from
  `GET /api/branding`, with a drifting aurora glow that uses the secondary accent
  colour) and a right **form card**. The hero is `hidden lg:block`, so on a phone
  you just see the clean form.
- The same screen drives all four flows: **sign-in**, the **first-run / forced
  password change** (with a live, dependency-free **password-strength meter**),
  the **MFA** step (a 6-cell segmented OTP input), and any configured **SSO**
  buttons (per-provider Google / Microsoft / generic brand icons).

Sign in. (For a real deployment, change this immediately — see `docs/USAGE.md`
§24 for the forced-change-password OOBE flow.)

> If you ran `run-demo.sh`, these creds are also echoed in the startup banner.

---

## 3. The guided tour (hit these in order)

### 3a. ⭐ Demo Mode — the one-click populated showcase — *Settings → Organization → Experimental & Demo* (`demo:manage`)
This is the showpiece. It populates the whole product with realistic, **isolated,
$0** synthetic data so every page has something to show — no source wiring, no LLM
spend, and no demo-generated writes to real cases, events, RAG, usage, or polling
cursors. It is **fully reversible in one click**.

- When started with `run-demo.sh`, Demo Mode is already live. Otherwise open
  **Settings → Organization → Experimental & Demo** and enable it.
  Two modes:
  - **`seeded`** — instantly back-fills ~2 weeks of synthetic cases (old + recent),
    audit, and cost rows from a fixed seed, so it's deterministic and repeatable.
  - **`live`** — also starts a deterministic background simulator that emits
    standards-faithful Splunk HEC, QRadar LEEF/offense, Wazuh JSON, and RFC
    5424/3164 traffic. Benign activity continuously updates the live tail while
    scheduled source-native alerts and Agentic SOC detections advance a shared MITRE
    ATT&CK storyline, so visible activity is guaranteed while you present.
- Notice the amber **Demo banner** pinned in the app shell and the **`SAMPLE`**
  badge on every demo row; cost tiles read **"(simulated)"**. The Sources UI disables
  real connector controls and outbound notification tests are refused while the
  demo is active. Other organization/admin settings remain live: do not edit them
  during a presentation if you want the underlying deployment unchanged.
- Synthetic events flow through the **REAL pipeline** (correlation → risk →
  router → investigator → case manager) against a separate in-memory store and a
  deterministic **mock LLM** — so what you're showing is the genuine product, just
  sandboxed. NEEDS_HUMAN cases stay open (the HITL showcase); FALSE_POSITIVE runs
  through the real deterministic `decide()` against a *sandboxed* policy copy
  (proving non-negotiable #3 without touching the live policy).
- Knobs to mention: `seed`, `history_days`, `tick_seconds` / `tick_jitter`, alert
  cadence, and logical event rate. `incident_rate` is a probability from 0 to 1
  evaluated **once per `alert_interval_seconds`**, not per event or per simulator
  tick. The guaranteed first incident and **Generate incident** are independent of
  that probability. Native records remain bounded in per-source live-tail buffers;
  higher logical volume is aggregated.
- Click **Generate incident** to emit one coherent attack immediately: Splunk,
  QRadar, and Wazuh each raise a native alert while raw syslog telemetry crosses
  Agentic SOC's own correlation threshold. The control has a short cooldown so a double
  click cannot duplicate the storyline.
- **Reset** re-seeds from the same seed (clean slate, same data). **Exit & clear**
  stops the simulator and **hard-deletes everything by `run_id`** across
  demo cases/audit/usage/events, then flips Demo Mode off. Lifecycle actions
  (enable, incident, reset, disable) intentionally remain in the real append-only
  audit trail. *Do this live at the end so the audience sees the sandbox disappear.*
- Endpoints (`demo:read` for status; `demo:manage` for mutations):
  `GET /api/demo/status`,
  `POST /api/demo/enable`, `POST /api/demo/incident`, `POST /api/demo/reset`,
  `POST /api/demo/disable`. By default, `super_admin` and `soc_manager` have
  `demo:manage`; custom roles can receive it explicitly.

> From here on, **leave Demo Mode ON** so Cases/Overview/Metrics and the simulated
> audit trail have data to show. Remember to **Exit & clear** in §4.

### 3b. Cmd-K command palette + global search — *anywhere*
- Press **⌘K** (macOS) / **Ctrl-K** (Win/Linux) to open the **command palette**.
- Type to jump to any page, run quick actions, and run **global search** across
  cases (backed by `GET /api/search`) — open a case straight from the results.
- Great moment to show how fast the redesigned IA is to navigate without the mouse.

### 3c. A case — overview panel + bulk actions — *Cases*
- On the **Cases list**, show **multi-select** + the **bulk action bar**: select
  several demo cases and apply a single action to all of them
  (`POST /api/cases/bulk`). The bulk path runs through the **same RBAC and the same
  analyst-action handler** as a single case — so it is exactly as safe.
- Open one case. **Overview panel:** the polished summary (entities, verdict,
  confidence, risk).
- **Status + disposition taxonomy:** drive the lifecycle —
  `NEW → INVESTIGATING → ESCALATED / ON_HOLD → RESOLVED` (the original
  `open/needs_human/closed` remain as aliases), and set a **Disposition**
  (`true_positive` / `false_positive` / `benign` / `suspicious` / `duplicate` /
  `undetermined`). Show the **status_history**.
- **Run a playbook:** trigger a **context-only re-investigation** against a chosen
  playbook.
- **Threat context panel:** IOC reputation + bundled **MITRE ATT&CK (697
  techniques)** + related cases (fails open if enrichment is unavailable).
- *(Talking point — non-negotiable #3):* the **close/escalate decision is
  deterministic code**; the LLM verdict only recommends, and a TRUE_POSITIVE is
  never auto-closed — even from a bulk action or an automation rule.

### 3d. Account self-service + sessions — *Settings → Account*
- **Profile** (`GET/PUT /api/account/me`): edit **display name**, **avatar** (the
  browser crops/resizes to a tiny WebP before upload; SVG is rejected),
  **alt email**, **timezone**, **locale**. Self-service — no admin needed.
- **Sessions** (`GET /api/sessions`): show the list of **active sessions** as
  device cards — current one pinned with a **"This device"** badge, plus
  Device/Browser, Location (IP + city/country, rendered as plain text),
  Last-active, and Signed-in columns.
  - **Revoke** a single other session (`POST /api/sessions/{sid}/revoke`), or click
    **"Sign out all other sessions"** (`POST /api/sessions/revoke-others`).
  - Talking points: sessions are **server-enforced** (idle timeout / absolute
    lifetime / revocation checked in `require_auth`), and **refresh-token rotation
    with reuse detection** auto-revokes a stolen token. A super_admin can also
    force-terminate **any** user's sessions from the admin sessions console
    (`GET /api/admin/sessions`, `POST /api/admin/sessions/{sid}/revoke`).

### 3e. Consolidated Settings IA — *Settings*
- Show the current Settings: **one left rail, five groups, 25 sections**
  (`webui/src/soc/pages/settings/settings-sections-meta.ts`) — **Account**
  (Profile / Security & two-factor / Sessions & activity / Appearance &
  customization — open to every signed-in user), **General** (data scope, models,
  detection, Detection & Rules, cases, SLA/priority/suppression, automation,
  standup), **Integrations** (alerting & notifications, enrichment, knowledge &
  threat context), **Security & access** (Users, Roles & permissions, single
  sign-on & policy, active sessions, secret keys), and **Organization** (branding,
  advanced, all-settings, Experimental & Demo, danger zone).
- Note that **RBAC hides what you can't touch**: a section a role can't reach
  simply doesn't appear (and the rail auto-jumps off a hidden active section).
  When auth is off, everything shows.
- This is a *Settings*-only regroup — it's separate from the app's top-level
  left-nav, which has its own **six groups**: **Overview** (Dashboard, Dashboards,
  Standup), **Triage** (Cases, Campaigns, Logs, Workspace → Chat/Investigate,
  Automated scans, Approvals), **Intelligence** (Knowledge, Memory, Playbooks),
  **Analytics** (Metrics, Cost, Models, Baseline, Batch jobs), **Notifications**
  (Inbox), and **Platform** (Sources, Audit log, Auto-tuning, Settings). Point out
  Sources and Audit log are standalone **Platform** pages now, not buried in
  Settings.

### 3f. Users, custom roles, MFA & SSO — *Settings → Security & access*
- **Users (RBAC):** *Settings → Security & access → Users* — show the **users
  list** (persisted in a KV-doc; no new index/table). **Create a user** and
  assign one of the **6 built-in roles**: `super_admin` · `soc_manager` ·
  `analyst_tier2` · `analyst_tier1` · `responder` · `auditor`. Server-side, every
  route is gated by `require_permission`; the UI mirrors it with `<Can>` guards.
- **Custom roles:** *Settings → Security & access → Roles & permissions* — create
  a role that **inherits** a built-in one (e.g. `analyst_tier1`), **grants** it one
  extra permission (e.g. `cases:close`), and **denies** another. Use **Preview**
  (`POST /api/roles/preview`) to show the resolved effective grants before saving,
  and **Simulate** (`GET /api/roles/simulate`) to answer "can this role do X?" on
  the spot. Point out a built-in role name can never be overwritten through this
  surface — the platform owner can't be locked out.
- **MFA enrollment (TOTP):** *Settings → Account → Security & two-factor* — click
  **Enroll MFA**: a **QR code renders inline** (SVG, no external calls). Scan it
  with any authenticator; enter the 6-digit code to confirm; **single-use recovery
  codes** are shown — save them. Log out and back in to show the **two-phase
  login** (password → the §2 segmented OTP).
- **SSO configuration:** *Settings → Security & access → Single sign-on & policy*
  — add an **OIDC provider** (Google / Microsoft / generic); fill issuer + client
  id; the **client secret goes to the SECRET tier** (env or runtime push), never
  the config store. Show **group → role provisioning**. The callback URI to
  register with the IdP is **`<base-url>/api/auth/sso/callback`** (see
  `DEPLOY.md` §10).
- **Token / session policy** (same *Single sign-on & policy* section): the idle
  timeout, absolute lifetime, refresh TTL, and step-up ("sudo") re-auth window are
  all **UI-editable** here (defaults: 30-min idle, 12-hour absolute, 7-day
  refresh, 10-min sudo).

### 3g. Sources — the QRadar-style Log Source Management table — *Platform → Sources* (or the wizard)
- Land on **Platform → Sources**: a dense, sortable **DataTable** (not a card
  stack) — a toolbar (search + faceted filter + a live "Log Sources (N)" count +
  a prominent **"+ New Log Source"** + a manage-columns gear), multi-row
  **bulk-select** with an Enable/Disable/Remove strip, and per-row **Status**
  dot + **Last Event** (both honestly derived from `GET /api/sources/health` —
  the poll-cursor age for a pull source, the live-tail buffer depth for a push
  receiver), an inline **Enabled** toggle, and a kebab menu (Browse logs · Make
  primary · Edit · Remove).
- **Add a source** (a webhook is the fastest live demo: no external cluster) —
  Add/Edit opens the same manifest-driven `SourceEditor` the wizard uses.
- **Per-feed (multi-feed) config:** each index pattern is its own **feed** with a
  **role** — **alerts** (auto-investigate), **events** (correlate only), or
  **ignore** (skip entirely) — plus per-feed **query**, **field-mapping
  override**, **severity floor**, **schedule**, and split **correlate** /
  **auto-investigate** switches. Mention that a severity floor never *drops* an
  event (#4) — it just holds it back from auto-forwarding.
- Hover the **(?) HelpTips** and open the **connector setup help**; use the
  **analyze-sample** affordance to paste a sample event and preview the field
  mapping. *(Optional)* enable **cross-source correlation** to link related cases
  by a shared entity (ip / host / user / file_hash / domain).
- **Browse logs** from the kebab menu opens the `SourceLogsSheet` — a live tail
  of that one source; or open **Triage → Logs** to browse across *every* enabled
  source at once, merged newest-first.
- *(If you want a real non-demo case)* push a sample alert (replace the token + id):

  ```bash
  curl -X POST http://localhost:5173/api/sources/<source_id>/secrets \
    -H 'Content-Type: application/json' -d '{"token":"demo-token"}'

  curl -X POST http://localhost:5173/api/ingest/<source_id> \
    -H 'Authorization: Bearer demo-token' -H 'Content-Type: application/json' \
    -d '{"event.module":"web_auth","source.ip":"203.0.113.7","user.name":"alice"}'
  ```

### 3h. Notifications + email templates — *Settings → Integrations → Alerting & notifications*
- Add a channel. Email options include the **`email` (SMTP, 13 provider
  presets)** channel, the **`resend`** channel (HTTPS API), and an **SES** preset
  (an SMTP-preset entry — host `email-smtp.{region}.amazonaws.com`, region from
  channel config); plus **Slack / Teams / webhook / PagerDuty / Telegram**.
- The channel secret (SMTP password, **Resend API key**, SES IAM secret, webhook
  URL, API token) goes in the **secret tier** — set via the UI or
  `POST /api/notifications/channels/{id}/secret` (env at boot via
  `TLSOC_NOTIFICATION_SECRETS`); the UI only ever shows `configured ✓`.
- **Customizable email templates:** open the **template editor** and **preview**
  pane. There are 5 preloaded, operator-overridable templates (`case.new`,
  `case.escalation`, `case.resolved`, `digest.daily`, `test`); the server renders
  the preview (`POST /api/notifications/preview?trigger=…`) with a tiny
  mustache-subset renderer that **HTML-escapes every interpolated variable** —
  point this out as a #9 (untrusted-data) safeguard.
- Click **Send test** and show the message land. Show **per-condition triggers** +
  **dedup / rate-limit / digest** controls.

### 3i. Per-user customization — saved views, columns, terminology, theme — *across the app + Settings → Account → Appearance & customization*
- **Saved views:** filter/sort the Cases list, then **save the view** from the
  saved-views bar; switch between personal views (`GET/POST/PUT/DELETE /api/views`,
  `POST /api/views/{id}/clone`). Org-default views can be cloned to personal.
- **Table columns:** show/hide and reorder columns; the choice persists per user
  (`PUT /api/prefs/user/tables/{table_id}`).
- **Terminology:** in **Appearance & customization**, relabel domain nouns (e.g.
  "Case" → "Alert", "Source" → "Sensor"); the change cascades through the UI via
  the `t()` helper (`GET/PUT /api/terminology`, admin PUT).
- **Theme:** toggle **light / dark / system**; it persists in your user prefs.
- These resolve through a cascade — org Preferences then per-user prefs — exposed
  at `GET /api/prefs/effective` (`/api/prefs/user`, `/api/prefs/org`).

### 3j. Detection & Rules — the rule-authoring home — *Settings → General → Detection & rules*
- Open the **Detection & Rules** home — the single place that replaced the old
  scattered per-rule editors. Show all three rule classes: a **detection-match /
  threshold rule**, a **correlation / clustering rule**, and a **case-automation
  rule** (the **#3-safe** action menu: `tag` / `recommend` / `notify` /
  `run_playbook` / `request_approval`).
- **Test/Preview** a rule (`POST /api/triage/preview-decision`) against recent
  data — emphasize it **never bills the LLM and never calls `decide()`** (zero
  gateway calls, zero cost, no case created).
- Show the **version ledger** for a rule and **roll back** to an earlier version
  with one click — every create/update/enable/disable/delete/rollback is audited
  and versioned.
- Emphasize: **automation NEVER sets case status directly** —
  `request_approval` raises a **HITL proposal** for a human to approve in the
  **Approvals** queue (*Triage → Approvals*); it cannot close or escalate a case
  on its own.

### 3k. The self-improving detection loop — campaigns, entity baseline & auto-tuning
- **Campaigns** (*Triage → Campaigns*): a daily deterministic pass groups
  already-created cases that share an entity into a `Campaign` — show one, and a
  case's campaign chip on its Overview tab. Talking point: a campaign only
  **references** case ids — it never re-clusters, closes, or escalates a member
  case.
- **Entity baseline** (*Analytics → Baseline*): an online per-signature anomaly
  sketch (EWMA/EWMV across 168 hour-of-week buckets, p50/p95/p99) with a warm-up
  gauge — show a signature's baseline card. It's a pure advisory producer; it
  never calls `decide()`.
- **Threshold auto-tuning** (*Platform → Auto-tuning*): a nightly, deterministic
  observer that measures a rule's false-positive rate (Wilson lower-bound) and
  proposes a **bounded +1** nudge. Show a recommendation, **apply** it, then
  **roll it back** — and point out a proposed suppression *drop* always routes to
  the **HITL Approvals** queue instead of auto-applying.
- All three are **default OFF** and none of them can ever close/escalate a case
  or bypass `decide()` — the through-line for this whole beat.

### 3l. Case collaboration — threads, tasks & @mentions — *a case's Collab tab*
- Open a case and switch to the **Collab** tab. Post a thread message, **@mention**
  a teammate (it fans into their in-app inbox, §3m), and toggle an emoji
  **reaction**. Add a **task** to the checklist, assign it, and mark it done.
- Talking point (#3, twice over): none of this — posting, editing, reacting,
  tasking — ever reads or sets the case's `status`/`verdict`/`disposition`. A
  deleted message is always a soft-delete tombstone, never erased (#2).

### 3m. The in-app inbox — *Notifications → Inbox*
- Open **Inbox**: your personal, self-scoped notification feed, including the
  @mention you just triggered in §3l. Show the unread-count bell badge, mark one
  read, mark all read, and the per-category × channel delivery **prefs**
  (`GET/PUT /api/notifications/prefs`) — a user manages their own inbox; there's
  no admin view into someone else's.

### 3n. Custom dashboards — *Overview → Dashboards*
- Create a new dashboard and drag/resize widgets on the 12-column grid
  (`react-grid-layout`, lazy-loaded, edit-mode only) — pick from the widget
  allowlist (KPI tiles, verdict/autonomy charts, the MITRE heatmap, the active-risk
  gauge, connector-health and recent-cases tables). An unknown widget type is
  rejected server-side, never silently stored.
- Clone a **role-default** curated layout into your own set and customize it.
  Everything is scoped to you — one user can never read or mutate another's
  dashboard. Talking point (#3): a dashboard is advisory presentation state only.

### 3o. A local / self-hosted model provider — *Settings → General → Models → "Add local model"*
- Point the dialog at a self-hosted **LiteLLM** proxy (or vLLM/Ollama/LM Studio) —
  `base_url` + an optional key. Click **Test** first
  (`POST /api/llm/providers/test`) — a **non-metered** reachability probe that
  lists the endpoint's models before you commit to anything.
- **Add it** (`POST /api/llm/models/custom`): the model appears in the per-role
  pickers immediately, priced at **$0** automatically (belt-and-suspenders — a
  price overlay *and* a gateway fallback both guarantee it). Great talking point
  for a cost-conscious or air-gapped deployment.

### 3p. MITRE coverage + ATT&CK Navigator export — *Analytics → Metrics*
- Show the **MITRE heatmap**: per-tactic technique coverage tallied from the live
  case load against the bundled **697-technique** ATT&CK corpus — no network
  call, no live STIX feed.
- Download the **ATT&CK Navigator v4.5 layer** (`GET /api/mitre/coverage/
  navigator.layer.json`) and, if you want the full effect, drop the file into the
  public [ATT&CK Navigator](https://mitre-attack.github.io/attack-navigator/) to
  show the same coverage rendered as an interactive heatmap outside the suite.

### 3q. Audit viewer — *Platform → Audit log*
- Open the **Audit log** — a standalone top-level page now, not tucked under
  Settings. It's an append-only, filterable record of every agent and operator
  action (#2). While Demo Mode is active, this page intentionally shows the
  **demo-scoped** investigation and case audit records; real tenant surfaces stay
  hidden. Demo lifecycle actions (enable, manual incident, reset, exit) are also
  attributed to the operator in the **real** append-only audit, which becomes
  visible here after **Exit & clear**.

### 3r. Overview — the Cyber Defence Center
- Land on the **Overview** (Dashboard). Walk it top to bottom:
  - **Masthead** — the time-range picker, auto-refresh, and a "last updated" stamp.
  - **KPI strip** — 5 server-fed tiles: **Total Cases**, **Total Critical**,
    **Open Cases**, **False Positive Rate**, **Resolved / Closed** (all populated
    by Demo Mode; hover or focus a tile with an honest series to reveal its
    selected-window trendline). Four are the selected window's arrival cohort;
    **Open Cases** is deliberately the open-case count *right now* — it is not
    window-filtered and never sums with the other four, and its sub says so.
    **Resolved / Closed** carries the three-way close attribution (AI agent /
    Human / System) inside the tile, reconciling with the Human-vs-AI instrument.
  - **KPI drill-down** — click (or press Enter/Space on) any tile: a detail panel
    docks *under* the strip without leaving the page, so the other four numerals
    stay in view for comparison. It lists that tile's own population with a
    filter box, a severity and status facet, a sort order and its **own** time
    range — note that **Open Cases** opens all-time, because the tile is a stock,
    not a window cohort. The footer states how much of the store it actually
    read rather than implying the list equals the numeral above it; **Open in
    Cases** hands the same population to the full list (Resolved / Closed uses
    the *Terminal* facet, which covers resolved **and** closed). Escape closes it
    and returns focus to the tile.
  - **Hero row** — the **Active Risk Index** (the one risk instrument on the
    page — the old Active-Risk-Index glitch is fixed), plus a "Cases resolved"
    and an "Open cases" donut snapshot.
  - **Noise-Reduction flow ribbon** — the value-prop headline: raw ingested
    volume, split by severity, thinning left-to-right through *clustered* →
    *cases* → *auto_cleared* / *escalated* / *closed-by-human*. Hover a stage for
    its exact count, share, and a per-severity/per-disposition breakdown; point
    out the "noise reduced by X%" figure.
  - **Third row** — a cases **burndown** (opened vs. resolved), a card showing
    real **MTTD** (mean time-to-detect, measured from the cluster's first event to
    case creation) alongside **first-response time** (the ACK clock — a talking
    point: this was deliberately renamed *away* from "MTTR" mid-round because it
    measures first human response, not full dwell/resolution time), and a
    **top-open-cases** work list.
  - **Deeper analytics** (collapsed by default) — the LLM spend tripwire, full
    response-timing detail, the autonomy split, connector health, case volume,
    workload, and top signatures/entities.
- Point out the polish layer: **skeleton/shimmer loading**, staggered reveals,
  8px-grid alignment, **WCAG AA** contrast.

---

## 4. Reset / teardown

- **Exit Demo Mode first** (if you enabled it in §3a): *Settings → Organization →
  Experimental & Demo →* **Exit & clear** (or `POST /api/demo/disable`). This stops the live simulator and
  **hard-deletes all synthetic data by `run_id`** — leaving any real state
  untouched except for the intentional real audit record of the lifecycle action.
  Reopen **Platform → Audit log** now to verify the operator-attributed enable /
  incident / reset / disable entries. (Use **Reset** instead to re-seed the same
  dataset for another run.)
- **`run-demo.sh`:** press **Ctrl-C** — it tears down both processes.
- **Docker:** `./scripts/agentic-soc-compose.sh down`
  (add `-v` to also drop the Postgres volume for a clean slate).
- **Auth & session state** live in the state backend; for the in-memory/local demo
  they reset on backend restart (the `Admin/Admin@123` super_admin re-seeds, and
  with no stable `TLSOC_AUTH_JWT_SECRET` all sessions are invalidated on restart).

---

## 5. Notes & gotchas

- **Auth is DEFAULT OFF** in the committed config for back-compat and tests;
  `run-demo.sh` and Option B export direct-run `AUTH_ENABLED=true`; Compose in
  Option C maps `TLSOC_AUTH_ENABLED=true` to it. With auth disabled there is **no
  login** and every caller is treated as `super_admin`.
- Use a **stable** `TLSOC_AUTH_JWT_SECRET` or sessions die on every backend
  restart (the §3d sessions list will look empty after a restart). `run-demo.sh`
  generates one per run (fine for a single sitting).
- **Demo Mode is $0 and uses the mock LLM regardless of any key** — it never spends
  real tokens; demo-generated cases/events/RAG/usage remain in the throwaway store.
  A provider key supplied to `run-demo.sh` is therefore unused until you exit the
  demo and deliberately run non-demo investigation.
- Demo status requires `demo:read`; enable / Generate incident / reset / disable
  require `demo:manage`. The default `super_admin` and `soc_manager` roles can
  manage it, and a custom role can be granted the same capability.
- Demo Mode does not turn the rest of organization administration into a sandbox.
  Real organization/admin settings remain live; leave them unchanged during a
  presentation unless you deliberately intend to configure the deployment.
- Secret values are **never** shown in the UI — you only ever see `configured ✓`.
  That includes the new **Resend API key** and **SES** credentials.
