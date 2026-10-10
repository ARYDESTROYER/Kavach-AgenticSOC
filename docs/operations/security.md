---
title: Security hardening
description: Apply least privilege, authentication, transport, prompt-safety, and operational controls to Agentic SOC 0.1.
---

# Security hardening

Agentic SOC processes attacker-influenced security telemetry and can call external model and
enrichment providers. Treat the backend, state store, credentials, and outbound network
as a security boundary.

## Minimum deployment controls

1. Enable authentication and RBAC.
2. Replace all demonstration/bootstrap credentials.
3. Set stable, random JWT and MFA keys outside Git.
4. Terminate HTTPS and set secure cookies.
5. Restrict backend and database network exposure.
6. Use separate read-only log and application-state credentials.
7. Restrict provider egress and webhook destinations.
8. Configure application and provider-side cost limits.
9. Back up and test restoration of state and deployment secrets.
10. Forward append-only audit records to an independently protected destination.

## Least-privilege source access

For Elasticsearch-compatible sources, the investigation key must be read-only and
limited to approved log patterns. A separate management key may read/write only
Agentic SOC-owned state indices. Never use a cluster superuser or `kibana_system`.

Apply the same principle to queue, object-store, cloud, and webhook credentials. A
receiver should access only the subscription, bucket/prefix, stream, or endpoint it
needs. Rotate credentials and confirm that failure does not acknowledge unpersisted
work.

## Authentication and sessions

Authentication is off by default, so network isolation alone is not a safe shared
deployment posture. After enabling it, use the smallest built-in/custom roles, MFA for
privileged accounts, short session policy, and session revocation during response.
Validate OIDC issuer, redirect URI, verified-email behavior, and client-secret storage.

Rate limiting is optional and process-local. It is not a replacement for an ingress
gateway or provider quota. CSRF support requires a client token exchange that the 0.1
web UI does not automatically complete; test it before enabling.

## Session lifetimes

This table is the documented record of session limits and of the deliberate
deviations from NIST SP 800-63B-4 (OWASP ASVS 5.0 requirement 7.1.1). Administrators
change the values in **Settings → Security & access → Single sign-on & policy**
(the Token & session policy group). The server's
session registry always decides; a browser cookie's own expiry is never relied on.

| | Sign-in without Remember me | Sign-in with Remember me |
|---|---|---|
| Cookie | Browser-session cookie (no `Max-Age`), `HttpOnly`, `SameSite=Lax`, `Secure` when `AUTH_COOKIE_SECURE=true` | Persistent cookie, `Max-Age` equal to the remembered lifetime, same attributes |
| Token lifetime | `AUTH_TOKEN_HOURS` (default 12 hours; values above 144 hours are reduced to 144 with a startup warning) | The remembered lifetime |
| Absolute limit | **Absolute lifetime** (default 30 days), bounded in practice by the token lifetime | The remembered duration (6, 12 or 24 hours; default and maximum 24), but never longer than the **Absolute lifetime**; counted from sign-in, and refreshing never extends it |
| Inactivity limit | **Idle timeout** (default 12 hours) | The **Idle timeout**, unless the administrator sets a separate remembered inactivity limit (5 minutes to 24 hours) |
| Ends when the browser closes | Usually; browsers that restore tabs can keep session cookies, so the server limits still apply | No, until a limit above ends it or the session is revoked |
| Two-factor authentication | Required at every sign-in when enrolled or mandated | Same. Remember me never skips the second factor |
| Sensitive actions (step-up) | Re-enter the password after the re-auth window (default 10 minutes) | Same |
| Revocation | Signing out, revoking a session, or signing out everywhere ends it on the next request | Same |
| Concurrent sessions | Not limited; each device has its own row in **Settings → Account → Sessions & activity** | Same, with a "Remembered" badge and its end time in the Expires column |

**Deviation 1: persistence.** NIST SP 800-63B-4 §5.1 says session secrets SHOULD NOT
be persistent and that "remember my browser" features must not replace
authentication. Remember me keeps an already authenticated session alive across
browser restarts for at most 24 hours, the AAL2 overall reauthentication ceiling; it
never replaces the next sign-in, never skips two-factor authentication, and never
bypasses step-up. It is opt-in per sign-in, preceded by a shared-device warning, and
controlled by the administrator: it can be turned off, shortened to 6 or 12 hours,
given its own inactivity limit, or refused for chosen roles.

**Deviation 2: inactivity.** NIST SP 800-63B-4 says the AAL2 inactivity timeout SHOULD
be no more than 1 hour. The default **Idle timeout** is 12 hours, and it applies to
remembered sessions too, so that a remembered device stays signed in through a
working day. An administrator who needs the NIST value sets the Idle timeout (or the
separate remembered inactivity limit) to 60 minutes or less. A remembered session is
never allowed a longer inactivity or absolute limit than ordinary sign-ins unless the
administrator sets a remembered inactivity limit explicitly, so an upgrade never
weakens a stricter policy that was already configured.

**Policy changes apply to live sessions.** Limits are recomputed from the current
policy on every request. Shortening the remembered duration ends older remembered
sessions on their next request. Turning Remember me off, excluding a role, or
promoting someone into an excluded role makes their remembered sessions follow the
standard limits from the next request, and the console turns their cookie into a
browser-session cookie the next time it loads. Out-of-range values sent to the
settings API are refused (HTTP 422), never silently adjusted.

**Transport.** A persistent cookie is only issued when it cannot cross plain HTTP:

- Behind TLS, set `AUTH_COOKIE_SECURE=true`. Until it is set, Remember me stays off
  even on an HTTPS console (the sign-in page says it is not available on this
  connection, and the Session policy editor explains why).
- Without secure cookies, Remember me is offered only on a direct request from the
  server itself (the browser and the backend on the same machine, with no reverse
  proxy in between). A request that arrives through any proxy is treated as coming
  from the network, even when the proxy rewrites the host name to `localhost`.
- An administrator may allow it on plain HTTP anyway ("Allow on plain HTTP", not
  recommended); the switch is shown only while secure cookies are off.

**Shared devices.** Do not use Remember me on shared, public or kiosk computers. Sign
out when done. The warning is shown to everyone who checks the box, except the person
this browser already remembers. A remembered username is kept in the browser (not a
credential) and can be removed with "Use a different account" on the sign-in page or
"Forget this device" in **Settings → Account → Sessions & activity**.
The password is never stored by Agentic SOC; only the browser's own password manager
may offer to save it.

**Revoked sessions stay revoked.** Every session token expires before the registry
forgets a revoked session (7 days), and the server never re-registers a token issued
before that window, so a revoked session cannot come back.

**Changed in this release.** A sign-in without Remember me now uses a browser-session
cookie instead of a 12-hour persistent cookie. API clients that send a bearer token
are unaffected.

## Untrusted data and AI

Log-derived, source-derived, and user-influenceable values are untrusted. Agentic SOC fences
them in prompts and escapes them in the UI/template paths. Operator-imported knowledge
is also untrusted unless it belongs to a built-in verified corpus.

These controls reduce prompt-injection risk; they do not prove a model safe. Keep model
tools read-only, inspect traces, limit outbound access, and require human review for
response actions. The model supplies a verdict, while deterministic code applies the
configured close/escalate policy.

## Secrets and backups

UI-entered source, SSO, enrichment, and notification secrets are memory-only. Use a
deployment secret manager or protected environment injection for restart-safe operation.
Application backups do not contain those values. Protect backup encryption keys and
test restoring both state and secrets.

## Current limitations

Version 0.1 does not claim multi-tenant isolation, complete high availability, a
database migration framework, an integrated secret manager, or certification for every
advertised source protocol. Review [Known limitations](../releases/known-limitations.md)
and perform an environment-specific security assessment.

See [Authentication](../administration/authentication.md),
[Users and RBAC](../administration/users-rbac.md), and
[Health, backup, and restore](health-backup.md).
