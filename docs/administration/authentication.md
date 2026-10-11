---
title: Authentication
description: Configure local authentication, sessions, MFA, and OIDC SSO in Agentic SOC 0.1.
---

# Authentication

Agentic SOC supports local password authentication, signed sessions, TOTP MFA, recovery
codes, and OIDC sign-in. Authentication is **disabled by default** for compatibility
with isolated development and evaluation setups. Enable it before shared use.

## Enable authentication

At minimum, configure:

```dotenv
TLSOC_AUTH_ENABLED=true
TLSOC_AUTH_JWT_SECRET=<stable-random-secret-of-at-least-32-bytes>
TLSOC_AUTH_COOKIE_SECURE=true
```

`TLSOC_AUTH_COOKIE_SECURE=true` requires HTTPS. Keep the JWT secret stable across
restarts; changing or losing it invalidates existing sessions. Never commit it.

An empty user store may seed the documented demonstration administrator unless the
backend variable `AUTH_SEED_ADMIN=false` is set. The reference Compose files do not
expose a prefixed mapping for this advanced bootstrap switch, so add the unprefixed
variable explicitly to the backend service when disabling it. Do not retain
demonstration credentials in a real environment. Prefer the first-admin setup flow or
supply controlled bootstrap credentials, then rotate them immediately.

## Sessions

Access tokens carry a session identifier and token version. The session store applies
idle, absolute, revocation, and refresh-rotation checks. Users can inspect and revoke
their sessions; administrators can inspect the organization session registry and
revoke sessions for another user.

Use short access lifetimes appropriate to the environment. Session continuity also
depends on the selected state store and a stable JWT secret.

A sign-in without **Remember me** uses a browser-session cookie: it usually ends when
the browser closes, and the server's idle and absolute limits apply in any case. Its
token lasts `AUTH_TOKEN_HOURS` (default 12 hours; a value above 144 hours is reduced to
144, for bearer-token API clients too). When a session ends on its own, the
sign-in page says why: after a period of inactivity, after the time limit, because it
was ended from another device or by an administrator, or because all of the account's
sessions were signed out.

## Remember me

The sign-in page offers **Remember me**. Checking it shows a warning first ("Keep this
device signed in?", with **Cancel** focused): anyone who can open this browser can use
the console as that user, without a password, until the remembered time runs out. After
**Keep me signed in**:

- the session survives browser restarts for the remembered duration (6, 12, or 24
  hours; 24 by default and at most), and never longer than the **Absolute lifetime**;
- the standard **Idle timeout** still applies, unless the administrator sets a separate
  inactivity limit for remembered devices;
- the username is remembered on this device, and the browser's own password manager may
  offer to save the password. Agentic SOC never stores the password. **Use a different
  account** on the sign-in page, or **Forget this device** under **Settings → Account →
  Sessions & activity**, removes the remembered username;
- two-factor authentication is still required at every sign-in, and sensitive actions
  still ask for the password.

Administrators configure it in the **Remember me** group of the session policy under
**Settings → Security & access → Single sign-on & policy**: turn it off, choose how long
devices stay signed in, add a separate inactivity limit, list roles that are never
remembered, and, only when secure cookies are off, allow it on plain HTTP (not
recommended). Changes apply to live sessions on their next request.

Remember me needs HTTPS with `AUTH_COOKIE_SECURE=true`, unless an administrator allowed
it on plain HTTP (`session_policy.remember_me.allow_insecure_http`, not recommended).
Until secure cookies are on, and while that setting is off, the checkbox is shown
disabled with the reason, except on a direct request from the server itself. It is
hidden only when authentication is disabled. A remembered session shows a
**Remembered** badge and its expiry under **Settings → Account → Sessions & activity**
and in the administrator's session list.

See [Security hardening](../operations/security.md#session-lifetimes) for the full
session-lifetime table, the transport rules for reverse proxies, and the documented
deviations from NIST SP 800-63B-4.

## MFA

TOTP setup returns a secret and recovery codes once. Store recovery codes outside the
application. Confirmation is required before MFA becomes active. Disabling MFA is a
sensitive operation and requires the authenticated account flow.

Agentic SOC obfuscates stored TOTP secrets with `MFA_OBFUSCATION_KEY`, or derives a key from
the JWT secret when no dedicated key is supplied. For a durable deployment, configure
a separate stable key and include it in secret backup procedures.

## OIDC SSO

Agentic SOC includes Google, Microsoft, and generic OIDC provider shapes. Configure provider
metadata as organization preferences and supply each client secret through the secret
tier. Register the callback URL ending in `/api/auth/sso/callback` at the identity
provider.

The callback validates browser-bound state. Email-based linking requires a verified
email and does not attach an SSO identity to a local-credential account merely because
the email strings match. Test sign-in and account-linking behavior with a non-admin
identity before rollout.

Runtime SSO secrets entered through the UI are memory-only. Supply them through the
deployment environment when restart persistence is required.

## Public routes and middleware

The setup status, login, refresh, SSO initiation/callback, liveness, readiness, and
branding bootstrap surfaces have narrowly scoped public behavior. The `/api` router
otherwise applies authentication centrally, and state-changing routes add permission
checks.

Security headers are enabled by default. Rate limiting is optional. The current CSRF
middleware requires clients to echo the expected token; the web UI does not complete
that exchange automatically in version 0.1, so do not enable CSRF without validating
the client flow.

See [Users and RBAC](users-rbac.md) and [Security hardening](../operations/security.md).
