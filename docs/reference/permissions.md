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
| `responder` | Tier-1 case access plus playbook execution and proposal approval |
| `auditor` | Read/view-only product access, including the append-only audit log |

The names describe defaults, not organizational job titles. Notably, the built-in
`responder` does not receive `cases:close`; assign a custom role when that is required.

## Case and operational grants

`*` means every action defined for that resource. `—` means no default grant.

| Resource | Actions | `super_admin` | `soc_manager` | `analyst_tier2` | `analyst_tier1` | `responder` | `auditor` |
|---|---|---|---|---|---|---|---|
| `cases` | `read`, `write`, `close`, `assign`, `comment`, `reinvestigate` | `*` | `*` | all six | `read`, `write`, `assign`, `comment` | `read`, `write`, `assign`, `comment` | `read` |
| `sources` | `read`, `manage` | `*` | `*` | `read` | `read` | `read` | `read` |
| `users` | `manage` | `*` | `manage` | — | — | — | — |
| `proposals` | `read`, `approve` | `*` | `*` | `read` | `read` | `read`, `approve` | `read` |
| `playbooks` | `read`, `run`, `manage` | `*` | `*` | `read`, `run` | `read` | `read`, `run` | `read` |
| `runbooks` | `read`, `manage` | `*` | `*` | `read` | `read` | `read` | `read` |
| `rag` | `read`, `manage` | `*` | `*` | `read` | `read` | `read` | `read` |
| `memory` | `read`, `manage` | `*` | `*` | `read` | `read` | `read` | `read` |
| `cost` | `view` | `*` | `view` | `view` | `view` | `view` | `view` |
| `metrics` | `view` | `*` | `view` | `view` | `view` | `view` | `view` |
| `audit` | `view` | `*` | `view` | — | — | — | `view` |
| `data_export` | `export` | `*` | `export` | — | — | — | — |

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
| Cases, case decisions, the shift report, campaigns | `cases:read` |
| Metrics (posture, trends, noise funnel, timing, coverage) | `metrics:view` |
| Indicator reputation | `enrichment:read` |
| Knowledge corpus search | `rag:read` |
| AI cost and usage | `cost:view` |
| Audit log | `audit:view` |
| Automation status | `rules:read`, `automation:read`, `settings:read`, or `proposals:read`, per kind |
| ATT&CK techniques, Help Center | none |

A few chat features have their own gates:

- choosing a model other than the default, and seeing money and budget figures, need
  `models:read`; today's spend also needs `cost:view`. When a blocking daily or
  monthly budget is used up, the composer disables Send only for viewers with
  `models:read`;
- posting a case-chat question and its answer text to the case thread, where every
  reader of the case sees them, needs `cases:comment`;
- confirming a fact the assistant suggests remembering needs `memory:manage`.

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

- `GET /api/account/permissions` returns the current account's effective access.
- `GET /api/roles` returns the role catalog/effective definitions.
- `POST /api/roles/preview` validates a proposed role shape without persisting it.
- `GET /api/roles/simulate` evaluates a role against a resource/action request.
- `PUT /api/users/{username}/roles` changes a user's role.

The Agentic SOC Console uses permission guards for presentation, but the API is the security
boundary. Non-GET routes are expected to declare an authorization dependency in
addition to the central authentication gate.

Object-level scope conditions exist as an opt-in policy hook and use a fixed,
non-`eval` condition vocabulary. They are off by default. Built-in RBAC therefore does
not by itself provide tenant isolation or arbitrary row-level case segregation.

See [Users and RBAC](../administration/users-rbac.md),
[API authentication](api.md#authentication), and [Security](security.md).
