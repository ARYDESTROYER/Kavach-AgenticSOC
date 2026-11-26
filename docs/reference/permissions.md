---
title: Permissions
description: Built-in Agentic SOC roles, resource-action grants, authorization modes, and custom-role behavior in version 0.2.
---

# Permissions

Agentic SOC 0.2 authorizes actions with a `resource:action` vocabulary. Six built-in roles
ship with the Agentic SOC API. Organization administrators can add custom roles, inherit
from an existing role, grant narrow actions, and apply explicit denies.

## Authorization modes

Authentication and RBAC are independent switches:

| Authentication | RBAC | Effective behavior |
|---|---|---|
| Off | Either value | API authentication/permission gates are no-ops |
| On | Off | Every authenticated user is treated as `super_admin` |
| On | On | The built-in or custom effective permission matrix is enforced |

The default role is `analyst_tier1`. For shared use, enable both authentication and
RBAC; enabling authentication alone does not create role separation.

Authentication is turned on in the deployment environment (`AUTH_ENABLED`). RBAC is turned
on or off in **Settings → Security & access → Roles & permissions** (the **Role-based
access** group) or with `PUT /api/rbac`. Only an account whose stored role is
`super_admin` may change it, after a recent sign-in, whatever RBAC currently says, so the
"every account is `super_admin`" view while RBAC is off never grants it. `PUT
/api/settings` cannot change `rbac.enabled` (`409 rbac_switch_moved`), and changing any
other `rbac` field through it needs `roles:manage` and a fresh sign-in. See
[Turn on role-based access](../administration/users-rbac.md#turn-on-role-based-access).

## Built-in roles

| Role ID | Intended scope |
|---|---|
| `super_admin` | Platform owner; hard-allowed to prevent a malformed override from locking out the owner |
| `soc_manager` | Full operational and administrative management |
| `analyst_tier2` | Full case investigation and closure, with read access to administration |
| `analyst_tier1` | Case triage, assignment, comments, and read-only supporting context |
| `responder` | Tier-1 case access, working runbooks on cases, and proposal approval |
| `auditor` | Read/view-only product access, including the append-only audit log |

The names describe defaults, not organizational job titles. Notably, the built-in
`responder` does not receive `cases:close`; assign a custom role when that is required.

## Case and operational grants

`*` means every action defined for that resource. "None" means no default grant.

| Resource | Actions | `super_admin` | `soc_manager` | `analyst_tier2` | `analyst_tier1` | `responder` | `auditor` |
|---|---|---|---|---|---|---|---|
| `cases` | `read`, `write`, `close`, `assign`, `comment`, `reinvestigate` | `*` | `*` | all six | `read`, `write`, `assign`, `comment` | `read`, `write`, `assign`, `comment` | `read` |
| `sources` | `read`, `manage` | `*` | `*` | `read` | `read` | `read` | `read` |
| `users` | `manage` | `*` | `manage` | None | None | None | None |
| `proposals` | `read`, `approve` | `*` | `*` | `read` | `read` | `read`, `approve` | `read` |
| `runbooks` | `read`, `run`, `manage`, `publish` | `*` | `*` | `read`, `run` | `read`, `run` | `read`, `run` | `read` |
| `rag` | `read`, `manage` | `*` | `*` | `read` | `read` | `read` | `read` |
| `memory` | `read`, `manage` | `*` | `*` | `read` | `read` | `read` | `read` |
| `cost` | `view` | `*` | `view` | `view` | `view` | `view` | `view` |
| `metrics` | `view` | `*` | `view` | `view` | `view` | `view` | `view` |
| `audit` | `view`, `export` | `*` | `view`, `export` | None | None | None | `view`, `export` |
| `team` | `view` | `*` | `view` | None | None | None | `view` |
| `data_export` | `export` | `*` | `export` | None | None | None | None |
| `system_updates` | `read`, `apply`, `rollback` | `*` | `read` | None | None | None | None |

Installing or rolling back a system update is additionally limited by the API to the
built-in `super_admin` with a fresh sign-in, whatever a custom role grants.

`metrics:view` covers every metrics read, the operational rollup behind the Metrics page
(`GET /api/metrics`) and the analyst feedback agreement (`GET /api/feedback/stats`)
included. `cost:view` covers AI spend wherever it is shown: the Cost page and
`GET /api/usage/summary` (one case's spend included), the usage breakdown, the spend on
the Executive board, chat's spending answers, the spend part of `GET /api/metrics` (left
empty), the spent and remaining amounts of the AI budget (`GET /api/budget/status` keeps
the caps and settings for `models:read`), the cost and tokens on a case's agent timeline,
a case's own investigation cost (`token_cost` is `null` on every case the API returns,
and the case page, its case facts and Entity investigation leave it out), and the
recorded case cost in Agent effectiveness (shown as unavailable). Since 0.2 it also
covers a case's AI usage list (`GET /api/cases/{case_id}/usage`), the cost values in
**View all fields**, and the cost figures in the text of a case's timeout, decision,
runbook AI and budget rows, which read "hidden" (amounts "(amount hidden)") in the trace,
the timeline, the activity feed, the case rationale, chat answers about the case and the
Audit log list and record, and the figure in a budget refusal shown on a case.
Tool output and log evidence are never rewritten. A role without `cost:view` still
reads everything else on those pages.

## Runbooks

| Action | Allows |
|---|---|
| `runbooks:read` | Seeing the runbook library, a runbook's versions and history, and the runbooks on a case |
| `runbooks:run` | Working a case's runbook: attaching one, updating steps, recording decisions and actions, running lookups, asking the AI for a draft, and abandoning or switching a run |
| `runbooks:manage` | Writing drafts, duplicating, importing, sending for review, retiring, restoring a version as a draft, and rebuilding the runbook search index |
| `runbooks:publish` | Publishing a version, sending a version in review back to draft, restoring a retired runbook and marking a runbook reviewed |

Publishing is the only step that lets runbook text reach the investigator as trusted
guidance, which is why it is a grant of its own. When separate approval is on in the
Runbooks settings, nobody who wrote or edited a version may publish it, whatever their
grants. A lookup inside a runbook also needs the lookup's own grant (for example
`sources:read` for a log lookup); a viewer without it sees the step but not the result.
See [Runbooks](../intelligence/runbooks.md).

### Grants stored before Round 14

Earlier versions had a separate `playbooks` resource. A stored grant or deny that still
names it keeps working, in every layer (the role overrides, the additive resource layer,
the denies and every custom role), and is read as its `runbooks` meaning:

| Stored | Read as |
|---|---|
| `playbooks:read` | `runbooks:read` |
| `playbooks:run` | `runbooks:run` |
| `playbooks:manage` | `runbooks:manage` and `runbooks:publish` |
| `playbooks:*` | `runbooks:*` |
| a deny of `playbooks:manage` | a deny of `runbooks:manage` and `runbooks:publish` |

On the first load after the upgrade, a stored layer that granted `runbooks:manage` also
gains `runbooks:publish`, and a stored deny of `runbooks:manage` also denies
`runbooks:publish`, so no role silently loses the ability to make runbook text trusted and
none silently gains it. The map is then stamped (`rbac_grants_version: 2`), so an
administrator who later removes `runbooks:publish` keeps that choice. After that, a
`runbooks` entry is authoritative and a `playbooks` key kept beside it changes nothing.
The `playbooks` resource is no longer in the role editor or in
`GET /api/account/permissions`; `GET /api/roles/simulate` answers a question that names it
for its `runbooks` meaning and says so in `alias_of`.

## Team activity

`team:view` opens **Analytics → Team activity** and its API (`/api/team/*`): what each
person did per day, counted from the audit log. A SOC manager tracks the team and an
auditor may read it; analysts and responders do not get it by default. A stored role
override that names other resources keeps the default `team` grant.

While RBAC is off every signed-in account holds every grant, so Team activity adds a
floor of its own: only an account whose stored role is `super_admin`, `soc_manager` or
`auditor` can open it (`403 team_activity_role_required`, with an Access denied row,
for anyone else). That floor limits this page only and is not an access control: while
RBAC is off every account still holds `audit:view` and `users:manage`, so it can read the
same rows in the Audit log or change its own role (an audited `user.role_changed` row).
Turn RBAC on to keep per-person work private. The page never shows an IP address, user
agent, session or settings row; those stay in the audit log under `audit:view`. See
[Team activity](../analyst/team-activity.md).

## Screenshots and reviews on a case

| Action | Grant |
|---|---|
| List and view a case's screenshots | `cases:read` |
| Add a screenshot, or delete one you added | `cases:comment` |
| Delete a screenshot someone else added | `cases:comment` and `cases:close` |
| Record a review of a case the AI agent closed | `cases:write` |
| Reopen a case from that review | `cases:close` |
| See one case's review state | `cases:read` |
| The Review scope count in Case Manager | `cases:read` |
| The review module on Agent effectiveness | `metrics:view` |
| The Team activity switch and the review sample settings | `settings:manage` |

A refused screenshot delete writes an Access denied row. See
[Auto-close review](../automation/auto-close-review.md).

## Audit log

`audit:view` opens and searches the audit log. `audit:export` writes a CSV or JSON Lines
file of the rows the person can read, so it needs `audit:view` as well; both are checked
again at every page of the export and at download. An export also asks for a fresh
sign-in and is not available in Demo Mode. See [Audit log](../administration/audit-log.md).

### Read grants on every read

Since version 0.2, every read of the API asks for the grant of the data it returns, as the
writes always did. The built-in roles hold every one of these grants, so their access does
not change; a custom role without the grant now gets `403` on that read.

| Read | Grant |
|---|---|
| A case's export, trace, rationale, activity, thread and tasks; `GET /api/scans` and `/api/scans/notifications` | `cases:read` |
| The AI investigations in progress (`GET /api/investigations/active` and the `investigations` live topic) | `cases:read` |
| A case's raw events (`GET /api/cases/{case_id}/events`) | `cases:read` and `sources:read` |
| A case's AI usage (`GET /api/cases/{case_id}/usage`) | `cases:read` and `cost:view` |
| The cost values in a case's **View all fields** | `cost:view` |
| A source's feeds (`GET /api/sources/{source_id}/feeds`) | `sources:read` |
| `GET /api/settings`, and today's network range in a case's risk explanation | `settings:read` |
| The Standup (`GET /api/standup` and its report, action items and acknowledgements) and `GET /api/metrics/explain` | `metrics:view` |
| `GET /api/llm/models`, `GET /api/models` and `GET /api/llm/providers` | `models:read` |
| `GET /api/roles` | `roles:read` |
| The name of the person who started an AI run | `users:manage` |

Everyone else who may read the case sees "Started by a person" without the name. A few
reads need only a signed-in account: your own account, preferences, sessions, views,
terminology, notification preferences and inbox, the connector catalog, the persona
catalog, and the live event stream, whose topics have their own grants.
`GET /api/metrics/breakdown` and `GET /api/rules/summary` check their grants inside the
request, per breakdown kind and per section.

## Settings and narrow administration grants

The general `settings` resource has `read` and `manage`. Newer administration
surfaces use narrower resources so a custom role can delegate one area without
granting all settings:

```text
notifications  branding  sessions  demo  terminology  automation
roles          models    enrichment inapp rules
```

Each narrow resource also defines `read` and `manage`. The default grants deliberately
mirror each role's `settings` grant:

| Roles | `settings` and every narrow resource |
|---|---|
| `super_admin`, `soc_manager` | `*` (`read` and `manage`) |
| `analyst_tier2`, `analyst_tier1`, `responder`, `auditor` | `read` |

**Discounted inference** (the Flex and Batch policy) is part of Settings and saves with
the other preferences, so changing it needs `settings:manage`. Before Round 14 it was on
the Jobs page and saved with `models:manage`; every built-in role holds both grants or
neither, so only a custom role that held one without the other sees a difference.

**Enrichment** (the provider switches, fusion, the cache lifetime and provider keys)
saves at once and needs `enrichment:manage`. Before Round 14 its switches and cache
lifetime saved with the other preferences under `settings:manage`; as above, only a
custom role that holds one of the two grants without the other sees a difference. The
settings lock applies to the switches, fusion and the cache lifetime too, whatever the
role. Provider keys are handled like source and notification channel credentials: the
server does not check the lock for them. The Console disables the key fields while the
lock is on, but a direct API call with `enrichment:manage` can still set or clear a key,
and the audit log records it. **All settings** no longer lists the `enrichment`
settings: the Enrichment section is their one editor.

The API can still combine these resources with a case/source permission where the
operation acts on both domains. Always test the exact route with the role rather than
inferring access solely from whether a navigation item is visible.

## Chat and reports

Workspace Chat, the Case Manager **Chat** tab, and reports need `cases:read`. Each lookup
the assistant runs then needs the same grant as the console page that shows that data,
so a role sees the same data through chat as through the console:

| Lookup | Grant |
|---|---|
| Log search and log statistics, source health | `sources:read` |
| Cases, exact case counts and breakdowns, case decisions, the shift report, campaigns | `cases:read` (a case's runbook progress also needs `runbooks:read`) |
| Metrics (posture, trends, noise funnel, timing, coverage) | `metrics:view` |
| Indicator reputation | `enrichment:read` |
| Knowledge corpus search | `rag:read` |
| Runbook library (published runbooks only) | `runbooks:read` |
| AI cost and usage | `cost:view` |
| Audit log | `audit:view` |
| Automation status | `rules:read`, `automation:read`, `settings:read`, or `proposals:read`, per kind |
| ATT&CK techniques, Help Center | none |

A few chat features have their own gates:

- choosing a model other than the default, and seeing money and budget figures, need
  `models:read`; today's spend also needs `cost:view`. Chat is not paused by the daily
  AI budget, whatever these permissions; when the optional daily chat spending limit is
  reached, a product question is still answered from the Help Center at no cost and any
  other question gets the spending-limit notice;
- posting a case-chat question and its answer text to the case thread, where every
  reader of the case sees them, needs `cases:comment`, and so does **Add to case** on a
  Workspace answer, which posts it as the user's own comment;
- the step inspector, answer ratings, rejoining a running answer, and **Ask AI** entity
  questions need `cases:read`, like chat itself, and work only on the user's own
  conversations and turns;
- suggested questions (`GET /api/chat/starters`) and their events need `cases:read`; a
  card appears only when the caller holds every grant its answer needs (for example
  `sources:read` for a quiet source, `models:read` and `cost:view` for spending,
  `proposals:read` for approvals, `metrics:view` for auto-close health), and while
  row-level object scope is on for the caller's role no card about cases is shown;
- confirming a fact the assistant suggests remembering needs `memory:manage`;
- a running answer keeps only the access it started with: a role change that removes a
  grant it uses stops it ("Your access changed"); a change that only adds access stops
  nothing.

Checking these grants for the composer and the starters writes no audit rows; a lookup
the model requests and the engine refuses for a missing grant writes one ACCESS_DENIED
row. Reports and saved conversations are visible only to the user who created them.

## Custom roles and overrides

The RBAC configuration supports four layers:

1. the built-in default matrix;
2. per-built-in-role `roles` replacements for named resources;
3. custom roles with cycle-guarded inheritance and additive grants;
4. explicit role/resource denies, applied last with **deny-wins** precedence.

A wildcard grant expands to the concrete action set when a narrow deny is applied,
so denying `cases:close` from a role that inherited `cases:*` takes effect. Unknown
resources and invalid actions are ignored by the policy normalizer; use the role
preview/simulation endpoints to detect mistakes before assigning a role.

`super_admin` remains hard-allowed even if an override or deny is malformed. Protect
assignment of that role as a privileged operation. The server does: giving an account
the `super_admin` role, or changing, disabling or deleting an account that has it,
needs a caller whose stored role is `super_admin` and a sign-in within the
re-authentication window, on `POST`, `PUT` and `DELETE /api/users` and `PUT
/api/users/{username}/roles`. `users:manage` alone answers `403 super_admin_only` with an
Access denied row, whether RBAC is on or off.

## Inspect and test access

- `GET /api/account/permissions` returns the current account's effective access: every
  action the API allows it, listed as concrete actions (never `*`). The server answers it
  with the same resolver its route checks use, so it includes the base role, every
  assigned custom role and every deny.
- `GET /api/roles` returns the role catalog/effective definitions.
- `POST /api/roles/preview` validates a proposed role shape without persisting it.
- `GET /api/roles/simulate` evaluates a role against a resource/action request.
- `PUT /api/users/{username}/roles` changes a user's role.

The Agentic SOC Console uses permission guards for presentation, but the API is the security
boundary. The guards read only `GET /api/account/permissions`, so the Console shows the
actions a custom role grants (for example `runbooks:publish` or `audit:export`) and hides
what a deny removes, exactly as the API decides. When that read fails, the Console hides
every restricted action (`super_admin` excepted) rather than guess. Behind the central
authentication gate, every `/api` route, reads included, declares the grant it needs or
checks it in the request. The only exceptions are the public paths (health, sign-in,
setup status, single sign-on and branding) and the reads that need only a signed-in
account, listed under [Read grants on every read](#read-grants-on-every-read). A test
fails the build when a new route has neither.

Object-level scope conditions exist as an opt-in policy hook and use a fixed,
non-`eval` condition vocabulary. They are off by default. Built-in RBAC therefore does
not by itself provide tenant isolation or arbitrary row-level case segregation.

See [Users and RBAC](../administration/users-rbac.md),
[API authentication](api.md#authentication), and [Security](security.md).
