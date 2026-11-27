# Release preparation: PostgreSQL receipt

WP19 measures what [rel] B4 and B5 ask of the 0.2.0 release preparation on a local
PostgreSQL 16, and records what it could not run as maintainer action M5. It changes no
product code. The scripts are throwaway Python in the build scratchpad, outside the
repository; the database was a scratch cluster created for the run, then stopped and
deleted. No database file is committed.

## Environment

- **Database.** PostgreSQL 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1) with pgvector 0.6.0, a
  fresh scratch cluster on 127.0.0.1 at default settings (`shared_buffers` 128 MB,
  `max_wal_size` 1 GB), on the same host as the client.
- **Host.** 4 vCPU (Intel Xeon, 2.10 GHz), 16 GB RAM, one virtio disk. No other load.
- **Code.** The 0.2.0 backend of this checkout (its `backend/app` is byte-identical to
  `4e32d29`; WP19 changes records only), on Python 3.11.18 with `backend/.venv`. The
  v0.1.1 backend is `ba179651a7b63d6352ad346fd633e1460f3a4d39` from `git archive`, in its
  own virtual environment from its own pinned `requirements.txt`.

## B4: the `audit.id` widening

### Method

1. Create the audit table exactly as v0.1.1 creates it: `id SERIAL` primary key,
   `ts VARCHAR(64) NOT NULL`, `case_id VARCHAR(255)`, `action_type VARCHAR(64) NOT NULL`,
   `doc JSON NOT NULL`, and the indexes `ix_audit_case_id`, `ix_audit_ts` and
   `ix_audit_case_ts`.
2. Fill it with N rows shaped like the v0.1.1 poll audit row (the `AuditDoc` key order of
   `engine/poller.py` at `ba17965`, 365 bytes of JSON per row, a distinct timestamp per
   row three seconds apart):

   ```sql
   INSERT INTO audit (ts, case_id, action_type, doc)
   SELECT t.ts, NULL, 'poll', ('{"ts": "' || t.ts || '", "case_id": null, ... }')::json
   FROM (SELECT to_char((timestamptz '2025-01-01 00:00:00+00' + g * interval '3 seconds')
                        AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') AS ts
         FROM generate_series(1, :rows) AS g) AS t;
   ```

3. `VACUUM ANALYZE audit`, then `CHECKPOINT`, so the timing starts from a settled table.
4. Time one call of the backend's own `app.stores.sql.engine.ensure_schema_migrations` on a
   fresh engine, as the backend runs it at start. It issues
   `ALTER TABLE audit ALTER COLUMN id TYPE bigint` and `ALTER SEQUENCE audit_id_seq AS bigint`
   and logs "Migrating audit.id from integer to bigint".
5. Read back the column and sequence types and the row count, then call it a second time to
   see a later start do nothing.

### Results

| Rows | Table with indexes | Heap | Widening | Second start |
|---|---|---|---|---|
| 1,000,000 (run a) | 611,655,680 B (0.61 GB) | 455,114,752 B | 4.91 s | 0.014 s |
| 1,000,000 (run b) | 611,655,680 B (0.61 GB) | 455,114,752 B | 4.05 s | 0.018 s |
| 5,000,000 | 3,057,836,032 B (3.06 GB) | 2,275,557,376 B | 24.99 s | 0.015 s |
| 10,000,000 | 6,115,549,184 B (6.12 GB) | 4,551,114,752 B | 44.3 s | 0.015 s |

In every run the status was `ok` with "audit.id widened to bigint", the column and the
sequence both read `bigint` afterwards, the row count was unchanged, and the second start
reported "audit.id is bigint" and changed nothing. The rewrite costs about 7 to 8 seconds
per GB of table here, roughly linear in size. The rewrite builds a new copy of the table
and its indexes, so it needs free disk of about the table's size; the scratch table was
dropped at the end.

### Decision

10 million rows took 44.3 s, well under the 200 s line, so the signed plan keeps its
300-second backend rollout timeout (`scripts/build_upgrade_plan.py`
`--backend-timeout` default 300; `release.yml` passes no override). The figures are written
in `docs/releases/0.2.0.md` (Upgrade steps), `docs/operations/upgrades.md` (the audit id
column) and `docs/releases/known-limitations.md`, with the size query an operator runs
first, the free-disk note, and the SQL that runs the same widening ahead of the update
for a large table. A host with slower storage scales by its own rate.

## B5: the v0.1.1 rollback rehearsal

### Method

`scripts/rollback_lane.py` alone cannot pass against v0.1.1: its checks of the earlier build
include the jobs route and the `runbooks.*` choices that v0.1.1 does not have. The rehearsal
is a throwaway driver built on the lane's own `Lane` class (its boots, its release-N phase
and plants, its assertions), in the order of a real field upgrade:

- **A.** v0.1.1 boots first on a fresh scratch database and writes its own state: the
  32-bit `audit.id`, its settings (`budget.daily_usd` 7.5) and its audit rows.
- **B.** 0.2.0 boots on that database and runs the lane's release-N phase: the settings, an
  audit export job, the migrated runbook corpus, the Round 15 plants (an auto-close review
  and a screenshot on an agent-closed case) and the Round 16 plants (a case with recorded
  risk inputs, its rated ledger row, a locked account, a What's new marker).
- **C.** v0.1.1 boots again on the data 0.2.0 wrote. Each check is recorded, not aborted.
- **D.** 0.2.0 boots again and reads what the rollback left.

It ran twice: once with v0.1.1 saving cases, an account, the preferences and the settings
in step C (the write variant), and once with v0.1.1 only reading (the read-only variant).

### Results

The write variant passed 37 of 38 checks; the read-only variant passed 32 of 33. The one
failing check is the same in both.

- **A.** v0.1.1 starts ready and healthy; `audit.id` and its sequence are `integer`.
- **B.** 0.2.0 starts, logs the widening, and `audit.id` and its sequence read `bigint`.
  v0.1.1's `budget.daily_usd` of 7.5 survives the 0.2.0 migration. The release-N phase
  completes.
- **C.** v0.1.1 answers `/api/health/ready` with 200 and `/api/health` with `ok` (no
  degraded reason). It lists both cases 0.2.0 wrote and opens them (the risk case open at
  38.31, the reviewed case closed). In the write variant it saves both with a comment,
  reads the audit log (13 rows of 13, the 0.2.0 rows included), appends a settings audit
  row with a positive id into the `bigint` column (id 11 after 10), reads the case spend
  from the ledger row 0.2.0 wrote (1 call, 0.0006), lists and saves the locked account,
  and reads and saves the personal preferences (the What's new marker `0.2.0.2026-12` is
  readable). Its log holds no traceback, no error line and no safe stop, and it stops
  gracefully.
- **D.** 0.2.0 starts healthy. The risk case v0.1.1 saved reads "not recorded" with its
  score and factors unchanged and the comment kept; in the read-only variant it still
  reads its recorded inputs. The ledger row keeps its rates. The lock counter of the
  account v0.1.1 saved is reset; in the read-only variant it is kept. The What's new marker
  and the theme survive. The review grade stays excluded from agent statistics. The
  screenshot lists and serves. `audit.id` stays `bigint`.
- **The failing check: settings v0.1.1 does not model are reset.** Back on 0.2.0,
  `runbooks.auto_attach` reads its default instead of the value release-N set. The
  read-only variant shows the cause: the settings document is unchanged while v0.1.1 runs
  and only reads, and its graceful stop rewrites it without what its model lacks. A
  settings save v0.1.1 makes does the same. Dropped are the sections
  `analyst_rule_policies`, `auto_close_review`, `chat_agent`, `evidence_fields`,
  `evidence_max_chars_per_event`, `precedent`, `replay_capture`, `resilience` and
  `team_activity`, and these keys inside surviving sections:
  - `caps.request_timeout_seconds`;
  - 19 `enrichment.use_*` switches (the Round 11 providers);
  - `rag.min_projection_retention`, `rag.unconfirmed_precedent`,
    `rag.use_unconfirmed_resolved_cases`;
  - `rbac.rbac_grants_version`;
  - `runbooks.ai_step_drafts`, `ai_suggest`, `auto_attach`, `fallback`,
    `investigator_guidance`, `rag_corpus`, `require_distinct_approver`,
    `review_every_days_default`, `runbooks_config_version`, `step_approvals`;
  - `session_policy.remember_me`;
  - `threshold_tuning.auto_apply_confirmed`.

  This is v0.1.1's behaviour, not a 0.2.0 defect, and nothing 0.2.0 ships can change it.
  It is documented as "Rolling back to v0.1.1 resets the settings it does not model" in
  `docs/releases/known-limitations.md`, in the 0.2.0 release page's Rollback section and in
  `docs/operations/upgrades.md`, with the instruction to note changed values and set them
  again after the return.

### Pass condition recorded

The narrower pass condition for v0.1.1 is the list in C and D above: it starts and stays
healthy on 0.2.0 data, reads and writes cases, audit and accounts, reads the ledger, and
0.2.0 starts healthy again afterwards with the documented per-document losses. The settings
reset is the documented exception.

### Not covered

- The published v0.1.1 images through the updater on a Docker host (the image-level
  rollback), and the canonical bootstrap. Both stay maintainer action M5, with the command
  in the release page.
- Elasticsearch and SQLite state backends; this receipt is PostgreSQL only.
- A rollback under load, or with Redis and a live log source attached.
