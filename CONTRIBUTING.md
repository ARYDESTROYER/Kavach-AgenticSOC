# CONTRIBUTING.md — Developer workflow

How to work on **Agentic SOC** (vendor-agnostic). Read
[`AGENTS.md`](AGENTS.md) first — it is the canonical context (architecture, the 12
non-negotiables, environment, and the Journal mandate). This file is the practical
workflow that sits on top of it.

Participation in the project is governed by the
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). Security vulnerabilities must use the
private reporting process in [`SECURITY.md`](SECURITY.md#8-responsible-disclosure),
not a public issue or pull request.

> **Surfaces.** The standalone web UI (`webui/`, Vite + React + Tailwind +
> shadcn-style primitives on Radix UI) is the **sole primary** UI; the Kibana
> plugin (`archive/kibana-plugin/tlsoc_agentic_triage/`) is **ARCHIVED** (frozen
> 2026-06-21, not built/tested/shipped — see §3b). The backend (`backend/`) is
> OCSF-canonical with a pluggable connector layer and a selectable state backend
> (ES / Postgres / SQLite).

> The build/dev environment is an **ephemeral** cloud container: the repo is
> cloned fresh and reclaimed on inactivity. **Commit + push or it is lost.**
> (`docs/ENVIRONMENT.md` §1.)

## 1. Branch, commits, and the Journal mandate

- **Branches:** merge feature work into `Testing`, the protected integration
  branch. After its full release gate passes, promote that accepted source tree to
  `main`, the protected **Stable** branch, and re-run the gates on the resulting
  `main` commit. Do not develop directly on `main`, and
  do not maintain a parallel prerelease branch under another name. See
  [`docs/releases/channels.md`](docs/releases/channels.md). Commit focused changes;
  push only when asked. The remote uses `main` as its default and retains `Testing`
  as the integration branch. Repository administrators must keep the required
  checks and pull-request protections enforced on those canonical branches.
- **Release notes:** keep one active top-level `[Unreleased]` section. Dated,
  unpublished work is a Development snapshot, not another pseudo-release. The final
  frozen release-preparation change creates `[X.Y.Z]`, reopens `[Unreleased]`, and is
  promoted, verified, and annotated-tagged without content drift; see the release
  checklist linked above.
- **Installable Stable releases:** the accepted `main` commit must receive one
  immutable annotated `vX.Y.Z` tag. The release workflow must publish the backend,
  Web, and updater once by exact digest, sign the images and command-free upgrade
  plan with the tag-bound workflow identity, and attach the plan plus Sigstore bundle
  to the GitHub Release. Make all three GHCR packages public and prove anonymous
  digest pulls before calling the release installable. Never rebuild or move a
  published tag to repair artifacts; prepare a new patch release.
- **Updater compatibility:** v1 plans support only the reference single-replica
  PostgreSQL Compose topology, the signed canonical Compose SHA-256 and schema labels,
  and `migration.strategy=none`. Changes to the Compose project identity, service
  names, network, PostgreSQL volume, private control socket, updater protocol, release
  plan, backup/rollback contract, or lifecycle wrapper require matching updater,
  release, deployment, security, and operator documentation tests. After bootstrap,
  manual lifecycle examples must use `scripts/agentic-soc-compose.sh`, not raw
  Compose.
- **The Journal mandate (non-negotiable process rule).** Every agent (and the
  orchestrator) **MUST** append an entry to [`Journal.md`](Journal.md) at the
  start and end of any session, and after any meaningful milestone (a feature
  done, a build produced, a test run, a decision, a blocker). The Journal is the
  shared memory across context resets and sub-agents. **If you did work and did
  not journal it, the work is not done** (`AGENTS.md`, process rule). Sub-agents that cannot
  commit must **return their Journal entry in their final report** so the
  orchestrator appends it. Use the format at the bottom of `AGENTS.md`.

## 2. Backend (`backend/`)

### 2.1 Setup & the test gate

```bash
cd backend
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
python -m pytest -q          # MUST be green before every commit
```

Tests run **fully offline** — fake ES + mock LLM provider, no network
(`docs/ENVIRONMENT.md` §1.4). This is the primary correctness gate; keep it
green and **add/keep offline tests** for any behaviour you touch.

### 2.2 Conventions

- `from __future__ import annotations`, full type hints, module docstrings,
  **async throughout** (`AGENTS.md` §8).
- **Pydantic v2.** Use `model_dump(mode="json")` for every ES write and every
  response body (see `api/routes.py`, `config.py`).
- **Never drop an alert.** Any LLM / ES / tool error must route to
  **`NEEDS_HUMAN`**, never silently fail. The gateway raises `GatewayError`
  (`llm/gateway.py`) and the case manager fails safe to a human
  (`engine/case_manager.py`).
- **Secrets are env-only.** Never persist a secret to ES, git, or logs; the UI
  sees booleans only (`config.py:configured_status`).

## 3. Web UI (`webui/`) — the primary frontend

A standalone Vite + React + TypeScript + Tailwind CSS SPA with shadcn-style
primitives on Radix UI, talking to the backend directly over `/api/*` (see
`webui/README.md`). **Not** `@elastic/eui` — EUI was fully removed in the UI
overhaul.

### 3.1 Conventions

- **No Kibana / `@kbn/*` imports** — this is a self-contained npm project, so new
  dependencies **are** allowed here (unlike the archived plugin). Compose the
  shared design system rather than re-rolling it: low-level primitives live in
  `src/ui/*` (shadcn-style wrappers on Radix — wrap, don't fork), SOC-domain
  components in `src/soc/components/*`; functional components + hooks
  throughout.
- **Follow the current Console migration contract** in
  [`docs/development/ui-standard.md`](docs/development/ui-standard.md) for every
  routed page, shared shell component, loading state, theme surface, and navigation
  change. Round-specific design docs are history, not a second current standard.
- **Reuse `SourceEditor`** (`src/soc/components/SourceEditor.tsx`) for anything
  that renders an `AuthField[]` — it turns a connector manifest into a validated
  form, so a new source needs zero bespoke UI.
- **Typed API client.** Route all calls through `src/lib/api.ts` (non-2xx →
  `ApiError` carrying the backend `detail`).

### 3.2 Develop & build

```bash
cd webui
npm install
npm run dev          # http://localhost:5173, proxies /api -> :8088
npm run build        # versioned Help Center + tsc --noEmit + Vite -> dist/
npm run docs:check   # validate the generated Help Center against VERSION
npm run build:app    # app-only typecheck + Vite when docs are intentionally unchanged
npm run typecheck    # type check only
npm run lint         # ESLint + accessibility rules
npm run gates        # design/contract gates
npm test             # Vitest suite
npm run test:strict  # release/CI: full suite, zero stderr or captured console stdout
```

Test counts rise as coverage is added. The commands and zero-failure result are the
contract; the latest frozen acceptance receipt is recorded in
[`docs/development/testing.md`](docs/development/testing.md) and `Journal.md`.

## 3b. Archived Kibana plugin (`archive/kibana-plugin/`)

> **ARCHIVED (frozen 2026-06-21) — not built, tested, or shipped.** The
> standalone `webui/` is the sole primary surface; **do not develop the
> plugin.** If a deployment genuinely needs the console embedded inside an
> existing Kibana, reviving it is a do-it-yourself exercise — see
> [`archive/README.md`](archive/README.md) for what that involves and
> [`archive/kibana-plugin/BUILD.md`](archive/kibana-plugin/BUILD.md) for the
> original build recipe (both Kibana versions, `@kbn/*` aliasing, manifest
> quirks, verification steps). The backend API contract is additive-only, so
> the plugin's old server-side proxy would still work in principle without a
> backend change — see `COMPATIBILITY.md` §F.

## 4. Repo layout & extension points

The pieces you are most likely to extend:

```
backend/app/
  ocsf/         canonical event schema. model.py (OCSFEvent + unmapped/raw_data
                catch-alls), ecs.py (ecs_to_ocsf + generic_to_ocsf). Every
                connector normalises to OCSF before the engine sees anything.
  connectors/   the source SPI. base.py (PullConnector / PushReceiver +
                ConnectorManifest/AuthField), registry.py (built-in + entry-point
                discovery), elastic.py / opensearch.py / wazuh.py (pull),
                receivers/ (the 16 push receivers; optional deps lazy-imported).
  stores/       persistence. stores/sql/ (SQLAlchemy async engine + models +
                repositories + vectorstore) backs STATE_BACKEND=postgres|sqlite;
                the ES stores back STATE_BACKEND=elasticsearch.
  engine/ agents/ tools/ llm/   correlation/risk/case-manager, the ReAct agents,
                MCP-shaped tools, and the single cost-ledger gateway.
  api/          the HTTP contract. routes.py is the base router (setup, health,
                core case/audit CRUD); every self-contained feature (rules,
                dashboards, metrics, notifications, RAG, search, roles, tuning,
                campaigns, baseline, batch, reset, setup, …) lives in its own
                `routes_<feature>.py` module and is **auto-discovered** at boot
                (`main.py::discover_feature_routers()` walks `app.api.routes_*`
                for a top-level `router: APIRouter` — no manual registration).
webui/          the standalone SPA (sole primary UI).
archive/kibana-plugin/   the ARCHIVED Kibana plugin — do not develop it (§3b).
```

Each extension point is small and deterministic by design. Whatever you add,
**the 12 non-negotiables (`AGENTS.md` §5) must never regress.**

- **A new tool** — add an MCP-shaped tool under `tools/` following
  `tools/base.py` (name, description, input schema, async `run`). It is exposed
  to the investigator via `tool_defs_text` (`agents/prompts.py`). Event-derived
  output stays untrusted; reads only — never write a source.
- **A new agent role** — add the role to `constants.py:Role`, give it a system
  prompt in `agents/prompts.py` (include `_INJECTION_NOTE`), a `ModelConfig` in
  `config.py:Preferences` wired into `model_for(...)`, and call it through the
  **single gateway** (`llm/gateway.py`) — never a provider directly, so the cost
  ledger stays complete (non-negotiable #6).
- **A new surface** — add a backend route in `api/routes.py`, or a new
  `app/api/routes_<feature>.py` module for a self-contained feature (it is
  auto-discovered, see §4 above); return `model_dump(mode="json")`. Then add the
  matching web UI component, a `webui/src/lib/api.ts` call, and **keep
  `webui/src/lib/types.ts` in sync with `backend/app/models.py`** for the new
  response/request shape. (The archived plugin's `common/index.ts` is frozen —
  no need to touch it.)
- **A new Preference** — add the field (with a working default) to
  `config.py:Preferences`. It **round-trips automatically** through
  `GET`/`PUT /api/settings` (the deep-merge + `Preferences.model_validate` in
  `routes.py`); the only extra work is surfacing it in Settings.
- **A new state backend table/repo** — extend `stores/sql/models.py` +
  `repositories.py`; keep Postgres-only deps (asyncpg/pgvector) **lazy** so the ES/
  SQLite paths still import without them.

## 4a. Writing a connector

A connector turns an external source into a stream of normalised OCSF/`RawEvent`s.
Implement one of the two SPI shapes in `backend/app/connectors/base.py`:

- **`PullConnector`** — *we drive it.* Implement `ping`, `poll(prefs, cursor,
  from_millis)` (in-scope events at/after the inclusive lower bound, time-ascending;
  the poller advances the cursor + dedups), `search(prefs, StructuredQuery)` (backs
  the `es_query` tool — compile the source-neutral `StructuredQuery` IR to your
  dialect; the LLM never emits raw DSL), and `fetch_by_ids`. See `elastic.py` /
  `opensearch.py` / `wazuh.py`.
- **`PushReceiver`** — *it drives us.* Implement `start(emit, prefs)` /`stop` (run a
  listener / consume a broker / poll an object store; deliver each normalised batch
  via the `emit` callback) and `parse(payload, prefs)`. HTTP receivers also expose
  `verify_auth` + `handle_request` and are route-driven via `POST /api/ingest/{id}`
  (no socket). See `receivers/webhook.py` (auth modes), `receivers/syslog.py`
  (socket), `receivers/queues.py` / `objectstore.py`.

Then:

1. **Ship a `ConnectorManifest`** from the classmethod `manifest()` (static — no
   credentials/instance needed). Its `auth_fields` + `config_fields`
   (`AuthField`s) **drive the wizard form** with zero per-connector UI code; mark
   credentials `secret=True` (UI shows configured-only). Set `category`,
   `ingest_modes`, `capabilities`, and `requires_pip` (any optional deps).
2. **Normalise to OCSF** by overriding `to_ocsf(raw, prefs)` with a precise mapper,
   or rely on the default `generic_to_ocsf`. Map what you can; everything else goes
   to `unmapped`, and keep the original record in `raw_data`. The engine NEVER sees
   source-native records.
3. **Register it.** Built-in: add the class to `_BUILTIN_PULL` (registry.py) or
   `BUILTIN_RECEIVERS` (`receivers/__init__.py`). Out-of-tree: publish it under the
   **`tlsoc.connectors` entry-point group** so `pip install
   tlsoc-connector-<vendor>` makes it appear in the wizard with no core change.
4. **Lazy-import optional deps** inside `start()`/runtime — never at module import
   — so the base image stays slim and importable. Raise the wizard-friendly
   `ConnectionError("… Install it with: pip install <lib>")` pattern (see
   `receivers/queues.py:_require`).
5. **Add offline tests** — exercise `manifest()`, `to_ocsf`/`parse` (call them
   directly, no socket/network), and auth. Keep `pytest -q` green.

A new `SourceType` enum value (`constants.py`) and (for receivers) the right
`IngestMode`(s) are the only core touch-points for a built-in.

## 5. Sub-agent workflow

- Delegate context-heavy or isolated work (builds, tests, docs, isolated modules)
  to sub-agents. Give each the exact files, interfaces, acceptance criteria, and
  "run `pytest`/`tsc` until green" (`AGENTS.md` §9).
- **Sequence** agents that touch shared files (`models.py`, `config.py`,
  `routes.py`, `webui/src/soc/registry.tsx`) to avoid edit conflicts;
  **parallelize** only non-overlapping work.
- Every sub-agent ends its report with a **Journal entry** for the orchestrator
  to append (sub-agents don't commit). The orchestrator owns cross-cutting
  contracts and integration, runs the final build + tests, commits, pushes, and
  updates the Journal.
- **Update `Journal.md` every session** — start, end, and at each milestone.

## 6. Pre-commit checklist (every change)

- [ ] `pytest -q` green (backend, offline).
- [ ] `webui` (if changed): `npm run build` clean, `npm run test:strict` green,
      `npm run lint -- --max-warnings=0` clean.
- [ ] New connector: manifest + OCSF mapping + registration + lazy deps + offline
      tests (if you added one).
- [ ] No secret in git / state store / logs; UI shows booleans only.
- [ ] None of the 12 non-negotiables regressed.
- [ ] Companion docs updated (USAGE / TROUBLESHOOTING / RUNBOOK / SECURITY /
      webui/README / DEPLOY / README as relevant).
- [ ] **`Journal.md` updated**.

---

## Continuous integration (merge gate)

`.github/workflows/ci.yml` runs on every pull request (and pushes to `main` /
`Testing`) and must be green before merge. It exposes eighteen independently
diagnosable quality checks plus one fail-closed aggregate:

| Status check | Contract |
| --- | --- |
| Repository & version contracts | Canonical SemVer, release-channel, package, image, Compose, OpenAPI, and documentation metadata agree. |
| Backend tests (offline) | The complete fake-ES/mock-LLM/SQLite suite passes, including deny-by-default route authorization coverage. |
| Backend package integrity | The sdist and wheel build, install, report the canonical version, and contain required runbooks, playbooks, model, and ATT&CK data. |
| Backend startup smoke | Production dependencies import, feature routers discover, the ASGI lifespan starts on isolated SQLite state, and liveness reports the expected version. |
| PostgreSQL & Redis acceptance | The supported PostgreSQL+pgvector state path boots against pinned service images, readiness proves a real KV write/read, the vector extension exists, and Redis responds. |
| Web UI tests (Vitest) | The complete component, interaction, accessibility, and page regression suite passes with zero stderr or captured console stdout. |
| TypeScript & OpenAPI drift | Backend OpenAPI regeneration is byte-stable and the Console type-checks without a soft skip. |
| Web UI lint | ESLint, hooks, and `jsx-a11y` finish with zero errors or warnings. |
| Design-system gates | Token existence, measured contrast, colour-vision separation, and raw-style regression guards pass. |
| Help Center & docs | Public structure/links, bundle/theme contracts, and the version-matched strict documentation build pass. |
| Web UI production build | The release-stamped Console and installed Help Center compile into an inspectable production artifact. |
| Workflow & shell contracts | Every workflow passes pinned actionlint with a checksum-verified ShellCheck binary, CI policy regression tests pass, and every tracked shell script parses. |
| Bootstrap portability (macOS Bash 3.2) | A native `macos-14` runner proves the one-time supervisor bootstrap parses and forwards both zero-argument and replacement Compose invocations under Apple Bash 3.2. |
| Deploy & updater contracts | The reference five-service Compose topology resolves, invalid startup modes fail closed, and updater wire, plan, lifecycle-wrapper, backup, and rollback contracts pass. |
| Python static correctness | Ruff's fatal correctness rules reject syntax faults, invalid control flow, and undefined names without turning legacy style debt into a release bypass. |
| Release image build (backend) | The complete backend image builds from the shipping Dockerfile and its OCI identity, healthcheck, port, and non-root runtime contract match the candidate. |
| Release image build (webui) | The Console plus version-matched Help Center image builds and its OCI identity, healthcheck, and port match the candidate. |
| Release image build (updater) | The isolated updater image builds and its OCI identity, healthcheck, protocol label, and entry point match the candidate. |
| CI passed | Runs even after failures and fails unless every one of the eighteen checks completed successfully. |

The jobs intentionally run separately and in parallel. This costs a few repeated
dependency-cache restores and image layers, but a pull request cannot hide API drift,
packaging, production-state, image, documentation, or deployment failures inside one
opaque log. A failing gate is repaired at its source; it is never weakened or bypassed
to make a candidate mergeable.

### Local CI parity

Use Python 3.11, Node 22, Docker with BuildKit/buildx, Go, and native macOS
`/bin/bash` 3.2 for the portability lane. Install only from the checked-in Python
requirements and npm lockfile. These command groups mirror the locally runnable
parts of the workflow; `.github/workflows/ci.yml` remains authoritative for its
inline PostgreSQL/Redis probes, package-content assertions, release-image metadata
checks, and clean-runner environment.

```bash
# Repository, backend, package, startup, and fatal static contracts
python3 scripts/check_version.py
(cd backend && .venv/bin/python -m pip check && .venv/bin/python -m pytest -q)
(cd backend && .venv/bin/python -m build --sdist --wheel --outdir dist)
backend/.venv/bin/python -m compileall -q backend/app
backend/.venv/bin/python -m ruff check \
  backend/app backend/tests updater/agentic_soc_updater scripts \
  --select E9,F63,F7,F82

# Console, API drift, design system, and production bundle
(cd webui && npm ci && npm run test:strict)
npm --prefix webui run check:types
npm --prefix webui run typecheck
npm --prefix webui run lint -- --max-warnings=0
npm --prefix webui run gates
# Build provenance is a PAIR: pass both, always the full object id. An abbreviated
# `git rev-parse --short` is not an exact revision, so the resulting build reports
# complete provenance that no upgrade can be pinned to. scripts/check_version.py
# fails the build if a shipped script or document derives the SHA that way.
(cd webui && TLSOC_RELEASE_CHANNEL=testing \
  TLSOC_BUILD_SHA="$(git rev-parse HEAD)" \
  TLSOC_BUILD_DATE="$(git show -s --format=%cI HEAD)" npm run build)

# Help Center, workflow, host-bootstrap, and updater contracts
python3 scripts/check_docs.py
python3 scripts/test_build_docs_bundle.py
python3 scripts/test_docs_theme.py
TLSOC_RELEASE_CHANNEL=testing python3 scripts/run_docs_bundle.py \
  --output /tmp/agentic-soc-docs
TLSOC_RELEASE_CHANNEL=testing python3 scripts/run_docs_bundle.py \
  --output /tmp/agentic-soc-docs --check-only
python3 scripts/check_ci_contract.py
backend/.venv/bin/python -m unittest scripts.test_check_ci_contract -v
go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7
/bin/bash -n scripts/bootstrap-updater.sh
python3 scripts/test_bootstrap_bash32.py
backend/.venv/bin/python -m unittest discover -s updater/tests -v
```

The workflow additionally checksum-installs ShellCheck 0.10.0, validates every
tracked shell script, boots the exact digest-pinned PostgreSQL+pgvector and Redis
services, validates the five-service Compose model, and builds/smokes backend,
Console, and updater images for the candidate identity. Run those exact workflow
blocks when their prerequisites are available; only GitHub's clean runners provide
authoritative parity for branch protection.

The workflow contract checker rejects missing or unreviewed workflow files (including
either YAML extension), duplicate YAML keys, mutable external action references,
missing job timeouts, over-broad permissions, `continue-on-error`, unsafe triggers,
and aggregate dependency drift. Dependabot proposes reviewed weekly updates to
immutable GitHub Actions pins; it does not make those updates automatically.
Shipping Dockerfile bases are also pinned to reviewed multi-platform manifest digests;
the workflow policy enforces that contract, while weekly Docker Dependabot proposals
keep those reproducible pins reviewable.

To enforce the aggregate:

> **GitHub → Settings → Branches → Branch protection rules** for both `Testing`
> and `main`: require pull requests, the status check **`CI passed`**, and “Require
> branches to be up to date before merging.” Direct development goes through
> `Testing`; a promotion PR to `main` must preserve the accepted source tree and
> re-run the gate on its resulting commit. PRs then cannot
> merge until the backend, Console, contracts, and documentation gates pass.

Run the matching commands in the pre-commit checklist before pushing. GitHub remains
the authoritative clean-checkout run, including package and deployment contracts.
