# Round 16 SPEC: visible AI work, explainable numbers, a segregated Case Manager, a quiet sign-in, What's new, and release 0.2.0

Status: binding for every Round 16 work package. Owner: orchestrator. Branch: `claude/round16`
(starts at `3cd362c`, "Journal: Round 16 start", one commit on top of `3cfd5c0`, the Round 15
merge into `Testing`; reaches `Testing` through a pull request). Version moves from `0.1.13` to
**`0.2.0`**, documentation line **`0.2`** (D1). `CHANGELOG.md` keeps one `[Unreleased]` section
for the round's entries.

This document replaces nothing in `AGENTS.md`. Where it is silent, `AGENTS.md`,
`docs/development/ui-standard.md`, `docs/development/design-system.md` and the Round 12, 13, 14
and 15 specs stay binding. Every override of those documents is listed in §6.4.

Inputs (the evidence base; read the parts your package cites). They are committed beside this
file:

- `research/SYNTHESIS.md` **[syn]**: the proposed scope and nineteen work packages. It is the
  backbone of §4; this SPEC adjusts it for the operator decisions D1 to D14.
- Ten research reports in `research/`, cited by key and recommendation id (for example
  [cmux] R4, [expl] D-API-2):
  - `competitors.md` **[comp]**;
  - `oss-ecosystem.md` **[oss]**;
  - `case-manager-ux.md` **[cmux]**;
  - `explainability.md` **[expl]**;
  - `ai-investigating.md` **[ai]**;
  - `login.md` **[login]**;
  - `whats-new.md` **[wn]**;
  - `release.md` **[rel]**;
  - `backend-roadmap.md` **[be]**;
  - `data-visibility.md` **[dv]**.
- `review/bug-hunt.md` **[bugs]**: the 81 confirmed bugs with evidence, failure scenario,
  proposed fix and the skeptic's minimal fix, ids B01 to B81 (Appendix A allocates them).

Every file path, function name and line reference below was checked against the tree at
`3cd362c`. Line numbers are the `def` line unless stated; they drift as packages land, so a
package re-reads the code before it edits.

Copy rule for every string that reaches a screen or a document: plain, specific, sentence case,
no em dashes, no en dashes used as dashes, no U+00A0 and no Cf characters, numbers with thousands
separators, only the product name "Agentic SOC", never the word "Round" in Console copy, never
"playbook" in Console-authored copy, and never "Investigating" alone for the AI (it is the human
acknowledged status, `CaseStatus.INVESTIGATING`).

---

## 1. Operator asks

The operator's message is not stored in the repository word for word. The orchestrator's Journal
entry of 2026-11-24 19:00Z records it as: show when the AI agent is investigating a case (and keep
the run's result authoritative), use the wasted space at the top of the Case Manager detail pane,
a cleaner and segregated Case Manager from deep research, a cleaner login page and animation with
"Remember me" and no duration, a bug hunt across the application, research agents on what to
build next (competitors, features, backend), every number explainable on hover or click with its
exact math (for example the risk score), a first-login "What's new" screen for each update plus a
Communication page that tracks every release with notes and screenshots, and to ship this as the
next release.

The discovery reports recorded these phrases verbatim:

- "whenever a new update is delivered, if a user logs in, a first time welcome to that update,
  what's new upfront screen shall be shown" ([wn] header).
- "it should be in the communication tab, all changes, well documented and screenshotted like a
  release tracker" ([wn] header).
- "this should be the next release" ([wn] header).
- "super clean and aesthetic" (the sign-in page, [login] §0), and the Remember me row that says
  only "Remember me".
- "a lot more cleaner and segregated" (the Case Manager, [syn] §2).
- "notification while AI investigates" ([cmux] §5.4).
- "81, show me the math" (the risk score, [bugs] B13 area) and "All data visible in some way"
  ([syn] WP14).
- "free for the world" (the goal behind the license decision, [rel] B9).
- On a close made while the AI runs: "Nope" to changing the rule that the run's result wins (D10).

Read as ten deliverables:

1. **A1 Visible AI work.** Anyone can see that the AI is working on a case, from the queue, the
   case, the navigation and the close dialog. The run's result stays authoritative; the Console
   now says so before a person acts, and notifies after.
2. **A2 Reclaimed space.** The Case Manager detail pane starts its content near the top: the
   first content of the active tab at most 210 px from the top of the window at 1440 by 900 and
   at 390 by 844, down from 324 px ([cmux] §2.1; WP03 defines the measured point).
3. **A3 A segregated Case Manager.** One question per region: tabs that each hold one lane
   (Brief, Evidence, AI investigation, Response, Activity, Chat) and an inspector column.
4. **A4 A quiet sign-in page.** Console tokens, one short entrance, nothing moving afterwards,
   and "Remember me" with no duration.
5. **A5 Bug hunt.** Every confirmed bug fixed (D12).
6. **A6 What to build next.** A ranked backlog (§7).
7. **A7 Explainable numbers and reachable data.** Hover any number for a one-line formula with
   the real numbers; click for inputs, steps, rounding and provenance. Every stored case field is
   visible somewhere.
8. **A8 What's new and Communication.** A once-per-update welcome after sign-in and a release
   tracker page with notes and screenshots under a "Communication" navigation group.
9. **A9 The next release.** Ship as 0.2.0, installable only after canonical acceptance (D1, D2).
10. **A10 Free for the world.** An Apache-2.0 license (D3).

---

## 2. Decisions

### 2.1 Operator decisions (binding)

**D1. Version 0.2.0, documentation line 0.2.** The never-tagged 0.1.13 candidate (the legacy
bootstrap correction) folds into 0.2.0.

- Code facts:
  - `VERSION` is `0.1.13`; no `v0.1.13` tag exists ([rel] §2). `docs/releases/channels.md`
    "Semantic versioning before 1.0" makes a new capability set a MINOR ([rel] B6).
  - `scripts/check_version.py` `main()` (line 75) derives the documentation line from `VERSION`
    (line 78) and requires: the same version in `backend/app/__init__.py`, `UPDATER_VERSION`
    (`updater/agentic_soc_updater/__init__.py:6`), `backend/pyproject.toml`, `webui/package.json`,
    both lockfile roots and `webui/openapi.json`; a dated heading `## [VERSION] - YYYY-MM-DD` in
    `CHANGELOG.md`; `docs/releases/{VERSION}.md` with seven markers; `docs/releases/{line}.md`
    naming the version; `mkdocs.yml` `product_version` and `docs_version` (lines 78 and 79) and a
    nav entry `releases/{VERSION}.md`; and the line in `docs/index.md`, `channels.md` and
    `documentation-versions.md`.
  - `CHANGELOG.md` has `## [Unreleased]` at line 13 and `## [0.1.13] - 2026-08-05` at line 2360.
  - `scripts/build_upgrade_plan.py:45` defaults `--max-version-exclusive` to `0.2.0`, so a 0.2.0
    install could never accept a 0.2.1 plan. Its test
    `test_release_plan_builder_emits_protocol_and_digest_pins` (`updater/tests/test_updater.py`,
    about line 401) asserts only the minimum.
  - `scripts/build_docs_bundle.py` writes the Help Center under `/docs/<line>/` and alias pages
    through `_redirect_page` (line 65). 51 files outside `docs/research/` and the Journal name
    `/docs/0.1`. The chat citation grammar `DOC_REF_PATTERN` (`backend/app/agents/blocks.py`,
    about line 284) accepts any `/docs/N.N/` line, so stored citations stay valid; redirect stubs
    keep them working.
  - `UPDATER_VERSION` is only reported (`updater/agentic_soc_updater/service.py:122, 381`); no
    updater or backend code restricts a target to the 0.1 line ([rel] B6).
- Decision: WP05 part 1 moves every current-version string to 0.2.0 as the second merge of the
  round (§3.8 lists exactly what moves and what does not). `check_version.py` stays green at every
  merge.

**D2. Repository identity: `ARYDESTROYER/Kavach-AgenticSOC`** is the update trust root and every
identity: the GHCR prefix, OCI source labels, the bootstrap default, the release-discovery
default, Console links and the public docs URL ([rel] B1, Option A).

- Code facts: the old name is the default in `updater/agentic_soc_updater/__main__.py:21`,
  `scripts/bootstrap-updater.sh:45`, `backend/app/config.py:2408`
  (`ReleaseUpdateConfig.repository_url`), `backend/Dockerfile:13`, `webui/Dockerfile:48`,
  `updater/Dockerfile:9`, `.env.example:46`, `mkdocs.yml` lines 3 to 5, 80 and 91,
  `webui/src/soc/pages/Docs.tsx:44, 46, 51` and `webui/src/soc/pages/settings/release-updates.tsx:25`.
  `INSTALL.md:266` tells operators to keep the old name. The old name is also a live default in
  `docs/ENVIRONMENT.md:211`, `docs/reference/configuration.md:211`, the "Observe upstream source
  revisions" block of `docs/operations/upgrades.md` (line 869), `docs/HANDOFF.md:9` and the
  updater smoke step of `.github/workflows/ci.yml` (line 918, `UPDATE_TRUSTED_REPOSITORY`). 44
  files name it outside the research folders. The frozen base `deploy/docker-compose.agnostic.yml`
  hard-codes the old default at lines 200 and 209, and its SHA-256 is pinned by
  `deploy/update-base-v1.sha256`, so that file cannot change under protocol 1.
  `release_discovery.py` rejects redirects by design ([rel] §2). The updater passes the trusted
  repository verbatim to `cosign --certificate-identity`
  (`updater/agentic_soc_updater/runtime.py:209-213`), an exact, case-sensitive match.
  `_canonical_public_github_repository` (`config.py:2330`) strips `.git` and slashes and keeps
  the case. The legacy ELK Compose file and its install steps use a local checkout directory
  named `agentic-kibana` (`deploy/docker-compose.tlsoc.yml:20-23, 32`, `DEPLOY.md:865`,
  `INSTALL.md:1105-1202`); that is a directory name, not a repository identity.
- Decision: WP05 part 2 adopts the new name. The frozen Compose file keeps its old default. The
  bootstrap script refuses an `.env` without `AGENTIC_SOC_UPDATE_REPOSITORY`, or whose value
  matches `ARYDESTROYER/Agentic-Kibana` ignoring case, with remediation text; it also refuses a
  value equal to `ARYDESTROYER/Kavach-AgenticSOC` ignoring case but not exactly, with the
  message that the signing identity is case-sensitive. It never edits `.env`. In
  `ReleaseUpdateConfig`, after the existing canonicalisation, a value whose owner and repository
  equal `ARYDESTROYER/Agentic-Kibana` ignoring case becomes
  `https://github.com/ARYDESTROYER/Kavach-AgenticSOC`; any other value is kept. The local
  checkout directory `agentic-kibana` stays as a compatibility literal in the legacy ELK files.
- Migration notes (written into `docs/operations/upgrades.md`, `INSTALL.md`, the 0.2.0 release
  page and What's new for administrators): set
  `AGENTIC_SOC_UPDATE_REPOSITORY=ARYDESTROYER/Kavach-AgenticSOC` in `.env` before bootstrapping;
  the publisher identity, GHCR namespace and source label changed; v0.1.12 artifacts stay valid
  under the old identity; old Pages URLs answer 404 because GitHub does not redirect project Pages
  after a rename.

**D3. License: Apache-2.0.**

- Code facts: no `LICENSE` file; `README.md:647-650` says the repository publishes no license;
  `docs/releases/known-limitations.md:26-34` files "No project license" under release gates; the
  three Dockerfiles set OCI labels (`backend/Dockerfile:15-21`, `webui/Dockerfile:50-56`,
  `updater/Dockerfile:11-17`) but no `org.opencontainers.image.licenses`. The signed plan's label
  set is fixed by `updater/agentic_soc_updater/contract.py:196` and does not include the license
  label, so adding it changes no plan.
- More code facts: `backend/pyproject.toml:2` requires `setuptools>=68`; the SPDX string form
  `license = "Apache-2.0"` (PEP 639) needs setuptools 77 or later, and PEP 639 forbids a
  `license-files` path that leaves the project directory. The backend and updater images build
  from the `backend/` and `updater/` contexts (`release.yml:251, 290`), so the root `LICENSE` is
  not in those contexts; the root `.dockerignore` (webui context) and `updater/.dockerignore`
  allow only listed paths. `backend/tests/test_distribution_contract.py:89` asserts the license
  label is absent. The Console bundles OFL-1.1 fonts (`@fontsource-variable/inter`,
  `@fontsource/jetbrains-mono`); `agents/chat_role_lookalikes.py` vendors Unicode data; the
  ATT&CK corpus ships in `threat/`.
- Decision: WP05 part 2 adds:
  - `LICENSE`: the verbatim Apache License 2.0 text from
    `https://www.apache.org/licenses/LICENSE-2.0.txt` (11,358 bytes, ASCII, LF line ends,
    SHA-256 `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`), checked by a
    test; `backend/LICENSE` and `updater/LICENSE` are byte-identical copies checked by the same
    test;
  - `backend/pyproject.toml`: `license = "Apache-2.0"`, `[build-system].requires` raised to
    `setuptools>=77`, no `license-files` entry outside `backend/` and no License classifier; the
    CI wheel lane proves the build;
  - `webui/package.json` `"license": "Apache-2.0"`, with the lockfile root regenerated so
    `packages[""]` carries it;
  - `org.opencontainers.image.licenses="Apache-2.0"` in the three Dockerfiles, and the license
    text in each image at `/usr/share/doc/agentic-soc/LICENSE` (webui from the root context with
    `!LICENSE` added to the root `.dockerignore`; backend and updater from their own copies, with
    `!LICENSE` added to `updater/.dockerignore`);
  - a README "License" section that states it, and a short third-party notices paragraph naming
    the OFL fonts, the Unicode data and the MITRE ATT&CK corpus;
  - a resolved note in place of the known-limitations entry.

**D4. Default branch.** GitHub reports `Testing` as the default branch ([rel] B8); `channels.md`
line 16 and `INSTALL.md` line 204 say `main`. This is a maintainer setting. The SPEC records it
as maintainer action M1 (§4.11): set the default branch back to `main` after the promotion merge
to `main` (so `main` already carries D13's Dependabot configuration) and before tagging. The docs
keep saying `main`.

**D5. Communication.** The "Notifications" navigation group is renamed "Communication" and holds
Inbox and a new What's new page. The top-bar bell keeps the name "Notifications".

- Code facts: `webui/src/soc/registry.tsx:428` (row label `Notifications`, group
  `notifications`) and `:532` (`FEATURE_GROUPS` entry). A single-child group renders as a row; two
  children render as a disclosure automatically (`NavSidebar.tsx` `toDestinations()`, [wn] §2.3).
- Decision: only the labels change; the group id stays `notifications` so stored navigation state
  and tests keyed on it keep working. The console map crumb becomes "Communication > Inbox" and is
  regenerated in the same change.

**D6. Remember me.** The sign-in row shows only "Remember me", with no duration line and no
accessible description.

- Code facts: the hint is computed in `RememberMeControls.tsx:87-91` ("Stay signed in on this
  device for up to ${duration}"). The one-time disclosure after a deliberate click exists: the
  warning prompt (`promptOpen`, with `acceptedFor` so re-checking the same name does not nag,
  lines 76 to 79) states the duration and the inactivity limit. Round 14 D3 (Round 14 SPEC line
  222) kept the hint as the disclosure.
- Decision: the row is label-only. The warning dialog keeps its facts and becomes the disclosure
  (this reverses Round 14 D3 for the row only). When the administrator turned Remember me off, or
  the connection is insecure, the row stays visible and disabled with its one-line reason.

**D7. What's new show rule.** Shown once per newest release-notes **update id** (not the version
string) after sign-in. Accounts created after an update start with it marked seen. The
acknowledgement is an audited preference change like `dismissed_intros`. Re-openable from the
Communication page. Never blocks sign-in.

- Code facts: the version did not bump across Rounds 12 to 15 ([wn] F2). `routes_prefs.py:231`
  audits `_AUDITED_MISC_KEYS` (`dashboards_hidden`, `dismissed_intros`) before saving. The
  dismissed-intro id grammar is `^[a-z0-9][a-z0-9_.:-]{0,63}$` (`_ROUND14_LIST_PREFS`,
  `models.py:990`). Accounts are created in `create_user` (`routes.py:5999`),
  `_provision_sso_user` (`routes.py:5608`, its create branch) and `POST /api/setup/account`
  (`routes_setup.py:119`). The backend image copies only `backend/app` (`backend/Dockerfile:46`)
  and the Web build stage only `webui/` ([wn] F1).
- Decision:
  - The marker is `UserPrefs.misc.whats_new_seen` (the dismissed-intro grammar). Any close of the
    dialog writes it once through `PUT /api/prefs/user`, which audits it (`whats_new_seen` joins
    `_AUDITED_MISC_KEYS`).
  - New accounts: after a successful create in each of the three paths, the backend writes
    `whats_new_seen` = the newest update id bundled with this backend build, best effort (a
    failure never fails the create; no separate audit row, the `user.created` row already exists).
    The id comes from a generated `backend/app/whats_new_latest.json`, written by
    `scripts/build_release_notes.py` and checked by its `--check` mode.
  - Fresh installs: the wizard completion stamps the marker through the audited prefs route.
  - No `release_history` KV namespace and no `GET /api/whats-new` route ([wn] R5 is not built).
  - An absent marker on an existing account means the account predates this feature: the dialog
    shows the newest version's featured highlights once.
  - The personal switch `misc.whats_new_auto` ("Show What's new after updates", absent means on)
    stays, per [wn] R6.
  - With sign-in off every caller shares the `default` prefs bucket, so the marker is per
    installation ([wn] F4); this is documented.

**D8. Case tabs.** Six tabs this round, Chat last: Brief, Evidence, AI investigation, Response,
Activity, Chat.

- Code facts: `CASE_TABS = ['overview', 'runbook', 'investigation', 'collab', 'chat']`
  (`webui/src/soc/case-tabs.ts:15`); legacy ids `timeline` and `threat` rewrite through
  `LEGACY_CASE_TABS` (`case-tabs.ts:25`).
- Decision: ids `['overview', 'evidence', 'investigation', 'runbook', 'collab', 'chat']` with the
  labels above, on Alt+1 to Alt+6. Alt+2 (Runbook to Evidence), Alt+4 (Collaboration to
  Response) and Alt+5 (Chat to Activity) change meaning, and Chat moves to Alt+6; What's new
  announces it. Chat moves into the inspector in a later round, which brings the tabs back to
  five (§7).

**D9. Sign-in identity contract.** Approved: replace the recorded "Identity surfaces" and
"Identity accents" sections of `docs/development/ui-standard.md` (lines 1907 and 1976) and retire
`webui/scripts/gate-login-accents.mjs` (with `gate-login-accents.d.mts` and step 6 of
`webui/scripts/gates.mjs`) as **subject removal**, with replacement contrast pairs added to
`webui/scripts/gate-contrast.mjs` in the same change. This is not gate softening: the gate's
subject (the identity accents) is deleted.

**D10. A close during an AI run.**

- The run's result stays authoritative. The Console shows the AI working (header chip, queue
  mark, navigation count), warns in the close dialogs that the run's result will replace a close
  made now, and notifies (Inbox) when a manual run finishes or replaces a close.
- An automatic drain skips a candidate that a person closed before the run started (outcome
  `unchanged`).
- Requester display: the requester sees "You started it". Others see "Started by a person",
  without the name, unless they hold the grant that lets them see accounts.
- Code fact and correction: there is no `users:read` permission; `RESOURCES["users"]` is
  `["manage"]` (`backend/app/rbac/policy.py:55`). The SPEC uses **`users:manage`**, the existing
  grant that lists accounts (built in for super_admin and soc_manager). No new permission is
  minted. The name never rides an SSE frame; only the caller-scoped route adds it (§4.5 WP08).

**D11. Standup.** `GET /api/standup` and the standup reads in `routes_standup.py`
(`/standup/report` at line 104, `/standup/action-items` at 168, `/standup/acknowledgements` at
251) require `metrics:view`. Code facts: `standup` (`routes.py:8604`) declares no permission
today ([bugs] B01); every built-in role holds `metrics:view` (`rbac/policy.py`, the role grants),
so defaults do not change. The navigation `standup` child (`registry.tsx:280`) gains
`perm: METRICS_VIEW`.

**D12. Bugs.** All 81 confirmed bugs are handled this round. Six are duplicates of another bug
and are merged into it, so 75 fixes land:

| Merged bug | Into | Shared root cause |
|---|---|---|
| B58 | B26 | The SLA response clock never stops for a case the agent closed (`engine/metrics.py` `sla_metrics`, about line 947) |
| B47, B65 | B35 | The Demo precedent corpus is seeded before the Demo cases exist (`state.py:3615`) |
| B62 | B13 | A stored risk breakdown cannot be reproduced from recorded inputs (the Demo seed is the second site) |
| B69 | B48 | Demo case cost has no ledger rows behind it (`demo_generator.py:1096`) |
| B70 | B01 | Case read routes skip `cases:read` |

Each bug goes to the package that owns its files (Appendix A). Security highs land first: B15 and
B16 ship in WP15A, the first merge of the round. No bug is deferred: none needs the maintainer to
fix. One needs the maintainer to verify: B81 (iOS focus zoom) cannot be reproduced without WebKit;
the fix ships and a device check is maintainer action M6.

Where the skeptic's minimal fix conflicts with a non-negotiable, this SPEC replaces that step:

- B13: the minimal fix fills inputs inside `compute_risk` (`engine/risk.py`). `engine/risk.py`
  stays byte-identical; the inputs come from the new pure `engine/risk_explain.py::explain_risk`,
  recorded beside `compute_risk` (S3).
- B09: the three link fields (`related_case_ids`, `cross_source_cluster_id`, `source_breakdown`)
  are a recorded open contract in `ROADMAP.md` section I. This round takes it up, with
  `automation_actions`: all four are carried, and `link_cross_source` (`engine/ingest.py:518`)
  re-reads each case under its signature lock before saving the link fields. `campaign_id` has no
  writer on the case (campaigns store `Campaign` objects), so it is not carried.
- B20: the seeded Demo Admin stays unflagged on purpose (`config.py:232-236`, pinned by
  `tests/test_oobe.py:104-110`); the docs are corrected instead, and the server enforces the flag
  for every other account.
- B24: no refresh token is issued; the docs become honest and the route is marked deprecated. No
  new credential readable from browser JavaScript is added.
- B48: option (b): the Demo seed writes one ledger row per seeded case with a cost, so the case
  figure, the per-case usage view and the Cost page agree. The flat synthetic embedding rate stays
  (intended).

Where the code review of this SPEC tightened a minimal fix (Appendix C), this SPEC also replaces
that step: B11 (the drain page size), B15 (every SSO change needs a Super admin), B16 (no
re-binding of an existing subject), B19 (the bound covers `/auth/mfa/disable`), B23 (the
recovery hash is matched off the event loop) and B45 (the one-time theme copy is idempotent).

**D13. Dependabot forward-port.** The four main-only action bumps on `origin/main` (commits
`18eb316`, `4c1edc8`, `928949b`, `c3f1fa3`: `actions/upload-pages-artifact` 4.0.0 to 5.0.0,
`actions/configure-pages` 5.0.0 to 6.0.0, `actions/upload-artifact` 4.6.2 to 7.0.1,
`actions/setup-go` 6.5.0 to 7.0.0, six lines in `ci.yml` and `docs.yml`) are applied on this
branch with the same SHA pins, and every block of `.github/dependabot.yml` (four today, none with
a target branch) gains `target-branch: Testing`. The `/backend` and `/webui` docker blocks also
gain `ignore: [{dependency-name: python, update-types: [version-update:semver-major,
version-update:semver-minor]}]`, because the shipping images pin Python 3.11
(`test_distribution_contract.py:76-79`).

- Proof: CI on the round's pull request proves `upload-artifact` 7.0.1 and `setup-go` 7.0.0.
  `configure-pages` 6.0.0 and `upload-pages-artifact` 5.0.0 (beside `deploy-pages` 4) run only in
  the tag-gated `publish` and `deploy` jobs of `docs.yml` (lines 79 to 81 and 320 to 322), so the
  required dress rehearsal M7 (§4.11) proves them before the real tag.
- Dependabot reads its configuration from the default branch, so `target-branch: Testing` takes
  effect on `main` only after the promotion merge, which is why M1 follows it. Dependabot
  security updates ignore `target-branch` and always target the default branch; `channels.md`
  says they are forward-ported to `Testing`.
- The open Dependabot pull requests against `Testing` (for example #134 and #141, which move the
  Python base image to 3.15) stay unmerged from WP19's frozen preparation until `v0.2.0` is
  tagged, so the candidate does not move.

**D14. Cut line.** Applied only if the round must shrink, in this order ([syn] §3):

1. WP06 vector search.
2. The WP12 samples route (keep the tile arithmetic lines).
3. The WP14 events view and usage popover (keep the WP14 fields sheet, findings and reasons).
4. The WP09 navigation count.
5. The WP07 "Earlier release records" group and the version rail (the page keeps the newest
   release). This replaces [syn]'s "WP07 install history", which D7 removed.
6. The WP08 per-case lock.

Never cut: the route gating and the security fixes (WP15A); every other bug fix (D12); the
release identity, version 0.2.0 and the license; the AI chip, queue mark and close warnings; the
Case Manager header and lanes; the risk explanation; Remember me; What's new.

### 2.2 Synthesis decisions (adopted, with the code facts behind them)

| # | Topic | Decision | Code facts |
|---|---|---|---|
| S1 | The live AI signal in the case header | A chip on the existing meta row with a popover; a 6 s success tint and one polite announcement on finish; no new row | A2 asks for less height; the meta row exists (`casedetail/CaseHeaderMeta.tsx`) |
| S2 | AI state copy | Chip and row: "AI working · m:ss", "AI queued". Popover title "AI investigation running" or "AI investigation waiting". Announcement "AI investigation finished: <status words>". Never "Investigating" alone | `CaseStatus.INVESTIGATING` is the human acknowledged status ([ai] F8) |
| S3 | Recording the risk inputs | New pure `engine/risk_explain.py::explain_risk`, recorded as `RiskBreakdown.inputs` (inputs plus the weights in force), with a property test against `compute_risk` | `engine/risk.py` last changed in `ba17965` and stays byte-identical; `compute_risk` is called at `agents/pipeline.py:942, 1415, 1564`; `RiskBreakdown` (`models.py:282`) holds only the five factors and the total |
| S4 | Release-notes source | One curated JSON per release under `docs/releases/notes/`, a stdlib generator, checked-in generated outputs; no backend notes route | The Web build stage cannot see `docs/` ([wn] F1, `webui/Dockerfile:28-29`) |
| S5 | What's new marker | The newest update id (D7) | [wn] F2 |
| S6 | Case tabs | Lanes, verdict first inside the Brief, key findings capped at five; six tabs (D8) | [cmux] R4, [comp] R4 |
| S7 | Realtime connection budget | One EventSource per page, reference-counted topics, in `useEventStream` | `webui/src/lib/useEventStream.ts` (`STREAM_CHANNELS` at line 89) |
| S8 | Shell-level AI signal | A count on the Case Manager navigation item from a low-volume `investigations` topic | `_REALTIME_TOPICS` (`routes.py:445`) and `_REALTIME_TOPIC_GRANTS` (`routes.py:451`) gate topics by permission |
| S9 | Per-case SLA | The server reading is served in `GET /api/cases/{id}/triage` | `GET /api/cases/{case_id}` is `response_model=Case` (`routes.py:7150`) and `_with_advisory_bands` returns a `Case` copy (`routes.py:6350`), so a non-field key would be filtered |
| S10 | Per-call price basis on `UsageDoc` | This round, still one row per call written only by the gateway | #6; `UsageDoc` at `models.py:2363` |
| S11 | Explain triggers inside queue rows | A mouse-only HoverCard with no focusable content; the accessible name carries the number; the keyboard path is the header chip | No nested interactive content inside a row button |

### 2.3 Corrections found while verifying the inputs

- Paths in [syn] corrected: the login parts live under `webui/src/soc/components/auth/`
  (`loginParts.tsx`, `ShineButton.tsx`, `ThemeModePill.tsx`, `LoginAuthBackdrop.tsx`,
  `RememberMeControls.tsx`); the gates under `webui/scripts/` (`gate-login-accents.mjs`,
  `gates.mjs`, `gate-contrast.mjs`); `CaseActivityFeed.tsx` under `webui/src/soc/components/`.
- `state.cluster_for_case` is at `state.py:1677` (B06 cites 1644).
- B01's skeptic asks to review `/api/llm/models` and `/api/personas`. Both are auth-only today by a
  recorded choice (`registry.tsx` comments near lines 368 and 400). This round gates
  `GET /api/llm/models` (`routes_models.py:130`) with `models:read`, which every built-in role holds
  through `_settings_like` (`rbac/policy.py`), and gives the Models navigation child the same
  `perm`. `GET /api/personas` (`routes.py:2543`) serves a static product catalog with no case data;
  it stays auth-only and goes on the reviewed GET allowlist with that reason.
- `risk_breakdown` is mapped as a dynamic object in Elasticsearch (`es/indices.py:81`) and the
  cases index has date detection on (only `AUDIT_MAPPING` sets `date_detection: false`, line 101).
  A source-controlled string inside `RiskBreakdown.inputs` (a rule value that looks like a date)
  could map a field as `date` and fail every later case save, so `inputs` is mapped explicitly
  as stored and never indexed (§3.4), as `trigger_reason` already is (line 89).
- `awaiting_reason` is not in `CASES_MAPPING` (`es/indices.py:48`); it maps dynamically as text
  with a `keyword` subfield. B11's query relies on that subfield (§4.4 WP15B).
- `check_version.py` requires a dated heading for the current version at all times, so the version
  move writes `## [0.2.0] - <date of the move>` with an honest Testing-candidate note, as the
  repository did for 0.1.13 since 2026-08-05; WP19 re-dates it to the tag date (§3.8).
- [syn] WP15 assumed one bug package. The bugs touch most of the tree, so this SPEC splits them
  into seven packages by file ownership (WP15A to WP15G) and gives the rest to the feature package
  that owns the file.

---

## 3. Shared contracts

### 3.1 Entry bundle

- Baseline `PRE_REVAMP_ENTRY_BYTES = 329_080` (`webui/src/soc/__tests__/bundle-first-paint.test.ts:185`);
  budget baseline plus 1,024 B; ceiling 400,000 B never moves. The stamped build adds about 13 B
  (Round 15: 329,093 B stamped, 329,080 B with `build:app`).
- Every Console package reports its measured entry delta with `npm run build:app`.
- New UI lives in lazy chunks. Only these may reach the entry: the investigation store (WP09), the
  navigation glyph and count (WP09), the NavSidebar investigations subscription and the reconcile
  client it calls (WP09), the `useEventStream` multiplexer (WP09; `useEventStream` is already an
  entry module because the shell imports `NotificationBell` and `JobMonitor` statically,
  `AppShell.tsx:110, 124`), the What's new gate (marker compare plus one dynamic import thunk, at
  most 450 B, WP07), the channel string (WP01), the Communication labels, the new `whats_new`
  route thunk and one lucide icon for the What's new row (WP07), and the new `perm` fields
  (WP15A).
- WP09 reports the multiplexer's measured delta separately from the rest of its entry growth.
  WP07's total entry growth (the gate, the registry row, the route thunk, the labels, the prefs
  `loaded` flag, the `localStorage` fallback, the wizard stamp and the `ReleaseBadge` link) is
  reported and is at most 700 B.
- WP04 frees about 7 KB (the prototype measured 329,080 B to 321,910 B, [login] §9).
- WP16 measures the integrated entry and ratchets `PRE_REVAMP_ENTRY_BYTES` down once to the merged
  measurement, recorded in §8 and in the `test_docs_round12_records.py` pin.
- `motion`, the Explain kit, the What's new page and dialog, and the notes JSON never reach the
  entry; WP16 asserts each.

### 3.2 Demo Mode

| Store, route or writer | Demo behaviour |
|---|---|
| Investigation registry and `GET /api/investigations/active` | The DemoStack holds its own registry; the route answers from it while Demo is active |
| `case.investigation` frames | Published on the same topics; Demo case ids are distinct |
| `GET /api/cases/{id}/events` | Reads Demo cases through the Demo log source connector |
| `GET /api/cases/{id}/usage` | Reads the Demo usage store |
| Seeded Demo ledger rows (B48) | One UsageDoc per seeded case with a cost, in the Demo usage store, `price_basis: "demo_simulated"` |
| Seeded risk breakdowns (B62) | Built by `compute_risk` and `explain_risk` from each case's own synthetic cluster |
| Demo precedent corpus (B35) | Seeded after every Demo case and review exists |
| Rule Test and preview (B34) | Reads the Demo sources through the shared `GET /api/logs` Demo reader |
| Setup wizard Demo rows (B43) | Read-only in the Console; the backend answers `409 source_demo_readonly` for a write to a Demo overlay id |
| Data export (B49) | The button is disabled in Demo with a reason; the backend refusal is unchanged |
| `case.close_replaced`, `case.events_viewed` audit rows | The Demo audit sink |
| What's new marker and personal switch | Real user prefs (not Demo-swapped), as `dismissed_intros` |
| Metrics explain samples | The Demo case store |

A test per new writer asserts the sink with Demo Mode on and off.

### 3.3 Permissions

No permission is added to the vocabulary. New and changed uses:

| Grant | Who (built-in defaults) | Used by |
|---|---|---|
| `cases:read` | every role | `GET /api/cases/{id}/export`, `/trace`, `/rationale`, `/activity`, `/thread`, `/tasks`, `GET /api/scans`, `/api/scans/notifications` (B01); `GET /api/investigations/active` and the `investigations` SSE topic (WP08); `GET /api/cases/{id}/events` together with `sources:read` (WP13) |
| `sources:read` | every role | `GET /api/sources/{source_id}/feeds` (its sibling `GET /api/sources` already requires it, `routes.py:950-953`) |
| `settings:read` | every role | `GET /api/settings` (B01); the read-time `asset_cidr` in `GET /api/cases/{id}/triage` (WP10) |
| `metrics:view` | every role | the standup reads (D11); `GET /api/metrics/explain` (WP12) |
| `models:read` | every role | `GET /api/llm/models` (§2.3), `GET /api/models` (it returns custom-model `base_urls`, `routes.py:2479-2486`) and `GET /api/llm/providers` (`routes_models.py:175`) |
| `roles:read` | every role | `GET /api/roles` (its sibling `GET /api/roles/simulate` already requires it) |
| `cost:view` | every role | `GET /api/cases/{id}/usage`; cost values in the "View all fields" sheet |
| `users:manage` | super_admin, soc_manager | the requester's name on an AI run (D10) |
| `cases:reinvestigate` | super_admin, soc_manager, analyst_tier2 | `POST /api/cases/{id}/reinvestigate` (unchanged) |
| stored super_admin plus strict fresh sign-in | super admins | every `PUT /api/settings` that changes the `sso` block (a provider added, removed or edited in any field, or `sso.enabled` changed) and every `POST /api/auth/sso/providers/{id}/secret` (B15) |

The GET rule skips `PUBLIC_API_PATHS` and `PUBLIC_GET_PATHS` (`api/deps.py:26, 70`: health,
`auth/me`, setup status, `auth/sso/*`, branding). The reviewed GET allowlist (auth only, each
entry with a one-line reason in `test_route_auth_coverage.py`) holds:

- self-service reads of the caller's own bucket: `/api/account/me`, `/api/account/activity`,
  `/api/account/permissions` (the Console's permission bootstrap), `/api/prefs/effective`,
  `/api/prefs/user`, `/api/prefs/org` (the cascade every page needs), `/api/sessions` (the
  caller's own sessions), `/api/views`, `/api/terminology` (labels every page needs),
  `/api/notifications/prefs`, `/api/notifications/inbox` and
  `/api/notifications/inbox/unread-count`;
- static catalogs with no tenant data: `/api/connectors`, `/api/connectors/{source_type}` and
  `/api/personas`;
- `/api/events`, the SSE endpoint, whose topics are gated separately (`_REALTIME_TOPIC_GRANTS`).

Two GETs enforce their grants inside the handler and sit on a separate reviewed "gated in body"
list: `/api/metrics/breakdown` (an in-body `require_permission(...)(request)` chosen by `kind`,
`routes_metrics.py:1492`) and `/api/rules/summary` (per-section grants through `resolve_access`,
`routes_rule_summary.py:1188`). The test asserts each listed endpoint's code still references
`require_permission` or `resolve_access`, so neither can lose its gate silently.

### 3.4 Storage (#12) and the Elasticsearch mapping budget

KV only. No new KV namespace, index, table or SQL migration. New stored fields, all additive and
defaulted, each a fixed key set:

- `Case.risk_breakdown.inputs` (`RiskInputs`, about 20 leaf fields; `weights` is the fixed
  five-key object). `CASES_MAPPING.risk_breakdown` gains
  `properties: {inputs: {type: object, enabled: false}}` (stored, never indexed, like
  `trigger_reason`). Bootstrap adds it to the stored cases template and to each live cases index
  that lacks it, an additive change like `extend_config_mapping` (WP15B, before WP10's first
  write). When it cannot (the client cannot read or extend mappings, or the call fails), the
  Elasticsearch case store leaves `inputs` out of the stored document, logged once, so a case
  always lands and reads "not recorded". `rule_values` holds at most 50 entries;
  `rule_type_count` is exactly `len(cluster.rule_values)`, as `compute_risk` counts it; `scored_at`
  is the only date.
- The DECISION audit row's `tool_input.gate` (11 keys).
- `UsageDoc`: `input_rate_per_million`, `output_rate_per_million`, `cache_read_rate_per_million`,
  `cache_write_rate_per_million`, `cache_write_ttl`, `price_basis`.
- `UserPrefs.misc.whats_new_seen` and `misc.whats_new_auto`.
- `User.mfa_failed_count` and `User.mfa_locked_until` (the one `users` KV document).
- `Citation.case_number` (inside chat transcripts, opaque).
- `CASES_MAPPING` gains an explicit `awaiting_reason` of type `text` with a `keyword` subfield
  (`ignore_above: 256`), identical to the dynamic default, so new indices match existing ones.
- The investigation registry is memory only (`process_local: true`).

### 3.5 Non-negotiables cross-check

- #1: the events route reads through `fetch_by_ids` on the read-only client only.
- #2: every new writer audits: `case.close_replaced`, `case.events_viewed` (coalesced),
  `auth.mfa_locked`, the What's new acknowledgement; the security fixes add denied rows where a
  request is refused.
- #3: `decide()` (`engine/case_manager.py`) and `engine/risk.py` stay byte-identical (guard in
  §3.6). Recorded inputs and the recorded gate are written beside `compute_risk` and after
  `apply()`, and nothing reads them to decide. The registry never feeds a decision. Spine fixes
  (WP15B) change which runs happen and what is carried, never the decision function.
- #4: WP15B fixes four #4 defects (B04, B05, B10, B11) without touching `engine/signatures.py`.
- #5: chat stays one engine; WP15G changes only display fields.
- #6: no new model call anywhere; the usage route reads the ledger; the gateway still writes one
  row per call; the seeded Demo rows are seeds of the Demo store, not calls.
- #7: frames and explanations carry ids, enums and our own numbers only.
- #8: enrichment stays Redis-cached; WP13 only exposes per-provider results.
- #9: every case, source, model or person derived string renders as a text node, `InlineCode`,
  `CodeBlock` or `JsonTree`; provider `raw` and prompt excerpts stay fenced; the sign-in page
  never renders a query-string value (B25).
- #10: defaults unchanged; What's new on by default; the personal switch is opt-out.
- #11: spine fixes first, each with a regression test that fails before the fix.
- #12: KV only (§3.4).

### 3.6 Static guards

- `backend/tests/test_round16_spine_guards.py` (WP01): the SHA-256 of `engine/risk.py` and of
  `inspect.getsource(decide)` equal their values at `3cd362c`.
- Import bans: `engine/risk_explain.py`, `engine/investigation_registry.py`,
  `engine/sla_reading.py` and `engine/stats.py` import nothing from `engine/case_manager.py`, and
  `engine/case_manager.py` and `engine/risk.py` import none of them (pattern
  `test_overhaul_b2_autopilot.py:307-316`). The registry is never imported by `agents/**` other
  than `agents/pipeline.py`, nor by `tools/**`.
- GET route coverage (WP15A): every `/api` GET that is not in `PUBLIC_API_PATHS` or
  `PUBLIC_GET_PATHS` declares a permission dependency or an in-body `_enforce`, or sits on the
  reviewed allowlist or the reviewed "gated in body" list of §3.3.
- Popover names (WP15F): every `PopoverContent` in `webui/src` has `aria-label` or
  `aria-labelledby` (a source scan test).
- What's new (WP07): the notes JSON and the dialog title are not in the entry chunk; the generator
  rejects HTML, raw URLs and hidden characters.
- Sign-in (WP04): an arbitrary `sso_error` value never reaches the DOM; `theme.css` login keyframes
  touch only `opacity` and `transform`, sit inside `prefers-reduced-motion: no-preference`, have no
  `infinite` and last at most 300 ms (600 ms for the brand wash).
- Copy: the existing banned-character gate covers new Console copy.

### 3.7 Rollback

- Every new stored field is additive. At `3cd362c`, `RiskBreakdown`, `User` and `UsageDoc` use
  Pydantic's default `extra` handling (they ignore unknown fields), and the pinned previous release
  (`45a4c31`, `scripts/rollback_previous_release.json`) is expected to behave the same: it loads
  new documents and drops the new fields when it rewrites one. The lane plants below prove it. Losses on rollback, documented in `known-limitations.md` and the rollback docs:
  recorded risk inputs on cases the old build rewrites (they then read "not recorded"); MFA
  lockout counters (reset); the route gating and the server-side forced password change (they
  revert). Ledger rows are append-only and keep their rate fields. `UserPrefs.misc` is a free
  dictionary in the old build, so What's new markers survive.
- Rollback lane plants (WP16, `scripts/rollback_lane.py` and `scripts/test_rollback_lane.py`), in
  `phase_n`: a case with recorded inputs, a usage row with rates, a user with a lockout counter and
  a What's new marker; in `phase_return`, assert the previous release loaded them and that the
  current build reads a rewritten case as "not recorded".
- WP19 rehearses image-only rollback to v0.1.1 (`scripts/rollback_lane.py --previous-release
  ba179651a7b63d6352ad346fd633e1460f3a4d39`) on PostgreSQL and records the narrower pass condition
  of [rel] B5.

### 3.8 Versioning to 0.2.0

What moves (WP05 part 1):

- Current-version strings: `VERSION`; `backend/app/__init__.py` `__version__`;
  `backend/pyproject.toml`; `webui/package.json` and both lockfile roots;
  `updater/agentic_soc_updater/__init__.py` `UPDATER_VERSION`; `webui/openapi.json` (regenerated);
  `deploy/docker-compose.tlsoc.yml` (lines 26, 30, 32); `mkdocs.yml` `product_version: "0.2.0"` and
  `docs_version: "0.2"`; the design-system catalog strings that name the shipping version
  (`webui/src/design-system/catalog.ts:6, 431`); every operator doc sentence that names the current
  version; tests that assert the current version or line.
- The Help Center moves to `/docs/0.2/`. `scripts/build_docs_bundle.py` also writes a redirect stub
  at `/docs/<old>/<page>/index.html` for every page of the current tree and every line in a
  constant `LEGACY_DOC_LINES = ("0.1",)`, which each later minor release extends. A stub is the
  existing `_redirect_page` (meta refresh plus canonical to `/docs/0.2/<page>/`) with, before the
  meta refresh, `<script>location.replace(TARGET + location.hash)</script>` (the target
  JSON-encoded), so a fragment such as `#sources` survives; the meta refresh stays the no-script
  fallback. The installed nginx sets no Content-Security-Policy that blocks an inline script.
  `validate_bundle` checks the stubs and one anchored stub. Assets are not redirected. Stored chat
  citations (`/docs/0.1/analyst/chat/#sources`), report links and bookmarks keep working.
  `scripts/test_docs_theme.py` derives the line it reads from `VERSION` instead of `"0.1"`.
- `scripts/build_upgrade_plan.py` `--max-version-exclusive` defaults to `0.3.0`; the updater test
  asserts it. The 0.2.0 plan's `from` range `0.1.1..<0.3.0` still admits the v0.1.1 baseline.
- `CHANGELOG.md`: `## [0.1.13] - 2026-08-05` becomes
  `## Development snapshot - 2026-08-05 - 0.1.13 Testing candidate (never tagged; folded into 0.2.0)`
  (hyphens, not the em dashes of older snapshot headings). A new
  `## [0.2.0] - <date of the move>` heading follows `[Unreleased]` with one paragraph: "Testing
  candidate for the 0.2 line, not yet tagged. The frozen release preparation moves the
  `[Unreleased]` notes here and sets the tag date." WP19 does that.
- Release pages: new `docs/releases/0.2.md` (the line page) and `docs/releases/0.2.0.md` (a
  skeleton with the seven `check_version.py` markers, marked Testing candidate); `0.1.13.md`
  becomes "unpublished candidate, folded into 0.2.0", like `0.1.2.md` and `0.1.3.md`; `0.1.md`
  points to the 0.2 line for current work; `channels.md` gains a "Version 0.2" section (the 0.1
  nomenclature stays as history); `documentation-versions.md` gains the 0.2 row; `docs/index.md`
  names the 0.2 line; nav entries in `mkdocs.yml`.
- Generated: the app knowledge corpus (its manifest records `product_version` and
  `docs_version`), the console map if labels changed, `api-types.gen.ts`.

What does not move:

- Stored data: `app_version` and `build_sha` on cases, audit and usage rows stay as written
  (provenance is never backfilled).
- Historical release pages `0.1.2.md` to `0.1.12.md` and their identities.
- Test fixtures that model stored historical values (for example `app_version: "0.1.13"` in chat
  report fixtures) and the many `/docs/0.1/...` citation fixtures, which stay valid.
- The frozen Compose base, the updater protocol (1), the plan schema (1) and the state schema (1).
- Comments that describe history (for example `stores/sql/engine.py:74`, "through 0.1.13") are
  reworded only when they name the current version.

`AGENTS.md` sentences such as "This is an additive `0.1.13` contract" are updated by WP18 to say
the contract arrived with the 0.1.13 candidate and ships in 0.2.0.

### 3.9 Generated files

`webui/src/lib/api-types.gen.ts`, `webui/openapi.json`, `backend/app/knowledge/console_map.json`,
the app knowledge corpus and manifest, `webui/src/soc/whats-new/release-notes.gen.json`,
`backend/app/whats_new_latest.json` and `docs/releases/whats-new.md` are resolved by re-running
their generator, never by hand merging. Each package regenerates what it touches; WP16 regenerates
everything on the integrated tree.

---

## 4. Work packages

### 4.1 Rules

- **Isolation.** Each package builds in its own git worktree from the round branch, on a local
  branch `r16-<wp>` (never pushed), and reports its branch and commit. It edits only the files it
  owns (§4.10) and the named hunks it is allowed in shared files. A finding in another package's
  file is reported to that package, not fixed in place.
- **Stub-first mount points.** WP01 creates every cross-package component with its final props
  and a no-op body. WP02 and WP03 mount the stubs while they restructure the pages. The feature
  packages replace the stub bodies, so almost no mounting is left for integration.
- **Regression first.** Each bug fix ships with one regression test that fails before the fix.
- **Reports.** CHANGELOG, Journal and Help Center text are returned in each package's final report;
  WP18 writes them. Every report ends with a Journal entry in the `AGENTS.md` format (no em
  dashes).
- **Router counts.** WP08 and WP13 add feature routers (`routes_investigations.py`,
  `routes_case_events.py`, `routes_case_usage.py`), so the router count in `AGENTS.md` and
  `HANDOFF.md` moves from 43 to 46. `test_docs_round13_records.py` pins it; packages list that test
  as expected-red and WP18 updates the count at merge.
- **The newest-round record.** `test_docs_round13_records.py::test_the_start_here_records_name_the_newest_round`
  is red from the round's start (the `2026-11-round16` research folder exists; HANDOFF and
  AGENTS still name Round 15 as the newest). The orchestrator's opening commit, before WP15A
  branches, fixes it: HANDOFF's round list gains `**Round 16 (newest, in progress):**` with one
  line pointing at this SPEC and the Round 15 line drops `newest, `; `AGENTS.md` §10 gains
  `**Round 16 is the newest work** (in progress; see the Round 16 SPEC)` and the Round 15
  sentence stops saying "is the newest". It then runs `backend/tests/test_docs_*.py` green.
  WP18 later writes the full Round 16 text. The expected-red list of every package is then only
  the two router-count tests.
- **Gates per package before hand-off:**
  - `cd backend && python -m pytest -q` (from a worktree:
    `/home/user/Kavach-AgenticSOC/backend/.venv/bin/python -m pytest -q -p no:cacheprovider`);
  - `cd webui && npm run typecheck && npm run lint && npm run gates && npm run test:strict && npm run check:types && npm run build`
    (worktree: `ln -s /home/user/Kavach-AgenticSOC/webui/node_modules webui/node_modules`);
  - `python3 scripts/check_version.py`, `python3 scripts/check_ci_contract.py`,
    `python3 scripts/check_docs.py`,
    `backend/.venv/bin/python scripts/build_app_knowledge.py --check`;
  - the §3.6 guards;
  - a scan of changed files for U+2014, U+2013 used as a dash, U+00A0 and Cf characters;
  - a package that changes `registry.tsx`, `settings-sections-meta.ts` or Settings anchors runs
    `npm run gen:console-map` and `scripts/build_app_knowledge.py` in its branch.

### 4.2 Package list

| Package | Title | Wave | Effort | Depends on | Bugs fixed |
|---|---|---|---|---|---|
| WP15A | Security and access fixes | 0, opening | L | nothing | 13 (B01 with B70, B15 to B24, B51, B55) |
| WP05 | Release: version 0.2.0, identity, license, guards | 0, opening (part 1) and 0 (part 2) | L | WP15A; part 2 also WP07 | 2 (B52, B54) |
| WP01 | Contracts and foundations | 0, opening | M | WP05 part 1 | 0 (contracts for B13, B42) |
| WP02 | Case Manager queue and frame | 0 | M | WP01 stubs | 0 |
| WP03 | Case detail: compact header, lanes, inspector | 0 (critical path) | L | WP01 stubs | 2 (B27, B28) |
| WP04 | Sign-in page | 0 | M | nothing | 2 (B25, B50) |
| WP06 | Performance extras | 0 | M | nothing | 0 |
| WP07 | What's new and Communication | 0 | M to L | WP01, WP15A | 0 |
| WP15B | Pipeline, ingest and job spine fixes | 0 | L | WP01 merged | 11 (B04 to B12, B14, B33) |
| WP15C | Metrics, SLA and time-window fixes | 0 | M | WP01 merged | 7 (B02, B03, B26 with B58, B39, B59, B60, B68) |
| WP08 | AI run tracking: backend | 1 | M to L | WP01, WP15B | 0 |
| WP09 | AI run Console and one stream per page | 1 | M to L | WP01; live with WP08 | 0 |
| WP10 | Case numbers explained: backend | 1 | M to L | WP01, WP08 | 2 (B13 with B62's contract, B63) |
| WP11 | Explain kit and case explainers: Console | 1 | M | WP01; live with WP10 | 1 (B32) |
| WP12 | Metrics explained | 1 | M to L | WP01, WP15C, WP11 primitive | 4 (B29, B64, B66, B67) |
| WP13 | Case records reachable: backend | 1 | M | WP01 | 0 |
| WP14 | Case records reachable: Console | 1 | M | WP01; live with WP13, WP10 | 2 (B30, B31) |
| WP15D | Demo Mode correctness | 1 | M | WP01, WP15B; merges after WP08 | 5 (B34, B35 with B47 and B65, B41, B48 with B69, B61) plus the B62 Demo hunk |
| WP15E | Console fixes: setup, settings, administration | 0 (part 1) and 1 | M to L | WP01; part 2 also WP03, WP15B | 10 (B36, B37, B43, B44, B45, B46, B49, B53, B56, B57) |
| WP15F | Accessibility fixes | 1 | M | the feature packages that own the files (merge late) | 11 (B71 to B81) |
| WP15G | Chat and local-model fixes | 1 | S to M | WP01 | 3 (B38, B40, B42) plus [oss] B1 and B3 |
| WP16 | Integration, entry budget, cross-cutting review | 2 | M | WP01 to WP15G merged | 0 |
| WP17 | Screenshots and What's new content | 3 | M | WP16 | 0 |
| WP18 | Records and docs | 3 | M | WP16 | 0 |
| WP19 | Frozen release preparation and acceptance | 3 (release track) | M | WP17, WP18 | 0 |

Total: 75 fixes plus 6 merged duplicates, 81 bug ids (Appendix A).

### 4.3 Wave 0, opening (sequential on the round branch, in this order)

#### WP15A. Security and access fixes (L; backend and a little Console; merges first)

- **Goal.** Close every confirmed access-control and account-security defect before any feature
  lands.
- **Implements.** [dv] R1 (moved here from [syn] WP13), D11, the B01 skeptic note on
  `/api/llm/models`.
- **Owned files.**
  - `backend/app/auth/passwords.py`, `backend/app/auth/service.py` (async wrappers);
  - `backend/app/auth/mfa.py` (async recovery helpers `averify_recovery_code` and
    `ahash_recovery_codes`, B18 and B23);
  - `backend/app/auth/oidc.py` (`identity_from` reads `hd` only for Google, B16);
  - `backend/app/stores/users.py` (`consume_mfa`, the failure counters);
  - `backend/app/api/deps.py` (`require_auth` forced-change gate; `session_metadata` IP);
  - `backend/app/api/routes_cases_collab.py` (the three GET dependencies at lines 412, 462, 709);
  - `backend/app/api/routes_models.py` (`llm_models`, line 130, and `llm_providers`, line 175);
  - `backend/app/api/routes_standup.py` (the GETs);
  - `backend/app/api/routes_setup.py` (async hashing at about line 192);
  - `backend/tests/test_route_auth_coverage.py` and the new `backend/tests/test_round16_security.py`;
  - the new `backend/tests/_auth_helpers.py` (`ready_user`: signs in as an account created
    through `POST /api/users` and changes its temporary password), and the existing tests that
    sign in as such an account (43 files POST `/api/users` and sign in; each calls `ready_user`
    first, no assertion is weakened and no application-side bypass is added);
  - `webui/src/soc/pages/Sessions.tsx` (B55);
  - `webui/src/soc/pages/settings/case-policy.tsx` and `settings/general.tsx` (B51 inline errors);
  - docs: `SECURITY.md` (line 20 and the "Refresh-token rotation & reuse (theft) detection"
    section at line 506), `docs/administration/authentication.md` (line 35), `DEMO.md` (line
    129), the auth passages of `docs/USAGE.md` (about lines 2001 to 2004, 2373 to 2374 and 2476
    to 2490) and `DEPLOY.md` (the `refresh_ttl` rows near line 1120 and line 1158).
- **Allowed hunks in shared files.**
  - `backend/app/api/routes.py`: the auth, MFA, session, account, users and SSO handlers (from
    `_register_session`, line 3919, to `set_sso_provider_secret`, line 5784, plus `create_user`
    at 5999 and the administrator reset in `update_user`, `PUT /api/users/{username}`, at 6098);
    `get_settings` (1770); `put_settings` (2089: a new `_guard_sso_settings_change` beside
    `_guard_rbac_settings_change` at 2048, and a new `_reject_incoherent_settings` beside
    `_reject_out_of_range_caps` at 1874); `account_activity`
    (4558); the case read GETs `case_export` (8192), `case_trace` (8499), `case_rationale`
    (8518), `scans` (8580), `scan_notifications` (8592) and `standup` (8604); `source_feeds`
    (1726), `models` (2480) and `list_roles` (5817), the dependency only.
  - `backend/app/models.py`: the `User` class only.
  - `backend/app/audit/event_categories.json` and `webui/src/soc/components/audit/events.ts`:
    `auth.mfa_locked`.
  - `webui/src/soc/registry.tsx`: `perm` on the `standup` and `models` children.
  - `webui/src/soc/pages/Users.tsx`: the `GET /api/roles` read becomes best effort (the role
    summary hides when it is refused), so a role with `users:manage` but no `roles:read` still
    lists accounts.
  - `webui/src/lib/api.ts`: delete the dead `refresh` method of `api.auth` (about lines 860 to 863).
  - `webui/src/lib/types.ts`: `ActivityEvent.event_label`.
- **Contracts.**
  - **Read gating (B01).** `cases:read` on the eight case reads of §3.3; `settings:read` on
    `GET /api/settings`; `metrics:view` on the standup reads (D11); `models:read` on
    `GET /api/llm/models`, `GET /api/models` and `GET /api/llm/providers`; `sources:read` on
    `GET /api/sources/{source_id}/feeds`; `roles:read` on `GET /api/roles`.
    `test_route_auth_coverage.py` gains the GET rule, the reviewed allowlist and the "gated in
    body" list (§3.3, §3.6). A denied read writes the existing Access denied row. Every built-in
    role holds each of these grants, so defaults do not change.
  - **Forced password change (B20).** `require_auth` answers
    `403 {"code": "password_change_required", "message": "Change your temporary password to continue."}`
    for a flagged account on every `/api` route except `/api/auth/me`, `/api/auth/change-password`,
    `/api/auth/logout`, `/api/auth/refresh`, `/api/account/me`, the self-service reads
    `GET /api/account/permissions`, `GET /api/prefs/effective` and `GET /api/prefs/user` (no case
    data; the Console reads them once per session at sign-in, `prefs.tsx:159-186`) and the public
    reads. The flag is read live. The seeded Demo Admin stays unflagged; the docs say so and say the
    forced change applies to accounts an administrator creates or resets.
  - **Hashing off the event loop (B18).** `averify_password`, `ahash_password` and
    `AuthService.acheck_password` run PBKDF2 through `asyncio.to_thread` under a semaphore of
    `max(2, cpu_count // 2)`; every login, change, re-auth, MFA, user create and reset path uses
    them; a six-digit TOTP-shaped code never runs the recovery-code PBKDF2 loop.
  - **MFA attempts (B19).** 10 consecutive failures lock second-factor checks for 5 minutes,
    doubling to at most 60 minutes, answering 429 without verifying; each lock writes
    `auth.mfa_locked`; a success resets `mfa_failed_count` and `mfa_locked_until`. The counter,
    the lock and the row apply to every second-factor check: `/auth/mfa/verify`,
    `/auth/mfa/enroll-confirm`, `/auth/mfa/confirm` and `/auth/mfa/disable` (today
    `mfa_disable`, `routes.py:5354`, checks codes with no bound from a bare session).
    `/auth/mfa/disable` also requires a fresh sign-in. The pending token carries a random `jti`
    held in a bounded process-local map; it is rejected after 5 failures or once used.
  - **MFA enrolment (B17).** `/auth/mfa/setup` and `/auth/mfa/confirm` answer 409 ("MFA is already
    enabled; turn it off with a current code before enrolling a new authenticator.") when the
    account is enrolled, and require a fresh sign-in.
  - **MFA single use (B23).**
    `UserStore.consume_mfa(username, *, step: int | None = None, recovery_hash: str | None = None) -> bool`.
    The route finds the matching stored hash off the event loop (`averify_recovery_code` under
    the B18 semaphore, only when the normalised code has the 8 hex characters of a recovery code).
    The CAS mutator then removes that exact stored hash string if it is still present (a string
    comparison, no PBKDF2 inside the mutator or its retries), or for TOTP requires
    `step > mfa_last_step`. A lost race is a failure.
  - **Sessions after a password change (B21).** A self-change revokes the caller's other sessions
    (the current one stays) and stops their chat turns; an administrator reset revokes every
    session of the target; both write `session.revoked` rows and return `sessions_revoked`.
  - **Session IP (B22).** `session_metadata` derives the IP with `audit_client_ip`
    (`audit/context.py`, `TRUSTED_PROXIES`), never the leftmost `X-Forwarded-For` entry.
  - **Refresh tokens (B24).** No sign-in issues one. `POST /api/auth/refresh` (line 4435) stays,
    marked `deprecated=True`, answering 401 `{"code": "session_invalid", "reason":
    "unknown_refresh"}` as it does today (line 4481). The docs say a session lasts until its
    access token expires within the idle and absolute limits.
  - **SSO (B15, B16).**
    - Linking: after step 1 (an account linked to this provider and subject) misses, link by
      verified email only when the candidate is linked to this provider and has no `oauth_sub`.
      Any other match, including an account that already holds a different `oauth_sub` for this
      provider or one linked to another provider, is refused with the `auth.login_failed` denied
      row; an existing subject is never re-bound by email (OIDC's stable identifier is issuer
      plus subject). Microsoft accounts are already keyed on `oid`, so no re-link exception is
      needed.
    - `oidc.identity_from` reads `hd` only when the provider type is `google`; otherwise
      `domain` is the verified email's domain (empty when the email is unverified), so a generic
      IdP cannot pass `allowed_domains` by asserting `hd`.
    - Every `PUT /api/settings` that changes the `sso` block (a provider added, removed or edited
      in any field, or `sso.enabled` changed) and every
      `POST /api/auth/sso/providers/{id}/secret` requires a stored Super admin with a strict fresh
      sign-in, otherwise `403 super_admin_only` and nothing is saved. A capability test on the
      role values is not enough: a settings editor could repoint the issuer of a provider that a
      stored Super admin is linked to, and step 1 would sign them in as that Super admin.
    - Role values must be a `UserRole` value or a known custom role id, otherwise 422.
    - `_provision_sso_user` never changes the role of a stored super_admin through a group map.
  - **Settings coherence (B51).** `_reject_incoherent_settings` answers 422 with a field message
    when `sla.timezone` is not `UTC`, `Z`, a `+HH:MM` offset or a zone `zoneinfo` accepts; when a
    merged SLA target has `response_minutes > resolve_minutes`; or when `investigate_lookback` does
    not parse to an instant earlier than now. A stored bad value still loads. The two Settings
    pages show the same checks inline.
  - **Sessions activity labels (B55).** `GET /api/account/activity` adds `event_label` from
    `audit.events.classify`; the Console renders it.
- **Bugs fixed.** B01 (with B70), B15, B16, B17, B18, B19, B20, B21, B22, B23, B24, B51, B55.
- **Tests.** One regression per bug, failing before the fix, including: a custom-role deny of
  `cases:read` gets 403 from all eight reads and the settings dump; a custom-role deny of
  `sources:read` gets 403 from the feeds read; the GET coverage rule; a forged
  `X-Forwarded-For` from an untrusted peer is not shown in `GET /api/sessions`; N wrong codes then
  429 until the window passes; 10 wrong codes on `/auth/mfa/disable` from one session, then 429
  even for a correct code, and MFA stays enabled; two concurrent redemptions of one recovery code,
  exactly one wins, with no PBKDF2 call inside the mutator;
  a concurrent request is answered while ten logins hash; a flagged bearer token gets 403 on
  `/api/cases` and `POST /api/users` and 200 after a change, while `GET /api/prefs/effective`
  answers 200 before the change; the two-provider SSO takeover is refused; a same-provider email
  match onto an account holding a different subject is refused; a generic provider asserting
  `hd: corp.test` with `email: x@evil.test` is refused by `allowed_domains: [corp.test]`; B15:
  a soc_manager with RBAC on who changes `discovery_url` on a provider (`default_role` analyst,
  no group map) that a stored super_admin is linked to gets 403 and `prefs.sso` is unchanged, a
  custom role holding only `settings:manage` that sets `default_role: soc_manager` gets 403, and
  a Super admin with a fresh sign-in gets 200; the settings 422 cases and the stored-bad-config
  load; the Sessions label render.
- **Acceptance.** Every probe in [bugs] for these ids flips. Defaults are unchanged for every
  built-in role. The Console changes only the Sessions labels, two Settings inline errors, two
  navigation `perm` fields and the best-effort roles read on Users.
- **Depends on.** Nothing. Merges first.
- **Effort.** L.

#### WP05. Release: version 0.2.0, repository identity, license and guards (L; two merges)

- **Goal.** The tree is 0.2.0, a tag cut from it can pass canonical bootstrap under the new
  identity, it is Apache-2.0, and the release records cannot silently omit content again.
- **Implements.** D1, D2, D3, D13; [rel] R1, R2, R7, R9, R11, R14, R15 (runbook text), R17;
  [wn] R10; B52, B54.
- **Part 1 (merge 2): the version move.** Everything in §3.8 "What moves".
- **Part 2 (Wave 0, after WP07's notes skeleton): identity, license, Dependabot, guards, B52,
  B54.**
- **Owned files.**
  - Version: `VERSION`, `backend/app/__init__.py`, `backend/pyproject.toml`, `webui/package.json`,
    `webui/package-lock.json`, `updater/agentic_soc_updater/__init__.py`,
    `deploy/docker-compose.tlsoc.yml`, `scripts/build_upgrade_plan.py`,
    `scripts/build_docs_bundle.py` and its tests, `scripts/test_docs_theme.py` (the line derived
    from `VERSION`), `updater/tests/test_updater.py`.
  - Identity: `updater/agentic_soc_updater/__main__.py`, `updater/Dockerfile`, `backend/Dockerfile`,
    `webui/Dockerfile`, `scripts/bootstrap-updater.sh`, `updater/tests/test_bootstrap_shell.py`,
    `backend/tests/test_release_discovery.py`, `backend/tests/test_system_updates.py`,
    `webui/src/soc/pages/settings/release-updates.tsx`, `.github/ISSUE_TEMPLATE/*.yml`, and the
    Console tests that name the old repository (`upstream-release.test.ts`,
    `SystemUpdateControl.test.tsx`, `useDeploymentUpgrade.test.tsx`, `Docs.test.tsx`,
    `release-updates.test.tsx`).
  - `webui/src/soc/pages/Docs.tsx` (URL constants, version-line strings, B54), except WP07's helper
    move.
  - `backend/app/engine/update_service.py` and `webui/src/soc/components/SystemUpdateControl.tsx`
    (B52).
  - License: `LICENSE`, `backend/LICENSE` and `updater/LICENSE` (new, byte-identical);
    `backend/tests/test_distribution_contract.py` (the absent-label assertion at line 89 becomes
    `'org.opencontainers.image.licenses="Apache-2.0"' in dockerfile` for all three Dockerfiles,
    plus the LICENSE hash and copy checks); the `!LICENSE` lines in the root `.dockerignore` and
    `updater/.dockerignore`.
  - `.github/dependabot.yml`.
  - `scripts/check_version.py` and its tests.
  - Docs: `docs/releases/0.2.md` and `0.2.0.md` (new), `0.1.13.md`, `0.1.md`, `channels.md`,
    `documentation-versions.md`, the license and identity entries of `known-limitations.md`,
    `docs/index.md` (version lines), `.env.example`, `INSTALL.md`, `DEPLOY.md`, `README.md` (license
    section, third-party notices and version mentions), `docs/operations/upgrades.md` (bootstrap
    step 2, the identity note and the "Observe upstream source revisions" default block at line
    869), `docs/ENVIRONMENT.md` (the `AGENTIC_SOC_UPDATE_REPOSITORY` default, line 211),
    `docs/reference/configuration.md` (the `repository_url` default, line 211),
    `docs/development/testing.md` (line 13), `docs/reference/compatibility.md`,
    `COMPATIBILITY.md`, every other doc sentence that names the current version. `docs/HANDOFF.md:9`
    (the repository line) is a WP18 item.
- **Allowed hunks in shared files.**
  - `mkdocs.yml`: `site_url`, `repo_url`, `repo_name`, `stable_docs_url`, `product_version`,
    `docs_version`, the footer link and the release-page nav entries.
  - `backend/app/config.py`: `ReleaseUpdateConfig` only.
  - `.github/workflows/ci.yml` and `docs.yml`: the four action pins and the identity strings,
    including the updater smoke step's `UPDATE_TRUSTED_REPOSITORY` (`ci.yml:918`).
  - `CHANGELOG.md`: the two headings of §3.8 only.
  - `webui/src/design-system/catalog.ts`: the two version strings.
  - Generated files by regeneration only (§3.9).
- **Contracts.**
  - §3.8 in full.
  - Identity: the new name everywhere in D2's list; the frozen Compose file byte-identical; the
    bootstrap refusals of D2 (missing; the old name in any case; the new name in the wrong case),
    with remediation text and no `.env` edit; the repair in `ReleaseUpdateConfig` runs after
    canonicalisation and compares owner and repository ignoring case (any other URL is kept); the
    legacy ELK checkout directory `./agentic-kibana` stays.
  - License: D3.
  - Dependabot: D13.
  - Guards in `check_version.py`:
    - on every ref, `docs/releases/notes/<VERSION>.json` exists and names `VERSION`;
    - on `refs/heads/main`, a `v*` tag or a pull request into `main` (read from
      `GITHUB_BASE_REF == "main"`, which GitHub sets on `pull_request` events; tests set it
      explicitly; no workflow change): the `[Unreleased]` body is
      exactly `No changes yet.`; the release-commit marker plus `docs/releases/<VERSION>.md` stay
      at most 100,000 characters; the notes file has `status: released` and a `date` equal to the
      dated CHANGELOG heading.
  - B52: `bootstrap_required` is true only when the state backend is PostgreSQL; on SQLite or
    Elasticsearch with no socket it is false and `postgres_state_required` is among the blockers,
    so the top bar shows "Updates unavailable".
  - B54: `PUBLIC_STABLE_DOCS_URL` points at `https://arydestroyer.github.io/Kavach-AgenticSOC/stable/`;
    the false Testing-channel sentence "Stable site publishes with the first Stable release"
    (`Docs.tsx`, about lines 603 to 617) is removed and the Latest Stable link always renders.
  - The Dockerfile marker loop of `check_version.py` (line 194) also requires
    `org.opencontainers.image.licenses="Apache-2.0"`, so the label cannot regress.
  - GHCR visibility runbook text ([rel] B2) in `channels.md` and the 0.2.0 release page, with the
    recovery steps of M2 (§4.11); a `channels.md` note that Dependabot security pull requests
    target the default branch and are forward-ported to `Testing` (D13).
- **Bugs fixed.** B52, B54.
- **Tests.** The [rel] B1 test list; the bootstrap shell test refuses the three bad `.env` cases
  (missing, `arydestroyer/agentic-kibana`, `ARYDESTROYER/kavach-agenticsoc`); the preference repair
  maps `https://github.com/arydestroyer/Agentic-Kibana.git/` and keeps a fork; `check_version`
  cases (missing notes, testing status on a release ref, date mismatch, non-empty `[Unreleased]`
  on main, the same with `GITHUB_BASE_REF=main`, oversize release page, a missing license label);
  the plan builder's `max_exclusive` is `0.3.0`; the docs bundle writes and validates the
  `/docs/0.1/` stubs and one stub keeps `#sources`; the LICENSE hash and its two copies; B52's
  parametrized backends; B54's Docs test.
- **Acceptance.**
  - `sha256sum deploy/docker-compose.agnostic.yml` equals `deploy/update-base-v1.sha256`.
  - `check_version.py` passes on the branch; simulated main and tag contexts fail only on the
    records WP19 writes.
  - `/docs/0.1/analyst/case-manager/` in the built bundle redirects to
    `/docs/0.2/analyst/case-manager/`.
  - `grep -ri agentic-kibana` finds only the historical release pages 0.1.2 to 0.1.13, the frozen
    Compose file, the bootstrap refusal and repair code, migration notes, tests of the old value,
    `archive/`, `docs/research/` and the Journal, and the legacy ELK checkout directory
    `./agentic-kibana`, kept as a local compatibility literal in `deploy/docker-compose.tlsoc.yml`,
    `DEPLOY.md` and `INSTALL.md`.
  - `python -m build` in `backend/` produces a wheel whose metadata carries
    `License-Expression: Apache-2.0`.
- **Depends on.** WP15A (part 1); WP07's notes skeleton (part 2).
- **Effort.** L (part 1 M, part 2 M).

#### WP01. Contracts and foundations (M; backend and Console; no visible behaviour)

- **Goal.** Land every shared contract and stub so later packages run in parallel without touching
  shared files.
- **Implements.** [ai] the pure registry of R1 and the R2 constants; [expl] R1 (types and the
  contract file) and R7 (rounding helper); [be] R8 (`explain_risk`); [cmux] R2 (the weight
  snapshot, merged into the inputs); [dv] the R3 and R14 store methods; [wn] R3 (prefs keys); the
  B13 and B42 model contracts.
- **Owned files.**
  - `backend/app/models.py` (all but the `User` class):
    - `RiskInputs`, and `RiskBreakdown.inputs: RiskInputs | None = None`;
    - `InvestigationView`, `InvestigationSlots`, `InvestigationsActive`;
    - `TraceSpanDetail`, plus optional `TraceSpan.detail` and `TraceSpan.cost_basis`;
    - the six optional `UsageDoc` rate fields (§3.4);
    - `CaseEventsPage` and `CaseUsagePage`;
    - `Citation.case_number: str | None = Field(default=None, max_length=200)` (B42);
    - `UserPrefs.misc` keys `whats_new_seen` (dismissed-intro grammar) and `whats_new_auto`
      (bool, absent means on), normalised on load like `_ROUND14_LIST_PREFS` (invalid values
      removed, never coerced).
  - `backend/app/engine/risk_explain.py` (new, pure):
    `explain_risk(cluster, prefs, reputation, *, reputation_source, scored_at) -> RiskInputs`.
  - `backend/app/engine/investigation_registry.py` (new, pure): `begin`, `started`,
    `attach_case`, `phase`, `end`, `active`, `for_case`, `recent`, `new_runs`, `clear` ([ai]
    §4.2). Every method swallows its own errors.
  - `backend/app/realtime.py`: `CASE_INVESTIGATION_EVENT = "case.investigation"` in
    `SSE_EVENT_TYPES`; `INVESTIGATIONS_TOPIC = "investigations"`;
    `EventBus.publish_many(topics, event_type, data, *, audience=None, retain=True)`, which
    publishes ONE event (one `seq`, one SSE id) into each topic's ring and offers it once per
    subscriber, and dedupes by `seq` on a `Last-Event-ID` replay across a subscriber's topics;
    `publish_case_investigation(bus, view, *, active, new_runs)`, built on `publish_many` with
    `retain=False` on `cases`, `cases:{id}` and `investigations`.
  - `backend/app/audit/event_categories.json` and `webui/src/soc/components/audit/events.ts`:
    `case.close_replaced` ("Close replaced by an AI investigation") and `case.events_viewed`,
    both under `case_work`.
  - Store methods in `stores/base.py`, `stores/usage.py` and `stores/sql/repositories.py`:
    `UsageRepository.records_for_case(case_id, limit=500)`, and
    `AuditRepository.count_for_case(case_id, *, cap)` as a base default built on the existing
    `count_matching` (exact up to its cap, the relation reported), so no audit store file beyond
    `stores/base.py` changes (the Elasticsearch audit store, `audit/audit_log.py`, inherits it).
  - `webui/src/lib/useEventStream.ts`: the `'case.investigation'` channel string only.
  - `webui/src/soc/investigations/aiRunText.ts`:
    `aiRunAccessibleText(view: InvestigationView | null, now: number) => string | null` (null in
    the stub; WP02 appends it to the queue row's accessible name, WP09 fills it).
  - `webui/src/lib/explain/types.ts` (the `Explanation` interface, [expl] §5.3) and
    `webui/src/lib/explain/explain.contract.json`.
  - Stubs with final props and no-op bodies:
    - `soc/investigations/AiRunChip.tsx` `{caseId, compact?}`, `AiRunMark.tsx` `{caseId}`,
      `AiQueueNotice.tsx`, `useAiRun.ts` `(caseId) => InvestigationView | null`;
    - `soc/investigations/ReinvestigateDialog.tsx`
      `{caseRecord, open, onOpenChange, models}`, whose stub body is today's inline Reinvestigate
      dialog moved verbatim from `CaseDetail.tsx` (blocking, as today), so nothing breaks before
      WP09 replaces it;
    - `casedetail/explain/RiskExplain.tsx` `{caseId, score, breakdown, children, variant?: 'row'}`
      (the `row` variant is the mouse-only HoverCard of S11), `DecisionExplain.tsx`
      `{caseRecord, children}`, `FactExplain.tsx` `{explanation, children}`;
    - `webui/src/lib/explain/builders.ts` with the final signatures `explainRisk`,
      `explainDecision`, `explainSla`, `explainPriority`, `explainSeverity`, `explainShare`,
      `explainPercentile`, `explainWilson` and `explainCost`, each returning `null`;
      `webui/src/design-system/explain/index.ts` `ExplainTrigger`
      `{explanation, children, mode?: 'interactive' | 'row-hover'}` rendering its children only;
    - `casedetail/records/CaseEvents.tsx`
      `{caseId, filterEventIds?: string[] | null, onClearFilter?: () => void}`,
      `CaseUsageButton.tsx` `{caseId, totalCost}`, `AllFieldsSheet.tsx`
      `{caseId, open, onOpenChange}`,
      `FindingsList.tsx` `{findings, onShowEvents?: (eventIds: string[]) => void}` (today's
      first-sentence form), `AwaitingReason.tsx` `{caseRecord}`.
  - `casedetail/ConfirmActionDialog.tsx` and `BulkCloseDialog.tsx`: an optional `caseIds` prop
    only (no behaviour); WP03 and WP02 pass it, and WP09 makes each dialog read the investigation
    store for those ids itself.
  - `backend/tests/test_round16_spine_guards.py` (§3.6) and `backend/tests/test_explain_contract.py`.
  - Regenerate `api-types.gen.ts` and `openapi.json`; update `webui/src/lib/types.ts`.
- **Allowed hunks.** `backend/app/utils.py`: `round_half_up(x) -> int` (`floor(x + 0.5)`) only.
  `backend/app/engine/auto_close_review.py`: `publish_review_frame` (line 539) publishes its two
  topics through `publish_many`, one line.
- **Contracts.**
  - `RiskInputs`: `event_count`, `span_seconds`, `effective_window_seconds`,
    `rate_per_minute | null`, `velocity_rule` (`below_min_events | rate`), `rule_values` (the
    distinct list, at most 50 entries) and `rule_type_count` (exactly `len(cluster.rule_values)`);
    `reputation_input` and `reputation_source`
    (`enrichment | not_ip_entity | enrichment_off | not_looked_up`); `asset_value`, `asset_match`
    (`network | exact | none`); `weights` (the five keys), `total_weight`,
    `zero_weight_fallback`; `refs` (`volume 50`, `velocity 10.0`, `diversity 5`); `scored_at`,
    `inputs_version: 1`. The matched CIDR is not stored: every route that returns a case document
    would return it to any `cases:read` holder. WP10's triage route adds it at read time for
    `settings:read` holders only (§4.5 WP10).
  - `InvestigationView` carries no person name; the route adds `requested_by_you: bool` and, for
    `users:manage` holders only, `requested_by: str | null` (D10).
  - Contract vectors: rounding at 80.5, 73.5, 73.6, 47.5 and 21.5; the [expl] §3 risk worked
    example, plus count 2, span 0 and all-zero weights; Wilson 27/30 (0.7438 to 0.9654) and the
    14/20 lower bound 0.4810; percentile of [4, 9, 31, 62] (p50 20.0, p90 52.7); priority lookups
    including `low/high` = P3; SLA states.
- **Bugs fixed.** None directly; it lands the B13 and B42 model contracts.
- **Tests.** A property grid of `explain_risk` against `compute_risk` (count 0 to 120, span 0 to
  3,600 s, reputation, rules 0 to 7, weights including all zero): factor equality; the total
  re-derives from full-precision factors recomputed from the inputs within 0.005, and from the
  stored 2-dp factors within 0.01 (each stored factor is rounded once, then the total). Registry
  lifecycle, pruning of done tasks, the recent
  ring bound and TTL. The SSE registry parity tests on both ends (`test_sse_agent_step_channel.py`,
  `webui/src/lib/__tests__/useEventStream.test.tsx`). `publish_many`: a subscriber on all three
  topics receives one frame with one id, and a replay after a reconnect does not repeat it. The
  prefs normaliser. The store methods on
  the ES fake and on SQLite. `test_explain_contract.py` for the existing functions. `check:types`
  without drift.
- **Acceptance.** All gates green; no visible change; entry within plus or minus 50 B; the §3.6
  guards pass.
- **Depends on.** WP05 part 1.
- **Effort.** M.

### 4.4 Wave 0, parallel (worktrees from the WP01 merge; WP02, WP03 and WP07 may start structural work earlier and rebase)

#### WP02. Case Manager queue and frame (M; Console)

- **Goal.** Reclaim the route's top band and calm the queue.
- **Implements.** [cmux] R1 (frame part, §5.1), R7 (queue rows), the §5.2 focus mode and the §5.9
  empty pane.
- **Owned files.** `webui/src/soc/pages/CaseManager.tsx` and its tests
  (`pages/__tests__/CaseManager.test.tsx`, the `route-visual-standard.test.ts` matched pair, the
  `console-grammar.guard.test.ts` exception modelled on Chat); the new
  `docs/research/2026-11-round16/acceptance/measure-case-manager.mjs` (global Playwright at
  `/opt/node22/bin/playwright`, seeded Demo, outside the build and the npm dependency graph),
  which prints the band height, the frame top, the header height and the top of the active tab's
  first child at 1440 by 900 and 390 by 844. WP02, WP03 and WP16 use it, and its output is
  recorded in §8.
- **Allowed hunks.** `docs/development/ui-standard.md` "Queue and detail workspaces", from the
  section start to the line before `**Case header.**` (the queue paragraphs).
- **Contracts.**
  - Frame: no routed `PageHeader`; an `sr-only` h1 "Case Manager"; Live, Refresh and "About Case
    Manager" in band row 1; `-my-2` and `h-[calc(100dvh-5.5rem)]`.
  - Queue row: a 40 px leading slot that shows the severity glyph and becomes the checkbox on
    hover, focus, any selection, a running bulk job, and always under `(pointer: coarse)`; "Risk
    N" in neutral `text-foreground/80 tabular-nums`, wrapped in `RiskExplain variant="row"` (S11);
    the `AiRunMark` stub inside the status node (or the outcome node), never in the case-chat
    glyph slot before the age, so a row can show both signals; `aiRunAccessibleText(useAiRun(id),
    now)` appended to the row's accessible name array (the `aria-label` overrides descendant text,
    `CaseManager.tsx:392-405, 492`).
  - The bulk confirm passes `caseIds` to `BulkCloseDialog`.
  - `AiQueueNotice` mounted in the band.
  - `[` collapses the queue to a 44 px strip; J and K keep working;
    `soc.caseManager.queueCollapsed` stored with try/catch.
  - `responsiveQueueWidth` clamps to 340 to 520.
  - Empty pane: "No case open", with up to three counted filter shortcuts.
  - `caseManagerShortcuts()` lists only the keys the viewer can use.
- **Bugs fixed.** None.
- **Tests.** X toggles a row whose checkbox is hidden; the checkbox shows after one selection and
  under a coarse pointer (matchMedia mock); the empty-state buttons apply the right filters; the
  shortcuts dialog is truthful.
- **Acceptance.** Measured by `measure-case-manager.mjs`: at 1440 by 900 the split frame starts
  at y = 72 and the band is 92 px when no AI notice shows; the notice shares row 1 or adds at most
  20 px.
- **Depends on.** WP01 stubs.
- **Effort.** M.

#### WP03. Case detail structure: compact header, lanes, inspector (L; Console; critical path)

- **Goal.** One question per region. First content at y at most 210 px at 1440 by 900 for every
  case.
- **Implements.** [cmux] R1 (header, §5.3), R4 (lane tabs, §5.5), R5 (inspector phase 1, §5.6),
  R8 (humanised automation records; the Tasks pointer removed), the §5.10 keyboard model and the
  §5.11 phone layout; [comp] R4 (verdict first inside the Brief, key findings capped at five);
  D8.
- **Owned files.**
  - `webui/src/soc/pages/CaseDetail.tsx` and `webui/src/soc/pages/casedetail/**` except the
    exceptions in §4.10 (`DecisionCard.tsx`, `StageTimeline.tsx`, `SignalProfile.tsx`,
    `caseFacts.ts` to WP11; `ConfirmActionDialog.tsx`, `BulkCloseDialog.tsx` to WP09;
    `CaseHistory.tsx`, `grading.tsx`, `ThreatContextPanel.tsx`, `WhyPanel.tsx`, `files/**`,
    `records/**` to WP14; `explain/**` to WP11).
  - `webui/src/soc/case-tabs.ts`, `webui/src/ui/tabs.tsx` (`density="compact"`).
  - New `casedetail/EvidencePanel.tsx`.
  - The tests of these files, including the `CaseDetail.*` header, tab and focus suites,
    `router-case-tabs.round15.test.tsx`, `router-deep-links.round14.test.tsx`, `OverviewPanel`,
    `InvestigationPanel`, `case-visual-dialect` and `FactsRail`.
- **Allowed hunks.** `webui/src/soc/router.tsx`: the case-tab legacy rewrite only.
  `docs/development/ui-standard.md`: "Case header", "Case tab bodies" and the G17 rule.
  `webui/src/soc/pages/Investigate.tsx`: the look-back seed reads `GET /api/settings` only when
  the caller holds `settings:read` (lines 410 to 428).
- **Contracts.**
  - **Tabs (D8).** Ids `['overview', 'evidence', 'investigation', 'runbook', 'collab', 'chat']`,
    labels Brief, Evidence, AI investigation, Response, Activity, Chat, on Alt+1 to Alt+6 (the
    key handler accepts `Digit1` to `Digit6`, `CaseDetail.tsx:1727`; each trigger's
    `aria-keyshortcuts` follows). Alt+2 (Runbook to Evidence), Alt+4 (Collaboration to Response)
    and Alt+5 (Chat to Activity) change meaning; Chat moves to Alt+6. Legacy rewrites: `timeline` opens `evidence` at `what-happened`; `threat` opens `evidence` at
    `threat-context`; `tab=investigation&section=threat-context` opens `evidence`;
    `section=related-cases` opens `evidence`. `tab=investigation` itself is unchanged (the audit
    "Open case trace" links). Response shows to everyone: tasks always, the runbook with
    `runbooks:read`.
  - **Header.** Row 1 (44 px): title, primary action, Take action, Ask AI, More, the inspector
    toggle (`]`), Back. Row 2: a 24 px meta strip that never wraps. Its items, in priority order:
    case number; severity; status or outcome; the Risk chip (wrapped in `RiskExplain`); the AI
    verdict chip (wrapped in `DecisionExplain`) with `AiRunChip` right after it; owner; SLA; the
    review chip. Items hide by container query in reverse priority, but the owner control never
    hides (only its name, below 44rem), because it is the owner's editable home and the anchor of
    the M shortcut's popover. A hidden SLA or review chip stays reachable: the SLA in the
    inspector's Signal section, the review sentence in the Brief's first block. Tabs: 36 px. Total
    height 118 px for every case, review samples included: the `ReviewBand`
    (`CaseDetail.tsx:2242`) leaves the header; its sentence moves to the review chip's hover and to
    a one-line review note as the Brief's first block.
  - **Panel padding.** `CASE_MANAGER_PANEL_PADDING` (`casedetail/shared.tsx:44`) becomes
    `'px-4 pt-4 pb-6 @[48rem]/case:px-5 @[64rem]/case:px-6'` (top padding 16 px at every width;
    today it is 20 px from `sm`). With the 56 px top bar, the 16 px frame inset, the 118 px
    header and its 1 px hairline, the first content sits at 207 px.
  - **Inspector.** A column from `@[52rem]/case`, 272 px, or 304 px from `@[72rem]/case`; `]`
    toggles it, persisted in `soc.caseManager.inspector`; six collapsible sections with persisted
    open state: Outcome, Signal, Times, Source and entity, Tags and campaign, Record (collapsed).
    Record mounts "View all fields" (`AllFieldsSheet`) and `CaseUsageButton`; Outcome mounts the
    hold-reason fact (`AwaitingReason`).
  - **Brief.** A 48 px Next step row; four lanes tagged with the existing `ProvenanceTag` kinds:
    Evidence (`source`), AI (`ai`), Decision (`code`, holding `DecisionCard` and the
    `AutomationApplied` disclosures), People (`analyst`); a folded "How this case was built"
    (`StageTimeline`). The lanes follow the ui-standard one-home rule: they summarise without
    repeating the header's verdict, confidence, risk, status or owner, and each lane links to its
    tab. The header Risk chip and the inspector's Signal meter are the sanctioned pair (the
    inspector is the rail, not a tab).
  - **Evidence.** What happened (fenced), the `CaseEvents` stub, entities, threat context,
    related cases, baseline.
  - **AI investigation.** Assessment (`FindingsList`), inputs, the trace (expanded while
    `useAiRun` reports a run), gradings, one muted advisory line. `FindingsList`'s
    `onShowEvents` switches to the Evidence tab with `CaseEvents` filtered to those ids
    (`filterEventIds`, cleared by `onClearFilter`).
  - **Reinvestigate.** The inline dialog (`CaseDetail.tsx:1579, 2556`) is replaced by the mounted
    `ReinvestigateDialog` stub (WP01); WP09 fills its body. The close dialog receives `caseIds`.
  - **Settings reads.** Case detail calls `GET /api/settings` only when the caller holds
    `settings:read` (`CaseDetail.tsx:1287-1308`), so a `cases:read` holder without it neither
    loses the case facts nor writes an Access denied row on every open. Without it, the auto-close
    policy for the case's verdict and the SLA reading come from `GET /api/cases/{id}/triage`
    (WP10's `auto_close_policy` and `sla`), and the runbook-preference and notification-channel
    facts hide.
  - **Activity.** Discussion, files, history.
  - **B27.** Case detail reads `prefs.auto_close` (the `AutoClosePolicy`, or the triage route's
    `auto_close_policy` without `settings:read`), not the deprecated
    `prefs.fp_auto_close` (`CaseDetail.tsx:1295`); a helper `policyForVerdict(policy, verdict)` in
    `casedetail/shared.tsx` returns the false-positive entry for false-positive or benign verdicts,
    the true-positive entry for true positives, and `{enabled: false}` for needs-human or any other
    verdict; `FactsRail` and `InvestigationPanel` use it.
  - **B28.** "Change owner" and "Edit tags" open only after the Take action menu has closed: a
    pending-editor ref, and `onCloseAutoFocus` that prevents Radix's trigger refocus and then
    opens the editor.
- **Bugs fixed.** B27, B28.
- **Tests.** The updated suites; a segregation guard (no `ProvenanceTag kind="code"` in the AI tab,
  no `kind="ai"` in Evidence); one deep-link test per legacy id; the key handler accepts 1 to 6
  and Alt+5 opens Activity, Alt+6 Chat; the meta strip is `flex-nowrap` with its hide classes; M
  opens the owner popover at a 30rem pane; `[` and `]` honour `shortcutBlocked`; jest-axe; B27 with
  `fp_auto_close` and `auto_close` disagreeing; B28 opens each editor and keeps it open; with
  `settings:read` denied, the case page makes no `GET /api/settings` call and shows the policy
  line from the triage route; "Cites N events" filters the Evidence table.
- **Acceptance.** Measured by `measure-case-manager.mjs` (WP02): the top of the active tab panel's
  first child (`data-testid="case-tab-first"`) is at most 210 px from the top of the window at
  1440 by 900 and at 390 by 844, for a normal case and a pending review case; the header is at
  most 120 px; at 1440 px with the navigation collapsed the inspector shows as a column.
- **Depends on.** WP01 stubs.
- **Effort.** L.

#### WP04. Sign-in page (M; Console)

- **Goal.** A quiet sign-in page on the Console's own tokens; "Remember me" without a duration.
- **Implements.** [login] R1 to R12 and R14 (R15 optional); D6, D9.
- **Owned files.**
  - `webui/src/soc/pages/Login.tsx`, `webui/src/soc/components/auth/loginParts.tsx`,
    `webui/src/soc/components/auth/RememberMeControls.tsx`.
  - Deleted with their tests: `components/auth/LoginAuthBackdrop.tsx`, `components/auth/ShineButton.tsx`,
    `components/auth/ThemeModePill.tsx`.
  - Gates: delete `webui/scripts/gate-login-accents.mjs` and `.d.mts`; drop step 6 in
    `webui/scripts/gates.mjs`; add the replacement pairs in `webui/scripts/gate-contrast.mjs`; drop
    the login blocks in `webui/src/soc/__tests__/design-gates.test.ts` and
    `webui/src/design-system/__tests__/foundations.test.ts`.
  - `webui/src/soc/theme.tsx` (a `brandingFresh` flag), `webui/src/soc/components/BrandingEditor.tsx`
    (the preview and B50), the login tests of [login] §7, `docs/getting-started/first-run.md` (text).
- **Allowed hunks.** `webui/src/styles/theme.css`: the login block (deleted, replaced by about 20
  lines). `webui/src/soc/App.tsx`: `CenterSpinner` delayed reveal only. `ui-standard.md`: "Identity
  surfaces" and "Identity accents" (rewritten, D9). `bundle-first-paint.test.ts`: the eager-chain
  list.
- **Contracts.**
  - **Remember me (D6).** When available, the row is the label "Remember me" with no accessible
    description. The two unavailable states keep their one-line reason. The warning dialog keeps
    its facts.
  - **SSO errors (B25).** The ten backend `sso_error` codes map to fixed sentences; anything else
    shows "Single sign-on failed. Try again." The URL is still cleaned.
  - **Appearance.** A three-button group: "Use system theme", "Light theme", "Dark theme".
  - **Heading and fields.** H1 "Sign in to {org_name}", or "Welcome back" when the device remembers
    a username; Continue always rendered; an empty submit shows "Enter your username."; OTP
    submits automatically, once, guarded by `busy`.
  - **Motion.** CSS only, `transform` and `opacity` only, at most 300 ms (the brand wash at most
    600 ms), `backwards` fill, inside `prefers-reduced-motion: no-preference`, no `infinite`.
  - **Order.** The What's new dialog appears only after the hand-off into the Console.
  - **B50.** The Branding editor's unset accent placeholders and preview come from the live tokens
    (`resolvedTokenHex('--primary')`, `--accent2`), not the hard-coded violet and teal.
- **Bugs fixed.** B25, B50.
- **Tests.** The [login] R1 to R14 cases; no timers or re-renders after first paint (fake timers,
  60 s); the `theme.css` keyframe source guard; one `/api/branding` call on a cold load and two
  after a sign-out; every backend `sso_error` code maps to a sentence (the test reads the codes
  from `routes.py`) and an arbitrary value such as "Call 555" never reaches the DOM; B50's preview
  shows the token accents.
- **Acceptance.** The entry shrinks by about 7 KB; the global CSS by about 13.9 KB; login field
  edges use `--input` (3.27:1); no assertion is weakened except by subject removal, recorded as
  such.
- **Records.** Reverses Round 14 D3 for the row (D6), replaces the recorded Identity contract and
  retires `gate-login-accents` as subject removal (D9).
- **Depends on.** Nothing.
- **Effort.** M.

#### WP06. Performance extras (M; backend)

- **Goal.** Remove three measured hot spots without touching decisions or storage layout.
- **Implements.** [be] R2 layer 1, R4, R1, and R5 (optional).
- **Owned files.** `backend/app/api/metrics_shared.py` (an all-time population TTL of 60 s with
  stale-while-revalidate; windowed reads keep 5 s); `backend/app/stores/auto_close_review.py`
  (a memo keyed by revision, plus a `case_id` to entry dict); `backend/app/api/routes_auto_close_review.py`
  (pass the loaded ledger into `_repair`); `backend/app/stores/sql/vectorstore.py` (pgvector `<=>`
  over the existing JSON column with a `dim` filter on PostgreSQL; a normalised float32 matrix
  cache on SQLite and as the fallback, invalidated directly by the store's own `add`, `delete`
  and `clear`, fingerprinted by `count(*)` and `max(id)`, and expiring after 60 s, because a
  foreign upsert that deletes the highest row and inserts its replacement reuses the same SQLite
  rowid (`RagChunkRow.id` has no `AUTOINCREMENT`, `stores/sql/models.py:109`) and leaves count,
  maximum and sum unchanged; numpy is imported behind a guard that falls back to today's Python
  path);
  `backend/app/stores/sql/engine.py` (one `pg_extension` probe at start);
  `backend/app/api/routes_diagnostics.py` (the loop-lag gauge).
- **Allowed hunks.** `backend/app/state.py`: the loop-lag task.
- **Contracts.** Stale all-time figures are never presented as fresh (`generated_at`).
- **Bugs fixed.** None.
- **Tests.** At most one all-time read across N LIVE ticks inside the TTL, and stale-while-revalidate
  serves the previous value during a refresh; one ledger decode per revision; vector top-k parity
  across the Python, numpy and pgvector paths in the PostgreSQL lane; cache invalidation on add,
  delete and clear, a foreign insert seen through the fingerprint, and a foreign
  same-rowid upsert seen once the 60 s expiry passes; the Python fallback when numpy is not
  importable; a dimension mismatch still raises `EmbeddingSpaceMismatch`;
  2,000 chunks answer in under 50 ms warm on SQLite; the loop-lag gauge rises with a blocking
  coroutine.
- **Acceptance.** Posture and metrics parity tests unchanged; no new dependency (numpy arrives
  through `pgvector==0.4.2`, which requires it and is in `requirements.txt`, so both images carry
  it; confirm with `pip check` in the final image).
- **Depends on.** Nothing.
- **Effort.** M.

#### WP07. What's new and the Communication page (M to L; scripts, Console, small backend)

- **Goal.** After an update, a user sees a short welcome once. Every release is documented with
  screenshots in Communication, What's new.
- **Implements.** [wn] R1, R2, R3, R4, R6, R8, R9; [comp] R6; [be] R9 (superseded by this design);
  D5, D7.
- **Owned files.**
  - Generator: `scripts/build_release_notes.py` and `scripts/test_build_release_notes.py`.
  - Notes: `docs/releases/notes/0.2.0.json` (the skeleton: structure and dated update ids from
    the [wn] §6 backfill table renamed from `0.1.13.` to `0.2.0.`; WP17 writes the content);
    `docs/assets/releases/0.2.0/` (WP17 fills it).
  - Generated: `webui/src/soc/whats-new/release-notes.gen.json`, `backend/app/whats_new_latest.json`,
    `docs/releases/whats-new.md`.
  - `webui/src/soc/whats-new/**`: `decide.ts`, `WhatsNewHost.tsx`, `WhatsNewDialog.tsx`, the
    figure, a generic lightbox, the rows and the version rail.
  - `webui/src/soc/pages/WhatsNew.tsx` (lazy).
  - `webui/src/soc/registry.tsx`: the group label "Communication", children Inbox and What's new,
    `PageId 'whats_new'`, the lazy route.
  - `webui/src/lib/docs-url.ts` (moved from `Docs.tsx`, re-exported there) and
    `webui/src/lib/semver.ts` (from `upstream-release.ts`).
  - `webui/src/soc/prefs.tsx` (a `loaded` flag, [wn] F3); `webui/vite.config.ts` (the
    `__AGENTIC_SOC_WHATS_NEW_LATEST__` define; a new name, because no new compatibility-prefixed
    identifier is minted) and `webui/src/vite-env.d.ts`.
  - `backend/app/whats_new.py` (`latest_update_id()`, fail-open to `None`).
  - The personal Settings switch "Show What's new after updates": one row in the Appearance
    section (`components/CustomizationSection.tsx`, owned by WP15E; WP07 adds only this row and
    merges first), plus the "what's new" and "release notes" search keywords of the
    `customization` section in `pages/settings/settings-sections-meta.ts`, with the console map
    regenerated.
  - Tests: `route-registry.test.tsx`, `nav.behaviour.test.tsx`, `nav-titles.round14.test.ts`,
    `route-visual-standard.test.ts`, `console-map.contract.test.ts`, the new What's new tests.
- **Allowed hunks.**
  - `webui/src/soc/App.tsx`: the gate beside `ReauthDialog` and the stamp on wizard completion.
  - `webui/src/soc/AppShell.tsx`: the `ReleaseBadge` link "What's new in vV".
  - `webui/src/soc/pages/Docs.tsx`: the helper move and a "What's new" entry in `DOC_CATEGORIES`.
  - `webui/src/soc/router.tsx`: the `whats_new` deep-link keys `v` and `h`.
  - `backend/app/api/routes_prefs.py`: `whats_new_seen` joins `_AUDITED_MISC_KEYS`.
  - `backend/app/api/routes.py` (`create_user`, the create branch of `_provision_sso_user`) and
    `backend/app/api/routes_setup.py` (`POST /setup/account`): the creation stamp (D7).
  - `mkdocs.yml`: one nav line, "What's new: releases/whats-new.md", first under "Releases and
    versions".
  - `.github/workflows/ci.yml`: the docs lane step `python scripts/build_release_notes.py --check`
    and the generator test (and `scripts/check_ci_contract.py` if it pins lane steps).
  - `.github/workflows/ci.yml`: the wheel check adds `app/whats_new_latest.json` to its
    `required` set (about line 120).
  - `backend/pyproject.toml` (WP05 owns it; after WP05 part 1): `[tool.setuptools.package-data]`
    gains `"whats_new_latest.json"`, so the wheel and the sdist carry it.
  - `scripts/build_app_knowledge.py`: `GUIDE_EXACT` gains `releases/whats-new.md`.
  - `docs/USAGE.md`: the "Notifications" group mentions (about lines 65 and 1953).
  - `docs/development/ui-standard.md` "Navigation and information architecture": the sentences
    that name Notifications as a single-page group (about lines 1292 and 1343 to 1345) become
    Communication with Inbox and What's new.
  - `bundle-first-paint.test.ts`: the not-in-entry assertions.
- **Contracts.**
  - Notes schema 1 with every [wn] §4.1 rule: plain text only; closed `kind` and `area` lists;
    `open.page` validated against `console_map.json`; WebP screenshots at most 2,880 px wide and
    250 KB with dimensions read from the header; alt text of at least 40 characters; featured
    highlights need light and dark images; no hidden characters and no em dashes; titles never say
    "Round".
  - The show rule of D7 and [wn] §4.2 (without the eligibility route). Never shown over sign-in,
    setup, a forced password change, the wizard, re-authentication, another open dialog, or a deep
    link to a record (a deep link defers to the next landing page). Any close writes the marker
    once; a `localStorage` mirror (`soc.whatsNew.seen:<user>`, try/catch, in the existing `soc.`
    key style such as `soc.nav.collapsed`, never a new `tlsoc_` name) is the fallback when the
    write fails.
  - The dialog ([wn] §4.3): 40rem, focus on the title, closing focus to `#socMain`, at most 5
    highlights, a theme-matched hero figure, "See all changes" and "Got it"; announces the six tabs,
    the Alt+2, Alt+4 and Alt+5 changes and Chat on Alt+6 (D8).
  - The page ([wn] §4.4): `#/whats_new?v=&h=`, a version rail from 1,280 px, area and kind chips,
    Copy link, "Show the welcome screen", and an "Earlier release records" group (0.1.2 to 0.1.13
    as one line each; 0.1.13 reads "Unpublished candidate, folded into 0.2.0").
  - With sign-in off the marker is per installation (documented).
- **Bugs fixed.** None.
- **Tests.** The [wn] §8 list without the eligibility rows; plus: the creation stamp in each of
  the three create paths, a stamp failure never fails the create, an older marker lists the newer
  updates, a deep link defers, the generator `--check` reports drift in each of the three outputs.
- **Acceptance.** The seeded Demo admin sees the welcome once on a landing page after sign-in; a
  reload shows nothing; a newly created account sees nothing; the gate at most 450 B and WP07's
  total entry growth reported and at most 700 B (§3.1); the notes JSON and the dialog title are
  not in the entry; the generator `--check` runs in CI; the wheel carries
  `app/whats_new_latest.json`; the WP05 notes guard passes with the skeleton.
- **Depends on.** WP01 (prefs keys), WP15A (it edits the same create paths first).
- **Effort.** M to L.

#### WP15B. Pipeline, ingest and job spine fixes (L; backend)

- **Goal.** No run wipes a decided case, overrides a person, mints a duplicate, loses spend or
  misses a configured window. #3 and #4 hold under the confirmed failure scenarios.
- **Owned files.** `backend/app/engine/ingest.py`, `engine/poller.py`,
  `engine/poller_manager.py` (the drain), `engine/jobs.py` (`_case_reinvestigate`),
  `engine/threshold_automation.py` (except B36's one line), `backend/app/ocsf/identity.py`,
  `backend/app/es/indices.py` (`CASES_MAPPING`, the explicit `awaiting_reason` and
  `risk_breakdown.inputs` mappings, and a new `extend_cases_mapping` called by
  `bootstrap_indices`), tests.
- **Allowed hunks.**
  - `backend/app/agents/pipeline.py`: `_register_candidate_locked`, `_investigate_cluster_run`
    (the lookup and the attach-only guard), the `except` path and `_fail_to_human_case`,
    `_carry_case_work`, the analyst-policy builder, the `ThresholdAutomation.run` call site.
  - `backend/app/state.py`: `cluster_for_case` (line 1677) and `_reenter_detections` (line 2086).
  - `backend/app/engine/demo_runtime.py`: `DemoStack.route_event_batch`.
  - `backend/app/config.py`: `Preferences.widest_correlation_window_seconds()` only.
  - `backend/app/stores/base.py`, `stores/cases.py`, `stores/sql/repositories.py`:
    `list_deferred_candidates` only; in `stores/cases.py` also the save-path rule that leaves
    `risk_breakdown.inputs` out of the stored document when bootstrap could not extend the cases
    mapping (§3.4).
  - `backend/app/engine/poller.py` and `engine/ingest.py` call sites of `link_cross_source` (both
    owned).
- **Contracts.**
  - **B04.** `register_candidate` on an open case that has a verdict, or that a person moved
    (`decision_by == ANALYST`), attaches the events and returns the case without a rebuild;
    `_reenter_detections` and `route_event_batch` skip `investigate_cluster` for it.
  - **B05.** `handle_clusters` (`engine/ingest.py:348`) treats a candidate with
    `decision_by == ANALYST` as attach-only; `_investigate_cluster_run` does the same for a
    non-forced run, with an audit row, so the drain and the event-detection path are covered.
    `decide()` and `apply()` are unchanged.
  - **B06.** `state.cluster_for_case` delegates to `engine.case_cluster.cluster_for_case` with
    `self.prefs`, `self.poller.source_for_id(...)` and `allow_stored_reconstruction=True`, so the
    drain, the job and the route compute the same risk for the same stored case.
  - **B07.** `Preferences.widest_correlation_window_seconds()` returns the largest of the default
    window, every `correlation_rules[*].window_seconds` and every enabled catalog rule's effective
    window (mode `NEVER` skipped); `Poller._correlation_lookback_seconds` (`poller.py:247`) and the
    push look-back in `IngestService` use it, keeping the formula and the cold-start clamp. On a
    push source the effective look-back is the lesser of the widest window and the per-source
    in-memory ring of 500 events (`ingest.py:722-723, 833-836`; lost on restart), so on a busy
    push source a long window still sees only the last 500 events. This is recorded in
    `known-limitations.md`, and the push regression test uses an event rate under the ring.
  - **B08.** `ThresholdAutomation.run` takes `fetch`, re-reads the case before saving and applies
    only its own deltas (new tags within `CASE_TAG_MAX_COUNT`, new comments, new
    `automation_actions`); a failed read falls back to today's save.
  - **B09.** `_carry_case_work` also carries `automation_actions`, `related_case_ids`,
    `cross_source_cluster_id` and `source_breakdown`; the analyst-policy builder carries
    `automation_actions`. `link_cross_source` (`ingest.py:518`, today
    `(clusters, prefs, *, cases)`) gains a `pipeline` keyword, and both call sites
    (`ingest.py:911`, `poller.py:740`) pass `pipeline=self._pipeline`. For each linked case it
    re-reads the case by id under `pipeline.signature_lock(case.cluster_signature)` (through the
    existing `_sig_lock` helper) and saves only the three link fields; without a pipeline it keeps
    today's behaviour. This closes the `ROADMAP.md` section I link contract.
  - **B10.** The identity lookup in `_investigate_cluster_run` runs before the `try`, so a lookup
    failure reaches the existing retry boundaries and no case is minted.
  - **B11.** `CaseRepository.list_deferred_candidates(*, older_than, limit)`: the base default keeps
    today's paged scan; Elasticsearch runs one search (`status: open`, prefix `deferred:` on
    `awaiting_reason.keyword`, `updated_at < older_than`, no `verdict`, sorted by `created_at`); SQL
    filters the JSON document the same way; `CASES_MAPPING` gains the explicit `awaiting_reason`
    of §3.4. `_drain_deferred` (`poller_manager.py:457`) asks
    `list_deferred_candidates(older_than=..., limit=max(50, 2 * limit))` and iterates until
    `limit` candidates are investigated, as today's page size does; a candidate whose cluster
    cannot be rebuilt is skipped without counting, so it never blocks the candidates behind it.
  - **B12.** `_fail_to_human_case` keeps the stored `token_cost`; the `except` path raises it to the
    ledger's `recorded_case_pipeline_cost` when that is higher (never `cost + sum(cost_accum)`).
  - **B14.** `_case_reinvestigate` fails the item with a fixed message when the returned case
    carries this run's `error` or a `[FAILED]` title.
  - **B33.** `native_event_uid` (`ocsf/identity.py`) skips the `event_id` path for LEEF records
    (the header EventID names an event type), so LEEF events take the hash-plus-ordinal fallback;
    the record shape and `rec["event_id"]` stay (saved mappings and the Demo use it).
- **Bugs fixed.** B04, B05, B06, B07, B08, B09, B10, B11, B12, B14, B33.
- **Tests.** One regression per bug, modelled on the [bugs] reproduction, and
  `test_round15_wp1_carry.py` extended to the new carried fields in all three builders.
  B11: the oldest candidate cannot be rebuilt and a tick with an allowance of 1 still drains the
  next one. The cases mapping: a fresh bootstrap maps `risk_breakdown.inputs` with
  `enabled: false`; an upgraded index gains it; a client that cannot extend leaves `inputs` out
  of the stored document and the save succeeds; a rule value `2026-01-01` followed by an ordinary
  rule name saves both cases on the Elasticsearch fake with dynamic mapping simulated.
  `test_wave6_decide_guard.py` stays green.
- **Acceptance.** Every probe flips; no model call added; the §3.6 guards pass.
- **Depends on.** WP01 merged.
- **Effort.** L.

#### WP15C. Metrics, SLA and time-window fixes (M; backend)

- **Goal.** The numbers explanations will describe are right first.
- **Owned files.** `backend/app/engine/shift_report.py`, `engine/case_aggregate.py`,
  `backend/app/stores/chat_feedback.py`, `backend/app/api/routes_chat_library.py` (the summary
  route), tests.
- **Allowed hunks.**
  - `backend/app/engine/metrics.py`: `sla_metrics` (line 897) and `compute_metrics` (line 295,
    the MTTR loop).
  - `backend/app/api/routes_metrics.py`: the breakdown `other` count (about line 1410).
  - `backend/app/utils.py`: `millis_to_iso_utc` and `relative_to_iso_utc_strict`.
  - `backend/app/api/routes.py`: `_millis_to_iso` (about line 8718).
  - `backend/app/agents/chat_tools/cases.py`: the shift snapshot "Needs attention" item (about
    line 1470).
  - `backend/app/engine/chat_starters.py`: the two `sla_aging` calls (about lines 1381 and 1496)
    pass `prefs=b.prefs`.
- **Contracts.**
  - **B26.** In `sla_metrics`, a terminal case with no human response stops its response clock at
    its terminal instant (`timings.terminal_any or timings.updated_iso`); a genuinely open,
    unresponded case keeps the live clock; a close after the target still counts as late. The
    per-case rules inline in the `sla_metrics` loop (`metrics.py:897-1000`: the response anchor,
    the terminal stop, the resolution fallback and at-risk) move into one pure
    `metrics.sla_case_reading(case, target, timings, *, now)`, which `sla_metrics` calls and
    WP10's `sla_reading.py` reuses.
  - **B59.** Operational MTTR uses the first terminal transition (`_resolved_dt`, line 471) over
    every terminal case; the wire shape is unchanged.
  - **B60.** `sla_aging` takes `prefs`, resolves the level with `metrics._sla_priority` (line 881)
    and stops the response clock at the first human response (`_CaseTimings`). Its two callers in
    `engine/chat_starters.py` (lines 1381 and 1496) pass `prefs=b.prefs`, so the starter cards
    ("N past target") agree with Standup.
  - **B68.** `build_case_result` adds `groups_counted`; the breakdown's `MetricsBreakdownOther`
    counts only groups with cases in the window.
  - **B39.** The attention queue row and the shift-brief item carry `created_at`.
  - **B02.** The two ISO conversions clamp to the representable datetime range instead of raising,
    so an out-of-range relative window answers 200.
  - **B03.** `ChatFeedbackStore.breakdown` compares instants (`_instant` with UTC normalisation);
    the summary route answers 422 for an unparseable `since` or `until`.
- **Bugs fixed.** B02, B03, B26 (with B58), B39, B59, B60, B68.
- **Tests.** One regression per bug; the posture parity tests stay green; the SLA vectors of
  `explain.contract.json` agree with `sla_metrics`; the chat starter "past target" count equals
  the Standup count for the same population; `sla_metrics` output is unchanged by the
  `sla_case_reading` extraction on the existing fixtures.
- **Acceptance.** An agent-closed case older than its target no longer becomes a breach over time;
  one comment no longer moves MTTR.
- **Depends on.** WP01 merged.
- **Effort.** M.

#### WP15E, part 1 (merges in Wave 0): B43 and B46

The Demo wizard and Make primary fixes land early because B43 writes Demo data into the live
configuration. Contracts and tests are in §4.5 WP15E.

### 4.5 Wave 1 (after WP01, WP15B and WP15C merge)

#### WP08. AI run tracking: backend (M to L)

- **Goal.** The server knows, and says, which investigations are queued or running, and how each
  ended.
- **Implements.** [ai] R1 (wiring), R2 (route and frames), R3 (terminal frame), R4 (non-blocking
  Reinvestigate and `409`), R5 (reinvestigate a closed case in place), R8 (finish notices and the
  close-replaced record), R11 (narrow the lost-update window), R13 (optional); [be] R7; the backend
  part of [comp] R1; D10.
- **Owned files.** The new `backend/app/api/routes_investigations.py`;
  `backend/app/engine/demo_runtime.py` (the Demo registry, except WP15B's hunk); the lock-only
  hunks of `backend/app/api/routes_cases_collab.py` writers; `backend/tests/test_round16_investigation_registry.py`.
- **Allowed hunks.**
  - `backend/app/agents/pipeline.py`: the registry wrapper in `_investigate_cluster_locked`
    (line 817); new keywords `trigger`, `requested_by`, `known_case_id`, `target_case_id` and
    `run_id`, all defaulted; the `_emit_step` (line 406) phase hook and outcomes at the early
    returns; close-replaced detection; the terminal `decision failed` frame in the `except` path; a
    per-case lock from the re-read to the save, taken only inside the signature lock.
  - `backend/app/api/routes.py`: `case_reinvestigate` (8364) and the investigate handler (8313);
    `investigations` in `_REALTIME_TOPICS` and `_REALTIME_TOPIC_GRANTS` (`cases:read`); the case
    lock around read and save on the case action path. No key is added to `_case_view`: `GET
    /api/cases/{id}` returns the `Case` model (`response_model=Case`, `routes.py:7150`), so a
    non-field key would show after a mutation and vanish on the next read. The Console reads run
    state only from `GET /api/investigations/active?case_id=` and the frames; the `wait=false`
    202 body carries the `run_id`.
  - `backend/app/engine/jobs.py` (`_case_reinvestigate`, after WP15B) and
    `backend/app/engine/poller_manager.py` (`_drain_deferred`, after WP15B).
  - `backend/app/engine/ingest.py` (after WP15B): `attach_cluster` (line 235) gains an optional
    `pipeline` keyword; with a pipeline that exposes `case_lock`, it re-reads the case by id under
    `case_lock(case_id)` (inside the signature lock its caller holds) and applies the attach to
    the fresh copy before saving, so a person's concurrent close is not overwritten. Its three
    call sites (`ingest.py:349, 444`, `poller.py:839`) pass the pipeline; without one it keeps
    today's behaviour.
  - `backend/app/state.py`: the registry on `AppState` and an `investigations` property with the
    Demo split; `_investigation_finished`, started with `spawn_mutation_task`; the case-lock
    registry, cleared on factory reset; `_reenter_detections` (line 2086, after WP15B) passes
    `trigger="detection"` only.
- **Contracts.**
  - **The frame.** `case.investigation` carries exactly: `run_id`, `case_id|null`; `state`
    (`queued|running|finished`), `phase` (`queued|triage|specialist|evidence|verdict|decision`);
    `trigger` (`automatic|manual|job|drain|detection`); `queued_at`, `started_at`, `deadline_at`,
    `time_cap_seconds`, `finished_at`; `outcome`
    (`decided|routed_to_person|closed_by_policy|unchanged|cancelled|failed`), `status_after`,
    `verdict_after`; `active` and `new_runs`. No person name. Sent on start, on a late case attach
    and on end; a queued frame only when the gate is full.
  - **`GET /api/investigations/active?case_id=`** (`cases:read`, memory only, Demo split):
    `items` and `recent` (the last 120 s), `new_runs`, `slots{in_use, cap}`, `process_local: true`,
    `generated_at`; each item adds `requested_by_you` and, for `users:manage` holders,
    `requested_by` (D10).
  - **`POST /api/cases/{id}/reinvestigate`** body `wait: bool = True`: `wait=false` answers
    `202 {run_id, case_id, state: "queued"}`; a second request answers
    `409 {"code": "investigation_running", "run": ...}`, checked before the audit row and the
    cluster rebuild. The check matches an active run by case id or by `cluster_signature`, so an
    automatic run on the same signature that has not yet attached its case is found too.
  - **A closed target (R5).** A closed case is reinvestigated in place (no second case) only when
    no open case holds its signature. When `target_case_id` is closed and another open case holds
    the signature (new events arrived after the close), `POST /api/cases/{id}/reinvestigate` and
    `/investigate` answer `409 {"code": "open_case_exists", "case_id": <open id>}` before the
    audit row and the rebuild (the route looks up `find_open_by_signature` on the stored
    signature), and the job item fails with the same reason. If the open case appears between
    that check and the run, the run, inside the signature lock, finds it, does not reopen the
    target, and ends with outcome `unchanged`, returning the target as stored.
  - **Inbox notices**, built from enums only ([ai] §4.5 copy): to the requester of a manual run
    when it finishes; to a person whose close was replaced, with a `case.close_replaced` audit row.
    Job and automatic runs get no item.
  - **D10 drain skip.** The drain passes `trigger="drain"` and `known_case_id=case.case_id`. For a
    non-forced run with trigger `drain`, `_investigate_cluster_run` re-reads that case inside the
    signature lock (after the gate). If the case is no longer open, or a person moved it
    (`decision_by == ANALYST`), the run returns it unchanged (registry outcome `unchanged`) and
    never mints a case. This closes the window in which a close made while the run waited for the
    lock or the gate would make `find_open_case_for_cluster` miss and mint a second case for the
    same events. `handle_clusters` passes no `known_case_id`, so new events after a close still
    open a new case (#4).
  - **The case lock.** A process-local per-case `asyncio.Lock` registry in a
    `weakref.WeakValueDictionary` (the pattern of `_sig_locks`, `pipeline.py:383-388`), shared by
    the real and Demo pipelines, exposed as `pipeline.case_lock(case_id)`. The pipeline takes it
    only inside the signature lock; a person's action and the collaboration writers take it alone;
    so no path holds the case lock while waiting for a signature lock.
- **Bugs fixed.** None (B05 and B10 land first in WP15B).
- **Tests.** The [ai] flip probes F1 and F6; F5 close-replaced (one Inbox item, one audit row); no
  item for job or automatic runs; cancellation empties the registry; the queued state with a cap of
  1; the run id equals the audit `run_id`; factory reset cancels a spawned run; a close injected
  during the ledger read survives in `status_history`; 403 without `cases:read`; the Demo split;
  the exact frame key set; the name only for `users:manage`; close X, new events open Y, then
  reinvestigate X answers `409 open_case_exists` and the store still holds one open case; a person
  closes a deferred candidate while its drain run waits on the gate and no second case is minted;
  a second Reinvestigate while an automatic run on the same signature has not attached its case
  answers 409; `attach_cluster` racing a person's close keeps the close; the case-lock registry
  holds no lock after its users finish. `test_round15_wp1_carry.py` stays green.
- **Acceptance.** All probes flipped; no persistent field and no model call; the registry never
  raises into a run.
- **Depends on.** WP01, WP15B.
- **Effort.** M to L.

#### WP09. AI run Console and one stream per page (M to L)

- **Goal.** Anyone can see what the AI is doing now, from the queue, the case, the navigation and
  the close dialog.
- **Implements.** [ai] R3 (narration UI), R6, R7, R9 (generalised into a page multiplexer), R10,
  R12; the UI parts of [cmux] R3; the Console part of [comp] R1; D10.
- **Owned files.** `webui/src/lib/useEventStream.ts`, the multiplexer:
  - One EventSource per page over a reference-counted topic union. An SSE frame does not say
    which topic it came from (`realtime.py:141-154`), so the client routes each frame by its
    channel through a static `CHANNEL_TOPICS` table in `useEventStream.ts`: `inapp` to
    `notifications` and `inbox`; `job` to `jobs`; `chat.turn` and `chat.read` to `chat`;
    `case.changed` to `cases`; `case.activity` and `agent.step` to `cases:{id}`; `case.review` to
    `cases` and `cases:{id}`; `case.runbook` to `runbooks`; `case.investigation` to `cases`,
    `cases:{id}` and `investigations`; `message` and `overflow` to every hook.
  - A hook receives only the channels its topics can carry, and a `cases:{id}` hook only frames
    whose `data.case_id` matches, so the bell (which refreshes on any frame,
    `NotificationBell.tsx:123-129`) and the job monitor (`JobMonitor.tsx:257-266`) never see a
    `case.changed` or `agent.step` frame.
  - Frames are deduped by event id; the backend's `publish_many` (WP01) gives a frame published
    on several topics one id.
  - A union change is debounced (300 ms), reopens with `Last-Event-ID` and counts as a reconnect
    for reconciliation. The last unsubscribe closes the stream. The hook API is unchanged.
  `webui/src/lib/api-investigations.ts`; `webui/src/soc/investigations/**` (`store.ts` with
  `useSyncExternalStore`, keyed by case id, plus `newRuns` and `slots`; the WP01 stub bodies;
  `AiRunPopover.tsx`; a non-blocking `ReinvestigateDialog.tsx`);
  `webui/src/soc/pages/casedetail/ConfirmActionDialog.tsx` and `BulkCloseDialog.tsx` (each reads
  the investigation store for its `caseIds` prop, which WP01 added); `webui/src/soc/components/CaseActivityFeed.tsx` (the "Investigation
  finished" heading, cleared on the next `router` frame); `webui/src/soc/components/NavSidebar.tsx`
  (the Case Manager item, from the `investigations` topic, subscribed only for `cases:read`
  holders).
- **Two signals, two places.** The queue rows and the Case Manager navigation item already show
  the turning `ActivityGlyph` for case chat (`CaseManager.tsx:512, 521`, `NavSidebar.tsx:142-161`).
  `AiRunMark` replaces the status glyph inside the status node (or the outcome node) with the
  turning ring and the words "AI working" or "AI queued"; it never sits in the case-chat glyph
  slot before the age, so a row can show both. In the navigation, the Case Manager item keeps the
  chat glyph's meaning; the AI count is a separate numeric badge with its own `sr-only` text ("AI
  investigating N cases"), joined to the existing `nav-activity-case_manager` description, and
  the ring turns if either source is running.
- **Contracts.**
  - The [ai] §4.6 copy, with S2. Popover lines by trigger: "You started it" (the requester),
    "Started by <name>" (`users:manage` holders), "Started by a person" (others), "Started
    automatically", "Started by a background job", "Started when an investigation slot came
    free" (`drain`) and "Started by event detection" (`detection`).
  - Close and bulk-close warning: "An AI investigation is running on this case. When it finishes,
    its result replaces a close you make now." It never blocks the submit; after the run it turns
    into a "finished" note.
  - A 1 s hold-off before showing anything; reconciliation through the route on mount, reconnect
    and `overflow`; a client expiry at `deadline_at + 60 s`, then a re-read; a 5 s polling
    fallback while a run is known and the stream is not live.
  - Announcements polite, at most one per step change and one per 10 s. Reduced motion shows a
    static ring. Every popover has an accessible name (§3.6).
- **Bugs fixed.** None.
- **Tests.** The store reducer (frame, finish, expiry, reconcile); the QueueRow accessible name
  ", AI investigation running, started 40 seconds ago" (from `aiRunAccessibleText`); the chip
  timer and the popover for each of the five triggers and for the queued state; the dialog alert
  only for status-moving actions, turning into the finished note, submit enabled; the bulk count;
  the multiplexer (N hooks share one EventSource; a union change reopens with `Last-Event-ID`; the
  last unsubscribe closes it; a bell hook gets no `case.changed` frame; a `cases:{id}` hook gets no
  frame for another case; a frame on three topics reaches a union subscriber once); a row with case
  chat running and an AI run active shows both signals, and the navigation item shows the chat
  glyph and the AI count together; `bundle-first-paint`, with the multiplexer's delta reported.
- **Acceptance.** In a browser, Case Manager with a case open on Activity holds one EventSource
  per tab; the seeded Demo manual Reinvestigate flow works end to end with WP08, through the
  dialog WP03 mounted; the entry delta is reported.
- **Depends on.** WP01; live with WP08 (fakes until then).
- **Effort.** M to L.

#### WP10. Case numbers explained: backend (M to L)

- **Goal.** Every case-level number has recorded inputs, and its explanation agrees with it.
- **Implements.** [expl] R2 (record the inputs at the three `compute_risk` call sites with
  `reputation_source`; `_risk_calculation` prefers them with `weight_basis: recorded_at_scoring`;
  the wording that fixes D5), R3 (D-API-2, the gate on the DECISION audit row; `_decision_span`
  reports the recorded decision plus `current_policy` and `policy_changed`, which fixes D1, the
  same defect as [dv] DV-3 and R10), R6 backend (D-API-3, the SLA reading in `/triage` as `sla`,
  fixing D2 with WP11), R7 (`round_half_up` in the `routes_triage` headline and `displayed_score`),
  R16 (D7, and the triage route on `execution_prefs`), R10 (one Wilson in `engine/stats.py`); [dv]
  R4 backend (span kinds by `actor_type`: `person`, `chat`, `agent`, `system`; a bounded `detail`;
  exact per-call cost and latency with `cost_basis`) and R14 (`rows_total`, `truncated`, a lifetime
  usage window); the routing total in `explain_forwarding` ([comp] R3 backend); B13; B63.
- **Owned files.** `backend/app/api/routes_triage.py`; new `backend/app/engine/sla_reading.py`
  (calls WP15C's pure `metrics.sla_case_reading` and imports `_CaseTimings` and `_sla_priority`
  read-only; it re-derives no clock rule); `backend/app/engine/priority.py`; new
  `backend/app/engine/stats.py` (used by `threshold_tuner.py`, `engine/auto_close_review.py` and
  `agent_improvement.py`, each a one-call hunk); `backend/app/engine/forwarding.py`; tests.
- **Allowed hunks.** `backend/app/agents/pipeline.py`: the three `compute_risk` call sites (942,
  1415, 1564), the DECISION audit `tool_input`, and one line right after `apply()` that stamps
  `run_id` on the decision history entry (after WP08).
- **Contracts.**
  - **B13.** At each call site `explain_risk` runs beside `compute_risk` and its `RiskInputs` is
    stored as `breakdown.inputs`. `_risk_calculation` uses the recorded weights when present,
    otherwise today's current-weights path with its mismatch note; `routes_triage.py:704` passes
    `state.execution_prefs`. A case without inputs reports `not_recorded`.
  - **Read-time additions to `GET /api/cases/{id}/triage`** (it is `cases:read`-gated and builds
    its own response, so these never ride the stored case):
    - `asset_cidr`, for `settings:read` holders only: the CIDR of the current
      `prefs.asset_networks` entry that contains the stored `asset_value`, labelled "current
      configuration";
    - `auto_close_policy`: the `AutoClosePolicy` entry for the case's verdict class (the
      `policyForVerdict` rule of B27), so Case detail can state the policy without
      `GET /api/settings` (WP03).
  - **DECISION gate.** `tool_input.gate` is `{verdict, confidence, risk_score, class_enabled,
    min_confidence, max_risk_score, objection_window_minutes, escalation_confidence,
    critical_severity, outcome, demo}`, written after `apply()`. The `result_summary` stays
    byte-identical. Legacy rows read "re-derived with today's policy".
  - **Pairing the history entry with its gate.** One run writes several DECISION audit rows (the
    reinvestigate request, actor `reinvestigate`; the P1 no-change row, actor `pipeline`; the B05
    attach-only row; and the `case_manager` row, `pipeline.py:1242`), and `apply()`'s history
    entry carries no run id (`case_manager.py:182-189`). Right after `apply()`, the pipeline sets
    `case.history[-1]["run_id"] = current_investigation_run_id()` on the decision entry
    `apply()` just appended; `engine/case_manager.py` is unchanged.
  - **B63.** `_decision_span` (`routes_triage.py:393`) builds the span from the last
    `history` entry with `event == "decision"` (its `ts`, `rationale`, `status`, `decision_by`,
    `escalate`) and the stored `objection_window_expires_at`, marked `source: "recorded"`. It
    reads the gate from the `actor == "case_manager"` DECISION row whose `run_id` matches the
    entry's, and falls back to "re-derived with today's policy" when none matches. It calls
    `decide()` only when no decision entry exists, marked "re-derived with today's policy".
  - **SLA reading.** `{clock, start_at, anchor (created|acknowledged|status_history), responded_at,
    target_minutes, due_at, elapsed_minutes, state, priority, priority_source}`, consistent with
    WP15C's `sla_metrics`.
  - **Trace.** A span `detail` holds `tool_input` (16 KB, with a `truncated` flag), `query_text`,
    `tool_output_summary` (8 KB), `prompt_excerpt` (only with `prefs.trace.include_prompts`),
    `result_summary`, `outcome`, `run_id`, `app_version` and `build_sha`.
- **Bugs fixed.** B13 (the B62 Demo hunk is in WP15D), B63.
- **Tests.** The [expl] D1 reproduction fails before and passes after; the [dv] DV-3 policy-change
  scenario; the same case through `sla_reading` and `sla_metrics` agrees on breach; escalate then
  read shows the resolution clock; the SLA vectors; Wilson golden vectors over a grid pin each of
  the three old call sites' outputs exactly, before and after (the tuner keeps the unrounded lower
  bound; the review and effectiveness modules round to 4 dp at their call sites); the decision
  span pairs the right gate when a reinvestigate request row and a P1 row precede it; `asset_cidr`
  only for `settings:read`; `auto_close_policy` for each verdict class; person and chat span kinds;
  a 40 KB tool input comes back truncated;
  `include_prompts=false` hides the excerpt; 501 audit rows give `truncated`; an investigator
  prompt snapshot is unchanged; B13: score a 3-event cluster, attach 47 more, the stored inputs
  still say 3; the §3.6 guards.
- **Acceptance.** The [expl] risk 81.11 worked example reproduces from stored inputs; a legacy case
  reports `not_recorded`.
- **Depends on.** WP01, WP08 (merge after it on `pipeline.py`).
- **Effort.** M to L.

#### WP11. The Explain kit and the case explainers: Console (M)

- **Goal.** Hover any number for a one-line formula with real numbers; click for the full
  arithmetic.
- **Implements.** [expl] R1 (the primitive: a HoverCard per WCAG 1.4.13 with Escape, a Popover on
  click, Enter, Space and touch, "Copy calculation"), R2 UI (`RiskExplain`, from `RiskDerivation`
  extracted out of `StageTimeline`), R3 UI (`DecisionCard` shows the recorded decision and a
  "policy changed since" note; `DecisionExplain` shows the comparison table), R4 (D8, both
  auto-close conditions), R5 (the priority, impact, urgency and severity explainers, and D9), R6
  client (`caseFacts.slaReading` counts the same human status moves and formats the server
  reading; a "First event" fact from `first_seen_millis` with the per-case MTTD), R7 client (round
  half up; band the displayed integer), R10 UI (Wilson lines in the review and effectiveness
  modules; the D6 Tuning fix), R13 (the Cost KPI arithmetic); [dv] R9 (the precedent line); the
  [cmux] §5.7 small explainers; the [comp] R3 sentence ("Why was this investigated?"); B32; the
  B13 Console hunk.
- **Owned files.** `webui/src/design-system/explain/**` (a separate entry, never the barrel);
  `webui/src/lib/explain/**` builders (`risk`, `decision`, `priority`, `severity`, `sla`, `share`,
  `percentile`, `wilson`, `cost`, replacing WP01's `builders.ts` stub bodies) and
  `webui/src/lib/format.ts`; `casedetail/explain/**` (the stub
  bodies); `casedetail/DecisionCard.tsx`, `StageTimeline.tsx`, `SignalProfile.tsx`,
  `caseFacts.ts`; `webui/src/soc/components/badges.tsx` and `riskCopy.ts`; `pages/Tuning.tsx` and
  `pages/Cost.tsx`; `pages/effectiveness/AutoCloseReviewModule.tsx` and the Agent effectiveness
  quality popover.
- **Allowed hunks.** `webui/src/design-system/catalog.ts`: one `components` entry
  `feedback.explain` (module `@/design-system/explain`, the hover and click contract, the WCAG
  1.4.13 note). `docs/development/design-system.md` and `webui/src/design-system/README.md`: the
  subpath import paragraph, beside the `@/design-system/material` exception.
- **Contracts.**
  - **B13 Console.** `caseRiskFactors` and `riskFactorCaseReason` (`SignalProfile.tsx`, about line
    271) read count, span, rules, reputation and asset from `risk_breakdown.inputs`; without them
    they never pair `member_event_keys.length` with the Volume factor, and the member count shows
    only as "the case now holds N events; the score was computed from the events in its scoring
    run".
  - **B32.** `shortDuration` takes a rounding function; the "due in" line floors the time left, so
    it never claims more time than remains.
  - **B80 caption hunk.** In `StageTimeline` `StoryStep`, the trust marker "Untrusted source data"
    wraps as one unit instead of truncating (WP15F fixes `CodeBlock`).
- **Bugs fixed.** B32 (and the Console part of B13).
- **Tests.** Explain: hover line, click panel, Escape, touch tap, focus return, axe; the builders
  print the `explain.contract.json` vectors exactly; risk: the recorded-weight sum of the stored
  2-dp factors equals the score within 0.01, a legacy mismatch note, a case with no breakdown; decision: met and not met, NEEDS_HUMAN fixed by
  code, an analyst close "agrees"; the SLA vectors; Tuning shows "not recorded" instead of
  fabricated counts; the cost lines; first paint has no `explain` module in the entry; hostile
  strings render literally; B32 at 94 minutes reads "1h".
- **Acceptance.** The [expl] §3 hover line and click panel render exactly for the worked example;
  every number in the meta strip and the inspector has a trigger; row buttons carry the accessible
  name only.
- **Depends on.** WP01; WP10 for live data (fixtures until then).
- **Effort.** M.

#### WP12. Metrics explained (M to L; backend and Console)

- **Goal.** Dashboard numbers can be cross-checked against the cases behind them.
- **Implements.** [expl] R8 (`GET /api/metrics/explain?metric&window` for `mtta`, `mttr`, `dwell`,
  `mttd`, `active_risk_index`, `fp_rate` and `sla_attainment`, at most 200 samples, object scope per
  row), R9 (`mttr_by_decider`; the Analytics MTTR now equals the lifecycle p50 after WP15C's B59
  fix; the legacy field stays one release), R11 (arithmetic lines on the share tiles and on Alert
  reduction), D10 (agreement is `None` when nothing is graded; each panel names its population);
  [be] R2 layer 3 (a LIVE tick refreshes `getMetrics` at most once per 30 to 60 s); [comp] R5; B29,
  B64, B66, B67.
- **Owned files.** `backend/app/api/routes_metrics.py` (except WP15C's hunk);
  `webui/src/soc/pages/Overview.tsx`, `pages/Metrics.tsx`, `components/NoiseFunnel.tsx`,
  `components/KpiDrilldownPanel.tsx`, `components/MetricHoverTrend.tsx`,
  `dashboard/widgets/kpi.tsx`, `dashboard/widgets/lifecycle.tsx` and
  `dashboard/widgets/detection.tsx` (it holds `PARTIAL_COVERAGE_NOTE`, B64).
- **Allowed hunks.** `components/KpiTile.tsx` and `components/KpiStrip.tsx`: an optional explain
  slot prop only (both are shared by many pages, including WP11's Cost and Tuning and WP15E's
  Team activity).
  `backend/app/engine/metrics.py` (after WP15C): the explain samples, `mttr_by_decider` and the
  agreement population.
- **Contracts.**
  - **B29.** The drill-down "Source" column, its CSV and its facet use
    `source_name || source_id`; a `source_name` CSV column is added before `detection_source`.
  - **B64.** A Simple-view stage whose share mixes a counter parent with a case-tally stage reads
    "not measured: partial coverage" when `counters.incomplete` is true (the
    `PARTIAL_COVERAGE_NOTE` wording of `webui/src/soc/dashboard/widgets/detection.tsx`).
  - **B66.** The Respond sub-line and help say "First human acknowledgement, or a move to
    investigating, escalated or on hold"; assignment alone does not stop the clock; MTTD help says
    "Median (p50)".
  - **B67.** Latest cases labels `closed` "Closed" and `resolved` "Resolved".
- **Bugs fixed.** B29, B64, B66, B67.
- **Tests.** On a seeded population, the explain p50 equals the posture p50 for the window and the
  sample count equals the stat-block count; truncation markers; object scope filters samples;
  `mttr_by_decider` sums to the total; the Analytics MTTR equals the Overview p50; the tile lines
  show real counts; the LIVE cadence test; one test per bug.
- **Acceptance.** Each Overview KPI opens formula, numerator, denominator, window and a
  filtered-list link; MTTA, MTTR and dwell show p50, p90, mean and count, plus "Show all N".
- **Depends on.** WP01, WP15C, WP11's primitive (it can start on the stub API).
- **Effort.** M to L.

#### WP13. Case records reachable: backend (M)

- **Goal.** Every stored case record can be read by the people entitled to it, and only by them.
- **Implements.** [dv] R2 backend (`GET /api/cases/{id}/events` under `cases:read` and
  `sources:read`), R3 backend (`GET /api/cases/{id}/usage` under `cost:view`, with pipeline and chat
  totals and `reconciles`; the gateway writes the rate fields), R7 backend (IP indicators also
  return `providers`, `method` and `errors`), DV-6 (the docstring). [dv] R1 moved to WP15A.
- **Owned files.** New `backend/app/api/routes_case_events.py` and `routes_case_usage.py`;
  `backend/app/llm/gateway.py` and `llm/pricing.py` (expose the rates `cost_for` used without
  changing results); `backend/app/engine/threat_context.py` and the IP path of the enrichment
  dispatch; tests.
- **Contracts.** The events route reads through `fetch_by_ids` on the read-only client and keeps
  only `member_event_keys`; the envelope is `{available, reason: aged_out |
  push_source_not_retrievable | source_unavailable | null, returned, expected, truncated}`; limit
  1 to 200; one coalesced `case.events_viewed` row per viewer per case per 10 minutes. Usage stays
  exactly one UsageDoc per call (#6).
  - **Rate fields.** `price_basis` is one of `catalog` (the bundled price table or registry),
    `overlay` (an operator price override), `custom` (a registered self-hosted model, $0),
    `mock` and `demo_simulated`; `pricing_source` (`exact | heuristic | zero | default`) stays as
    it is. The four `*_rate_per_million` fields are the undiscounted per-million rates `cost_for`
    resolved for that call (`resolve_price` and `cache_rates`), and `cache_write_ttl` the TTL it
    used. The stored `batch` flag applies the 0.5 factor; `processing_tier` is recorded only
    (`cost_for` applies no Flex factor today). The recompute is exactly
    `round((prompt * in + completion * out + cache_read * read + cache_write * write) / 1e6 *
    (0.5 if batch else 1), 8)`, the `cost_for` formula (`llm/pricing.py:384-420`).
- **Bugs fixed.** None.
- **Tests.** Every `GET /api/cases/{case_id}/*` has a permission dependency; the events route keeps
  only member keys, answers `push_source_not_retrievable` and `aged_out`, and leaves HTML-looking
  values as strings; the pipeline total equals `token_cost` on a multi-run case; the recompute
  formula above over the stored rates equals the stored cost for a plain, a cached, a Batch and a
  Flex call, and each `price_basis`; 403 without `cost:view`; the IP and domain paths both return
  `providers`.
- **Acceptance.** No Console change needed for the backend contracts.
- **Depends on.** WP01.
- **Effort.** M.

#### WP14. Case records reachable: Console (M)

- **Goal.** "All data visible in some way": one click or hover from the case.
- **Implements.** [dv] R2 UI (the `CaseEvents` table; a side sheet with Table and JSON tabs, Copy
  and an NDJSON page download; "Open in Logs"; the signal event count links to the table), R3 UI
  (the `CaseUsageButton` popover, one row per call, the formula with that call's own numbers, a
  case chat footer), R4 UI (`TraceTimeline` Details, cost-basis labels, People and Chat filters,
  AI-only step counts), R5 (`FindingsList` "More" and "Cites N events"), R6 (`CaseHistory` shows
  status reasons, resolution notes and attach entries, plus a hold-reason fact), R7 UI (provider
  lines, "Checked when you opened this case" against "At investigation"), R8 (the full grading
  record), R11 (the `AllFieldsSheet`; `JsonTree` moves to `soc/components/JsonTree.tsx` with search,
  Copy and Download; cost withheld without `cost:view`), R13 UI (`AwaitingReason` from
  `/forwarding`), R15 (notifications "Show all", the lifetime retrieval markers); B30, B31.
- **Owned files.** `casedetail/records/**` (the stub bodies); `casedetail/files/**`;
  `webui/src/soc/components/TraceTimeline.tsx`; `casedetail/CaseHistory.tsx`, `grading.tsx`,
  `ThreatContextPanel.tsx`, `WhyPanel.tsx`; `webui/src/soc/components/audit/JsonTree.tsx` (moved and
  re-exported); `webui/src/soc/components/caseActivityText.ts`; new `webui/src/lib/api-case-records.ts`.
- **Contracts.**
  - **B30.** `activityText()` renders `file_attached ...` as "Screenshot added (PNG, 107 B)." and
    `file_deleted ...` as "Screenshot deleted.", keeping the recorded text under Details; audit
    summaries stay free of captions and filenames; the delete dialog's promise is kept (the
    gallery shows the deleted tombstone or the dialog no longer promises the caption).
  - **B31.** Files over the remaining room are listed as "not added. This case allows N
    screenshots." through `CaseFileUploader.skip`.
- **Bugs fixed.** B30, B31.
- **Tests.** The [dv] Vitest lists; a value `<img onerror>` renders literally; the JSON tab copies
  the exact record; the finding filter narrows the table; the usage formula numbers and the
  "estimated" badge; the Agent filter excludes person rows; B30 and B31.
- **Acceptance.** Every field [dv] §3 marks "Never" or "Partly" has a visible path, except the
  intentional ones; the checklist is recorded in §8.
- **Depends on.** WP01; WP13 and WP10 for live data.
- **Effort.** M.

#### WP15D. Demo Mode correctness (M; backend)

- **Goal.** The seeded Demo tells the truth: its numbers cross-check, its health is real and it
  never touches live data.
- **Owned files.** `backend/app/engine/demo_generator.py`, `backend/app/engine/demo_chat.py`,
  `backend/app/api/routes_rules.py` (`_read_recent_events`), `docs/getting-started/demo.md` (line
  46 and step 6), tests.
- **Allowed hunks.** `backend/app/state.py`: `_enable_demo_unlocked` (the seeding order and the
  seeded ledger rows).
- **Contracts.**
  - **B35 (with B47, B65).** The eager `demo_stack.rag_service.ensure_seeded()` (`state.py:3615`)
    moves after every seeded case and review is saved and before the `mutate_prefs` commit, fail
    open; the first projection includes the analyst-confirmed seeded cases.
  - **B48 (with B69).** The rng draw stays (determinism); each seeded case with `token_cost > 0`
    gets one UsageDoc in the Demo usage store: `role: investigator`, its `case_id`, `ts` its
    `created_at`, its cost, prompt tokens derived at the gateway's `_DEMO_IN_RATE`
    (`llm/gateway.py:361`), the WP01 rate fields and `price_basis: "demo_simulated"`. The demo
    docs say Demo spend is simulated.
  - **B61.** `_with_seeded_decision` appends the `analyst_action` history entry with the classified
    disposition for an analyst-closed case, as the live close writes.
  - **B62 (the Demo hunk of B13).** Each seeded case's breakdown comes from `compute_risk` and
    `explain_risk` over a synthetic cluster from the case's own entity, rules and member count, with
    a window from the case's own seeded Random (the main seed stream is unchanged), reputation only
    for IP entities and the Demo asset map, so asset criticality matches the impact chip.
    `case.risk_score = breakdown.total` at all three seeding sites (`demo_generator.py:1074, 1281,
    1320`). For IP entities the seeded reputation is solved (clamped to 0 to 100) toward the
    template's risk. The seeded decision stays coherent: `seeded_decision` re-runs `decide()` over
    `case.risk_score` (`demo_generator.py:850-860`) and writes the history decision entry from it
    (`:879-888`), so the synthetic member count and window are chosen within the template's ranges
    such that `seeded_decision(case).status` agrees with the templated status class (an agent
    close only where `decide()` closes).
  - **B34.** In Demo Mode, rule Test and preview reads the Demo sources through the shared
    `GET /api/logs` reader (`engine/log_rows`).
  - **B41.** Demo chat ranks open cases by risk for "needs attention" and "first" questions, unless
    the question names a status or sort.
- **Bugs fixed.** B34, B35 (with B47 and B65), B41, B48 (with B69), B61, and the B62 hunk.
- **Tests.** One regression per bug; enabling seeded Demo raises no agent-health alert; the Demo
  per-case cost equals its ledger rows; for every seeded case the breakdown reproduces from its
  inputs (volume, diversity, reputation and asset), `risk_score` equals `breakdown.total`, and
  `seeded_decision(case).status` agrees with the templated status class; the Demo determinism test
  (`test_demo_runbooks.py:124`) stays green.
- **Acceptance.** A fresh seeded Demo shows no "Agent health needs attention" banner, the Executive
  "Confirmed threats" counts the analyst true-positive closes, and every seeded risk popover
  reproduces.
- **Depends on.** WP01 (the rate fields and `RiskInputs`), WP15B; merges after WP08 (`state.py`).
- **Effort.** M.

#### WP15E. Console fixes: setup, settings and administration (M to L)

- **Goal.** Setup, Settings and administration pages do what they say.
- **Owned files.** `webui/src/soc/pages/Wizard.tsx` (except WP15F's skip-link hunk),
  `pages/Sources.tsx`, `pages/Approvals.tsx`, `pages/settings/data-export.tsx` (and the Job guards in
  `settings/storage.tsx`, the DangerZone reset and the Knowledge job buttons),
  `components/CustomizationSection.tsx`, `pages/Inbox.tsx`, `components/NotificationPrefs.tsx`,
  `pages/TeamActivity.tsx`, `pages/team/PersonSheet.tsx`, `pages/Roles.api.ts`, `pages/Roles.tsx`,
  `components/RoleMatrixEditor.tsx`, `components/RolePermissionSummary.tsx`,
  `backend/app/stores/user_prefs.py` (`resolve_effective_prefs`), tests.
- **Allowed hunks.** `webui/src/soc/router.tsx`: the `onHashChange` blocker (after WP03).
  `backend/app/api/routes.py`: `upsert_source`, `delete_source` and `set_source_secrets` (the Demo
  refusal). `backend/app/engine/threshold_automation.py`: line 449 only (after WP15B).
  `backend/app/config.py`: one `Preferences` after-validator for B45 (after WP15B).
  `components/CustomizationSection.tsx` is owned here; WP07's What's new switch row in it lands
  first.
- **Contracts.**
  - **B43.** Demo rows in the wizard's Data sources step show "Managed by Demo Mode" and no actions;
    the backend answers `409 source_demo_readonly` for a write to a Demo overlay id while Demo is
    active (real-source adds stay allowed).
  - **B46.** Make primary shows only for pull sources; success is toasted only when the response
    confirms it; otherwise "Only a pull source can be the primary source."
  - **B44.** A browser Back or a typed hash that leaves a page with an unsaved draft runs the same
    blocker as `navigate()`, restoring the committed hash with `history.pushState` first.
  - **B45.** Branding `default_theme` is the only organization theme default; Appearance shows a
    read-only line linking to it; `resolve_effective_prefs` stops letting the legacy
    `CustomizationConfig.default_theme` override Branding. One `Preferences` after-validator in
    `config.py` keeps an administrator's earlier choice: when `customization.default_theme` is not
    `system` and `branding.default_theme` is at its factory default, it copies the value into
    Branding and sets `customization.default_theme` to `system` in the same load, so the copy
    happens once and an administrator who later resets Branding does not get the legacy theme
    back.
  - **B36.** `threshold_automation.py:449` stops inventing 0.5; Approvals shows the confidence pill
    only for proposals an agent scored.
  - **B37.** A decided proposal shows a read-only footer (Approved, Acknowledged or Rejected, with
    the decider and time) and no expiry chip.
  - **B49.** Data export and the other Job submitters are disabled in Demo with "Data exports are
    not available in Demo Mode. Turn Demo Mode off to export."
  - **B53.** The Inbox Preferences sheet uses `size="xl"`.
  - **B56.** The person sheet's "Open in Audit log" carries the window's absolute bounds.
  - **B57.** One `RESOURCE_LABELS` map with a `resourceLabel()` fallback names every resource
    (`rag` "Knowledge corpus", `inapp` "In-app notifications", `data_export` "Data export",
    `system_updates` "System updates") everywhere the Roles and Users pages list them.
- **Bugs fixed.** B36, B37, B43, B44, B45, B46, B49, B53, B56, B57.
- **Tests.** One regression per bug; B43's backend 409 and unchanged `prefs.sources` after Demo off;
  B45's copy is idempotent (a second load changes nothing, and a Branding reset after the copy
  stays at the reset value).
- **Acceptance.** Every [bugs] reproduction for these ids flips.
- **Depends on.** WP01; part 2 also WP03 (router) and WP15B (threshold automation).
- **Effort.** M to L.

#### WP15F. Accessibility fixes (M; Console; merges late)

- **Goal.** The confirmed keyboard, focus, naming and reflow defects are fixed.
- **Owned files.** `webui/src/soc/components/DataTable.tsx`, `components/CodeBlock.tsx`,
  `webui/src/ui/table.tsx` (B78's `scrollLabel` prop),
  `components/CommandPalette.tsx`, `webui/src/ui/command.tsx`, `components/NotificationBell.tsx`,
  `components/audit/AuditTable.tsx`, `pages/Audit.tsx`, `pages/Runbooks.tsx`,
  `webui/src/soc/runbooks/editor/RunbookEditor.tsx`, `webui/src/ui/input.tsx` (if needed),
  `webui/src/soc/hooks/useElementWidth.ts` (moved from `chat/composer/`, re-exported), the popover
  name guard test, tests.
- **Allowed hunks.** `webui/src/soc/AppShell.tsx`: the skip link (about line 1425) and the phone
  navigation sheet (about lines 1442 and 1508). `webui/src/soc/pages/Wizard.tsx`: its skip link
  (about lines 503 to 508). `webui/src/styles/theme.css`: one coarse-pointer rule in `@layer base`.
  Any file with a `PopoverContent`: `aria-label` or `aria-labelledby` only (B75).
  `pages/effectiveness/AutoCloseReviewModule.tsx` (WP11) and `pages/team/PersonSheet.tsx` (WP15E):
  the `scrollLabel` prop only, and in `PersonSheet` the removal of its extra overflow wrapper so
  one focusable scroller remains (B78).
- **Contracts.**
  - **B71.** The skip links move focus to their target in code and never reach the hash router.
  - **B72.** The Audit table layout follows the list's measured width (phone below 816 px, medium
    below 992 px, wide above).
  - **B73.** The phone navigation sheet returns focus to the menu button on close, or to `#socMain`
    after a navigation.
  - **B74.** A sticky first column sets `scroll-padding-inline-start` to its measured right edge
    (WCAG technique C43).
  - **B75.** Every popover dialog has an accessible name (a visible heading by `aria-labelledby`,
    else an `aria-label` matching the trigger); the static guard of §3.6.
  - **B76.** The cmdk separator is `aria-hidden`.
  - **B77.** Opening a runbook or going back to the library focuses the heading once, as Dashboards
    does.
  - **B78.** `CodeBlock` becomes a focusable named region only when it overflows; `ui/table.tsx`
    gains an optional `scrollLabel` that makes its wrapper a focusable named region, passed at
    `AutoCloseReviewModule.tsx:149` and `PersonSheet.tsx:288`.
  - **B79.** Phone audit times wrap at the space instead of truncating.
  - **B80.** The `CodeBlock` caption wraps (`min-w-0 break-words`); WP11 does the `StageTimeline`
    caption.
  - **B81.** Under `(hover: none) and (pointer: coarse)`, text inputs, textareas and selects use
    `max(1rem, 16px)`; pinch zoom stays enabled.
- **Bugs fixed.** B71, B72, B73, B74, B75, B76, B77, B78, B79, B80, B81.
- **Tests.** One per bug, with axe rules where they apply (`aria-dialog-name`,
  `aria-required-children`, `scrollable-region-focusable`); the popover guard; B71 keeps
  `window.location.hash` unchanged from a Case Manager deep link.
- **Acceptance.** axe serious and critical counts on the swept routes are zero; B81 is verified on
  an iOS device by the maintainer (M6).
- **Depends on.** The feature packages that own the touched files merge first.
- **Effort.** M.

#### WP15G. Chat and local-model fixes (S to M)

- **Goal.** Chat exports and citations say what really happened, and a local model URL ending in
  `/v1` works.
- **Owned files.** `webui/src/soc/chat/report/model.ts`, `webui/src/soc/pages/Chat.tsx` (the delete
  dialog), `webui/src/soc/chat/stream-events.ts`, `webui/src/soc/chat/message/SourcesDisclosure.tsx`,
  `backend/app/llm/providers.py`, `webui/src/soc/pages/Models.tsx` (example URLs), tests.
- **Allowed hunks.** `backend/app/agents/chat_tools/cases.py`: the case citation (about line 938).
  `webui/src/lib/types.ts`: `ChatCitation.case_number`.
- **Contracts.**
  - **B38.** A conversation export names a log source only when a lookup read it (the server's
    `_scope_for` rule).
  - **B40.** "Its report stays in Reports" appears only when the conversation has a report.
  - **B42.** The citation chip shows `case_number` (display only; navigation uses `case_id`).
  - **[oss] B1.** `_make_openai_compatible` (`providers.py:1755`) and the custom `base_url` branch
    normalise one trailing `/v1` and slash; the stored URL stays as typed.
  - **[oss] B3.** The Models page examples use `host.docker.internal` inside Compose.
- **Bugs fixed.** B38, B40, B42 (plus [oss] B1 and B3).
- **Tests.** One per bug; an httpx `MockTransport` records `request.url.path` for `http://h/v1`,
  `http://h/v1/`, `http://h` and `http://h/openai/v1`, for both `complete` and `embed`; a gateway
  test: a custom model with a `/v1` URL produces one completion and one $0 UsageDoc.
- **Depends on.** WP01 (`Citation.case_number`).
- **Effort.** S to M.

### 4.6 Wave 2

#### WP16. Integration, entry budget and cross-cutting review (M)

- **Goal.** One tree in which the operator flows work together, inside every budget.
- **Mounts.** Swap the inline Reinvestigate dialog in `CaseDetail.tsx` for WP09's dialog; wire the
  hold-reason fact in the inspector, the events link on the signal count, and the trace People and
  Chat filters in `InvestigationPanel`.
- **Regeneration.** Every generated file on the merged tree (§3.9).
- **Budget.** Measure the entry; set `PRE_REVAMP_ENTRY_BYTES` to the merged measurement; assert
  `motion`, the Explain kit, the What's new page and dialog and the notes JSON are off the entry
  path.
- **Rollback lane.** The §3.7 plants.
- **Records.** Consolidate `ui-standard.md`.
- **Review.** The full gates, then a cross-cutting adversarial review of the integrated tree (the
  Round 15 practice): backend correctness and #3, security, statistics integrity, UI against the
  standard with screenshots, test honesty; each finding verified before it is fixed.
- **Browser checks** (Playwright 1.63, Chromium at `/opt/pw-browsers`, seeded Demo): the Case
  Manager geometry; one EventSource per tab; no timers on the sign-in page after paint; What's new
  on first sign-in only; the AI chip across a full Reinvestigate; the risk popover numbers; the
  `/docs/0.1/` redirect stubs.
- **Acceptance.** All gates green, the entry inside the ratcheted budget, zero unexplained console
  errors.
- **Effort.** M.

### 4.7 Wave 3

#### WP17. Screenshots and What's new content (M)

- **Goal.** The release tracker is documented and screenshotted.
- **Notes content.** Fill `docs/releases/notes/0.2.0.json` from the [wn] §6 backfill table, with
  ids `0.2.0.<date>`: dated updates from 2026-08-05 to the release, newest first, each titled by
  user-visible change, never "Round"; the 0.1.1 entry; the earlier records group. The newest
  update (this round) highlights the AI indicator, the segregated Case Manager, explainable numbers,
  the sign-in page, What's new and Communication, the six tabs with the Alt+2 and Alt+4 change, the
  license, and the administrator's repository step (D2). Update ids never change after WP17
  merges.
- **Capture.** Light and dark, from seeded Demo only, at 1440 by 900 and DPR 2, WebP at most
  250 KB with explicit dimensions and alt text; the §5.3 list.
- **Acceptance.** The generator passes; an upgraded account sees the newest update; the page
  renders every release.
- **Effort.** M.

#### WP18. Records and docs (M)

- **Goal.** Every record says what shipped.
- **Scope.** The CHANGELOG `[Unreleased]` Round 16 section from the package reports; the Help Center
  pages of §6.1; `docs/USAGE.md`; `AGENTS.md` §4 layout, §5 contract wording (§3.8), §10 (a Round 16
  bullet, the baseline, the Communication group, the router count, and the new process rule "every
  update that reaches users adds a What's new entry with screenshots, enforced by
  `check_version.py`"); `ROADMAP.md` (§7 of this SPEC); `docs/HANDOFF.md`; `Journal.md`; this SPEC's
  §8; the `testing.md` browser matrix rows ([rel] §5.3); the regenerated knowledge corpus.
- **Effort.** M.

#### WP19. Frozen release preparation and acceptance (M; release track)

- **Goal.** A candidate that becomes installable only after canonical runtime acceptance passes.
- **Records.** The CHANGELOG release section for 0.2.0 (the `[Unreleased]` content moved under the
  dated heading, a one-paragraph summary at the top, the 0.1.13 bootstrap correction as a "Legacy
  bootstrap correction" subsection) and a fresh `[Unreleased]` containing only `No changes yet.`;
  `docs/releases/0.2.0.md` per the [rel] §5.2 outline, under about 60,000 characters, with the
  seven markers; the other files of [rel] §5.3; the notes file `status: released` with the tag date.
- **Migration and rollback evidence.** Measure the `audit.id` widening at 1, 5 and 10 million rows
  ([rel] B4) and raise `--backend-timeout` to 900 in `release.yml` if 10 million rows exceed about
  200 s; document the large-table pre-step; rehearse the v0.1.1 rollback (§3.7) and record the
  result in `known-limitations.md`.
- **Receipts.** The local gates of [rel] §5.4 and the browser receipt of [rel] §6.
- **Effort.** M.

### 4.8 Waves and merge order

```
Opening (sequential): WP15A -> WP05 part 1 -> WP01
Wave 0 (parallel):    WP15B  WP15C  WP04  WP06  WP07 -> WP05 part 2   WP15E part 1   WP02  WP03 (L, critical)
Wave 1:               WP08 -> WP10   WP15D   WP13 -> WP14   WP09   WP11 -> WP12   WP15E part 2   WP15G   WP15F (last)
Wave 2:               WP16
Wave 3:               WP17   WP18   ->   WP19 (release track)
```

Merge order into `claude/round16`:

1. WP15A (security highs first).
2. WP05 part 1 (version 0.2.0).
3. WP01.
4. WP15B, then WP15C.
5. WP04, WP06 (independent).
6. WP07, then WP05 part 2 (the notes guard needs the skeleton).
7. WP15E part 1 (B43, B46).
8. WP08, then WP10 (shared `pipeline.py`); WP15D after WP08 (its `state.py` hunk follows
   WP08's).
9. WP13.
10. WP02, then WP03.
11. WP09, WP11, WP12, WP14, WP15E part 2, WP15G.
12. WP15F.
13. WP16.

WP03 is the longest package and starts first among the parallel ones. WP16 cannot start until WP03
lands.

### 4.9 Risks

- **Test churn in the Case Manager.** About 20 suites assert ids and structure. WP03 plans a
  dedicated test pass; no assertion is weakened except where its subject is removed.
- **The spine.** WP15B, WP08 and WP10 edit `pipeline.py` in that order. Every new keyword has a
  default, the registry never raises, and the case lock is taken only inside the signature lock.
- **The realtime client.** The multiplexer changes the transport of every live page; fake
  EventSource tests and a browser connection count gate it.
- **Security changes users will notice.** Denied roles now get 403 from eight case reads, the
  settings dump and the standup; flagged accounts must change their password before any other
  call; MFA locks after 10 failures; a password change signs out other sessions. These go in
  CHANGELOG and What's new.
- **Behaviour changes users will notice.** Reinvestigate updates a closed case in place; Alt+2 and
  Alt+4 change meaning; risk banding at exact .5 boundaries can move one band; the Analytics MTTR
  changes definition; agent-closed cases stop counting as late responses forever.
- **The Decision card.** It stops presenting a read-time re-run as the recorded decision; older
  cases show "thresholds not recorded".
- **Release identity.** Hosts whose `.env` keeps the old repository fail closed. That is correct
  but adds support load, so it is the first upgrade step in every record.
- **Version churn.** The 0.2.0 move touches many files; it lands second so every other package
  builds on it.
- **Single replica.** The registry, the gate and the SSE bus stay process-local; the route says
  `process_local: true`.

### 4.10 Ownership of shared files

| File | Owner | Other packages allowed a distinct hunk (merge order) |
|---|---|---|
| `backend/app/models.py` | WP01 | WP15A (`User` class; merges first) |
| `backend/app/realtime.py` | WP01 | none |
| `backend/app/audit/event_categories.json`, `webui/src/soc/components/audit/events.ts` | WP01 | WP15A (`auth.mfa_locked`; first) |
| `backend/app/utils.py` | WP01 (`round_half_up`) | WP15C (the ISO clamps) |
| `backend/app/agents/pipeline.py` | WP15B | WP08 (registry wrapper, keywords, lock), then WP10 (risk call sites, DECISION gate) |
| `backend/app/api/routes.py` | none (by region) | WP15A (auth, sessions, users, SSO, `get_settings`, `put_settings` guards, `account_activity`, the case read GETs); WP15C (`_millis_to_iso`); WP15E (source writes); WP08 (reinvestigate, investigate, `_case_view`, topic maps, case lock); WP07 (creation stamps) |
| `backend/app/api/routes_cases_collab.py` | WP15A (GET dependencies) | WP08 (writer locks) |
| `backend/app/api/routes_triage.py` | WP10 | none |
| `backend/app/api/routes_metrics.py` | WP12 | WP15C (breakdown `other`; first) |
| `backend/app/engine/metrics.py` | WP15C (`sla_metrics`, `compute_metrics`) | WP12 (explain samples, `mttr_by_decider`, agreement; after) |
| `backend/app/engine/threshold_automation.py` | WP15B | WP15E (line 449; after) |
| `backend/app/engine/demo_runtime.py` | WP08 | WP15B (`route_event_batch`; first) |
| `backend/app/engine/jobs.py`, `engine/poller_manager.py` | WP15B | WP08 (after) |
| `backend/app/state.py` | WP08 | WP15B (`cluster_for_case`, `_reenter_detections`; first), WP06 (loop-lag task), WP15D (`_enable_demo_unlocked`; after WP08) |
| `backend/app/config.py` | WP05 (`ReleaseUpdateConfig`) | WP15B (`widest_correlation_window_seconds`) |
| `backend/app/stores/base.py`, `stores/usage.py`, `stores/cases.py`, `stores/sql/repositories.py` | WP01 (`records_for_case`, `count_for_case`) | WP15B (`list_deferred_candidates`) |
| `backend/app/llm/gateway.py`, `llm/pricing.py` | WP13 | none |
| `backend/app/llm/providers.py` | WP15G | none |
| `backend/app/agents/chat_tools/cases.py` | WP15G (citation) | WP15C (shift snapshot item) |
| `scripts/check_version.py` | WP05 | none |
| `.github/workflows/ci.yml` | WP05 (action pins, identity) | WP07 (docs lane step) |
| `mkdocs.yml` | WP05 (URLs, version, release nav) | WP07 (What's new nav line), WP18 (new Help Center pages) |
| `CHANGELOG.md` | WP18 (`[Unreleased]` content) | WP05 part 1 (the two headings), WP19 (the frozen prep) |
| `webui/src/lib/useEventStream.ts` | WP09 | WP01 (the channel string; first) |
| `webui/src/lib/types.ts` | WP01 | WP15A (`ActivityEvent.event_label`), WP15G (`ChatCitation.case_number`) |
| `webui/src/soc/registry.tsx` | WP07 | WP15A (two `perm` fields; first) |
| `webui/src/soc/router.tsx` | WP03 (case-tab rewrite) | WP07 (`whats_new` keys), WP15E (hashchange blocker) |
| `webui/src/soc/App.tsx` | WP07 (gate, wizard stamp) | WP04 (`CenterSpinner`) |
| `webui/src/soc/AppShell.tsx` | WP07 (`ReleaseBadge` link) | WP15F (skip link, phone navigation focus) |
| `webui/src/soc/pages/Wizard.tsx` | WP15E | WP15F (skip link) |
| `webui/src/soc/pages/CaseManager.tsx` | WP02 | WP16 (final mounts) |
| `webui/src/soc/pages/CaseDetail.tsx`, `casedetail/*` | WP03 | exceptions: `DecisionCard.tsx`, `StageTimeline.tsx`, `SignalProfile.tsx`, `caseFacts.ts`, `explain/**` (WP11); `ConfirmActionDialog.tsx`, `BulkCloseDialog.tsx` (WP09); `CaseHistory.tsx`, `grading.tsx`, `ThreatContextPanel.tsx`, `WhyPanel.tsx`, `files/**`, `records/**` (WP14); WP16 final mounts |
| `webui/src/soc/pages/Overview.tsx`, `Metrics.tsx`, `components/NoiseFunnel.tsx`, `components/KpiDrilldownPanel.tsx` | WP12 | none |
| `webui/src/soc/pages/Login.tsx`, `components/auth/*` | WP04 | none |
| `webui/src/styles/theme.css` | WP04 (login block) | WP15F (one `@layer base` rule) |
| `webui/src/soc/pages/Docs.tsx` | WP05 | WP07 (helper move, `DOC_CATEGORIES` entry) |
| `docs/development/ui-standard.md` | WP16 (consolidation) | WP02 ("Queue and detail workspaces"), WP03 ("Case header", "Case tab bodies", G17), WP04 ("Identity surfaces", "Identity accents") |
| `webui/src/soc/__tests__/bundle-first-paint.test.ts` | WP16 (ratchet) | WP04 (eager-chain list), WP07 and WP11 (not-in-entry assertions) |
| `docs/USAGE.md` | WP18 | WP15A (auth passages), WP07 (group mentions) |
| `backend/app/knowledge/*`, generated files | regeneration only (§3.9) | every package regenerates; WP16 on the integrated tree |
| `AGENTS.md`, `HANDOFF.md`, `ROADMAP.md`, `Journal.md` | WP18 (Journal entries appended by the orchestrator per package report) | none |

### 4.11 Release track and maintainer actions

Owners: [A] an agent in this sandbox, [M] the maintainer on GitHub, [H] the maintainer on a Docker
host. Condensed from [rel] §4; that report holds the commands.

1. [A] The Round 16 pull request (WP15A to WP18) into `Testing`, with `CI passed` green on its head
   (D13's bumps ride in it).
2. [H or A] The `audit.id` widening timings and the v0.1.1 rollback rehearsal on PostgreSQL
   (WP19). The sandbox cannot pull images; Ubuntu `postgresql-16` and `postgresql-16-pgvector`
   packages are an untried fallback.
3. [A] WP19, the frozen prep pull request; then the browser receipt on the exact stamped build.
4. [H] Shipping-image acceptance; [A] a journal-only pull request. The resulting commit is the
   accepted candidate.
5. [M, H] Dress rehearsal in a disposable test repository (strongly recommended after seven failed
   or blocked tags).
6. [M] Tree-replacement promotion of the accepted candidate to `main`; the trees must be equal.
   [A] A Stable rebuild and the full matrix on `main`.
7. [M] The annotated tag `v0.2.0`, three workflows watched; never moved or reused.
8. [H] Canonical bootstrap from v0.1.1 on PostgreSQL Compose with
   `AGENTIC_SOC_UPDATE_REPOSITORY=ARYDESTROYER/Kavach-AgenticSOC` set first. Only then is v0.2.0
   installable. [A] Record it and bump `scripts/rollback_previous_release.json`.

Maintainer actions this SPEC depends on:

- **M1** Set the GitHub default branch back to `main` (D4), before tagging.
- **M2** Make the three new GHCR packages Public when the release workflow pauses at the
  anonymous-read step (irreversible; [rel] B2).
- **M3** Verify the `stable-release` and `github-pages` environment policies and the required
  `CI passed` check on `main` and `Testing`.
- **M4** Authorize the promotion and push the tag.
- **M5** Run the PostgreSQL timings, the v0.1.1 rollback rehearsal and the canonical bootstrap on
  a Docker host.
- **M6** Check B81 on an iOS device (focus on a text input does not zoom).

---

## 5. Verification

### 5.1 Tests per package

Offline tests for every rule each package introduces, listed under each package in §4. The
must-haves across the round:

- one regression per bug id that fails before its fix (75 fixes; the six merged ids are covered by
  their primary's test);
- the `explain_risk` property grid and the explain contract vectors on both ends;
- the §3.6 guards, including the `decide()` and `engine/risk.py` hashes;
- the GET route coverage rule;
- the investigation registry lifecycle, the exact frame key set and the Demo split;
- the six-tab deep links for every legacy id;
- the What's new decision table, the creation stamps and the generator `--check`;
- the version move: `check_version.py` on the branch and in simulated main and tag contexts, the
  docs bundle stubs, the plan builder's range;
- the rollback lane plants.

### 5.2 Gates (integrated tree)

`pytest -q` (record the count); ruff fatal; `npm run test:strict` (zero stderr); `npm run lint`;
`npm run gates` (with the D9 contrast pairs); `npm run check:types`; `npm run build` (docs plus app;
entry within the ratcheted budget); `npm run docs:check`; `scripts/check_docs.py`;
`scripts/build_app_knowledge.py --check`; `scripts/build_release_notes.py --check`;
`scripts/check_version.py` (and the tag-context dry run); `scripts/check_ci_contract.py`; the docs
bundle and theme tests; `python3 -m unittest discover -s updater/tests -v`;
`bash -n scripts/bootstrap-updater.sh scripts/run-demo.sh scripts/agentic-soc-compose.sh`;
`python3 -m unittest scripts.test_rollback_lane -v`; `sha256sum deploy/docker-compose.agnostic.yml`
equals `deploy/update-base-v1.sha256`.

### 5.3 Screenshots (light and dark, seeded Demo, 1440 by 900 unless stated)

1. Case Manager queue with an AI-working row mark and the band notice.
2. Case header with the AI chip and its popover open ("You started it").
3. Brief tab: Next step row and the four lanes.
4. Evidence tab with the events table and its side sheet.
5. AI investigation tab with the trace and an expanded step detail.
6. Response tab (tasks and a runbook run).
7. Activity tab (discussion, files, history with status reasons).
8. The close dialog with the AI-running warning.
9. Risk explain: the hover line and the click panel for one case.
10. Decision explain with "policy changed since".
11. The inspector with the "View all fields" sheet open.
12. The usage popover with per-call formulas.
13. Sign-in: username step, password step with "Remember me", MFA step, an SSO error sentence;
    plus the same at 390 by 844.
14. The What's new dialog after sign-in.
15. Communication, What's new page with the version rail.
16. The navigation with the Communication group open and the Case Manager AI count.
17. An Overview KPI explain panel and the Metrics explain samples.
18. The Inbox item for a finished manual run.
19. Case detail at 390 by 844.

Docs screenshots in `docs/assets/screenshots/` are refreshed where the surface changed (Case
Manager, sign-in, first run); release screenshots live in `docs/assets/releases/0.2.0/`.

### 5.4 Browser checks

The WP16 list, then the full [rel] §6 receipt on the stamped build in WP19 (routes from
`console_map.json` and the aliases, 1440 by 900 and 390 by 844, Light, Dark and System, axe serious
and critical zero, no horizontal overflow, no unexplained console errors), with the [rel] §6.4
limits stated in the receipt.

---

## 6. Documentation

### 6.1 Help Center pages

- New: `docs/releases/whats-new.md` (generated, WP07); `docs/releases/0.2.md` and `0.2.0.md`
  (WP05, WP19); `docs/analyst/explainable-numbers.md` (WP18: how to read the hover line and the
  panel, risk inputs, the decision gate, SLA, rounding, "not recorded"), with a `mkdocs.yml` nav
  line under the analyst guide.
- Changed: `docs/analyst/case-manager.md` (header, six tabs, inspector, the AI indicator, close
  during a run), `investigation.md`, `cases.md`, `collaboration.md`, `overview.md`, `analytics.md`,
  `kpi-glossary.md`; `docs/getting-started/first-run.md` (the sign-in page), `demo.md` (simulated
  spend), `install.md`, `quickstart.md`; `docs/administration/authentication.md` (forced change,
  MFA lockout, sessions after a password change, refresh honesty, SSO linking),
  `users-rbac.md` (the new read gates), `customization.md` (one theme default),
  `notifications.md` (the Communication group); `docs/concepts/deterministic-decisions.md` (the
  recorded gate, inputs recorded beside the score), `state-audit-cost.md` (the usage rate fields);
  `docs/reference/api.md` (new routes, `wait=false`, 409s, deprecations), `permissions.md`,
  `configuration.md`; `docs/operations/upgrades.md` (the repository step, the column widening,
  rollback notes); `docs/releases/channels.md`, `documentation-versions.md`, `known-limitations.md`,
  `0.1.md`, `0.1.13.md`; `docs/index.md`.

### 6.2 Repository docs

`README.md` (license, version), `INSTALL.md`, `DEPLOY.md`, `SECURITY.md`, `DEMO.md`, `.env.example`,
`COMPATIBILITY.md`, `docs/USAGE.md`, `AGENTS.md`, `docs/HANDOFF.md`, `CHANGELOG.md`, `Journal.md`,
`ROADMAP.md` (§7 items), `docs/development/testing.md`, `docs/development/ui-standard.md`.

### 6.3 Release records for 0.2.0

- `CHANGELOG.md`: the round's entries under `[Unreleased]`; at WP19 the dated `## [0.2.0]` section
  with its summary and the folded 0.1.13 correction, and a fresh `[Unreleased]`.
- `docs/releases/0.2.0.md`: the GitHub Release body ([rel] §5.2 outline; under about 60,000
  characters; no embedded images; links to What's new).
- `docs/releases/0.2.md`: the 0.2 line page.
- `docs/releases/notes/0.2.0.json` and `docs/assets/releases/0.2.0/`: What's new.
- `docs/releases/known-limitations.md`: the new limits (process-local registry, Chat as a sixth
  tab, the rollback losses of §3.7, the column widening, the v0.1.1 rehearsal result, the identity
  change).
- `docs/research/2026-11-round16/acceptance/`: the browser receipt (excluded from the Help Center
  by `exclude_docs: research/`).

### 6.4 Amendments to earlier documents

- Round 14 SPEC D3 (the Remember me hint): reversed for the row; the warning dialog is the
  disclosure (D6).
- `docs/development/ui-standard.md` "Identity surfaces" and "Identity accents": replaced (D9);
  "Queue and detail workspaces", "Case header", "Case tab bodies" and G17: rewritten for D8 and
  WP02, WP03.
- Round 15 SPEC §2.8 (five case tabs, the facts rail): superseded by D8 and the inspector.
- The registry comments that keep `GET /api/llm/models` auth-only: superseded by §2.3.
- `ROADMAP.md` section I "Re-investigation keeps person-made case state": the link fields are
  carried (B09); the remaining campaign note is closed (no case writer).
- `AGENTS.md` §5 "This is an additive 0.1.13 contract" and the other current-version sentences:
  reworded for 0.2.0 (§3.8).

---

## 7. Not built this round (backlog, ranked by value for a free agentic SOC)

| Rank | Item | Value | Effort | Source |
|---|---|---|---|---|
| 1 | A free local-model path from install to the first verdict | high | M | [oss] R3, [be] R15 |
| 2 | One-command install, `doctor`, measured resource figures, a lite SQLite profile, a container demo and a devcontainer | high | M | [oss] R5, R15 |
| 3 | Source presets for the free stacks (Elastic Security alerts, Security Onion, OpenSearch Security Analytics, Graylog, Wazuh push, Suricata EVE, Zeek, osquery), the Wazuh Integrator push script, an inverted severity ladder, and a "free SOC stack in an afternoon" guide | high | M | [oss] R6, R10 |
| 4 | Restart-safe per-source secrets: document and forward `CONNECTOR_SECRETS` with a missing-secret banner, then opt-in sealed KV persistence after a security review | high | S then M | [oss] R4, B2, B5 |
| 5 | No-loss push: answer HTTP push before investigating, then a durable push receipt with a dead-letter ring | high | M then L | [be] R10, R11 |
| 6 | Teach the agent from a close: pending, scoped, expiring memory with origin case and usage counts, plus per-step and per-summary feedback | high | M | [comp] R8, R9 |
| 7 | Offline threat intel: MISP warninglists, public MISP feeds, TAXII 2.1 and OpenCTI, and a MISP server, into a bounded KV IOC store | high | M to L | [oss] R7 |
| 8 | Hand-off to DFIR-IRIS (and TheHive), plus a STIX 2.1 case export | high | M | [oss] R8 |
| 9 | Ask AI beside the evidence: case chat in the inspector, which brings the tabs back to five | medium to high | M to L | [cmux] R6 |
| 10 | Sigma: metadata import with DRL attribution, then a matcher, with a precompiled rule catalog first | medium to high | M then L | [oss] R9, [be] R14, R6 |
| 11 | Approval-gated response actions and a per-case Resolution Center, with a separate write credential and never model-driven | high | L | [comp] R11 |
| 12 | A read-only MCP server and scoped, revocable API keys (resolve the `ROADMAP.md` C versus G contradiction first) | medium to high | L | [comp] R12, [oss] R14, [be] R19 |
| 13 | New pull connectors: Splunk, then Microsoft Graph `alerts_v2`, then CrowdStrike | high for adoption | M each | [be] R13 |
| 14 | SQL queue projection and filter push-down (0.65 to 2.5 s per filtered view at 20,000 cases today) | medium to high | M | [be] R3 |
| 15 | A global pause and resume of AI investigations; autonomy per rule with an optional settle delay; stopping one run | medium | S to M | [comp] R10, R15, [ai] R15 |
| 16 | Field anonymization before the model, with a reversible per-investigation map | high for regulated users | M to L | [comp] R14 |
| 17 | A push-source evidence snapshot in KV, bounded and with a retention setting | medium | L | [dv] R12 |
| 18 | Observability export (Prometheus text, JSON logs, optional OTEL) and a one-command backup and restore | medium to high | S to M each | [be] R16, R17 |
| 19 | An attack storyline on campaigns; CVE context (CISA KEV, EPSS); a model leaderboard from replay; scheduled digests and ticketing; a PDF case report | medium | M each (PDF S) | [comp] R13, R16, R17, R18, [oss] R11 |
| 20 | Community runbook packs, a Cortex bridge provider, passkeys, administrator announcements in Communication | medium | M to L | [oss] R12, R13, [login] R16, [wn] R12 |
| 21 | Platform depth: versioned SQL migrations, a multi-replica leader lease (including the investigation registry, [ai] R14), cross-process signature claims, SBOM attestation | medium now, high at scale | M to L | [be] R12, R18, [rel] R16 |
| 22 | Install history and server eligibility for What's new (`release_history` KV), only if D7's creation stamp proves insufficient | low | S to M | [wn] R5 |
| 23 | Decide whether people with `sources:read` see real member event ids in the clustering diagram (reverses an earlier #9 decision) | low | S | [dv] R16 |
| 24 | Explainability follow-ups: Standup urgency terms, campaign entity links, the anomaly detection signal on anomaly-born cases | low to medium | M | [expl] R15 |
| 25 | Stretch items not taken: HTTP push answered before investigating, the audit `run_id` filter, condense on scroll | medium | S to M | [be] R10, [ai] R13, [cmux] §5.3 |

What not to copy ([comp] §5): model-written lessons placed in trusted context; autonomous response
by default; browser recording of analysts; vendor-style headline accuracy figures; per-alert pricing
logic.

---

## 8. As built

Placeholder. WP18 records here, from the package reports, their reviews, the Journal and the code
as built: the contract resolutions, per-package notes, the [dv] §3 field checklist (WP14), the
entry ratchet (WP16), known limitations, and the verification record (counts, gates, receipts).
Where this section and §1 to §7 disagree, this section wins.

### 8.1 Contract resolutions

To be written.

### 8.2 Per package

To be written.

### 8.3 Known limitations

To be written.

### 8.4 Verification record

To be written.

---

## Appendix A. Bug allocation

Every confirmed bug, in the order of `review/bug-hunt.md`. A merged bug is fixed by its primary's
change and tested by its primary's regression test.

| Id | Severity | Area | Title | Owning package | Merged into |
|---|---|---|---|---|---|
| B01 | medium | RBAC: case and settings reads | Older case and settings GET routes skip their read grant, so a role denied cases:read still gets case data | WP15A | - |
| B02 | low | API validation: relative windows | An out-of-range relative window on /api/cases and /api/scans/notifications answers 500 | WP15C | - |
| B03 | low | Chat feedback summary time filter | GET /api/chat/feedback/summary compares `since` as text, so a since value with a zone offset filters the wrong ratings | WP15C | - |
| B04 | high | Pipeline re-entry on a decided case (#3, #4) | register_candidate on a signature whose open case is already decided wipes the verdict and decision, then the follow-up investigate re-bills and can re-decide (auto-close) it | WP15B | - |
| B05 | high | Ingest overrides a person's move | The agent auto-closes an un-investigated candidate that a person escalated, acknowledged or put on hold, on the next tick that carries a new event | WP15B | - |
| B06 | high | Drain and job risk input | state.cluster_for_case (used by the deferred-candidate drain and the bulk reinvestigate job) fabricates member timestamps and rules, inflating risk and changing decide()'s outcome; aged-out pull cases fail in the job but not in the route | WP15B | - |
| B07 | medium | Correlation look-back windows | The correlation look-back ignores rule-catalog (Rules editor) correlation windows, so a configured threshold over a longer window can never fire | WP15B | - |
| B08 | medium | Automation lost update | Post-decision threshold automation saves a stale in-memory case after awaiting notification I/O, overwriting a person's concurrent work | WP15B | - |
| B09 | medium | Rebuild carry-over | Every rebuild of a case drops related_case_ids, cross_source_cluster_id, source_breakdown and automation_actions | WP15B | - |
| B10 | medium | Pipeline failure path duplicate (#4) | A transient case-store read failure at the start of a run mints a second open case for the same signature (#4) | WP15B | - |
| B11 | medium | Deferred drain scale (#4) | The deferred-candidate drain re-scans every OPEN case each tick, and on Elasticsearch it can never reach candidates past the first 10,000 | WP15B | - |
| B12 | low | Failed-run cost (#6 presentation) | A failed run resets the case's token_cost to $0 and drops the run's partial spend | WP15B | - |
| B13 | medium | Risk inputs not recorded | The risk score cannot be cross-verified: the factor inputs are not stored, and the Console pairs the post-attach member count with a volume factor computed from a different count | WP10 | - |
| B14 | low | Bulk reinvestigate job result | A bulk reinvestigate job reports an item as succeeded when the investigation failed | WP15B | - |
| B15 | high | SSO mints a Super admin | A settings:manage holder can mint a stored Super admin through SSO, bypassing the Round 15 Super-admin-only boundary | WP15A | - |
| B16 | high | SSO cross-provider linking | SSO links any account provisioned by another provider when the email matches (cross-provider account takeover, Super admins included) | WP15A | - |
| B17 | medium | MFA enrolment replacement | An existing MFA factor can be replaced from a bare session without proving the old factor or re-authenticating | WP15A | - |
| B18 | medium | Password hashing on the event loop | Password hashing runs on the event loop: unauthenticated logins and wrong MFA codes stall every request | WP15A | - |
| B19 | medium | MFA attempt bound | MFA verification has no attempt bound, and a pending token stays reusable for its whole 5 minutes | WP15A | - |
| B20 | medium | Forced password change | must_change_password is not enforced by the server, and the seeded Admin/Admin@123 is not even flagged (contradicts USAGE.md) | WP15A | - |
| B21 | low | Sessions after a password change | Changing or resetting a password leaves every existing session signed in | WP15A | - |
| B22 | low | Session IP from a forwarded header | The session registry records a client-chosen IP (first X-Forwarded-For entry) in the session list and new-device notices | WP15A | - |
| B23 | low | MFA code single use | A recovery code or TOTP code can be redeemed twice by concurrent requests | WP15A | - |
| B24 | low | Refresh-token rotation unreachable | Refresh-token rotation is never reachable: no sign-in issues a refresh token | WP15A | - |
| B25 | low | Sign-in SSO error text | The sign-in page shows arbitrary attacker text from ?sso_error= | WP04 | - |
| B26 | high | SLA response clock on auto-closed cases | SLA response clock keeps running on cases the agent closed, so every auto-close eventually counts as a permanent SLA breach | WP15C | - |
| B27 | high | Case auto-close policy text | Case detail reads the deprecated prefs.fp_auto_close, so the facts rail and Investigation tab state the wrong auto-close policy | WP03 | - |
| B28 | medium | Take action menu items | Take action → Change owner and Edit tags open and immediately close (dead menu items) | WP03 | - |
| B29 | low | KPI drill-down Source column | KPI drill-down 'Source' column (and CSV) is blank for every alert-sourced case | WP12 | - |
| B30 | low | Screenshot history text | Deleting or adding a screenshot writes raw machine text to case history, without the caption or filename the dialog promises | WP14 | - |
| B31 | low | Screenshot upload over the limit | Choosing more screenshots than the remaining room silently drops the extras | WP14 | - |
| B32 | low | SLA countdown rounding | SLA countdown rounds to the nearest hour or day, overstating the time left | WP11 | - |
| B33 | high | LEEF push event ids | LEEF push events of the same event type collapse to one id, so distinct events are dropped | WP15B | - |
| B34 | medium | Rule preview in Demo Mode | Rule 'Test and preview' ignores Demo Mode: it reads the real tenant sources | WP15D | - |
| B35 | medium | Demo precedent corpus alarm | Seeded Demo raises two CRITICAL agent-health alerts because the demo precedent corpus is never projected | WP15D | - |
| B36 | low | Approvals invented confidence | Automation proposals show a made-up '50% confidence' labelled as the agent's confidence | WP15E | - |
| B37 | low | Approvals decided card | An approved proposal shows a 'Retry approval' button and still says 'Expires in 1mo' | WP15E | - |
| B38 | low | Chat export sources | Conversation export claims 'Sources queried: Splunk…' for answers that queried no log source | WP15G | - |
| B39 | low | Shift brief created time | Shift-brief 'Needs attention' list has no created time, so its 'Created (UTC)' export column is always blank | WP15C | - |
| B40 | low | Chat delete dialog text | 'Delete conversation?' always says 'Its report stays in Reports', even with no report | WP15G | - |
| B41 | low | Demo chat attention question | Demo chat answers a free-text 'need attention first' question with closed, low-risk false positives | WP15D | - |
| B42 | low | Chat citation case number | Chat citation chip shows the internal case id instead of the case number | WP15G | - |
| B43 | high | Wizard writes Demo sources | Setup wizard in Demo Mode writes demo sources into the live source configuration (Make primary / Edit) | WP15E | - |
| B44 | medium | Settings draft lost on Back | Browser Back (or a typed hash) silently discards an unsaved Settings draft | WP15E | - |
| B45 | medium | Two default theme controls | Two 'organization default theme' controls store different values and show contradictory state | WP15E | - |
| B46 | medium | Make primary on a push source | Make primary on a push/queue source reports success but the server silently drops it | WP15E | - |
| B47 | medium | Demo agent health alarm | Fresh Demo Mode raises two Critical 'agent health' alarms (precedent corpus starved) on the bell and Effectiveness | WP15D | B35 |
| B48 | low | Demo cost without ledger rows | Demo cost data is incoherent: cases carry AI spend the cost ledger never records, and the simulated rate contradicts the model price | WP15D | - |
| B49 | low | Data export in Demo Mode | Data export 'Build ZIP in background' is enabled in Demo Mode and fails with a raw 409 | WP15E | - |
| B50 | low | Branding default accents | Branding editor shows wrong default accents (violet/teal) while the Console's real defaults are blue/indigo | WP04 | - |
| B51 | low | Settings coherence validation | Settings accepts incoherent or unparseable values without validation (SLA respond > resolve, unknown timezone, free-text lookback) | WP15A | - |
| B52 | low | Update control off PostgreSQL | Top bar offers 'Enable updates' on deployments that can never enable one-click updates | WP05 | - |
| B53 | low | Inbox preferences width | Notification preferences table is clipped at 1440 px (Telegram column cut off) | WP15E | - |
| B54 | low | Help Center Stable link | Help Center says the Stable site does not exist yet, though Stable documentation was published | WP05 | - |
| B55 | low | Sessions activity labels | Sessions > Activity shows raw event ids ('User.deleted', 'Auth.login', 'Team.viewed') | WP15A | - |
| B56 | low | Team person sheet audit link | Team activity person sheet 'Open in Audit log' drops the window | WP15E | - |
| B57 | low | Permission resource names | Permission resource names shown as raw tokens ('Rag', 'Inapp') | WP15E | - |
| B58 | high | SLA attainment falls over time | SLA response clock never stops for agent auto-closed cases, so SLA attainment falls over time with no change to any case | WP15C | B26 |
| B59 | high | Operational MTTR | Metrics > Operational MTTR uses updated_at − created_at over 'closed' only, so any later edit inflates it (10m to 6h 41m after one comment) | WP15C | - |
| B60 | medium | Standup SLA aging | Standup and SOC operations 'SLA breached' use the unpersisted priority_level (always 120-min default, 'unprioritized') and ignore acknowledgement | WP15C | - |
| B61 | medium | Demo analyst classification | Demo seed: analyst closes carry no classification entry, so 17 human true-positive closes read 'Outcome not recorded' and Executive 'Confirmed threats' shows 1 | WP15D | - |
| B62 | medium | Demo risk factors | Demo risk factors do not reproduce from the case's own inputs (same Volume 72 for 3 and 6 alerts; asset criticality 47 while the impact chip says 0) | WP15D (Demo hunk of B13) | B13 |
| B63 | medium | Timeline decision stage | Timeline 'Decision' stage takes its time from updated_at and re-derives the decision from today's policy instead of the recorded decision | WP10 | - |
| B64 | medium | Noise flow share | Overview noise flow prints 'Cases opened 56 · 147%' of clusters when the alert counters cover only part of the window | WP12 | - |
| B65 | medium | Demo health banner | Demo precedent corpus is seeded before the demo cases exist, so every page shows a false 'Agent health needs attention' banner | WP15D | B35 |
| B66 | low | Overview Respond copy | Overview 'Respond' copy says assignment counts and calls the p50 a mean, but the clock ignores assignment | WP12 | - |
| B67 | low | Overview closed label | Overview Latest cases labels status 'closed' as 'Resolved' | WP12 | - |
| B68 | low | Top rules 'more' count | Top detection rules 'N more rules' counts rules with zero cases in the window | WP15C | - |
| B69 | low | Demo case cost | Demo per-case 'Investigation cost' has no ledger rows behind it | WP15D | B48 |
| B70 | low | Case read routes | Case rationale, trace and export routes skip the cases:read check (outside the data-correctness area) | WP15A | B01 |
| B71 | high | Skip link | The "Skip to main content" link takes keyboard users away from the page they are on, to Overview | WP15F | - |
| B72 | medium | Audit list reflow | Audit log list cuts off the Actor and Summary columns between 640 and about 1000 px; the page scrolls sideways near 768 px | WP15F | - |
| B73 | medium | Phone navigation focus | The phone navigation sheet drops focus to <body> when it closes, and after picking a destination | WP15F | - |
| B74 | medium | Sticky column hides focus | A sticky first column hides the focused control in DataTable on phones (WCAG 2.2 SC 2.4.11) | WP15F | - |
| B75 | low | Popover dialog names | Popover dialogs have no accessible name (axe aria-dialog-name, serious) | WP15F | - |
| B76 | low | Palette separators | The command palette listbox contains role=separator children (axe aria-required-children, critical) | WP15F | - |
| B77 | low | Runbooks focus | Opening a runbook, or going back to the library, leaves focus on <body> with no announcement | WP15F | - |
| B78 | low | Scroll region focus | Scroll regions with no focusable content: CodeBlock pre and the bare table wrapper (axe scrollable-region-focusable) | WP15F | - |
| B79 | low | Phone audit time | Phone Audit list cuts every timestamp's seconds ("24 Nov 20:57:…") | WP15F | - |
| B80 | low | Untrusted caption clipped | Case evidence caption "Untrusted source data" is clipped mid-word with no ellipsis at 390 and 768 | WP15F | - |
| B81 | low | Phone input zoom | Phone text inputs are 13 px, which triggers iOS Safari's zoom on focus (not reproduced: no WebKit here) | WP15F | - |

Per package: WP15A 13 fixes (plus B70 merged), WP15B 11, WP15C 7 (plus B58), WP15D 5 (plus B47,
B65, B69 and the B62 hunk), WP15E 10, WP15F 11, WP15G 3, WP03 2, WP04 2, WP05 2, WP10 2, WP11 1,
WP12 4, WP14 2. Total 75 fixes and 6 merged ids, 81 ids.

## Appendix B. Traceability (research recommendation to package)

| Report | In Round 16 | Backlog or later (§7) |
|---|---|---|
| ai-investigating | R1 to R5, R8, R11 (WP08); R3 UI, R6, R7, R9, R10, R12 (WP09); R13 optional (WP08) | R14 (cross-replica lease), R15 (stop a run) |
| case-manager-ux | R1 (WP02, WP03); R2 explainers (WP11); R3 UI parts (WP09, strip replaced by the chip, S1); R4, R5, R8 (WP03); R7 (WP02) | R6 (Ask AI in the inspector) |
| explainability | R1 to R7, R10, R13, R16 (WP10, WP11); R8, R9, R11 (WP12); R12 (WP14 `AllFieldsSheet`); R14 partly (rates in WP13); the eight drift defects (WP10, WP11, WP12, WP15C) | R15 |
| data-visibility | R1 (WP15A); R2, R3, R7 backend (WP13); R2 to R8, R11, R13, R15 UI (WP14); R4 backend, R10, R14 (WP10); R9 (WP11) | R12, R16 |
| login | R1 to R12, R14 (WP04); R15 optional (WP04) | R16 (passkeys) |
| whats-new | R1 to R4, R6, R8, R9 (WP07); R7 (WP17); R10 (WP05); R11 optional (WP07) | R5 (replaced by D7's creation stamp), R12 (announcements) |
| release | R1, R2, R7, R9, R11, R14, R15, R17 (WP05); R3 to R6, R10, R12 (WP19 and §4.11); R8 maintainer (M1); R13 replaced by the What's new design (S4) | R16 (SBOM) |
| backend-roadmap | R1, R2 layer 1, R4, R5 (WP06); R2 layer 3 (WP12); R7 (WP08); R8 (WP01, WP10); R9 superseded (WP07) | R3, R6, R10 to R19 |
| competitors | R1 (WP08, WP09); R2 (WP01, WP10, WP11); R3 (WP10, WP11, WP14); R4 (WP03); R5 (WP12); R6 (WP07); R7 (D3, WP05) | R8 to R18 |
| oss-ecosystem | R1 (D3, WP05); R2 with B1, and B3 (WP15G) | R3 to R15, B2, B4, B5 |
| bug hunt | B01 to B81 (Appendix A) | none |
