---
title: Troubleshooting
description: Diagnose Agentic SOC 0.1 startup, readiness, authentication, source, model, notification, and UI failures.
---

# Troubleshooting

Start with the narrowest failing layer. Preserve timestamps, build information, source
ID, request path/status, and sanitized logs. Never paste credentials, tokens, raw
sensitive events, or complete environment files into an issue.

## Backend is live but not ready

Check `/api/health/ready` and `/api/health/build-info`. A 503 readiness response means
the selected state store failed its usable/write-path probe.

- PostgreSQL: verify URL, DNS, TLS, credentials, database existence, and write rights.
- SQLite: verify the directory is writable and the file is not on unsuitable shared
  storage.
- Elasticsearch state: verify TLS/CA and the management key's rights to Agentic SOC-owned
  indices. Do not substitute the read-only log key.

## Login fails

- Confirm `AUTH_ENABLED` and the effective bootstrap/user configuration.
- Verify the backend uses the same stable JWT secret as before restart.
- Check whether the account is disabled, locked, or required to change its password.
- Confirm the user store is readable and readiness is healthy.
- For secure cookies, access the UI through HTTPS.
- For MFA, check system time and use a recovery code only through the supported flow.

## SSO callback fails

Compare the registered callback URI exactly, including scheme and path. Verify issuer,
client ID, provider metadata, client secret, browser cookies, and system time. An
unverified email or attempted unsafe link to a local account is expected to fail.

## Source is configured but no data appears

1. Inspect source health and coverage.
2. Confirm it is enabled and its feed role is not `ignore`.
3. Test the connector with the same endpoint/TLS settings.
4. Re-enter runtime-only secrets after a backend restart.
5. Validate time field, field mappings, index/stream scope, and severity/entity fields.
6. Check cursor lag, source retention, receiver acknowledgement, and per-tick caps.

Do not reset a source as a first diagnostic step; preserve cursor and mapping evidence.

## Investigation does not call a model

Check provider configuration/test results, model routing, the daily/monthly budget,
autopilot risk admission, per-tick caps, and whether the case is already queued/deferred.
A budget block should produce human-review work rather than drop the case.

## Notifications do not arrive

Preview the template, send a provider test, and inspect trigger, dedup, rate-limit, and
digest settings. Confirm the runtime secret survived the last restart and inspect the
receiving provider's rejection logs. Case persistence can succeed even when delivery
fails.

## A background job looks stuck

Open **Analytics → Jobs** and record the job ID, status, progress, cancellation state,
and safe failure summary. Navigation and reload do not stop accepted work. If SSE is
unavailable, use **Refresh** or wait for the polling fallback. A running cancellation is
cooperative and may wait for the next checkpoint; it does not undo completed items.

After an abrupt backend stop, allow the five-minute lease to expire before treating a
running record as orphaned. Recovery retries only repeat-safe ambiguous work; unsafe
state-changing items fail closed. Operate one backend replica: CAS job claims do not make
the wider process-local application active-active.

Submission/retry and cancel do not return a successful `202`, and a terminal Inbox/SSE
state does not project, until the corresponding transition audit is confirmed. During an
audit-store interruption, inspect the durable reconciliation/audit evidence before
assuming a queued or terminal state was lost; do not bypass the wait by resubmitting a
state-changing operation under a new intent key.

For a missing Download action, confirm the terminal result has an `artifact_id`. For a
failed download, inspect the configured artifact volume, private file permissions,
newest-50 retention, free space, and size/SHA-256 verification logs. Do not resubmit a
state-changing job until its audit transitions and terminal state are conclusive.

Scheduler health is a list projection and never appears in personal Inbox. A newly
accepted local LLM Batch row creates notes only for its strict, frozen, maximum-200
effective-`models:read` audience. Legacy rows, users/grants added later, and recipients
past the bound remain list-only. Authorization-store outage leaves the outbox pending for
retry; permission or account-generation loss removes and fail-closed filters the note.
Batch notes carry no Cancel, Download, or completion toast. The Jobs list is authoritative
for legacy, later-grant, and overflow records. See
[Background jobs](background-jobs.md).

An authenticated legacy client that calls `POST /api/admin/reset` or
`POST /api/storage/lifecycle/apply` receives `410 Gone` with
`durable_job_required`. Submit `tiered_reset` or `storage_lifecycle_apply` through
`POST /api/jobs`; do not retry the retired synchronous mutation in a loop.

If factory reset reports or leaves a privacy-boundary failure, the fenced/degraded state
is intentional. Ordinary work remains blocked. Restore the failing dependency, perform
fresh authorization, and submit only another factory-reset attempt; do not try a cases,
sources, or unrelated Job as a way around the fence.

## Changes fail with "audit_unavailable"

Since Round 14 a settings save, a user, role, source, runbook or dashboard change and a
job file download write their audit row before the change takes effect. When that row
cannot be written, nothing changes and the request answers `503 audit_unavailable`.
Sign-ins and sign-outs are never blocked this way.

- Check the audit store first: the state backend's health, its free space and the
  management key's write rights to the `tlsoc-agent-*` indices.
- On an Elasticsearch state backend upgraded from an earlier build, check that the
  Round 14 audit template was applied and the audit write index rolled. Until then a
  date-like value in an audit row can map a field as a date, and later rows with
  ordinary text there are refused. The backend logs a warning naming the step on every
  start. The warning keeps appearing after the step is done, and on deployments first
  created by Round 14 from their second start on, because the backend cannot read the
  mapping to check. The warning alone does not mean the step failed, so do not roll the
  index again because of it. To confirm the step, check that
  `GET _index_template/tlsoc-agent-audit-template` shows `date_detection: false`, and
  that the write index behind `tlsoc-agent-audit` (`GET _alias/tlsoc-agent-audit`)
  shows it too in its mapping. See
  [Applying the Round 14 audit template](upgrades.md#applying-the-round-14-audit-template).
- While the audit log cannot be written, `POST /api/setup/secrets` still applies the
  management connection keys (`es_mgmt_api_key`, `es_url`, `es_ca_cert`), so a broken
  audit connection stays repairable.

## The Audit log answers "could not be read" on PostgreSQL

On a PostgreSQL state backend, an earlier build answered `503 audit_unavailable`
for People and settings, Agent activity, a search or a count over any time range that
held an audit row with a `\u0000` in it, while All kept working. The account activity
list showed nothing. One failed sign-in with a NUL in the username was enough to write
such a row.

The current build never writes one (audit text is cleaned on write, an account cannot be created with
such a username, and a sign-in with one is an ordinary failed sign-in), and reads a row an older build stored as if it had been cleaned, without
rewriting it. After upgrading, every scope reads again with no data change. To see
whether any such rows are stored, run this read-only check:

```sql
BEGIN TRANSACTION READ ONLY;
SELECT count(*) FROM audit WHERE strpos(doc::text, '\u0000') > 0;
ROLLBACK;
```

## UI is blank or stale

Verify backend readiness through the nginx `/api` proxy, then inspect browser network
status and console errors. Confirm the web and backend artifacts are both version
`0.1.13`. Clear only browser cache/site data needed to rule out stale assets; do not
factory-reset application state for a presentation problem.

## A rule keeps routing to a human no matter how many cases we confirm

Check **Analytics → Agent effectiveness → Agent health → Precedent by rule**. If the rule is listed
as not helping, this is expected and confirming more cases will not change it.

The cause is evidence sufficiency, not precedent. If the rule's alerts carry no request
payload, URI, method, response code, or execution context, the investigation has nothing
to verify the individual instance against, so it correctly declines. Precedent describes
the rule's history; it cannot supply the missing per-case evidence.

Two remedies work, in this order:

1. **Enrich the source** so the alerts carry the fields an investigation needs. This is
   the real fix and it improves every future case of that rule.
2. **Declare the detection benign** with an [analyst rule policy](../automation/rules.md)
   if the alerts genuinely cannot carry that evidence. Matching clusters then close
   deterministically with no model call, and stay visible, audited, and reopenable.

Optionally enable analyst-confirmed precedent promotion so a unanimous confirmed history
for the exact rule is supplied to the investigator as a computed count. It is evidence,
not authority, so it changes what the model is told but never who decides.

If the rule is *not* listed and its precedent count looks low, confirm the corpus is
healthy first: an unreadable corpus reports "Unknown" rather than zero, and precedent
recorded before rule identity was captured is reported as unattributed until the next
retrieval projection re-tags it.

## The knowledge corpus is empty, or auto-close has stopped

The Console health pill reads **Degraded** with "Knowledge corpus empty", or auto-close
has fallen to zero while alert volume held steady.

An empty corpus means every investigation runs with no retrieved runbook passages,
ATT&CK or precedent context, so cases route to a human however confident the model is.
The matched runbook's guidance still reaches the investigator: it is read from the
runbook library, not from the corpus. Check
**Analytics → Agent effectiveness** (Agent health), or `GET /api/diagnostics/health`, which reports
the corpus size, the last projection outcome, any refused projection, and the
reconciliation between corpus documents and the qualifying case history.

Work through it in this order:

1. **Check the model provider first.** If health also reports "Model provider rejecting
   credentials", that is the cause: the corpus cannot be rebuilt while embedding calls
   fail, and the product deliberately refuses to rebuild it in a degraded embedding
   space rather than filling it with unusable vectors. Fix the API key (expired,
   revoked, or rotated) and the corpus rebuilds on its own.
2. **Look for a refused projection.** "Knowledge rebuild refused" means a rebuild would
   have replaced the corpus with an empty or drastically smaller one and was rejected;
   your existing corpus was preserved. The refusal record names the reason and survives
   a restart.
3. **Rebuild explicitly** if the corpus is genuinely empty and the provider is healthy:
   submit a `rag_rebuild` background job (requires `rag:manage`). It is idempotent and
   safe on a healthy deployment: it either converges on the same corpus or refuses and
   leaves the existing one intact. See [background jobs](background-jobs.md).

A reconciliation warning (*"the corpus holds N analyst-confirmed precedent documents
but the case history qualifies M records"*) is the early warning for this failure. The
corpus is a projection of the case history, so a large divergence means the projection
broke, not that the history is small. Note that `N` is expected to be smaller than `M`
whenever `M` exceeds the precedent window size; only a large shortfall is reported.

If a rebuild legitimately produces a much smaller corpus (you disabled sources on
purpose), lower `rag.min_projection_retention`, or set it to `0` to disable the ratio
guard. A projection reaching **zero** is refused regardless; that is never a
legitimate rebuild of a non-empty corpus, and no setting changes that.

A release that deliberately replaces a source's documents with a new document-id
scheme records a corpus-migration marker (KV namespace `rag_corpus_migration`). With
that marker, a build on either side of the migration (after an upgrade, or after an
image-only rollback) replaces the other build's documents instead of refusing at the
retention floor, and logs `RAG projection replaced a marked corpus migration` at INFO.
A refusal at the retention floor right after a rollback to a build without markers
(before this contract) is the corpus-migration case; see
[Upgrades](upgrades.md#rolling-back-from-round-14).

Narrowing `precedent.window.size` to drop unwanted precedent is a shrink like any other
and can therefore trip the same ratio floor. When the refusal is attributable to that
(the precedent source shrank to within the new window while every other knowledge source
held steady), health reports it as a refused **window reduction** rather than as a corpus
loss. Nothing was destroyed and the model provider is not implicated; lower
`rag.min_projection_retention` to let the intended reduction through.

## The knowledge corpus rebuilt, but auto-close is still wrong

A rebuild that succeeds proves only that a projection completed. The retention guard is a
**size** guard: a reprojection that keeps the same number of records and reverses every
one of them passes it cleanly.

Read **`GET /api/diagnostics/precedent-composition`** before and after any rebuild. It
costs nothing (no embedding calls, no writes) and reports what the corpus holds beside
what a rebuild would produce, cross-tabulating the analyst-confirmed outcome against the
model's own verdict. Counts per outcome alone are the trap: a corpus that is entirely
"false positive" reads as a clean benign baseline even while every one of those records
also says the agent escalated it.

If the report shows the qualifying **pool** is skewed the same way the selected window is,
rebuilding cannot help: the projection selects the newest qualifying cases, so it will
re-select the same records. Fix the ground truth instead; see
[excluding a precedent record](../intelligence/knowledge-memory.md#excluding-a-precedent-record)
for how to evict individual records so they stay evicted, and check the admission
concentration in the same report to see whether one bulk analyst action bought most of
the window.

## Escalation package

Provide sanitized build info, deployment shape, state backend, failing endpoint/status,
reproduction steps, relevant timestamps, expected/actual behavior, and whether the
problem reproduces with synthetic data. See [Security hardening](security.md) before
sharing diagnostics.
