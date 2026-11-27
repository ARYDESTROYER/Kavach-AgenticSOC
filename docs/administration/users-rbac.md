---
title: Users and RBAC
description: Manage Agentic SOC users, built-in roles, custom roles, and least-privilege access.
---

# Users and RBAC

Agentic SOC 0.2 provides local users, six built-in roles, custom roles, and deny-wins
permission overrides. RBAC is enforced only when authentication and RBAC are enabled.

## Turn on role-based access

Role-based access is **off by default**. With authentication on and role-based access off,
every signed-in account is treated as Super admin, whatever role it was given. It has no
effect while sign-in is off. **Settings → Security & access → Single sign-on & policy**
shows the current state in its Posture row **Role-based access**: **Enforced**, or
**Off: everyone is Super admin**.

Give every account its intended role before you turn it on, and keep at least one Super
admin.

### In the Console

1. Sign in as a Super admin.
2. Open **Settings → Security & access → Roles & permissions**, or select **Manage** on the
   Posture row **Role-based access**.
3. The **Role-based access** group at the top shows the state, **On** or **Off: every
   signed-in account is treated as Super admin**, and, for an account that may manage
   users, the active accounts per role.
4. Select **Turn on role-based access**. The confirmation lists what changes:
    - every account gets its role's permissions on its next request;
    - a background job started by an account that loses a permission stops at its next
      item;
    - an open live stream keeps its topics until it reconnects;
    - whether an account can use Remember me follows its role;
    - you stay Super admin.
5. Select **Turn on**. If you signed in longer ago than the session policy's
   re-authentication window (10 minutes by default), sign in again when asked.

**Turn off role-based access** works the same way, behind a destructive confirmation:
every signed-in account is then treated as Super admin, whatever its role.

The button is unavailable, with the reason under the state, when sign-in is off, when
your account's role is not Super admin, or while settings are in read-only mode. Only the
role stored for your account counts: while role-based access is off every account is
treated as Super admin, but only a real Super admin may change it. Only a Super admin
can give an account that role ([Add a local user](#add-a-local-user)).

Each change is recorded in the [Audit log](audit-log.md) as a settings change to **RBAC**,
with the field `rbac.enabled` before and after. A request that changes nothing writes no
row.

### With the API

`GET /api/rbac` (permission `roles:read`) returns the state: `enabled`, `auth_enabled`,
`can_change`, `blockers` (`auth_off`, `not_super_admin`, `read_only_settings`),
`caller_role`, `super_admin_count` and, for a caller holding `users:manage`,
`role_counts`.

`PUT /api/rbac` with `{"enabled": true}` or `{"enabled": false}` changes it. It needs a
Super admin whose session was created by signing in (or re-authenticated with
`POST /api/auth/reauth`) within the re-authentication window. It answers:

| Status | Code | Meaning |
|---|---|---|
| 200 | | The new state, with `changed` (`false` when it was already in that state) |
| 401 | `reauth_required` | Sign in again: the sign-in is too old, or the session cannot be verified |
| 403 | `rbac_super_admin_only` | The account's role is not Super admin (an Access denied row is written) |
| 403 | | `Settings are in read-only mode` |
| 409 | `rbac_auth_required` | Sign-in is off |
| 409 | `rbac_no_super_admin` | Turning on needs at least one active Super admin account |
| 409 | `settings_conflict` | Another save kept changing the settings; try again |
| 503 | `audit_unavailable` | The audit log could not be written, so nothing changed |

From a shell that can reach the Console, with your Console address and Super admin
username:

```bash
CONSOLE=http://localhost:8080
ADMIN=soc-admin
read -r -s -p "Password for $ADMIN: " PW; echo
TOKEN=$(ADMIN="$ADMIN" PW="$PW" python3 -c 'import json, os; print(json.dumps({"username": os.environ["ADMIN"], "password": os.environ["PW"]}))' \
  | curl -s -X POST "$CONSOLE/api/auth/login" -H 'Content-Type: application/json' --data-binary @- \
  | python3 -c 'import json, sys; print(json.load(sys.stdin)["token"])')
unset PW
curl --fail -s -X PUT "$CONSOLE/api/rbac" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"enabled": true}' \
  | python3 -c 'import json, sys; b = json.load(sys.stdin); print("enabled:", b["enabled"], "changed:", b["changed"])'
unset TOKEN
```

The expected output is `enabled: True changed: True` (`changed: False` when it was already
on). The change applies from the next request. Run it within the re-authentication
window of the sign-in it makes.

- For an account with two-factor, the sign-in call returns a `pending_token` instead of
  `token`; send it with the current code to `POST /api/auth/mfa/verify`
  (`{"pending_token": "...", "code": "..."}`), which returns `token`.
- `PUT /api/settings` no longer changes `rbac.enabled`: a body that would change it answers
  `409 rbac_switch_moved`. Any other `rbac` field (`roles`, `resources`, `custom_roles`,
  `denies`, `default_role`) changed through `PUT /api/settings` needs `roles:manage` and a
  fresh sign-in.

## Built-in roles

| Role | Intended use | Default access summary |
|---|---|---|
| `super_admin` | Platform owner | Unrestricted; code prevents an override from locking this role out |
| `soc_manager` | SOC administration | Cases, sources, users, settings, rules, knowledge, audit, team activity, and operational administration |
| `analyst_tier2` | Senior analyst | Full case investigation and closure; read-only administration |
| `analyst_tier1` | Analyst | Read, update, assign, and comment on cases; no case closure by default |
| `responder` | Response operator | Tier-1-style case access plus working runbooks on cases and proposal approval |
| `auditor` | Independent review | Read/view only, including the audit trail and team activity |

The backend permission vocabulary is resource/action based, for example
`cases:close`, `sources:manage`, `models:manage`, and `audit:view`. The effective
permission calculation is authoritative; hiding a button in the UI is not an
authorization boundary. The Console reads that same effective calculation, so a person
sees the actions their base role and assigned custom roles allow, and no others.

## Add a local user

1. Open **Settings → Security & access → Users**.
2. Create a unique username and a strong initial password.
3. Assign the smallest built-in or custom role that covers the user's duties.
4. Require a password change when appropriate.
5. Ask the user to enroll MFA and review their active sessions.

User creation, update, and deletion use `/api/users`. Role assignment also has a
dedicated `/api/users/{username}/roles` route. Administrative writes are audited.

Only a Super admin can give an account the Super admin role, or change, disable or
delete an account that has it (its role, password, MFA, profile or active state), and
only after signing in within the re-authentication window. `users:manage` alone, which a
SOC manager holds, is not enough, so it cannot be used to become Super admin or to take
over a Super admin account. Anyone else gets `403 super_admin_only` and an Access denied
row in the Audit log; a Super admin whose sign-in is too old gets `401 reauth_required`.
This holds whether role-based access is on or off, because only the role stored for the
account counts.

## Custom roles

Custom roles can inherit from existing roles, add grants, and declare explicit
denies. Denies win after inherited and direct grants are combined. The server guards
inheritance cycles and ignores unknown permission vocabulary.

Before assigning a custom role:

1. Build it from the least-privileged parent.
2. Add only the required resource actions.
3. Preview the effective matrix.
4. Simulate a representative action.
5. Test with a non-administrator account.

Avoid broad `*` grants. Object/row-level scope is an opt-in capability and is not a
default tenant-isolation boundary in version 0.2.

Treat `data_export:export` as a privileged data-access grant. It permits a bounded
portable snapshot across selected cases, audit, usage, configuration, automation,
and knowledge metadata. The built-in grant is limited to `super_admin` and
`soc_manager`; add it to a custom role only when that operator is authorized to read
all records in the selected scopes. Export remains audited and secret-free, but it is
not row-scoped to the requesting analyst.

Treat `audit:export` the same way: it writes a file of every audit row its holder can
read, including client addresses and user agents (personal data). The built-in grant
is limited to `super_admin`, `soc_manager` and `auditor`, and each export also asks for
a fresh sign-in. See [Audit log](audit-log.md#exporting).

Runbook grants are separate: `runbooks:run` works a case's checklist (every built-in
role except `auditor`), `runbooks:manage` writes drafts, and `runbooks:publish` makes a
version live and trusted by the investigator (`super_admin` and `soc_manager`). Grant
publish deliberately; see [Permissions](../reference/permissions.md#runbooks).

## Account and session response

Administrators can revoke an individual session, revoke all sessions for a user, or
disable/delete an account. Session revocation is checked on subsequent authenticated
requests. Preserve at least one working `super_admin` account and verify it before
changing another administrator's role.

Deleting an account also deletes that user's Workspace chat conversations, answer
ratings and reports, and stops their running chat answers. Audit records are kept.

## Read grants

With role-based access on, every read asks for the grant of the data it returns, so a
custom role can hide an area by leaving its read grant out: for example cases without
`cases:read`, the Standup without `metrics:view`, the Models page without `models:read`,
or a case's AI usage without `cost:view`. The built-in roles hold all of these grants.
Only people who manage accounts (`users:manage`) see who started an AI investigation;
everyone else sees "Started by a person". The full list is in
[Permissions](../reference/permissions.md#read-grants-on-every-read).

An account you create, or whose password you reset, must change that password before
anything else, and a reset signs the account out everywhere (see
[Authentication](authentication.md#sessions)).

## Limitations

- Agentic SOC does not yet expose a complete API-key lifecycle for automation clients.
- Custom role quality depends on operator testing; there is no policy-as-code release
  pipeline in 0.2.
- Authentication is off by default in the base configuration. RBAC alone cannot
  protect a deployment until authentication is enabled.

See [Authentication](authentication.md) for login, MFA, SSO, and session policy, and
[Security hardening](../operations/security.md) for production boundaries.
