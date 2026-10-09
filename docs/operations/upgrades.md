---
title: Upgrades and promotion
description: Promote Agentic SOC from Testing to Stable/main and upgrade versioned deployments safely.
---

# Upgrades and promotion

Agentic SOC's intended release contract uses two permanent branches:

```text
feature branches → Testing → main (Stable)
```

`Testing` is the integration and acceptance branch. `main` is the supported Stable
branch. The current source candidate is represented as `0.1.13` in packages/images
and becomes Stable only if the immutable `v0.1.13` tag and its complete signed/public
artifact set pass every publication and canonical runtime acceptance gate; its
documentation line remains `0.1`.

!!! note "Canonical topology and administrative controls"

    The remote now uses `Testing` for integration and default `main` for accepted
    Stable source. Version 0.1.13 is Stable only when the exact verified `main`
    commit has the immutable `v0.1.13` tag, matching signed/public artifacts, and
    completed canonical runtime acceptance.
    Pull-request protections,
    required checks, and release-environment policy are repository settings rather
    than source-code guarantees. Administrators must verify them independently;
    branch and tag names alone do not prove acceptance.

    The immutable `v0.1.4` and `v0.1.5` tags are failed, non-installable publication
    attempts. Neither has the canonical signed plan and public GitHub Release needed
    for installation. Never use them as deployment, bootstrap, or update sources.

    The immutable `v0.1.6` tag has valid signed/public artifacts, but canonical
    macOS Bash 3.2 bootstrap acceptance failed before supervisor installation. It
    remains historical evidence and is not a supported deployment, bootstrap, or
    update source.

    The immutable `v0.1.7` tag also has valid signed/public artifacts. Canonical
    Docker Desktop acceptance reached the updater container, then `cap_drop: ALL`
    denied its unconditional control-socket ownership change before `/v1/status`.
    It is also historical, superseded, and not a supported installation source.

    The immutable `v0.1.8` tag also has valid signed/public artifacts. Canonical
    bootstrap reached signed-plan verification, where cosign 3 tried to initialize
    its default TUF cache at `/root/.sigstore` beneath the updater's read-only root
    filesystem. It is historical, bootstrap-blocked, and superseded.

    The immutable `v0.1.9` tag built, signed, and anonymously proved all three
    images, but constrained plan verification could not traverse the runner-owned
    verification directory. The workflow stopped before GitHub Release publication,
    so no installable signed plan exists for that tag. It is also historical,
    bootstrap-blocked, and superseded by 0.1.13.

    The immutable `v0.1.10` tag passed source and exact-tag CI, then its signed-release
    workflow timed out while the architecture-neutral Web Console builder ran under
    target emulation. It has no complete three-image set, canonical signed plan,
    GitHub Release, Stable tags, or Stable Help Center. It is non-installable,
    superseded, and must never be moved, reused, or used as an update source.

    The immutable `v0.1.11` tag passed every image and plan-verification gate,
    including verification inside the constrained updater. Its post-verification
    cleanup then failed before attestations, GitHub Release, canonical asset,
    Stable-tag, or Stable-documentation publication. It too is non-installable,
    superseded, and immutable.

    The immutable `v0.1.12` tag completed protected source and exact-tag CI and the
    full signed/public release: all three dual-platform digest images, attestations,
    canonical plan and bundle, GitHub Release, Stable aliases, Stable documentation,
    anonymous reads, and keyless signatures verified. Canonical v0.1.1 bootstrap
    then failed closed before application mutation because both legacy application
    images omit the state-schema label and the updater compared one normalized
    absence with one raw absence. It is cryptographically valid but
    bootstrap-blocked, superseded, and not a supported installation source.

## Promotion gate

Before promoting `Testing` to `main`:

- review the complete diff and release notes;
- pass backend, web, generated-contract, version-consistency, Compose, and documentation
  gates;
- exercise clean install, restart, source ingest, investigation, authentication, and
  notification smoke tests;
- back up and restore the reference state backend;
- record known limitations and rollback criteria;
- ensure every package, image, OpenAPI document, and documentation page uses the same
  release identity.

Promote through a reviewed pull request. Tag the accepted `main` commit `v0.1.13` and
publish artifacts identified by digest. Do not move a release tag.

### Version and promotion checklist

1. Update the root `VERSION` once; synchronize backend/package metadata, web
   package and lockfile, OpenAPI, Compose build defaults, Docker labels, MkDocs,
   release notes, and the matching documentation line. Keep one active
   `[Unreleased]` section during development; the final frozen preparation moves its
   accepted entries under `[X.Y.Z]`, opens a fresh `[Unreleased]`, and then promotes
   that exact prepared tree without drift.
2. Run `python3 scripts/check_version.py` and `python3 scripts/check_docs.py`.
3. Run the complete backend suite and the Console typecheck, lint, design gates,
   test, and production build.
4. Regenerate and verify OpenAPI/TypeScript contracts; validate both Compose files;
   build the strict docs site.
5. Build the candidate with `TLSOC_RELEASE_CHANNEL=testing` plus its exact
   `TLSOC_BUILD_SHA` and `TLSOC_BUILD_DATE`. Confirm the OCI source URL (the
   Dockerfile defaults to this repository; forks must override the build argument),
   then record digests and `/api/health/build-info`.
6. Freeze and accept that Testing source tree. Promote it without content changes
   through the protected PR, then rerun the full gate on the resulting `main` SHA.
7. Build that verified SHA with `TLSOC_RELEASE_CHANNEL=stable`, tag it exactly once,
   publish by digest, and let the docs workflow move `stable`/`latest`.

`TLSOC_VERSION` and `TLSOC_RELEASE_CHANNEL` answer different questions. Promoting
`0.1.13` from Testing to Stable changes provenance, not its SemVer.

## Supported one-click upgrades

Agentic SOC 0.1.13 includes the updater foundation for the reference deployment and
becomes installable only after the candidate completes the immutable Stable
publication and canonical runtime acceptance gates.
After one explicit bootstrap, a built-in `super_admin` can authorize a compatible
Stable release from the Console and the updater performs the host-side work. The
ordinary backend and browser never receive Docker access, registry credentials,
arbitrary command execution, or a writable deployment file.

The 0.1.13 updater bakes
`TUF_ROOT=/var/lib/agentic-soc-updater/sigstore-root`, so cosign's TUF trust state
lives on the existing writable updater-state volume while the root filesystem stays
read-only. Stable publication materializes the canonical plan and bundle as read-only
files beneath an explicitly traversable verification directory, then verifies them
inside the real digest-pinned updater under the production `read-only`, `cap_drop: ALL`, and
`no-new-privileges` constraints. Its architecture-neutral Web Console documentation
and application builder stages run on BuildKit's native platform while the final
nginx runtime remains target-platform-specific. After the constrained verifier exits,
release-fixture cleanup restores its runner-owned parent directory to private mode
`0700`, then removes it; the plan and bundle remain mode `0444` beneath mode `0555`
throughout verification. There is no state-schema,
updater-protocol, publisher-identity, process-privilege, trust-policy, or frozen-base
change.

The first implementation is deliberately narrow:

| Requirement | Supported value |
| --- | --- |
| Deployment | Unmodified reference standalone Compose project `tlsoc-agentic-soc` |
| Application state | The reference `tlsoc-postgres` PostgreSQL service |
| Runtime shape | One backend, one Web, and one updater container with canonical service/container names |
| Release channel | Immutable Stable tag and GitHub Release |
| Updated components | Backend, Web Console, installed Help Center, and a compatible updater |
| Infrastructure | Existing PostgreSQL and Redis versions remain operator managed |

SQLite, Elasticsearch-owned state, external PostgreSQL, the legacy ELK merge,
Kubernetes, horizontal replicas, a modified/forked Compose topology, or an update
requiring an unknown state transform fails closed as **Manual upgrade required**. A
source branch, mutable image tag, or bare SemVer is never sufficient installation
authority.

The updater does not download, replace, or rewrite the host's base
`deploy/docker-compose.agnostic.yml`. Every one-click target must therefore name the
same canonical base-file SHA-256 that is mounted on the host. A release that changes
that file is a manual upgrade even when every image and signature is otherwise valid.

### The unavoidable first bootstrap

An installation made before the updater exists cannot grant itself host update
authority. The supported transition from the final pre-supervisor Stable release,
v0.1.1, to v0.1.13 therefore requires one host-authorized bootstrap. On the host:

1. keep the existing reference PostgreSQL Compose deployment running;
2. configure durable `.env` values for `TLSOC_PG_PASSWORD`,
   `TLSOC_AUTH_ENABLED=true`, a `TLSOC_AUTH_JWT_SECRET` of at least 32 characters,
   and the trusted `AGENTIC_SOC_UPDATE_REPOSITORY`;
3. after the complete publication and acceptance evidence verifies, check out the
   clean, exact annotated `v0.1.13` tag whose commit is contained in
   `origin/main`; and
4. run `./scripts/bootstrap-updater.sh` from that checkout.

The script refuses an unclean checkout, a lightweight or mismatched tag, a tag whose
commit is not contained in `origin/main`, an unsupported running topology, or missing
durable secrets. If no supervisor exists, it installs one. If a supervisor exists, the
script first reads its private status: it reuses a healthy compatible idle supervisor
only when its reported updater version exactly matches the target release, or replaces
an idle protocol-, capability-, readiness-, or version-incompatible one while
preserving the active digest override. When
no active override exists, it instead records the exact immutable image ID of the prior
supervisor in a restricted recovery override. Either form is restored if installation
fails before job submission, and the temporary preserved copy is removed only after
the signed update succeeds. Before sending `/v1/jobs`, bootstrap transfers lifecycle
ownership to the durable supervisor. Its EXIT trap never rewrites release pins after
that boundary, including when the client loses an accepted response. One mode-0600,
unpredictable start key is retained per release commit and reused after interruption;
it is deleted only after bootstrap observes that exact job terminal. An unreadable or
invalid supervisor or any active job fails closed for operator recovery; bootstrap
never force-replaces work in progress.
It builds only the initial supervisor transport from the verified checkout, then
asks that supervisor to fetch, verify, preflight, and apply the signed v0.1.13 plan.
The full transition therefore uses the same digest-pinned pull, quiesce, verified
backup, identity/health checks, durable receipt, and automatic rollback state machine
as later Console-initiated updates. It is not an unverified local rebuild of the
application pair.

!!! warning "Testing/source builds are not bootstrap identities"

    A Testing- or source-built 0.1.3 deployment, the non-installable `v0.1.4` /
    `v0.1.5` publication attempts, and the published-but-bootstrap-blocked `v0.1.6`
    through `v0.1.8` records and the failed-publication `v0.1.9` through `v0.1.11` records cannot be
    relabelled Stable. If an earlier attempt left
    an inspectable idle older supervisor while the application
    remained on v0.1.1, the v0.1.13 bootstrap preserves durable state and replaces
    that version-mismatched supervisor before signed-plan verification. Reconcile
    other states only through the documented 0.1.13 path appropriate to their actual
    installed release. Bootstrap also requires a strictly newer target, so an
    already-running 0.1.13 deployment cannot bootstrap itself from the 0.1.13 plan.

Once a supported 0.1.13 deployment has the supervisor, later compatible Stable
releases can be applied from the Console. A missing supervisor or a safely inspectable,
idle older protocol or version is remediated by the host-authorized bootstrap; active, unreadable,
or invalid supervisor state remains an explicit manual blocker. The product never
labels any of those states one-click ready before reconciliation succeeds.

After bootstrap, use `./scripts/agentic-soc-compose.sh` for **every** manual Compose
lifecycle command. The wrapper fixes the reference project identity and automatically
layers `.agentic-soc-runtime/active-release.compose.yml`, which contains the
supervisor-selected public digest pins. Running raw `docker compose -f
deploy/docker-compose.agnostic.yml ...` after bootstrap can silently bypass those
pins and is unsupported.

The signed target override is not made active when images are pulled or when the
supervisor hands off to its target image. It remains a private pending file until the
backend writer is stopped, the PostgreSQL backup is checksumed and catalog-verified,
and cancellation is durably closed. Promotion to the updater-private and host-visible
active overrides is the deployment switch boundary.

The wrapper and supervisor serialize mutations through the same advisory lifecycle
lock. `ps`, `logs`, `config`, and other read-only inspection commands remain usable
during an update; `up`, `down`, `restart`, `stop`, `rm`, `pull`, and other mutating or
unknown commands are refused until the durable job is terminal. A restart clears a
leftover marker only when it names an exact terminal job in the updater ledger.
Malformed, unknown, orphaned, or non-terminal markers stay fail-closed for operator
recovery. Direct raw Compose commands bypass this guard as well as the digest override
and remain unsupported.

The updater fsyncs the recoverable queued job before publishing its lifecycle marker;
the idempotency map is only a repairable index. Preflight reservations and start,
cancel, and rollback intents embed their request keys in the same authoritative record
as the accepted intent. Startup repairs missing indexes from those records. On restart,
a marker therefore has durable job truth, while a queued job saved just before marker
publication resumes by acquiring the lock and revalidating mutable deployment state
before any host mutation.

### What every installable release carries

The immutable GitHub Release includes a canonical signed upgrade plan and signature
bundle. The plan is data, not a shell script. It contains only schema-versioned,
allow-listed fields:

- the exact tag, version, Stable channel, source commit, publication time, and
  minimum updater protocol;
- exact digest-pinned backend, Web, and updater images from the trusted repository;
- supported source versions, PostgreSQL state backend, state-schema identity,
  pinned version-invariant v1 reference-Compose SHA-256, and whether a verified
  backup is mandatory;
- an allow-listed migration strategy identifier; and
- bounded readiness and observation timeouts.

It cannot carry a shell command, host path, Compose fragment, registry credential,
arbitrary URL, or browser-selected image. The updater independently verifies the
plan signature, trusted GitHub Actions workflow identity, repository, tag, commit,
image signatures and digests, compatibility, and local deployment identity before
allowing a preflight to pass. Release assets follow the official Sigstore bundle
verification model and GitHub's digest-pinned container publication contract.
The release workflow creates and signs these canonical assets before the GitHub Release
is public. It first creates an exact tag/SHA draft, uploads both files, downloads and
byte-compares them, verifies the Sigstore identity, and only then publishes the draft
in one transition. A retry may clean an interrupted draft upload and resume only that
exact draft; it must revalidate the plan and signature before publication. Once a
release is public, the workflow treats it as immutable. A missing, partial, duplicate,
or unexpected published asset set is never repaired under that tag; publish a new patch
release instead.

Changing **Settings → Organization → Updates & releases** changes the public source observation;
it does not silently change the updater's trusted publisher. A fork must be
explicitly bootstrapped with its own trusted repository and release-workflow
identity on the host.

The official supervisor deliberately has no container-registry credentials. Before
publishing an installable release, the repository owner must make the three GHCR
packages—`backend`, `webui`, and `updater`—public and prove each digest is anonymously
pullable. The release workflow checks that property before publication. The updater
pulls and inspects all three images after a job starts but before it changes the
running application; an unavailable or private package therefore fails the job
without mutating the deployment.

### Operator experience

The top bar may offer **Update vX.Y.Z** after the public, mutable Stable branch exposes
a newer root `VERSION`, that version resolves through an exact annotated `vX.Y.Z` tag
to an immutable commit, and the host reports the required supervisor capability. The
branch head remains observation-only and may advance after the tag; the candidate's
commit is the dereferenced tag commit. That offer is still not installation authority.
Selecting it causes the backend to derive the canonical immutable GitHub Release
assets and opens a signed supervisor preflight. Only a preflight with no blockers is
installable. It reports:

- target release version, tag, commit, channel, and repository plus current/target
  component versions and scope;
- signed plan and component identities, source-version compatibility, installed
  release and state-schema coherence, exact canonical Compose-file hash,
  single-replica Compose project/network/service shape, canonical PostgreSQL volume,
  Docker/Compose availability, durable authentication and PostgreSQL settings,
  PostgreSQL/updater health, and backup-capacity checks;
- the reason and remediation for every blocker or warning; and
- the planned backup and rollback behavior.

Known unsaved drafts block confirmation. Installation requires a built-in
`super_admin`, an active registered session, current token version, and recent
reauthentication. The request contains only the server-issued release identifier,
short-lived release-bound preflight token, and an idempotency key.
The backend separately authenticates, authorizes, and audits the operator for both
preflight and start; the supervisor token itself is not an operator identity token.

The updater then persists and reports these stages:

1. validate the signed release and local deployment;
2. pull and verify every digest before changing the running pair;
3. quiesce the backend writers;
4. create a PostgreSQL custom-format backup, record its SHA-256, and validate its
   catalog with `pg_restore --list`;
5. recreate the backend from the pinned digest and verify readiness plus exact
   version/channel/commit identity;
6. recreate the Web Console from its matching digest and verify health,
   `/release.json`, entry document, and installed Help Center;
7. observe the coherent release; and
8. commit a durable success receipt or automatically roll back.

The Console shows a persistent stage/progress view. A short backend disconnect is a
planned **Reconnecting after update** state, not a generic outage alarm. Closing or
reopening the tab does not cancel the job: the updater's host volume is
authoritative and the Console resumes from the active job when the backend returns.
After success, the browser repeats the no-store release-manifest, build-info,
readiness, and entry-document checks before reloading the same hash route.

The prior same-origin activation check remains a compatibility fallback for a
coherent backend/Web pair that an external deployment system already installed. It
does not convert mutable upstream source metadata into an install action.

### Automatic rollback and receipts

Before mutation the updater records the exact prior backend, Web, and updater image
IDs; the base Compose-file and environment-file SHA-256 values (never secret values);
the coherent application version, channel, and commit; the job identifier; and, after
quiescing, the verified backup path, size, and checksum. It does not claim to snapshot
rendered Compose or a database/server version. The signed v1 plan is restricted to
`migration.strategy=none`. Preflight proves the installed backend/Web schema-identity
labels match the signed target (except for the explicit legacy v0.1.1 bootstrap); it
does not introspect an independent database-migration ledger.

A signed-artifact or image pull/digest/label failure ends the job before application
mutation. Once switching begins, backup, handoff, recreation, readiness, release-
identity, Help Center, or observation failure triggers image rollback.

If an in-flight update fails after application switching has started, the updater
stops the candidate pair, restores the exact prior backend/Web images, leaves
PostgreSQL untouched, and verifies the old coherent release. Cancellation is accepted
only before switching and also restores image selection without rewriting the
database. The updater never deliberately leaves a mixed old/new pair. The final
receipt distinguishes **Update succeeded**, **Update failed; rollback succeeded**,
and **Rollback failed; manual recovery required**.

The catalog-verified quiesced PostgreSQL dump is retained as a break-glass recovery
artifact, but no automatic or post-success rollback consumes it. Restoring it after
the target backend accepted a write could discard valid data. This image-only
rollback contract is safe only inside the v1 `migration.strategy=none` compatibility
boundary. If a release changes persisted state incompatibly, one-click installation
and image rollback are both the wrong procedure; ship a forward fix or follow a
release-specific, operator-controlled restore plan.

**Upgrade and rollback: case threads and chat history.** Builds with the rebuilt
Workspace Chat keep that boundary on PostgreSQL: after an image-only rollback the older
build still reads and writes case discussion threads and chat transcripts. It does not
know the conversation-level fields those builds add, so its first chat write for a user
drops that user's conversation pins, linked reports, time ranges, and usage totals; the
transcripts and the reports themselves remain. It does not know the pin exemption
either: those builds let up to 10 pinned conversations sit beyond the 50-conversation
limit, so the older build's first saved answer for a user with more than 50
conversations deletes that user's oldest conversations (by last activity, pinned ones
included) until 50 remain. Before rolling back, ask users with more than 50
conversations to export the extra conversations they want to keep (history row menu →
**Export**) and delete them. On the Elasticsearch state backend, which has no
supervised rollback, the new storage form is one-way: after a manual rollback, case
threads and chat history appear empty and the older build's next write removes them.
See
[Known limitations](../releases/known-limitations.md#rollback-loses-chat-and-thread-data).

No updater can make a host power loss, full disk failure, corrupt storage device, or
external registry/network outage literally fail-proof. The supported contract is
fail-closed and idempotent, with host-durable job state across browser/backend
reconnects and ordinary supervisor-process restarts. It also creates a verified backup
and automatically restores prior application images for supported failures.

Updater self-replacement is coordinated by a restartable helper container whose
name-swap transaction is idempotent. After an ordinary helper-process, Docker-daemon,
or host restart, it observes the existing container names and immutable image IDs,
then resumes the replacement or restores the prior healthy supervisor. The durable
ledger, selected override, backup, and recorded prior image IDs remain recovery
evidence. A host, Docker installation, or Docker metadata/storage failure that prevents
all containers from running still requires ordinary host-level disaster recovery; the
updater does not claim zero downtime or immunity from loss of its trusted host.

### Updater retention and capacity

Version 0.1.13 does **not** automatically prune updater jobs, preflights, cached signed
plans and signature bundles, deployment snapshots/receipts, or PostgreSQL backups.
The reference deployment keeps updater state in the persistent
`agentic-soc-updater-state` volume and verified dumps in the separate
`agentic-soc-updater-backups` volume. Accumulation is intentional in this release:
monitor free bytes and inodes for both volumes, include them in the operator's backup
and capacity alerts, and do not interpret a terminal Console status as permission to
delete its underlying evidence.

Never remove or rotate away:

- an active job, its lifecycle marker, or any state needed for its restart;
- the latest terminal job record and the `last-job` reference used to report it;
- the current installed release's signed plan, deployment snapshot, receipts, prior
  image identity, active override, or other evidence that still carries rollback
  authority;
- a terminal job whose exact `job_id` and terminal status have not yet been mirrored
  into the application's append-only audit; or
- a verified break-glass backup or related artifact that remains inside the site's
  backup, incident, legal-hold, or rollback-retention policy.

Archive or remove eligible history only after **all** of these are true: a later
successfully installed release has superseded the record's rollback authority; the
exact terminal outcome is present in application audit; and the operator's backup and
retention policy permits disposal. Version 0.1.13 provides no supported online,
per-record cleanup command, so do not delete individual live-volume files while the
supervisor is running or infer eligibility from age alone.

Safe automatic pruning requires a future versioned acknowledgement and retention
protocol between the updater and backend. That protocol must durably bind the exact
job and terminal transition to its mirrored audit event, identify which snapshot and
artifacts still authorize rollback for the installed release, carry policy/hold
decisions, and make selection plus deletion crash-safe and replay-safe. Until both
sides can prove those facts, age-, count-, or status-only pruning could erase the only
restart, audit, or recovery evidence and therefore remains intentionally absent.

## Manual deployment upgrade procedure

Use the manual path for the first bootstrap, unsupported deployments, or a release
that correctly reports **Manual upgrade required**:

1. Read the release notes and limitations for both versions.
2. Capture `/api/health/build-info` and exact image digests.
3. Stop or quiesce ingestion as required by the state backend.
4. Create and verify a state backup plus a separate secret/config backup.
5. Pull/build the exact accepted release artifacts.
6. Apply only explicitly documented configuration and migration changes.
7. Start state dependencies, backend, Web, then the updater where supported.
8. Require readiness and coherent release identity before traffic.
9. Validate login, sources/cursors, a synthetic case, cost ledger, notifications,
   installed Help Center, and updater capability.
10. Retain old artifacts and the verified backup until the observation window closes.

## Observe upstream source revisions

Open **Settings → Organization → Updates & releases** to configure the public
GitHub repository and the branch used for each release channel. Fresh installations
observe:

```text
Repository: https://github.com/ARYDESTROYER/Agentic-Kibana
Stable branch: main
Testing branch: Testing
Check interval: 360 minutes
```

The backend checks public GitHub metadata through a fixed, bounded, read-only path.
For both channels it reads the branch head and root `VERSION`. For Stable it also
requires an exact annotated `vVERSION` tag and dereferences that tag to its immutable
commit. The branch head remains source-observation metadata; the tag commit is the only
commit projected into a supervised update candidate. Results are cached for the
configured interval and exposed to authenticated operators. Discovery does not clone,
pull, execute, build, deploy, restart, migrate, promote, or roll back anything. The
browser never contacts GitHub directly. Operators can use **Check now** after saving
changed repository or branch settings; the manual endpoint has its own short cooldown.

A newer observed SemVer, or a different SHA on the same current version, may produce
an amber **Source available** notice beside the version badge. The notice links to the
immutable public commit and explicitly means “source exists upstream,” not “this
deployment can update.” Older versions are never offered as upgrades. Network/rate-limit
failures do not interrupt the Console; a last verified observation may remain visible
as stale.

The blue **Update vX.Y.Z** action may appear when the saved Stable observation
identifies a newer SemVer, its annotated tag resolves to an immutable commit, and the
isolated updater reports the required capability. Source discovery alone never
authorizes installation. Selecting the action derives the canonical immutable release
assets for that exact tag commit and starts preflight; the updater then
independently verifies the signed tag workflow identity, release plan, component
signatures and digest identities, compatibility range, backup readiness, and runtime
shape. Confirmation remains unavailable until every blocker is cleared. After job
creation, it pulls the images and inspects their actual labels before application
mutation.

!!! important "Static-asset retention is part of a graceful rollout"

    An open tab may still request an old lazy-loaded hashed asset before the operator
    activates the new release. The reference one-click, single-container updater
    force-recreates the Web service and cannot retain the prior container's chunks or
    provide blue-green serving. A short reconnect or old-chunk miss is therefore a
    documented limitation: save work before updating and reload if an old chunk is
    unavailable. Sites that require zero-downtime asset continuity must use an
    operator-owned external deployment with retained artifacts or blue-green serving;
    that topology is outside the supported one-click profile.

Release observation and supervised installation remain independent of the strict plain-text
authoring contract for Intelligence → Reference runbooks; see
[Runbooks](../intelligence/runbooks.md).

## Rollback

Rollback is not merely starting an older image. A newer version may have written state
that older code does not understand. Version 0.1 does not provide a general schema
migration framework. The v1 supervisor therefore accepts only signed plans whose
migration strategy is `none`, verifies a PostgreSQL custom-format backup before
switching, and retains it only for explicit break-glass recovery. Automatic in-flight,
cancellation, and deliberate post-success rollback restore the prior application
images without rewriting PostgreSQL or discarding post-snapshot writes. Any release
that needs a schema migration is blocked from one-click installation and must follow
a release-specific manual procedure.

Stable fixes start on a focused branch from the affected source, merge into
`Testing`, pass the same acceptance gate, and promote forward to `main` as a patch
release. Emergency timing may shorten review, but it must not reverse the permanent
Testing-to-Stable direction or patch only `main`.

See [Version 0.1](../releases/0.1.md),
[Documentation versions](../releases/documentation-versions.md), and
[Health, backup, and restore](health-backup.md).
