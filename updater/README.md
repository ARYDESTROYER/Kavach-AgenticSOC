# Agentic SOC update supervisor

This image is the privileged half of the signed one-click update path. It exposes
HTTP only through `/run/agentic-soc-updater/control.sock`; the ordinary backend gets
that socket, while the browser and Web container never get Docker access.

The first supported profile is deliberately narrow: the repository's standalone,
single-replica Docker Compose stack with PostgreSQL-owned state, the signed canonical
base-file hash, canonical project/network/service and PostgreSQL-volume identity, and
coherent installed schema labels. A signed plan may select only three digest-pinned
GHCR images (`updater`, `backend`, and `webui`) and the migration strategy `none`. It
cannot carry commands, paths, Compose fragments, PostgreSQL/Redis upgrades, or
arbitrary registries.

The supervisor never transports, replaces, or rewrites the base Compose file. The
0.1.x protocol pins its version-invariant bytes in
`deploy/update-base-v1.sha256`; component versions and immutable image digests exist
only in the signed generated override. This keeps sequential patch updates eligible.
Changing the base requires a new protocol/bootstrap contract and a manual upgrade.

The immutable `v0.1.10` tag is a superseded, non-installable failed-publication
record. Its release job timed out before a complete signed three-image set,
canonical plan and Sigstore bundle, GitHub Release, Stable tags, or Stable Help
Center existed. Never move, reuse, repair, install, or bootstrap from that tag.
The immutable `v0.1.11` workflow built, signed, anonymously proved, and verified all
three images and the plan, including inside the constrained updater, but its
post-verification fixture cleanup failed before attestations, GitHub Release,
canonical assets, Stable tags, or Stable documentation. It is also superseded,
non-installable, and immutable. The immutable `v0.1.12` release then completed the
entire public signed publication and verified anonymous access, but canonical
v0.1.1 bootstrap failed closed before application mutation because matching absent
legacy state-schema labels were normalized asymmetrically. It is cryptographically
valid but bootstrap-blocked and is not a supported installation source. Version
0.2.0 is the current release candidate (it folds in the never-tagged 0.1.13 correction
and is signed as `ARYDESTROYER/Kavach-AgenticSOC`, the renamed repository) and
becomes installable only after
its own complete signed/public publication and canonical acceptance succeed.

The supervisor verifies the Sigstore bundle and each image signature against the
configured repository's Stable-tag release workflow, pulls all images before any
switch, and durably captures exact prior image IDs. Target pins are first written to
a private pending file used only for updater self-handoff; neither updater Compose
commands nor the host lifecycle wrapper consume that file. The supervisor updates
itself through a reversible handoff that retains the prior supervisor until the
replacement is healthy. Only then does it stop the backend writer and create and
catalog-verify a PostgreSQL custom-format backup. After cancellation is durably closed,
it atomically promotes the pending pins to the updater-private and host-visible active
overrides, then switches backend and Web separately.

Version 0.1.10 introduced, and 0.2.0 carries forward,
`TUF_ROOT=/var/lib/agentic-soc-updater/sigstore-root`, so cosign 3 initializes its
TUF trust state on the existing writable updater-state volume instead of its
read-only `/root/.sigstore` default. The release gate also installs the canonical
plan and bundle as read-only files beneath an explicitly traversable verification
directory before invoking the constrained supervisor. The keyless certificate
identity, issuer, repository binding, updater protocol, process identity (`0:10001`), dropped-capability
runtime, and frozen base Compose bytes are unchanged. Bootstrap also replaces an
inspectable idle supervisor whose reported updater version does not match the exact
target; protocol compatibility alone cannot reuse a bootstrap-blocked older image.

Job state survives browser/backend reconnects and normal supervisor-process restarts.
The queued job and idempotency binding are fsynced before its lifecycle marker is
published; a restart can therefore resume every published marker from durable job
truth. Mutable host state is revalidated after the worker acquires the shared lock.
Self-replacement is coordinated by a restartable helper whose name-swap transaction is
idempotent: after an ordinary helper-process, Docker-daemon, or host restart, it
observes the existing container names and immutable image IDs, then resumes replacement
or restores the exact prior supervisor. Loss or corruption of the trusted host, Docker
installation, or Docker metadata/storage remains an operator-owned recovery event.

An in-flight failure after application switching starts restores the exact prior
backend/Web images without rewriting PostgreSQL. A failure or operator cancellation
before switching and a deliberate rollback requested after success are image-only as
well. The verified quiesced dump is retained solely for explicit break-glass recovery,
because consuming it automatically could discard valid post-snapshot writes. Job and
receipt state lives in a host-persistent named volume so backend restarts and
supervisor handoffs do not erase progress.

After the updater selects a release, use `scripts/agentic-soc-compose.sh` for every
manual Compose lifecycle command. The wrapper automatically layers the public,
host-visible `.agentic-soc-runtime/active-release.compose.yml` digest pins. Calling
raw `docker compose -f deploy/docker-compose.agnostic.yml ...` bypasses that lifecycle
contract and is unsupported after a supervised update.

The wrapper and supervisor share an advisory lifecycle lock. Read-only inspection
commands such as `ps`, `logs`, and `config` remain available during an update, while
mutating commands are refused until its durable job is terminal. The marker spans
supervisor self-handoff; on restart it is removed automatically only when it names an
exact durable terminal job. An unknown, malformed, or orphaned marker fails closed and
requires the documented operator recovery rather than guessing that mutation is safe.

The wrapper also rejects `build` and `--build` while the signed release override is
active. Returning deliberately to a source-built Testing deployment is a recovery
operation, not a normal lifecycle command: first make an application export and an
independently verified PostgreSQL backup, stop the stack through the wrapper, move
`.agentic-soc-runtime/active-release.compose.yml` to a retained `.disabled` recovery
file, and only then run the documented source-build deployment. The supervisor will
no longer describe that source build as a managed installed release; reinstall or
reconcile the supervisor through the bootstrap procedure before using one-click
updates again. Do not delete the updater state/backup volume as part of this recovery.

Deployments older than the supervisor need the one-time, host-authorized bootstrap
in `scripts/bootstrap-updater.sh`. It refuses a dirty or non-tagged checkout, proves
HEAD is the exact annotated Stable release commit and that commit remains contained in
`origin/main`, installs a missing supervisor, reuses a compatible idle supervisor, or
safely replaces only an inspectable idle incompatible supervisor while preserving the
prior digest override. If no override exists, it records the exact immutable image ID
of the prior updater in a restricted recovery override. It restores the applicable
override only for failures before durable job submission. Immediately before the
`/v1/jobs` request, ownership passes irrevocably to the supervisor—even an ambiguous
client disconnect cannot make the bootstrap trap rewrite active pins. A restricted,
unpredictable per-release start key survives interruption and is reused until the
exact durable job is observed terminal; only then is that key retired. The temporary
preserved copy is removed after confirmed success and remains a recovery artifact after
a terminal failure. Active, unreadable, or invalid supervisor state fails closed.
The bootstrap installs only the local transport boundary,
then asks that supervisor to verify and apply the signed digest-pinned release using
the same quiesce, backup, health, identity, documentation, and rollback state machine.
After that boundary is installed, later compatible Stable releases can be applied
through the Console.

## Retention and cleanup

Version 0.2.0 deliberately performs no automatic pruning. The updater state volume
retains durable jobs and preflights, cached `upgrade-plan.json` and Sigstore bundles,
release overrides, deployment snapshots, and receipts. The separate backup volume
retains the catalog-verified PostgreSQL dumps. Operators must monitor free space and
inode usage on both persistent volumes and protect them through the site's backup and
retention controls.

Do not delete:

- an active job, its lifecycle marker, or restart state;
- the latest terminal job record or its `last-job` pointer;
- the current installed release's plan, snapshot, receipts, prior-image identities,
  active override, or any other artifact that still provides rollback authority;
- a terminal job until its exact `job_id` and terminal status are present in the
  application's append-only system-update audit; or
- a verified break-glass dump or related evidence still retained by backup,
  incident-response, legal-hold, or rollback policy.

An older record may be archived or removed only after a later successful release has
superseded its rollback authority, the backend has durably mirrored its terminal
outcome into application audit, and operator policy permits disposal. There is no
supported online per-record cleanup command in v0.2.0; never edit the live volume's
files while the supervisor is running or treat age alone as deletion authority.

Future automatic pruning requires a versioned acknowledgement/retention protocol
between the updater, which owns host recovery evidence, and the backend, which owns
the append-only audit mirror. It must bind an exact job/status transition to its audit
acknowledgement, expose the installed release's current rollback generation, carry
policy holds, and commit deletion through a crash-safe, replay-safe state transition.
Without that handshake, automatic cleanup could erase evidence needed to resume,
audit, or recover an update.
