---
title: Configuration reference
description: Understand environment variables, durable preferences, state backends, and secret handling in Agentic SOC 0.1.
---

# Configuration reference

Agentic SOC configuration has two authorities: deployment-owned environment settings and
application-owned preferences. Credentials are not ordinary preferences.

## Environment naming

The backend reads unprefixed names such as `STATE_BACKEND`, `STATE_DB_URL`,
`AUTH_ENABLED`, and `OPENAI_API_KEY`. The reference Compose files map supported root
`.env` variables prefixed with `TLSOC_` to backend names; the standalone stack fixes
`STATE_BACKEND=postgres` and derives its database URL from the PostgreSQL variables.

Examples:

```dotenv
TLSOC_PG_PASSWORD=<strong-password>
TLSOC_AUTH_ENABLED=true
TLSOC_AUTH_JWT_SECRET=<stable-random-secret>
TLSOC_AUTH_COOKIE_SECURE=true
TLSOC_OPENAI_API_KEY=<secret>
```

Use the exact variables supported by `.env.example` and the selected Compose file.
Unknown environment values are ignored by the settings loader, so a typo may look like
a working default rather than a startup error.

## State backends

| `STATE_BACKEND` | URL/credential | Intended profile |
|---|---|---|
| `postgres` | `STATE_DB_URL=postgresql+asyncpg://...` | Recommended standalone persistence; pgvector supports vector retrieval |
| `elasticsearch` | management URL/key and TLS settings | Agentic SOC state in dedicated indices; separate from the read-only log key |
| `sqlite` | `sqlite+aiosqlite:///...` | Single-node evaluation/development |

The state backend stores Agentic SOC-owned cases, audit, usage, configuration, cursors, users,
and knowledge. It does not select or authorize an external log source; connectors own
that boundary.

Background-job metadata shares this StateStore through a strict-CAS KV document.
Downloadable job ZIPs do not: `JOBS_ARTIFACT_DIR` selects their filesystem root. The
local and updater-managed standalone default is `./data/job-artifacts`; the legacy ELK
merge profile maps `TLSOC_JOBS_ARTIFACT_DIR` to `/var/lib/agentic-soc/jobs` and mounts a
persistent named volume there. Keep the directory private, capacity-monitored, and
outside a public web root. A standalone operator who needs artifacts to survive
container replacement must provide a reviewed override/bind mount; changing the
directory does not migrate existing artifacts.

## Secret classes

- **Global boot secrets:** model, database, authentication, enrichment, and similar
  credentials supplied as environment values.
- **Connector secrets:** per-source tokens/keys. Environment JSON maps are restart-safe;
  UI-entered values are memory-only.
- **SSO secrets:** provider client secrets, also environment or memory-only.
- **Notification secrets:** SMTP passwords or webhook credentials, environment or
  memory-only.

The UI receives configured booleans or field names, never the secret values. Back up
deployment secrets separately from application state.

## Durable preferences

`GET /api/settings` returns validated preferences, and `PUT /api/settings` updates
them. Important groups include sources/feeds, model routing, budget, auto-close policy,
autopilot, threshold tuning, campaigns, baselines, rules, notifications, branding,
RBAC, and realtime events.

Prefer the UI and change one section at a time. An external full-document update can
overwrite a concurrent administrator's change. General preferences do not have a
universal revision/rollback interface in 0.1.

## Defaults that require an explicit decision

- Authentication is off in the base configuration.
- Security headers are on; rate limiting and CSRF are off.
- The balanced autopilot profile and several deterministic learning/correlation
  helpers are on.
- The LLM budget backstop is on at $10/day with blocking behavior.
- Compatible official OpenAI alert inference prefers live Flex and truthfully falls
  back to standard service by default; the separate asynchronous Batch queue remains
  opt-in.

Review each default against the deployment's threat model and operational capacity.
See [Settings administration](../administration/settings.md),
[Models and spend controls](../administration/models-spend.md), and
[Background jobs](background-jobs.md), and [Security hardening](security.md).
