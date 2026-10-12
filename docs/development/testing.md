---
title: Testing
description: Backend, Console, API-contract, version, documentation, and release validation gates for Agentic SOC 0.1.
---

# Testing

Agentic SOC changes are accepted on `Testing` only after the relevant offline, contract,
build, and documentation gates pass. Stable promotion moves that accepted source
tree through a protected pull request to `main`; the resulting commit is gated again
before application version `v0.1.13` is tagged.

The latest fully recorded local baseline is **7,526 backend tests** (4 skipped) and **4,750
Console tests (1 skipped) across 466 files**. The
Console baseline also has zero stderr bytes and zero Vitest-captured console stdout
blocks under `npm run test:strict`. Counts rise as coverage is added; the commands
and zero-failure result are the contract, not a frozen target.

The remote uses `Testing` for integration and default `main` for accepted Stable
source. Version 0.1.13 is a candidate on `Testing` and is Stable only when the
resulting verified `main` commit has the immutable `v0.1.13` tag and matching
artifacts. Branch protection, required checks,
Pages source selection, and `github-pages` environment policy are repository settings;
verify them independently before treating a merge or deployment as accepted.

The immutable `v0.1.10` tag passed source/tag CI but its signed-release job timed
out during the emulated arm64 Console build. It has no complete signed image set,
canonical plan/bundle, GitHub Release, Stable tags, or supported bootstrap path;
preserve it as historical evidence and never move, reuse, repair, install, or
bootstrap from it.

## GitHub merge gate

Every pull request receives nineteen visible statuses from
`.github/workflows/ci.yml`: eighteen independently diagnosable quality lanes plus the
aggregate **CI passed** result. In addition to repository, backend, Console, API,
design, documentation, and package checks, the gate boots the supported
PostgreSQL+pgvector/Redis state path, validates workflows and shell separately from
deploy/updater contracts, rejects fatal Python correctness faults, and builds all
three shipping images. The aggregate runs even when a dependency fails or is
cancelled and succeeds only when all eighteen
report success.

Branch protection needs only the stable aggregate name **CI passed**. Requiring that
single fail-closed result keeps protection intact if an internal job is renamed while
still preventing a skipped or cancelled lane from passing a merge. The exact job-to-
command parity guidance is maintained in the repository's root `CONTRIBUTING.md`;
the workflow itself remains authoritative for inline service and container probes.

## Backend suite

The backend tests use fake Elasticsearch, mock model providers, and SQLite for SQL
repository coverage. They do not require production credentials or a live SIEM.

```bash
cd backend
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements-dev.txt
python -m pytest -q
```

Run a focused file or test while iterating, then run the complete suite before
acceptance:

```bash
python -m pytest tests/test_api.py -q
python -m pytest tests/test_api.py::test_name -q
```

Tests that touch pipeline behavior should assert fail-safe human routing, audit writes,
usage ledger writes, cursor/idempotency behavior, and the deterministic case-manager
boundary as applicable. Every new state-changing route needs an authorization test.

## Console suite

Install exactly from the lockfile and run all product gates:

```bash
cd webui
npm ci
npm run typecheck
npm run lint
npm run gates
npm run test:strict
npm run build
```

Component/page tests should cover loading, empty, error, populated, and permission-
denied states. Interaction tests should use user-observable behavior and include
keyboard/focus/accessibility assertions where the component is interactive.

Use plain `npm test -- <file-or-pattern>` for focused iteration. The release-only
`npm run test:strict` command first tests its own output parser, then runs the complete
suite and fails if Vitest writes any stderr byte or reports any captured `console.log`
block. CI uses the strict command; the focused developer path remains direct and
argument-friendly.

### Release-candidate browser acceptance

The complete Console suite is necessary but does not replace browser acceptance. For
every Stable candidate, inspect the exact built candidate through the supported same-
origin proxy and record the build SHA, application/channel badge, browser, viewport,
theme, and result in a dated release receipt. Use at least one desktop viewport at or
above 1280 CSS pixels and one narrow viewport at or below 767 CSS pixels. Exercise
Light, Dark, and System; System must be checked against both device preferences across
the receipt or linked automated evidence.

| Area | Required browser path |
| --- | --- |
| Identity and setup | Sign-in username → password flow, optional demo/SSO controls when configured, theme switch, error/retry, software-keyboard-safe narrow layout, first-run setup progress/content/footer, and close/re-run behavior |
| Overview | Dashboard time/refresh controls, KPI and case drill-down, Latest Cases hover and focus detail, Noise Reduction expand/close, custom Dashboards, and Standup |
| Triage | Cases filters/table/loading and exact Case Manager handoff; Case Manager Active/All queue, resize/keyboard reset, selection/bulk menu, Overview/Timeline/Investigation/Threat context/Collaboration/Chat tabs, Campaigns, Logs, Workspace Chat/history, Entity investigation, and Approvals |
| Intelligence and analytics | Knowledge corpus, Reference runbooks, Operator memory, Response playbooks, Agent personas, Metrics, Agent effectiveness, Cost, Models, Baseline, Batch jobs, and Auto-tuning Operations/Outcomes/Policy & history |
| Platform and help | Sources catalog/detail/health, Audit log, Settings section search/deep links/dirty state/sticky actions, narrow Settings Sheet, appearance/branding isolation, and the in-app Help Center plus an installed `/docs/<major.minor>/` article |
| Release update | Current release badge/popover; mutable Stable candidate versus signed preflight; unsupported-supervisor/manual boundary; blocker remediation; reauth and known-dirty blocking; durable progress/reconnect; cancellation-before-switch; automatic rollback; post-success image-only rollback; successful same-hash-route activation |
| Compatibility paths | Hidden or consolidated bookmarked routes load or redirect to their documented replacement without reappearing in primary navigation |

For Auto-tuning, verify Collecting/Within target/Needs attention classification,
search and state filters, inspector open/close, one grouped action per rule, mixed
safe/restricted outcomes, same-rule busy locking with unrelated rules still enabled,
permission-isolated Outcomes loading, dirty policy preservation, newest-active
rollback, and no horizontal overflow in Light/Dark desktop and 390px layouts.

For release update, separate mutable discovery from immutable authority. A newer
Stable branch `VERSION` plus supervisor capability may display a candidate only when
the exact annotated `vVERSION` tag dereferences to an immutable commit; branch HEAD is
review metadata, not the candidate commit. It must not become confirmable until the
backend derives the canonical GitHub Release assets and signed updater preflight
returns zero blockers. Exercise unavailable,
stale, same-version, malformed release, bad signature, wrong workflow/repository/tag/
commit, unsupported source version, SQLite/Elasticsearch/custom topology, unhealthy
Postgres/updater, canonical base-Compose hash mismatch, insufficient backup capacity,
concurrent job, runtime-only secret,
and expired preflight-token paths. Separately verify that private/missing registry
images and digest/label mismatches fail after job creation but before application
mutation. Every denial or failed job must remain usable and provide exact remediation
without sending host paths, commands, Compose fragments, registry credentials, or
Docker authority to the browser.

Before release publication, start the exact digest-pinned updater with the production
read-only root filesystem, `cap_drop: ALL`, `no-new-privileges`, and mounted state,
backup, control, and runtime volumes. Assert its image-baked `TUF_ROOT` is exactly
`/var/lib/agentic-soc-updater/sigstore-root`, that the path is writable on the state
volume, and that the running supervisor's own cosign verifies the canonical signed
plan. A host-injected `TUF_ROOT`, alternate entrypoint, writable root filesystem, or
source-only signature check does not satisfy this release gate.

Exercise the complete supported job against an isolated copy of the reference
single-replica PostgreSQL Compose stack. Assert pull-before-mutation, quiesced and
catalog-verified custom-format backup, exact backend/Web identity and readiness,
installed Help Center checks, observation window, durable progress across backend and
updater handoff, and same-hash-route browser reload. Inject failure before switching,
after backend switch, after Web switch, and during observation. An automatic
post-switch failure must restore prior images without rewriting PostgreSQL and must
preserve a sentinel write accepted after the backup. Cancellation before switch and a
rollback requested after success must also restore images only. Prove the verified
dump remains available for an explicit break-glass recovery rehearsal, but is never
consumed automatically. Any plan with a migration strategy other than `none` must fail
preflight.

Verify the one-time pre-supervisor/source-built→v0.1.13 bootstrap separately from
later Console updates:
it must refuse a dirty checkout, a lightweight/mismatched tag, a tag whose commit is
not contained in `origin/main`, missing durable secrets, an unsupported running
topology, an active job, and unreadable/invalid existing supervisor state. Prove it
reuses a protocol-compatible idle supervisor only when its reported updater version
also exactly matches 0.1.13, and replaces an inspectable idle older supervisor while
preserving/restoring the active digest override. Repeat the replacement test
without an active override and prove bootstrap captures the exact immutable prior
updater image ID, restores it after an injected replacement failure, and removes the
temporary recovery override only after confirmed success. Its happy path installs only
the initial supervisor transport before delegating the full v0.1.13 transition to the
signed state machine. Afterward, prove
`scripts/agentic-soc-compose.sh` layers the active digest override and document raw
Compose lifecycle commands as unsupported. Verify a known dirty Runbook or Settings
draft blocks confirmation, cancel restores focus, and the browser never receives a
deployment credential or direct pull/restart/migration/rollback authority.

Fault-inject helper-process, Docker-daemon, and host restarts at every updater
self-replacement name-swap boundary. Confirm the restartable helper re-observes container
names and immutable image IDs, then either resumes the target or restores the exact
prior supervisor. Separately rehearse manual disaster recovery when Docker cannot run
any container or its durable metadata/storage is unavailable; do not conflate that
host-loss boundary with an ordinary restart.

Fault-inject the Stable publication workflow before draft creation, after each
canonical asset upload, after remote byte/signature verification, and immediately
before and after the draft-to-published transition. A retry must recover only an exact
tag/SHA draft, remove only validated incomplete draft assets, and publish only after
both downloaded assets match and the Sigstore bundle verifies. A complete published
release must become verify-only; a partial, duplicate, unexpected, or wrong-SHA release
must fail closed without upload, overwrite, or publication.

For each area, verify the states that can be reproduced safely: loading, populated,
empty, refresh-in-place, retryable failure, permission denied/hidden navigation, and
confirmation/progress for consequential actions. Use keyboard-only navigation through
the rail/flyouts, tabs, menus, dialogs, Sheets, table controls, and the Case Manager
divider; confirm visible focus and Escape/focus-return behavior. Hover/focus details
must remain reachable without clipping.

At both widths, reject horizontal page overflow, overlapping sticky regions, scroll
jumps, clipped menus, duplicate headings/actions, blank lazy-route canvases, competing
spinners, theme flashes, and content hidden beneath the composer or footer. Keep the
browser console and network panel open: unexplained runtime errors, rejected chunks,
failed same-origin API/docs requests, or repeated request loops fail acceptance.

The receipt may link screenshots rather than embedding every view, but it must identify
the corrected or high-risk surfaces and state that no unexplained console/network error
remained. Re-run the focused browser path after a fix and repeat the complete matrix on
the final promoted `main` commit before tagging.

### Console output contract

The complete Console suite is quiet: passing tests must not emit React/Radix `act(...)`
warnings, Recharts measurement warnings, other stderr, or captured console stdout.
`npm run test:strict` streams Vitest output unchanged and fails closed on any such
output even when every assertion passes. Fix noise at its owning fixture or component;
do not add a global warning filter or weaken the strict runner. A test that deliberately
exercises logging should install a local spy, assert the expected call, and restore it
before the test ends.

## API contract drift

The OpenAPI document and generated TypeScript contract are committed artifacts.
Regenerate them whenever a backend request, enum, or typed response changes:

```bash
cd webui
npm run gen:types
npm run check:types
```

`check:types` imports the backend and regenerates in place, then fails if the generated
bytes differ from the starting artifacts. Set `TLSOC_REQUIRE_TYPEGEN=1` in a lane where
missing backend dependencies must be treated as an error rather than a skip.

Review the generated diff. OpenAPI generation does not replace the hand-maintained
`src/lib/types.ts`, and endpoints without explicit `response_model` remain only partly
typed in the generated contract.

## Version consistency

Run the repository's standard-library metadata gate from the root:

```bash
python3 scripts/check_version.py
```

For the 0.1 line it checks that the root `VERSION` (`0.1.13`) agrees with backend,
Console, lockfile, OpenAPI, Compose image/build metadata, release records, and the
MkDocs/Mike documentation line (`0.1`).

## Documentation

Use the same version-matched bundler the Console build invokes:

```bash
cd webui
npm run docs:bundle
npm run docs:check
npm run build
```

The wrapper runs MkDocs in strict mode and reuses `TLSOC_DOCS_PYTHON`, a compatible
backend/current interpreter, or an automatically bootstrapped ignored `.docs-venv`.
The final `npm run build` is the canonical docs-plus-application acceptance gate;
`npm run build:app` alone is insufficient for release acceptance. Strict mode catches
missing pages, invalid internal links, and configuration warnings.
Review the rendered desktop and narrow layouts, dark/light themes, search, navigation,
code copy, the installed `/docs/0.1/` base path, and the public 0.1 version selector.
Confirm that **Use the product** is the default navigation path and that in-app links
stay on the application origin. Internal development records are deliberately excluded
from the Help Center build.

### Native Pages publication verification

The `Documentation` workflow validates every eligible pull request, push, and manual
run. Only the exact annotated `vX.Y.Z` tag may enter the Stable publication path,
whether triggered by its tag push or an explicit manual run selected on that tag.
Pull requests, branch pushes (including `main` and `Testing`), and manual runs on any
other ref must stop after validation and preview-artifact upload.

After a Stable publication event:

1. Confirm **Validate Help Center**, **Assemble Stable documentation**, and
   **Deploy Stable documentation** all succeed for the exact tag SHA, and that the
   tag dereferences to the accepted `main` commit.
2. Confirm the generated `gh-pages` history contains `index.html`,
   `0.1/index.html`, `stable/index.html`, `latest/index.html`, and `versions.json`.
   `gh-pages` is a Mike-managed backing store; never edit it by hand.
3. In **Settings → Pages**, verify **Build and deployment → Source** is
   **GitHub Actions**, not **Deploy from a branch**. Verify the `github-pages`
   environment deployment points to the expected workflow run and commit.
4. Request the public root, `/0.1/`, `/stable/`, and `/latest/`; follow redirects,
   require successful responses, and confirm the version selector, Stable marquee,
   and `main` edit links render from the deployed artifact.
5. Re-run the workflow manually on the exact immutable release tag once to prove an
   idempotent redeploy preserves prior version history. Also inspect a manual run on
   `main`, `Testing`, or another non-tag ref and confirm that it validates only:
   neither publication nor deployment may execute.

The native Pages artifact is assembled from the complete generated branch tree and
must be free of symbolic links. A green preview artifact does not prove that the
Pages environment deployed or that the public aliases resolve.

## Deployment-shape checks

Validate Compose interpolation without starting services:

```bash
TLSOC_PG_PASSWORD=validation-only \
  docker compose -f deploy/docker-compose.agnostic.yml config --quiet
bash -n scripts/run-demo.sh
python3 -m unittest discover -s updater/tests -v
python3 -m py_compile updater/agentic_soc_updater/*.py scripts/build_upgrade_plan.py
go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7
```

GitHub additionally runs the production-state acceptance against digest-pinned
PostgreSQL+pgvector and Redis service images. Readiness must prove the bounded KV
write/read, the `vector` extension must exist, and Redis must answer `PING`. A
three-cell BuildKit matrix then builds the backend `full`, Console/Help Center, and
updater images without publishing them and verifies their immutable candidate labels,
healthchecks, ports, runtime user or updater protocol as applicable. These are
required lanes, not advisory previews.

The raw Compose invocation above is a read-only CI render, not a deployed-lifecycle
command. After updater bootstrap, manual start/stop/build/restart operations must use
`scripts/agentic-soc-compose.sh` so the active release override remains layered.
`deploy/docker-compose.tlsoc.yml` is deliberately a fragment to merge into an
operator's existing ELK project; validating it as a standalone topology would be a
false failure because its Elasticsearch service is external. For a release candidate, additionally test
the selected real state backend, restart persistence, source authentication, readiness,
backup/restore, Console proxying, SSE reconnect, and provider failure behavior in an
isolated environment.

## Release acceptance

Before promoting `Testing` to Stable:

1. Rebase/merge the intended feature changes into `Testing` and identify the candidate commit.
2. Run backend, Console, generated-contract, version, strict-docs, and packaging/deployment checks.
3. Resolve every failure on `Testing`; do not patch only the Stable branch, weaken a
   gate, or use `continue-on-error` to manufacture a green candidate.
4. Promote the accepted source tree to `main` without content changes, then run the
   release gate again on the resulting `main` commit.
5. Build and stamp the verified commit with the correct channel, exact SHA, build
   date, and source URL.
6. Create the immutable `v0.1.13` tag and publish matching application artifacts by
   digest; let the Documentation workflow publish the accepted public 0.1 line from
   `main`.
7. Verify all three GHCR packages are public and anonymously pullable by the exact
   backend, Web, and updater digests in the signed plan. Confirm the GitHub Release
   carries the plan and Sigstore bundle and that the plan's tag, commit, workflow
   identity, labels, and compatibility range match the release.
8. In an isolated test repository, interrupt the tag workflow before either draft
   upload, after the plan upload, after both uploads, and immediately after publication.
   Prove each exact tag/SHA draft resumes without rebuilding a validated plan and that a
   complete published release becomes verify-only. Separately present a partial or
   unexpected published asset inventory and prove the retry fails closed without
   upload, overwrite, or publication.
9. Verify `/api/health/build-info`, image metadata, the native Pages deployment, and
   the 0.1 Stable docs selector and aliases.

See [Development](index.md), [Compatibility](../reference/compatibility.md), and
[Release channels](../releases/channels.md).
