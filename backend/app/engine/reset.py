"""Operator RESET service (Round 4, Wave 4 — the danger-zone endpoint's engine).

A **tiered, secret-safe** reset of the suite's OWN management state. Three scopes,
each a strict SUPERSET of the previous (see the tier table in
``docs/research/2026-07-round4/PROPOSAL.md`` §6.6):

* ``cases``    — clear the case store + the case-adjacent collaboration/observability
                 KV stores (campaigns, baseline sketches, noise-reduction counters,
                 inbox, case thread/activity/tasks, batch jobs) + the in-memory
                 live-tail rings. KEEP sources, settings, users, RAG, secrets, cost
                 ledger, audit.
* ``sources``  — the cases tier PLUS ``Preferences.sources[]`` (configured feeds) +
                 the polling cursors. KEEP secrets, users, settings, the ``setup``
                 flag.
* ``factory``  — the sources tier PLUS users/sessions/user-prefs/custom-roles/
                 proposals/memory + branding, resets prefs to defaults with
                 ``setup_complete=False`` (→ fresh OOBE), and (ONLY at this tier)
                 resets the append-only audit index. KEEP env-provided secrets.

⛔ HARD RULE (code-enforced): this service **NEVER reads or writes any env-provided
secret** — ``Secrets`` (``ES_API_KEY`` / the LLM keys / ``STATE_DB_URL`` / any
``TLSOC_*``) is the env/.env + in-memory tier and is never touched here. Reset only
ever re-initialises the StateStore side; it never rewrites env/.env. The per-source
connector secrets + wizard/in-memory secrets that DO clear at tiers 2/3 are cleared
by the ROUTE layer (which owns the in-memory ``Secrets`` object), NOT here — this
engine is a pure StateStore operation.

Invariants held (mirroring the platform rails):
  * #1 — never touches the read-only log surface / the upstream ``all-logs-*`` key.
    Every clear rides the ``_mgmt``/StateStore path (the case/audit indices, the KV
    doc store, the cursor index); the read-only ``_ro`` client is never used.
  * #3 — NEVER imports ``case_manager`` / calls ``decide()``. Reset destroys cases;
    it never TRANSITIONS one (no verdict, no close/escalate decision).
  * #4 — never recomputes a ``cluster_signature``.
  * #6 — the usage/cost ledger is preserved at the ``cases``/``sources`` tiers (cost
    history survives a case reset); only a FULL factory reset resets the audit index.
    No LLM call is made.

The cases and sources tiers remain best-effort. Factory reset is different: every
privacy-critical clear uses a confirmed strict write, later identity/audit/OOBE
steps stop after the first failure, and the caller receives an explicit failed
receipt. The Jobs runner keeps the factory fence until that boundary is confirmed,
so a partial clear is never presented as a clean new tenant.
"""

from __future__ import annotations

import logging
from typing import Any, Protocol, runtime_checkable

from ..constants import (
    AUDIT_INDEX,
    AUDIT_READ_PATTERN,
    BASELINE_KEY,
    BASELINE_NS,
    CAMPAIGNS_KEY,
    CAMPAIGNS_NS,
    CASE_ACTIVITY_KEY,
    CASE_ACTIVITY_NS,
    CASE_TASKS_KEY,
    CASE_TASKS_NS,
    CASE_THREAD_KEY,
    CASE_THREAD_NS,
    CASES_READ_PATTERN,
    CASES_WRITE_ALIAS,
    CURSOR_INDEX,
    NOISE_KEY,
    NOISE_NS,
    USAGE_INDEX,
    USAGE_READ_PATTERN,
    ResetScope,
)
from ..stores.ledger_claims import clear_ledger_claims

logger = logging.getLogger("tlsoc.engine.reset")


@runtime_checkable
class ResetHost(Protocol):
    """The NARROW slice of :class:`app.state.AppState` the reset engine needs.

    Round 5 (Coupling-F / G8): ``reset_service`` used to take the whole ``AppState`` as
    ``Any`` and reach into ``_kv``/``_sql_engine``/``_is_sql_backend``/
    ``_real_ingest_service`` privates. It now depends only on this documented seam — the
    public ``es``/``prefs``/``kv`` handles, ``update_prefs``/``rebuild_log_source``/
    ``refresh_users``, and the SQL-backend accessors (``is_sql_backend``/``sql_engine``)
    + the public ``real_ingest_service``. Structural typing means ``AppState`` satisfies
    it unchanged, and a test can pass a tiny fake host. Behaviour is byte-identical.
    """

    es: Any
    prefs: Any

    @property
    def kv(self) -> Any: ...
    @property
    def sql_engine(self) -> Any: ...
    @property
    def real_ingest_service(self) -> Any: ...
    @property
    def real_batch_job_store(self) -> Any: ...
    @property
    def rag(self) -> Any: ...

    def is_sql_backend(self) -> bool: ...
    async def update_prefs(self, prefs: Any) -> Any: ...
    def rebuild_log_source(self) -> Any: ...
    async def refresh_users(self) -> Any: ...


# The KV (namespace, key) documents cleared at the ``cases`` tier: the case-adjacent
# collaboration + observability stores. Every one is a single KV document over the
# SHARED ``self._kv`` (ES: a doc in the config index; SQL: a KVRow) — clearing it is a
# byte-safe ``put(ns, key, {})`` on any backend. NONE holds a secret; NONE feeds
# ``decide()`` (#3). The cost/price overlay + shift-handoff + notif-prefs are NOT
# here (they are org/observability data, not per-case state → survive a case reset).
_CASES_KV: tuple[tuple[str, str], ...] = (
    (CAMPAIGNS_NS, CAMPAIGNS_KEY),      # cross-case campaign clustering (references case ids)
    (BASELINE_NS, BASELINE_KEY),        # anomaly-baseline sketches (pure math state)
    (NOISE_NS, NOISE_KEY),              # durable Noise-Reduction ingest counters (advisory, #3-safe)
    (CASE_THREAD_NS, CASE_THREAD_KEY),  # per-case threaded discussion
    (CASE_ACTIVITY_NS, CASE_ACTIVITY_KEY),  # per-case activity feed
    (CASE_TASKS_NS, CASE_TASKS_KEY),    # per-case checklist / tasks
)

async def reset_service(
    app_state: ResetHost,
    scope: ResetScope | str,
    *,
    factory_owner: str | None = None,
) -> dict[str, Any]:
    """Execute a tiered StateStore reset and return WHAT WAS CLEARED.

    ``app_state`` is the live :class:`app.state.AppState` (typed as the narrow
    :class:`ResetHost` seam); ``scope`` is a
    :class:`app.constants.ResetScope` (or its string value). Returns a JSON-safe
    ``{"scope": ..., "cleared": [...]}`` receipt (plain data, #9) enumerating each
    store touched, so the route can echo it and the caller can see exactly what went.

    The ROUTE is responsible for the auth/step-up gate + the audit record (written
    BEFORE this runs, #2) + the confirm-token validation + any in-memory secret
    clearing. This function performs ONLY the StateStore mutation and is idempotent —
    running it twice on an already-empty store is a harmless no-op.
    """
    scope = ResetScope(scope) if not isinstance(scope, ResetScope) else scope
    cleared: list[str] = []
    attempted: list[str] = []
    failed: list[str] = []

    # ---- Tier 1: cases + case-adjacent KV + live-tail rings (all tiers). ---------
    attempted.append("cases")
    n, cases_ok = await _clear_cases(
        app_state, strict=scope == ResetScope.FACTORY
    )
    if cases_ok:
        cleared.append(f"cases:{n}")
    else:
        failed.append("cases")
    # A factory reset default-deletes the complete KV surface later. Avoid writing
    # empty placeholders first: doing so creates more stale-writer windows and makes
    # a transient per-store error falsely fail a boundary the strict wholesale purge
    # could prove. Cases/sources retain their existing scoped semantics.
    if scope != ResetScope.FACTORY:
        for ns, key in _CASES_KV:
            attempted.append(f"kv:{ns}")
            if await _clear_kv(app_state, ns, key):
                cleared.append(f"kv:{ns}")
            else:
                failed.append(f"kv:{ns}")
    # Batch work is a separate strict-CAS document. Its embedded reset epoch is
    # preserved while rows are cleared, so an already-admitted scheduler mutation
    # cannot recreate a pre-reset provider job after this boundary.
    attempted.append("kv:batch_jobs")
    try:
        removed_batches = await app_state.real_batch_job_store.clear_all_strict(
            factory_owner=(
                factory_owner if scope == ResetScope.FACTORY else None
            )
        )
        cleared.append(f"kv:batch_jobs:{removed_batches}")
    except Exception as exc:  # noqa: BLE001 - reported; factory fails closed
        logger.warning("batch-job reset failed (%s); continuing", exc)
        failed.append("kv:batch_jobs")
    # Active/personal Job anchors survive only cases/sources resets. Factory clears
    # the entire Inbox (including pending digests) before the Jobs registry is
    # replaced with one system-owned sanitized receipt.
    try:
        from ..stores.inbox import InboxStore

        if scope != ResetScope.FACTORY:
            attempted.append("kv:inbox")
            inbox_store = InboxStore(app_state.kv)
            batch_notes = await inbox_store.purge_batch_entries_strict()
            await inbox_store.clear_non_job()
            cleared.append(f"kv:inbox_batch_jobs:{batch_notes}")
            cleared.append("kv:inbox_except_jobs")
    except Exception as exc:  # noqa: BLE001 - reported; scoped reset continues
        logger.warning("inbox reset failed (%s); continuing", exc)
        failed.append("kv:inbox")
    attempted.append("live_tail_rings")
    if _clear_live_tail(app_state):
        cleared.append("live_tail_rings")
    else:
        failed.append("live_tail_rings")

    # ---- Tier 2: sources + polling cursors. --------------------------------------
    if scope in (ResetScope.SOURCES, ResetScope.FACTORY):
        attempted.append("cursors")
        if await _clear_cursors(
            app_state, strict=scope == ResetScope.FACTORY
        ):
            cleared.append("cursors")
        else:
            failed.append("cursors")
        attempted.append("sources")
        if await _clear_sources(app_state):
            cleared.append("sources")
        else:
            failed.append("sources")

    # ---- Tier 3: identity/personalisation KV + branding + prefs→defaults + audit. -
    if scope == ResetScope.FACTORY:
        # Persistent knowledge and cost history are tenant state too. Clear and
        # verify them before the generic KV boundary so ledger claims cannot later
        # resurrect a row from their payload.
        attempted.append("rag")
        if await _reset_rag(app_state):
            cleared.append("rag")
        else:
            failed.append("rag")
        attempted.append("usage")
        if not failed and await _reset_usage(app_state):
            cleared.append("usage")
        else:
            failed.append("usage")
        # Default-delete EVERY application KV/config row, including future/dynamic
        # partitions, while preserving only the exact fenced Jobs + Batch documents
        # and updater operation state. The backend primitive verifies the protected
        # bytes and the absence of all disallowed rows before it commits/returns.
        attempted.append("kv:tenant")
        try:
            if failed:
                raise RuntimeError("earlier privacy clear was not confirmed")
            removed = await app_state.kv.factory_purge_strict()
            cleared.append(f"kv:tenant:{removed}")
        except Exception as exc:  # noqa: BLE001
            logger.warning("factory KV purge failed (%s)", exc)
            failed.append("kv:tenant")
        # Do not open a fresh tenant or erase the old audit lineage unless every
        # preceding state/privacy clear was confirmed. Partial destructive work is
        # reported as failed and remains fenced for operator recovery.
        if not failed:
            attempted.append("audit")
            if await _reset_audit(app_state):
                cleared.append("audit")
            else:
                failed.append("audit")
        if not failed:
            # Prefs → factory defaults with setup_complete=False (→ fresh OOBE).
            # Done last so source/cursor clears ran against the live prefs first.
            attempted.append("preferences")
            if await _reset_prefs_to_factory(app_state):
                cleared.append("preferences")
            else:
                failed.append("preferences")

    # Keep the AuthService view of users current after a factory user-store wipe so the
    # next request doesn't authenticate a now-deleted account (best-effort, never
    # raises). No-op when auth is off / at the non-factory tiers.
    if scope == ResetScope.FACTORY:
        try:
            await app_state.refresh_users()
        except Exception as exc:  # noqa: BLE001 — refresh is best-effort
            logger.warning("post-reset user refresh failed (%s); continuing", exc)

    logger.info("RESET scope=%s cleared=%s", scope.value, cleared)
    return {
        "scope": scope.value,
        "attempted": attempted,
        "cleared": cleared,
        "failed": failed,
        # A sanitized post-reset receipt is safe only after every identity,
        # session, personal projection, and preference clear was confirmed.
        "privacy_boundary_confirmed": (
            scope != ResetScope.FACTORY
            or (
                not failed
                and "rag" in cleared
                and "usage" in cleared
                and any(item.startswith("kv:tenant:") for item in cleared)
                and "audit" in cleared
                and "preferences" in cleared
            )
        ),
    }


# --------------------------------------------------------------------------- #
# Per-store clears — each backend-agnostic + best-effort (logs + continues on a
# glitch). All ride the mgmt/StateStore path; NONE touches the read-only log key (#1).
# --------------------------------------------------------------------------- #
async def _clear_cases(
    app_state: Any, *, strict: bool = False
) -> tuple[int, bool]:
    """Delete every persisted case from the REAL case store (never the demo store).

    Backend-dispatched: SQL truncates the ``cases`` table in one statement; ES pages
    through the case read-pattern and deletes each doc by id (there is no store-level
    bulk delete, and per-doc delete keeps the write index/alias intact so a fresh case
    can be saved immediately after). Returns the number of cases removed. Best-effort:
    a glitch is logged and the partial count returned — reset never hard-fails."""
    if _is_sql(app_state):
        try:
            return await _sql_delete_all(app_state, "cases", strict=strict), True
        except Exception:
            return 0, False
    es = app_state.es
    deleted = 0
    ok = True
    try:
        # Page defensively (a case reset is rare + operator-scale). Re-query each page
        # from offset 0 because we are deleting as we go (the total shrinks).
        while True:
            resp = await es.search(
                CASES_READ_PATTERN,
                {"size": 500, "from": 0, "query": {"match_all": {}},
                 "_source": ["case_id"]},
            )
            hits = resp.get("hits", {}).get("hits", [])
            if not hits:
                break
            page_deleted = 0
            for h in hits:
                cid = (h.get("_source") or {}).get("case_id") or h.get("_id")
                if not cid:
                    continue
                try:
                    remove = (
                        es.delete_doc_strict if strict else es.delete_doc
                    )
                    if await remove(CASES_WRITE_ALIAS, str(cid), refresh=True):
                        deleted += 1
                        page_deleted += 1
                    else:
                        # Fall back to the doc's own index (a rolled backing index the
                        # write alias no longer points at) so an old case still clears.
                        idx = h.get("_index") or CASES_WRITE_ALIAS
                        if await remove(str(idx), str(cid), refresh=True):
                            deleted += 1
                            page_deleted += 1
                        else:
                            ok = False
                except Exception as exc:  # noqa: BLE001
                    ok = False
                    logger.warning("case delete %s failed (%s); continuing", cid, exc)
            # Guard against a store that ignores delete (would loop forever): stop when
            # a full page produced no deletions.
            if page_deleted == 0 and len(hits) > 0:
                ok = False
                logger.warning("case clear made no progress on a %d-hit page; aborting", len(hits))
                break
    except Exception as exc:  # noqa: BLE001 — never hard-fail the reset
        ok = False
        logger.warning("case clear failed (%s); cleared %d so far", exc, deleted)
    if strict:
        try:
            remaining = await es.count(
                CASES_READ_PATTERN, {"query": {"match_all": {}}}
            )
            if int(remaining or 0) != 0:
                ok = False
                logger.warning(
                    "case clear verification found %d retained rows", remaining
                )
        except Exception as exc:  # noqa: BLE001
            ok = False
            logger.warning("case clear verification failed (%s)", exc)
    return deleted, ok


async def _clear_kv(
    app_state: Any, namespace: str, key: str, *, strict: bool = False
) -> bool:
    """Clear ONE shared-KV document (``put(ns, key, {})``) — backend-agnostic (ES doc
    in the config index / SQL KVRow). Best-effort; returns True on a successful put."""
    kv = getattr(app_state, "kv", None)
    if kv is None:
        return False
    try:
        put = (getattr(kv, "put_strict", None) if strict else None) or kv.put
        get = (getattr(kv, "get_strict", None) if strict else None) or kv.get
        await put(namespace, key, {})
        if strict:
            persisted = await get(namespace, key)
            if not isinstance(persisted, dict):
                raise RuntimeError("clear could not be confirmed")
            if any(name != "_rev" for name in persisted):
                raise RuntimeError("clear verification found retained state")
        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("kv clear %s/%s failed (%s); continuing", namespace, key, exc)
        return False


async def _clear_chat_history(app_state: Any) -> bool:
    """Clear the chat partition registry and every registered user partition."""
    kv = getattr(app_state, "kv", None)
    if kv is None:
        return False
    try:
        from ..stores.chat_conversations import ChatConversationStore

        await ChatConversationStore(kv).clear_all()
        return True
    except Exception as exc:  # noqa: BLE001 -- reset remains best-effort
        logger.warning("chat-history clear failed (%s); continuing", exc)
        return False


def _clear_live_tail(app_state: Any) -> bool:
    """Drop the in-memory per-source live-tail ring buffers on the REAL ingest service
    (the demo stack has its own throwaway rings). Purely in-process; never raises."""
    svc = getattr(app_state, "real_ingest_service", None)
    recent = getattr(svc, "_recent", None)
    if isinstance(recent, dict):
        try:
            recent.clear()
            return True
        except Exception as exc:  # noqa: BLE001
            logger.warning("live-tail ring clear failed (%s); continuing", exc)
    return False


async def _clear_cursors(app_state: Any, *, strict: bool = False) -> bool:
    """Clear the durable polling cursors so a re-added source cold-starts (no skip/dup).

    SQL: delete every ``cursor`` KV row. ES: drop + recreate the cursor index (it holds
    the primary + every per-feed cursor doc; a wholesale reset is the right semantic and
    the index is re-created empty so the next poll writes a fresh cursor). Cases and
    sources resets remain best-effort; ``strict=True`` makes bootstrap failure a
    confirmed factory failure."""
    if _is_sql(app_state):
        try:
            await _sql_delete_all(
                app_state,
                "kv",
                where="namespace = 'cursor'",
                strict=strict,
            )
            return True
        except Exception:
            return False
    es = app_state.es
    try:
        delete = es.delete_index_strict if strict else es.delete_index
        await delete(CURSOR_INDEX)
    except Exception as exc:  # noqa: BLE001
        logger.warning("cursor index delete failed (%s); continuing", exc)
        return False
    # Re-create the (empty) bookkeeping indices so the next cursor save has a home.
    try:
        from ..es.indices import bootstrap_indices

        await bootstrap_indices(es)
    except Exception as exc:  # noqa: BLE001
        logger.warning("cursor index re-bootstrap failed (%s); continuing", exc)
        if strict:
            return False
    return True


async def _clear_sources(app_state: Any) -> bool:
    """Remove all configured sources/feeds from ``Preferences.sources`` and persist +
    re-wire the (now source-less) log surface. Preserves EVERY other preference (this
    is the ``sources`` tier, not factory). Best-effort; never raises."""
    try:
        prefs = app_state.prefs.model_copy(deep=True)
        prefs.sources = []
        await app_state.update_prefs(prefs)
        try:
            app_state.rebuild_log_source()
        except Exception as exc:  # noqa: BLE001 — a rewire glitch must not fail the reset
            logger.warning("log-source rebuild after source clear failed (%s); continuing", exc)
        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("source clear failed (%s); continuing", exc)
        return False


async def _reset_prefs_to_factory(app_state: Any) -> bool:
    """Reset ``Preferences`` to code defaults with ``setup_complete=False`` (→ OOBE).

    A fresh :class:`Preferences` carries the shipped defaults (branding, rule catalog
    empty → re-seeded on next boot, every feature toggle back to its default). ``demo``
    is FORCED off so a reset can never leave a stale demo run pointed at a wiped store
    (mirrors ``put_settings``' demo discipline). This touches ONLY the config doc — env
    secrets are never read or written. Persisted via ``update_prefs`` so it survives a
    restart. Best-effort; never raises."""
    try:
        from ..config import DemoConfig, Preferences

        fresh = Preferences()
        fresh.setup_complete = False
        fresh.demo = DemoConfig()  # mode='off' — never leave a demo run on a wiped store
        # The generic factory KV purge removed the old document. Persist the fresh
        # OOBE defaults through a confirmed backend write before considering the
        # privacy boundary complete; the ordinary config-store save is intentionally
        # compatibility/fail-soft on some backends.
        if app_state.is_sql_backend():
            await app_state.kv.put("config", "preferences", fresh.model_dump(mode="json"))
            persisted = await app_state.kv.get("config", "preferences")
        else:
            from ..constants import CONFIG_DOC_ID, CONFIG_INDEX

            await app_state.es.index_doc(
                CONFIG_INDEX,
                fresh.model_dump(mode="json"),
                doc_id=CONFIG_DOC_ID,
                refresh=True,
            )
            persisted = await app_state.es.get_doc_strict(CONFIG_INDEX, CONFIG_DOC_ID)
        if not isinstance(persisted, dict):
            raise RuntimeError("factory preferences were not confirmed")
        confirmed = Preferences.model_validate(persisted)
        if confirmed.model_dump(mode="json") != fresh.model_dump(mode="json"):
            raise RuntimeError("factory preference verification mismatch")
        app_state.prefs = fresh
        app_state.rag.set_prefs(fresh)
        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("prefs factory reset failed (%s); continuing", exc)
        return False


async def _reset_audit(app_state: Any) -> bool:
    """Reset the append-only audit index — FACTORY TIER ONLY.

    #2 keeps the audit append-only in NORMAL operation (no update/delete on a recorded
    action). A full factory reset is the explicit, audited (the route writes the RESET
    row first) exception: the whole history is wiped as the deployment returns to a
    clean slate. SQL: truncate the ``audit`` table. ES: drop + recreate the audit index
    (append-only means there is no per-row delete; a whole-index reset is the semantic).
    Best-effort; never raises."""
    if _is_sql(app_state):
        try:
            await _sql_delete_all(app_state, "audit", strict=True)
            return True
        except Exception:
            return False
    es = app_state.es
    deleted = True
    try:
        # Clear the stable, non-rolling idempotency authority first. If this fails,
        # retain the ledger too: deleting rows while old claims survive would allow a
        # later retry to resurrect pre-reset audit evidence from the recovery payload.
        await clear_ledger_claims(es, "audit")
    except Exception as exc:  # noqa: BLE001
        logger.warning("audit claim reset failed (%s); retaining audit ledger", exc)
        return False
    try:
        # Rollover can leave several concrete backing indices. Delete the full owned
        # read pattern, then the pre-rollover/base spelling defensively.
        await es.delete_index_strict(AUDIT_READ_PATTERN)
        await es.delete_index_strict(AUDIT_INDEX)
    except Exception as exc:  # noqa: BLE001
        logger.warning("audit index delete failed (%s); continuing", exc)
        deleted = False
    try:
        from ..es.indices import bootstrap_indices

        await bootstrap_indices(es)
    except Exception as exc:  # noqa: BLE001
        logger.warning("audit index re-bootstrap failed (%s); continuing", exc)
        deleted = False
    try:
        # Catch a claim created by an in-flight pre-reset writer between the first
        # cleanup and index deletion. A post-reset row is left intact and will be
        # safely adopted if its deterministic id is retried.
        await clear_ledger_claims(es, "audit")
    except Exception as exc:  # noqa: BLE001
        logger.warning("post-reset audit claim cleanup failed (%s)", exc)
        return False
    try:
        remaining = await es.count(
            AUDIT_READ_PATTERN, {"query": {"match_all": {}}}
        )
        if int(remaining or 0) != 0:
            logger.warning("audit reset verification found %d retained rows", remaining)
            return False
    except Exception as exc:  # noqa: BLE001
        logger.warning("audit reset verification failed (%s)", exc)
        return False
    return deleted


async def _reset_usage(app_state: Any) -> bool:
    """Strictly clear and verify the complete usage/cost ledger and claims."""

    if _is_sql(app_state):
        try:
            await _sql_delete_all(app_state, "usage", strict=True)
            return await _sql_count(app_state, "usage") == 0
        except Exception as exc:  # noqa: BLE001
            logger.warning("SQL usage reset failed (%s)", exc)
            return False
    es = app_state.es
    try:
        await clear_ledger_claims(es, "usage")
        await es.delete_index_strict(USAGE_READ_PATTERN)
        await es.delete_index_strict(USAGE_INDEX)
        from ..es.indices import bootstrap_indices

        await bootstrap_indices(es)
        await clear_ledger_claims(es, "usage")
        remaining = await es.count(
            USAGE_READ_PATTERN, {"query": {"match_all": {}}}
        )
        if int(remaining or 0) != 0:
            raise RuntimeError(f"usage reset retained {remaining} rows")
        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("usage reset failed (%s)", exc)
        return False


async def _reset_rag(app_state: Any) -> bool:
    """Clear and prove absence of persistent/in-memory RAG chunks."""

    try:
        from ..tools.vectorstore import ESVectorStore, RAG_INDEX

        service = getattr(app_state, "rag", None)
        store = getattr(service, "_store", None)
        if store is None:
            raise RuntimeError("RAG store is unavailable")
        if isinstance(store, ESVectorStore):
            await app_state.es.delete_index_strict(RAG_INDEX)
            remaining = await app_state.es.count(
                RAG_INDEX, {"query": {"match_all": {}}}
            )
            if int(remaining or 0) != 0:
                raise RuntimeError(
                    f"RAG index retained {remaining} chunks after strict delete"
                )
            store._ensured_dim = None  # noqa: SLF001 - reset owns store lifecycle
        else:
            await store.clear()
            if int(await store.count()) != 0:
                raise RuntimeError("RAG store retained chunks after clear")
        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("RAG reset failed (%s)", exc)
        return False


# --------------------------------------------------------------------------- #
# SQL helpers (only reached on the sqlite/postgres state backend).
# --------------------------------------------------------------------------- #
def _is_sql(app_state: Any) -> bool:
    try:
        return bool(app_state.is_sql_backend())
    except Exception:  # noqa: BLE001
        return False


async def _sql_delete_all(
    app_state: Any,
    table: str,
    *,
    where: str | None = None,
    strict: bool = False,
) -> int:
    """``DELETE FROM <table> [WHERE <where>]`` on the SQL state engine. ``table`` +
    ``where`` are code-controlled constants (never user input) so this is not an
    injection surface. Returns the rowcount (0 on a glitch). Best-effort; never raises."""
    engine = getattr(app_state, "sql_engine", None)
    if engine is None:
        if strict:
            raise RuntimeError("SQL state engine is unavailable")
        return 0
    try:
        from sqlalchemy import text

        stmt = f"DELETE FROM {table}" + (f" WHERE {where}" if where else "")
        async with engine.begin() as conn:
            result = await conn.execute(text(stmt))
            return int(getattr(result, "rowcount", 0) or 0)
    except Exception as exc:  # noqa: BLE001
        logger.warning("SQL delete on %s failed (%s); continuing", table, exc)
        if strict:
            raise
        return 0


async def _sql_count(app_state: Any, table: str) -> int:
    """Strict code-controlled row count used to confirm a factory clear."""

    engine = getattr(app_state, "sql_engine", None)
    if engine is None:
        raise RuntimeError("SQL state engine is unavailable")
    from sqlalchemy import text

    async with engine.connect() as conn:
        value = await conn.scalar(text(f"SELECT COUNT(*) FROM {table}"))
    return int(value or 0)
