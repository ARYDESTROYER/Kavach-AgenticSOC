---
title: Security model
description: Trust boundaries, enforced safety properties, deployment responsibilities, and known security limits in Agentic SOC 0.1.
---

# Security model

Agentic SOC processes attacker-influenced telemetry and sends bounded summaries to language
models. Version 0.1 therefore treats input data, model output, and operational actions
as separate trust domains. The product's consequential safety rules are enforced in
code rather than delegated to a prompt.

## Trust boundaries

```text
Analyst browser
    -> Agentic SOC Console / reverse proxy
        -> Agentic SOC API
            -> read-only telemetry sources
            -> Agentic SOC-owned state backend
            -> LLM and enrichment providers
```

- The browser receives non-secret configuration and configured booleans, not secret values.
- Pull-source credentials are read-only and scoped to the selected telemetry.
- The state backend credential can write Agentic SOC-owned data but must not grant source-log access.
- Push receivers authenticate inbound senders before parsing when bearer or HMAC mode is selected.
- Model and enrichment calls cross an outbound trust boundary and require an explicit egress policy.

## Enforced product invariants

### Read-only source access

The Elastic path uses physically separate clients for the read-only log key and the
management key for `tlsoc-agent-*`. The latter needs index
`read`/`write`/`create_index`/`view_index_metadata`/`manage` plus cluster
`manage_ilm`, `manage_index_templates`, and `monitor` when the administrator uses the explicit storage-lifecycle
preview/apply. Never use `elastic`, `kibana_system`, or an
equivalent administrator identity at runtime. Other pull connectors follow the same
least-privilege principle; push receivers have no write path back to a source.

### Deterministic decisions

The LLM produces a verdict recommendation. The pure case-manager decision function
evaluates that verdict, confidence, risk score, and operator policy. `NEEDS_HUMAN`
cannot auto-close. True-positive auto-close is off by default, while false-positive
auto-close is bounded by configured confidence/risk thresholds and an objection
window. Runbooks, automation, memory, notifications, and preview endpoints cannot
bypass the case manager.

See [Deterministic decisions](../concepts/deterministic-decisions.md).

### Append-only audit and complete LLM accounting

The audit repository exposes a write operation and no update/delete operation for an
existing action. Every LLM call passes through one gateway, which writes the usage and
cost ledger. A provider or tool failure fails toward human review rather than silently
discarding an alert.

### Prompt-injection containment

Mapped fields, OCSF `unmapped`, `raw_data`, case/user-influenced strings, search
results, and arbitrary imported/resolved-case knowledge are untrusted. Prompt builders
wrap attacker-influenceable values in labelled fences and tell the model not to follow
instructions found inside them. Only the shipped/verified runbook, MITRE, and
suppression corpus is allowlisted as trusted knowledge. Even trusted context can only
shape a recommendation; it cannot alter the deterministic decision authority.

### Capability tiers

Agent tools declare `SAFE`, `MANAGED`, `REQUIRES_APPROVAL`, or `FORBIDDEN`. The shipped
investigation tools are read-only. Outward or irreversible capabilities must be
proposal/approval-gated, and closing a case is not an autonomous tool capability.

## Authentication and authorization

Authentication is **off by default** in the base backend configuration. That default
supports isolated evaluation; it is not a production security posture. When auth is
enabled, JWTs are accepted through an HTTP-only, SameSite=Lax cookie or a bearer
header. Session records add revocation, idle/absolute expiry, refresh rotation, and
token-version invalidation.

RBAC is a second switch:

- auth off: API gates are no-ops;
- auth on, RBAC off: every authenticated user receives super-admin-equivalent access;
- auth on, RBAC on: built-in/custom role grants and deny-wins rules are enforced.

Enable both switches for role separation. Configure TOTP MFA and/or OIDC as required,
and protect fresh-auth operations. See [Permissions](permissions.md) and
[Authentication](../administration/authentication.md).

## Inbound receiver security

HTTP receivers support:

- `bearer`: constant-time comparison with the source token;
- `hmac`: HMAC-SHA256 over the exact request body using the configured shared secret;
- `none`: no application-layer sender authentication.

Use `none` only when a trusted gateway enforces authentication and reachability.
Apply body-size, connection, and rate limits at the edge. Syslog, queue, stream, and
object-store transports depend on their transport-specific TLS, identity, and network
controls; the connector manifest tells the operator which secret/config fields apply.

## HTTP hardening

Security headers are enabled by default and include CSP, frame denial, no-sniff, and a
no-referrer policy; HSTS is emitted for HTTPS requests. The built-in rate limiter is
optional, in-process, and per client IP. It is a coarse single-process guard, not a
distributed rate-control system.

CSRF middleware is optional and off by default. In 0.1 it expects matching
`tlsoc_csrf` cookie and `X-CSRF-Token` header values on unsafe requests, but the Agentic SOC
Console does not mint/echo that token end to end. Do not enable it without validating
the client flow or providing the exchange at the trusted proxy/application layer.

## Secrets and cryptography

Provider, source, SSO, notification, database, and signing credentials belong in the
deployment secret store. Runtime values entered in the Console are memory-only unless
also supplied at boot. API reads expose only configured status. Never put a secret in
an organization preference, connector non-secret `config`, a runbook, a model prompt,
or source telemetry.

Local passwords use PBKDF2 hashes. JWTs use HS256 with an operator-supplied stable
secret. TOTP seeds are obfuscated at rest; this is not a substitute for envelope
encryption backed by a KMS. Treat access to the state database and the MFA
obfuscation/signing keys as sensitive and back them up separately.

## Deployment checklist

- Terminate TLS at a trusted reverse proxy and set `AUTH_COOKIE_SECURE=true`.
- Enable authentication and RBAC; remove or rotate all demonstration/bootstrap credentials.
- Supply a stable, high-entropy JWT signing key and a separate MFA protection key.
- Restrict the API and Console by network policy; restrict `/docs` and `/openapi.json` if needed.
- Use per-source read-only credentials and a distinct state-backend credential.
- Authenticate every inbound receiver and validate replay/duplicate behavior for its transport.
- Set outbound allowlists for the selected LLM and enrichment providers.
- Enable edge-level request limits, logging redaction, and alerting on auth/audit events.
- Back up and restore-test state and deployment secrets separately.
- Record the immutable image/tag/commit identity and verify readiness after restart.

## Security limits in 0.1

Agentic SOC 0.1 does not provide a built-in durable secret manager, default multi-tenant
row isolation, distributed rate limiting, or autonomous response containment. The
reference service shape is single-backend oriented; multi-replica coordination and
high availability require deployment-specific validation. Some transport receivers
cannot acknowledge durably before process memory/state handling completes. Provider
usage estimates are not a billing authority.

Read the complete [Known limitations](../releases/known-limitations.md) and the
deployment-focused [Security hardening guide](../operations/security.md).
