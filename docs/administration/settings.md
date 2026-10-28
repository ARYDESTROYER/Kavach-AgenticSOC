---
title: Settings administration
description: Configure Agentic SOC 0.1 safely, understand preference scope, and keep secrets out of persisted settings.
---

# Settings administration

Agentic SOC separates ordinary preferences from credentials. This distinction matters:
preferences are durable application state, while credentials belong to the secret
tier and are never returned to the browser.

## Who can change settings

When authentication and RBAC are enabled, `super_admin` and `soc_manager` have the
built-in ability to manage settings. Other built-in roles can read settings but
cannot change them. Custom roles can grant narrower management rights for models,
notifications, branding, enrichment, terminology, automation, and rules.

When authentication is disabled, route-level authorization is intentionally a
no-op. Enable authentication before exposing a deployment to other users or a
network you do not fully trust.

## Configuration layers

| Layer | Examples | Persistence |
|---|---|---|
| Environment | state database URL, JWT signing key, provider credentials | supplied by the deployment; never written by Agentic SOC |
| Organization preferences | sources, case policy, model routing, budgets, automation, branding | selected `StateStore` |
| User preferences | theme, saved views, table columns | selected `StateStore`, scoped by user |
| Runtime secret tier | source, SSO, and notification secrets entered through the UI | memory only; lost when the backend restarts |

The Settings UI is the preferred editing surface. The API exposes `GET /api/settings`,
`GET /api/settings/schema`, and `PUT /api/settings`; writes are validated as a complete
`Preferences` model. Do not send a stale full settings document from an external
script: another administrator may have changed a different section in the meantime.

The Console presents one searchable section rail, a single active-section heading,
and flat divider-led setting groups. Theme selection is a compact **System / Light /
Dark** control under **Settings → Account → Appearance & customization**. Personal theme changes
apply immediately and follow the signed-in user; System follows the organization
default when one is configured, otherwise the device preference.

On a narrow screen, the full section inventory moves into a searchable Sheet opened
from one compact section trigger; it is not stacked above the active form. Settings
URLs retain `#/settings?s=<id>&a=<anchor>`, so an authorized operator can bookmark a
section or a specific setting group. Modified sections show a dirty indicator, and
one sticky **Save changes / Discard** bar owns both buffered preference writes and
write-only secret drafts across the workspace. Saving keeps the narrow API contracts:
ordinary preferences are sent as a minimal top-level patch, then only non-blank
replacement secrets are sent to the dedicated secret endpoint. If the preference
write succeeds but a secret write fails, the saved preferences stay applied and the
secret draft remains visible and retryable. Immediate self-contained operations still
report their own result, but a section renderer must not create a second preference or
credential save path.

## Safe administration sequence

1. Back up the application state before a broad policy change.
2. Change one section at a time.
3. Use built-in preview or test actions where available.
4. Confirm the effective value after saving.
5. Inspect the audit trail and relevant health page.
6. Keep a rollback value for detection, automation, and model-routing changes.

Rules have their own version ledger and rollback controls. Threshold tuning also
keeps an application ledger. General preference documents do not provide universal
point-in-time rollback in version 0.1.

## High-impact areas

- **Sources and ingestion:** changing identifiers, feeds, field mappings, or source
  roles affects future collection. It does not rewrite closed cases.
- **Case policy:** the deterministic case manager remains the sole close/escalate
  authority. `NEEDS_HUMAN` can never auto-close; true-positive auto-close is off
  unless an operator explicitly enables it.
- **Autopilot and budget:** the balanced profile enables broad collection and a
  default daily LLM budget backstop. A budget block routes work to a human; it does
  not discard or silently close the case. Chat is outside this budget; its only
  spending bound is the optional daily chat spending limit (see
  [Chat assistant](#chat-assistant)), which is off by default.
- **Reset:** reset actions are separate, freshly authenticated, type-to-confirm
  operations. See [Reset and recovery](reset.md).

## Chat assistant

**Settings → General → Chat assistant** controls Workspace and Case Manager chat:

- **Question limits.** **Limits per question** comes first. **Unlimited** (the default)
  lets a question run until the assistant has answered or someone presses Stop, and
  never cuts an answer short; loop guards still stop a question that is going nowhere
  (the same lookup never runs twice, a question that stops making progress is asked to
  answer, a model call that goes silent is retried once, and a very long investigation
  wraps up with what it found). **Bounded** applies the per-question limits shown under
  it: model calls, lookups, the token ceiling, and the time limit, with the answer
  reserve, answer length, and results per step under **More limits**. Switching modes
  keeps the values you set, so switching back is lossless.
- **Spending.** **Daily chat spending limit** is off by default: the AI budget (daily
  and monthly) covers automatic investigations and never pauses chat, so this limit is
  chat's only spending bound, and there is no monthly chat limit. With a limit, chat stops
  starting model calls once its spending since 00:00 UTC reaches the amount, and the
  answer says so; 0 turns the limit off. Every chat call is still recorded in the cost
  ledger.
- **Answers.** One **Typed-out answers** control with three choices: **Off** (answers
  arrive whole, and the composer's **Type out answers** switch is disabled and says
  why), **Allowed (off by default)**, and **Allowed (on by default)** (answers appear
  word by word until a viewer turns it off). A viewer's own choice in the composer
  wins wherever typed-out answers are allowed. Then **Animate the logo while chat
  works**: a thin ring turns around the logo while an answer is being written. A custom
  logo itself never moves, and the Chat item in the navigation keeps its own indicator
  either way.
- **Suggestions.** **Suggest questions from live data** (on by default): "New chats open
  with questions about your queue, SLA and sources, computed from data each viewer can
  read. No AI cost." Each viewer sees only cards their own permissions allow, and a
  viewer can still turn the suggestions off for themselves in the composer's Options
  (see [Workspace Chat](../analyst/chat.md#turn-suggestions-off)). Turned off here, new
  chats offer only the everyday questions, with no catch-up line; Case Manager chat
  keeps its case questions, which name no data.
- **Timeouts and capacity** (in both modes): how many lookups run side by side in one
  step (12 by default; in Bounded mode never more than the per-question lookup limit,
  so 10 with the default limit), how long one lookup may take (45 seconds), how long a
  model call may go silent before it is retried (900 seconds, fifteen minutes, by
  default), and how many questions may run at once per user (12) and in total on this
  backend (48). Over those bounds a question waits and starts by itself. Higher values
  run more lookups and questions at once; on small model plans this can reach the
  provider's per-minute limits, and Agentic SOC retries those calls. After an upgrade
  from the previous build, each of these values that still equals its earlier default
  (4 lookups at once, a 15-second lookup timeout, a 300-second model call timeout, 4
  questions per user and 16 in total) moves to the new default once; a value you
  changed to anything else stays as you set it. A value you chose that happens to equal
  an earlier default cannot be told apart from it, so it moves too; set it again after
  the upgrade.
- **Indicator lookups:** how many indicators chat may send to enrichment providers per
  question and per conversation (0 turns the lookup off, and chat's access list then
  says it is turned off on this deployment), internal domain suffixes that are never
  sent, and whether e-mail addresses may be sent.

The editor accepts only values inside each knob's range, and the server clamps anything
else, so a bad value can never reset other preferences. No setting here can let chat
change anything: the assistant is read-only by construction. The keys are listed in the
[configuration reference](../reference/configuration.md#chat-assistant-bounds).

**Upgrading from an earlier build.** The first time a stored configuration is read, it
moves to **Unlimited** unless an administrator had changed a per-question limit from
its shipped value; then it stays **Bounded** with those values. Values that still hold
the shipped default of the build that saved them move to today's defaults (see
**Timeouts and capacity** above). A configuration from an older build, with a 30-second
model call timeout and 2 questions per user and 8 in total, first takes 300 seconds
(Unlimited only), 4 and 16, and then the current 900 seconds, 12 and 48; a Bounded
configuration keeps its 30 seconds. Values an administrator had chosen are kept, even
when one equals a later default. Each move happens once and is never repeated.

## Updates and release channels

Open **Settings → Organization → Updates & releases** to manage the public source
repository used for release observations. Fresh installations point to the Agentic
SOC repository, Stable `main`, Testing `Testing`, and a six-hour cache. Forks can save
a renamed repository or different branch refs; only canonical public GitHub URLs and
bounded branch names are accepted.

The observation cards show each channel's root `VERSION`, branch-head commit, check
time, and any typed unavailable/stale condition. Stable discovery also requires the
exact annotated `vVERSION` tag and records its immutable commit for an update candidate;
branch HEAD remains observation-only. **Check now** is available only for
the server-saved configuration, so an unsaved repository edit can never be checked as
though it were durable. If GitHub is unavailable, the rest of Settings remains usable
and a previous verified result may be shown as **Last verified**.

The channel cards themselves remain read-only observations. An amber source notice is
only a review link and changing the saved repository never grants deployment authority.

For the reference standalone Compose/PostgreSQL profile, a separately bootstrapped
private supervisor adds a guarded **Update to vX.Y.Z** action beside the version badge.
Only the built-in super-administrator can preflight or start it after recent
reauthentication. The confirmation names the exact Stable release, application
components, planned PostgreSQL backup, unchanged infrastructure, and rollback
coverage. The job later checksum- and catalog-verifies that backup before switching
either application service. Progress is host-durable across a backend/Web reconnect.
The updater never replaces the base Compose file. Its restartable, idempotent
self-replacement helper resumes or restores the exact prior supervisor after ordinary
helper-process, Docker-daemon, and host restarts. Loss of the trusted host or Docker
metadata/storage remains manual recovery. Unsupported
state backends, runtime-only secrets, unknown build identity, custom deployment
topologies, missing supervisor, and migration-bearing releases remain manual with a
specific blocker. See [Upgrades](../operations/upgrades.md).

## Storage and retention

Open **Settings → Organization → Storage & retention** to review the desired
lifecycle for Agentic SOC's **own application state**. The default policy is:

| Stage | Desired age | Current meaning |
|---|---:|---|
| Hot | First 180 days | Immediately available operational state |
| Warm | Next 90 days, until day 270 | Lower-cost native tier where the selected state backend can enforce it |
| Archive | From day 270 | Desired AWS S3 Glacier Flexible Retrieval target; not an active archive until an independent export/restore path is configured |

Deletion is always disabled. Saving this preference records the desired policy; it
does not prove that bytes moved. Use **Preview** to inspect capabilities and exact
targets, then **Apply supported lifecycle** to make the native changes. Apply is an
explicit, freshly authenticated, audited operation.

Apply submits a `storage_lifecycle_apply` background job with an exact snapshot of
the persisted policy. The worker compares that snapshot with the authoritative saved
policy before applying it and fails rather than acting on drifted settings. After
`202 Accepted`, progress remains in **Analytics → Jobs** and **Inbox**; leaving Settings
does not stop it. Cancellation is cooperative and cannot undo a native lifecycle
change already committed. The retired direct `POST /api/storage/lifecycle/apply`
mutation returns `410 Gone` with `durable_job_required`; GET, PUT, and Preview remain
direct operations.

Enforcement is intentionally capability-aware:

- **Elasticsearch state:** Agentic SOC can install ILM only for the append-only
  audit and usage/cost ledgers. The management key needs cluster `manage_ilm`,
  `manage_index_templates`, and `monitor`, the owned-index privileges documented in the deployment guide, and
  usable hot and warm data tiers. Mutable cases plus configuration, cursors, users,
  sessions, collaboration, and other live metadata remain hot.
- **PostgreSQL state:** the Console records and previews the desired policy, but it
  is advisory until an operator provides timestamp partitioning plus a managed
  scheduler/tablespace or archive workflow.
- **SQLite state:** row-level tiering is unavailable because the state is one file;
  use a controlled whole-database backup/export workflow.
- **Connected SIEM and log sources:** retention is external and read-only. This
  setting never changes a source index, bucket, stream, or vendor policy.

Glacier is deliberately not wired to Elasticsearch snapshots. A supported archive
requires an independent immutable export, manifest, checksum verification, and a
tested restore path. **Never apply an S3 lifecycle transition to an Elasticsearch
snapshot-repository prefix**: moving repository objects to Glacier can make the
repository unreadable to Elasticsearch. Until that independent archive pipeline
exists, warm data remains retained and the Console reports Archive as not configured.

## Export portable application state

Open **Settings → Organization → Data export** when support or offline analysis
needs all records from selected supported safe scopes. Select cases, audit, usage,
configuration, automation, and/or knowledge. Both the normal archive and the advanced
segment strategy now submit a server-owned job. The server walks every selected scope,
assembles one UTC-stamped ZIP, verifies it, and exposes **Download** only when the
terminal result carries a retained `artifact_id`.

Archive mode writes one newline-delimited JSON entry per selected scope and a terminal
`manifest.json` with counts, completion and consistency evidence, actor, and build
provenance. The advanced strategy uses bounded cursor pages internally, but the server
follows them and packages their numbered JSON envelopes into one ZIP; the browser no
longer has to remain open and collect a sequence of files. **Records per file** (up to
5,000) remains an internal segment-size control, not a full-history ceiling.

After `202 Accepted`, close the dialog or navigate away. Progress, cancellation,
partial/failure counts, and the final artifact remain in **Analytics → Jobs** and
**Inbox**. Cancellation is cooperative: it releases work at a safe checkpoint and does
not undo server work already performed. A cancelled or otherwise incomplete export
exposes no artifact. The executable direct archive/segment APIs are explicitly
OpenAPI-deprecated compatibility primitives with their synchronous/request-bound and
cursor limits; the cursor-cancel cleanup remains available. None is the Console
workflow.

The Knowledge scope includes exact catalog counts, sanitized authoritative Markdown
for operator-owned runbooks and playbooks, and metadata-only references/manifests for
bundled procedures. It excludes environment/source credentials, users and sessions,
password/MFA material, browser tokens, upstream raw logs, and raw knowledge chunks.
Each internal archive page and compact server segment is capped at 25 MiB; the complete
disk-backed ZIP is not a 25 MiB lifetime export. This is not an import format,
whole-application export, or backup/restore mechanism. Preparation and terminal outcome
are audited and require
`data_export:export` plus a fresh sign-in, granted by default to `super_admin` and
`soc_manager`. Exact point-in-time consistency is available on the bundled
Elasticsearch state path; PostgreSQL is explicitly `bounded_at_start` and other
backends disclose their weaker consistency. A segment cursor that
expires (ten-minute PIT keep-alive), crosses a backend restart, or is invalid must be
restarted for that scope.
Unavailable/malformed registry data, insufficient temporary space, an integrity failure,
or an unavailable append-only audit store fails the job; the Console never turns that
failure into a completed export. One archive assembly slot exists per backend process.

Artifacts live outside the StateStore. The supported Compose profiles persist
`/var/lib/agentic-soc/jobs` on a named volume; the local default is
`./data/job-artifacts`. Downloads re-check file size and SHA-256. Only the newest 50
attached artifacts are retained, so move important exports into an independently
controlled retention system. See [Background jobs](../operations/background-jobs.md).

## Secrets

Use environment variables for restart-safe credentials. A value entered into a
source, notification, enrichment, or SSO secret form is held in memory and represented
later only as a configured/not-configured state. Plan to re-enter those values after
a backend restart unless the deployment supplies them at boot.

In **Settings → Security & access → Secret keys**, replacement values participate in
the page-wide **Save changes / Discard** flow. Blank fields preserve existing values;
Discard clears only the local replacement drafts. A failed secret update never echoes
or erases the attempted value, so the operator can correct the problem and retry.

Continue with [Configuration reference](../operations/configuration.md),
[Background jobs](../operations/background-jobs.md), [Authentication](authentication.md),
and [Health, backup, and restore](../operations/health-backup.md).
