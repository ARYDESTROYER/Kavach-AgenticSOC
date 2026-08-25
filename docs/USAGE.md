# USAGE.md — Using Agentic SOC

A deep, example-driven guide to operating the suite once it is deployed (see
`DEPLOY.md`) and the standalone web UI is up. Everything here maps 1:1 to the
shipped UI (`webui/src/soc/`) and the backend API contract (`backend/app/api/`).

> **The standalone web UI is the primary surface.** It is a self-hosted SPA
> (Vite + React + TypeScript + Tailwind + shadcn-style primitives on Radix UI, in
> `webui/`) that talks to the FastAPI backend **directly** over `/api/*` (proxied
> by nginx in production). The old Kibana plugin (`archive/kibana-plugin/`) is
> **archived** (frozen, not built/tested/shipped); this document describes the
> standalone UI only.
>
> **New here?** Start with **[`docs/HANDOFF.md`](HANDOFF.md)** for the
> orientation map (what's where, the green baseline, how to run it), then come
> back here for the feature-by-feature how-to.

The suite is **vendor-agnostic**: it ingests from any number of configured
**sources** (pull connectors — Elasticsearch / OpenSearch / Wazuh — or push
receivers — webhook / HEC / syslog / Kafka / SQS / …), normalises every event to
**OCSF** (`backend/app/ocsf/`), and runs the same correlate → risk →
two-tier-LLM → deterministic-case-manager pipeline regardless of where the alert
came from.

---

## 0. Open the UI

The agnostic stack (`deploy/docker-compose.agnostic.yml`) publishes the web UI on
**http://localhost:8080** (nginx serves the SPA and reverse-proxies `/api/*` to
`tlsoc-backend:8088`). The backend's own API is also published on **:8088** for
ops/automation.

```bash
cp .env.example .env   # set TLSOC_PG_PASSWORD + at least one LLM key
./scripts/agentic-soc-compose.sh up -d --build
# then open http://localhost:8080
```

On first load the UI checks `GET /api/setup/status`; if `setup_complete` is
`false` it shows the **first-run wizard** instead of the console. If that check
fails, the app shows a fail-closed **Can't verify setup state** recovery screen with
**Retry**; it never opens the operational console while setup state is unknown.
After setup, the
left rail (`webui/src/soc/registry.tsx`, the single `FEATURES[]` table that derives
the nav, the routes, and the Cmd-K command palette from one place) groups every
surface into **six top-level nav groups**:

| Group | What lives there |
|---|---|
| **Overview** | Dashboard (the Cyber Defence Center), Dashboards (custom, §21), Standup (§7) — each a full page |
| **Triage** | Cases (§3), **Case Manager** (§3), Campaigns (§16), Logs (a unified cross-source log browser, §2a), Workspace → **Chat** (§5) and **Entity investigation** (§4) as left-nav children, Approvals |
| **Intelligence** | Knowledge corpus (§9), Reference runbooks, Operator memory (§10), Response playbooks, Agent personas |
| **Analytics** | Metrics, **Agent effectiveness** (§7a), Cost (§8), Models (§22), Baseline (§17), Batch jobs (§22) |
| **Notifications** | Inbox (the in-app notification inbox, §23) |
| **Platform** | Sources (§2, standalone — not inside Settings), Audit log (§32), Auto-tuning (§15), Settings (§25, with Users and Roles as children) |

The pinned **Documentation** utility at the bottom of the rail opens the
version-matched Help Center bundled with this application at `/docs/0.1/`. That
installed copy is authoritative for the controls and behavior in the running build;
public Stable and Development documentation are secondary destinations for upgrade
planning and preview. Lazy destinations immediately show a route-labelled
skeleton/progress state rather than a blank page; reduced-motion users receive the
same status without animation.

Every analytics/triage surface calls its backend endpoints directly; every
endpoint below is also usable via `curl` (§33). RBAC (`<Can>` guards) hides an
item a signed-in user's role can't reach; with auth off, everything shows.

### Cyber Defence Center dashboard

**Overview → Dashboard** is the shift landing page. One time-range control scopes
the five primary KPIs: **Open Cases**, **Critical / High**, **Escalated to Human**,
**False Positive Rate**, and **Auto-resolved**. Open Cases includes all non-terminal
statuses (`new`, `open`, `needs_human`, `investigating`, `escalated`, `on_hold`).
Critical / High spans both open and resolved cases in the window and states the
split as `N open + M resolved`; it never silently drops an unknown lifecycle.
False Positive Rate shows the selected-window rate only — it carries no
period-over-period percentage chip.

Hovering or keyboard-focusing a landing metric reveals its recent trendline for the
same window (`GET /api/metrics/trends` zero-filled case-cohort buckets, the per-day
timing series, or the spend ledger series). Each hover card names the exact series
it draws and its bucketing; a metric with no measured series shows a quiet "No trend
data yet" line, and the combined Critical / High tile deliberately has no trendline
because no per-severity series exists.

`GET /api/metrics/trends?window_hours=24` (`metrics:view`) is the hover-trendline
feed: `window_hours` clamps to 1..720 and the UTC-aligned, zero-filled buckets follow
a fixed width ladder (≤24 h → 60 min, ≤72 h → 180, ≤168 h → 360, else 1440), with the
newest bucket partial. Per bucket it reports new/closed/auto-closed/FP/needs-human/
escalated case counts, an `fp_rate` (null when no verdicted case), and raw `alerts`
from the durable noise counters (null while they warm up); a
`truncated`/`store_total`/`fetched` marker keeps a partial (newest-5000) tally
honest. Like the other dashboard rollups it is served from a shared short-TTL (~5 s)
case-page cache, so the LIVE fan-out costs one store scan per refresh window.

False Positive Rate and Auto-resolved use the server posture rollup for the exact
selected range. A range change keeps the last successful posture snapshot mounted —
explicitly marked by the tiles' `Loading …` sub-line — while the superseded request
is cancelled and the new window loads, so the dashboard never blanks. Only a
response whose echoed window still matches the selector is accepted; a slower
earlier request cannot repaint those tiles beneath a new range.

The next row uses the available height for a current-open-queue **Active Risk
Index**, Open-above-Resolved severity rings, and exactly four **Latest Cases**.
Hovering or keyboard-focusing a latest row reveals bounded case detail without
changing the selection. Open/Resolved controls drill into their lifecycle scopes;
the combined Critical/High tile opens the selected-window case list without applying
one misleading single-severity filter.

The **Noise Reduction** ribbon presents alerts ingested → after clustering → cases
opened → {auto-cleared by AI | escalated | closed by human}, with the six text labels
and values aligned below the larger flow. The labels are authoritative: Auto-cleared
and Escalated partition opened cases, while Closed by human is an analyst-owned subset
of Escalated and must not be added as a third partition. Selecting an outcome applies the matching selected-window Cases filter;
earlier stages open the selected-window Cases context. Burndown and the compact MTTD / first-human-
response summary live below; full MTTA, MTTR, dwell, and other detail live under
**Deeper analytics**. The page opens at **Last 24 hours** with visibility-aware
**LIVE** refresh every five seconds; choose Off, 5 seconds, 30 seconds, 1 minute, or
5 minutes when another cadence is appropriate. **Expand** opens Noise Reduction in a
near-fullscreen, horizontally scrollable view: the aggregate funnel remains the complete
volume view, and a lazy bounded section shows the newest persisted redacted alert →
deterministic cluster → opened case → current/terminal-outcome lineages. Coverage, store-
page, and sample truncation notices remain visible. Raw alert identifiers and payloads are
not exposed; alerts that never formed a case remain aggregate counts only. The Cases
page loads a bounded record window, so its filtered rows may be a lower bound even when
the aggregate outcome count is complete.

The full Agent health panel lives on **Analytics → Effectiveness**, follows that page's
24h/7d/30d selector, and is directly reloadable at
`#/metrics?tab=effectiveness`. Overview renders no health card while every readable
signal is healthy. A positively detected precedent-corpus, migration, or auto-close
degradation produces one compact warning that opens the full panel; unknown evidence
is explained there without being promoted to a false incident.

---

## 1. First-run wizard (4 stages)

The wizard (`webui/src/soc/pages/Wizard.tsx`) is a focused four-stage setup
workspace. It shows automatically when `GET /api/setup/status` reports
`setup_complete: false`, and administrators can re-run it from **Settings**. The
desktop progress rail and compact mobile progress bar use the same sequence:
**Workspace → Data sources → AI runtime → Review & launch**. Each stage heading
receives focus after navigation, and the sticky action bar remains available while
long source forms scroll.

### Stage 1 — Workspace

Choose **Live environment** or **Synthetic demo**:

- Live connects operator-owned telemetry and a live model provider. Full live
  triage requires at least one source and an OpenAI key for the default Luna roles,
  or another supported provider key plus explicit role reassignment.
- Synthetic demo seeds isolated sample activity and forces the deterministic `$0`
  mock runtime. It never calls a configured live provider. Sources and a live key
  are therefore optional in this mode (§29).

### Stage 2 — Data sources

This is the heart of the vendor-agnostic design. The step embeds the same
manifest-driven **`SourceEditor`** the standalone Sources page uses (§2) — no
per-connector UI code. Pick a connector from `GET /api/connectors` (grouped by
category: `siem`, `edr_xdr`, `transport`, `queue`, `object_store`, `file`) and the
editor renders a validated form from that connector's `auth_fields` +
`config_fields`.

- **Pull sources** (Elasticsearch / OpenSearch / Wazuh): supply the cluster URL,
  a **read-only** API key, an optional CA cert, and the **field mapping**
  (`data_view_pattern`, `time_field`, `source_ip_field`, `user_field`,
  `host_field`, `rule_field`, `rule_name_field`, `severity_field`). Defaults match
  ECS (`source.ip` / `user.name` / `host.name` / `event.module` / `@timestamp`).
- **Push sources** (webhook / HEC / syslog / Kafka / Kinesis / Event Hub / Pub/Sub
  / RabbitMQ / NATS / MQTT / Redis Streams / S3 / GCS / Azure Blob / file): supply
  the transport's auth + config (e.g. a webhook `auth_mode` + `token`, or a
  syslog `bind_host` / `port` / `protocol`).

For encrypted Syslog, choose `protocol: tls`, mount the server certificate and key
inside the backend container, and enter those container paths as `tls_cert_file` and
`tls_key_file`. `tls_key_password` is a write-only secret. Optional mTLS uses
`tls_client_ca_file` plus `tls_require_client_cert: true`. TLS requires version 1.2
or newer and is fail-closed: missing/unreadable material stops that receiver instead
of silently accepting plaintext TCP. UDP and plain TCP remain unauthenticated
plaintext transports and should be used only on a separately trusted network.

**Test connection** (`POST /api/connectors/test`) evaluates the current draft
without saving it. Saving sends per-source secret fields to
`POST /api/sources/{id}/secrets` and non-secret configuration to
`POST /api/sources`. You can add multiple sources and mark one pull source
**primary** (the agent's main read surface). Secret values are never returned; the
source record exposes only configured field names.

An open source editor is a guarded draft. Back, a progress-stage link, or Close on
a setup re-run first asks whether to discard it; cancel keeps the draft in place.

### Stage 3 — AI runtime

Paste an **OpenAI** key for the default GPT-5.6 Luna runtime, and/or another
supported provider key if you plan to change role assignments. Keys remain write-only and the UI
shows only their configured state. Blank values leave an existing provider
unchanged. A newly typed key saves through `POST /api/setup/secrets` whenever the
operator leaves this stage—Back, Continue, a progress-stage link, launch, or Close
on a re-run all use the same guarded transition. A failed save keeps the operator
on AI runtime with a retryable error.

Register a self-hosted OpenAI-compatible endpoint and choose per-role models under
**Settings → Models** after launch (§22). The setup workflow does not pretend to
configure model assignments.

### Stage 4 — Review & launch

The readiness list uses **Ready**, **Needs attention**, and **Optional** states and
names the overall outcome truthfully:

- **Demo workspace is ready** for Synthetic demo;
- **Ready for live triage** when a live source and provider are configured; or
- **Ready with limited capabilities** when live telemetry or a provider is missing.

The **Automation posture** row states that adaptive investigation routing and
related-case grouping are on by default. Detailed controls live in **Settings**;
the posture never changes the deterministic close/escalate policy.

On first run, **Launch Agentic SOC** calls `POST /api/setup/complete`. That flips
`setup_complete=true`, starts the poller (if `polling_enabled`), and reconciles
enabled background receivers. A lost completion response is checked against
`GET /api/setup/status` before a failure is shown, and completion hands off to the
console once only.

On a Settings re-run, the final label is **Apply changes** and **Close** exits the
workflow. Existing sources and configured secrets stay in place unless explicitly
changed or removed. Correlation, risk, model routing, cost controls, the kill
switch, and enrichment remain editable under **Settings** (§25).

---

## 2. Managing sources (day-to-day)

**Sources** is a standalone top-level **Platform** nav page (`webui/src/soc/pages/
Sources.tsx`) — not nested inside Settings. It presents every configured source as
a dense, sortable, QRadar-style **`DataTable`** (`webui/src/soc/components/
DataTable.tsx`), the same shape as a "Log Source Management" console: a toolbar
(faceted filter + free-text search + a live "Log Sources (N)" count + a prominent
**"+ New Log Source"** + a manage-columns gear), multi-row **bulk-select** with an
Enable / Disable / Remove strip, and per-row **Status** dot, **Last Event**, an
inline **Enabled** toggle, and a kebab menu (Browse logs · Make primary · Edit ·
Remove).

**Status** and **Last Event** are derived, honestly, from `GET /api/sources/health`
— the durable poll cursor age for a PULL source, the live-tail buffer depth for a
PUSH receiver. Since Round 10 the health payload also carries `last_poll_at` /
`last_poll_ok` / `last_poll_error` / `events_per_min` / `silent` (a multi-feed
source whose feeds **all** raise now honestly reports unhealthy instead of merely
looking quiet), and the page shows a top-of-table **coverage banner** rolled up
from `GET /api/sources/coverage` — see §33 for the full coverage-observability
story. Add/Edit open the manifest-driven **`SourceEditor`** in a dialog (the same
form the wizard uses, §1); **Browse** opens the **`SourceLogsSheet`** (§2a).

| Action | Endpoint |
|---|---|
| List configured sources | `GET /api/sources` |
| Per-source health (status + last event, feeds the table) | `GET /api/sources/health` |
| Fleet-wide coverage rollup (feeds the banner + Overview tile, §33) | `GET /api/sources/coverage` |
| List available connectors (+ field schema) | `GET /api/connectors`, `GET /api/connectors/{source_type}` |
| Add / update a source | `POST /api/sources` |
| Set / clear a per-source secret | `POST /api/sources/{id}/secrets` |
| Test connectivity | `POST /api/connectors/test` |
| Browse a source's recent logs | `GET /api/sources/{id}/logs?limit=&query=&from=&to=` (see §2a) |
| Delete a source | `DELETE /api/sources/{id}` |

**Pull vs push at runtime:**

- **Pull** sources are polled by the in-process poller — `engine/poller_manager.py`
  fans out over **every** enabled pull source, on `poll_interval_seconds` (and on a
  manual `POST /api/poll`). Each pull connector compiles the agent's structured
  queries to its own dialect; the agent never emits raw DSL.
- **Push** sources arrive asynchronously:
  - **Webhook / HEC** are **route-driven** — a source POSTs to
    `POST /api/ingest/{source_id}` (§33). No background task; the route verifies
    auth, parses + normalises to OCSF, and feeds the same pipeline.
  - **syslog / Kafka / SQS / Kinesis / Event Hub / Pub/Sub / RabbitMQ / NATS /
    MQTT / Redis Streams / S3 / GCS / Azure Blob / file** run as **background
    receivers** that start on app startup (and on save) and `emit` batches into
    the shared ingest path. Their optional client libraries are imported lazily
    (see `docs/TROUBLESHOOTING.md`) and, for socket receivers (syslog), the
    configured port must be **published** in your compose file.

Per-source secrets (a webhook token, a Splunk HEC token, a cloud credential) live
in the **in-memory secret tier** and are **never persisted** — only the configured
field *names* are stored on the source (`configured_secrets`). They are lost on a
backend restart unless also supplied via env/`.env`.

### Test connection — what `ok`, `mode`, and `cluster_monitor` mean

`POST /api/connectors/test` returns a `ConnectionTest`: `{ ok, message, mode?,
cluster_monitor? }`. For a **pull** source the test runs the **cheap, scoped,
read-only search first** — that read is the authoritative pass/fail gate, so a
correctly-scoped **read-only API key passes** (it does **not** need cluster
privileges):

- **`ok:true`, `mode:"read_only"`** — the scoped read succeeded but the key lacks
  `cluster_monitor` (the expected, healthy state for a least-privilege read-only
  key). The UI shows a green *"Read-only access verified — N events readable in
  `<pattern>`. Cluster-monitor privilege not granted (expected for a read-only
  key)."* callout.
- **`ok:true`, `mode:"full"`, `cluster_monitor:true`** — the scoped read succeeded
  **and** the key can also `ping()` the cluster (has `cluster_monitor`). A green
  "Connection verified" callout.
- **`ok:false`** — only when the **scoped read itself fails**: auth (`401`/`403` on
  the index → wrong/under-scoped key) or network/TLS (URL not routable, or a
  private CA isn't trusted). A failed `ping()` alone is **not** a failure.

> A read-only key cannot do `HEAD /` (a cluster-level op), so the test no longer
> gates on `ping()` — `ping()` is now only the extra `cluster_monitor` signal that
> upgrades `mode` to `full`. (See `docs/TROUBLESHOOTING.md` §D.)

---

## 2a. Browse a source's logs

From the Sources table's kebab menu, **"Browse logs"** (and the table's
**Browsable** column) is shown only for sources the **server** reports as
browsable — `GET /api/sources` returns `can_browse` per source from the same
predicate the browse routes gate on, which resolves to the connector's `browse`
capability (`capabilities:["browse"]`: all pull connectors, and every push
receiver, which the registry augments automatically). It opens the
**`SourceLogsSheet`**, a live window onto that one source's recent events, backed
by `GET /api/sources/{id}/logs?limit=&query=&from=&to=` (auth-protected).

| Control | What it does |
|---|---|
| **Table** | One row per event: timestamp · `source.ip` · module/rule · severity · message. |
| **Expand a row** | Reveals the **raw `_source`** document in a code block. |
| **Search box** | Free-text `query` filter passed to the source. |
| **Time range** | A date-range picker (`from`/`to`); defaults to the **last 15m**. |
| **Live tail** | A toggle that auto-refreshes every **10s** so new events stream in. |

How the rows are produced depends on the source's runtime mode:

- **Pull sources** (Elasticsearch / OpenSearch / Wazuh) run a **bounded
  (hard-capped at 200), read-only, field-mapping-aware scoped search** against the
  source's own `data_view_pattern` / field mapping / TLS (via the per-source ES
  client, `state.es_client_for_source()`) — so what you see is exactly what the
  agent can read.
- **Push sources** (webhook / HEC / syslog / queues / object-stores) have no index
  to query, so they return the **last N events from an in-memory live-tail ring
  buffer** (capped at **500 events per source**) that `IngestService` keeps as
  events arrive. A connector that supports neither returns `501`.

Each row is `{ ts, source_ip, user, host, rule, severity, message, _raw }` where
`_raw` is the full log document. **Secrets are never returned.** An unknown source
id returns `404`; a read failure (e.g. an auth/TLS error against a pull source)
returns `502`. All log content renders as plain text / code blocks — it is
attacker-influenceable and fenced/escaped as UNTRUSTED (see `SECURITY.md`).

**Browse across every source at once.** `GET /api/logs` (the **Logs** page under
**Triage**) fans out the *exact* per-source read above over **every enabled,
browse-capable source** concurrently, merges the rows newest-first, and tags each
with a mandatory `source_id`/`source_name` provenance column. One slow or failing
source degrades to a per-source error entry and never blocks the rest
(`asyncio.gather(return_exceptions=True)`); still hard-capped at 200 rows and
read-only.

Pass the optional **`source_id`** to scope the fan-out to exactly one source
(`GET /api/logs?source_id=prod-es`). Omitting it is the default all-sources
behaviour. An id that is not visible in the current mode returns `404` — while
**Demo Mode** is active a real tenant id is deliberately indistinguishable from an
unknown one, so a demo session can never confirm that a live source exists — and a
visible id that is not an eligible browse target (disabled, no registered
connector, or no `browse` capability) returns `501`, the same status and detail the
per-source route uses.

### The browse contract (what it is, and what it is not)

Browse is a **bounded read-only window**, not a log archive or a search product.
Read this before building on it:

| Guarantee | Detail |
|---|---|
| **Capability is server-authoritative** | `GET /api/sources` returns **`can_browse`** per source, computed by the *same* predicate the browse routes gate on. The Console never re-derives it from connector manifests or health — one definition, so the "Browse logs" affordance can never disagree with what the endpoint will do. |
| **Bounded, never complete** | `limit` is clamped to **1..200** (applied per source *and* on the merge) and there is **no pagination, cursor, offset, or `search_after`**. Both envelopes echo the effective **`limit`** and a **`truncated`** flag, so a surface says *"most recent N"* rather than implying completeness. `truncated: false` only means nothing was demonstrably cut — it is **not** proof you have seen everything. |
| **One `truncated` rule, both routes** | `truncated` is computed the same way everywhere. When the connector reports a **coherent match total** the answer is exact: `total > returned`. A page that is saturated *and* complete (`total == returned == limit`) is **not** advertised as having more. Only when a total is absent or incoherent — a live-tail ring, a connector that omits it — does a **saturated page** stand in as the evidence of a cut. In the unified envelope every `sources[]` entry carries its **own** `truncated` by that same rule, and the envelope flag is `merge was cut OR any single source was cut`. Each source is itself read at `limit`, so a one-source read (a `source_id` scope, or a single-source deployment) can never overflow the merge — without the OR the two routes would report opposite flags for identical data. |
| **Two read modes** | Each response (and each `sources[]` entry in the unified envelope) carries **`mode`**. `"search"` = a real backing query where `from`/`to`/`query` apply and a match `total` is reported when the connector supplies one. `"buffer"` = an in-memory live-tail ring where `from`/`to`/`query` are **ignored** and no total exists. `mode` describes the **filters**, never the durability of the backing store: a **Demo Mode** adapter reports `"search"` because it genuinely applies `from`/`to`/`query` over its ring — see *Buffers are volatile* for the separate durability fact. |
| **Buffers are volatile** | The push live-tail ring is **process-local and in-memory** (500 events per source), so it is lost on restart and is not shared across replicas. It is a live tail, not storage. |
| **Rows are NOT OCSF** | Browse deliberately bypasses OCSF normalisation. `_raw` is the **verbatim source-native document** — the strongest untrusted-data case in the product. Every field on every row is attacker-influenceable: render as plain text, `_raw` only inside a code block, never as markup (#9). No browsed row is ever sent to a model (#7). |
| **Scoped read-only key** | Pull reads run through `state.es_client_for_source()`, which honours the source's own URL/TLS and **explicitly drops the management key** (#1). |
| **Permission** | Both routes are gated on **`sources:read`** — the same grant that lists source configuration. There is deliberately no separate "read log content" permission today. |

**Deliberately deferred** (do not assume these exist): pagination / PIT / cursors
and any `total` reconciliation, structured filters (`ip`/`user`/`host`/
`severity_gte`), sort control, column/field selection, saved views, `deep_link`
"open in Kibana/Wazuh" plumbing, export or download of browsed rows, durable
storage for push-source logs, and any LLM summarisation of a browsed window.

---

## 3. Cases (Surface)

The triage workbench. The cases table (`GET /api/cases?limit=100`) shows **Entity
· Rules · Risk · Status · Disposition · Verdict · Created** with per-status
filtering (`?status=escalated`), per-surface filtering (`?surface=automated_scan`),
and per-entity filtering (`?entity=10.10.1.152`).

### Case Manager (canonical detail workspace)

**Case Manager** sits directly beneath Cases in the Triage rail. It is the newer,
split-pane way to work the same case data while the table-based Cases surface remains
available during the migration. The left queue supports **Active / All**, search,
severity/status filters, latest/highest-risk sorting, and manual refresh. The right
pane embeds the canonical CaseDetail workflow: the same six
tabs, lifecycle confirmations, deterministic decision card, RBAC gates, reinvestigate,
playbooks, exports, notifications, collaboration/tasks/activity, and case-scoped chat.
Its reference-matched header keeps only **Share**, **Take Action**, and the pane-close
control at the upper-right; every lifecycle and operational command is consolidated
inside **Take Action**. Timeline and Investigation are already tabs and are not
repeated in that menu. Opening a row or deep link on **Cases** now announces a short
handoff and opens that exact record in Case Manager; `caseId` stays in the URL across
refresh, history, and bookmarks instead of opening a second detail drawer.
At tablet/mobile widths the selected case replaces the queue and a **Cases** back control
returns to the list. Counts explicitly distinguish the loaded 200-case window from the
backend total when those differ.

For an opened record, **Overview** conditionally adds a flat **Investigation inputs**
summary when the latest investigation run recorded applicable context: approved
operator **memory consulted**, indexed **RAG knowledge retrieved**, **runbook references
retrieved**, a **playbook actually consulted**, or a deterministic platform threshold
tuning snapshot. **Review inputs** opens the detailed Investigation evidence. The
section stays absent when no inputs were recorded; an unavailable provenance lookup is
reported as unavailable rather than as an empty successful run.

At desktop width, drag the divider between queue and detail. It defaults to 400 px,
stays between 320 and 680 px, and preserves at least 560 px for detail. Focus the
divider and use Left/Right Arrow in 24-pixel steps (48 with Shift), Home/End for the
bounds, or double-click to reset. The chosen width is stored in the browser.

The complete operator contract—including loaded/visible selection scope, every
bulk action and permission, confirmations, per-case eligibility, progress, and
partial-failure behavior—is maintained in
[`docs/analyst/case-manager.md`](analyst/case-manager.md). Do not assume Case
Manager selection behaves exactly like the older table bulk bar.

In short, its current menu is **Acknowledge · Assign · Add tag · Set status · Set
disposition · Reinvestigate · Resolve**. Raw Close is omitted. The exact selected IDs
and action input are submitted as one background-job snapshot. After `202 Accepted`,
the dialog closes and progress, cooperative cancellation, bounded failures, and the
terminal result remain in **Analytics → Jobs** and **Inbox** across navigation/reload.
Result links seed a current status/assignee/tag context, not an immutable exact case
cohort; use job counts, case history, and Audit for exact accountability.

**Two-axis taxonomy.** A case carries both a lifecycle **status** and an analyst
**disposition** — they are independent.

- **status** (where the case is in its lifecycle): `new` (candidate, pre-LLM),
  `open` (investigated, awaiting an analyst), `investigating` (actively worked),
  `escalated` (marked for analyst escalation), `on_hold` (paused), `resolved` (worked
  to completion, pending final close), `closed` (terminal). `needs_human` is
  **retained as a deprecated alias** of "open · awaiting analyst" — the
  deterministic `decide()` still uses it internally, and old stored cases load
  unchanged.
- **disposition** (what the case turned out to be): `true_positive`,
  `false_positive`, `benign`, `suspicious`, `duplicate`, `undetermined` (the default
  for cases that predate the taxonomy). Set it explicitly with the `set_disposition`
  action; `confirm_fp` also stamps `false_positive` when the disposition is still
  undetermined.

### Case detail + lifecycle

Opening a case loads the **stored** case by id (`GET /api/cases/{id}`) — it does
**not** re-investigate. `CaseDetail` renders **six tabs**: **Overview** (a compact
decision brief, signal profile, persisted risk-factor values, source/agent/code
provenance, conditional latest-run Investigation inputs, entities, attack story,
ownership, and history), **Timeline** (the
"what happened" narrative with Risk Assigned and Decision — see §11), **Investigation** (the AI assessment,
input evidence, pinned deterministic `DecisionCard`, and full agent trace — see §11),
**Threat** (§12's threat-context panel), **Collab** (§18's threads/tasks), and
**Chat** (a case-scoped chat follow-up, §5).

The Threat tab includes **How this case was clustered**, a read-only projection of
persisted facts: Input alerts → Correlation cluster → Opened case. Hover or focus a
node for source counts, grouping, threshold/window, current status/verdict, and
bounded related-case links. Alert references are stable one-way hashes and are
limited to 12; raw source identifiers and payloads are never returned. Older cases
may show limited or unavailable cluster metadata rather than an invented
reconstruction.

**Analyst actions** go through `POST /api/cases/{id}/action` with
`{ "action": "...", "note": "...", "analyst": "..." }` (plus the optional fields
noted below):

| action | resulting status | meaning |
|---|---|---|
| `close` | `closed` | analyst closes the case |
| `confirm_fp` | `closed` | analyst confirms a false positive (sets disposition `false_positive` if still undetermined) |
| `resolve` | `resolved` | worked to completion, pending final close |
| `reopen` | `open` | reopen a closed/resolved case |
| `escalate` | `escalated` | mark the case Escalated for analyst action |
| `deescalate` | `open` | undo an escalation |
| `hold` | `on_hold` | pause the case (awaiting info / third party) |
| `resume` | `open` | take a held case off hold |
| `set_status` | the `status` field | move to an arbitrary legal status |
| `set_disposition` | unchanged | set the analyst `disposition` (no status change) |
| `acknowledge` | `investigating` | mark the case as being worked (the first-response clock stops here) |

The body may carry `status` (for `set_status`), `disposition` (for
`set_disposition`), `reason` (recorded as `status_reason`
on `hold` / `resolve` / `set_status`), and the existing `resolution` / `assignee` /
`priority` / `tags`. A **transition guard** rejects illegal moves — e.g. leaving a
terminal status (`closed` / `resolved`) is only legal via `reopen` (a `400`
otherwise). Every action sets `decision_by=analyst`, stamps `updated_at`, appends
an entry to the case **history** + `status_history`, and is audited. A `close` /
`confirm_fp` also indexes the resolved case (entity, rules, verdict, risk, note,
trigger reason) into the **resolved-case RAG baseline** when `rag.enabled` +
`rag.use_resolved_cases` — a RAG/embedding failure can never break the action
(fail-safe).

**Re-investigate in place** (`POST /api/cases/{id}/investigate`) re-runs the same
pipeline for a stored case with `force=True`, rebuilding the cluster (preferring an
exact id-based re-query of the member events, falling back to a config-windowed
entity re-query with the auto-widen ladder) and **preserving the case's original
provenance**. If the retained log window has aged out, it rebuilds the
investigation from the **stored evidence already on the case** rather than
failing; a NEUTRAL `400` is returned only when neither a re-query nor the stored
evidence is usable.

> **Decision invariants (code-enforced):** the **close/escalate decision is a
> pure, deterministic function** (`case_manager.decide()`) over `(verdict,
> confidence, risk_score, policy)` — never raw LLM output. **FALSE_POSITIVE
> auto-close is ON by default** above a confidence/risk bar
> (`auto_close.false_positive`: 0.85 confidence, ≤30 risk, a 1440-minute human
> objection window). **TRUE_POSITIVE auto-close is a real, opt-in policy knob**
> (`auto_close.true_positive`, **off by default**; when enabled: 0.95 confidence,
> ≤10 risk, a 4320-minute objection window). Only **NEEDS_HUMAN** (or a
> missing/unknown verdict) is the **code-enforced, non-tunable** never-auto-close
> guard — everything else fails safe to a human. The legacy `fp_auto_close` field
> is deprecated and migrated once into `auto_close.false_positive`.

---

## 4. Entity investigation (Surface)

A left-nav child under **Workspace** (alongside Chat, §5). Choose **IP / User /
Host**, type a value, and run an entity investigation. The visible workflow explains
the job: scope telemetry → analyze evidence → create a case. This POSTs `/api/investigate` with
`{ "entity": { "type": "ip", "value": "10.10.1.152" }, "source_surface": "investigate" }`.
The backend pulls in-scope events for that entity (same scope + suppression
filters the poller uses), correlates them into a cluster, and runs the full
pipeline → enrich → deterministic risk → router role → investigator role
(only if uncertain/serious) → deterministic Case Manager decision. It returns a
**case**, rendered as a **verdict card**.

**Lookback + auto-widen.** The starting lookback is `investigate_lookback`
(default `now-24h`); a request may override it with a `lookback` field. If the
window yields **zero** events, the backend auto-widens through a ladder
(`configured → now-7d → now-30d → now-365d`) before giving up. When nothing is
found even in the widest window the response is a NEUTRAL `400` (rendered as an
empty-state, not a red error).

**Example verdict card** (case fields the card shows):

```json
{
  "verdict": "TRUE_POSITIVE",
  "confidence": 0.82,
  "risk_score": 71,
  "evidence": [
    { "summary": "412 failed SSH logins from 10.10.1.152 in 90s, then 1 success for 'alice'." },
    { "summary": "Source IP reputation: AbuseIPDB confidence 88 (known SSH brute-forcer)." }
  ],
  "mitre": ["T1110", "T1078"],
  "recommended_action": "Isolate web-01, force-reset alice, block 10.10.1.152 at the edge.",
  "reproduce_query": "source.ip: \"10.10.1.152\" and event.module: \"sshd\""
}
```

---

## 5. Chat (Surface)

A read-only natural-language console (`POST /api/chat`), the **Chat** child under
**Workspace** (the same left-nav host as **Entity investigation**, §4 — **ONE** chat
engine, two entry points). Type a question; the agent may turn your intent into a single
read-only structured query, render the first 50 hits as a table, and produce a
**two-turn analysis**: the first model turn decides the query, then the engine
builds a compact, fenced-UNTRUSTED aggregate of the hits and re-prompts the model
for the analysis you read. If the second turn is unavailable, chat degrades
gracefully (it never hard-fails). Both turns are metered through the single
gateway.

Workspace Chat keeps a bounded, per-user history on the application's selected state
backend. On desktop, the newest conversations appear first in the searchable history
rail; on a narrow screen, **History** opens the same list in a Sheet. Select a row to
restore its authoritative saved transcript. A conversation can be renamed or deleted
from its row menu. **New chat** starts an unsaved draft: it enters history only after the
first successful assistant response has also been verified in the state backend, so
cancelled questions, provider failures, and failed history writes do not create records
that only look durable. The first saved exchange supplies a deterministic title that the
operator can rename later.

The workspace preserves unsent input separately for each visited conversation and for
the new-chat draft. You can inspect an earlier thread and return without losing a query
you were composing. These drafts stay in the current browser and are not part of server
history until sent. Same-browser tabs announce history mutations, and summaries also
refresh when Chat opens or its tab regains focus, so changes made in another tab or
device appear without requiring a route reload. A history-store outage is shown as a
retryable error, never as an empty account.

The active thread has one title, one **Agent ready / Agent working** indicator, and one
composer docked at the bottom. Use the sliders button beside the input to choose a
queryable source or model; the current choices remain visible in the quiet composer
footer. While a saved conversation is restoring, or while the agent is working, the
composer and thread switching stay disabled so a reply cannot land in the wrong thread.
If restore fails, use **Retry** or **Start new chat** without losing the surrounding
history workspace.

An explicit source selection is strict. If that source is disabled, removed,
non-queryable, or unavailable when the turn runs, Chat reports the scoped failure instead
of silently querying Primary. Primary is used only when no source was selected. Each
saved assistant turn records the effective source and model that actually served it, so
changing the composer controls later does not rewrite the provenance of earlier answers.

Each assistant answer keeps supporting detail in one collapsed **Evidence & execution**
row. Open it to inspect the read-only query, tools, knowledge, citations, reasoning,
effective source/model, and metered cost that are available for that turn. A saved
snapshot that was compacted explicitly notes that larger evidence structures may be
omitted. The transcript follows new
messages only when you are already near the bottom; if you scroll up to read earlier
evidence, **Jump to latest** appears instead of moving you unexpectedly.

This history begins with the version that introduced saved Workspace conversations.
Earlier Chat turns lived only in the browser component and cannot be recovered or
backfilled. The current navigation history retains up to **50 conversations per user**
and **100 messages per conversation**. When that boundary removes older material, Chat
marks the retained history as incomplete instead of presenting it as the whole thread.
The bounded history is a navigation aid, not an audit substitute; use the usage and audit
surfaces for metering and governed activity records.

Add `case_id` to seed a case follow-up (the engine already knows the case's
entity, verdict, confidence, risk, rules, and top evidence). Add a `context`
object (`app` / `data_view` / `time_range` / `query` / `selection`) to supply
es_query defaults — server-side it is fenced **UNTRUSTED** and never becomes
instructions.

Case-scoped chat remains separate. The **Chat** tab inside Case Manager uses the same
chat engine but stays with the selected case and is never written into the operator's
personal Workspace history—even if a caller supplies the Workspace persistence flag.
Resume a Workspace conversation by sending its `conversation_id` with
`persist_conversation: true`; the server-owned transcript, not caller-supplied history,
is authoritative for that resumed turn. Workspace sends also carry an 8–128 character
`idempotency_key`. If a connection drops after submission, retry the same turn with the
same key: the backend returns the committed result or commits it once instead of creating
a second billed turn. A still-running turn returns `409 chat_request_in_progress`;
conflicting reuse returns `409 chat_idempotency_conflict`. If all 256 per-user live request
leases are occupied, a new turn returns retryable `409 chat_request_capacity_busy` before
the model is invoked. An unavailable explicit source
returns `422 chat_source_unavailable`, and an unverifiable history read/write returns
`503 chat_history_unavailable`.

If no LLM provider is configured, chat replies *"The assistant is unavailable (no
model configured). Configure an LLM provider key in Settings."* — it never
silently errors.

---

## 6. Automated scan data (legacy surface)

**Automated scans is no longer a primary navigation destination.** It duplicated the
same autonomous-case lifecycle that Case Manager now presents with better filtering,
selection, actions, and complete case detail. Existing `#/scans` bookmarks and the API
remain compatible for this release, but operators should use **Triage → Case Manager**
for the active queue and **Cases** for the complete record.

The background-investigation queue (`GET /api/scans?limit=100`). **`background_scan_enabled`
now defaults ON** (Round 10 — comprehensive ingestion, §33), so this queue is live
out of the box, not something you have to switch on first. The poller correlates
each new in-scope cluster and either:

- **auto-investigates** it — an `alerts`-role cluster always does (every SIEM
  detection is triaged); an `events`-role cluster does once its deterministic
  `risk_score` clears `auto_investigate_risk_floor` (default **70**), or its rule
  is on the **auto-forward allowlist** (`*` = all) — see §33 for the full gate, or
- **registers it as an OPEN candidate** (deterministic risk only, no LLM cost) so
  nothing is ever dropped — those appear in **Cases** for manual triage, honestly
  labelled "awaiting" until it clears the floor or cap.

Every case carries a `trigger_reason` (which rule, how many events, in what
window, grouped on which entity, plus a plain-English sentence). The new-scan
badge polls `GET /api/scans/notifications?since=now-24h`.

**Tune auto-forwarding** in **Settings → Organization → Advanced** (§25): the
**Auto-forward allowlist** still force-forwards specific rule values
(comma-separated; `*` = all), and the `autopilot_profile` dial (§33) moves the
risk floor / daily budget / per-tick cap together in one step.

---

## 7. Standup (Surface)

Aggregate-then-summarise (`GET /api/standup/report?window_hours=24`, the legacy
`GET /api/standup?window_hours=24` alias still works). The backend runs near-free
aggregations over the window (events from the log source, case stats from the
state store), then sends ONLY the compact JSON aggregate to the configured router model for
prose — **raw logs are never sent to a model**. You get a prose **Summary**, stat
tiles (total events · unique IPs · cases opened), the case breakdown by-verdict
and by-status, and top rules / source IPs / users / hosts.

If the summariser model is unavailable, the response is the **deterministic**
summary (ends with *"(LLM summary unavailable; this is the deterministic
aggregate.)"*). If standup is disabled, the response is
`{ "enabled": false, "summary": "Standup is disabled in settings." }`.

**Forward-looking: attention queue, action items, and shift handoff.** Standup is
not just a look back — `engine/shift_report.py` also derives a deterministic
**attention queue** (aging/SLA-breaching/unassigned cases + workload-by-analyst),
surfaced alongside the report. Analysts can raise + track **action items** for the
next shift:

| Action | Endpoint |
|---|---|
| Action items for the window | `GET /api/standup/action-items` |
| Create an action item | `POST /api/standup/action-items` |
| Update an action item | `PUT /api/standup/action-items/{item_id}` |
| Delete an action item | `DELETE /api/standup/action-items/{item_id}` |
| Acknowledge the shift report (handoff) | `POST /api/standup/acknowledge` |
| List acknowledgements | `GET /api/standup/acknowledgements` |

Action items and acknowledgements are advisory shift-handoff bookkeeping only —
aggregate-derived, never fed raw logs, and never touching `decide()` (non-negotiable
#7, #3).

---

## 7a. Agent effectiveness (Surface)

Open **Analytics → Agent effectiveness** (the **Effectiveness** analytics tab; the
reload-safe `#/metrics?tab=effectiveness` URL opens the same tab). Access follows the backend's
`metrics:view` permission. The page reads
`GET /api/metrics/agent-improvement` and compares the last **7 complete UTC days**
with the preceding **28 complete UTC days**. It is read-only: loading it makes no
model call, writes no case or feedback, and cannot influence risk scoring or
`decide()`.

The three displayed measurements are observed outcomes, not a model-training score:

- **Analyst-reported verdict agreement** and **material analyst correction rate**
  are two views of the same comparable analyst-grade cohort. They form one quality
  domain and are never counted as two independent votes.
- **Human review turnaround** is the separate domain. It measures median elapsed
  time from first human acknowledgement in the final live episode to the final human
  terminal transition; it is not active analyst touch time.
- The headline can say improving only when both independent domains improve and the
  safety guardrails are evaluable and unbreached. Otherwise it says stable, mixed,
  safety review, or insufficient evidence as supported by the data.

Comparisons are adjusted to a shared **source × severity** mix. The page exposes
current/baseline samples, comparable coverage, suppressed strata, exclusions, the
daily series, and whether the bounded case read was truncated. Its guardrails are
confirmed false-negative rate and human reopen rate within a complete 24-hour window
after an explicit agent terminal decision. Missing, undersized, mix-shifted,
truncated, or guardrail-unevaluable evidence remains visibly **Collecting evidence**,
**Insufficient**, **Unavailable**, or **Not applicable**; it is never rendered as a
zero or converted into a synthetic composite. No raw evidence, case/source
identifiers, or causal claim that the model is "learning" leaves this aggregate
report.

Below that established headline, the page presents an additive **Outcome evidence**
layer. Read each result on its own terms:

- **Confirmed-positive case rate** is confirmed-positive outcome-graded cases divided
  by all outcome-graded cases. It describes the reviewed case cohort; it is not
  precision over every source alert and is unavailable until both windows contain
  enough recorded outcomes. Rising or falling is descriptive rather than inherently
  better: review source mix, feedback coverage, and the false-negative guardrail.
- **Observed closure elapsed difference** compares case-open-to-terminal elapsed time
  for agent-terminal cases with the observed human-terminal cohort. It is an elapsed
  workflow comparison, not active analyst touch time, payroll savings, or a portable
  benchmark for how long a person "should" take. If there is no eligible human cohort,
  the Console says so instead of substituting a default duration. A negative signed
  aggregate difference is labelled as slower elapsed handling; it is never turned
  into a positive time-saved value.
- **Recorded AI processing cost** totals usage-ledger cost only where the model call is
  linked to a case in the reporting window. It is AI inference cost, not staff overtime
  and not a provider-invoice reconciliation. Unlinked usage remains outside this
  outcome measurement rather than being allocated by assumption.
- **Alert-volume movement** compares durable raw-ingest counters with the durable
  after-clustering count. These volumes show whether downstream workload changed;
  they do not establish why it changed. Validate source health before interpreting a
  lower raw-ingest count as improvement.

Two trend summaries accompany the outcome layer: **week over week** is the latest
seven complete UTC days versus the immediately preceding seven, and **rolling 28** is
the latest 28 complete UTC days versus the preceding 28. Rolling 28 is not labelled
calendar month over month. Selecting a period recomputes the operational cost,
closure-time, case-mix, durable volume, and tuning blocks over those exact windows;
it does not leave them on the default 7-versus-28 comparison. Trend states remain
better, worse, no material change, insufficient, or unavailable where the metric has
a good direction; neutral measures such as positive-case mix report only up, down,
or stable.

The product deliberately does **not** divide confirmed-positive cases by raw alerts and
call the result a true-positive yield: clustering means those are different units.
That measurement is explicitly unavailable until durable alert-to-case lineage can
support a like-for-like denominator. The Agent Effectiveness response also keeps
`source_guidance` unavailable because that aggregate contract has no governed
case-specific proof. Separately, **Auto-tuning → Telemetry recommendations** reads
`GET /api/tuning/source-recommendations` and reports only versioned, stored query/tool
failures proving that a supported field was unavailable. The accepted v1 mapping is
deliberately narrow: outbound DNS (`dns.question.name`), endpoint process
(`process.command_line`), and identity-authentication method
(`user.authentication_method`). The current release reports
`capture_status=not_available` until a connector-neutral query/tool boundary can emit
those controlled field-level result codes; it does not reinterpret legacy free text as
proof. Missing connector configuration and free-form model prose are never evidence;
an empty evidence set returns `not_available`, not a guessed recommendation. The
outcome map explains which supported observation concerns decision
quality, closure speed, processing cost, or downstream volume without claiming that the
AI caused the change.

**Platform → Auto-tuning → Outcomes** shows a focused summary of the same report. It
adds the durable volume comparison and applied-change chronology, always marked
`causal_claim=false`. Auto-tuning changes downstream correlation/promotion thresholds;
it may change clustered or opened work, but it cannot reduce the number of alerts the
source emitted. It does not calculate another score or claim that a tuning change
caused an observed shift; return to **Analytics → Agent effectiveness** for complete
windows, cohort coverage, exclusions, daily evidence, definitions, and guardrails.

---

## 8. Cost (Surface)

Open **Analytics → Cost**. `GET /api/usage/summary?window_hours=24`.
Because **100% of LLM calls go through the single gateway**, every token is
metered. Top tiles: today's spend, total tokens, call count, total cost (window).
Breakdown tables: **by model**, **by role** (`router` / `investigator` /
`formatter` / `standup` / `chat` / `overview` / `embedding`), **by surface**
(`investigate` / `automated_scan` / `chat` / …). Scope to one case with
`&case_id=...`.

The **Execution tiers** band is observation, not policy inference. It always uses
four fixed buckets from the usage ledger: **Standard**, **Flex**, **Batch**, and
**Unconfirmed**, each with calls, tokens, and recorded spend. Flex + Batch make up
the displayed discounted call/token/spend coverage; every ledger row, including
Unconfirmed, remains in the denominator so old or unknown data cannot inflate the
discounted share. A Standard row proves standard execution, but the current ledger
does not prove whether it was intentionally requested or was a fallback from Flex;
the Console therefore does not invent a fallback count. Missing, legacy, and future
unknown tier values stay Unconfirmed.

### 8a. Per-log AI overview

`POST /api/overview` returns a one-click AI summary of a **single event** (no
full investigation, no case) on the configured `overview_model`, cost-ledgered like any
other call:

```json
{
  "overview": "Repeated failed SSH logins from 10.10.1.152 against web-01 for user 'alice'.",
  "why_it_matters": "A burst of failures from one source IP is a classic brute-force precursor.",
  "suggested_next_step": "Check whether any login from 10.10.1.152 succeeded shortly after.",
  "entities": ["10.10.1.152", "alice", "web-01"],
  "mitre": ["T1110"],
  "ip_reputation": { "ip": "10.10.1.152", "reputation_score": 88, "is_malicious": true, "country": "RU" },
  "cost": 0.0003
}
```

---

## 9. Knowledge base (RAG) — see and grow the corpus

The agent's retrieval corpus is no longer a black box. The **Knowledge** page
(`webui/src/soc/pages/Knowledge.tsx`, under the **Intelligence** nav group) lets
you inspect exactly what RAG holds and add to it. A **document** is a set of
chunks that share a `document_id`; the built-in seed knowledge is grouped by
source (`runbook` / `mitre` / `suppression` / `resolved_case`).

| Action | Endpoint | Notes |
|---|---|---|
| Corpus stats (docs, chunks, embedding model + dim, by-source) | `GET /api/rag/stats` | also feeds the Metrics page |
| Browse documents | `GET /api/rag/documents` | title, source, tags, chunk count |
| Inspect one document's chunks | `GET /api/rag/documents/{id}` | the chunk drill-in flyout |
| Import a document directly | `POST /api/rag/import` | Executable OpenAPI-deprecated single-document compatibility primitive; the Console submits bounded `rag_import` jobs |
| Delete a document | `DELETE /api/rag/documents/{id}?force=` | seeds need `force=true` (see below) |
| Run a live test retrieval | `GET /api/rag/search?q=&top_k=` | shows EXACTLY what RAG returns for a query |

The managed corpus follows the saved RAG source switches, not just the state that
existed at first seed. Changes to `rag.enabled`, `rag.use_runbooks`,
`runbooks.enabled`, `rag.use_mitre`, `rag.use_resolved_cases`,
`rag.use_suppression_rules`, or `rag.use_threat_context` reconcile the corresponding
managed projections while leaving operator-imported documents untouched. Live
retrieval enforces the same switches, so a disabled source cannot remain effective
because an older chunk still exists.

**Import documents.** On the Knowledge page, paste text into the import textarea or
upload bounded `.txt` / `.md` / `.json` / `.csv` files (read client-side, then sent
as text). The Console snapshots up to 20 validated documents with aggregate UTF-8
headroom below the active job registry's 8 MiB cap and submits one `rag_import` job.
After `202 Accepted`, Jobs/Inbox owns per-document progress and bounded failures; the
terminal record compacts the imported text. Give each document a title (and optional
tags); the backend chunks it
(`engine/chunking.chunk_text` — dependency-free paragraph-pack with overlap),
embeds each chunk through the single gateway, and indexes it into the same vector
store the investigator retrieves from. Imported docs are immediately retrievable.
The embedding role is capability-validated and defaults to the dedicated
`text-embedding-3-small` assignment. Empty, all-zero, mixed-dimension, and
cardinality-mismatched vectors fail before a partial write. Changing embedding space
clears and reseeds the managed corpus rather than mixing dimensions. If the explicit
local hash fallback is used, stats/chunk provenance records its actual provider/model
and `embedding_fallback=true`; fallback vectors are not represented as provider
embeddings.

**Browse + inspect chunks.** The documents table lists every document with its
source, tags, and chunk count; open one to see its individual chunks in a flyout (so
you can see precisely what text will be retrieved and fed to the model — fenced as
UNTRUSTED at prompt time — see below).

**Run a test retrieval.** Use "Try a retrieval" (`GET /api/rag/search`) to type a
query and see the ranked snippets RAG would surface for it — the fastest way to
confirm an imported runbook or IOC list is actually being recalled.

**Delete (and the guarded-seed force flag).** Deleting your own imported document is
a one-click `DELETE /api/rag/documents/{id}`. The **built-in seed sources**
(`runbook`, `mitre`, `suppression`, `resolved_case`) are **guarded**: a plain delete
is refused; you must pass **`?force=true`** to remove seed knowledge (the UI prompts
for the force confirmation). This prevents accidentally wiping the baseline corpus.

> **Trust boundary.** Only `runbook` / `mitre` / `suppression` are the RAG
> **TRUSTED** allowlist. Everything else RAG retrieves — including your own
> **imported documents** and `resolved_case` text — is rendered **UNTRUSTED-fenced**
> at prompt time, exactly like log evidence (`SECURITY.md`). Importing a document
> does not make it instructions; it only makes it *retrievable* context.

---

## 10. Agent memory — durable operator facts

The suite carries a small, durable **memory** of human-governed operator facts so an
approved standing fact can inform later investigations and chat without being repeated.
Each `MemoryEntry` has `text`, optional `category`/`tags`, a `source` (`human` or
`agent`), an `author`, an `active` flag, and a `review_status` of `approved` or
`pending`. Memory uses the existing strict-CAS KV layer in the selected
`STATE_BACKEND`; a successful mutation is durable and concurrent updates cannot
silently overwrite one another.

**How it is used (and its limits).** Only entries that are both **active and approved**
enter the distinct TRUSTED `<<<MEMORY>>>` block in investigations and chat, with the
precedence `policy > base-prompt > playbook > MEMORY > untrusted`. Pending
agent-authored suggestions are review candidates and remain UNTRUSTED-fenced; they do
not become standing instructions merely because a model proposed them. Legacy
`source=agent` entries without review metadata migrate to pending on read, while legacy
human entries remain approved. Memory can inform the LLM but can never override the
deterministic Case Manager (non-negotiable #3). Forged `<<<MEMORY>>>` markers in event
data are neutralised by `fence()`.

**Add / review / edit / remove on the Memory page**
(`webui/src/soc/pages/Memory.tsx`, under **Intelligence**) requires `memory:manage` for
mutations. A direct authorized `POST /api/memory` creates approved human memory. An
authorized `PUT /api/memory/{id}` can edit/toggle it or approve a pending entry and
records the approver/time; `DELETE` removes it. Readers can distinguish source and
review state. The Approvals queue can also materialize an approved memory proposal.

**…or in Chat.** Chat never bypasses RBAC. An authorized **"remember: <fact>"** stores
an audited `source=agent`, **pending** entry; an unauthorized request becomes a
non-persisted suggestion, and an unauthorized forget request is a no-op. A human with
`memory:manage` must approve the pending entry before it can enter trusted context.

| Action | Endpoint |
|---|---|
| List memory facts | `GET /api/memory` |
| Add an approved human fact (`memory:manage`) | `POST /api/memory` (`{ text, category?, tags? }`) |
| Edit, toggle active, or approve pending (`memory:manage`) | `PUT /api/memory/{id}` |
| Delete a fact | `DELETE /api/memory/{id}` |

**Active vs review state.** `active` controls whether an approved fact is currently in
use; `review_status` controls whether it is trusted at all. An inactive approved fact
is retained but not injected. A pending fact is not trusted regardless of `active`.

---

## 11. Case explainability — the Investigation tab

Every case can explain itself, right where you're already looking: `CaseDetail`'s
**Investigation** tab (one of the six tabs, §3) — there is **no** separate "Why" or
"Agent trace" tab. It combines three things:

- **A pinned `DecisionCard`.** The **code-made** close/escalate rationale from the
  Case Manager, shown prominently and separately from the model's opinion — the
  verdict/confidence are the LLM's recommendation; the *decision* is deterministic
  (non-negotiable #3).
- **A "why" / rationale panel**, backed by `GET /api/cases/{id}/rationale`. The
  investigator records a **CONTEXT audit entry** (`ActionType.CONTEXT`) capturing
  everything it was handed; the rationale object — assembled defensively from the
  case + audit trail — surfaces: the investigator's **reasoning** excerpt; **RAG
  knowledge retrieved** and separately labelled **runbook references retrieved**
  (each with source, bounded snippet, document id, revision/content hash, score, and
  the retrieval query groups that produced it); approved operator **memory consulted** (§10);
  the exact **tool calls / ES queries** run; **enrichment** pulled; and the routed
  **persona** and **playbook** with explicit selected-versus-consulted state,
  selection reason and consultation path (+ version/why), **MITRE**
  techniques, and evidence list. When the case traversed a threshold previously
  changed by Agentic SOC, it also shows the immutable platform tuning snapshot
  (scope, before/after values, rationale, and applied time). This is deterministic
  correlation/severity-threshold tuning, **not model fine-tuning**.
- **A collapsible `TraceTimeline`** — the step-by-step agent trace
  (`GET /api/cases/{id}/trace`), projecting the append-only audit index into an
  ordered timeline (router → investigator → tool calls → verdict → formatter →
  case-manager decision). Raw prompt excerpts are included only when
  `trace.include_prompts` is true (default on).

The rationale projection is scoped to the **latest investigation run**. An earlier
run's memory, retrievals, playbook, tools, or tuning snapshot cannot leak into a later
re-investigation. Overview defaults to inputs actually consulted/applied; Investigation
may additionally disclose a persona or playbook that the router selected but a cheap
route or kill switch prevented from being consulted. It never promotes selected-only
procedure metadata into consulted provenance. These inputs may inform preprocessing or the model assessment; deterministic
case policy remains the final close/escalate route authority.

The separate **Timeline** tab is deliberately narrower: it is ONLY the "what
happened" narrative — a 6-stage story (input → correlate → **Risk Assigned** → triage →
investigate → **Decision**), backed by `GET /api/cases/{id}/stages`. Expanding Risk
Assigned reconstructs the arithmetic from persisted factor values and current
configured weights; it preserves the recorded score and warns when historical
weights cannot be attributed exactly. In Case Manager, the terminal marker alone
pulses. If the Investigate sentence already repeats the verdict/confidence chips,
that duplicate sentence is suppressed. Use Investigation
to audit *how* a verdict was reached and confirm the close/escalate was a
deterministic policy outcome; use Timeline to see the sequence of events at a
glance.

### What the agent actually sees per event (case evidence fields)

Every sample event reaches the model as a **bounded projection** of the raw record,
never the whole record — a set of identity fields (id, timestamp, ip, user, host,
rule, severity) plus the paths configured as **case evidence fields**. The default
set is the ECS group that most often decides a verdict:

```
event.action  event.outcome  url.path  url.original  http.request.method
http.response.status_code  user_agent.original  process.name
process.command_line  file.path  destination.ip
```

Fields the record does not carry are simply not rendered, so a source with no HTTP
context sees no empty-key noise.

**One list drives three things**, deliberately: what the investigator and router are
shown per event, what the `es_query` tool returns per row, and which fields a
free-text `contains` search is matched against. A field the agent can see is
therefore a field it can then search for, with three deliberate exceptions:

- `http.response.status_code` is a `long` and `destination.ip` is an `ip`, so they
  are shown but not free-text searched — a substring match against either is
  meaningless, and asking a real cluster for one fails the whole query.
- Free-text search fans out over at most 24 fields (a `multi_match` runs once per
  field, so this is a real cost on a large index), while the projection carries up
  to 64. Past roughly the 20th configured path, a field is shown but not searched.
- A cluster spanning sources *unions* their evidence lists for display, while a
  search runs against one source and uses that source's list alone.

This is the fix for a real failure mode —
a field present on the alert but absent from all three lists is invisible *and*
unsearchable, and a zero-hit query for it reads back as evidence the data does not
exist. `es_query` now also reports which fields its free text was matched against,
so "0 hits" cannot be mistaken for "not in the record".

**`contains` is a term match, not a substring scan** — it always was, and the result
now says so. The free text is analysed and matched per field, so it finds a word in
an analysed field (`message`, `event.original`) but matches an exact-value field
(most ECS `keyword` paths, including `url.path`) only against its whole value.
Searching `contains: "editpdf"` will not find `/mod/assign/feedback/editpdf/ajax.php`.
That is precisely why the field belongs in the *projection*: the agent reads the
record's own value directly rather than having to guess a query that would match it.
The result summary states the semantics, so a zero is never read as an absence, and
an `ids` lookup — which returns the requested documents verbatim and never applies
`contains` — now says that outright instead of presenting an unfiltered result as a
filtered one.

Set the deployment-wide list in **Settings → General → Case evidence fields**. A
single source can override it through its own `evidence_fields` config key —
`POST /api/sources` (there is no per-source control in the Console for this yet) —
and sources correlated into one cluster *union* their lists, so a narrow setting on
one cannot blind another. Two special values:
`[]` restores the identity-only projection, and `["*"]` sends the whole record
bounded only by the per-event character budget beside it. Whenever that budget
binds, the model is told which fields were withheld rather than being handed a
silently shortened record; in whole-record mode it additionally offers rule
*definition* metadata (`kibana.alert.rule.parameters`, `.note`, `.description` and
siblings — identical on every alert the rule ever fires) last, so those are what get
dropped rather than the URL that decides the case. In the default allowlist mode
that ordering never arises: the list holds only what an operator asked for.

The default is an allowlist rather than whole-record because a realistic alert
serialises to roughly 10 KB, and twelve of those would be ~128 KB — several times the
per-case token budget (`caps.max_tokens`), which would route every case to
`needs_human` on cost alone. `["*"]` is there for deployments that want it and have
raised the budget to match.

Whole-record mode widens what the model is *shown*; it does not widen what
Elasticsearch *matches on*, because an unbounded `multi_match` across every field of
a large alert index is a real query cost on the shared read-only credential.

The budget is *per event*, and the investigator reads up to 12 sample events, so a
raised budget multiplies. Setting it near its 16,000 ceiling can exhaust the
per-case token budget (`caps.max_tokens`) before the investigation finishes; that
fails safe to `needs_human` rather than closing anything (#3), but it is a real cost.
The default of 1,200 leaves comfortable headroom.

Not sure whether your alerts carry these fields? **Sources → your source → Advanced
— field mapping** → paste one record → *Suggest mappings*: the response's
`suggested_evidence_fields` lists exactly which default evidence paths that record
has. See `docs/TROUBLESHOOTING.md` §M2 for the symptom this diagnoses.

Everything in this projection is log-derived and stays **UNTRUSTED-fenced** (#9),
including — in whole-record mode — the record's own field *names*.

---

## 12. Run a playbook on a case + threat context

**Run a playbook** (`POST /api/cases/{id}/run-playbook` with
`{ "playbook_id": "...", "analyst": "..." }`). A run is a **context-only**
re-investigation: the chosen playbook is **forced** into the investigator's
TRUSTED `<<<PLAYBOOK>>>` block and the case is re-investigated through the shared
pipeline. The playbook can only RECOMMEND — it can never change the deterministic
close/escalate outcome (non-negotiable #3). An unknown `playbook_id` returns `404`.
List the catalog first with `GET /api/playbooks`. In the UI, open a case's
**Investigation** tab and use **Run playbook** (pick from the catalog); the
resulting re-investigation renders in place.

Manage procedures under **Intelligence → Response playbooks**. Any user with
`playbooks:read` can browse and open the plain Markdown source. Bundled procedures
are visibly protected; `playbooks:manage` adds **New playbook** and **Edit** for
operator-owned records. Bundled procedures are immutable package data; operator
procedures are strict-CAS StateStore records, so they survive image replacement on
Elasticsearch, PostgreSQL, or SQLite without a new table/index. A successful create or
update means the durable write was confirmed and the active catalog was atomically
refreshed. Creates/updates are slug constrained, individually bounded to 256 KiB,
limited to 100 operator procedures and 2 MiB aggregate content, hot-reloaded, and
append-only audited. Send the current `expected_revision` on update; a stale save is
rejected with `409`, after which the client must reload. There is no runtime delete
endpoint in v0.1. The rendered trusted procedure context is independently bounded to
2,400 characters. Editing guidance never changes deterministic case-decision authority.

`POST /api/playbooks/dry-run` accepts up to 100 `rule_ids`, one `entity_type`, and an
`event_count` from 0 through 1,000,000, then explains the exact deterministic match or
no-match reason. It never invokes an LLM, investigation, or `decide()`. `GET
/api/playbooks/coverage` scans up to 20,000 stored cases and reports covered/uncovered
counts, selected procedure counts, truncation, and the top 100 unmatched rule families.
Selection is exact/deterministic—there is no fuzzy or model-selected fallback. `GET
/api/playbooks/selection/{case_id}` exposes the persisted selection explanation for a
case.

**Threat context** (`GET /api/cases/{id}/threat-context`) assembles a defensive,
**fail-open** panel for the case (each section degrades independently if its source
is missing), shown as the **Threat** tab (§3):

- **IOC reputation** — enrichment-provider lookups (§19) for the case's indicators
  (an indicator is flagged malicious above `threat_context.ioc_malicious_threshold`,
  default 50).
- **MITRE ATT&CK** — technique metadata (name, tactics, platforms, sub-techniques)
  resolved from a **bundled corpus of 697 enterprise techniques**
  (`backend/app/threat/mitre_techniques.json`); no network call.
- **Related cases** — cases sharing the entity (the cross-source linkage from §13)
  or belonging to the same campaign (§16).

All untrusted log / intel text renders as plain text / code blocks (#9). You can
grow the intel corpus with `POST /api/threat-context/import` (admin) — `{ title,
content, tags? }` — which chunks the doc into RAG as `source="threat_context"` and
injects retrieved text as fenced UNTRUSTED context at investigation time.

**Resolved-case knowledge loop.** A terminal case is eligible for the reusable RAG
corpus only when its outcome was independently analyst-confirmed. Model-only verdicts,
inferred terminal dispositions, and auto-closed outcomes are excluded, preventing the
agent from training its retrieval context on its own prior inference. Eligible cases
are best-effort chunked as `source="resolved_case"`; indexing never blocks the action
and remains gated by `rag.enabled` + `threat_context.reuse_resolved_cases` /
`rag.use_resolved_cases`. Resolved-case text is still UNTRUSTED-fenced when retrieved
(§9); analyst confirmation makes it eligible evidence, not trusted instructions.

---

## 13. Multi-source correlation — Auto-Correlate + cross-source related cases

By default each configured source is correlated on its own. Two controls change
that, both in the **`SourceEditor`** (§2, and on the `SourceInstance` config):

- **Auto-Correlate (per source).** A switch on each source. When **on** (default),
  that source's correlated clusters auto-forward into triage. When **off**, its
  clusters are still formed but routed to **candidates** (Cases, manual triage) —
  use this to keep a noisy source from auto-investigating. Stored as the source's
  `config.auto_correlate`.
- **Auto-Correlate (per feed).** Each pull source can carry multiple **feeds**
  (index patterns) with an `alerts` / `events` / `ignore` **role**; each feed has
  its **own** Auto-Correlate toggle (`correlate`). This lets you, say,
  auto-investigate the `alerts` feed while leaving a high-volume `events` feed
  on manual — see §30 for the full per-feed model.

**Cross-source correlation (default ON since Round 10, §33).** `cross_source_correlation`
(**Settings → General → Detection**) runs a **second** pass that links clusters
from *different* sources that share an entity
(`ip` / `host` / `user` / `file_hash` / `domain`) within a time window. Tunables:
`time_window_seconds` (default 300), `min_sources_to_cluster` (default 2), and the
`entity_keys`. The result is surfaced as **RELATED cases** — the cases are linked
(`related_case_ids`, `cross_source_cluster_id`, a source breakdown) but **never
force-merged**, so the per-source 1:1 cluster→case signature and audit trail stay
intact. The Overview tab shows a "Sources" pill and a "Related cases" facet; the
Cases list can filter to related-only.

**Per-source field-mapping overrides + connector help.** Beyond the wizard's field
mapping, a source's config can carry `field_mappings_extra` overrides applied at
ingest. Each connector field can also ship contextual setup help (`help_link` /
`help_code`), rendered as a (?) `HelpTip` in the `SourceEditor` so you can see, e.g.,
the exact read-only API-key grant for that connector inline.

---

## 14. Detection & Rules — the rule-authoring home

**Settings → General → Detection & rules** (nav-anchored, deep-linkable at
`#/settings?s=detection_rules`) is the single home for authoring every rule class
the engine reads, replacing the old scattered per-rule editors:

- **Detection-match / threshold rules** (`RuleDefinition`, the `rule_catalog`) —
  `PUT /rules/detection/{rule_name}`, `POST /rules/detection/{rule_name}/enabled`,
  `DELETE /rules/detection/{rule_name}`.
- **Correlation / threshold clustering rules** (`CorrelationRule`, the
  `correlation_rules` map, §25) — `PUT /rules/correlation/{rule_key}`,
  `DELETE /rules/correlation/{rule_key}`.
- **Case-automation rules** (`CaseAutomationRule`, `threshold_automation.rules`) —
  the **#3-safe post-decision rules**: each has `conditions` (on verdict / risk /
  severity / entity type / rule / source) and an `action`, evaluated in priority
  order **after** the Case Manager decides — `tag` (add a tag), `recommend`
  (attach a recommendation), `notify` (fire a notification, §23), `run_playbook`
  (queue a context-only re-investigation, §12), or `request_approval` (raise a
  HITL `Proposal` — the permission-gated approve/reject queue). A complete
  suppression payload remains a suppression proposal and an explicit Memory payload
  remains governed Memory. A generic, partial, or unknown approval request is an
  `automation_ack`: approving it records operator acknowledgement only and does not
  change configuration, create Memory, add suppression, or move a case. `PUT
  /rules/case-automation/{rule_id}`, `POST /rules/case-automation/{rule_id}/
  enabled`, `DELETE /rules/case-automation/{rule_id}`.

**The hard guarantee:** every rule editor here is a **config writer**. Nothing
imports or calls `case_manager.decide()`, sets a case status/disposition/verdict,
or recomputes a `cluster_signature`. A case-automation rule **never sets
`case.status` directly** — a SAFE action (tag/recommend/notify) is applied and
audited; `request_approval` routes through the HITL `Proposal` path; a
`run_playbook` re-investigation calls `decide()` again with new inputs.
`decide()` remains the only producer of a CLOSED / auto-closed case, and
`NEEDS_HUMAN` never auto-closes (non-negotiable #3, CI-asserted). An impossible
condition — a disposition value (`suspicious`/`benign`) stored where only a real
`Verdict` is legal — is rejected on write.

**What the detection editor can author today.** A detection-match rule has exactly
one persisted predicate (`field` + operator + value) and one executable correlation
threshold (`group_by`, count, and window). Polling cadence belongs to the source feed.
The API may contain additive `mitre`, `schedule`, or `suppression` metadata written by
older or external clients; the Console preserves that metadata during unrelated edits
but does not present it as an active rule control. Per-rule schedule and suppression
metadata are not executed by the current runtime. Multi-predicate authoring and per-rule
schedule authoring remain unavailable until their persistence and execution contracts
exist end to end.

**Analyst rule policies are a SEPARATE, executable surface.** They are deliberately not
the `RuleSuppression` metadata above (which stays storage-only) and not
`Preferences.suppression_rules` (which drops events before a case exists).
`Preferences.analyst_rule_policies` records an operator's explicit, audited, revocable
declaration that a detection is benign in this environment; a cluster whose rules are ALL
declared is closed with `disposition=false_positive` and
`decision_by=analyst_policy`, with no LLM call. It exists because precedent volume cannot
resolve an evidence-sufficiency judgement: for a rule whose alerts carry no request /
payload / execution context, an investigation can never verify a given instance is
benign, so it routes to a human however many prior cases an analyst confirms. `decide()`
is untouched — the declaration is evaluated before a verdict exists — and the close is
excluded from every agent-performance statistic and from
`analyst_confirmed_outcome`, so it can neither flatter the agent nor become training
evidence. CRUD lives at `/api/rules/analyst-policies*` under `rules:read` /
`rules:manage`.

**Test/Preview — never bills the LLM, never decides.** `POST
/api/rules/preview` runs a rule's single predicate against recent events
(through the scoped read-only key, hard-capped, the exact `GET /api/logs`
scatter-gather path) and returns match counts / a histogram — **zero** gateway
calls, **zero** `UsageDoc` writes, and it never calls `decide()` or creates a
case (non-negotiables #3 and #6 both hold here). The separate
`POST /api/triage/preview-decision` endpoint is the deterministic case-policy
what-if preview; it also remains pure and no-cost.

**Version ledger + rollback.** Every create / update / enable / disable / delete /
rollback writes an append-only audit row *and* an immutable version snapshot
(`stores/rule_versions.py`). `GET /rules/{kind}/{rule_id}/versions` lists the
ledger; `POST /rules/{kind}/{rule_id}/rollback/{version_id}` restores an earlier
version (itself versioned, so a rollback is never a dead end).

Everything here is gated by the unified `rules` grant (`rules:read` /
`rules:manage`) — including custom roles (§25) granted just that resource.

Settings still keeps a lightweight **Automation** section (**Settings → General
→ Automation**) as the master enable switch + a pointer here — there is no
per-rule editor left inside it.

---

## 15. Adaptive threshold auto-tuning

**Auto-tuning** (top-level **Platform** nav item, backed by
`engine/threshold_tuner.py`) is a nightly deterministic observer—default **ON**
since Round 10 (§33; `shadow_eval` is **forced on**, even for a migrated tenant).
Its learning denominator is deliberately narrower than the cases it observes: only
the latest valid independent analyst outcome/adjudication can count as FP or confirmed
TP evidence. Model verdicts, inferred terminal dispositions, and auto-closed outcomes
are recorded as **unconfirmed** and cannot authorize a tuning write. It applies the
minimum-sample gate, Wilson lower bound, EWMA, and shadow replay to propose a bounded
`+1` nudge to correlation `n` or a feed's `severity_floor`. A cold tenant under
`min_samples` (default 30 analyst-confirmed outcomes) remains Collecting.

| Action | Endpoint |
|---|---|
| Recommendations (observed, analyst-confirmed/unconfirmed split, proposal, ledger) | `GET /api/tuning/recommendations` (`automation:read`) |
| Read / update policy, including `auto_apply_confirmed` | `GET`/`PUT /api/tuning/config` (`automation:read/manage`) |
| Recompute and process every current proposal for one rule | `POST /api/tuning/{rule_id}/apply` (`automation:manage`) |
| Roll back the latest applied change | `POST /api/tuning/{rule_id}/rollback` (`automation:manage`) |
| Query-backed telemetry gaps | `GET /api/tuning/source-recommendations` (`cases:read`) |
| Worker attempt/success/error health | `GET /api/schedulers/health` (`automation:read`) |

The page separates work into **Operations**, **Outcomes**, and **Policy & history**.
Operations is the default rule/recommendation workflow. Outcomes reads the
reporting-only `GET /api/metrics/agent-improvement` aggregate for operators with
`metrics:view`; a missing metrics grant does not block the separately authorised
tuning controls. Policy & history holds the append-only ledger and tuner policy.

Operations separates rules into **Collecting**, **Within target**, and **Needs
attention**. Collecting means the rule has fewer than `min_samples` independently
confirmed labels; Within target and Needs attention are assigned only after that
threshold, using the Wilson lower-bound rate against policy. The API distinguishes all
`observed` cases from `analyst_samples`, `unconfirmed`, `fp`, and `tp`. The UI names
both measurements: the **observed FP ratio** is `fp / analyst-confirmed outcomes`, while
the **conservative FP estimate** is the Wilson lower bound that gates policy. A gap
from target is shown in **percentage points**, not as percentage change.

Operations presents one attention-ordered **Rule review** workspace rather than
separate recommendation and monitored-rule queues. Recommendation-only rows remain
visible in that same list. Apply is rule-scoped, not recommendation-kind-scoped, so
one request recomputes every current proposal for that rule. With the safe default
`auto_apply_confirmed=false`, eligible bounded changes
enter the HITL **Approvals** queue; suppression always enters it. Explicit auto-apply
requires an authorized configuration opt-in plus sufficient analyst evidence and a
clean shadow replay. Each queued row and the selected-rule inspector answer, in order:
**why it needs attention**, **recommended action**, **expected operational effect**,
and **safety replay**. **Can apply after safety check** means the evidence and safeguards
will be recomputed before any write; it is not a guarantee that the change will apply.
The rule list supports search and state filtering; selecting a rule opens an
in-context inspector at 1536px+ or a focus-managed Sheet below that width. Policy &
history presents the editable tuner policy first and the append-only ledger after it;
rollback is offered only for the newest active reversible change for a rule. Historical
auto-applied tuner rows remain visible for review/rollback rather than being silently
reversed during migration to the review-first default.

Approvals is independently RBAC-gated: `GET /api/proposals` requires
`proposals:read`; approve/reject requires `proposals:approve`. Built-in Analyst Tier 1,
Analyst Tier 2, Responder, and Auditor roles can read; Responder and management roles
with the approve grant can decide. Tuning approval recomputes/materializes the bounded
change rather than trusting stale proposal text; a stale threshold returns `409` and
must be reviewed again. Reject leaves preferences unchanged and history remains
auditable. Approval first acquires a strict `pending -> applying` compare-and-set
claim, materialises at most once using the proposal id, then strictly finalises the
status. Concurrent decisions return `409`; a storage failure is shown and remains
retryable rather than being reported as success. An approved Memory proposal is not
reported successful until its trusted fact is durably confirmed. Approve and reject
also write strict append-only control-audit evidence before final status; a stable
per-proposal event id makes that evidence retry-idempotent, and no successful response
is returned when the audit ledger cannot confirm the row.

In Outcomes, agreement and correction remain one analyst-grade quality domain; human
review turnaround is the independent second domain, and evaluable safety guardrails
qualify any favorable headline. A selector shows one daily trajectory at a time so
the evidence remains readable without mixing units. Missing evidence stays collecting,
insufficient, unavailable, or not applicable—never zero—and the page never produces a
composite improvement score. Use **Analytics → Agent effectiveness** for the full
evidence detail. This summary performs no model call or write and does not prove that
tuning caused an outcome shift.

The same workspace can show durable **ingested** and **after clustering** counts plus
applied tuning events inside the comparison horizon. Those rows are observational and
carry `causal_claim=false`: a tune can change correlation or downstream promotion, not
raw source emission. A lower clustered/opened workload after a change is therefore
useful review context, not a causal result. True-positive/raw-alert yield remains
unavailable. Telemetry-source advice is a separate evidence-only surface (§7): its
schema accepts three controlled v1 mappings and returns nothing until a future
controlled query/tool producer records a qualifying gap. The current release says
capture is unavailable; it never infers advice from connector absence.

The tuner **never imports `case_manager`/`decide()`, risk weights, or
signatures**—it only moves detection-*volume* knobs the pipeline already reads live.
A proposed **suppression DROP is never auto-applied**. Every
apply/rollback/config change is shadow-evaluated first and writes an append-only
`ActionType.TUNING` audit row, so a bad tune is always visible and always
reversible.

---

## 16. Campaigns — cross-case shared-entity correlation

**Campaigns** (a top-level **Triage** nav item, backed by `engine/campaigns.py`,
default **ON** since Round 10, §33) runs a deterministic pass over shared entities
across already-created cases and groups related ones into a `Campaign` object—the
same idea as §13's cross-source linkage, but over the case store rather than a live
correlation window. The worker enforces the configured hourly/daily/weekly cadence;
`manual` never runs in the background. Each completed pass performs full-set active
reconciliation, removes campaigns that disappeared from the latest snapshot, and
records a durable `last_reconciled_at` success anchor.

| Action | Endpoint |
|---|---|
| List running campaigns (newest first, with member case ids / entities / MITRE / severity rollup) | `GET /api/campaigns` |
| One campaign | `GET /api/campaigns/{id}` |
| The campaign a case belongs to (or `null`) | `GET /api/cases/{id}/campaign` |
| Trigger the pass on demand | `POST /api/campaigns/recorrelate` (admin) |
| Read / update campaign config | `GET`/`PUT /api/campaigns/config` |

A campaign only **references** `case_ids`; it never recomputes or mutates a
case's `cluster_signature`, and it can never close or escalate a member case — a
`NEEDS_HUMAN` case that joins a campaign stays `NEEDS_HUMAN` (non-negotiable #3,
#4). The CaseDetail Overview tab shows a campaign chip when a case belongs to one.
Campaign operation is still single-replica/process-local: there is no distributed
lease or immutable split/merge lifecycle history, and the pass remains bounded. Use
`GET /api/schedulers/health` to distinguish disabled, manual/gated, running, failed,
and last-success states for the threshold tuner, campaign correlation, event-driven
baseline producer, and Batch worker. The baseline row uses `cadence=on_ingest`; its
running state means baseline learning is enabled and ready outside Demo, independent of
the cadence-loop `scheduler_runtime_running` flag.

---

## 17. Entity baseline — anomaly detection over time

**Baseline** (under **Analytics**, backed by `engine/baseline.py` +
`stores/baseline.py`, default **ON as a pure producer** since Round 10, §33) keeps
an online EWMA/EWMV sketch per cluster-signature across **168 hour-of-week
buckets**, plus a bounded t-digest for **p50/p95/p99**, with a robust modified-z
(`|M| > 3.5`) anomaly test and a 3×-period warm-up (`H=14d`, `warmup_days=14`
advisory) before it trusts its own numbers. Learning starts from day one
(including a silent-source/volume-flood detector); **baseline-driven
auto-investigation stays a separate, opt-in knob** (§33) — the producer itself
never triggers one.

| Action | Endpoint |
|---|---|
| Warm-up + coverage overview across every signature | `GET /api/baseline/stats` |
| One signature's per-bucket warm-up + p50/p95/p99 | `GET /api/baseline/{signature}` |
| Read / update baseline config | `GET`/`PUT /api/baseline/config` |

Baseline is a **pure advisory producer** — it is keyed by `cluster_signature` but
never recomputes or mutates one, never reads risk weights, and never calls
`decide()`; it can never close or escalate a case on its own (non-negotiable #3,
#4). The webui shows a "warm-up gauge" on `CaseDetail` for a case whose signature
has an active baseline.

---

## 18. Case collaboration — threads, tasks, and @mentions

Every case has a per-case **thread** (`Collab` tab, §3) for human+AI ticket
collaboration, plus a lightweight **task checklist**:

| Action | Endpoint |
|---|---|
| List the thread (chronological; legacy `Case.comments` migrate in as root messages) | `GET /api/cases/{id}/thread` |
| Post a message (`human`/`ai`/`system` author, optional one-level reply `parent_id`) | `POST /api/cases/{id}/thread` |
| Edit a message | `PATCH /api/cases/{id}/thread/{msg_id}` |
| Soft-delete (tombstone) a message | `DELETE /api/cases/{id}/thread/{msg_id}` |
| Toggle a `{emoji, user}` reaction | `POST /api/cases/{id}/thread/{msg_id}/reactions` |
| List the case's activity feed | `GET /api/cases/{id}/activity` |
| List the task checklist | `GET /api/cases/{id}/tasks` |
| Add a task | `POST /api/cases/{id}/tasks` |
| Patch a task (title/assignee/status/order) | `PATCH /api/cases/{id}/tasks/{tid}` |
| Log a note on a task | `POST /api/cases/{id}/tasks/{tid}/log` |

**@mentions** in a thread message body (plus an explicit `mentions` list) are
resolved against the user store and fanned out into each mentioned user's
in-app **Inbox** (§23). Deleting a message is always a **soft delete** (a
tombstone, never a hard delete, non-negotiable #2) so threaded replies keep their
parent and the audit/UI can render a "deleted" placeholder.

**#3 guarantee, twice over.** Posting/editing/deleting a thread message, adding a
reaction, or creating/patching a task **never** reads, sets, or influences the
case's `status` / `verdict` / `disposition` — a task's own `status` (open /
in_progress / done / blocked) is work tracking, not a case status. All bodies,
titles, and log notes are plain data (#9); every write is audited and, best-
effort, published to the per-case realtime event stream so an open `CaseDetail`
updates live.

---

## 19. Enrichment providers (38 registered)

**Settings → Integrations → Enrichment** (`GET /api/enrichment/providers`) lists
every registered indicator-reputation provider's manifest plus its current
config/key state (booleans only — secret values are never returned) — **38
registered classes**. Round 3's 19: **AbuseIPDB, VirusTotal, GreyNoise, Shodan,
Shodan InternetDB, Censys, BinaryEdge, IPinfo, OTX, Pulsedive, Spur, XForce,
URLScan, HIBP, ProjectHoneypot, RDAP, URLhaus, ThreatFox,** and **MalwareBazaar**
(the abuse.ch trio shares one file). Round 11 adds 19 more — keyless **CIRCL
hashlookup, DShield, Onionoo, Spamhaus, Cymru MHR, Robtex,** and **crt.sh**, plus
keyed **CrowdSec, Google Safe Browsing, IPQualityScore, ipdata, APIVoid,
Maltiverse, SecurityTrails, Criminal IP, Netlas, Hybrid Analysis, MetaDefender,**
and **EmailRep**. The quota-safe **keyless** providers default ON (Shodan
InternetDB, IPinfo, the abuse.ch trio, RDAP, CIRCL hashlookup, DShield, Onionoo);
Spamhaus + Cymru MHR (DNS lookups needing the host's own resolver) and Robtex +
crt.sh (slow free tiers) are keyless but default OFF; every keyed provider needs
its key set in the secret tier. Each provider card renders the manifest's
per-provider **"How to set up"** steps (naming the exact env var to set) and an
**example** blurb of how that source helps triage.

| Action | Endpoint |
|---|---|
| List every provider's manifest + configured state | `GET /api/enrichment/providers` |
| Look up one observable (type-routed IP/domain/hash/url/email) | `GET /api/enrichment/lookup?indicator=` |
| Set a provider's secret | `POST /api/enrichment/providers/{name}/secrets` |

Every lookup is **Redis-cached** (non-negotiable #8) and **fail-open** — a
provider outage degrades that one signal, never the investigation. Multiple
providers on the same indicator are fused (default: `max()` across normalised
scores; an opt-in weighted-fusion mode is available via
`enrichment.fusion_enabled`). Results feed both the automated investigation (as
enrichment evidence) and the case-detail **Threat** tab (§12).

---

## 20. MITRE coverage + ATT&CK Navigator export

`GET /api/mitre/coverage` tallies **per-tactic** MITRE ATT&CK technique coverage
from your case load against the bundled **697-technique** corpus
(`backend/app/threat/mitre_techniques.json`) — up to the most-recent 5000 cases
(a `truncated` flag marks the tally as a lower bound when the store holds more).
`window_hours=0` (the default) covers every fetched case; a positive value
time-bounds it to cases created within that window. Forged/invalid technique ids
on a case are dropped, never surfaced (#9).

`GET /api/mitre/coverage/navigator.layer.json` returns the same coverage as an
**ATT&CK Navigator v4.5** layer — a pure JSON document you can hand straight to
the [MITRE ATT&CK Navigator](https://mitre-attack.github.io/attack-navigator/) (or
save/import it there) to visualize your organization's technique coverage as a
heatmap. The webui's Metrics page renders the same coverage inline via a
`MitreHeatmap` component and offers the layer file as a one-click download.

---

## 21. Custom dashboards

**Dashboards** (under **Overview**, alongside the built-in Dashboard) lets each
user build their own widget grid over the existing tile/chart registry — a
per-user, drag/resize `react-grid-layout` grid (lazy-loaded, edit-mode only).

| Action | Endpoint |
|---|---|
| List my saved dashboards | `GET /api/dashboards` |
| The server's widget-type allowlist | `GET /api/dashboards/widget-types` |
| Create (or replace by id) a dashboard | `POST /api/dashboards` |
| Replace one dashboard | `PUT /api/dashboards/{id}` |
| Delete a dashboard | `DELETE /api/dashboards/{id}` |
| Clone an existing (or org/role-default) dashboard into my own set | `POST /api/dashboards/{dashboard_id}/clone` |

Widgets are drawn from a fixed, versioned allowlist (KPI tiles, verdict/autonomy
mix charts, a connector-health table, a recent-cases table, the MITRE heatmap, and
the active-risk gauge) — an unknown widget `type` is rejected with a `400`, never
silently stored. Everything is scoped to the **authenticated** caller (the shared
`default` bucket when auth is off), so one user can never read or mutate another's
board. Per-role **curated default layouts** ship pre-packed (12-column grid, no
default board stacks at `(0,0)`); editing a default clones it into your own
personal set on first change.

A dashboard is **advisory presentation state only** — nothing here imports or
calls `case_manager.decide()` (non-negotiable #3), and building/reading one never
bills the LLM.

---

## 22. Models, batch jobs, and the budget gate

**Settings → General → Models** (`GET /api/llm/models`, `GET /api/llm/providers`)
is the per-role model picker (router / investigator / formatter / standup / chat /
overview / embedding), populated from the bundled model registry across **seven**
LLM providers: `anthropic`, `openai`, `azure`, `bedrock`, `vertex`,
`openai_compatible`, and `mock` (offline tests only). Each role picker also
carries temperature and max-tokens; the gateway handles per-model quirks
automatically (e.g. `gpt-5`/`o`-series omit `temperature`, use
`max_completion_tokens`). `POST /api/llm/models/test` verifies a model+key work
before you save it. Per-model price overrides live in a price overlay
(`PUT`/`DELETE /api/llm/models/{model_id}/pricing`) for when you need to correct a
list price.

Fresh workspaces assign official OpenAI `gpt-5.6-luna` to router, investigator,
formatter, standup, chat, and overview. The embedding role remains
`text-embedding-3-small`. Existing stored assignments are preserved, and all other
providers/models remain selectable. Luna uses the existing Chat Completions adapter
with `reasoning_effort: none` to preserve the earlier non-reasoning latency/cost
baseline and function-tool compatibility.

### A self-hosted / local model provider (LiteLLM, vLLM, Ollama, LM Studio, …)

Beyond the five hosted providers, `openai_compatible` is a generic path for any
OpenAI-Chat-Completions-compatible endpoint — most commonly a self-hosted
**LiteLLM** proxy, but equally vLLM/Ollama/LM Studio/etc. **"Add local model"** in
the Models page walks you through it:

1. **Test it first** — `POST /api/llm/providers/test` is a **non-metered**
   reachability probe: it calls `GET {base_url}/models` (falling back to `/v1/
   models`) with an optional Bearer key, so you know the endpoint answers before
   you wire it in.
2. **Add it** — `POST /api/llm/models/custom` with `{ model_id, base_url, label?,
   context_window?, api_key? }`. The model is stored (provider
   `openai_compatible`) with a **$0** price overlay applied automatically (belt-
   and-suspenders — the store row *and* the gateway's fallback both guarantee
   $0), so pointing at a local model never appears on a spend chart.
3. **Remove it** — `DELETE /api/llm/models/custom/{model_id}` also clears its $0
   overlay.

The optional key has **three** supply paths, in order of precedence: (a) the
per-model `api_key` you pass to `POST /api/llm/models/custom` (goes straight to
the in-memory secret tier, never the config store); (b) the backend env var
`LITELLM_API_KEY` (unprefixed; add `TLSOC_LITELLM_API_KEY` to `.env` for the
agnostic compose stack — see `DEPLOY.md`); or (c) nothing at all — a no-auth
local endpoint is driven by `base_url` alone, and the gateway falls back to
`OPENAI_API_KEY` if one happens to be set. None of this is a real spend risk:
the model is priced at $0 regardless.

### Discounted inference — live Flex and asynchronous Batch

**Analytics → Jobs** controls two independent cost paths. Both preserve the
same prompt, verdict, one-ledger-row rule, and deterministic case decision.

**Live Flex preference (default on).** Compatible alert/case inference on the
`automated_scan` and `investigate` surfaces prefers the official OpenAI Flex service
tier. Eligibility is deliberately narrow: the selected provider must be OpenAI
without a custom/Azure-compatible base URL, and the model family must be GPT-5, o3,
or o4-mini. Chat, standup, per-log overview, embeddings, and provider/model tests
stay interactive standard service. Unsupported
providers, endpoints, and model families use standard service before a provider call
and are never labelled or priced as discounted.

Fresh installations assign official OpenAI `gpt-5.6-luna` to completion roles, so
eligible alert/case calls can use Flex immediately. Existing stored model assignments
remain authoritative and unsupported/provider-alternate combinations continue on
standard service.

Flex is best-effort capacity. With **Standard fallback** enabled (the default), an
OpenAI 429 or a Flex/service-tier-specific 400 is retried once without
`service_tier="flex"`; that result is recorded and priced as standard. Disable the
fallback only when waiting/failing is preferable to paying the standard rate. The
usage record reports the `processing_tier` and discount actually returned—not merely
the tier requested.

**Asynchronous Batch queue (opt-in).** `batch.enabled` separately routes eligible
low-urgency event-detection candidates through Anthropic Message Batches or OpenAI
Batch. The severity floor and provider allow-list apply only to that delayed funnel;
turning it off does not disable the live Flex preference above. **Jobs** first shows
the signed-in actor's application background work. With `models:read`, it also shows a
separate read-only projection of related provider Batch records; users with
model-management permission can edit the two routing policies on the same page.

| Action | Endpoint |
|---|---|
| List batch jobs | `GET /api/batch/jobs` |
| One job's detail | `GET /api/batch/jobs/{job_id}` |
| Read / update batch config | `GET`/`PUT /api/batch/config` |

Submit / poll / retrieve is driven out-of-band by the batch service, not this
router—you observe progress here (submitted → polling → retrieved). Provider results
can arrive out of order, so retrieval is keyed by `custom_id`. Results are billed
**exactly once per result** at the batch discount rate (0.5×); this page never writes
a usage row itself, and nothing here calls `decide()`.

Related provider Batch rows do not acquire application-job Cancel or Download actions.
With `automation:read`, the page also shows read-only scheduler health; those worker
rows never create personal Inbox notifications. A newly accepted local Batch row takes
one strict, bounded snapshot of at most 200 active accounts whose effective grants include
`models:read`. A durable outbox then upserts one stable, generation-bound Inbox row per
snapshotted recipient with safe provider/model labels, request progress, and terminal
counts only. It never exposes provider handles, custom/case IDs, candidate payloads, or
raw provider errors, and it never adds Batch Cancel, Download, or completion-toast
actions.

If the authorization stores are unavailable, the audience stays pending and the
reconciler retries instead of guessing. Permission or account-generation loss removes
and fail-closed filters the old note. The snapshot is frozen: users or grants added later,
legacy Batch rows, and recipients beyond the 200-entry bound remain Jobs-list-only.
The bounded audience/outbox path is regression-backed across authorization-store outage,
stable retry, permission loss, account deletion/recreation, and factory-reset fencing.

### Durable application jobs

Long Case Manager operations, Data exports, precedent bootstrap, Runbook reindex,
Knowledge import, tiered reset, and Storage apply submit to `POST /api/jobs`. One
user intent retains one idempotency key across an ambiguous retry or double-submit;
a later deliberate repeat uses a fresh key. The server snapshots validated parameters,
returns `202 Accepted` only after the submission transition audit is confirmed, and
continues without the initiating page. Cancellation likewise waits for its transition
audit before a successful `202`; terminal Inbox/SSE state is withheld until the
terminal audit is confirmed and durable reconciliation repairs any audit gap.

Console/user workflows are Jobs-only. Direct archive/segment export, precedent
bootstrap, RAG import, and full-catalog Runbook reindex remain executable,
OpenAPI-deprecated compatibility primitives with request-bound or synchronous limits;
they are not canonical Console paths. Targeted single-Runbook reindex remains a normal
direct catalog operation. Reset and storage apply are different: their direct mutation
routes are retired with 410 and have no synchronous bypass.

Use **Analytics → Jobs** for the self-scoped registry and **Inbox** for its stable
notification projection. SSE provides actor-scoped live nudges and polling is the
fallback. Status moves from queued/running to succeeded, partial, failed, or cancelled.
Cancellation is cooperative and never rolls back completed items. Detailed failures
are bounded while their full/truncated counts remain visible. A terminal toast is a
deduplicated convenience, not the durable record.

Only results carrying a retained `artifact_id` show **Download**. The server verifies
size and SHA-256 before serving the server-managed ZIP. Artifacts are private filesystem state,
retained only for the newest 50 attachments, so move important exports into an
independent retention system. Job state uses strict-CAS transitions and renewable
five-minute leases, but execution/concurrency is process-local and the application
still supports one backend replica. See
[`docs/operations/background-jobs.md`](operations/background-jobs.md).

### Budget gate — a pre-flight spend ceiling

`GET`/`PUT /api/budget` reads/writes a daily + monthly USD ceiling
(`BudgetConfig`: `enabled`, `daily_usd`, `monthly_usd`, `on_exceed`). Since
**Round 10** this ships **ON by default** — `enabled: true`, `daily_usd: 10`,
`soft_warn_pct: 0.8`, `on_exceed: "block"` — as the spend backstop for
comprehensive ingestion (§33); warning-only mode remains an explicit opt-in.
`GET /api/budget/status` reports where you currently stand against it.
`POST /api/cost/estimate` (`{ model, prompt, max_tokens }`) gives a pre-flight
cost estimate for a hypothetical call, using any price overlay first and the
pricing table otherwise. The gate is a **pure pre-flight check**: when a call
would exceed budget it routes the investigation to `NEEDS_HUMAN` rather than
silently degrading or dropping the alert — it never overrides `decide()`, it only
gates *whether* the LLM is called at all.

---

## 23. Notifications — channels, templates, and the in-app inbox

Configure notifications in **Settings → Integrations → Alerting & notifications**.
The suite ships a pluggable `NotificationChannel` abstraction; the channel types
available are **email**, **Resend**, **Slack**, **Microsoft Teams**, **webhook**,
**PagerDuty**, and **Telegram**.

**Email (SMTP).** Pick a **provider preset** from the dropdown — 13 are built in
(gmail, o365, yahoo, zoho, icloud, sendgrid, mailgun, postmark, brevo, sparkpost,
**SES**, … and `custom`) — which fills host/port/encryption; supply `from_addr`,
recipients, and the SMTP credential (stored in the **secret tier**, never in
Preferences). `GET /api/notifications/providers` returns the preset table the UI
renders. **SES** ships as an SMTP preset (host `email-smtp.{region}.amazonaws.com`,
STARTTLS); supply ready-made SES SMTP credentials **or** a raw IAM access-key
pair — the backend derives the SMTP password via the stdlib AWS4-HMAC chain (no
new dependency).

**Resend** (`type:"resend"`) is an HTTPS-API channel — its secret is the Resend
API key; it POSTs to `https://api.resend.com/emails` with an idempotency key per
case/trigger and a client-side rate limit.

**Slack / Teams / webhook / PagerDuty / Telegram.** Add the channel and supply its
secret (a Slack/Teams incoming-webhook URL, a PagerDuty routing key, a Telegram bot
token, etc.) via `POST /api/notifications/channels/{channel_id}/secret`.

**Triggers, dedup, digest.** Each channel chooses **triggers** — on case create,
on verdict change, on escalate, on close — plus an `immediate_severity_threshold`.
Noise control is built in: **dedup** within `dedup_window_seconds`, per-recipient
**rate limiting**, and **digest** batching within `digest_window_seconds`.

**When sends happen.** Notifications fire **fire-and-forget, *after* the
deterministic `apply()` + save** — never inside `decide()` — so a channel failure
can never block or alter a case decision. Every send is audited; untrusted log
fields in the message body are fenced as plain text (#9).

### Customizable email templates

There are **5 preloaded templates** keyed by trigger — `case.new`
(`case_created`), `case.escalation` (`escalated`), `case.resolved` (`closed`),
`digest.daily` (`digest_daily`), and `test`. They render through a tiny **stdlib
mustache-subset** renderer: `{{var}}` is auto HTML-escaped, `{{{var}}}` is raw
**only** for trusted header HTML, with `{{#section}}`/`{{^section}}` and dotted
lookup (no `eval`/`getattr`). Subjects are CRLF-stripped/capped (header-injection
safe) and untrusted text in the `.txt` part is newline-stripped (#9). Override
the per-trigger `{subject, html, text}` in the template editor (stored under
`notifications.templates.overrides`); anything you don't override falls back to
the built-in default. `POST /api/notifications/preview?trigger=case_created`
renders a **sample** case server-side and returns the exact wire output for
review (no real send, no secret leak).

```bash
curl -s localhost:8088/api/notifications/providers      # presets + channel_types + template_ids
curl -s -b cookies.txt -X POST "localhost:8088/api/notifications/preview?trigger=escalated" \
  -H 'content-type: application/json' \
  -d '{"subject":"[{{org_name}}] ESCALATED {{case.case_number}}"}'   # preview an unsaved edit
curl -s -b cookies.txt -X POST localhost:8088/api/notifications/channels/resend-1/secret \
  -H 'content-type: application/json' -d '{"field":"api_key","value":"re_..."}'
```

### In-app inbox

Every notification also fans into a per-user, self-scoped **in-app inbox**
(the **Inbox** page under the **Notifications** nav group) — including @mention
fan-out from case threads (§18). Every route reads/writes only the requesting
user's bucket; there is no admin view of another user's inbox.

| Action | Endpoint |
|---|---|
| List my inbox (optionally unread-only) | `GET /api/notifications/inbox?unread_only=` |
| Unread count (for the bell badge) | `GET /api/notifications/inbox/unread-count` |
| Mark one read | `POST /api/notifications/inbox/{notification_id}/read` |
| Mark all read | `POST /api/notifications/inbox/read-all` |
| Dismiss one | `POST /api/notifications/inbox/{notification_id}/dismiss` |
| Read / update my per-category × channel prefs | `GET`/`PUT /api/notifications/prefs` |

The inbox is advisory (never feeds `decide()`, #3); titles/bodies are plain,
render-escaped data (#9); no secret is ever read or returned here.

Accepted application jobs upsert one stable Inbox row with status, progress, result
counts, and a curated same-app result link. Marking it read does not cancel work or
hide active progress. SSE nudges and polling keep it current; the terminal toast is
deduplicated and transient. Scheduler health is always list-only. Newly accepted local
LLM Batch rows also upsert one stable progress/terminal note for their frozen,
generation-bound effective-`models:read` audience (maximum 200). They intentionally
have no Cancel, Download, or terminal toast. Legacy rows and later users/grants remain
Jobs-list-only; permission/generation loss hides and removes a stale note. The Jobs list
remains the authoritative shared record for every non-recipient.

---

## 24. Authentication — users, RBAC, custom roles, MFA, SSO

Auth is **default OFF** (the no-auth "old version" is the default and stays fully
functional, which is also why the offline tests run unauthenticated) — but it is
**fully built**: six built-in roles plus operator-defined custom roles, TOTP MFA,
OIDC SSO, and a session policy. Turn it on with the env flag and restart the
backend:

```bash
# in .env (mapped to the backend's UNPREFIXED env names by compose)
TLSOC_AUTH_ENABLED=true
```

When auth is enabled, the relevant `Secrets` are `auth_enabled`,
`auth_seed_admin` (default true), `auth_seed_admin_username` (default `Admin`), and
`auth_seed_admin_password` (default `Admin@123`).

### First login + OOBE

On first boot with an **empty** user store, the suite seeds a single
**`super_admin`** — `Admin` / `Admin@123` — with `must_change_password=true`. At
the login screen sign in as `Admin` / `Admin@123`; the login flow detects the flag
and forces a **change-password** step (`POST /api/auth/change-password`) before it
issues a real session. **Change this password immediately** — the seed is a known
default. You can disable the seed with `TLSOC_AUTH_SEED_ADMIN=false`; the platform
then self-bootstraps via the public **`POST /api/setup/account`** endpoint — a
strong-password-enforced (min length, must differ from the username, rejects
common passwords), one-shot OOBE that is only callable while auth is on, setup is
not yet complete, and **no** user exists yet. The moment one admin exists the
endpoint **self-locks** (`409` on any further call) — it can never be used to add
or escalate an account on a live platform. (There is no `/api/setup/init-admin` —
that legacy, weaker path was removed.)

### Roles (RBAC)

The suite ships a **six-role** built-in permission matrix, enforced **in code** on
every state-changing route (and mirrored in the UI by `<Can>` guards that hide
actions a role can't perform):

| Role | Typical scope |
|---|---|
| `super_admin` | everything, incl. users / RBAC / SSO / settings |
| `soc_manager` | manage cases + approvals + most settings |
| `analyst_tier2` | investigate + close cases |
| `analyst_tier1` | investigate + work cases (no close) |
| `responder` | act on assigned cases |
| `auditor` | read-only (cases, audit, metrics) |

`GET /api/roles` returns the built-in role→permission matrix the UI renders.
Manage users (super_admin only) on **Settings → Security & access → Users**:

```bash
curl -s localhost:8088/api/users                                   # list
curl -s -X POST localhost:8088/api/users \
  -H 'content-type: application/json' \
  -d '{"username":"alice","password":"<temp>","role":"analyst_tier2",
       "display_name":"Alice Ng","email":"alice@example.org","phone":"+91 ...",
       "mfa_required":true,"custom_roles":["tier1_plus"]}'
curl -s -X PUT localhost:8088/api/users/alice \
  -H 'content-type: application/json' -d '{"role":"soc_manager","active":true}'
curl -s -X DELETE localhost:8088/api/users/alice
```

Beyond `username`/`password`/`role`, creation accepts the optional profile fields
`display_name` (doubles as the full name), `email`, and `phone`, the `mfa_required`
enrolment mandate (see MFA below), and creation-time `custom_roles` (validated
exactly like `PUT /api/users/{username}/roles`). Update accepts the same profile
fields plus `mfa_required` (`null` = leave unchanged; clearing a text field is an
explicit empty string); custom roles are re-assigned post-hoc via the roles
endpoint. All additive — the base `role` must remain one of the six built-ins.

### Custom roles

**Settings → Security & access → Roles & permissions** manages **operator-defined
custom roles** layered on top of the six built-ins: a custom role `inherits` one or
more base roles, `grants` additional `resource → [action]` permissions, and can
`deny` specific ones (deny always wins). A built-in role name can never be
created/mutated/deleted through this surface, and the effective-matrix resolver
drops a custom role that would shadow a built-in one — so the platform owner can
never be locked out. An unknown/deleted role assigned to a user fails safe to a
default role at resolution time.

| Action | Endpoint |
|---|---|
| Create a custom role | `POST /api/roles` |
| Update (replace by name) a custom role | `PUT /api/roles` |
| Delete a custom role | `DELETE /api/roles/{name}` |
| Preview a draft role's effective grants (no persistence) | `POST /api/roles/preview` |
| Simulate `can(role, resource, action)` | `GET /api/roles/simulate` |
| My own resolved permissions (drives the webui `<Can>` guard) | `GET /api/account/permissions` |
| Assign a base role + custom roles to a user | `PUT /api/users/{username}/roles` |

Every RBAC mutation is audited; role names/grant maps are returned as plain data
(#9) and are never fed to an LLM prompt.

### Enrolling MFA (TOTP)

MFA is per-user, RFC-6238 TOTP, stdlib-only:

1. Signed in, go to **Settings → Account → Security & two-factor** (or
   `POST /api/auth/mfa/setup`). The backend returns `{ secret, otpauth_uri,
   recovery_codes }`.
2. The UI renders the `otpauth://` URI as an **inline-SVG QR** — **scan it** with
   Google Authenticator / Authy / 1Password / etc. (or type the `secret` by hand).
   **Save the recovery codes** (single-use, shown once).
3. Confirm enrolment by entering a current 6-digit code:
   `POST /api/auth/mfa/confirm` — this persists MFA as enabled.

After that, **login is two-phase**: the password call returns
`{ requires_mfa: true, session }`, and the client posts the code to
`POST /api/auth/mfa/verify` to receive the real JWT (a recovery code works here too,
once). Disable with `POST /api/auth/mfa/disable` (self, requires a current code; an
admin can force-disable). `mfa.enforce_for_roles` can require MFA for chosen roles.

**Admin-mandated enrolment:** an admin can set **Require MFA** on a user at create
or edit time (the `mfa_required` flag — required ≠ enrolled; it never mints a
secret). At the next login, a mandated-but-unenrolled user's password call returns
`{ requires_mfa, mfa_enrollment_required, pending_token }` and the login screen
walks them through authenticator enrolment **inside the login flow** —
`POST /api/auth/mfa/enroll-setup` (QR + recovery codes) then
`POST /api/auth/mfa/enroll-confirm` (proves possession, persists the enrolment,
and mints the full session) — before any session is issued. Both routes are gated
by the same short-lived pending token (never a session); an already-enrolled
account cannot replace its factor through this path, every step is audited, and
the env-managed admin fallback is never mandated (it has no persisted user record
to enrol).

### Configuring SSO (OIDC)

Configure an OIDC provider in **Settings → Security & access → Single sign-on &
policy** (writes the `sso` Preferences block). Supported: **Google**,
**Microsoft**, and **generic** OIDC. The flow is server-side: the suite redirects
to the provider, exchanges the `code` server-side, then calls the provider's
**`userinfo`** endpoint and maps the claims to a user (id_token *signature*
verification is intentionally skipped — see `SECURITY.md` — so there is **no
`PyJWT`/JWKS dependency**).

1. Set `sso.enabled=true`, the provider `type`, `client_id`, `discovery_url` (for
   generic), `scopes`, the `allowed_domains` / `allowed_tenants`, and the
   `group_claim_name` + `group_role_map` (group → one of the six roles); set
   `auto_create_users` to provision users on first login at `default_role`.
2. Put the client secret in the secret tier:
   `POST /api/auth/sso/providers/{provider_id}/secret`.
3. Register the **callback URL** shown in the SSO settings panel with your IdP.

Endpoints: `GET /api/auth/sso/providers` (public; powers the "Sign in with …"
buttons), `GET /api/auth/sso/authorize?provider=` (returns the auth URL + sets a
single-use state/nonce), `GET /api/auth/sso/callback?code=&state=` (validates,
mints the JWT, redirects to `/`).

---

## 25. Settings — full reference

`GET /api/settings` returns `{ prefs, configured, read_only }`; `PUT
/api/settings` applies a partial patch (deep-merged server-side, validated against
the `Preferences` schema). When **read-only mode** is on, a `403` is returned.
Large subtrees can be fetched section-by-section with `GET
/api/settings/{section}`, and `GET /api/settings/schema` returns the
form-generation schema.

**Layout: five Settings groups, 28 sections** (`webui/src/soc/pages/settings/
settings-sections-meta.ts`, the single source of truth the rail, the deep-link
router, and the Cmd-K "jump to a setting" search all derive from):

| Group | Sections |
|---|---|
| **Account** | Profile · Security & two-factor · Sessions & activity · Appearance & customization |
| **General** | Data scope · Models · Detection · Detection & rules (§14) · Cases (case-ID format, below) · SLA, priority & suppression · Automation (master switch, §14) · Standup |
| **Integrations** | Alerting & notifications (§23) · Enrichment (§19) · Knowledge & threat context (§9, §12) |
| **Security & access** | Users · Roles & permissions (§24's custom roles) · Single sign-on & policy (§24) · Active sessions (§27) · Secret keys |
| **Organization** | Branding · Updates & releases (read-only Stable/Testing observations plus supervised one-click Stable updates for a bootstrapped, supported Compose/PostgreSQL deployment) · Advanced (caps, kill switch, background-scan/auto-forward allowlist, the autopilot dial + risk floor + budget backstop, §33, read-only lock) · All settings (a schema-generated long tail) · Experimental & Demo (§28) · Storage & retention · Data export · Danger zone (§28's tiered reset) |

The page uses one searchable section rail, one active-section heading, and flat
divider-led setting groups. It deliberately avoids a card around the whole page and
then more cards around every field group; dialogs and contained editors keep their
own boundary where one is functionally useful. On a narrow screen the full section
inventory moves into a searchable Sheet opened from one compact section trigger. The
current `#/settings?s=<id>&a=<anchor>` location remains deep-linkable. Modified sections
carry a visible dirty indicator, while one sticky **Save changes / Discard** bar owns
buffered preference writes; a renderer must not introduce a competing save path.

RBAC hides a section a role can't reach (and auto-jumps off a hidden active
section); with auth/RBAC off, everything shows. Every section still round-trips
through `/api/settings`, `/api/branding`, `/api/roles`, and the per-feature routes
covered elsewhere in this document.

### Custom case-ID nomenclature

`case_id_format` (**Settings → General → Cases**) controls the human-facing
**case number** (the immutable system `case_id` is unchanged). Set `enabled=true`
and a `template` (placeholders include `{prefix}`, `{sep}`, `{year}`, `{yy}`,
`{mm}`, `{seq:0Nd}`, `{source}`, `{verdict}` — e.g. `CASE-{year}-{seq:06d}` →
`CASE-2026-000123`), a `reset_period` (`none` / `calendar_year` / `fiscal_year` /
`fiscal_quarter`), and `seq_start`. The sequence is an atomic KV counter bucketed
by period. Preview candidate templates without persisting:
`POST /api/settings/case-id/preview`. When set, the UI shows `case_number` and
falls back to `case_id`.

### Configured credentials

Badges per secret show **`configured ✓`** or **`not set`** — values are never
returned. Covered: `es_api_key`, `es_mgmt_api_key`, `openai_api_key`,
`anthropic_api_key`, `litellm_api_key` (§22), the enrichment-provider keys (§19),
and `embedding_api_key`. Per-source secrets show as `configured_secrets` on each
source.

### Portable application-state export

**Settings → Organization → Data export** exports all records in selected supported
safe scopes. Choose `cases`, `audit`, `usage`, `configuration`, `automation`, and/or
`knowledge`; archive and advanced segment strategies both submit one server-owned
background job. After `202 Accepted`, close the dialog or navigate elsewhere. Follow
progress, cooperative cancellation, bounded failures, and the terminal result in
**Analytics → Jobs** or **Inbox**.

Archive mode writes one `<scope>.ndjson` entry per selected scope and a terminal
`manifest.json` with counts, completeness, consistency, actor, and current build
provenance. Advanced mode follows authenticated opaque cursors in bounded pages, then
packages its numbered JSON envelopes into the same kind of single ZIP. **Records per
file** (500–5000) is an internal segment-size control, not a full-history ceiling; the
browser no longer has to remain open and collect numbered downloads.

The server exposes **Download** only when the terminal job result has a non-empty
`artifact_id`. Archive mode verifies member CRC/count/size/digests against its terminal
manifest before attachment. Segment mode reopens its ZIP and rejects corrupt, empty, or
unexpected members. Every download then checks the retained file's size and SHA-256.
Only an Elasticsearch scope whose manifest says `consistency.exact: true` proves fixed
membership and values; PostgreSQL and KV scopes remain explicitly non-exact, and
selected scopes are not one cross-scope transaction.

This export intentionally excludes environment/source credentials, users and
sessions, password/MFA material, browser tokens, upstream raw logs, and raw knowledge
chunks; a final recursive sanitizer also removes credential-shaped fields and common
secret patterns. Each internal archive page and compact segment response is capped at
25 MiB; the complete disk-backed ZIP has no 25 MiB lifetime ceiling. It is **not** a
whole-application export, import format, database dump, or backup/restore substitute;
chat, collaboration, identity/session state, user preferences, and raw RAG chunks are
also outside its supported scopes. Preparation and terminal outcomes are audited and
require `data_export:export` plus fresh authentication. Elasticsearch scopes disclose
an exact PIT snapshot; PostgreSQL discloses `bounded_at_start` and KV paths disclose
their weaker live-at-read semantics.

If any selected registry cannot emit its starting count, the temporary filesystem
cannot preserve its safety reserve, the finished ZIP fails CRC/count/size/SHA-256
verification, or the append-only job/audit transition cannot be persisted, the job
fails and exposes no artifact. The audit and job result prove preparation,
authorization, and counts—not that the client downloaded every byte.

The local and updater-managed standalone artifact root defaults to
`./data/job-artifacts`; the legacy merge Compose uses the persistent
`/var/lib/agentic-soc/jobs` volume. Standalone files survive a process/ordinary
container restart but require an operator-provided reviewed mount to survive container
replacement. Files are private and only the newest 50 attached artifacts are retained.
A job record can outlive its Download action. Move an important export to an
independently controlled retention system; this feature is still an analysis/support
artifact, not a backup.

The older direct archive and segment endpoints remain executable, explicitly
OpenAPI-deprecated compatibility interfaces. They retain their request-bound timeout,
temporary-disk, and cursor constraints and are not the Console workflow. For example,
a direct synchronous archive request (all safe scopes when `scopes` is omitted) is:

```bash
curl -sS -b cookies.txt -X POST localhost:8088/api/admin/export/archive \
  -H 'content-type: application/json' \
  -d '{"scopes":["cases","audit","usage"]}' \
  --output agentic-soc-export.zip
```

Direct advanced/resumable example:

```bash
curl -sS -b cookies.txt -X POST localhost:8088/api/admin/export/segment \
  -H 'content-type: application/json' \
  -d '{"scope":"audit","page_size":1000}' \
  --output agentic-soc-audit-part-00001.json
```

For the direct advanced API, pass the response's `segment.next_cursor` in the next request and continue until
`segment.complete` is true. PIT cursors use a renewable ten-minute keep-alive; after
expiration or backend restart, restart that scope. Automation and knowledge are
currently materialized from their KV collections before being sliced into response
segments, so exceptionally large catalogs have a known server-memory limitation.
The direct synchronous ZIP path retains its proxy/timeout boundary. The background job
does not depend on the initiating browser response, but archive assembly still has one
process-local slot and must fit server disk. Job cancellation stops at a safe checkpoint
and does not undo server work already performed; a cancelled or otherwise incomplete
export exposes no artifact.

### Polling & detection

A themed field reference spanning **General → Data scope** (the first three rows)
and **Organization → Advanced** (the rest, incl. the Round-10 autopilot knobs, §33):

| Field | Pref | Default | Notes |
|---|---|---|---|
| Poll interval (seconds) | `poll_interval_seconds` | 30 | loop sleeps `max(5, value)` |
| Severity threshold | `severity_threshold` | 0.0 | min numeric severity in scope |
| Polling enabled | `polling_enabled` | true | starts/stops the loop |
| Background scan enabled | `background_scan_enabled` | **true** (Round 10) | comprehensive ingestion — every source correlated + risk-scored; see §33 |
| Auto-forward risk floor | `auto_investigate_risk_floor` | **70** (Round 10) | the deterministic risk gate for `events`-role clusters — §33 |
| Autopilot profile | `autopilot_profile` | `"balanced"` (Round 10) | `conservative` \| `balanced` \| `aggressive` — moves the risk floor + daily budget + per-tick cap together, §33 |
| Auto-forward allowlist | `auto_forward_allowlist` | `[]` | comma-separated rule values; `*` = all; forwards regardless of risk |

### Case evidence fields

**General → Case evidence fields.** What the agent is shown per event, what
`es_query` returns per row, and what free-text search matches against — one list,
three surfaces (§11).

| Field | Pref | Default | Notes |
|---|---|---|---|
| Evidence fields | `evidence_fields` | the 11-path ECS set (§11) | dotted paths added to each event's identity keys; `[]` = identity only, `["*"]` = the whole record; per-source override via that source's `evidence_fields` config key (co-correlated sources union) |
| Evidence budget per event | `evidence_max_chars_per_event` | 1200 | serialised characters per event (0–16000). When it binds, the withheld field names are reported to the model; in whole-record (`["*"]`) mode, rule *definition* metadata is offered last and so is dropped first. Multiplies across the 12 sample events an investigation reads |

### Caps & kill switch

| Field | Pref | Default |
|---|---|---|
| Max tool calls | `caps.max_tool_calls` | 8 |
| Max tokens | `caps.max_tokens` | 20000 |
| Max concurrent investigations | `caps.max_concurrent` | see schema |
| Max auto-investigations / tick, **shared across concurrently polled sources** (§33) | `caps.max_auto_investigations_per_tick` | **25** (Round 10) |
| Kill switch | `caps.kill_switch` | false |

The **kill switch** is a global emergency stop: when on, the poller does not run
and an investigation returns a `NEEDS_HUMAN` case with *"Kill switch engaged;
investigation skipped."* (`caps.timeout_seconds` = 120 is schema-level.)

### Auto-close policy

Lives on **Settings → General → Detection**:

| Toggle | Pref | Default |
|---|---|---|
| FALSE_POSITIVE auto-close | `auto_close.false_positive.enabled` | **true** (0.85 confidence, ≤30 risk, 1440min objection window) |
| TRUE_POSITIVE auto-close | `auto_close.true_positive.enabled` | **false** (opt-in; 0.95 confidence, ≤10 risk, 4320min objection window when enabled) |

(`fp_auto_close` is the deprecated predecessor field, migrated once into
`auto_close.false_positive` for back-compat.)

### Other feature toggles

| Toggle | Pref | Default | Section |
|---|---|---|---|
| Enrichment enabled | `enrichment.enabled` | true | Integrations → Enrichment |
| RAG enabled | `rag.enabled` | true | Integrations → Knowledge & threat context |
| Standup enabled | `standup.enabled` | true | General → Standup |

### Per-rule correlation (JSON editor, also reachable through §14's Detection & Rules editor)

A JSON map of **rule value → `{ mode, n, window_seconds, group_by }`**:

```json
{
  "web_auth":   { "mode": "threshold", "n": 5, "window_seconds": 120, "group_by": "ip" },
  "modsec_xss": { "mode": "every",     "n": 1, "window_seconds": 60,  "group_by": "ip" },
  "ml_stats":   { "mode": "never",     "n": 1, "window_seconds": 60,  "group_by": "host" }
}
```

- **mode**: `threshold` (≥ `n` within `window_seconds`, grouped), `every`
  (every occurrence), `never` (manual only).
- **group_by**: `ip` | `user` | `host`.
- Rules not listed use **default correlation** (`threshold`, `n=5`,
  `window_seconds=120`, `group_by=ip`).

---

## 26. Your account — profile, avatar, activity

> Account self-service is reachable **only when auth is enabled** (§24). With auth
> off the suite has no concept of a per-user identity, so these surfaces are hidden
> and `GET /api/account/me` reports `auth_enabled:false`.

The login screen is a two-column split (a left brand hero consuming your
branding — org name / logo / accent colours from `GET /api/branding` — and a
right form card, `hidden lg:block` on the hero so a phone just sees the clean
form). It drives four modes from one screen: normal sign-in, the forced OOBE
change-password step on the seeded admin's first login (with a live,
dependency-free password-strength meter), the **MFA** code step (a 6-cell
segmented OTP entry, §24), and any configured **SSO** buttons.

### Edit your profile + avatar

Open **Settings → Account → Profile**. It reads `GET /api/account/me` and writes
`PUT /api/account/me`. Every field is optional and only the fields you change
are written; clearing a field is an explicit empty string (never null):

| Field | Body key | Notes |
|---|---|---|
| Display name | `display_name` | shown in the top bar / audit attribution |
| Short alias | `alias` | a compact handle |
| Alternate email | `alt_email` | a contact address (not the login id) |
| Timezone / locale | `timezone` / `locale` | personal formatting |
| Avatar | `avatar` | a small data-URL image (see below) |
| Personal prefs blob | `prefs` | a small JSON object (bounded) |

**Avatar.** The browser resizes/crops your image to **256×256 WebP** before upload,
so the backend only ever validates a tiny data-URL string. Allowed:
`data:image/png|webp|jpeg;base64,…` (**SVG is rejected**; the body is magic-byte
sniffed and capped). Use the dedicated thin endpoint `PUT /api/me/avatar` to just
set or clear the avatar (an **empty string clears it**).

```bash
# View your own account (auth-on)
curl -s -b cookies.txt localhost:8088/api/account/me

# Patch your profile (only the provided fields change)
curl -s -b cookies.txt -X PUT localhost:8088/api/account/me \
  -H 'content-type: application/json' \
  -d '{"display_name":"Alice Ng","timezone":"Europe/London","alt_email":"alice@corp.example"}'

# Set / clear just the avatar
curl -s -b cookies.txt -X PUT localhost:8088/api/me/avatar \
  -H 'content-type: application/json' -d '{"avatar":"data:image/webp;base64,UklGR..."}'
curl -s -b cookies.txt -X PUT localhost:8088/api/me/avatar \
  -H 'content-type: application/json' -d '{"avatar":""}'    # clear
```

**The env single-admin can't self-edit.** If auth runs as the legacy
environment-seeded single admin (no persisted user record), `account/me` returns
`env_managed:true` and a `PUT` is refused with `400` ("managed via environment
configuration") — exactly like the change-password seam. Create real users (§24)
to get editable profiles. Secrets never leak: `public()` excludes `password_hash`,
`mfa_secret`, and the recovery-code hashes. Every profile/avatar change is audited.

Your recent account activity is available at `GET /api/account/activity?limit=50`
(your own audit rows, newest first) — it powers the "recent activity" list on the
account page.

---

## 27. Sessions & token policy

When auth is enabled, the stdlib HS256 JWT is a short-lived **access token**
carrying a session id (`sid`) + token-version (`tv`) claim, backed by a durable
`SessionStore` (in your `STATE_BACKEND`, so sessions survive a restart). Every login
path (password, MFA-verify, SSO callback) registers a session row with its device /
browser / OS / IP (+ city/country when resolvable) — all rendered as **plain data**.

### See and revoke your own sessions

**Settings → Account → Sessions & activity** lists your session cards. The
current one is pinned with a **"This device"** badge; each other row has a
destructive **Revoke**, and a top-right **"Sign out all other sessions"**.

| Action | Endpoint |
|---|---|
| List my sessions (current flagged) | `GET /api/sessions` |
| Revoke one of my sessions | `POST /api/sessions/{sid}/revoke` |
| Sign out my **other** sessions (keep this one) | `POST /api/sessions/revoke-others` (`{"notify":true?}`) |

Revoking your other sessions bumps your `token_version`, so any still-valid JWT for
the other sessions is rejected on its next request (the kept `sid` is preserved).

### Admin: terminate anyone's sessions

Admins (`users:manage`) get **Settings → Security & access → Active sessions** —
every session across all users, force-terminable. These admin writes are
**step-up gated**: if your last password re-auth is older than the sudo window
you get `401 {code:"reauth_required"}` and the UI pops a re-auth modal
(`POST /api/auth/reauth` with your password stamps a fresh `last_authn_at`).

| Action | Endpoint |
|---|---|
| List ALL sessions | `GET /api/admin/sessions` |
| Force-terminate one session | `POST /api/admin/sessions/{sid}/revoke` (step-up) |
| Global sign-out for one user | `POST /api/admin/users/{username}/revoke-all` (step-up) |

### Token policy (idle / absolute / refresh / sudo)

**Settings → Security & access → Single sign-on & policy** edits the
`session_policy` Preferences sub-model: `access_ttl` (default 900s), `idle_timeout`
(1800s), `absolute_lifetime` (43200s), `refresh_ttl` (604800s),
`sudo_reauth_window` (600s), plus notify-on-new-device / notify-on-terminate
toggles. Idle + absolute expiry and revocation are enforced in `require_auth`
(the async gate), not in the hot-path sync `verify()`. A session whose
idle/absolute window has lapsed gets `401 {code:"session_expired"}`.

**Refresh rotation + theft detection.** `POST /api/auth/refresh` rotates the
refresh token (old hash slides to a previous-hash slot) and mints a fresh access
token. If a caller replays an **already-rotated** refresh token, that is treated
as theft: the session is revoked, the user's `token_version` is bumped (global
sign-out), the event is audited + best-effort notified, and a `401
{code:"session_invalid"}` is returned. `POST /api/auth/logout` revokes the
current `sid`.

```bash
curl -s -b cookies.txt localhost:8088/api/sessions
curl -s -b cookies.txt -X POST localhost:8088/api/sessions/revoke-others -d '{}'
curl -s -b cookies.txt -X POST localhost:8088/api/auth/reauth \
  -H 'content-type: application/json' -d '{"password":"<my-password>"}'
curl -s -b cookies.txt -X POST localhost:8088/api/auth/refresh \
  -H 'content-type: application/json' -d '{"refresh_token":"<token>"}'
```

---

## 28. Demo Mode — a safe, reversible showcase

Demo Mode is a first-class, **reversible, fully isolated** tenant state (not a
fork). Synthetic OCSF events flow through the **real** correlate → risk → decide
pipeline, but every demo-generated workload write lands in a **separate in-memory
store** with a **deterministic mock LLM**, so the demo is **$0** and leaves your real
data untouched,
and is removed with one flip. (Lifecycle audit records are intentionally persistent;
other admin settings remain live.) Enable it from **Settings → Organization →
Experimental & Demo**. Status requires `demo:read`; mutations require
`demo:manage`, granted by default to `super_admin` and `soc_manager` (and available
to explicitly configured custom roles). Every demo case is tagged `demo` plus a
run tag. Seeded cases use `demo-…` IDs; live pipeline cases may instead use the
configured case-number format, so an ID prefix is not the isolation boundary.

| Action | Endpoint | What it does |
|---|---|---|
| Status | `GET /api/demo/status` | `{mode, run_id, history_days, tick_seconds, …}` (`demo:read`) |
| Enable | `POST /api/demo/enable` | seed synthetic data; start the simulator (`demo:manage`) |
| Generate incident | `POST /api/demo/incident` | emit one cooldown-aware five-source storyline (`demo:manage`) |
| Reset | `POST /api/demo/reset` | delete this run + re-seed from the same seed (`demo:manage`) |
| Disable / clear | `POST /api/demo/disable` | stop the tick + **hard-delete** demo data by `run_id` (`demo:manage`) |

`mode` is `off` | `seeded` | `live`:

- **`seeded`** pre-generates a trailing **history window** (`history_days`, default
  14) of backdated "old" cases over a fixed fictional org (employees / hosts / a DC /
  VIP / a corp range), a benign baseline, plus 4–6 MITRE ATT&CK storylines
  (phishing → cred-access → lateral → exfil, RDP brute force, SQLi → webshell,
  impossible-travel, ransomware beacon, insider staging).
- **`live`** additionally runs a jittered background **simulator** (`tick_seconds` ≈
  10, `tick_jitter`, `incident_rate`) with five independently visible,
  protocol-compatible sources. It guarantees an initial cross-source storyline,
  then emits bounded benign traffic and scheduled detections so the live tail,
  source health, correlation, and investigations keep moving during a demo.
  `incident_rate` is a 0–1 probability evaluated once whenever
  `alert_interval_seconds` elapses; it is **not** a per-event or per-tick rate. The
  guaranteed first incident and a manual incident request do not consume that roll.

| Synthetic source | Native records exercised | Alert behavior |
|---|---|---|
| Splunk-compatible | HEC event envelopes (`access_combined`) | HEC Enterprise Security-style risk finding |
| QRadar-compatible | RFC-syslog-carried LEEF 2.0 | `/api/siem/offenses`-shaped finding |
| Wazuh-compatible | `archives.json`-shaped records | `alerts.json`-shaped record with a synthetic rule |
| Syslog | RFC 5424 plus occasional RFC 3164 | Agentic SOC raises a correlated detection; no vendor alert is invented |
| Microsoft Entra ID / Active Directory | Graph `auditLogs/signIns` and Identity Protection-shaped JSON | Entra-native risky-sign-in / identity alert |

These records are independently authored synthetic data, labelled protocol-compatible,
and passed through the same receiver/parser → OCSF boundary as production input. The
full native record remains untrusted evidence. Per-source recent-event buffers are
bounded; the higher event-rate number is logical volume handled by aggregate sketches.

```bash
curl -s -b cookies.txt localhost:8088/api/demo/status
curl -s -b cookies.txt -X POST localhost:8088/api/demo/enable \
  -H 'content-type: application/json' \
  -d '{"mode":"live","seed":1337,"history_days":14,"tick_seconds":10,"alert_interval_seconds":120,"incident_rate":0.05}'
curl -s -b cookies.txt -X POST localhost:8088/api/demo/incident  # coherent 5-source attack
curl -s -b cookies.txt -X POST localhost:8088/api/demo/reset      # re-seed, same seed
curl -s -b cookies.txt -X POST localhost:8088/api/demo/disable    # exit + hard-delete
```

A successful manual incident emits exactly eight native records across the five
sources: four source-native alerts (Splunk, QRadar, Wazuh, and Entra) plus four
syslog events that produce at least one Agentic SOC correlation detection. The
response attributes records, native alerts, and system detections per source.

**While demo is engaged** the app shell shows an amber **Demo banner** with *Reset*
and *Exit & clear*; demo rows carry a `SAMPLE` badge; cost tiles read "(simulated)";
the Sources UI disables real connector controls; and outbound notification tests are
refused. Other organization/admin settings remain live and should be left unchanged
during a presentation. FALSE_POSITIVE still runs through the **real** `decide()`
against a sandboxed policy copy, and `NEEDS_HUMAN` stays open as the HITL showcase.
The real polling cursor is left untouched, and `POST /api/demo/disable` flips the
state back to `off` and hard-deletes every demo case / audit / usage / event by
`run_id`.

Demo lifecycle mutations are the deliberate exception to throwaway writes: enable,
manual incident, reset, and disable append operator-attributed records to the **real**
audit log. `/api/audit` shows the demo-scoped trail while Demo Mode is active; exit
the demo before using the Audit page to view those persistent lifecycle records.

**Tiered reset.** Beyond Demo Mode, **Settings → Organization → Danger zone** offers
an admin-gated, freshly authenticated, type-to-confirm **tiered reset** (cases /
sources / factory) through a `tiered_reset` background job. The cost ledger and audit
log survive the cases tier, and **environment-supplied secrets are never wiped by any
tier**. Non-factory progress remains in Jobs/Inbox. Factory purges prior Jobs, personal
Inbox state, and artifacts, so it retains only one privileged actorless sanitized
system receipt and starts a new audit lineage—not a personal Inbox completion. In the
supported single-backend-process profile, the reset closes and drains HTTP mutation
admission and SSE, quiesces tenant producers and detached writers, clears Demo/EventBus/
cache state, strictly removes tenant cases/cursors/RAG/usage/audit and non-protected KV
state, restores boot-provided runtime secrets, and releases its fences only after the
sanitized receipt lineage is audited. This is not a distributed transaction across
arbitrary application replicas.
If its privacy boundary fails, the application stays fenced/degraded: ordinary work is
blocked and only a new, freshly authorized factory-reset attempt is permitted until the
boundary succeeds.
The retired direct `POST /api/admin/reset` mutation returns `410 Gone` with
`durable_job_required`; there is no synchronous bypass around the Job fence.

---

## 29. Source feeds — alerts / events / ignore

A pull source's index patterns are richer **feeds**. The model keeps its wire key
(`config.index_patterns`) and class name (`IndexPattern`) for back-compat, but each
entry carries a per-feed **role**, query, mapping, severity floor, and correlation
behaviour. Edit them in the **`SourceEditor`** (§2, a source's Feeds panel); the
source round-trips through the existing `POST /api/sources` (additive `config`, no
migration).

**Role** (`role`): `alerts` (auto-investigate by default, bypasses the allowlist),
`events` (correlate → auto-forward only when on the allowlist), or **`ignore`**
(skip ingest entirely — excluded from the union read, useful to carve a noisy
sub-index out of a broad `events` pattern; longest-pattern-wins precedence).

**Per-feed knobs:**

| Field | Meaning |
|---|---|
| `pattern` | the index pattern (e.g. `wazuh-alerts-*`) |
| `role` | `alerts` \| `events` \| `ignore` |
| `enabled` | turn a feed off without deleting it |
| `query` | a connector-native filter applied to just this feed (operator-**TRUSTED**) |
| `field_mapping` / `message_field` | per-feed overrides (fall back to the source-level mapping) |
| `severity_floor` | OCSF `severity_id` 1–6; below it an event is **not auto-forwarded** but is **still correlated + live-tailed** (never dropped, #4) |
| `correlate` | the per-feed "Auto-Correlate" toggle (legacy `auto_correlate` maps onto this); `false` → candidate-only (manual triage), still correlated |
| `auto_investigate` | `null` → derived from role/legacy (`alerts` or legacy `auto_correlate`); set `true`/`false` to pin it |

**Back-compat is exact.** A stored `{pattern, role, auto_correlate}` dict — or a bare
`"all-logs-*"` string — still validates and yields identical effective behaviour
(`auto_correlate` → `correlate`; `auto_investigate` derived as `role=='alerts' or
legacy auto_correlate`). Each feed gets its **own durable poll cursor**
(`{source.id}:{feed.id}`), so a fast `alerts` feed and a slow `events` feed never
share or skip a cursor (#4). The legacy `config.data_view_pattern` stays synced
(comma-join of the non-`ignore` patterns) for the fallback read path.

```bash
curl -s -X POST localhost:8088/api/sources \
  -H 'content-type: application/json' \
  -d '{
        "id": "prod-es", "source_type": "elasticsearch", "is_primary": true,
        "config": {
          "es_url": "https://elasticsearch:9200",
          "index_patterns": [
            { "pattern": "wazuh-alerts-*", "role": "alerts" },
            { "pattern": "all-logs-*", "role": "events", "severity_floor": 3,
              "query": "event.outcome: failure", "correlate": true },
            { "pattern": "all-logs-debug-*", "role": "ignore" }
          ]
        }
      }'
```

---

## 30. Personal customization — saved views, columns, terminology, theme

Customization is a **two-store cascade**: **ORG defaults** on
`Preferences.customization` (admin-only) ← **personal** overrides in a per-user
`UserPrefsStore` (keyed by username when auth is on, a shared `default` bucket when
auth is off — so even the no-auth profile gets real, persisted personal prefs). The
webui hydrates `GET /api/prefs/effective` once on mount and merges the two. Most
of this lives under **Settings → Account → Appearance & customization**.

### Saved views

A **saved view** is a named filter/sort/column preset for a scope (e.g. `cases`). The
**Saved-views bar** above a list lets you create from the current filters, switch,
clone, pin, and delete. Org-shared views (`shared:true`, curated by an admin under
`prefs/org`) show up alongside your personal ones; cloning copies any view into your
own set as a fresh, owned, non-shared `… (copy)`.

| Action | Endpoint |
|---|---|
| List my views (personal + org-shared) | `GET /api/views` |
| Create a personal view | `POST /api/views` (`{name, scope, filters, sort, columns?, shared?}`) |
| Edit a personal view (partial) | `PUT /api/views/{view_id}` |
| Delete a personal view | `DELETE /api/views/{view_id}` |
| Clone any view into my set | `POST /api/views/{view_id}/clone` |

### Table columns

Each table persists its own **column state** (order / hidden / widths) per user via
`PUT /api/prefs/user/tables/{table_id}` with `{order, hidden, widths}`. Send an
**all-empty body** to clear the override and revert to that table's default columns.
Theme mode, pinned view ids, and last-list-state live on your personal bucket via
`GET/PUT /api/prefs/user` (a partial patch — only the fields you send change):
the compact **System / Light / Dark** segmented control writes `theme_mode` as
`system` | `light` | `dark` and overrides the org `default_theme`. System follows
the organization default when one is set, otherwise the device preference.

### Terminology

Admins can rename suite nouns org-wide via `GET/PUT /api/terminology` (the map, e.g.
`{"case":"incident","cases":"incidents"}`) or the broader
`GET /api/prefs/org` / `PUT /api/prefs/org` (`CustomizationConfig`: `terminology`,
`default_saved_views`, `default_theme`). The UI renders every label through a
`t(key)` helper; all terminology and view text is **plain data**, never markup and
never an LLM-prompt input (#9). Writes to `prefs/org` + `terminology` are admin-gated
and audited; reads are open to any signed-in user (the cascade needs them).

```bash
curl -s -b cookies.txt localhost:8088/api/prefs/effective       # merged ORG ← USER
curl -s -b cookies.txt -X PUT localhost:8088/api/prefs/user \
  -H 'content-type: application/json' -d '{"theme_mode":"dark"}'
curl -s -b cookies.txt -X POST localhost:8088/api/views \
  -H 'content-type: application/json' \
  -d '{"name":"My escalations","scope":"cases","filters":{"status":"escalated"},"sort":"-created_at"}'
curl -s -b cookies.txt -X PUT localhost:8088/api/prefs/user/tables/cases \
  -H 'content-type: application/json' \
  -d '{"order":["entity","risk","status","created_at"],"hidden":["source_name"],"widths":{}}'
curl -s -b cookies.txt -X PUT localhost:8088/api/terminology \
  -H 'content-type: application/json' -d '{"terminology":{"case":"incident","cases":"incidents"}}'
```

---

## 31. Command palette, global search, bulk actions & the audit viewer

### Cmd-K palette + global search

Press **⌘K / Ctrl-K** anywhere to open the command palette. It calls
`GET /api/search?q=&limit=20` and returns typed hits so you can jump anywhere:

- **cases** — matched on `case_id` / `case_number` / `title` / entity value / `tags`
  / `source_name` (works in Demo Mode too — it reads the active case store).
- **sources** — matched on name / type / id.
- **nav** — static page + settings-section targets, so the palette can navigate the
  whole app (including a jump straight to one settings section or card, §25).

The endpoint is bounded (`limit` hard-capped) and degrades gracefully (a case-listing
failure just yields no case hits). All matched text is operator/log data rendered as
**plain** (#9).

```bash
curl -s "localhost:8088/api/search?q=10.10.1.152&limit=20"
# -> { "query":"...", "cases":[...], "sources":[...], "nav":[...] }
```

### Bulk case actions

Select multiple rows in the Cases table and apply **one** lifecycle action to all of
them via `POST /api/cases/bulk` with `{ "ids": [...], "action": "...", ...the same
optional CaseAction fields }`. Each id runs through the **exact** single-case human
action path (`_perform_case_action`) — it is **#3-safe** (the analyst layer, never
`decide()` / auto-close), RBAC is enforced once up front (`cases:close` for
close-class moves, else `cases:write`), and each case is **applied + audited
individually**. It is partial-failure tolerant (max 500 ids; a bad id or illegal
transition fails only that row):

```bash
curl -s -b cookies.txt -X POST localhost:8088/api/cases/bulk \
  -H 'content-type: application/json' \
  -d '{"ids":["case-a","case-b","case-c"],"action":"escalate","analyst":"alice"}'
# -> { "results":[ {"id":"case-a","ok":true}, {"id":"case-b","ok":false,"error":"..."}, ... ] }
```

This direct API/table workflow is distinct from the newer Case Manager toolbar. Case
Manager submits `case_lifecycle`, `case_assign`, `case_tag`, or
`case_reinvestigate` through `POST /api/jobs` with an immutable selected-ID snapshot;
it does not run a browser-owned per-case loop. Its dialog closes after admission and
the durable Jobs/Inbox surfaces own progress and partial failure reporting. See the
[Case Manager guide](analyst/case-manager.md) for its exact current selection and
background-job contract.

### Audit viewer

The **Audit log** is a standalone top-level **Platform** nav page (`GET
/api/audit`) — a bounded, read-only view of the append-only audit log (#2). It is
gated on `audit:view` (the auditor/admin grant) and filterable; rows are
**newest-first**, hard-capped (≤500), and all text is rendered as plain (#9 —
audit rows carry fenced UNTRUSTED log excerpts).

```bash
curl -s -b cookies.txt "localhost:8088/api/audit?limit=100&actor=alice&action=DECISION&from=now-24h"
# filters: actor, action, surface, case_id, source_id (§33 coverage), from (alias), to, limit
curl -s -b cookies.txt "localhost:8088/api/audit?source_id=prod-es&limit=50"   # one source's audit history
```

---

## 32. Using the API directly (`curl`)

Every surface is backed by an HTTP route under `/api` — the base monolith
(`backend/app/api/routes.py`) plus 27 auto-discovered `routes_*.py` feature
routers (`main.py::discover_feature_routers()`; no manual registration needed).
You can drive them directly for ops/automation. Examples below hit the backend on
`localhost:8088` (the agnostic stack publishes it); through the web UI's nginx,
the same paths work under the SPA origin (e.g. `http://localhost:8080/api/...`).

```bash
# Health
curl -s localhost:8088/api/health
# -> {"status":"ok","version":"0.1.13","es_connected":true,"store_type":"...","setup_complete":true}
# NOTE: "store_type" is the log-surface ES CLIENT CLASS ("RealESClient" /
# "InMemoryESClient") — it never reports your STATE_BACKEND (elasticsearch /
# postgres / sqlite). "InMemoryESClient" with no pull source wired is expected,
# not a database outage (see docs/TROUBLESHOOTING.md).

# Setup status (configured booleans, entity mapping, es_connected)
curl -s localhost:8088/api/setup/status
```

### Connectors + sources

```bash
# List every available connector + its wizard field schema (auth/config)
curl -s localhost:8088/api/connectors
# One connector's manifest
curl -s localhost:8088/api/connectors/elasticsearch

# Create (or update) a source — a webhook push receiver, id "edr-webhook"
curl -s -X POST localhost:8088/api/sources \
  -H 'content-type: application/json' \
  -d '{
        "id": "edr-webhook",
        "source_type": "webhook",
        "display_name": "EDR webhook",
        "ingest_mode": "push_http",
        "is_primary": false,
        "config": { "auth_mode": "bearer", "path": "/webhook", "format_hint": "auto" }
      }'

# Set a per-source secret (the bearer token) — secret tier, never persisted
curl -s -X POST localhost:8088/api/sources/edr-webhook/secrets \
  -H 'content-type: application/json' \
  -d '{ "token": "s3cr3t-webhook-token" }'

# Test connectivity (tests the live primary log source)
curl -s -X POST localhost:8088/api/connectors/test \
  -H 'content-type: application/json' -d '{}'

# List configured sources + their health
curl -s localhost:8088/api/sources
curl -s localhost:8088/api/sources/health
curl -s localhost:8088/api/sources/coverage   # rollup: silent sources, events/min, worst last-event age (§33)

# Browse a source's recent logs (pull=bounded scoped search ≤200; push=live-tail buffer)
curl -s "localhost:8088/api/sources/prod-es/logs?limit=50&query=ssh&from=now-15m&to=now"
# -> { "source_id": "prod-es", "mode": "search", "count": 50, "total": 1234,
#      "limit": 50, "truncated": true, "query": "...",
#      "logs": [{ "ts": "...", "source_ip": "...", "user": "...", "host": "...",
#                 "rule": "...", "severity": "...", "message": "...", "_raw": { ... } }] }
# 404 unknown source · 501 browse-unsupported connector · 502 read failure
# `limit`/`truncated` = the bound (most recent N, NO pagination); `mode` = a real
# filtered search (from/to/query apply) vs a live-tail buffer that IGNORES them.
# `truncated` is exact when the connector reports a total (`total > count`), and falls
# back to "the page saturated" only when no total exists: total==count==limit is
# COMPLETE, not "more exist".

# Which sources can be browsed at all (server-authoritative, same predicate)
curl -s localhost:8088/api/sources | jq '.sources[] | {id, can_browse}'

# Browse across EVERY enabled, browse-capable source at once
curl -s "localhost:8088/api/logs?limit=50&query=ssh&from=now-15m&to=now"
# -> { "logs": [...], "count": 50, "partial": false, "limit": 50, "truncated": true,
#      "sources": [{ "source_id": "...", "source_name": "...", "ok": true,
#                    "count": 25, "mode": "search", "truncated": true }] }
# Envelope `truncated` = the merge was cut OR any single source was cut, so a
# one-source read agrees with GET /api/sources/{id}/logs on the identical data.

# ...or scope the same fan-out to ONE source (404 unknown · 501 not browsable)
curl -s "localhost:8088/api/logs?limit=50&source_id=prod-es"

# Delete a source
curl -s -X DELETE localhost:8088/api/sources/edr-webhook
```

A pull source (Elasticsearch) follows the same shape; its secret is the read-only
key:

```bash
curl -s -X POST localhost:8088/api/sources \
  -H 'content-type: application/json' \
  -d '{
        "id": "prod-es",
        "source_type": "elasticsearch",
        "is_primary": true,
        "config": {
          "es_url": "https://elasticsearch:9200",
          "data_view_pattern": "all-logs-*",
          "time_field": "@timestamp",
          "source_ip_field": "source.ip",
          "user_field": "user.name",
          "host_field": "host.name",
          "rule_field": "event.module"
        }
      }'
curl -s -X POST localhost:8088/api/sources/prod-es/secrets \
  -H 'content-type: application/json' -d '{ "es_api_key": "<encoded-read-only-key>" }'
```

### Push an alert to a webhook source

The receiver verifies auth (here bearer), parses + normalises to OCSF, and the
events flow into the same correlate → case pipeline:

```bash
curl -s -X POST localhost:8088/api/ingest/edr-webhook \
  -H 'authorization: Bearer s3cr3t-webhook-token' \
  -H 'content-type: application/json' \
  -d '{ "source.ip": "10.10.1.152", "user.name": "alice", "event.module": "sshd",
        "event.severity": 7, "message": "Failed password for alice" }'
# -> {"ok":true,"received":1,"clusters":...,"investigated":...,"candidates":...}
# A bad/missing token returns 401.
```

### Cases / analytics

```bash
# List cases (filterable: status, surface, entity, limit, offset)
curl -s "localhost:8088/api/cases?limit=20&status=needs_human"
curl -s localhost:8088/api/cases/case-abc123                       # one case
curl -s localhost:8088/api/cases/case-abc123/trace                 # agent trace
curl -s localhost:8088/api/cases/case-abc123/rationale             # the deterministic decision + reasoning + knowledge + commands + memory
curl -s localhost:8088/api/cases/case-abc123/stages                # the 6-stage "what happened" timeline

# Analyst lifecycle actions (close/confirm_fp/resolve/reopen/escalate/deescalate/
# hold/resume/set_status/set_disposition/acknowledge); illegal moves -> 400
curl -s -X POST localhost:8088/api/cases/case-abc123/action \
  -H 'content-type: application/json' \
  -d '{"action":"escalate","note":"paging on-call","analyst":"alice"}'
curl -s -X POST localhost:8088/api/cases/case-abc123/action \
  -H 'content-type: application/json' \
  -d '{"action":"set_disposition","disposition":"true_positive","analyst":"alice"}'

# Re-investigate a stored case in place (rebuilds from stored evidence if the log
# window has aged out; NEUTRAL 400 only when neither path is usable)
curl -s -X POST localhost:8088/api/cases/case-abc123/investigate

# Run a playbook on a case (context-only re-investigation; #3-safe)
curl -s -X POST localhost:8088/api/cases/case-abc123/run-playbook \
  -H 'content-type: application/json' \
  -d '{"playbook_id":"brute-force-login","analyst":"alice"}'

# Browse/open playbooks (playbooks:read)
curl -s localhost:8088/api/playbooks
curl -s localhost:8088/api/playbooks/brute_force_login

# Create/update operator Markdown (playbooks:manage). Bundled ids return 403 on PUT.
curl -s -X POST localhost:8088/api/playbooks \
  -H 'content-type: application/json' \
  -d '{"id":"credential_response","content":"---\nid: credential_response\nname: Credential response\nversion: 1\n---\n## Procedure\n1. Validate the signal.\n"}'
curl -s -X PUT localhost:8088/api/playbooks/credential_response \
  -H 'content-type: application/json' \
  -d '{"content":"---\nid: credential_response\nname: Credential response\nversion: 2\n---\n## Procedure\n1. Validate and contain.\n","expected_revision":1}'

# Exact-match diagnostics and bounded stored-case coverage (playbooks:read)
curl -s -X POST localhost:8088/api/playbooks/dry-run \
  -H 'content-type: application/json' \
  -d '{"rule_ids":["sshd"],"entity_type":"ip","event_count":12}'
curl -s localhost:8088/api/playbooks/coverage

# Threat context for a case (IOC reputation + MITRE + related cases; fail-open)
curl -s localhost:8088/api/cases/case-abc123/threat-context

# The campaign a case belongs to (or null)
curl -s localhost:8088/api/cases/case-abc123/campaign

# The case thread + tasks (collaboration, §18)
curl -s localhost:8088/api/cases/case-abc123/thread
curl -s localhost:8088/api/cases/case-abc123/tasks

# Investigate an entity (optional "lookback" overrides; auto-widens on 0 hits)
curl -s -X POST localhost:8088/api/investigate \
  -H 'content-type: application/json' \
  -d '{"entity":{"type":"ip","value":"10.10.1.152"},"source_surface":"investigate"}'

# Chat (add "case_id" / "context" for follow-ups; add a real queryable
# "source_id" to scope strictly instead of using Primary)
curl -s -X POST localhost:8088/api/chat \
  -H 'content-type: application/json' \
  -d '{"message":"list all logs from 10.10.1.152 today","history":[],"persist_conversation":true,"idempotency_key":"chat-turn-20260727-0001"}'

# Per-user Workspace history (newest first); open, rename, or delete one saved chat
curl -s 'localhost:8088/api/chat/conversations?limit=50&offset=0'
curl -s localhost:8088/api/chat/conversations/chat-example
curl -s -X PATCH localhost:8088/api/chat/conversations/chat-example \
  -H 'content-type: application/json' -d '{"title":"Failed-login review"}'
curl -s -X DELETE localhost:8088/api/chat/conversations/chat-example

# Per-log AI overview
curl -s -X POST localhost:8088/api/overview \
  -H 'content-type: application/json' \
  -d '{"source":{"source.ip":"10.10.1.152","user.name":"alice","event.module":"sshd"}}'

# Model catalog + providers for the per-role pickers
curl -s localhost:8088/api/llm/models
curl -s localhost:8088/api/llm/providers

# Knowledge base (RAG): stats, browse, deprecated direct import, test-retrieve, delete
# (Console import uses a durable rag_import Job; seeds need force)
curl -s localhost:8088/api/rag/stats
curl -s localhost:8088/api/rag/documents
curl -s localhost:8088/api/rag/documents/doc-abc123                 # one document's chunks
curl -s "localhost:8088/api/rag/search?q=ssh%20brute%20force&top_k=5"   # live retrieval — see what RAG returns
curl -s -X POST localhost:8088/api/rag/import \
  -H 'content-type: application/json' \
  -d '{"title":"SSH brute-force runbook","text":"...","source":"runbook","tags":["ssh"]}'
curl -s -X DELETE "localhost:8088/api/rag/documents/doc-abc123"        # imported doc
curl -s -X DELETE "localhost:8088/api/rag/documents/seed:runbook?force=true"  # guarded seed needs force

# Agent memory (durable operator facts; source=human via REST)
curl -s localhost:8088/api/memory
curl -s -X POST localhost:8088/api/memory \
  -H 'content-type: application/json' \
  -d '{"text":"10.0.0.0/8 is our internal corporate range","category":"asset","tags":["network"]}'
curl -s -X PUT localhost:8088/api/memory/mem-abc123 \
  -H 'content-type: application/json' -d '{"active":false}'          # retire without deleting
curl -s -X DELETE localhost:8088/api/memory/mem-abc123

# Automated scans + badge
curl -s "localhost:8088/api/scans?limit=20"
curl -s "localhost:8088/api/scans/notifications?since=now-24h"

# Standup, aggregate agent-effectiveness evidence, and cost
curl -s "localhost:8088/api/standup/report?window_hours=24"
curl -s "localhost:8088/api/metrics/trends?window_hours=24"   # dashboard hover-trendline buckets (§0)
curl -s "localhost:8088/api/metrics/agent-improvement"
curl -s "localhost:8088/api/diagnostics/health?window_hours=24"
curl -s "localhost:8088/api/metrics/auto-close-health?window_hours=24"
curl -s "localhost:8088/api/usage/summary?window_hours=24"

# Detection & Rules (§14): CRUD + preview + version ledger
curl -s localhost:8088/api/rules
curl -s -X POST localhost:8088/api/triage/preview-decision \
  -H 'content-type: application/json' -d '{"kind":"detection","rule_name":"sshd"}'
curl -s localhost:8088/api/rules/detection/sshd/versions

# Campaigns, baseline, tuning, batch jobs (§15-17, §22)
curl -s localhost:8088/api/campaigns
curl -s localhost:8088/api/baseline/stats
curl -s localhost:8088/api/tuning/recommendations
curl -s localhost:8088/api/tuning/source-recommendations
curl -s localhost:8088/api/schedulers/health
curl -s localhost:8088/api/batch/jobs

# Self-scoped durable application jobs (§22)
curl -s -b cookies.txt "localhost:8088/api/jobs?limit=50&offset=0"
curl -s -b cookies.txt -X POST localhost:8088/api/jobs \
  -H 'content-type: application/json' \
  -d '{"kind":"case_tag","idempotency_key":"case-tag-one-intent-01","params":{"case_ids":["case-a","case-b"],"tag":"reviewed"}}'
curl -s -b cookies.txt localhost:8088/api/jobs/job-abc123
curl -s -b cookies.txt -X POST localhost:8088/api/jobs/job-abc123/cancel
curl -sS -b cookies.txt localhost:8088/api/jobs/job-abc123/artifact \
  --output job-artifact.zip  # only when result.artifact_id is non-empty

# Custom dashboards (§21)
curl -s localhost:8088/api/dashboards
curl -s localhost:8088/api/dashboards/widget-types

# MITRE coverage + ATT&CK Navigator layer export (§20)
curl -s localhost:8088/api/mitre/coverage
curl -s localhost:8088/api/mitre/coverage/navigator.layer.json -o navigator-layer.json

# Enrichment providers (§19)
curl -s localhost:8088/api/enrichment/providers
curl -s "localhost:8088/api/enrichment/lookup?indicator=10.10.1.152"

# Budget gate + cost estimate (§22)
curl -s localhost:8088/api/budget/status
curl -s -X POST localhost:8088/api/cost/estimate \
  -H 'content-type: application/json' -d '{"model":"gpt-5.6-luna","prompt":"...","max_tokens":1000}'

# Settings get / patch (+ section / schema / case-id preview)
curl -s localhost:8088/api/settings
curl -s localhost:8088/api/settings/schema
curl -s localhost:8088/api/settings/notifications        # one section
curl -s -X PUT localhost:8088/api/settings \
  -H 'content-type: application/json' \
  -d '{"background_scan_enabled":true,"auto_forward_allowlist":["sshd","suricata"]}'
curl -s -X POST localhost:8088/api/settings/case-id/preview \
  -H 'content-type: application/json' \
  -d '{"template":"CASE-{year}-{seq:06d}","count":3}'

# Manual poll (pull sources)
curl -s -X POST localhost:8088/api/poll
```

### Auth, users + RBAC (only when TLSOC_AUTH_ENABLED=true)

```bash
# Login (returns {requires_mfa, pending_token} when the user has MFA — plus
# mfa_enrollment_required:true when MFA is mandated but not yet enrolled (§24); else {token, user})
curl -s -X POST localhost:8088/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"Admin","password":"Admin@123"}'
# Forced on the seeded admin's first login:
curl -s -X POST localhost:8088/api/auth/change-password \
  -H 'content-type: application/json' \
  -d '{"current_password":"Admin@123","new_password":"<strong-new>"}'
curl -s localhost:8088/api/auth/me                 # current user + role + must_change_password
curl -s localhost:8088/api/roles                   # built-in role -> permission matrix

# One-shot OOBE bootstrap (only while auth is on, setup incomplete, no user exists yet)
curl -s -X POST localhost:8088/api/setup/account \
  -H 'content-type: application/json' \
  -d '{"username":"alice","password":"a-strong-unique-password","display_name":"Alice Ng"}'

# Users (super_admin)
curl -s localhost:8088/api/users
curl -s -X POST localhost:8088/api/users \
  -H 'content-type: application/json' \
  -d '{"username":"alice","password":"<temp>","role":"analyst_tier2"}'
curl -s -X PUT localhost:8088/api/users/alice \
  -H 'content-type: application/json' -d '{"role":"soc_manager","active":true}'
curl -s -X DELETE localhost:8088/api/users/alice

# Custom roles (§24)
curl -s -X POST localhost:8088/api/roles \
  -H 'content-type: application/json' \
  -d '{"name":"tier1_plus","inherits":["analyst_tier1"],"grants":{"cases":["close"]}}'
curl -s "localhost:8088/api/roles/simulate?role=tier1_plus&resource=cases&action=close"

# MFA enrolment (self): setup -> scan the otpauth_uri QR -> confirm
curl -s -X POST localhost:8088/api/auth/mfa/setup     # -> {secret, otpauth_uri, recovery_codes}
curl -s -X POST localhost:8088/api/auth/mfa/confirm -H 'content-type: application/json' -d '{"code":"123456"}'
# Login phase 2: exchange the pending_token + a TOTP (or recovery) code for a session
curl -s -X POST localhost:8088/api/auth/mfa/verify  -H 'content-type: application/json' -d '{"pending_token":"...","code":"123456"}'
# Admin-mandated enrolment DURING login (§24; pending-token-gated, confirm mints the session)
curl -s -X POST localhost:8088/api/auth/mfa/enroll-setup   -H 'content-type: application/json' -d '{"pending_token":"..."}'
curl -s -X POST localhost:8088/api/auth/mfa/enroll-confirm -H 'content-type: application/json' -d '{"pending_token":"...","code":"123456"}'

# SSO (OIDC)
curl -s localhost:8088/api/auth/sso/providers
curl -s "localhost:8088/api/auth/sso/authorize?provider=google"
```

### Notifications

```bash
curl -s localhost:8088/api/notifications/providers        # email presets + channel types
curl -s -X POST localhost:8088/api/notifications/test \
  -H 'content-type: application/json' -d '{"channel_id":"email-1"}'   # send a sample to one configured channel
curl -s -X POST localhost:8088/api/notifications/channels/slack-1/secret \
  -H 'content-type: application/json' -d '{"field":"webhook_url","value":"https://hooks.slack.com/..."}'
curl -s -X POST localhost:8088/api/cases/case-abc123/notify \
  -H 'content-type: application/json' -d '{"channel_id":"slack-1"}'
curl -s -b cookies.txt localhost:8088/api/notifications/inbox
```

---

## 33. Autopilot — smart defaults, governed tuning, and coverage

**Round 10** flipped the suite's out-of-the-box posture: instead of waiting for an
operator to opt every source and every detection knob in, the suite now **reads and
reasons over everything by default**, and the $0/#3-safe advisory engines that used
to ship OFF now ship ON. Nothing here changes non-negotiable #3 — the close/escalate
decision is still `case_manager.decide()` and only `decide()`; everything below is
routing, cost-governance, or presentation.

### Comprehensive ingestion — every event, risk-scored, never dropped

`background_scan_enabled` now defaults **`true`** (§6, §25): every correlated cluster
from every source is risk-scored (0–100) and made visible, whether or not it is
auto-forwarded to the configured investigator role.

- **`alerts`-role feeds** (§29 — SIEM-generated detections) bypass the gate entirely
  and correlate in **`EVERY`** mode: every alert becomes exactly one case
  (same-signature bursts still coalesce onto one open case, #4).
- **`events`-role feeds** auto-forward through a **deterministic risk gate**:
  `risk_score >= auto_investigate_risk_floor` (default **70** — the cross-vendor
  "High" severity-band floor). Below-floor clusters stay **`$0` OPEN candidates** —
  risk-scored and visible in Cases, never dropped (#4). The `auto_forward_allowlist`
  (§25) still works exactly as before and forwards a listed rule regardless of risk.
- A **shared per-poll-tick cap** (`caps.max_auto_investigations_per_tick`, default
  **25**) bounds how many clusters the entire concurrent source fan-out can forward
  to the investigator role in one manager tick. A concurrency-safe budget prevents several
  busy sources from each consuming the full allowance. Cap-deferred candidates
  **drain** on a later tick once headroom frees, and investigations run sequentially
  so provider load stays predictable. Direct push-ingest uses the same configured
  gate for its own request. The **daily USD budget is the one GLOBAL bound** across
  every source — the per-tick cap only smooths *when* spend happens, not the ceiling.

### The autopilot dial

`autopilot_profile` (**Settings → Organization → Advanced**, `conservative` |
**`balanced`** (default) | `aggressive`) moves the three knobs above together:

| Profile | Risk floor | Daily budget | Per-tick cap |
|---|---|---|---|
| `conservative` | 90 | $5 | 10 |
| `balanced` (default) | 70 | $10 | 25 |
| `aggressive` | 40 | $50 | 100 |

Applying a profile only writes `auto_investigate_risk_floor` / `budget.daily_usd` /
`caps.max_auto_investigations_per_tick` — it is a pure config-writer and never
touches `decide()`. (The floors track cross-vendor entity-risk banding — 70 ≈ the
"High" band start, 90 ≈ "Critical", 40 ≈ "Medium"; $10/day is roughly a coffee
budget, an order of magnitude below a typical AI-SOC entry price.)

### The default budget backstop

`BudgetConfig` (§22) now defaults **`enabled: true`, `daily_usd: 10`,
`soft_warn_pct: 0.8`, `on_exceed: "block"`** — the backstop that keeps "read
everything by default" from turning into "spend everything." Crossing the ceiling
stops the provider call before it is made; an operator can explicitly select
warning-only mode. A budget-blocked investigation fails safe to `NEEDS_HUMAN`
(#3/#4) — never a silent drop or close.

### What's ON by default now, and what's still opt-in

**Default ON (Round 10):** background scan (above), the deterministic risk gate,
the budget backstop, the **adaptive threshold observer** (§15, with `shadow_eval`
**forced on** even for a migrated tenant but preference writes review-first unless
`auto_apply_confirmed` is explicitly enabled), **campaigns** (§16), **cross-source
correlation** (§13), the **SLA policy** and **priority matrix** (advisory
badges/reporting), **realtime SSE** (the live-update plumbing behind §0's app
shell), the **threshold-automation engine** (§14 — the engine runs, but ships with
an empty `rules: []`, so it is a byte-identical no-op until an operator adds a
rule), and **entity baseline** (§17) as a pure statistical producer—it accumulates from day one
(the warm-up gauge + a silent-source/volume-flood detector) but still never
triggers an investigation by itself.

**Still opt-in:** the asynchronous Batch queue (§22), any `run_playbook` / `notify`
action on a case-automation rule (§14), and baseline-driven auto-investigation —
baseline stays advisory-only (#3/#4). The separate compatible OpenAI live Flex
preference is on by default and falls back truthfully to standard service when
configured to do so.

### Migration — an announcement, not a silent flip

A `Preferences` document **persisted before this round** auto-adopts the new ON
defaults **exactly once** (an internal `autopilot_config_version` marker) and sets
`show_autopilot_banner: true`, so the change is surfaced, not silent: the
`AutomationNudge` card on Overview — previously a "turn this on" prompt — is
**inverted** into an "autopilot is ON — here's what it's doing, and how to turn it
off" reassurance card. Any explicit opt-out an operator saved *after* the marker is
preserved byte-for-byte — the migration never re-overwrites a deliberate choice. A
**fresh install** simply starts at the new defaults with no banner at all.

### Coverage observability — "am I seeing everything?"

Reading everything only matters if you can tell it's actually happening:

- **`GET /api/sources/health`** (§2) gained additive per-source fields:
  `last_poll_at` / `last_poll_ok` / `last_poll_error`, `events_per_min`, and a
  `silent` flag — a multi-feed source whose feeds **all** raise now correctly
  reports `last_poll_ok: false` instead of merely looking quiet.
- **`GET /api/sources/coverage`** (new) rolls those rows up into one answer:
  `{sources_total, sources_enabled, sources_silent, events_per_min,
  alerts_triaged_24h, worst_last_event_seconds}`.
- The webui surfaces this as a **coverage banner** atop **Sources** (§2 — honest,
  server-truth per-row status straight from `/health`, no more guessing) and a
  **coverage tile** on **Overview**.
- The **Noise-Reduction funnel** (Overview) gained an honest **"awaiting /
  candidate"** stage, so a below-floor `events`-role cluster shows up as exactly
  what it is — scored and waiting, not silently discarded.
- **`AuditDoc.source_id`** is now recorded on every audited action, so
  **`GET /api/audit?source_id=<id>`** (§31) narrows the append-only log to one
  source's history — useful for confirming a specific connector is actually
  polling.

All of this is read-only and advisory: nothing in this section can set a case's
status, verdict, or disposition, and none of it ever calls `decide()`
(non-negotiable #3).

---

## 34. Safety guarantees you can rely on

These are enforced in **code**, not prompts (see `SECURITY.md`):

- **The close/escalate decision is deterministic code**, never raw LLM output.
  FALSE_POSITIVE auto-close is ON by default above a bar; TRUE_POSITIVE auto-close
  is a real, off-by-default opt-in; only NEEDS_HUMAN (or a missing verdict) is the
  code-enforced never-auto-close case.
- **Fail-safe routing.** Missing/unknown verdict, router unavailable, kill switch,
  budget-exceeded, or any pipeline exception → a `needs_human` case (an alert is
  never dropped).
- **Every LLM call is metered.** 100% of completions and embeddings pass the single
  gateway, which writes the usage/cost ledger (including `error` outcomes).
- **Every agent action is audited**, append-only, from the first prompt.
- **Read-only sources.** Every connector reads with a least-privilege, read-only
  credential; the agent's tools never write the source.
- **No duplicate cases (idempotent).** Cases are keyed by an entity-centric cluster
  signature; re-polling attaches new events to the open case.
- **Inbound push payloads are untrusted.** Push receivers verify auth and fence the
  normalised data as UNTRUSTED in prompts. Raw logs are never sent to a model in
  standup or the event-detection funnel.
- **Advisory surfaces never decide.** Threshold automation, tuning, campaigns,
  baseline anomaly detection, case collaboration (threads/tasks), and custom
  dashboards are all deliberately incapable of calling `decide()` or setting a
  case's status/verdict/disposition — they can only tag, recommend, notify, propose
  (HITL), or display.
