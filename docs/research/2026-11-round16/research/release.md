# Release readiness: shipping Round 16 as the next Stable release

Research key: `release`. Repository state read on 2026-11-24 at `claude/round16`
`3cd362c` (one Journal commit on top of `origin/Testing` `3cfd5c0`). Everything below was
done read-only: no repository file, ref or setting was changed. Simulations ran in a
scratch clone under the session scratchpad.

## 1. Verdict in one paragraph

The release machinery itself is in good shape (all local contract checks pass, Testing CI
is green on `3cfd5c0`, the frozen Compose base still matches its pin, the Help Center
corpus is current). But the next release cannot be tagged safely yet. Four findings are
blocking: (1) the GitHub repository was renamed from `ARYDESTROYER/Agentic-Kibana` to
`ARYDESTROYER/Kavach-AgenticSOC`, while the updater trust root, GHCR image prefix, OCI
source labels, bootstrap default, release-discovery default, Console links and the public
docs URL are all still pinned to the old name, so a v0.1.13 built today would publish
under the new identity and then fail canonical bootstrap exactly like the six previous
tags; (2) the release records are stale: `CHANGELOG.md` already has a
`## [0.1.13] - 2026-08-05` section that describes only the August bootstrap fix, while
2,346 lines of Rounds 12 to 15 sit in `[Unreleased]`, and `docs/releases/0.1.13.md` says
"no Sigstore identity change" and "no migration", both of which are now false; (3) the
backend performs an in-place PostgreSQL column widening (`audit.id` to `bigint`) at boot,
which the signed plan (`migration.strategy: none`) and the upgrade docs do not admit, and
which can outlast the 300 s rollout timeout on a large audit table; (4) under the
repository's own versioning rules this content is a MINOR release (0.2.0), not a PATCH
(0.1.13). Each has a concrete fix below; none requires touching `decide()`.

## 2. Verified facts

| Fact | Evidence |
| --- | --- |
| `VERSION` on Testing and the round16 branch is `0.1.13`; `main` `VERSION` is `0.1.12` | `cat VERSION`; `git show origin/main:VERSION` |
| `origin/main` = `c3f1fa3`: the v0.1.12 promotion `87e8f3a` plus four Dependabot commits (#43, #41, #39, #37) that bump `actions/setup-go` 6 to 7.0.0, `upload-artifact` 4 to 7.0.1, `configure-pages` 5 to 6.0.0, `upload-pages-artifact` 4 to 5.0.0 in `ci.yml` and `docs.yml` only (6 changed lines). Testing does not have these bumps | `git log origin/Testing..origin/main`; `git diff 87e8f3a origin/main` |
| Testing is 47 commits ahead of `main`; merge base is `537090a` | `git log origin/main..origin/Testing` |
| A plain merge of Testing into `main` conflicts in 60 files (VERSION, CHANGELOG, every `docs/releases/0.1.x.md` as add/add, workflows, package files) | `git merge-tree --write-tree origin/main origin/Testing` in a scratch clone |
| Previous promotions were tree replacements, not merges: `87e8f3a^{tree}` equals Testing `f5dd366^{tree}` (`e19b2885...`); commit message "Promote the tree byte-identical to final accepted Testing" | `git rev-parse` on both trees |
| Tags present: `v0.1.1`, `v0.1.4` to `v0.1.12`. No `v0.1.13` tag and no v0.1.13 release | `git tag -l`; GitHub `list_tags`, `list_releases` |
| v0.1.12 GitHub Release is `"immutable": true` with exactly `upgrade-plan.json` and `upgrade-plan.sigstore.json` | GitHub `get_release_by_tag` |
| Repository metadata: `full_name` `ARYDESTROYER/Kavach-AgenticSOC`, public, **`default_branch` `Testing`**, **`license` null**, `has_pages` true | `gh api repos/ARYDESTROYER/Kavach-AgenticSOC` |
| Branch protection on both `main` and `Testing` requires the single check `CI passed` | `gh api .../branches/{main,Testing}` |
| Environment policies (`stable-release`, `github-pages`) are not readable through this sandbox's proxy | `gh api .../environments` returned 403 |
| Testing push CI on `3cfd5c0` succeeded in about 23 minutes (run 45463274869) | GitHub `actions_list` |
| The v0.1.12 signing certificate SAN is `https://github.com/ARYDESTROYER/Agentic-Kibana/.github/workflows/release.yml@refs/tags/v0.1.12`; its plan pins `ghcr.io/arydestroyer/agentic-kibana/...@sha256` and `from` `0.1.1..<0.2.0` | downloaded bundle, `openssl x509 -ext subjectAltName` |
| `release.yml` derives image prefix, OCI source label and signing identity from `GITHUB_REPOSITORY` (now `ARYDESTROYER/Kavach-AgenticSOC`) | `.github/workflows/release.yml` lines 45 to 52, 264, 343, 410, 538, 624, 643 |
| The updater pins all of these to its trusted repository: identity (`runtime.py` 210 to 213), image prefix `ghcr.io/{repo.lower()}/` and source label (`contract.py` 184 to 201), asset URLs (`contract.py` 56 to 61); default `ARYDESTROYER/Agentic-Kibana` (`__main__.py` 21) | `updater/agentic_soc_updater/` |
| The **frozen** base `deploy/docker-compose.agnostic.yml` hard-codes `UPDATE_TRUSTED_REPOSITORY=${AGENTIC_SOC_UPDATE_REPOSITORY:-ARYDESTROYER/Agentic-Kibana}` (line 209); its SHA-256 `e3f7ecbb...6fd4` matches `deploy/update-base-v1.sha256`, so that default cannot change under protocol 1 | `sha256sum`; compose line 200 and 209 |
| `bootstrap-updater.sh` defaults the repository to `ARYDESTROYER/Agentic-Kibana` (line 45); `.env.example` line 46 and `INSTALL.md` line 266 tell operators to keep it | files |
| GHCR: anonymous pull token works for `arydestroyer/agentic-kibana/backend`; `arydestroyer/kavach-agenticsoc/backend` is denied (does not exist yet) | `ghcr.io/token` probe |
| Pages: `https://arydestroyer.github.io/Agentic-Kibana/stable/` is 404; `https://arydestroyer.github.io/Kavach-AgenticSOC/stable/` is 200 and serves the 0.1.12 docs, whose canonical link and sitemap still point at the dead old URL | `curl` |
| Old release asset URLs redirect: `.../Agentic-Kibana/releases/download/v0.1.12/upgrade-plan.json` answers 301 to the new name | `curl` |
| Release discovery deliberately rejects redirects (`release_discovery.py` lines 12, 96 to 152) while `ReleaseUpdateConfig.repository_url` defaults to the old name (`config.py` 2408) | source |
| Console hard-codes the dead Pages URL and old repo (`webui/src/soc/pages/Docs.tsx` 43 to 51; `settings/release-updates.tsx` 25); `mkdocs.yml` `site_url`, `repo_url`, `repo_name`, `stable_docs_url` and the footer link use the old name | source |
| `CHANGELOG.md`: `## [Unreleased]` spans lines 13 to 2359 (Round 15, docs refresh, Round 14 follow-up, Round 14, "Earlier rounds in this cycle", Fixed, Added, Changed, Upgrade notes); `## [0.1.13] - 2026-08-05` at 2360 covers only the legacy label normalization and states "No ... Sigstore identity/issuer change" | file |
| `docs/releases/0.1.13.md` (10,167 bytes) covers only the bootstrap correction; it becomes the GitHub Release body verbatim (`release.yml` 751 to 752, `release_asset_state.py` 35 to 38) | files |
| The backend widens `audit.id` to `bigint` in place at every PostgreSQL boot until done (`backend/app/stores/sql/engine.py` 72 to 147, called from `state.py` 3255 during startup); CHANGELOG line 2308 says "PostgreSQL deployments are migrated in place at boot"; `docs/operations/upgrades.md` 470 to 471 says "needs no database migration"; upgrades.md 922 to 928 says any release that needs a schema migration "is blocked from one-click installation" | files |
| Plan rollout defaults: backend 300 s, Web 180 s, observation 30 s (`scripts/build_upgrade_plan.py` 46 to 48); the updater accepts backend 30 to 900 s (`contract.py`) | files |
| The rollback lane pins `45a4c31` (the Round 14 build), not v0.1.1, which is the only installable Stable source and therefore the real image-only rollback target in the field (`scripts/rollback_previous_release.json`) | file |
| `known-limitations.md` 283 to 297: image-only rollback to any build before Round 14 "is not clean" | file |
| Local gates on HEAD: `check_version.py` passes (also with `TLSOC_SOURCE_REF=refs/tags/v0.1.13 TLSOC_RELEASE_CHANNEL=stable` and with `refs/heads/main`); `check_ci_contract.py` passes (3 workflows, 3 Dockerfiles); `check_docs.py` passes (86 pages); `build_app_knowledge.py --check` current (971 chunks) | commands run |
| `check_version.py` only requires one `[Unreleased]`, a dated `[VERSION]` heading and seven markers in the release page; it cannot tell that the 0.1.13 notes omit Rounds 12 to 15 | `scripts/check_version.py` 637 to 690 |
| `docs/development/testing.md` line 13 still quotes a 7,526 backend / 4,750 Console baseline; AGENTS.md records 13,143 / 8,864 | files |
| Browser tooling exists: Playwright 1.63.0 under `/opt/node-tools/node_modules`, Chromium 153 under `/opt/pw-browsers`, `axe-core` in `webui/node_modules`; a headless smoke with `colorScheme: 'dark'` worked | ran a smoke script in scratchpad |
| `npx vite preview` serves `webui/dist` with `/release.json` (`no-store`), `/docs/0.1/` and SPA fallback, and proxies `/api` to `BACKEND_URL` (default `127.0.0.1:8088`) because `preview.proxy` defaults to `server.proxy` | probe on port 4179; [Vite preview options](https://vite.dev/config/preview-options) |
| The existing `webui/dist` was built from `b01098f` with a 7-character SHA and `buildTime 2026-11-24T00:00:00Z`, so it is not a receipt candidate | `dist/release.json` |

## 3. Blocking findings and their fixes

### B1. The repository rename breaks the signed-update trust chain (blocker)

**What happens if nothing changes.** On tag push the release workflow runs with
`GITHUB_REPOSITORY=ARYDESTROYER/Kavach-AgenticSOC`. It pushes
`ghcr.io/arydestroyer/kavach-agenticsoc/{backend,webui,updater}`, labels them
`org.opencontainers.image.source=https://github.com/ARYDESTROYER/Kavach-AgenticSOC`, and
Fulcio issues a certificate whose SAN is built from the job's `job_workflow_ref`
([Fulcio OIDC](https://docs.sigstore.dev/fulcio/oidc-in-fulcio)), i.e. the new name. The
workflow's own checks pass because they use the same variable. An operator then runs
`bootstrap-updater.sh` with a v0.1.1 `.env` that has no `AGENTIC_SOC_UPDATE_REPOSITORY`
(or the documented old value): the supervisor trusts `ARYDESTROYER/Agentic-Kibana`, and
`validate_plan` rejects the plan ("image must be the trusted GHCR repository pinned by its
exact digest"), and the identity and label checks would fail next. Result: v0.1.13 becomes
the seventh bootstrap-blocked immutable tag. Two side effects also exist today:

- GitHub does not redirect project Pages URLs after a rename
  ([Renaming a repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository)),
  so every "public Stable docs" link and the live docs' canonical and sitemap URLs point at
  a 404.
- Renamed-repository API calls answer with a redirect
  ([GitHub API changelog, 2015-07-21](https://developer.github.com/changes/2015-07-21-automatic-redirects-for-renamed-repositories)),
  and the backend's release discovery rejects redirects by design, so with the stored or
  default `repository_url` the Console's update discovery cannot see any new release.
  (Not observed live: the sandbox proxy blocks the old API path; inferred from code plus
  the documented redirect.)

**Decision needed now (maintainer).** Either adopt the new name as the trust root (Option
A) or rename the repository back (Option B). This is the cheapest moment to choose: no
supervisor has ever completed a canonical bootstrap in the field (v0.1.6 to v0.1.12 were
all blocked), so only the maintainer's acceptance host carries the old trust value.

**Option A (adopt `ARYDESTROYER/Kavach-AgenticSOC`), effort M, value high.** In the Round 16
code PR (not the frozen prep, because it changes code and tests):

1. `updater/agentic_soc_updater/__main__.py` line 21 default; `updater/Dockerfile`,
   `backend/Dockerfile` line 13 and `webui/Dockerfile` line 48 `TLSOC_SOURCE_URL` defaults.
2. `scripts/bootstrap-updater.sh` line 45: default to the new name, and fail closed with a
   clear remediation when `.env` lacks `AGENTIC_SOC_UPDATE_REPOSITORY` or still names the
   old repository (the frozen compose would otherwise start the supervisor with the old
   default on the next `agentic-soc-compose.sh` recreate). Do not edit `.env` silently.
3. `backend/app/config.py` `ReleaseUpdateConfig.repository_url` default plus a
   `model_validator(mode="before")` repair that maps exactly
   `https://github.com/ARYDESTROYER/Agentic-Kibana` to the new URL (any other value is an
   operator choice and stays). This fixes discovery on every existing deployment.
4. `webui/src/soc/pages/settings/release-updates.tsx` default; `webui/src/soc/pages/Docs.tsx`
   `PUBLIC_STABLE_DOCS_URL`, `DEVELOPMENT_DOCS_URL`, `documentationSourceUrl`.
5. `mkdocs.yml` `site_url`, `repo_url`, `repo_name`, `stable_docs_url`, footer link.
6. `.env.example` line 46, `INSTALL.md` line 266 ("Keep ...") and 1105 to 1110, `DEPLOY.md`,
   `docs/operations/upgrades.md` bootstrap step 2, `docs/releases/0.1.13.md` (all GHCR
   paths, asset URLs, identity strings and the `git ls-remote` example).
7. Tests: `updater/tests/test_updater.py` 57, `updater/tests/test_bootstrap_shell.py` 73,
   `backend/tests/test_release_discovery.py`, `backend/tests/test_system_updates.py`, and the
   11 Console test files that name the old repository. Add a test for the preference repair
   and for the bootstrap refusal.
8. Release notes must say plainly that the publisher identity, GHCR namespace and source
   label changed, that old v0.1.12 artifacts stay valid under the old identity, and that
   operators must set `AGENTIC_SOC_UPDATE_REPOSITORY=ARYDESTROYER/Kavach-AgenticSOC` in
   `.env` before bootstrapping.

The frozen `deploy/docker-compose.agnostic.yml` keeps its old default; that is acceptable
because `.env` is not hash-pinned and bootstrap enforces it. Do not edit the base file
(that would need a protocol 2 and a new bootstrap path).

**Option B (rename the repository back), effort S.** Restores every pin at once; then the
README and INSTALL clone URLs written in the docs refresh must revert, and the Pages site
moves back to the old URL. Risk: whether GitHub keeps a redirect from the second name is
not verified. GitHub warns not to create a new repository with an old name
([Renaming a repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository)).

**How to test (either option).** Offline: the updater unit tests with the new constant and a
plan fixture built by `scripts/build_upgrade_plan.py --repository ARYDESTROYER/Kavach-AgenticSOC`;
a bootstrap shell test with no repository line and with the old line in `.env` (both must
refuse). Online: the dress rehearsal in section 6.

### B2. The new GHCR namespace starts private (blocker for the first run, recoverable)

Under Option A the three packages are created by the first push and are private: "When you
first publish a package, the default visibility is private", and a linked package
"inherits the access permissions (but not the visibility)" of the repository
([Configuring a package's access control and visibility](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility)).
The release workflow's step "Prove anonymous pullability and exact OCI release labels"
(`release.yml` 354) will fail before any plan, attestation or Release is created, with the
message "make backend, webui, and updater packages Public, then rerun this tag workflow".
This is a designed pause, not a burnt tag, but the Documentation workflow waits at most
2 hours for the signed release (`docs.yml` 186) and may time out.

**Maintainer runbook:** after the first failure, set each of the three packages to Public
(irreversible: "Once you make a package public, you cannot make it private again"), confirm
the repository has write access under the package's Actions access, re-run the failed
release job, then re-run the Documentation workflow on the tag through
`workflow_dispatch` if its wait timed out. Effort S, value high.

### B3. The release records do not describe the release (blocker)

`check_version.py` passes today, yet the `[0.1.13]` CHANGELOG section and
`docs/releases/0.1.13.md` describe only the August label fix and assert things that are no
longer true ("no Sigstore identity/issuer change", "no application-state schema migration",
"does not change ... publisher identity"). The fix is the frozen release-preparation change
in section 5. Add two cheap guards so this cannot recur (section 7, R11).

### B4. An undeclared in-place PostgreSQL migration runs during the supervised rollout (blocker for honesty, risk for large tables)

`ensure_schema_migrations()` runs `ALTER TABLE audit ALTER COLUMN id TYPE bigint` and
`ALTER SEQUENCE ... AS bigint` inside startup. In PostgreSQL an `int` to `bigint` type
change rewrites the table and its indexes under an exclusive lock, so on a canonical
v0.1.1 deployment with a large audit table the new backend can stay unready past the
plan's 300 s backend timeout; the updater then rolls the images back, the transaction
aborts, and every retry repeats the same failure. (Rewrite behavior is standard PostgreSQL
knowledge, not measured here; the 300 s value is measured from the plan builder.)

**Fix, effort S to M, value high:**

1. Measure the ALTER on 1, 5 and 10 million audit rows in the PostgreSQL lane or on the
   maintainer host (a scratch database seeded with `generate_series`), and record the
   timings in the release notes.
2. If 10 million rows exceed about 200 s, raise the plan's backend timeout for this release
   by passing `--backend-timeout 900` to `build_upgrade_plan.py` in `release.yml` (the
   updater already accepts up to 900) and say so in the notes.
3. Document a pre-step for large deployments: stop the backend, run the remediation SQL
   from `engine.py` line 81 in a maintenance window, start v0.1.1 again, then bootstrap.
4. Reword `docs/operations/upgrades.md` 470 to 471, the release notes and
   `known-limitations.md`: "one idempotent, backward-compatible column widening at first
   boot; no other schema change; `migration.strategy` stays `none` because v0.1.1 reads and
   writes the widened column unchanged". That last claim must be proven by B5.

**Test:** a PostgreSQL test that seeds an `integer` `audit.id`, boots the backend, asserts
`bigint` and that a v0.1.1 backend (B5) still inserts and reads audit rows.

### B5. Image-only rollback to v0.1.1 is not rehearsed (blocker for the "automatic rollback" promise)

The canonical path is v0.1.1 to the new release, and the updater's automatic rollback
restores v0.1.1 images on the data the new backend already wrote (preferences migrations,
the one-shot runbook migration, the widened `audit.id`, the knowledge corpus). The rollback
lane only boots `45a4c31`, and `known-limitations.md` already says rollback to builds
before Round 14 "is not clean".

**Fix, effort M, value high:** run
`backend/.venv/bin/python scripts/rollback_lane.py --previous-release ba179651a7b63d6352ad346fd633e1460f3a4d39 --database-url <scratch PostgreSQL>`
(the v0.1.1 commit; the lane supports `--previous-release`). Expect some assertions to fail
by design (no `runbooks.*` in v0.1.1); the pass condition for the release is narrower and
must be written down: v0.1.1 boots without safe-stop on the new data, serves
`/api/health/ready`, reads and writes cases and audit rows, and the documented losses are
exactly those in `known-limitations.md`. Add a v0.1.1 subsection to that page with the real
result. The sandbox cannot pull the PostgreSQL image; either run it on the maintainer host
or try Ubuntu packages (`postgresql-16` and `postgresql-16-pgvector` from the noble
archive, which is reachable from this sandbox; not attempted here).

### B6. Version number: 0.1.13 is not the right number under the repository's own rules

`docs/releases/channels.md` "Semantic versioning before 1.0": increment PATCH "for
backward-compatible fixes within a documentation line"; increment MINOR "for a new pre-1.0
capability set or a compatibility change that needs its own documentation line". Rounds
12 to 16 are a new capability set (chat without limits, Dashboards library, Audit log,
rule sheets, one Runbooks feature, RBAC switch, Team activity, case screenshots, the
auto-close review, What's new and Communication) and carry compatibility changes: writes
to `/api/playbooks*` answer `410 runbooks_moved`, `PUT /api/settings` answers `409
rbac_switch_moved` for `rbac.enabled`, `playbooks:*` grants are remapped, reads under
`/api/playbooks*` are deprecated for one release, `AUTH_TOKEN_HOURS` is capped at 144,
Elasticsearch state needs a manual audit-template step, and image-only rollback to older
builds is not clean.

SemVer 2.0.0 itself says "Major version zero (0.y.z) is for initial development. Anything
MAY change at any time", so 0.1.13 does not break the SemVer specification; but its FAQ
recommends incrementing the minor version for each subsequent 0.y release, and its MINOR
rule names deprecation explicitly ([SemVer 2.0.0](https://semver.org/spec/v2.0.0.html)).
The binding rule here is the project's own, and it says **0.2.0**. 0.1.13 was never tagged
or published, so the number is still free to change ("Choose the candidate version before
final acceptance").

**Recommendation:** ship **0.2.0** with documentation line **0.2**, and fold the unpublished
0.1.13 bootstrap correction into it. If the maintainer keeps 0.1.13 to limit churn, record
an explicit, dated exception in `channels.md` and in the release page, because otherwise
the published policy and the published version disagree.

**Extra work for 0.2.0 (effort M, value high), on top of section 5:**

- Version strings: `VERSION`, `backend/app/__init__.py`, `backend/pyproject.toml`,
  `webui/package.json` and lockfile, `webui/openapi.json`, `updater/agentic_soc_updater/__init__.py`
  `UPDATER_VERSION`, `deploy/docker-compose.tlsoc.yml` image default, `mkdocs.yml`
  `product_version` and `docs_version: "0.2"` plus nav entries. About 115 files mention
  `0.1.13` (29 under `webui/src`, 9 each in `backend/app` and `backend/tests`).
- New pages `docs/releases/0.2.md` (line page; `check_version.py` requires
  `docs/releases/{docs_version}.md` to mention the version) and `docs/releases/0.2.0.md`;
  demote `docs/releases/0.1.13.md` to "unpublished candidate, folded into 0.2.0" like
  0.1.2 and 0.1.3; convert the CHANGELOG `[0.1.13]` heading to
  `## Development snapshot - 2026-08-05 - 0.1.13 Testing candidate (never tagged; folded into 0.2.0)`
  (use the repository's existing snapshot heading style).
- Installed Help Center moves to `/docs/0.2/`; about 52 files reference `/docs/0.1`. Add
  redirect stubs for `/docs/0.1/...` in `scripts/build_docs_bundle.py` so stored chat
  citations, report links and bookmarks keep working.
- Documentation workflow: Mike deploys `0.2` and moves `stable` and `latest`; `0.1` stays.
  Update `docs/releases/documentation-versions.md`.
- `scripts/build_upgrade_plan.py` `--max-version-exclusive` default to `0.3.0` (with a test),
  otherwise a 0.2.0 install could never accept a 0.2.1 plan. The 0.2.0 plan's `from` range
  `0.1.1..<0.3.0` still admits the v0.1.1 baseline; same-version plans are refused elsewhere.
- No updater or backend code restricts a target to the 0.1 line (`contract.py` only checks
  the `from` range; `update_service.py` 267 to 268 only compares newer), so the supervised
  path itself is unaffected. Verified by reading, not by a run.

### B7. Main-only Dependabot commits would be reverted by the promotion

A tree-replacement promotion (the established method) makes `main` byte-identical to
Testing, which silently reverts the four action bumps on `main`; a merge instead conflicts
in 60 files. **Fix, effort S, value medium:** before the frozen prep, open one PR into
Testing that applies the same four bumps (cherry-pick `18eb316`, `4c1edc8`, `928949b`,
`c3f1fa3`), let CI prove them (upload-artifact 7 and setup-go 7 are major versions), then
add `target-branch: Testing` to every block in `.github/dependabot.yml` so future bumps
follow the promotion direction ("do not patch main first", `channels.md` step 3).

### B8. The repository default branch is `Testing`, the docs say `main`

`gh api` reports `default_branch: Testing`. `channels.md` line 16 says the remote "uses
`main` as the default", and `INSTALL.md` line 204 says "stay on `main` (the default
branch)". A plain `git clone` therefore lands on the integration branch. **Fix (maintainer,
S, medium):** set the default branch back to `main` in Settings, or correct both documents;
re-check before tagging because Dependabot and the repository home page follow it.

### B9. No license, while the goal is "free for the world"

The repository has no `LICENSE` and the API reports `license: null`. `known-limitations.md`
"No project license" is filed under **Release gates** and says to "choose and commit the
intended license before publishing binaries, containers, or an 'open-source'
announcement", and that it "must not be guessed by automation". Public containers were
published before without it, but the operator's stated goal makes this the moment.
**Maintainer decision, effort S, value high:** pick a license (the page lists Apache-2.0 and
AGPL-3.0 with their trade-offs), add `LICENSE`, the `license` field in `pyproject.toml` and
`package.json`, `org.opencontainers.image.licenses` in the three Dockerfiles, and update
the limitation. Agents must not choose it.

## 4. The ordered release plan

Owners: **[A]** an agent in this sandbox, **[M]** the maintainer on GitHub, **[H]** the
maintainer on a Docker host. The plan is written for version `V` (0.2.0 recommended, or
0.1.13 with the recorded exception).

**Phase 0: decisions before the Round 16 SPEC freezes**

1. [M] Choose `V` (B6).
2. [M] Choose the repository identity (B1, Option A or B).
3. [M] Choose a license (B9).
4. [M] Decide the default branch (B8).

**Phase 1: bring Testing in line**

5. [A] PR into Testing with the four Dependabot bumps and `target-branch: Testing` (B7). CI
   must pass.
6. [A] Round 16 feature work on `claude/round16`, including the identity code fix (B1), the
   migration honesty and test (B4), the release guards (R11), the release feed for What's
   new and Communication (R13) and the version bump if `V` is 0.2.0 (B6). PR into Testing;
   `CI passed` green on the PR head; squash-merge; confirm the Testing push run is green.

**Phase 2: evidence that needs PostgreSQL**

7. [H or A] Measure the `audit.id` widening (B4) and run the v0.1.1 rollback rehearsal (B5).
   Write the results into the release notes in step 8.

**Phase 3: the frozen release-preparation change**

8. [A] Branch from the merged Testing head; make only the record changes in section 5;
   regenerate the corpus; run every local gate (section 5.4); PR into Testing; green; merge.
   Call the resulting Testing commit `T`. From here, nothing but evidence records may change.
9. [A] Build `T` with exact stamps and run the full browser matrix (section 6). Fix any
   failure through a new PR into Testing and repeat from step 8's gates and step 9.
10. [H] Shipping-image acceptance of `T` (the v0.1.12 precedent in the Journal: build the
    three images for `linux/amd64` with channel `testing`, check labels, health, updater
    socket, `release.json`, frozen Compose hash).
11. [A] One journal-only PR into Testing that records steps 9 and 10 (and a receipt file under
    `docs/research/2026-11-round16/acceptance/`, which `mkdocs.yml` `exclude_docs: research/`
    keeps out of the Help Center). Merge; the resulting commit `T'` is the accepted candidate.

**Phase 4: dress rehearsal (strongly recommended, given seven failed or blocked tags)**

12. [M, H] In a disposable test repository (not the canonical one): push `T'` as its `main`,
    push the annotated tag `vV` there, let CI, the release workflow and the docs workflow run,
    make its packages public, then bootstrap a canonical v0.1.1 PostgreSQL Compose
    deployment against it with `AGENTIC_SOC_UPDATE_REPOSITORY=<owner>/<test-repo>`. This is
    the only place a failure costs nothing: tags there are not the canonical immutable
    history. `testing.md` "Release acceptance" step 8 already requires an isolated test
    repository for the publication fault injection; do both in one session.

**Phase 5: promotion to `main`**

13. [M] Create the promotion head as a tree replacement (the method used for v0.1.12):

    ```bash
    git fetch origin
    git switch -c release/promote-V origin/main
    git read-tree -u --reset "<T' sha>"
    git commit -m "release: promote Agentic SOC vV to Stable"
    test "$(git rev-parse HEAD^{tree})" = "$(git rev-parse '<T' sha>^{tree}')"
    git push origin release/promote-V
    gh pr create --base main --head release/promote-V --title "release: promote Agentic SOC vV to Stable"
    ```

14. [M] Wait for `CI passed` on the PR head, squash-merge, then confirm the `main` push run is
    green on the resulting commit `M` and that `git rev-parse M^{tree}` equals `T'^{tree}`.
15. [A] Rebuild at `M` with `TLSOC_RELEASE_CHANNEL=stable` and `TLSOC_BUILD_SHA=M`, from a
    scratch clone whose checkout is the literal `main` branch, and repeat the complete
    browser matrix ("repeat the complete matrix on the final promoted `main` commit before
    tagging", `testing.md` line 237). The badge must read `vV · Stable`. Record the result in
    the PR conversation; it goes into the repository only after the tag (step 20), because any
    commit on `main` now would move the release commit.

**Phase 6: the immutable tag**

16. [M] Verify repository settings: `main` and `Testing` require `CI passed` (verified today);
    the `stable-release` environment used by `release.yml` line 23 admits the tag and its
    reviewers are available; the `github-pages` environment admits `v*`; Settings, Pages,
    Source is GitHub Actions; under Option A, decide the GHCR runbook in B2.
17. [M] Create and push the annotated tag exactly as `channels.md` lines 152 to 163 show, with a
    concrete summary in the second `-m`. Do not create it before step 15 passes.
18. [M] Watch three workflows: tag CI (about 25 minutes), the release workflow (it waits up to
    40 minutes for tag CI and has a 120 minute budget), the Documentation workflow (waits up
    to 2 hours for the published release). Apply B2 if the anonymous-read step fails. Never
    use `continue-on-error`, never move or delete the tag.
19. [M] Verify the public result: exactly two assets; `cosign verify-blob` and `cosign verify`
    with the new identity (`https://github.com/<owner>/<repo>/.github/workflows/release.yml@refs/tags/vV`);
    anonymous pulls by digest; plan tag, commit, labels and compatibility; Pages `/`, the line
    path, `/stable/`, `/latest/` and `versions.json`.

**Phase 7: canonical acceptance and records**

20. [H] Canonical bootstrap from v0.1.1 on PostgreSQL Compose: set the repository in `.env`
    first, clean checkout of `vV`, run `./scripts/bootstrap-updater.sh`, check the receipt,
    health, `release.json`, `build-info`, the Console badge and the post-update browser
    matrix. Only then is `vV` installable. If this fails, `vV` is a historical record and the
    fix ships as the next patch.
21. [A] PR into Testing that records the Stable and canonical acceptance in the Journal, adds
    the receipt, bumps `scripts/rollback_previous_release.json` to the `vV` tag commit for the
    next round, and opens the next development cycle.

## 5. The frozen release-preparation change (step 8)

Only records and generated artifacts change here. Code, tests and identity constants belong
in the Round 16 code PR so this change stays reviewable as "no behavior".

### 5.1 `CHANGELOG.md`

1. Move everything under the current `## [Unreleased]` (lines 14 to 2359: Round 16, Round 15,
   Documentation refresh, Round 14 follow-up, Round 14, Earlier rounds, Fixed, Added, Changed,
   Upgrade notes) under the release heading.
2. For 0.1.13: merge the existing August text of `## [0.1.13]` into the same section (as a
   "Legacy bootstrap correction" subsection) and change the date to the tag date; there must
   be exactly one `## [0.1.13] - YYYY-MM-DD`. Rewrite its "Release boundary" bullets: the
   identity change (B1) and the column widening (B4) are now part of the boundary.
   For 0.2.0: create `## [0.2.0] - YYYY-MM-DD` and convert the old 0.1.13 heading to a
   Development snapshot (B6).
3. Put a one-paragraph summary at the top of the release section with the operator-visible
   headline, compatibility changes, required upgrade steps and the rollback boundary, so a
   reader does not need the 2,400 lines below.
4. Open a fresh `## [Unreleased]` above it containing only `No changes yet.` (the wording
   `main` uses today).
5. Run `python3 scripts/check_version.py`; it requires exactly one `[Unreleased]` and the dated
   heading.

### 5.2 `docs/releases/V.md` (the GitHub Release body)

Keep the seven markers `check_version.py` requires (`# Agentic SOC V`, ``annotated tag `vV` ``,
`Exact Stable build identity`, `Immutable annotated-tag checklist`,
`TLSOC_RELEASE_CHANNEL=stable`, `TLSOC_BUILD_SHA`, `TLSOC_BUILD_DATE`). The body is
`<!-- agentic-soc-release-commit:SHA -->` plus this file, and GitHub rejects release bodies
over 125,000 characters (community-reported, not in official docs:
[intuit/auto#2418](https://github-redirect.dependabot.com/intuit/auto/issues/2418)), so keep it
under about 60,000 characters and link out for detail. Proposed outline:

1. Summary: what this release is (the first release carrying Rounds 12 to 16 since v0.1.12),
   and the "a candidate is not an installable Stable release" warning.
2. What is new, by area, one short paragraph each: chat without limits and dynamic starters
   (Rounds 12 to 13); Dashboards library, Audit log, rule sheets, one Runbooks feature,
   docked console (Round 14); RBAC switch, truthful setup wizard, Team activity, case
   screenshots, auto-close review, calmer Case Manager (Round 15); Round 16 items (the AI
   investigating indicator, the Case Manager detail header, the login page and Remember me,
   explainable numbers including the risk score math, What's new and Communication, fixed
   bugs). Link each to its Help Center page, not to research folders.
3. Compatibility and API changes: the 410 and 409 responses, the permission remap, the
   deprecated read aliases (removal planned for the next minor), `AUTH_TOKEN_HOURS` cap,
   `TRUSTED_PROXIES`, chat outside the AI budget, `chat_limits_version` 2.
4. Upgrade steps: the repository line in `.env` (B1); the PostgreSQL column widening with
   timings and the large-table pre-step (B4); the Elasticsearch audit template step from
   CHANGELOG Upgrade notes; the one-shot runbook migration; what Demo Mode does.
5. Rollback: the v0.1.1 rehearsal result (B5) and the Round 14 and Round 15 rollback notes.
6. Signed artifacts: the new GHCR paths, asset URLs and identity predicate; a sentence that
   v0.1.12 artifacts remain valid under the old identity.
7. Signed plan and compatibility (plan schema 1, `from` range, state schema 1, protocol 1,
   frozen Compose hash `e3f7ecbb0f749cc9d88f4392c58c9a63ddbd064e80ecde9f21fe9de199086fd4`).
8. Exact Stable build identity (the existing block with `V`).
9. Immutable annotated-tag checklist (the existing steps).
10. Operator bootstrap (with the `.env` line) and independent verification commands.
11. Verification evidence: CI run ids for `T'`, `M` and the tag, test counts, the browser
    receipt id, image acceptance.
12. Known limitations: link to `known-limitations.md` and list the new ones in one line each.

Screenshots: do not embed images in this file. Relative image links are broken in a GitHub
Release body, and the docs rule keeps in-app links same-origin. Put screenshots on the
What's new page (R13) and link to it.

### 5.3 Other files in the same change

- `docs/releases/0.1.md` (or new `0.2.md`): the "current source version" paragraph (lines 10
  to 20, 54, 149, 179).
- `docs/releases/channels.md`: "Version 0.1 nomenclature" (lines 65 to 109) gains the
  release's scope; the topology note (line 16) matches the real default branch; the
  publisher identity under Option A.
- `docs/releases/documentation-versions.md`: the table row at line 50.
- `docs/releases/known-limitations.md`: front matter, line 8, 40, 154 to 165, 235; new entries
  for Round 16 limits, the column widening, v0.1.1 rollback results, and the identity change.
- `docs/operations/upgrades.md`: "Changes that need attention when upgrading to this build"
  (line 468) becomes the release's upgrade section, with a Round 16 subsection and the B4
  text; bootstrap step 2 names the repository value.
- `docs/index.md` lines 16 to 20 and 147 to 169; `docs/reference/compatibility.md`;
  root `COMPATIBILITY.md`.
- `docs/development/testing.md`: replace the 7,526 / 4,750 baseline (line 13) with the
  measured counts; add Round 16 rows to the browser matrix (What's new on first sign-in per
  version and dismissal, the Communication page and a release with screenshots, the AI
  investigating indicator, every explainable number on hover, focus and click including the
  risk score breakdown, the login page with Remember me and no duration, the new Case
  Manager header).
- `README.md`, `INSTALL.md` (line 202 Stable row, line 204 default branch, line 266
  repository), `DEPLOY.md`, `.env.example` line 46.
- `AGENTS.md` section 10 (Round 16 bullet, release topology, current baseline),
  `docs/HANDOFF.md`, `ROADMAP.md`, `Journal.md`.
- The What's new entry for `V` and its screenshots (R13).
- `mkdocs.yml` nav label for the release page (drop nothing; keep historical pages).
- Generated: `cd webui && npm run gen:console-map`, then
  `backend/.venv/bin/python scripts/build_app_knowledge.py` (the corpus records the product
  version, so the docs lane fails until rebuilt).

### 5.4 Local gates before opening the prep PR

```bash
python3 scripts/check_version.py
TLSOC_SOURCE_REF=refs/tags/vV TLSOC_RELEASE_CHANNEL=stable python3 scripts/check_version.py
python3 scripts/check_ci_contract.py && python3 -m unittest scripts.test_check_ci_contract -v
python3 scripts/check_docs.py
backend/.venv/bin/python scripts/build_app_knowledge.py --check
(cd backend && .venv/bin/python -m pytest -q)
(cd webui && npm ci && npm run typecheck && npm run lint && npm run gates \
   && npm run test:strict && npm run check:types && npm run build && npm run docs:check)
python3 -m unittest discover -s updater/tests -v
bash -n scripts/run-demo.sh scripts/bootstrap-updater.sh scripts/agentic-soc-compose.sh
python3 -m unittest scripts.test_rollback_lane -v
sha256sum deploy/docker-compose.agnostic.yml   # must equal deploy/update-base-v1.sha256
```

`docker compose ... config --quiet`, actionlint and the PostgreSQL lane run in CI; the
sandbox cannot pull images.

## 6. The browser acceptance receipt in this sandbox

### 6.1 What can run here

Playwright 1.63.0 with Chromium 153 (preinstalled), `axe-core` from `webui/node_modules`,
the backend from `backend/.venv`, and `vite preview` serving the exact built `dist/` with a
same-origin `/api` proxy. Keep the harness in the session scratchpad (no new repository
dependency, the same approach the Journal records for earlier rounds).

### 6.2 Commands

```bash
REPO=<scratch clone checked out at T' (or at main for step 15)>
cd "$REPO"
export TLSOC_VERSION="$(tr -d '[:space:]' < VERSION)"
export TLSOC_RELEASE_CHANNEL=testing          # stable for step 15, from a literal main checkout
export TLSOC_BUILD_SHA="$(git rev-parse HEAD)"   # full 40 characters
export TLSOC_BUILD_DATE="$(git show -s --format=%cI HEAD)"
(cd webui && npm ci && npm run build)           # docs bundle + tsc + Vite, stamped
# Backend with the SAME stamps (run-demo keeps caller-supplied identity), auth on, seeded demo.
DEMO_MODE=seeded ./scripts/run-demo.sh &        # backend :8088 (its dev server :5173 is not used)
(cd webui && npx vite preview --port 4173 --strictPort) &
# A second, empty backend for first-run setup (no demo seeding):
#   start uvicorn on :8089 with AUTH_ENABLED=true and a fresh state, then
#   (cd webui && BACKEND_URL=http://127.0.0.1:8089 npx vite preview --port 4174 --strictPort)
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node <scratchpad>/receipt/run.cjs \
  --base http://127.0.0.1:4173 --setup-base http://127.0.0.1:4174 --out <scratchpad>/receipt/out
```

Point the backend's artifact directory and any state files at the scratchpad (for example
`TLSOC_JOBS_ARTIFACT_DIR`) so the run writes nothing under the repository.

### 6.3 What the harness does

1. Identity: read `/release.json` and `/api/health/build-info`; fail unless both report `V`,
   the channel and the full SHA; read the top-bar badge text and open its popover.
2. Route sweep, generated from `backend/app/knowledge/console_map.json` (29 page targets and
   31 Settings sections, so no route is forgotten) plus the compatibility aliases in
   `webui/src/soc/router.tsx` (`#/dashboard`, `#/playbooks`, `#/catalog`, `#/scans`,
   `#/analytics`, `#/users`, `#/security`, `#/sessions`, `#/account`, `#/roles`).
3. Matrix per route: viewports 1440x900 and 390x844; theme Light, Dark, and System under both
   emulated `prefers-color-scheme` values (set the user's theme once through the real theme
   control, then through the preference API for speed).
4. Per load, record and fail on: `pageerror`, console errors, failed or 4xx/5xx same-origin
   requests (allow-list only documented expected denials), horizontal overflow
   (`scrollWidth > clientWidth`), a blank lazy canvas, axe serious or critical violations;
   save a screenshot.
5. Scripted interaction paths for each matrix area in `testing.md` lines 135 to 143: sign-in
   username then password, wrong password and retry, Remember me; first-run setup on the
   empty backend; Overview drill-downs; the Dashboards library and an Edit-mode board; Cases
   to Case Manager handoff, queue tabs, divider keyboard resize and reset, bulk menu, the five
   tabs and legacy `tab=timeline`, the close dialog, Files add, paste, view, delete, the
   auto-close review; Runbooks run with its Next step card; Team activity sheet; the RBAC
   switch dialogs; Settings search, deep link, dirty state; an installed `/docs/0.1/` (or
   `/docs/0.2/`) article; plus the Round 16 rows. Use keyboard only for at least one pass
   through rail, tabs, menus, dialogs and Sheets, and check Escape and focus return.
6. Output: `receipt.json` (every check) and `receipt.md` with the template below.

### 6.4 What cannot run here, and must be stated in the receipt

- The real nginx proxy (`webui/nginx.conf`): unbuffered SSE, the 3 MiB screenshot body
  bound, `/index.html` no-store and `/assets/` immutable caching, security headers. Vite
  documents that preview "is intended for previewing the build locally and not meant as a
  production server" ([Vite static deploy](https://vite.dev/guide/static-deploy)). Cover
  these in step 10 on the maintainer host, or install Ubuntu's `nginx` here and run a copy
  of `nginx.conf` with the upstream set to `127.0.0.1:8088` and `root` set to `webui/dist`
  (the Ubuntu archive is reachable from this sandbox; not attempted).
- The Release update row (signed preflight, supervisor states, rollback): only the
  manual-upgrade boundary and the badge are visible without a supervisor. The rest belongs
  to steps 12 and 20.
- SSO (no identity provider), Firefox and Safari (only Chromium is installed).

### 6.5 Receipt template

```text
Agentic SOC browser acceptance receipt
Date (UTC):            YYYY-MM-DD HH:MM
Candidate:             vV, channel testing|stable, SHA <40 chars>, build date <ISO>
Console /release.json: <values>   Backend build-info: <values>   Badge: "vV · Testing"
Served by:             vite preview over webui/dist (not nginx); backend uvicorn, auth on, seeded demo
Browser:               Chromium 153.0.8010.12 (Playwright 1.63.0), headless
Viewports:             1440x900, 390x844
Themes:                Light, Dark, System(light), System(dark)
Routes swept:          N pages x 2 viewports x 4 themes, M Settings sections, K aliases
Interaction paths:     list, each pass/fail
Console/page errors:   0 unexplained (list any explained)
Failed requests:       0 unexplained
Horizontal overflow:   0
axe serious/critical:  0 (or list)
Not covered here:      nginx proxy behaviors, Release update supervisor paths, SSO, non-Chromium
Screenshots:           <link to PR attachment or archive>
Result:                PASS | FAIL
```

## 7. Recommendations

| # | Recommendation | Where | Effort | Value | This round |
| --- | --- | --- | --- | --- | --- |
| R1 | Fix the repository identity before tagging (B1) | updater, bootstrap, `config.py`, Console, `mkdocs.yml`, docs, tests | M | high | yes |
| R2 | Decide the version: 0.2.0 per `channels.md`; or record an exception for 0.1.13 (B6) | `VERSION` and the files in B6 | M | high | yes |
| R3 | Rewrite `CHANGELOG.md` and open an empty `[Unreleased]` in the frozen prep (5.1) | `CHANGELOG.md` | S | high | yes |
| R4 | Rewrite the release page for Rounds 12 to 16, kept under about 60,000 characters (5.2) | `docs/releases/V.md` | M | high | yes |
| R5 | Make the `audit.id` widening honest and safe: measure, raise the backend timeout if needed, document the pre-step (B4) | `engine.py` docs, `release.yml` plan args, `upgrades.md` | S | high | yes |
| R6 | Rehearse image-only rollback to v0.1.1 on the new data and publish the result (B5) | `scripts/rollback_lane.py --previous-release`, `known-limitations.md` | M | high | yes |
| R7 | Forward-port the four Dependabot bumps into Testing and set `target-branch: Testing` (B7) | `.github/workflows/*.yml`, `.github/dependabot.yml` | S | medium | yes |
| R8 | Align the default branch with the docs (B8) | GitHub settings or `channels.md`, `INSTALL.md` | S | medium | yes |
| R9 | Add a LICENSE chosen by the maintainer (B9) | root, packaging metadata, Dockerfile labels | S | high | yes |
| R10 | Build the scratchpad browser receipt harness (section 6) | session scratchpad; receipt under `docs/research/2026-11-round16/acceptance/` | M | high | yes |
| R11 | Release guards in `check_version.py`: on `refs/heads/main`, a `v*` tag or a PR into `main`, require the `[Unreleased]` body to be exactly `No changes yet.`; fail when marker plus release page exceeds 100,000 characters; require a What's new entry for `VERSION` whose screenshots exist and stay within a size budget | `scripts/check_version.py`, `ci.yml` env for PRs into `main` | S | medium | yes |
| R12 | Dress rehearsal of tag, release, docs workflows and v0.1.1 bootstrap in a disposable test repository (Phase 4) | maintainer | L | high | yes |
| R13 | One release feed for What's new and Communication, generated from `docs/releases/*.md` front matter (status, date, highlights, screenshots) with a `--check` mode like the console map; screenshots as WebP at 1440x900 under `docs/assets/releases/V/` (served same-origin from the installed Help Center), total at most about 1.5 MB per release; the first-sign-in gate lazy so the entry chunk stays inside its +1,024 B budget over 329,080 B; the seen version stored per user in `UserPrefs.misc` (KV, #12) | `scripts/`, `docs/releases/`, `webui/src/soc/` | M | medium | yes |
| R14 | Fix the dead public docs links and canonical URLs now (they 404 today) | `Docs.tsx` 43 to 51, `mkdocs.yml` 3 to 5, 80, 91 | S | medium | yes |
| R15 | Write the GHCR visibility pause into the release runbook (B2) | `docs/releases/channels.md`, `docs/releases/V.md` | S | high | yes |
| R16 | SBOM attestation for the three images | `release.yml` | M | medium | no |
| R17 | Refresh stale test baselines in `testing.md` | `docs/development/testing.md` line 13 | S | low | yes |

## 8. Risks

- **A published tag is permanent.** The repository uses GitHub immutable releases (the
  v0.1.12 release reports `immutable: true`): once published, assets cannot be changed and
  the tag cannot be moved or deleted, and a deleted release's tag name cannot be reused
  ([Immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)).
  Any error found after publication costs a new version. Mitigation: R12, and tag only after
  step 15.
- **Identity change.** Under Option A every future verifier must use the new identity; a
  host whose `.env` keeps the old value fails closed (correct, but support load). Mitigation:
  the bootstrap refusal text and one prominent upgrade step.
- **Rollout timeout on large audit tables** (B4). Mitigation: measure, raise to 900 s, pre-step.
- **Rollback to v0.1.1 leaves a degraded v0.1.1** (B5). Mitigation: rehearse and document
  before the first field bootstrap.
- **Workflow waits.** Tag CI must finish within the release workflow's 40-minute wait and the
  release within the docs workflow's 2-hour wait; a GHCR pause can exceed the latter.
  Mitigation: re-run on the tag; both are designed to be re-runnable.
- **Promotion drift.** A merge-based promotion conflicts in 60 files; a tree replacement
  reverts the Dependabot bumps unless R7 lands first.
- **Scope creep inside the freeze.** Round 16 is large; every fix after step 8 restarts the
  receipt. Mitigation: freeze code before step 8; record-only changes after.
- **Screenshot privacy.** Release screenshots must come from the seeded demo with synthetic
  values only (the docs refresh followed this rule).

## Sources

- [SemVer 2.0.0](https://semver.org/spec/v2.0.0.html) (items 4, 6, 7 and the 0.y.z FAQ)
- [GitHub Docs: Renaming a repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository)
- [GitHub API changelog: automatic redirects for renamed repositories](https://developer.github.com/changes/2015-07-21-automatic-redirects-for-renamed-repositories)
- [GitHub Docs: Configuring a package's access control and visibility](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility)
- [GitHub Docs: Immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
- [Sigstore: OIDC usage in Fulcio](https://docs.sigstore.dev/fulcio/oidc-in-fulcio)
- [Vite: preview options](https://vite.dev/config/preview-options)
- [Vite: deploying a static site](https://vite.dev/guide/static-deploy)
- [intuit/auto issue 2418](https://github-redirect.dependabot.com/intuit/auto/issues/2418) (125,000-character release body limit; community report, not official)
- Not verified: whether GitHub keeps a redirect after renaming a repository back (Option B);
  exact PostgreSQL ALTER durations for this schema; whether Ubuntu `nginx`,
  `postgresql-16` and `postgresql-16-pgvector` install cleanly in this sandbox.

## Journal entry (for the orchestrator to append)

```text
### 2026-11-24 20:45Z - Round 16 research agent (release) - Release readiness for the next Stable release
- Context: Round 16 discovery, key "release": an ordered plan to ship Rounds 12 to 16 as the next Stable release, the frozen preparation change, the browser receipt in this sandbox, maintainer-only steps, risks, and whether 0.1.13 is the right number.
- Did: read channels.md, 0.1.13.md, testing.md, CHANGELOG, check_version.py, the three workflows, the updater contract and bootstrap; simulated the Testing-to-main promotion in a scratch clone (60 conflicts; previous promotions were tree replacements); queried GitHub (no v0.1.13 tag; default branch Testing; license null; both branches require CI passed); inspected the v0.1.12 certificate (SAN names Agentic-Kibana). Found blockers: the repository rename breaks the updater trust chain, GHCR namespace and public docs URLs; stale 0.1.13 records; an undeclared in-place PostgreSQL column widening inside the rollout; no v0.1.1 rollback rehearsal; main-only Dependabot commits; no LICENSE. Under channels.md the release is a MINOR (0.2.0). Report at the scratchpad path round16/research/release.md. No repository file changed.
- Tests: check_version (also tag and main contexts), check_ci_contract, check_docs and build_app_knowledge --check pass on 3cd362c; Playwright Chromium headless smoke passed; vite preview serves dist and proxies /api.
- Status: done (research only).
- Next: maintainer decides version, repository identity, license and default branch; then Round 16 code PR with the identity fix and release guards, the PostgreSQL measurements and v0.1.1 rollback rehearsal, the frozen prep, receipts, a dress rehearsal, promotion and the tag.
```
