---
title: Permissions
description: Built-in Agentic SOC roles, resource-action grants, authorization modes, and custom-role behavior in version 0.1.
---

# Permissions

Agentic SOC 0.1 authorizes actions with a `resource:action` vocabulary. Six built-in roles
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
and the case page, its facts rail and Entity investigation leave it out), and the
recorded case cost in Agent effectiveness (shown as unavailable). A role without
`cost:view` still reads everything else on those pages.

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

## Audit log

`audit:view` opens and searches the audit log. `audit:export` writes a CSV or JSON Lines
file of the rows the person can read, so it needs `audit:view` as well; both are checked
again at every page of the export and at download. An export also asks for a fresh
sign-in and is not available in Demo Mode. See [Audit log](../administration/audit-log.md).

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
assignment of that role as a privileged operation.

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
every restricted action (`super_admin` excepted) rather than guess. Non-GET routes are
expected to declare an authorization dependency in addition to the central authentication
gate.

Object-level scope conditions exist as an opt-in policy hook and use a fixed,
non-`eval` condition vocabulary. They are off by default. Built-in RBAC therefore does
not by itself provide tenant isolation or arbitrary row-level case segregation.

See [Users and RBAC](../administration/users-rbac.md),
[API authentication](api.md#authentication), and [Security](security.md).
