---
title: Reset and recovery
description: Understand Agentic SOC's destructive reset scopes, safeguards, and recovery requirements.
---

# Reset and recovery

Reset removes Agentic SOC-owned state. It never deletes upstream log data and never erases
environment-provided secrets. Reset is destructive and is not a substitute for a
tested backup/restore process.

## Safeguards

The Console submits a `tiered_reset` job through `POST /api/jobs`. Admission requires:

- an administrator with the privileged user-management grant;
- a freshly reauthenticated session;
- settings not being in read-only mode;
- an exact type-to-confirm phrase;
- a successful audit write before the destructive step begins.

The job snapshots the scope and exact phrase. After `202 Accepted`, non-factory reset
progress remains visible in **Analytics → Jobs** and **Inbox**. Cancellation is
cooperative and cannot restore state already cleared. The successful submit/cancel
response and terminal projection each wait for their corresponding transition audit;
reconciliation repairs an audit gap before visibility. `POST /api/admin/reset` is a
retired mutation seam: authenticated legacy callers receive HTTP `410 Gone` with a
`durable_job_required` response directing them to submit `tiered_reset` through
`POST /api/jobs`. There is no synchronous reset bypass around the job fence.

## Scopes

| Scope | Confirmation phrase | Intended effect |
|---|---|---|
| `cases` | `RESET CASES` | Clear Agentic SOC case-oriented state and related advisory counters while retaining configured sources and durable cost history where specified by the reset service |
| `sources` | `RESET SOURCES` | Remove configured sources, source cursors/mappings, and in-memory per-source secrets; does not delete data from upstream systems |
| `factory` | `FACTORY RESET` | Clear Agentic SOC-owned configuration/state and return the application to first-run setup |

The terminal job result returns bounded counts/categories reported as cleared. Review
it rather than assuming every external dependency was affected.

## Factory receipt and privacy

A factory job fences new application-job admission, asks other active jobs to stop,
waits a bounded time, and purges the previous Jobs registry, personal Inbox state, and
job artifacts. It therefore does not promise a personal Inbox completion that it then
deletes.

One actorless, terminal, sanitized operational receipt remains in the Jobs registry
for callers with `users:manage`. It contains only scope, timestamps, status, counts,
and non-secret build identity—never actor/session identity, submitted parameters,
idempotency material, item IDs, failure text, or an artifact. Factory reset starts a
new audit lineage. In the supported single-backend-process profile, global mutation
admission and SSE drain before tenant producers and detached writers stop; the reset
strictly clears tenant StateStore, RAG, usage/audit, runtime projection, cache/EventBus,
and runtime-overlay state before auditing the receipt and reopening admission. Do not
describe this process-local guarantee as an atomic distributed reset across arbitrary
application replicas.

Failure to complete this privacy boundary leaves the application fenced and degraded.
Ordinary work and non-factory job admission remain blocked; the only permitted recovery
mutation is a new factory-reset job from a freshly authorized administrator. Investigate
the failed purge/quiescence evidence, reauthenticate, and retry the factory scope rather
than attempting to continue from partially reset state.

## What reset does not erase

- source-system logs, alerts, queues, or object-store objects;
- environment variables and deployment-managed credentials;
- container images or database backups;
- provider-side LLM usage and invoices.

A source or factory reset clears runtime connector secrets because the corresponding
source configuration no longer exists. Other boot-time environment secrets remain
outside the reset engine.

## Before reset

1. Export or back up the selected `StateStore`.
2. Record the application version and build information.
3. Export any cases or reports that must remain readily readable.
4. Confirm upstream retention and replay capability.
5. Inventory runtime-only secrets that must be re-entered.
6. Schedule a validation window and notify affected operators.

## After reset

Verify setup status, state-store readiness, source credentials, cursor position,
model routing, budget limits, authentication, and notification tests before admitting
real data. Replaying a retained source can recreate alerts and cases; idempotency does
not make an intentional full-state reset reversible.

See [Background jobs](../operations/background-jobs.md),
[Health, backup, and restore](../operations/health-backup.md), and
[Troubleshooting](../operations/troubleshooting.md).
