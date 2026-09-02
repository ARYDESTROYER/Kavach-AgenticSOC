# Replay harness (`replay_experiment`)

What this harness can and cannot answer.

This harness compares replay configurations that are run now, against one pinned corpus snapshot and one frozen fixture set. It cannot answer a retrospective question about a change that has already shipped, and it does not try to.

Rebuilding a past investigation is not possible in this system. The only two paths from a stored case back to its alert content either re-query the live log surface — whose contents roll with retention and whose relative time windows resolve against the present — or synthesise placeholder events with the record content stripped. No snapshot of the knowledge corpus as it stood before an earlier change exists either. A comparison between a replay run now and outcomes logged earlier would therefore mix at least two changed variables and would be uninterpretable. That comparison is refused by this API rather than discouraged in prose: there is no parameter through which it can be expressed.

Fixture capture runs forward. What is captured from now on is what the next change can be measured against.

An insufficient-evidence result stays insufficient evidence. It is never converted into a score, a percentage, a rate, or a recommendation. A difference that does not clearly exceed this run's own measured self-consistency floor is reported as indistinguishable from noise, and that judgement appears as a machine-readable field, not only as prose.

---

## What the harness is

A durable Job (`JobKind.replay_experiment`) that replays FROZEN investigation fixtures
through one or two named **arm configurations**, now, against **one pinned corpus
snapshot**, and scores close-eligibility per fixture with the production
`case_manager.decide()` called offline.

An **arm is a replay configuration**, never a historical period or a shipped build.
Both arms replay the same fixtures against the same corpus in the same job, interleaved
per fixture. The submit contract (`ReplayExperimentParams`, `extra="forbid"`) has no
parameter through which a comparison against logged history could be named, so that
comparison is refused rather than discouraged.

## Fixture capture

Capture is **ON by default** and runs FORWARD. One fixture is captured per investigated
cluster at the single point in `agents/pipeline.py` where the cluster, the enrichment
result and the deterministic risk are all final and no model has been called — so a
fixture can never encode the outcome a later replay is meant to measure. Capture is
error-isolated: a sink failure leaves the case byte-identical to a run with no sink.

Each fixture pins the cluster (with every member event's raw record), the enrichment
result that produced the risk score, the RESOLVED evidence projection
(`evidence_fields` + `evidence_max_chars_per_event`) in force at capture time, and the
capturing source's effective **field mapping** — the per-source overlay (`time_field`,
the entity/rule/severity/message fields, the entity strategy and the rule scope) that a
non-ECS source needs for its frozen records to be readable at all. Without it a replay
would query the frozen index with the global ECS defaults and the investigator's log
tool would return nothing where production returned real evidence. It deliberately does
**not** pin any secret, the whole `Preferences` object, a whole `SourceInstance.config`,
the corpus, or any model output.

A cluster whose contributing sources DISAGREE on a mapping key has no single faithful
frozen surface — production applied each connector's own overlay while normalising, and
one frozen connector cannot. Such a cluster is not captured at all, and the skip is
counted as `skipped_mapping_conflict`.

The log-bearing half of a body is stored as ONE opaque canonical-JSON string. The
shared KV document space is dynamically mapped on the Elasticsearch state backend, so
storing attacker-named log field paths as document field NAMES would let one
heterogeneous record consume that index's field budget or collide on type with another
source's record. One string field per body can do neither. (Dynamic-mapping growth of
that shared index from the existing Round-3/4 KV stores is a broader, PRE-EXISTING
condition — `stores/jobs.py` alone adds tens of field paths per job row — that this
harness does not fix; it only declines to become a new, log-derived contributor.)

The frozen log surface (`raw_hits`) is DERIVED from the cluster's own member events at
load time and is never persisted: storing it would duplicate every raw record inside the
per-fixture byte cap, halving the evidence a fixture may hold before it is skipped
whole, and would be the only way the log source and the cluster could ever disagree.

### The storage bound is structural

Fixtures live in the existing shared KV (`replay_fixtures` namespace) as one catalog
document plus a **fixed-size ring of body slots** — no new index, table, or migration.
A fixed slot ring rather than one key per fixture because `KVStore` has no delete
primitive; slot `seq % ring_size` is simply overwritten.

Worst case storage is `ring_size * max_fixture_bytes` — at the defaults, **100 x
128 KiB = 12.5 MiB**. That bound is kept true across a CONFIG CHANGE, not only in
steady state: lowering `ring_size` drops the higher slots out of the catalog, and every
slot the catalog stops naming is scrubbed at the moment it is evicted. Without that,
those bodies would be unreachable to both the ring and the purge — an operator lowering
retention to hold LESS raw log data would instead make the old records permanent.

Lowering `max_fixture_bytes` applies to future captures only; bodies already stored are
not re-checked against a tightened cap, so `ring.max_bytes` is reported as the larger of
the configured product and what is actually stored, never as an understatement.

A body over the byte cap, or a cluster over `max_events_per_fixture`, is skipped
**whole**: never truncated, never sampled, because either would silently change the
evidence a replay is scored on. Every skip is counted and reported.

| Setting | Default | Meaning |
| --- | --- | --- |
| `replay_capture.enabled` | `true` | The off-switch. |
| `replay_capture.ring_size` | `100` | Retained fixtures; the oldest is evicted. |
| `replay_capture.max_fixture_bytes` | `131072` | Per-fixture ceiling; a larger fixture is skipped whole. |
| `replay_capture.max_events_per_fixture` | `50` | Member-event ceiling; a larger cluster is skipped whole. |

`GET /api/replay/fixtures` reports `skipped_oversize`, `skipped_too_many_events` and
`skipped_mapping_conflict` alongside the ring's used/capacity/bytes.

### Privacy

A fixture holds raw log records — addresses, account names, hostnames, command lines,
URLs — which is strictly more than a Case retains. Fixtures are stored in the
deployment's own state store and are **never returned by any API**. Three controls
remove them, all of which scrub the body slots and not merely the catalog:

* the **cases** and **sources** tiered resets, which report `kv:replay_fixtures:<n>` on
  the receipt — a fixture outliving the case it was captured from would keep more log
  content than the deleted Case ever held;
* the **factory** KV purge;
* `DELETE /api/replay/fixtures` (`models:manage`), on demand.

The on-demand purge sweeps the whole slot space the catalog has ever addressed (its
`ring_capacity` high-water mark), not merely the slots it still names, so it stays
exhaustive after the ring has been shrunk.

## Running one

Submit a `replay_experiment` job (`models:manage` + `cases:read`):

```json
{
  "kind": "replay_experiment",
  "idempotency_key": "...",
  "params": {
    "fixture_ids": ["fx-..."],
    "arms": [{"arm_id": "baseline"}, {"arm_id": "candidate", "rag_top_k": 8}],
    "repeats": 2,
    "spend_bound_usd": 5.0,
    "alpha": 0.05
  }
}
```

An arm may pin per-role models and a short allow-list of retrieval/context toggles.
Everything else is held identical by construction: the fixture bytes, the evidence
projection, the corpus and memory snapshots, the frozen log source and its time anchor,
the enrichment seed, correlation/risk/asset configuration, the auto-close policy,
analyst rule policies, and every threshold block. `base_url`/`region` are deliberately
not overridable — a job parameter must not be able to open a new egress endpoint.

The run is refused, having spent nothing, when the knowledge corpus is empty, larger
than `corpus_chunk_limit`, mixes embedding spaces, or is embedded in a different space
than queries would use. A silent zero-knowledge experiment is worse than no experiment.

## Spend

The gateway is **real** — real providers, real money — because a mock proves nothing
about model behaviour. Consequences, stated plainly:

* Every usage row lands in the **real** ledger, tagged `surface = "replay"` — ONE
  stable, low-cardinality bucket, deliberately not one per run. `UsageStore.summary`
  keeps only the ten most expensive surfaces, so a per-run key would occupy a slot per
  run and silently evict real production surfaces from the operator's cost view, which
  no consumer-side filter can repair. That tag makes replay spend **identifiable**;
  version 0.1.13 ships **no** automatic exclusion, so a replay's spend does appear in
  the Cost page's headline total and in `by_surface` alongside production spend. Size
  `spend_bound_usd` accordingly, and filter on the `replay` surface if you export the
  ledger for reporting. PER-RUN spend is reported by the job record's own `spend` block
  and by its keyed `replay-spend` audit row, not by the ledger's surface dimension.
* Replay spend **counts against the deployment's configured daily/monthly budget**,
  because it is real money. The tenant budget gate is consulted first, so a replay can
  never push the deployment past its own ceiling.
* One keyed audit row (`action_type=job`, `event_id=job:<id>:replay-spend`) names who
  spent how much and on what.

`spend_bound_usd` is a **required** job parameter with no default. It is enforced
**both** pre-flight and post-hoc:

1. before every completion, through the gateway's own pre-flight, on an estimate that
   is worst-case in the OUTPUT dimension (`max_tokens` priced as output);
2. before every embedding, which the gateway deliberately does not budget-gate;
3. on realised actuals at every fixture and **cell** boundary.

Exceeding the bound **CANCELS** the job (cooperative cancellation through the Jobs
subsystem). It never truncates silently and **never overruns by a whole call**. The
residual, stated precisely: the pre-flight estimate approximates INPUT tokens at four
characters per token, so a call whose real tokenisation is denser and whose completion
saturates `max_tokens` can record slightly more than it estimated. Realised spend can
therefore exceed the bound by at most the estimation error of one call — errors cannot
accumulate, because the accrued actual is re-read before every call — and the
cell-boundary check then trips and cancels. Any cell produced after the trip is excluded
from every rate and from the paired table, because a blocked completion surfaces as
`NEEDS_HUMAN` — precisely the metric under study.

The bound is **per job, and a job spends in exactly one attempt.** A run's accrual is
read from a run-scoped ledger mirror that a new worker cannot reconstruct after a
restart, so a recovered replay is REFUSED rather than resumed: resuming would hand the
remaining fixtures a fresh, untouched copy of the ceiling and let one interruption spend
it twice. The refusal spends nothing, names itself in the job's failure record, and
leaves the first attempt's spend visible in the ledger and in its audit row; submit a new
run for the remaining fixtures.

Cancellation, live authority and the lease are observed at the **cell** boundary, not
the fixture boundary, because a cell is the unit of billable work: a fixture-only
checkpoint would let up to `arms * repeats` full investigations run after an operator
pressed Cancel, and a single-fixture run would ignore Cancel entirely.

## Isolation

Cases, audit, threads, activity, tasks, inbox, proposals, tuning, campaigns, baseline,
batch, noise counters, the vector store and the event bus are all isolated on a fresh
in-memory client per **cell** (one `(fixture, arm, repeat)` triple), exactly as Demo
Mode does it. Per-cell rather than per-run so arm B cannot attach to the case arm A
saved for the same signature and inherit its verdict for free.

Two deliberate exceptions: usage (above), and the Job's own `action_type=job,
surface=jobs` lifecycle rows plus the one spend row. Those lifecycle rows are not
avoidable for any Jobs-hosted work — the runner refuses to claim work or project a
terminal transition while a transition is unaudited (#2) — so the isolation guarantee is
stated precisely: **a replay writes zero rows to the production case store, and zero
rows to the production audit log other than the job's own lifecycle transitions and one
spend-accountability row.**

Notifications, HITL automation and case-number allocation are wired off; the replay
never pages anyone, opens a real proposal, or burns a real case number.

## Scoring

* **Close-eligibility** is derived by importing and calling the production
  `case_manager.decide()` read-only against the deployer's configured `AutoClosePolicy`.
  It is never copied, reimplemented, wrapped-and-modified, or monkeypatched, and never
  inferred from the config schema — `policy.needs_human` is a real settable field that
  `_entry_for` ignores outright, so only behaviour is authoritative. Comparison excludes
  `objection_window_expires_at`, which `decide()` stamps from the wall clock.
* **Pairing** is per fixture. McNemar operates on the discordant cells of the 2x2 paired
  table, using the **exact binomial** test, **two-sided** — emitted machine-readably as
  `test: "mcnemar_exact_binomial"`, `alternative: "two_sided"`, and compared against
  `alpha` on that two-sided scale. The continuity-corrected chi-square, itself a
  two-sided statistic, is reported only alongside it. `p_exact` is never emitted without
  `a`, `b`, `c`, `d` and `n_pairs` in the same object, and never at all on a path whose
  verdict is `insufficient_evidence`: an insufficient result ships its raw counts, and
  no rate, difference or p-value beside them.
* **The noise floor comes first.** Before any arm-versus-arm claim the harness measures
  each arm's self-consistency from this run's own repeats. It is measured, never
  assumed: the shipped default completion family drops the configured temperature
  entirely at the provider boundary while other providers send it, so the floor is
  deployment- and model-specific. `repeats < 2` forces `insufficient_evidence`, and so
  does a floor resting on fewer comparisons than the paired table it would gate
  (`reason: "noise_floor_undersampled"`, with `noise_floor_coverage` beside it).
* **The floor guard compares like with like.** `rate_difference` is a NET signed
  difference, so it is tested against the largest NET close-rate swing any arm shows
  against ITSELF (`pooled_close_rate_swing`), never against the GROSS per-fixture flip
  rate `pooled_close_disagreement_rate` — a different quantity on a different scale,
  which is reported separately along with the between-arm `gross_discordance_rate`. When
  no arm flipped any fixture, the guard uses the zero-event upper limit at the run's own
  `alpha` instead of treating `0/n` as evidence of a zero floor. `noise_floor_basis` and
  `noise_floor_value` name what was actually compared.
* **`exceeds_noise_floor` is a conjunction, and its parts are reported separately.**
  `above_noise_floor` is the floor comparison alone, `significant_at_alpha` the test
  alone; both are `null` — never a measured `false` — where no comparison was performed.
* `arm_comparison.verdict` is machine-readable and is exactly one of
  `insufficient_evidence`, `no_discordant_pairs`, `indistinguishable_from_noise`,
  `underpowered`, or `difference_exceeds_noise_floor`. `underpowered` means the
  difference cleared the floor but this many discordant pairs cannot reach `alpha` under
  ANY split — "add fixtures", not "no effect". **No composite score is ever produced.**
* **Every rate ships with its denominator, and a rate with a zero denominator is
  `null`.** `arms[].close_eligible_rate` is computed over the PAIRED fixture population,
  so it equals `arm_comparison.rate_a`/`rate_b` by construction; the arm's own figure is
  kept separately as `close_eligible_rate_unpaired` beside `primary_scored`. `scored`
  pools every repeat while `close_eligible` counts repeat 0 only, so both bases are
  labelled (`pooled_basis`, `close_eligible_basis`).
* **The report records the decision policy** (`policy.fingerprint` plus the values
  behind it, echoed in `manifest.json`). `close_eligible` is a function of the auto-close
  policy and the two escalation thresholds, so an artifact without it cannot be paired
  with another safely.
* Excluded cells (`analyst_policy`, `spend_bound`, `pipeline_error`, `fixture_aborted`,
  `fixture_unavailable`) leave every denominator entirely and are reported per reason. A
  fixture that fails part-way leaves BOTH arms (`fixture_aborted`), so the surviving
  pairs stay symmetric. An unavailable fixture or an interrupted item is never counted as
  a measured zero.

## What each statistic does NOT prove

| Statistic | Does not prove |
| --- | --- |
| `arm_comparison.p_exact` | That the difference generalises beyond this fixture set. Fixtures are the newest N investigated clusters in a bounded ring — not a random sample of alert traffic and not a calendar-time cohort. |
| `arms[].close_eligible_rate` | A production close rate. Every replayed case is a FIRST investigation against an empty case store, and the rate is computed against the deployer's CURRENT policy (recorded as `policy.fingerprint`), not the policy in force at capture. |
| `arms[].close_eligible_rate_unpaired` | An arm-versus-arm effect. It is computed over that arm's own surviving fixtures, so when exclusion was one-sided the two arms' unpaired rates are over DIFFERENT populations and must never be differenced. `arm_comparison.rate_a`/`rate_b` are the only paired rates. |
| `arm_comparison.exceeds_noise_floor` | That a `false` means "no effect". It is the conjunction of `above_noise_floor` and `significant_at_alpha`; read those two, and `verdict`, to tell "below this run's instability" from "too few discordant pairs to test". |
| `noise_floor.per_arm[].close_disagreement_rate` | The quantity the arm guard uses. It is the GROSS per-fixture flip rate; the guard compares NET against NET. A floor is also only as good as the `compared` count beside it that survived exclusion. |
| `noise_floor.*` | A general stability figure. It bounds the sampling variability of this model, at this configuration, over these fixtures, in this run only. |
| `retrieval.*` | Retrieval quality or hit rate. It measures reference IDENTITY only. `noise_floor.per_arm[].retrieval_compared` is the authority for whether retrieval was observed at all; a zero there means the rate is `null`, never a stable `0.0`. |
| `spend.accrued_usd` | A projection of production cost per case. The population is more expensive and the models may differ. |
| `corpus.fingerprint` | Anything about whether the pinned corpus resembles an earlier state. It proves only that both arms saw the same corpus. |

## Fidelity notes

- Every replayed case is a first investigation against an empty case store; the no-material-change short-circuit and every attach path never execute.
- Enrichment is served from a frozen cache, so a tool observation is reported as cached.
- The platform threshold-tuning audit snapshot is absent in replay; it is an audit annotation and never a prompt input.
- Query time windows are anchored to each fixture's capture instant, so a relative window resolves identically in every cell.

## Artifact

One verified ZIP, downloadable through the Jobs artifact channel:
`manifest.json`, `report.json`, `cells.ndjson`, `pairs.ndjson`, `limitations.txt`. No
member carries raw log content, evidence text, prompt text, model output text, or a
secret — only ids, hashes, enums and numbers.

## Comparing two builds

The harness cannot execute two code builds in one process, and it does not pretend to.
The supported procedure is manual and mechanical:

1. capture fixtures forward on the deployment;
2. run the harness once per checkout against the **same** `fixture_ids`;
3. pair the two artifacts offline by `fixture_id`.

That pairing is valid **only if both artifacts report the same `corpus_fingerprint`
AND the same `policy.fingerprint`**. The corpus is one causal input to a replayed
verdict; the auto-close policy is the other, and a routine Settings edit between the two
runs flips `close_eligible` with no other trace. The harness emits both precisely so the
check is mechanical; it does not automate the pairing.

Two caveats on the corpus fingerprint. It fixes the pinned ORDER as well as the content
— the pin is sorted on exactly what the fingerprint hashes, because neither persistent
vector store defines a read order and the in-memory store breaks equal cosine scores by
insertion order. But it hashes text, `doc_id`, `source`, `embedding_model` and `dim`,
**not** the stored vectors, so a silent re-embed within the same model and dimension
would not move it.

On a CANCELLED run the paired comparison is suppressed to `insufficient_evidence`, so no
arm-versus-arm rate is available at all — such an artifact cannot be paired.

## Scope

Below-floor `$0` candidates (clusters that never reach an investigation) are out of
scope for this version: they produce no `(verdict, confidence, risk_score)` triple and
so cannot enter a close-eligibility paired table. Tick-scoped replay of the
auto-forward routing gate is likewise out of scope.
