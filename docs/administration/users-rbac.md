---
title: Users and RBAC
description: Manage Agentic SOC users, built-in roles, custom roles, and least-privilege access.
---

# Users and RBAC

Agentic SOC 0.1 provides local users, six built-in roles, custom roles, and deny-wins
permission overrides. RBAC is enforced only when authentication and RBAC are enabled.

## Turn on role-based access

Role-based access is **off by default**. With authentication on and role-based access off,
every signed-in account is treated as Super admin, whatever role it was given. Check the
current state in **Settings → Security & access → Single sign-on & policy**: the Posture row
**Role-based access** reads **Off: everyone is Super admin** until you turn it on, and the
**Roles & permissions** page shows a "Role-based access is off" notice.

The 0.1.13 Console has no switch for it. A super administrator turns it on by saving
`{"rbac": {"enabled": true}}` through `PUT /api/settings` (permission `settings:manage`).
From a shell that can reach the Console, with your Console address and administrator
username:

```bash
CONSOLE=http://localhost:8080
ADMIN=soc-admin
read -r -s -p "Password for $ADMIN: " PW; echo
TOKEN=$(ADMIN="$ADMIN" PW="$PW" python3 -c 'import json, os; print(json.dumps({"username": os.environ["ADMIN"], "password": os.environ["PW"]}))' \
  | curl -s -X POST "$CONSOLE/api/auth/login" -H 'Content-Type: application/json' --data-binary @- \
  | python3 -c 'import json, sys; print(json.load(sys.stdin)["token"])')
unset PW
curl --fail -s -o /dev/null -w 'settings saved: HTTP %{http_code}\n' -X PUT "$CONSOLE/api/settings" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"rbac": {"enabled": true}}'
unset TOKEN
curl -s "$CONSOLE/api/setup/status" | python3 -c 'import json, sys; print("rbac_enabled:", json.load(sys.stdin)["rbac_enabled"])'
```

The expected output is `settings saved: HTTP 200`, then `rbac_enabled: True`. The change
applies from the next request.

- Run it before this administrator turns on two-factor. For an account with two-factor, the
  sign-in call returns `requires_mfa` and a `pending_token` instead of `token`; exchange
  them at `POST /api/auth/mfa/verify` with `{"pending_token": "...", "code": "..."}`, which
  returns `token`.
- Give every account its intended role before you turn it on, and keep at least one super
  administrator.

## Built-in roles

| Role | Intended use | Default access summary |
|---|---|---|
| `super_admin` | Platform owner | Unrestricted; code prevents an override from locking this role out |
| `soc_manager` | SOC administration | Cases, sources, users, settings, rules, knowledge, audit, and operational administration |
| `analyst_tier2` | Senior analyst | Full case investigation and closure; read-only administration |
| `analyst_tier1` | Analyst | Read, update, assign, and comment on cases; no case closure by default |
| `responder` | Response operator | Tier-1-style case access plus working runbooks on cases and proposal approval |
| `auditor` | Independent review | Read/view only, including the audit trail |

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
default tenant-isolation boundary in version 0.1.

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

## Limitations

- Agentic SOC does not yet expose a complete API-key lifecycle for automation clients.
- Custom role quality depends on operator testing; there is no policy-as-code release
  pipeline in 0.1.
- Authentication is off by default in the base configuration. RBAC alone cannot
  protect a deployment until authentication is enabled.

See [Authentication](authentication.md) for login, MFA, SSO, and session policy, and
[Security hardening](../operations/security.md) for production boundaries.
