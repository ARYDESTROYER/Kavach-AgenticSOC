"""Investigation pipeline — the shared spine used by every surface.

One code path produces a case from a cluster: enrich → deterministic risk →
cheap-router triage → (benign shortcut | strong investigator) → deterministic
Case Manager decision → persist + audit. Surfaces 2 (investigate), 3 (automated
scan) and the poller all call this, guaranteeing identical, auditable behaviour.

It NEVER raises: any failure yields a NEEDS_HUMAN case (Section 6.7).
"""

from __future__ import annotations

import asyncio
import contextvars
import logging
import weakref
from collections.abc import Awaitable, Callable, Iterable
from types import SimpleNamespace
from typing import TYPE_CHECKING, Any

from ..audit.audit_log import AuditLogger
from ..audit.changes import redact_text
from ..audit.events import DERIVED_OUTCOMES
from ..build_identity import originating_record_provenance
from ..cache import Cache
from ..config import Preferences, Secrets
from ..connectors.base import PullConnector
from ..connectors.elastic import ElasticConnector
from ..constants import (
    ActionType,
    CaseStatus,
    DecisionBy,
    Disposition,
    EntityType,
    OPEN_CASE_STATUSES,
    RUNBOOK_SELECTOR_ACTOR,
    TERMINAL_CASE_STATUSES,
    SourceSurface,
    Verdict,
)
from ..engine.analyst_outcomes import standing_analyst_disposition
from ..engine.case_manager import CaseManager, _entry_for
from ..engine.cost_gate import CaseBudget
from ..engine.ingest import attach_cluster, is_attach_only
# Read-time classification of an ALREADY-persisted decision, shared with the metrics
# reader so the audit trail and the analysis cannot use two different vocabularies.
# It never decides anything and is never an input to decide() (#3).
from ..engine.metrics import classify_auto_close_gate
from ..engine.precedent import match_analyst_rule_policy
from ..engine.priority import band_of_case
from ..engine.risk import compute_risk
from ..engine.risk_explain import explain_risk
from ..engine.signatures import find_open_case_for_cluster
from ..es.base import BaseESClient
from ..llm.gateway import LLMGateway
from ..models import Case, Cluster, EnrichmentResult, StatusHistoryEntry, VerdictResult
from ..stores.cases import CaseStore
from ..tools.base import ToolRegistry
from ..tools.enrich import EnrichTool
from ..tools.es_query import DEFAULT_MAX_RESULT_CHARS, EsQueryTool
from ..tools.rag import RagService, RagTool
from ..utils import iso_now, new_id, truncate
from .common import entity_kql, normalize_kql
from .formatter import Formatter
from .graph import run_investigation
from .investigator import (
    GUIDANCE_LIBRARY_UNAVAILABLE,
    GUIDANCE_SELECTION_FAILED,
    Investigator,
    RunbookGuidance,
    select_investigator_runbook,
)
from .personas import select_persona_with_reason
from .router import Router

if TYPE_CHECKING:  # pragma: no cover - typing only
    from ..engine.case_id import SequenceStore
    from ..stores.memory import MemoryStore
    from ..stores.tuning import TuningStore

logger = logging.getLogger("tlsoc.agents.pipeline")

# Operator-facing copy for a provider outage observed BEHIND a downstream symptom.
# The incident's cases displayed "Investigation exceeded the 120s time cap" when the
# real failure was HTTP 401 on every call, so the operator spent days on latency and
# evidence quality. A time cap reached because the provider is rejecting our
# credentials is a credential problem, and must say so.
_PROVIDER_FAILURE_CAUSE = {
    "unauthenticated": (
        "the model provider is rejecting our credentials (authentication failure)"
    ),
    "quota_exhausted": (
        "the model provider is refusing calls for quota/rate-limit reasons"
    ),
    "unavailable": "the model provider is not responding",
    "unsupported": "the configured model does not support this operation",
}

# Case spend is displayed at six decimal places.  A ledger sum can legitimately
# differ from ``round(previous_display + current_raw, 6)`` by one micro-dollar
# because the previous display value was already rounded.  This is the only
# tolerance used when proving that an all-time ledger read includes the current run.
_LEDGER_DISPLAY_EPSILON = 0.000001

#: The separator between a new case title's entity and its rules (T36: no em dash on
#: screen). Stored titles keep the separator they were written with (an em dash before
#: Round 13), so every parser of case titles accepts both
#: (``engine/demo_chat._MACHINE_TITLE_RE``).
CASE_TITLE_SEPARATOR = " \u00b7 "


# --------------------------------------------------------------------------- #
# Investigation run ids (Round 14 SPEC §4.5.3, §4.5.4). Every audit row written while
# one investigation runs (the pipeline's own rows and the router, investigator and
# formatter rows, which write through the same stamped logger) carries that run's
# ``run_id``, so the audit log's Agent activity scope can group one investigation's
# steps into one row. Each row also says who acted (``actor_type``): the AI agent, or
# the system for the deterministic actors (``case_manager``, ``analyst_policy``,
# ``poller``: code decides, never the model, #3), from the one actor table the audit
# reader uses for older rows (``audit/event_categories.json``), and how the step ended
# (``outcome``), so the Outcome column and filter work for agent activity.
# --------------------------------------------------------------------------- #
_INVESTIGATION_RUN_ID: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "investigation_run_id", default=None,
)
#: The prefix of an investigation run id (``inv-<32 hex>``), distinct from the
#: ``run-`` ids of runbook runs.
INVESTIGATION_RUN_PREFIX = "inv-"


def current_investigation_run_id() -> str | None:
    """The id of the investigation running in this task, or ``None``."""
    return _INVESTIGATION_RUN_ID.get()


# --------------------------------------------------------------------------- #
# Round 16 (SPEC §4.5 WP08): which runs are queued or running, and how each ended.
# The registry (``engine/investigation_registry.py``) is memory only; the pipeline
# registers a run before the investigation gate and ends it in a ``finally``. Nothing
# here reads the registry to decide anything (#3), and a registry error never reaches
# a run (each registry method swallows its own errors).
# --------------------------------------------------------------------------- #
_CURRENT_INVESTIGATION: contextvars.ContextVar[Any] = contextvars.ContextVar(
    "current_investigation", default=None,
)

#: ``status_history`` writers that are code, not a person: a close by one of them is
#: never reported as a person's close replaced by a run.
_MACHINE_STATUS_ACTORS = frozenset(
    {"", DecisionBy.AGENT.value, DecisionBy.SYSTEM.value, DecisionBy.ANALYST_POLICY.value, "pipeline"}
)


def _mark_run(outcome: str | None = None, case: Case | None = None) -> None:
    """Record this run's outcome and the case's status and verdict after it on the
    current registry handle. A no-op without one; never raises."""
    handle = _CURRENT_INVESTIGATION.get()
    if handle is None:
        return
    try:
        if outcome is not None:
            handle.outcome = outcome
        if case is not None:
            handle.status_after = getattr(case.status, "value", case.status)
            verdict = getattr(case, "verdict", None)
            handle.verdict_after = getattr(verdict, "value", verdict) if verdict is not None else None
    except Exception:  # noqa: BLE001 (tracking never reaches a run)
        pass


def _attach_run_case(registry: Any, case_id: str | None) -> None:
    """Tell the registry which case the current run is on (a frame when it was
    unknown). Never raises."""
    handle = _CURRENT_INVESTIGATION.get()
    if registry is None or handle is None or not case_id:
        return
    try:
        registry.attach_case(handle, case_id)
    except Exception:  # noqa: BLE001
        pass


def _parse_iso(value: Any) -> Any:
    from datetime import datetime, timezone

    try:
        parsed = datetime.fromisoformat(str(value or "").replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def replaced_close(stored: Case | None, decided: Case, *, since: Any) -> dict[str, str] | None:
    """The person's close this run's result replaced, or ``None``.

    ``stored`` is the case as re-read just before the rebuild, ``decided`` the case the
    run saved and ``since`` when the run was queued. A close counts when the stored case
    is terminal, its newest move to that status was made by a person at or after
    ``since`` (so while the run was queued or running; a case closed before the run was
    asked for, then reinvestigated, is not a replaced close), and the decided status
    differs. Reads decided values only (#3); never raises."""
    try:
        if stored is None or since is None:
            return None
        before = str(getattr(stored.status, "value", stored.status) or "")
        after = str(getattr(decided.status, "value", decided.status) or "")
        if before not in TERMINAL_CASE_STATUSES or after == before:
            return None
        entry = next(
            (e for e in reversed(stored.status_history or []) if e.to_status == before), None,
        )
        if entry is None or str(entry.by or "").strip().lower() in _MACHINE_STATUS_ACTORS:
            return None
        at = _parse_iso(entry.at)
        if at is None or at < since:
            return None
        return {"by": str(entry.by), "from_status": before, "to_status": after}
    except Exception:  # noqa: BLE001
        return None


def _note_replaced_close(stored: Case | None, decided: Case) -> None:
    """Record on the current handle a person's close this run replaced (SPEC D10)."""
    handle = _CURRENT_INVESTIGATION.get()
    if handle is None:
        return
    replaced = replaced_close(stored, decided, since=getattr(handle, "queued_at", None))
    if replaced is not None:
        try:
            handle.close_replaced = replaced
        except Exception:  # noqa: BLE001
            pass


class CaseLocks:
    """Process-local per-case write locks (Round 16 SPEC §4.5 WP08, research R11).

    A rebuild reads the stored case, then saves the whole document; a person's action
    does the same. Holding one lock per case id across read and save keeps one writer
    from erasing the other's work. A ``WeakValueDictionary`` bounds it, as the signature
    locks are bounded: a lock exists only while someone holds a reference to it.

    Lock order: the pipeline (and ``engine.ingest.attach_cluster``) takes a case lock
    only INSIDE the cluster's signature lock; a person's action takes the case lock
    alone. No path holds a case lock while it waits for a signature lock."""

    def __init__(self) -> None:
        self._locks: "weakref.WeakValueDictionary[str, asyncio.Lock]" = weakref.WeakValueDictionary()

    def lock(self, case_id: str) -> asyncio.Lock:
        key = str(case_id or "")
        lock = self._locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[key] = lock
        return lock

    def clear(self) -> None:
        """Forget every lock (factory reset, after every writer task was cancelled)."""
        self._locks.clear()

    def __len__(self) -> int:
        return len(self._locks)


class _CaseWriteHold:
    """One run's hold on its case lock: idempotent :meth:`hold` and :meth:`release`, so
    the success path, the failure path and the ``finally`` can each call them."""

    __slots__ = ("_lock", "_held")

    def __init__(self, lock: asyncio.Lock) -> None:
        self._lock = lock
        self._held = False

    async def hold(self) -> None:
        if not self._held:
            await self._lock.acquire()
            self._held = True

    def release(self) -> None:
        if self._held:
            self._held = False
            self._lock.release()


def audit_actor_type(actor: str) -> str:
    """``system`` for a deterministic actor of the audit actor table, else ``agent``."""
    try:
        from ..audit.events import TABLE

        if actor in TABLE.system_actors:
            return "system"
    except Exception:  # noqa: BLE001 (an unreadable table never blocks an audit row)
        pass
    return "agent"


def default_audit_outcome(action_type: Any) -> str:
    """The outcome of a pipeline row whose writer names none (Round 14 SPEC §4.5.3:
    ``outcome`` is written by every writer): the outcome the audit reader derives for
    that action type on a row without one (``failure`` for ``error``, ``denied`` for
    ``access_denied``: the one table, :data:`app.audit.events.DERIVED_OUTCOMES`), so a
    stamped row never reads differently from an unstamped one; otherwise ``success``,
    because every other pipeline row records a step that happened. A writer whose step
    can fail, stop short or be refused names its own outcome (a tool call that
    returned an error, a capped verdict, a blocked tool)."""
    value = getattr(action_type, "value", action_type)
    return DERIVED_OUTCOMES.get(str(value or ""), "success")


class RunStampedAudit:
    """The pipeline's audit logger: delegates every call, and stamps each appended row
    with the current investigation's ``run_id``, the actor's kind and, when the writer
    names none, the outcome (:func:`default_audit_outcome`). A caller that sets any of
    these fields keeps its own value."""

    __slots__ = ("_inner",)

    def __init__(self, inner: Any) -> None:
        self._inner = inner

    @property
    def inner(self) -> Any:
        return self._inner

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)

    @staticmethod
    def _stamp(fields: dict[str, Any]) -> dict[str, Any]:
        if fields.get("actor_type") is None:
            fields["actor_type"] = audit_actor_type(str(fields.get("actor") or ""))
        if fields.get("outcome") is None:
            fields["outcome"] = default_audit_outcome(fields.get("action_type"))
        run_id = _INVESTIGATION_RUN_ID.get()
        if run_id is not None and fields.get("run_id") is None:
            fields["run_id"] = run_id
        return fields

    async def record(self, **fields: Any) -> Any:
        return await self._inner.record(**self._stamp(fields))

    async def record_strict(self, **fields: Any) -> Any:
        return await self._inner.record_strict(**self._stamp(fields))


def machine_case_title(cluster: Cluster) -> str:
    """The title of a case the pipeline writes: ``<entity type>:<value> · <rules>``."""
    rules = ", ".join(cluster.rule_values) or "activity"
    return f"{cluster.entity.type.value}:{cluster.entity.value}{CASE_TITLE_SEPARATOR}{rules}"


# --------------------------------------------------------------------------- #
# Runbooks in the agent path (Round 14 SPEC §4.10.4, §4.10.9)
# --------------------------------------------------------------------------- #
#: Provides the matchable runbook catalog at investigation time: an awaitable that
#: returns ``engine.runbook_runs.RunbookCatalog`` (its ``matchable`` is used) or an
#: iterable of ``engine.runbook_match.MatchableRunbook``. A read failure raises; the
#: investigation then runs with no runbook (fail closed, never an incomplete catalog).
RunbookCatalogProvider = Callable[[], Awaitable[Any]]
#: Attaches the matching runbook to a case the pipeline left needing a person (the
#: post-investigation trigger of §4.10.4). Never awaited for its result.
RunbookAttacher = Callable[[Case], Awaitable[Any]]
# Round 15 (SPEC D6.3): ``engine.auto_close_review.ReviewSampler`` in production.
ReviewSamplerHook = Callable[[Case, Preferences], Awaitable[Any]]


def builtin_runbook_catalog() -> tuple[Any, ...]:
    """The matchable catalog of the bundled library alone (package data, cached).
    The default when the pipeline is built without a catalog provider (direct
    constructions and tests): no operator runbook, nothing to read, nothing to fail."""
    from ..engine.runbook_match import MatchableRunbook, matchable_catalog
    from ..engine.runbook_model import load_builtin_runbooks

    builtins = [
        MatchableRunbook(id=b.id, version=b.version, definition=b.definition, origin="builtin")
        for b in load_builtin_runbooks()
    ]
    return matchable_catalog(builtins, ())


def _matchable(catalog: Any) -> tuple[Any, ...]:
    """The matchable entries of a provider's answer (a ``RunbookCatalog`` or an
    iterable of ``MatchableRunbook``)."""
    entries = getattr(catalog, "matchable", catalog)
    if not isinstance(entries, Iterable):
        raise TypeError("a runbook catalog provider returned no matchable entries")
    return tuple(entries)


def source_type_map(prefs: Preferences) -> dict[str, str]:
    """Each configured source id to its ``SourceType`` value, so a runbook's
    ``type:<SourceType>`` criterion can match (it fails without the map)."""
    out: dict[str, str] = {}
    for source in getattr(prefs, "sources", None) or []:
        raw = getattr(source, "source_type", None)
        value = getattr(raw, "value", raw)
        if getattr(source, "id", None) and value:
            out[str(source.id)] = str(value)
    return out


def cluster_severity_band(cluster: Cluster, existing: Case | None, prefs: Preferences) -> str:
    """The severity band the case built from ``cluster`` will show (the one shared
    helper ``engine.priority.band_of_case``, on the source's declared ladder), read
    from the same trigger, source and risk the case is assembled with. Advisory only;
    never read by ``decide()`` (#3)."""
    view = SimpleNamespace(
        severity_band=None,
        trigger_reason=_trigger(existing, cluster),
        source_id=_source_id(existing, cluster),
        risk_score=cluster.risk_score,
    )
    return band_of_case(view, prefs)


# Distinguishes the legacy/default primary query surface from an explicit ``None``.
# ``None`` means the originating source is push-only and MUST NOT inherit another
# source's read tool.
_DEFAULT_QUERY_SOURCE = object()


class InvestigationPipeline:
    def __init__(
        self,
        es: BaseESClient,
        secrets: Secrets,
        cache: Cache,
        gateway: LLMGateway,
        rag_service: RagService,
        cases: CaseStore,
        audit: AuditLogger,
        source: PullConnector | None = None,
        playbooks: Any = None,
        memory: "MemoryStore | None" = None,
        tuning_store: "TuningStore | None" = None,
        seq_store: "SequenceStore | None" = None,
        notifier: Any = None,
        automation: Any = None,
        event_bus: Any = None,
        investigation_gate: Any = None,
        mutation_task_spawner: Any = None,
        fixture_sink: Callable[[dict[str, Any]], Awaitable[None]] | None = None,
        runbook_catalog: RunbookCatalogProvider | None = None,
        runbook_attacher: RunbookAttacher | None = None,
        review_sampler: ReviewSamplerHook | None = None,
        investigation_registry: Any = None,
        case_locks: CaseLocks | None = None,
    ) -> None:
        self._es = es
        # Round 16 (SPEC §4.5 WP08): the memory-only run registry (None: untracked, as
        # the replay stack and direct constructions are; post-settable) and the per-case
        # write locks, shared with the person's case actions (AppState passes one
        # registry to the real and Demo pipelines).
        self.investigation_registry = investigation_registry
        self._case_locks = case_locks if case_locks is not None else CaseLocks()
        # The agent's read-only log surface. Defaults to wrapping ``es`` in an
        # ElasticConnector (full back-compat) so a direct construction without a
        # source keeps working; state wiring injects the configured connector.
        self._source = source or ElasticConnector(es)
        self._secrets = secrets
        self._cache = cache
        self._gateway = gateway
        self._rag = rag_service
        self._cases = cases
        # Round 14: every row the pipeline, router, investigator and formatter write
        # carries the run id and actor kind (see ``RunStampedAudit``).
        self._audit = audit if isinstance(audit, RunStampedAudit) else RunStampedAudit(audit)
        self._router = Router(gateway, self._audit)
        # ``playbooks`` (the retired Markdown procedure registry) is accepted and
        # IGNORED: Round 14 replaced it with the runbook catalog below. It stays a
        # keyword only so a caller that still passes it keeps constructing.
        del playbooks
        # The matchable runbook catalog (Round 14 SPEC §4.10.9): built-ins plus every
        # live operator version, read once per investigation. None → the bundled
        # library alone (``builtin_runbook_catalog``).
        self.runbook_catalog = runbook_catalog
        # The post-investigation attachment trigger (§4.10.4): called after the
        # deterministic decision is saved; the attacher itself decides whether the
        # case needs a person. Post-settable, like ``notifier`` and ``automation``.
        # None → no attachment (direct constructions and tests).
        self.runbook_attacher = runbook_attacher
        # Round 15 (SPEC D6.3): the auto-close review sampler, called once per run
        # after every other post-decision hook, for a terminal case the agent decided.
        # It reads the decided case and never changes it (#3). Post-settable, like
        # ``runbook_attacher``; None (the replay stack, direct constructions) samples
        # nothing.
        self.review_sampler = review_sampler
        # Operator MEMORY store (durable trusted facts auto-injected into every
        # investigation). None → no memory injected (today's behaviour).
        self._memory = memory
        # Adaptive tuning is DETECTION-THRESHOLD configuration, never model
        # fine-tuning and never the deterministic close/escalate authority.  The
        # optional ledger is read only to snapshot the exact active threshold(s)
        # that this cluster traversed; that append-only audit snapshot lets the UI
        # explain historical cases even after a later tune or rollback.
        self._tuning_store = tuning_store
        # Case-number sequence store (F7). None → case_number stays "" and the UI
        # falls back to case_id (today's behaviour).
        self._seq_store = seq_store
        # Optional fire-and-forget notification dispatcher (F5 / Wave 4). Round 5
        # (Coupling-F): promoted to an optional CTOR kwarg (still assignable after
        # construction — AppState sets it once the dispatcher is built). None → no
        # notifications (today's behaviour). It is called ONLY after apply()+save and
        # never alters the case decision (#3).
        self.notifier = notifier
        # Optional threshold-automation executor (F10 / Wave 6). Round 5: promoted to an
        # optional CTOR kwarg (still post-settable). None → no automation (today's
        # behaviour). It runs ONLY after apply()+save and may ONLY tag/recommend/notify/
        # queue a re-investigation/open a HITL Proposal — never sets status/disposition (#3).
        self.automation = automation
        # Optional realtime EventBus for live ``agent.step`` progress frames (Round-3
        # Wave-4). Round 5: promoted to an optional CTOR kwarg (still post-settable).
        # DEFAULT None → resolved lazily from the module singleton so this works with
        # zero integrator wiring (mirrors AppState.event_bus); set explicitly only to
        # inject a test/alternate bus. Publishing is ALWAYS best-effort + fully isolated:
        # it NEVER changes decide()/the ledger and a bus error can never break the
        # pipeline (#3/#11). When realtime is disabled nobody subscribes and publish is a
        # cheap history-only no-op.
        self.event_bus = event_bus
        # Process-wide permit shared by poller, push ingest, manual work and durable
        # jobs. None preserves direct-construction compatibility in extension tests.
        self._investigation_gate = investigation_gate
        # AppState-owned detached-task registry. Direct constructions keep the old
        # create_task fallback; production injects a spawner that factory reset can
        # cancel/await before it clears tenant state.
        self._mutation_task_spawner = mutation_task_spawner
        # OBSERVATIONAL forward capture of frozen investigation fixtures for the replay
        # harness. Default None → behaviour is byte-identical to before. It is invoked
        # once per investigated cluster, AFTER deterministic risk and BEFORE any model
        # call, so a fixture can never encode the outcome a replay is meant to measure;
        # it is fully error-isolated, reads nothing the decision depends on, and writes
        # nothing onto the case (#3).
        self._fixture_sink = fixture_sink
        # Per-cluster-signature locks (Round-4 harden). The poller fan-out
        # (:class:`PollerManager`) runs per-source pollers CONCURRENTLY, so two ticks /
        # sources correlating the SAME cluster signature could both run the
        # ``find_open_by_signature → save`` critical section interleaved and each mint a
        # NEW case for that signature (breaking #4 — one open case per signature). These
        # locks serialize that critical section PER SIGNATURE (never globally), so only
        # one create-or-attach for a given signature is ever in flight. Lazily created;
        # granularity is per-signature so unrelated signatures still run in parallel.
        # This is a SHARED instance so every caller of this ONE pipeline (poller fan-out,
        # push-ingest, manual investigate) contends on the same lock for a signature.
        # A WeakValueDictionary bounds the registry (audit #42): the lock only needs to
        # exist while a create-or-attach for that signature is IN FLIGHT (a caller holds a
        # strong ref through its ``async with``); once no caller holds it, it is GC'd, so a
        # long-running process no longer accumulates a lock per distinct signature forever.
        self._sig_locks: "weakref.WeakValueDictionary[str, asyncio.Lock]" = (
            weakref.WeakValueDictionary()
        )

    def signature_lock(self, signature: str) -> asyncio.Lock:
        """Return the shared :class:`asyncio.Lock` for ``signature`` (created lazily).

        Held around the ``find_open_by_signature → save`` critical section by
        ``investigate_cluster`` / ``register_candidate`` (and by ``ingest.handle_clusters``
        via this same registry) so two concurrent per-source pollers correlating the SAME
        signature cannot both create a case (#4). Per-signature granularity means
        different signatures never block each other. Creation is safe under the single
        event-loop model (no ``await`` between the membership check and the insert)."""
        lock = self._sig_locks.get(signature)
        if lock is None:
            lock = asyncio.Lock()
            self._sig_locks[signature] = lock
        return lock

    def case_lock(self, case_id: str) -> asyncio.Lock:
        """The shared per-case write lock (:class:`CaseLocks`). The pipeline takes it
        only inside the cluster's signature lock, from the re-read of the stored case
        to its save."""
        return self._case_locks.lock(case_id)

    def _emit_step(
        self, case_id: str, step: str, *, status: str = "running",
        detail: str = "", extra: dict | None = None,
    ) -> None:
        """Publish ONE ``agent.step`` frame to the per-case room (``cases:{case_id}``)
        so the Wave-4 case-detail EventSource can render investigation progress live.

        ADDITIVE + BEST-EFFORT + NON-BLOCKING: this is a pure transport nudge that runs
        ALONGSIDE the deterministic flow — it reads nothing the decision depends on and
        writes nothing onto the case. The decision is produced solely by
        ``case_manager.apply()``; these frames only NARRATE the steps. The whole thing
        is wrapped so a bus error (or a missing bus) can never break the pipeline
        (#3/#11). ``detail`` is a SHORT, already-render-safe label (a persona/runbook
        id, a verdict enum, a status word) — never raw log/AI text (#9; the UI escapes
        it regardless)."""
        # Round 16 (WP08): the run's phase, served by GET /api/investigations/active
        # and carried on its next frame. No frame of its own; never raises.
        registry = self.investigation_registry
        if registry is not None:
            registry.phase(_CURRENT_INVESTIGATION.get(), step)
        try:
            bus = self.event_bus
            from ..realtime import AGENT_STEP_EVENT, get_event_bus

            if bus is None:
                bus = get_event_bus()
            if bus is None or not case_id:
                return
            payload: dict = {"case_id": case_id, "step": step, "status": status}
            if detail:
                payload["detail"] = truncate(str(detail), 200)
            if extra:
                payload.update(extra)
            # The channel name comes from the ONE registry in ``realtime`` — a literal
            # here is exactly how the client and the producer drifted apart before
            # (the client listened on ``agent``, which nothing ever published).
            bus.publish(f"cases:{case_id}", AGENT_STEP_EVENT, payload)
        except Exception as exc:  # noqa: BLE001 — realtime is advisory; never break the flow
            logger.debug("agent.step publish skipped for %s: %s", case_id, exc)

    def _build_investigator(
        self,
        prefs: Preferences,
        query_source: PullConnector | None | object = _DEFAULT_QUERY_SOURCE,
    ) -> tuple[Investigator, EnrichTool]:
        """Build the tool-using investigator for the originating log source.

        ``query_source`` is supplied by each per-source poller.  Falling back to the
        primary source preserves manual/single-source compatibility, while the
        explicit override prevents an alert from source B being investigated with
        source A's read-only query tool.
        """
        enrich = EnrichTool(self._secrets, prefs, self._cache)
        effective_source = self._source if query_source is _DEFAULT_QUERY_SOURCE else query_source
        tools = [enrich, RagTool(self._rag)]
        if effective_source is not None:
            # The investigator hands the whole tool result to a model, so its rows
            # are budgeted; Chat's are not (they are an operator table + facets).
            tools.insert(0, EsQueryTool(
                effective_source, prefs, max_result_chars=DEFAULT_MAX_RESULT_CHARS,
            ))
        registry = ToolRegistry(tools)
        formatter = Formatter(self._gateway, self._audit)
        investigator = Investigator(self._gateway, registry, self._audit, formatter)
        return investigator, enrich

    async def _capture_fixture(
        self,
        cluster: Cluster,
        enrichment: EnrichmentResult | None,
        prefs: Preferences,
        *,
        case_id: str,
        source_surface: SourceSurface,
    ) -> None:
        """Hand one frozen-fixture candidate to the optional capture sink.

        This is the single point every investigated cluster from every surface passes
        through with the cluster, the enrichment result and the resolved risk all
        final and no model yet called. The RESOLVED evidence projection travels with
        it because ``render_cluster`` otherwise re-resolves it from whatever
        Preferences are live at replay time — an operator edit between capture and
        replay would silently change what the model sees.

        Best-effort and never raises: capture is observational, so a sink failure
        must leave the case byte-identical to a run with no sink at all."""
        sink = self._fixture_sink
        if sink is None:
            return
        try:
            from ..engine.replay.fixtures import source_field_mapping

            source_ids = cluster.contributing_source_ids()
            await sink({
                "cluster": cluster.model_dump(mode="json"),
                "enrichment": (
                    enrichment.model_dump(mode="json") if enrichment is not None else None
                ),
                "evidence_fields": list(prefs.evidence_fields_for(source_ids)),
                "evidence_max_chars": int(prefs.evidence_budget_for(source_ids)),
                # The capturing source's effective FIELD MAPPING. Without it a replay
                # reads the frozen records under the global ECS defaults, so a non-ECS
                # source's investigator would query the wrong time/entity fields and
                # see an empty log surface where production saw real evidence.
                "field_mapping": source_field_mapping(prefs, source_ids),
                "origin_case_id": case_id,
                "source_surface": source_surface.value,
            })
        except Exception as exc:  # noqa: BLE001 — capture is observational
            logger.debug(
                "replay fixture capture skipped for %s: %s", cluster.signature, exc
            )

    def _maybe_notify(self, case: Case) -> None:
        """Schedule a fire-and-forget notification for a freshly-saved case (#3-safe).

        Detached via ``asyncio.create_task`` so it never blocks/awaits in the case
        path; ``NotificationService.notify`` swallows every error. A no-op when no
        notifier is wired / notifications are disabled. NEVER raises."""
        notifier = getattr(self, "notifier", None)
        if notifier is None:
            return
        try:
            import asyncio

            # Pass fetch=get so the detached task merges notifications_sent onto the
            # FRESH case, never clobbering a concurrent analyst edit (audit #28).
            coro = notifier.notify(case, save=self._cases.save, fetch=self._cases.get)
            if self._mutation_task_spawner is not None:
                self._mutation_task_spawner(
                    coro, name=f"case-notify:{case.case_id}"
                )
            else:
                asyncio.create_task(coro)
        except Exception as exc:  # noqa: BLE001 — must never affect the case flow
            logger.debug("notification scheduling skipped: %s", exc)

    async def _maybe_automate(self, case: Case, prefs: Preferences) -> None:
        """Run post-decision threshold automation for a freshly-saved case (#3-safe).

        A no-op when no automation executor is wired / automation is disabled. The
        executor itself is error-isolated; this wrapper double-guards so a failure can
        NEVER break the case path. It NEVER sets case.status/disposition."""
        automation = getattr(self, "automation", None)
        if automation is None:
            return
        try:
            # fetch=get: automation merges its own changes onto the case as stored
            # when it saves, never a copy read before a notify send (Round 16 B08).
            await automation.run(case, prefs, save=self._cases.save, fetch=self._cases.get)
        except Exception as exc:  # noqa: BLE001 — automation must never affect the case flow
            logger.warning("threshold automation skipped for %s: %s", case.case_id, exc)

    async def _select_runbook(
        self, cluster: Cluster, existing: Case | None, prefs: Preferences
    ) -> RunbookGuidance:
        """The runbook that guides this investigation (Round 14 SPEC §4.10.9).

        Reads the matchable catalog once (the provider, else the bundled library) and
        runs the pure matcher over the cluster's facts, with the stored case's tags on
        a re-investigation (a new cluster has no case, so its tags stay pending).
        Never raises: a catalog that cannot be read gives no runbook
        (``library_unavailable``), never a partial catalog in which a built-in an
        operator copy replaces could stand in for that copy; a failure while choosing
        from a catalog that was read gives no runbook either (``selection_failed``),
        so the audit trail says which of the two happened (#2). Advisory only (#3)."""
        try:
            if self.runbook_catalog is None:
                catalog = builtin_runbook_catalog()
            else:
                catalog = _matchable(await self.runbook_catalog())
        except Exception as exc:  # noqa: BLE001 - guidance is advisory; never break the flow
            logger.warning(
                "Runbook catalog unavailable for %s (%s); investigating without a runbook",
                cluster.signature, exc,
            )
            return RunbookGuidance.none(GUIDANCE_LIBRARY_UNAVAILABLE)
        try:
            return select_investigator_runbook(
                cluster, prefs, catalog,
                severity=cluster_severity_band(cluster, existing, prefs),
                source_types=source_type_map(prefs),
                tags=(list(existing.tags or []) if existing is not None else None),
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "Runbook selection failed for %s (%s); investigating without a runbook",
                cluster.signature, exc,
            )
            return RunbookGuidance.none(GUIDANCE_SELECTION_FAILED)

    async def _maybe_attach_runbook(self, case: Case) -> None:
        """The post-investigation attachment trigger (Round 14 SPEC §4.10.4).

        Runs AFTER the deterministic decision is applied and saved, so it only ever
        reads a decided case and can never feed ``decide()`` (#3). The attacher
        (``engine.runbook_runs.reevaluate_case`` in production) attaches the matching
        runbook when the decision left the case needing a person, and never to an
        automatic close (including one waiting out its objection window); it is
        idempotent per case and runbook (#4), so a re-investigation never makes a
        second run. A no-op when no attacher is wired. Never raises."""
        attacher = self.runbook_attacher
        if attacher is None:
            return
        try:
            await attacher(case)
        except Exception as exc:  # noqa: BLE001 - attachment never affects the case path
            logger.warning("runbook attachment skipped for %s: %s", case.case_id, exc)

    async def _maybe_sample_review(self, case: Case, prefs: Preferences) -> None:
        """The auto-close review sample (Round 15 SPEC D6.3): hands a terminal case the
        agent decided to ``review_sampler``, which picks a small random, capped share
        of them for a person to review. Runs after ``apply()``, the save and every other
        post-decision hook, so it only reads a decided case (#3). A no-op without a
        sampler (the replay stack) and for any other case. Never raises."""
        sampler = self.review_sampler
        if sampler is None:
            return
        try:
            from ..constants import TERMINAL_CASE_STATUSES

            if case.decision_by != DecisionBy.AGENT:
                return
            if not case.status or case.status.value not in TERMINAL_CASE_STATUSES:
                return
            await sampler(case, prefs)
        except Exception as exc:  # noqa: BLE001 - sampling never affects the case path
            logger.warning("auto-close review sampling skipped for %s: %s", case.case_id, exc)

    async def _maybe_index_resolved(self, case: Case) -> None:
        """Best-effort: index a terminal (closed/resolved) case into the RAG corpus
        as institutional memory (F11). OUTSIDE the decision logic — a failure never
        blocks/raises. The RagService method is itself gated + fail-safe."""
        try:
            from ..constants import TERMINAL_CASE_STATUSES

            if case.status and case.status.value in TERMINAL_CASE_STATUSES:
                await self._rag.index_resolved_case(case)
        except Exception as exc:  # noqa: BLE001 — knowledge loop is best-effort
            logger.debug("resolved-case indexing skipped for %s: %s", case.case_id, exc)

    async def _allocate_case_number(
        self, existing: Case | None, cluster: Cluster, prefs: Preferences
    ) -> str:
        """Render a human-facing display id (F7) for a NEW case, preserving an
        existing case's number on re-investigation. Returns "" when the feature is
        disabled / no sequence store is wired (the UI then falls back to case_id).
        Never raises — a numbering glitch must never break case creation."""
        if existing is not None and existing.case_number:
            return existing.case_number
        fmt = getattr(prefs, "case_id_format", None)
        if not fmt or not getattr(fmt, "enabled", False) or self._seq_store is None:
            return ""
        try:
            from ..engine.case_id import allocate_case_number

            return await allocate_case_number(self._seq_store, fmt, source=cluster.source_name or "")
        except Exception as exc:  # noqa: BLE001 — numbering must never break creation
            logger.warning("Case-number allocation failed (%s); falling back to case_id", exc)
            return ""

    async def _latest_stored_case(self, case_id: str, existing: Case | None) -> Case | None:
        """The stored case as it stands now, read again just before a rebuild (Round 15
        SPEC D6.10).

        ``existing`` is read when the run begins, and the run (router, investigator and
        tool calls) can last up to ``caps.timeout_seconds``. A person may acknowledge,
        assign, comment on, grade, tag or close the case meanwhile, and the case stores
        write the whole document, so a rebuild from the copy read at the start would
        silently erase that work. The rebuild therefore starts from the latest stored copy,
        and :func:`_carry_case_work` carries the work from it.

        A case a person closed during the run is rebuilt like any other: the run's new
        events are never dropped, the person's close stays on the carried timeline, and
        the appended transition names it as the previous status.

        A new case (``existing`` is None) reads nothing. A read that fails, or that finds no
        case, keeps ``existing``. Never raises; the rebuilt verdict, confidence and risk
        come from this run, never from the stored copy (#3)."""
        if existing is None:
            return None
        try:
            latest = await self._cases.get(case_id)
        except Exception as exc:  # noqa: BLE001 (the rebuild must never fail on this read)
            logger.warning(
                "Re-reading case %s before its rebuild failed (%s); using the copy read "
                "when the run began", case_id, exc,
            )
            return existing
        return latest if isinstance(latest, Case) else existing

    async def _platform_tuning_snapshot(
        self, cluster: Cluster, prefs: Preferences
    ) -> dict[str, Any]:
        """Snapshot adaptive thresholds actually present on this cluster's path.

        This is explainability-only.  It reads the active tuning ledger and the
        already-computed cluster/config; it never mutates a threshold, risk, verdict,
        or case route.  Matching is deliberately strict so the UI never claims a
        tenant-wide tune affected an unrelated case:

        * ``correlation_n`` must match a threshold-mode primary trigger AND the
          ``n`` recorded in ``TriggerReason``;
        * ``severity_floor`` must match a contributing ``source:feed`` AND the
          current per-feed floor used by ingestion.

        Ledger availability is explicit.  An unavailable store is not silently
        presented as "no tuning".
        """
        if self._tuning_store is None:
            return {"status": "not_recorded", "records": []}
        try:
            entries = await self._tuning_store.list_strict(active_only=True)
        except Exception as exc:  # noqa: BLE001 — provenance is advisory/fail-open
            logger.warning("Loading platform-tuning provenance failed (%s)", exc)
            return {"status": "unavailable", "records": []}

        trigger = cluster.trigger_reason
        primary_rule = (trigger.rule_value if trigger and trigger.rule_value else None)
        trigger_n = int(trigger.n) if trigger and trigger.n else None
        trigger_mode = str(trigger.mode if trigger and trigger.mode else "")

        # Preserve the source/feed PAIR carried by each member.  ``source_ids`` and
        # ``feed_ids`` are independently de-duplicated lists, so taking their cross
        # product can falsely attribute ``source-a:feed-b`` when feed-b actually came
        # from source-b.  Older clusters may not retain member-level provenance; only
        # fall back to the aggregate feed list when exactly one source contributed.
        contributing_sources = set(cluster.source_ids or [])
        if cluster.source_id:
            contributing_sources.add(cluster.source_id)
        exact_feed_pairs: set[tuple[str, str]] = set()
        sole_source = next(iter(contributing_sources)) if len(contributing_sources) == 1 else ""
        for event in cluster.member_events or []:
            event_source = str(event.source_id or sole_source or "")
            event_feed = str(event.feed_id or "")
            if event_source and event_feed:
                exact_feed_pairs.add((event_source, event_feed))
        if not exact_feed_pairs and sole_source:
            exact_feed_pairs.update(
                (sole_source, str(feed_id))
                for feed_id in (cluster.feed_ids or [])
                if str(feed_id)
            )

        feed_floors: dict[str, int] = {}
        if exact_feed_pairs:
            for source in prefs.sources:
                if source.id not in {source_id for source_id, _ in exact_feed_pairs}:
                    continue
                try:
                    feeds = source.feeds()
                except Exception:  # noqa: BLE001 — malformed source stays isolated
                    continue
                for feed in feeds:
                    if (
                        (source.id, feed.id) in exact_feed_pairs
                        and feed.severity_floor is not None
                    ):
                        feed_floors[f"{source.id}:{feed.id}"] = int(feed.severity_floor)

        snapshots: list[dict[str, Any]] = []
        seen: set[tuple[str, str]] = set()
        for record in entries:  # newest first; keep one effective record per knob
            target = str(getattr(record, "target", "") or "")
            rule_id = str(getattr(record, "rule_id", "") or "")
            key = (target, rule_id)
            if target not in {"correlation_n", "severity_floor"} or not rule_id or key in seen:
                continue
            # Only the newest active ledger row for a knob can describe its current
            # provenance.  A newer non-matching row means the older value is stale;
            # do not skip past it and accidentally resurrect historical attribution.
            seen.add(key)
            after = int(getattr(record, "after", 0) or 0)
            applies = False
            if target == "correlation_n":
                applies = bool(
                    trigger_mode == "threshold"
                    and primary_rule
                    and rule_id == primary_rule
                    and trigger_n == after
                )
            elif target == "severity_floor":
                applies = rule_id in feed_floors and feed_floors[rule_id] == after
            if not applies:
                continue
            snapshots.append({
                "record_id": str(getattr(record, "id", "") or ""),
                "target": target,
                "rule_id": rule_id,
                "before": int(getattr(record, "before", 0) or 0),
                "after": after,
                "applied_at": str(getattr(record, "applied_at", "") or ""),
                "rationale": truncate(str(getattr(record, "rationale", "") or ""), 300),
            })
        return {"status": "recorded", "records": snapshots}

    async def investigate_cluster(
        self,
        cluster: Cluster,
        source_surface: SourceSurface,
        prefs: Preferences,
        *,
        force: bool = False,
        query_source: PullConnector | None | object = _DEFAULT_QUERY_SOURCE,
        investigation_priority: str = "ingest",
        trigger: str = "automatic",
        requested_by: str | None = None,
        known_case_id: str | None = None,
        target_case_id: str | None = None,
        run_id: str | None = None,
    ) -> Case:
        """Investigate a cluster into a case. The ``find_open_by_signature → save``
        critical section is serialized PER SIGNATURE (:meth:`signature_lock`) so two
        concurrent per-source pollers correlating the SAME signature never both mint a
        case (#4). Different signatures still run concurrently.

        Round 16 (SPEC §4.5 WP08), all defaulted: ``trigger`` (``automatic``,
        ``manual``, ``job``, ``drain``, ``detection``) and ``requested_by`` say who asked,
        for the run registry; ``known_case_id`` is the case the caller expects the run
        on; ``target_case_id`` is the case a person asked to reinvestigate, updated in
        place even when it is closed (unless an open case holds its signature);
        ``run_id`` is the run's id, minted when absent (the audit rows carry it)."""
        async with self.signature_lock(cluster.signature):
            return await self._investigate_cluster_locked(
                cluster, source_surface, prefs,
                force=force,
                query_source=query_source,
                investigation_priority=investigation_priority,
                trigger=trigger, requested_by=requested_by, known_case_id=known_case_id,
                target_case_id=target_case_id, run_id=run_id,
            )

    async def _investigate_cluster_locked(
        self,
        cluster: Cluster,
        source_surface: SourceSurface,
        prefs: Preferences,
        *,
        force: bool = False,
        query_source: PullConnector | None | object = _DEFAULT_QUERY_SOURCE,
        investigation_priority: str = "ingest",
        trigger: str = "automatic",
        requested_by: str | None = None,
        known_case_id: str | None = None,
        target_case_id: str | None = None,
        run_id: str | None = None,
    ) -> Case:
        gate = self._investigation_gate
        cap = max(1, int(getattr(prefs.caps, "max_concurrent", 3)))
        run_id = run_id or new_id(INVESTIGATION_RUN_PREFIX)
        # Round 16 (SPEC §4.5 WP08): register the run before the gate and end it in the
        # ``finally``, whatever way the run ends. A queued frame only when the gate is
        # full. The registry never raises into the run and never feeds a decision (#3).
        registry = self.investigation_registry
        handle = None
        if registry is not None:
            handle = registry.begin(
                run_id=run_id, signature=cluster.signature, case_id=known_case_id,
                trigger=trigger, requested_by=requested_by,
                announce_queued=bool(gate is not None and gate.active >= cap),
            )
        token = _CURRENT_INVESTIGATION.set(handle)
        try:
            if gate is None:
                if handle is not None:
                    registry.started(handle, time_cap_seconds=prefs.caps.timeout_seconds)
                case = await self._investigate_cluster_effect(
                    cluster, source_surface, prefs,
                    force=force, query_source=query_source, run_id=run_id,
                    trigger=trigger, known_case_id=known_case_id, target_case_id=target_case_id,
                )
            else:
                async with gate.permit(
                    cap, "background" if investigation_priority == "background" else "ingest",
                ):
                    if handle is not None:
                        registry.started(handle, time_cap_seconds=prefs.caps.timeout_seconds)
                    case = await self._investigate_cluster_effect(
                        cluster, source_surface, prefs,
                        force=force, query_source=query_source, run_id=run_id,
                        trigger=trigger, known_case_id=known_case_id,
                        target_case_id=target_case_id,
                    )
            if handle is not None and handle.outcome is None:
                _mark_run("decided", case)
            return case
        except asyncio.CancelledError:
            _mark_run("cancelled")
            raise
        except Exception:
            # Only the fail-to-human persistence error (or a failed case lookup, B10)
            # leaves a run with an exception: the case was not saved.
            _mark_run("failed")
            raise
        finally:
            if handle is not None:
                registry.end(handle, outcome=handle.outcome or "failed")
            _CURRENT_INVESTIGATION.reset(token)

    async def _investigate_cluster_effect(
        self,
        cluster: Cluster,
        source_surface: SourceSurface,
        prefs: Preferences,
        *,
        force: bool = False,
        query_source: PullConnector | None | object = _DEFAULT_QUERY_SOURCE,
        run_id: str | None = None,
        trigger: str = "automatic",
        known_case_id: str | None = None,
        target_case_id: str | None = None,
    ) -> Case:
        # One investigation run: every audit row until it returns carries its id (the
        # same id the run registry serves, Round 16 WP08).
        run_token = _INVESTIGATION_RUN_ID.set(run_id or new_id(INVESTIGATION_RUN_PREFIX))
        try:
            return await self._investigate_cluster_run(
                cluster, source_surface, prefs,
                force=force, query_source=query_source,
                trigger=trigger, known_case_id=known_case_id, target_case_id=target_case_id,
            )
        finally:
            _INVESTIGATION_RUN_ID.reset(run_token)

    async def _investigate_cluster_run(
        self,
        cluster: Cluster,
        source_surface: SourceSurface,
        prefs: Preferences,
        *,
        force: bool = False,
        query_source: PullConnector | None | object = _DEFAULT_QUERY_SOURCE,
        trigger: str = "automatic",
        known_case_id: str | None = None,
        target_case_id: str | None = None,
    ) -> Case:
        registry = self.investigation_registry
        # Round 16 (SPEC D10): a deferred candidate's drain run re-reads its case inside
        # the signature lock, after the gate. A candidate a person closed or moved while
        # the run waited is returned as stored and never re-run: a close made meanwhile
        # would otherwise miss the open-case lookup below and mint a second case for the
        # same events. New events after a close still open a new case (``handle_clusters``
        # passes no known case, #4).
        if trigger == "drain" and known_case_id and not force:
            stored = await self._cases.get(known_case_id)
            if stored is not None and (
                str(getattr(stored.status, "value", stored.status)) not in OPEN_CASE_STATUSES
                or stored.decision_by == DecisionBy.ANALYST
            ):
                _attach_run_case(registry, stored.case_id)
                _mark_run("unchanged", stored)
                await self._audit.record(
                    action_type=ActionType.DECISION, surface=source_surface.value,
                    actor="pipeline", case_id=stored.case_id,
                    result_summary=(
                        "the candidate was closed or moved by a person before its deferred "
                        "run started; not investigated"
                    ),
                )
                return stored
        # The case identity is known BEFORE the run's failure boundary (Round 16 B10):
        # a lookup that fails (a store timeout) propagates to the caller's retry
        # boundary (the poll tick is not committed, a pushed batch is retried, a person
        # sees an error) instead of minting a second open case for this signature (#4).
        existing: Case | None = await find_open_case_for_cluster(self._cases, cluster)
        # Round 16 (SPEC §4.5 WP08, research R5): the case a person asked to
        # reinvestigate is updated in place, even when it is closed, unless an open case
        # holds its signature (new events arrived after the close): then the target is
        # not reopened and is returned as stored (#4: one open case per signature).
        if target_case_id and (existing is None or existing.case_id != target_case_id):
            target = await self._cases.get(target_case_id)
            target_open = target is not None and str(
                getattr(target.status, "value", target.status)
            ) in OPEN_CASE_STATUSES
            if target is not None and existing is not None and not target_open:
                _attach_run_case(registry, target.case_id)
                _mark_run("unchanged", target)
                await self._audit.record(
                    action_type=ActionType.DECISION, surface=source_surface.value,
                    actor="pipeline", case_id=target.case_id,
                    result_summary=(
                        f"open case {existing.case_id} holds this signature; "
                        "the closed case was not reopened"
                    ),
                )
                return target
            if (
                existing is None and target is not None
                and target.cluster_signature in {cluster.signature, cluster.legacy_signature}
            ):
                existing = target
        case_id = existing.case_id if existing else new_id("case-")
        if existing is not None:
            _attach_run_case(registry, case_id)
        # A candidate a person acted on (escalated, acknowledged, put on hold,
        # reopened) is theirs (Round 16 B05): a run nobody asked for attaches the
        # events and leaves the case as the person left it. Only an automated run is
        # such a run (the deferred drain, event detection, a poll or a pushed batch,
        # all on the automated-scan surface). A person's own request still runs:
        # Investigate on the case, Reinvestigate and the bulk reinvestigate job are
        # forced, and the Investigate page asks on its own surface without force.
        # ``decide()`` and ``apply()`` are untouched (#3).
        if (
            existing is not None
            and not force
            and source_surface == SourceSurface.AUTOMATED_SCAN
            and existing.verdict is None
            and existing.decision_by == DecisionBy.ANALYST
        ):
            await attach_cluster(self._cases, existing, cluster, pipeline=self)
            await self._audit.record(
                action_type=ActionType.DECISION, surface=source_surface.value,
                actor="pipeline", case_id=case_id,
                result_summary=(
                    "a person owns this candidate; events attached, not investigated"
                ),
            )
            _mark_run("unchanged", existing)
            return existing
        # Kept outside the investigation try block so a later failure can preserve a
        # successfully completed retrieval observation instead of erasing it.
        procedure_provenance: dict[str, Any] = {}
        # Round 16 (SPEC §4.5 WP08, research R11): the case lock, held from the re-read
        # of the stored case to its save (success and failure paths alike), inside the
        # signature lock held by the caller. A person's action holds it across its own
        # read and save, so neither write erases the other.
        write_hold = _CaseWriteHold(self.case_lock(case_id))
        try:
            # --- Operator analyst rule policy (deterministic, $0, no LLM) ----------
            # An explicit, audited, revocable operator declaration that this detection
            # is benign in THEIR estate. Checked BEFORE any model call precisely
            # because there is nothing to ask a model: the operator has already
            # answered at the rule level. See ``_close_by_analyst_policy``.
            policy_case = await self._close_by_analyst_policy(
                cluster, source_surface, prefs,
                case_id=case_id, existing=existing, force=force,
            )
            if policy_case is not None:
                _attach_run_case(registry, policy_case.case_id)
                _mark_run("closed_by_policy", policy_case)
                return policy_case

            # --- P1: case/verdict stability ---
            # An already-investigated OPEN case (verdict is not None) with NO material
            # change (no new member event ids) and no explicit force must be returned
            # UNCHANGED — no LLM calls — to stop poll/attach-driven verdict drift.
            # Re-investigate only when force=True, the case is an un-investigated
            # candidate (verdict is None), or new events were added.
            if existing and existing.verdict is not None and not force:
                if existing.member_event_keys:
                    new_keys = set(_cluster_event_keys(cluster)) - set(
                        _case_event_keys(existing)
                    )
                else:
                    prior_ids = set(existing.member_event_ids)
                    new_keys = {
                        key
                        for key, event_id in zip(
                            _cluster_event_keys(cluster), cluster.member_event_ids
                        )
                        if event_id not in prior_ids
                    }
                if not new_keys:
                    await self._audit.record(
                        action_type=ActionType.DECISION, surface=source_surface.value,
                        actor="pipeline", case_id=case_id,
                        result_summary=(
                            "no material change; returning existing case unchanged "
                            f"(verdict={existing.verdict.value})"
                        ),
                    )
                    _mark_run("unchanged", existing)
                    return existing

            # Live progress: the investigation has begun (router/triage stage). Pure
            # narration — best-effort, never gates the flow (#3/#11).
            self._emit_step(case_id, "router", status="running",
                            detail="triage starting")

            investigator, enrich = self._build_investigator(prefs, query_source)

            # --- enrichment + deterministic risk ---
            enrichment: EnrichmentResult | None = None
            reputation = 0.0
            if cluster.entity.type == EntityType.IP and prefs.enrichment.enabled:
                enrichment = await enrich.enrich_ip(cluster.entity.value)
                reputation = enrichment.reputation_score
            breakdown = compute_risk(cluster, prefs, reputation)
            # Round 16 (B13): what the score was computed from, recorded beside it.
            breakdown.inputs = explain_risk(
                cluster, prefs, reputation, scored_at=iso_now(),
                reputation_source=(
                    "not_ip_entity" if cluster.entity.type != EntityType.IP
                    else "enrichment" if prefs.enrichment.enabled else "enrichment_off"
                ),
            )
            cluster.risk_score = breakdown.total
            cluster.risk_breakdown = breakdown

            await self._capture_fixture(
                cluster, enrichment, prefs,
                case_id=case_id, source_surface=source_surface,
            )

            budget = CaseBudget(prefs.caps)
            cost = 0.0

            # Multi-agent roster + runbooks: both are selected deterministically from
            # the cluster ($0, no model call, #6). The persona specialises the
            # investigator; the matching Published runbook is injected as TRUSTED
            # guidance (it can only RECOMMEND; code decides close/escalate, #3).
            persona, persona_reason = select_persona_with_reason(cluster, prefs)
            guidance = await self._select_runbook(cluster, existing, prefs)
            platform_tuning = await self._platform_tuning_snapshot(cluster, prefs)
            # The selection row (Round 14 SPEC §4.10.9): actor ``runbook_selector``,
            # action ``runbook.selected``, with the match explanation. It is also the
            # durable run boundary the case rationale reads. ``result_summary`` keeps
            # the ``key=value`` tokens the older ``playbook_selector`` rows carried.
            await self._audit.record(
                action_type=ActionType.DECISION, surface=source_surface.value,
                actor=RUNBOOK_SELECTOR_ACTOR, action="runbook.selected", case_id=case_id,
                outcome=guidance.audit_outcome,
                result_summary=(
                    f"runbook={guidance.label} persona={persona.id} "
                    f"reason={guidance.status}: {guidance.reason}"
                ),
                tool_input={
                    "runbook_selection": guidance.selection_payload(),
                    "runbook_status": guidance.status,
                    "runbook_reason": guidance.reason,
                    "persona_selection": {
                        "id": persona.id,
                        "reason": persona_reason,
                    },
                    "platform_tuning": platform_tuning,
                },
            )
            # Live progress: the specialist persona + runbook are selected.
            self._emit_step(
                case_id, "persona", status="running", detail=persona.id,
                extra={"runbook_id": (guidance.runbook_id if guidance.selected else "") or ""},
            )

            # Operator MEMORY (durable trusted facts): auto-injected into the strong
            # investigation as a distinct TRUSTED block. Best-effort + bounded; a
            # memory load failure must never break the pipeline (never raises).
            memory_entries = []
            if self._memory is not None:
                try:
                    memory_entries = await self._memory.list(active_only=True)
                except Exception as exc:  # noqa: BLE001 — memory is advisory only
                    logger.warning("Loading operator memory failed (%s); continuing", exc)
                    memory_entries = []

            # Set only when a run failed for a reason the verdict text cannot express
            # (currently: a provider outage behind the investigation time cap).
            # Declared before the branch so every path binds it.
            timeout_error: str | None = None
            if budget.kill_switch:
                procedure_provenance = {
                    "consultation_path": "kill_switch",
                    "persona_consulted": False,
                    "runbook_consulted": False,
                    "knowledge": [],
                    "retrieval_query_groups": [],
                    "retrieval_status": "not_attempted",
                    "retrieval_reason": "kill_switch",
                }
                verdict = VerdictResult(
                    verdict=Verdict.NEEDS_HUMAN,
                    recommended_action="Kill switch engaged; investigation skipped.",
                    reproduce_query=entity_kql(cluster, prefs),
                )
            else:
                procedure_provenance = {
                    "persona_consulted": False,
                    "runbook_consulted": False,
                    "knowledge": [],
                    "retrieval_query_groups": [],
                    "retrieval_status": "not_attempted",
                    "retrieval_reason": "pending",
                }
                # Live progress: handing off to the tool-using investigation graph.
                self._emit_step(case_id, "tools", status="running",
                                detail="investigation running")
                # LangGraph flow: triage -> (benign shortcut | strong investigator).
                # Enforce caps.timeout_seconds (Section 6.3 #4): a runaway / slow
                # investigation is capped to a NEEDS_HUMAN verdict, never left to spin.
                # A mutable cost_sink mirrors each REALISED gateway cost as it lands on
                # the ledger, so a timeout that cancels the flow mid-investigation can
                # still account the PARTIAL spend (otherwise Case.token_cost would
                # under-count vs the ledger). It is a side-channel for the timeout path
                # ONLY: the normal path uses the returned flow_cost (sum is identical).
                cost_accum: list[float] = []
                # Stamp the case TIME budget HERE — at the ``wait_for`` site — and not at
                # ``CaseBudget`` construction: construction happens before enrichment,
                # persona/runbook selection and the platform-tuning snapshot, so a
                # deadline stamped there would already be partly spent when this clock
                # starts and the two clocks would disagree. With it stamped, the ReAct
                # loop bounds each model request by ``min(caps.request_timeout_seconds,
                # time actually left)`` and stops COOPERATIVELY a small reserved slice
                # early, so a degraded provider no longer costs the accumulated
                # reasoning. The outer ``wait_for`` below remains the hard backstop.
                #
                # HONEST ABOUT THE COST: for a run that would have blown the case cap
                # anyway the outcome is identical (NEEDS_HUMAN either way). Stopping
                # before the cap can also end a run that would have reached a verdict, so
                # the reserve is a small FRACTION of the case rather than a whole
                # per-request slice, and the loop only declines to start a request when
                # the slice left is shorter than one this case has already completed.
                # Whatever it stops on, the verdict is NEEDS_HUMAN — which never
                # auto-closes, so #3 is untouched in either direction.
                budget.start(
                    timeout_seconds=prefs.caps.timeout_seconds,
                    request_timeout_seconds=prefs.caps.request_timeout_seconds,
                )
                try:
                    verdict, flow_cost = await asyncio.wait_for(
                        run_investigation(
                            self._router, investigator, self._rag, cluster, enrichment,
                            prefs, budget, source_surface.value, case_id,
                            persona=persona, runbook=guidance, memory=memory_entries,
                            cost_sink=cost_accum,
                            provenance_sink=procedure_provenance,
                        ),
                        timeout=prefs.caps.timeout_seconds,
                    )
                    cost += flow_cost
                except asyncio.TimeoutError:
                    # Account the spend already on the ledger before the cap fired so
                    # Case.token_cost reconciles with the usage rows (#6 — no spend is
                    # silently dropped). Use ONLY the sink here (flow_cost was never
                    # returned), so there is no double counting.
                    partial_cost = sum(cost_accum)
                    cost += partial_cost
                    # A time cap is a SYMPTOM. When the gateway has already observed a
                    # sustained provider failure, that is the real cause, and reporting
                    # the cap instead sends the operator after latency and evidence
                    # quality — which is exactly what happened for three days. The
                    # verdict itself is unchanged (NEEDS_HUMAN, #3); only the
                    # explanation becomes truthful.
                    provider_state = self._gateway.provider_health_state()
                    provider_cause = _PROVIDER_FAILURE_CAUSE.get(provider_state, "")
                    logger.warning(
                        "Investigation for %s exceeded caps.timeout_seconds=%ss; capping to "
                        "human (accounted partial cost=%s)%s",
                        cluster.signature, prefs.caps.timeout_seconds, round(partial_cost, 6),
                        f" — underlying cause: {provider_cause}" if provider_cause else "",
                    )
                    await self._audit.record(
                        action_type=ActionType.ERROR, surface=source_surface.value,
                        actor="pipeline", case_id=case_id,
                        result_summary=(
                            f"investigation timed out after {prefs.caps.timeout_seconds}s; "
                            f"capped to NEEDS_HUMAN (partial cost={round(partial_cost, 6)})"
                            + (f"; underlying cause: {provider_cause}" if provider_cause else "")
                        ),
                    )
                    if provider_cause:
                        timeout_error = (
                            f"The investigation reached the {prefs.caps.timeout_seconds}s "
                            f"time cap because {provider_cause}. This is a system-wide "
                            "condition, not a problem with this alert."
                        )
                        recommended_action = (
                            f"Investigation could not run: {provider_cause}. "
                            "Manual review required until the provider is restored."
                        )
                    else:
                        timeout_error = None
                        recommended_action = (
                            f"Investigation exceeded the {prefs.caps.timeout_seconds}s time "
                            "cap; manual review required."
                        )
                    verdict = VerdictResult(
                        verdict=Verdict.NEEDS_HUMAN,
                        recommended_action=recommended_action,
                        reproduce_query=entity_kql(cluster, prefs),
                    )
                    if procedure_provenance.get("retrieval_status") != "measured":
                        procedure_provenance["retrieval_status"] = "unavailable"
                        procedure_provenance["retrieval_reason"] = "interrupted"

            # Selected and consulted are different facts. The cheap router path,
            # kill switch, or a timeout may select a procedure without ever injecting
            # it. Preserve both explicitly so operator UI never overclaims usage.
            await self._audit.record(
                action_type=ActionType.CONTEXT,
                surface=source_surface.value,
                actor="procedure_provenance",
                case_id=case_id,
                # Partial when knowledge retrieval was cut short (a query group that
                # did not complete, or the time cap), so the gap is findable.
                outcome=(
                    "partial"
                    if procedure_provenance.get("retrieval_status") == "unavailable"
                    else "success"
                ),
                result_summary=(
                    f"persona selected={persona.id} consulted="
                    f"{bool(procedure_provenance.get('persona_consulted'))}; "
                    f"runbook selected={guidance.label} consulted="
                    f"{bool(procedure_provenance.get('runbook_consulted'))}"
                ),
                tool_input={
                    "persona": {
                        "selected_id": persona.id,
                        "selection_reason": persona_reason,
                        "consulted": bool(procedure_provenance.get("persona_consulted")),
                    },
                    "runbook": {
                        "selected_id": guidance.runbook_id if guidance.selected else None,
                        "version": guidance.version if guidance.selected else None,
                        "title": guidance.title if guidance.selected else "",
                        "selection_reason": guidance.reason,
                        "consulted": bool(procedure_provenance.get("runbook_consulted")),
                    },
                    "consultation_path": procedure_provenance.get("consultation_path", ""),
                    "retrieval_status": procedure_provenance.get(
                        "retrieval_status", "unavailable"
                    ),
                    "retrieval_reason": procedure_provenance.get(
                        "retrieval_reason", "provenance_missing"
                    ),
                    "retrieval_query_groups": procedure_provenance.get("retrieval_query_groups", []),
                    "knowledge": procedure_provenance.get("knowledge", []),
                },
            )

            # Live progress: a verdict exists (from the kill-switch, the timeout cap,
            # or the investigation graph). The DETERMINISTIC close/escalate decision
            # has NOT been made yet — that is the next step.
            self._emit_step(case_id, "verdict", status="running",
                            detail=verdict.verdict.value)

            # Round 15 (SPEC D6.10): rebuild on the case as it is stored NOW, so work a
            # person did while this run was in flight is carried, not overwritten.
            await write_hold.hold()
            existing = await self._latest_stored_case(case_id, existing)
            case_number = await self._allocate_case_number(existing, cluster, prefs)
            retrieval_measured = procedure_provenance.get("retrieval_status") == "measured"
            case = self._assemble_case(
                case_id, cluster, verdict, source_surface, existing, cost, prefs,
                persona_id=persona.id,
                runbook=(
                    guidance
                    if guidance.selected and procedure_provenance.get("runbook_consulted")
                    else None
                ),
                case_number=case_number,
                knowledge_used=(
                    list(procedure_provenance.get("knowledge", []) or [])
                    if retrieval_measured
                    else None
                ),
                retrieval_measured=retrieval_measured,
                precedent_signal=procedure_provenance.get("precedent"),
                error=timeout_error,
            )
            # ``Case.token_cost`` is a rounded cumulative presentation field. Adding
            # a new raw run cost to the previously rounded value can drift by a
            # micro-dollar across re-investigations (especially with low-cost models).
            # Reconcile from the all-time authoritative ledger after this run's rows
            # have landed. Elasticsearch is near-real-time, so an immediate search
            # may still expose only the previous run. Adopt a lower (rounding-correct)
            # ledger total only when it is within one display micro-dollar of the
            # assembled total AND has advanced beyond the prior case value. Otherwise
            # preserve the current run's fail-soft cost; a stale read must never erase
            # newly realised spend.
            recorded_cost = await self._gateway.recorded_case_pipeline_cost(case_id)
            prior_cost = existing.token_cost if existing else 0.0
            ledger_proves_current_run = bool(
                recorded_cost is not None
                and recorded_cost + _LEDGER_DISPLAY_EPSILON >= case.token_cost
                and (cost <= 0.0 or recorded_cost > prior_cost)
            )
            if ledger_proves_current_run:
                case.token_cost = recorded_cost
            CaseManager(prefs).apply(case)
            # Round 16 (WP10, C18): pair apply()'s decision entry with this run's gate row.
            case.history[-1]["run_id"] = current_investigation_run_id()
            await self._cases.save(case)
            write_hold.release()
            # Round 16 (WP08): a new case exists now; a person's close made while this
            # run was queued or running, and replaced by its result, is recorded for
            # the finish notice (read after apply(), never fed back, #3).
            _attach_run_case(registry, case_id)
            _note_replaced_close(existing, case)
            # The gate INPUTS, recorded beside the gate OUTPUT. Without them a missed
            # auto-close could not be explained from the append-only trail at all: the
            # row said the case routed to a human but not which side of the bar it
            # fell on, and the case fields that would have said so are overwritten by
            # the next re-investigation. Classification only — it runs strictly AFTER
            # apply() has decided and persisted, and nothing branches on it (#3).
            #
            # APPEND-ONLY, AT THE END. ``result_summary`` is an audit history string:
            # existing tokens keep their exact spelling and order forever, and new
            # facts are only ever appended after them. A row written before these
            # tokens existed simply lacks them and reads back as ``unrecorded``.
            gate_outcome = classify_auto_close_gate(
                prefs.auto_close, case.verdict, case.confidence, case.risk_score,
            )
            # Round 16 (WP10, D-API-2): the entry decide() compared, the same closable-class
            # test classify_auto_close_gate uses (None for NEEDS_HUMAN and no verdict).
            gate_entry = _entry_for(prefs.auto_close, case.verdict)
            await self._audit.record(
                action_type=ActionType.DECISION, surface=source_surface.value,
                actor="case_manager", case_id=case_id,
                result_summary=(
                    f"verdict={verdict.verdict.value} status={case.status.value} "
                    f"decision_by={case.decision_by.value if case.decision_by else None} "
                    f"risk={case.risk_score} cost={round(cost, 6)} "
                    f"confidence={case.confidence} auto_close_gate={gate_outcome}"
                ),
                # Round 16 (WP10, D-API-2): what the gate compared, recorded after apply()
                # for the Decision explanation; nothing reads it to decide (#3).
                tool_input={"gate": {
                    "verdict": case.verdict.value if case.verdict else None,
                    "confidence": case.confidence,
                    "risk_score": case.risk_score,
                    "class_enabled": bool(gate_entry is not None and gate_entry.enabled),
                    "min_confidence": gate_entry.min_confidence if gate_entry else None,
                    "max_risk_score": gate_entry.max_risk_score if gate_entry else None,
                    "objection_window_minutes": (
                        gate_entry.objection_window_minutes if gate_entry else None
                    ),
                    "escalation_confidence": prefs.escalation_confidence,
                    "critical_severity": prefs.critical_severity,
                    "outcome": gate_outcome,
                    # The Demo case store tags every case it saves (``demo_runtime.DEMO_TAG``).
                    "demo": "demo" in (case.tags or []),
                }},
            )
            # Live progress: TERMINAL ``decision`` frame, emitted AFTER apply()+save +
            # the audit record so it only REPORTS the already-decided, already-persisted
            # case — it never feeds the deterministic decision (#3). This is the last
            # agent.step a subscriber sees for this run.
            self._emit_step(
                case_id, "decision", status="done", detail=case.status.value,
                extra={
                    "verdict": verdict.verdict.value,
                    "decision_by": (case.decision_by.value if case.decision_by else None),
                },
            )
            # Runbook attachment (Round 14 SPEC §4.10.4): AFTER the deterministic
            # decision + save, so a case that needs a person gets the matching runbook
            # as a checklist. It reads the decided case and never changes it (#3).
            await self._maybe_attach_runbook(case)
            # Threshold automation (F10) runs AFTER the deterministic decision + save
            # (#3). It may ONLY tag/recommend/notify/queue a re-investigation (which
            # itself re-runs decide()) / open a HITL Proposal — never set status or
            # close. Fully error-isolated: a failure can never break the case path.
            await self._maybe_automate(case, prefs)
            # Reusable-knowledge loop (F11): if this case is terminal (closed/resolved),
            # index it as a resolved_case RAG chunk so future investigations learn from
            # it. Best-effort, OUTSIDE the decision logic — never blocks/raises.
            await self._maybe_index_resolved(case)
            # Fire-and-forget outbound notifications AFTER the deterministic decision +
            # save (#3). A send (or failure) can never block, delay, or alter the case
            # — create_task detaches it and notify() swallows all errors internally.
            self._maybe_notify(case)
            # Round 15 (SPEC D6.3): the random auto-close review sample, AFTER every
            # hook above, only for a terminal case the agent decided. It never writes
            # to the case and never feeds the decision (#3); a failure is logged.
            await self._maybe_sample_review(case, prefs)
            return case
        except Exception as exc:  # noqa: BLE001 — never drop an alert
            logger.exception("Pipeline failed for cluster %s; failing to human", cluster.signature)
            retrieval_measured = procedure_provenance.get("retrieval_status") == "measured"
            # Round 15 (SPEC D6.10): a failed run keeps the work a person did while it was
            # in flight, too (the run may have failed before the re-read above).
            await write_hold.hold()
            existing = await self._latest_stored_case(case_id, existing)
            case = _fail_to_human_case(
                case_id,
                cluster,
                source_surface,
                # The case error is shown to every case reader: an exception's text can
                # carry an address or a credential, so it is redacted as the row is.
                redact_text(str(exc))[0],
                existing,
                prefs,
                knowledge_used=(
                    list(procedure_provenance.get("knowledge", []) or [])
                    if retrieval_measured
                    else None
                ),
                retrieval_measured=retrieval_measured,
            )
            # The failed run's spend (Round 16 B12): the case keeps its stored total
            # (``_fail_to_human_case``) and rises to the ledger's total when the ledger
            # already holds this run's rows. Read from the ledger, never summed here, so
            # a cost added before the failure is not counted twice (#6).
            try:
                recorded_cost = await self._gateway.recorded_case_pipeline_cost(case_id)
            except Exception:  # noqa: BLE001 - accounting is fail-soft
                recorded_cost = None
            if recorded_cost is not None and recorded_cost > case.token_cost:
                case.token_cost = recorded_cost
            persist_error: Exception | None = None
            try:
                await self._cases.save(case)
            except Exception as save_exc:  # noqa: BLE001
                persist_error = save_exc
                logger.exception("Could not persist fail-to-human case %s", case_id)
            write_hold.release()
            # Round 16 (WP08, research F1): the run's TERMINAL frame, so a narration
            # never stays "in progress" after a failure. Reports the routed case only.
            self._emit_step(case_id, "decision", status="failed", detail=case.status.value)
            if persist_error is None:
                _attach_run_case(registry, case_id)
                _note_replaced_close(existing, case)
                _mark_run("routed_to_person", case)
            try:
                await self._audit.record(
                    action_type=ActionType.ERROR, surface=source_surface.value,
                    actor="pipeline", case_id=case_id,
                    # Any exception, so its text can carry an address or a credential.
                    result_summary=truncate(redact_text(f"pipeline error: {exc}")[0], 1000),
                )
            finally:
                if persist_error is not None:
                    # Returning an unsaved Case would make a webhook/broker ack work
                    # that vanished. Propagate only this terminal persistence failure;
                    # IngestService converts it to its retry boundary.
                    raise RuntimeError(
                        f"could not persist fail-to-human case {case_id}"
                    ) from persist_error
            # A failed investigation still leaves a case that needs a person, so it
            # gets the matching runbook like any other (§4.10.4).
            await self._maybe_attach_runbook(case)
            return case
        finally:
            # A cancelled run (or one that raised before its save) never keeps the
            # case lock.
            write_hold.release()

    async def _close_by_analyst_policy(
        self,
        cluster: Cluster,
        source_surface: SourceSurface,
        prefs: Preferences,
        *,
        case_id: str,
        existing: Case | None,
        force: bool = False,
    ) -> Case | None:
        """Close a cluster the operator has DECLARED benign — with no LLM call at all.

        Why this exists. For a detection whose alerts carry no per-case evidence, an
        investigation can never verify that THIS instance is benign, so it correctly
        returns NEEDS_HUMAN no matter how much analyst-confirmed history stands behind
        the rule. Confirming more cases cannot move an evidence-sufficiency judgement,
        so an operator needs a way to assert a RULE-LEVEL fact directly. Trying to
        persuade a model, per case, with evidence the source never emits is slower,
        more expensive and less honest than letting the operator say it once.

        What it is NOT. It is not a new close authority layered onto ``decide()``, and
        it never reads or influences it: this runs BEFORE any verdict exists, so there
        is nothing for the auto-close policy to be applied to. ``verdict`` stays
        ``None`` — a case nobody investigated must never carry a fabricated model
        judgement — and the decision owner is the distinct
        ``DecisionBy.ANALYST_POLICY``, which is invisible to
        ``analyst_confirmed_outcome`` (so it can never become training evidence for the
        automation it replaces) and excluded from every agent-performance statistic (so
        it can never flatter the agent).

        Scope, and the two things this must never do:

        * **It never retro-closes an investigated case.** The declaration applies going
          FORWARD. A cluster signature is entity-centric and deliberately excludes rule
          ids, so a later alert carrying only a declared rule can re-enter an OPEN case
          the agent already investigated — and rebuilding that record here would erase
          its verdict, override the outcome ``decide()`` produced (including a
          ``NEEDS_HUMAN`` routing, which #3 says can never be auto-closed), and delete a
          confirmed incident from every agent-performance statistic. So a case that
          already carries a verdict is left entirely alone; the ordinary stability /
          re-investigation path still owns it.
        * **It never absorbs an undeclared detection.** Coverage is checked against the
          rule set the closed record will actually CARRY — the union of the cluster's
          rules and any already recorded on the existing case — not just the incoming
          cluster's. Matching on the cluster alone would let a declared-rule alert close
          a case that also fired something the operator never declared.

        Revoking (disable, expire, delete) stops the next match immediately.

        Returns the closed Case, or ``None`` when no declaration covers this cluster.
        Fail-safe: any error returns ``None``, so a broken declaration degrades to a
        normal investigation rather than dropping the cluster.
        """
        # An explicit human action on THIS case always wins over a rule-level statement.
        #
        # ``verdict is not None`` alone is not that test. The analyst lifecycle path
        # (``routes._perform_case_action``) sets ``status`` and stamps
        # ``decision_by = ANALYST`` but never assigns a verdict, and
        # ``OPEN_CASE_STATUSES`` includes escalated / on_hold / investigating /
        # needs_human — so an analyst who REOPENED a policy-closed case, or escalated an
        # un-investigated candidate, was handed straight back to this gate and overridden
        # by the next matching alert. Their only per-case escape was a loop they could
        # not win. A declaration says what a DETECTION means in general; it must never
        # overrule what a person decided about one case.
        #
        # This guard is also what makes the unconditional ``disposition=FALSE_POSITIVE``
        # below safe: every writer of an analyst disposition stamps ANALYST too, so a
        # deliberate analyst classification can no longer be reached from here (mirroring
        # ``case_manager.apply``'s "never overrides an analyst-confirmed disposition").
        if existing is not None and (
            existing.verdict is not None
            or existing.decision_by == DecisionBy.ANALYST
        ):
            return None
        # An explicit per-case human REQUEST wins too. ``force`` is what
        # ``POST /api/cases/{id}/reinvestigate`` and ``/investigate`` carry, and an
        # analyst tier holding ``cases:reinvestigate`` but only ``rules:read`` cannot
        # revoke the declaration — so without this they could neither investigate a
        # declared-benign case they suspect is a real attack, nor lift the declaration.
        # On a security product that is the wrong end state.
        if force:
            return None
        # The risk ceiling is compared against the SAME deterministic risk the case
        # will carry, so it must be computed before the match rather than after it.
        breakdown = compute_risk(cluster, prefs, 0.0)
        # Round 16 (B13): what the score was computed from, recorded beside it.
        breakdown.inputs = explain_risk(
            cluster, prefs, 0.0, reputation_source="not_looked_up", scored_at=iso_now(),
        )
        cluster.risk_score = breakdown.total
        cluster.risk_breakdown = breakdown
        try:
            match = match_analyst_rule_policy(
                rule_ids=_merge_rules(existing, cluster),
                source_id=getattr(cluster, "source_id", None),
                policies=getattr(prefs, "analyst_rule_policies", None),
                risk_score=cluster.risk_score,
            )
        except Exception as exc:  # noqa: BLE001 — never drop a cluster on policy code
            logger.warning("Analyst rule policy evaluation failed: %s", exc)
            return None
        if match is None:
            return None

        case_number = await self._allocate_case_number(existing, cluster, prefs)
        now = iso_now()
        rules = ", ".join(match.rule_ids)
        reason = next((r for r in match.reasons if r.strip()), "")
        rationale = (
            f"Closed by operator analyst rule policy: {rules} is declared benign in "
            "this environment. No investigation was run and no model was called."
            + (f" Operator reason: {truncate(reason, 240)}" if reason else "")
        )
        history = list(existing.history) if existing else []
        history.append({
            # Deliberately NOT the ``analyst_action`` event shape: that is what
            # ``analyst_confirmed_outcome`` reads as independent ground truth, and a
            # policy close is automation output, not a per-case human judgement.
            "ts": now,
            "event": "analyst_policy",
            "action": "close_false_positive",
            "policy_ids": list(match.policy_ids),
            "rule_ids": list(match.rule_ids),
            "rationale": rationale,
        })
        status_history = list(existing.status_history) if existing else []
        prev_status = existing.status if existing else None
        if prev_status != CaseStatus.CLOSED:
            status_history.append(StatusHistoryEntry(
                from_status=(prev_status.value if prev_status else ""),
                to_status=CaseStatus.CLOSED.value,
                by=DecisionBy.ANALYST_POLICY.value,
                at=now,
                reason=rationale,
            ))
        case = Case(
            case_id=case_id,
            case_number=(existing.case_number if existing and existing.case_number else case_number),
            cluster_signature=cluster.signature,
            **originating_record_provenance(existing),
            created_at=existing.created_at if existing else now,
            updated_at=now,
            source_surface=_preserved_surface(existing, source_surface),
            origin_surface=_origin_surface(existing, source_surface),
            rule_ids=_merge_rules(existing, cluster),
            entity=cluster.entity,
            source_id=_source_id(existing, cluster),
            source_name=_source_name(existing, cluster),
            member_event_ids=list(dict.fromkeys(
                (existing.member_event_ids if existing else []) + cluster.member_event_ids
            )),
            member_event_keys=_merge_event_keys(existing, cluster),
            first_seen_millis=_first_seen(existing, cluster),
            risk_score=cluster.risk_score,
            risk_breakdown=cluster.risk_breakdown,
            # No model ran, so there is no verdict and no confidence to report.
            verdict=None,
            confidence=0.0,
            status=CaseStatus.CLOSED,
            disposition=Disposition.FALSE_POSITIVE,
            decision_by=DecisionBy.ANALYST_POLICY,
            status_reason=rationale,
            recommended_action="No action required; this detection is declared benign here.",
            reproduce_query=normalize_kql(entity_kql(cluster, prefs), prefs),
            title=truncate(machine_case_title(cluster), 200),
            summary=truncate(rationale, 300),
            token_cost=(existing.token_cost if existing else 0.0),
            # Analyst-owned state on an un-investigated case survives the close: a grade
            # recorded here is independent ground truth, and tags/comments/assignment are
            # a person's work on the record.
            feedback=(list(existing.feedback) if existing else []),
            tags=(list(existing.tags) if existing else []),
            comments=(list(existing.comments) if existing else []),
            assignee=(existing.assignee if existing else ""),
            # Append-only record of automation rules on this case (Round 16 B09).
            automation_actions=(list(existing.automation_actions) if existing else []),
            history=history,
            status_history=status_history,
            verdict_history=(list(existing.verdict_history) if existing else []),
            trigger_reason=_trigger(existing, cluster),
            knowledge_used=list(existing.knowledge_used) if existing is not None else [],
            retrieval_history_status=(
                existing.retrieval_history_status if existing else "available"
            ),
            retrieval_observation_status=(
                existing.retrieval_observation_status if existing else "not_measured"
            ),
            precedent_signal=(existing.precedent_signal if existing else None),
            **_procedure_history(existing),
            analyst_policy=match.as_dict(),
        )
        await self._cases.save(case)
        await self._audit.record(
            action_type=ActionType.DECISION, surface=source_surface.value,
            actor=DecisionBy.ANALYST_POLICY.value, case_id=case_id,
            result_summary=(
                f"closed by analyst rule policy rules={rules} "
                f"policies={','.join(match.policy_ids)} risk={cluster.risk_score}"
            ),
            tool_input={"analyst_policy": match.as_dict(), "rationale": rationale},
        )
        return case

    async def register_candidate(
        self, cluster: Cluster, source_surface: SourceSurface, prefs: Preferences,
        *, awaiting_reason: str = "",
    ) -> Case:
        """Create/refresh an OPEN candidate case with NO LLM cost (deterministic
        risk only). Every correlated cluster becomes a visible case so nothing is
        ever dropped; auto-forwarded clusters are investigated separately.

        ``awaiting_reason`` (optional) is an honest, already-render-safe stage label
        explaining WHY this cluster is not (yet) LLM-reasoned — e.g. "risk 33 is below the
        auto-investigate floor 70", "deferred: per-tick auto-investigation cap reached".
        It is recorded on the candidate ``summary`` so the UI can honestly show candidates
        are awaiting analysis; it NEVER feeds ``decide()`` (advisory presentation, #3).

        The ``find_open_by_signature → save`` critical section is serialized PER
        SIGNATURE (:meth:`signature_lock`) so two concurrent per-source pollers
        registering the SAME signature never both mint a candidate case (#4)."""
        async with self.signature_lock(cluster.signature):
            return await self._register_candidate_locked(
                cluster, source_surface, prefs, awaiting_reason=awaiting_reason
            )

    async def _register_candidate_locked(
        self, cluster: Cluster, source_surface: SourceSurface, prefs: Preferences,
        *, awaiting_reason: str = "",
    ) -> Case:
        existing = await find_open_case_for_cluster(self._cases, cluster)
        case_id = existing.case_id if existing else new_id("case-")
        # A declared-benign cluster is CLOSED here too, not parked as a candidate: the
        # operator answered this at the rule level, so leaving it open would put work
        # back on the queue the declaration exists to clear.
        policy_case = await self._close_by_analyst_policy(
            cluster, source_surface, prefs, case_id=case_id, existing=existing
        )
        if policy_case is not None:
            return policy_case
        # A decided case, or one a person moved, is never rebuilt as a candidate
        # (Round 16 B04): the events attach and the case is returned as it is, the
        # same rule the realtime path applies. Rebuilding it would wipe its verdict,
        # decision and escalation and hand it back to a run that could re-decide it.
        if existing is not None and is_attach_only(existing):
            await attach_cluster(self._cases, existing, cluster, pipeline=self)
            return existing
        breakdown = compute_risk(cluster, prefs, 0.0)
        # Round 16 (B13): what the score was computed from, recorded beside it.
        breakdown.inputs = explain_risk(
            cluster, prefs, 0.0, reputation_source="not_looked_up", scored_at=iso_now(),
        )
        cluster.risk_score = breakdown.total
        cluster.risk_breakdown = breakdown
        member_ids = list(dict.fromkeys(
            (existing.member_event_ids if existing else []) + cluster.member_event_ids
        ))
        member_keys = _merge_event_keys(existing, cluster)
        case_number = await self._allocate_case_number(existing, cluster, prefs)
        case = Case(
            case_id=case_id,
            case_number=case_number,
            cluster_signature=cluster.signature,
            **originating_record_provenance(existing),
            created_at=existing.created_at if existing else iso_now(),
            updated_at=iso_now(),
            source_surface=_preserved_surface(existing, source_surface),
            origin_surface=_origin_surface(existing, source_surface),
            rule_ids=_merge_rules(existing, cluster),
            entity=cluster.entity,
            source_id=_source_id(existing, cluster),
            source_name=_source_name(existing, cluster),
            member_event_ids=member_ids,
            member_event_keys=member_keys,
            first_seen_millis=_first_seen(existing, cluster),
            risk_score=cluster.risk_score,
            risk_breakdown=cluster.risk_breakdown,
            verdict=None,
            status=CaseStatus.OPEN,
            title=truncate(machine_case_title(cluster), 200),
            # No em dash on screen (T36); summaries stored earlier keep their text.
            summary=truncate(
                f"Candidate awaiting analysis: {awaiting_reason}." if awaiting_reason
                else "Candidate cluster awaiting investigation.", 300),
            awaiting_reason=awaiting_reason,
            history=(existing.history if existing else []),
            verdict_history=(existing.verdict_history if existing else []),
            trigger_reason=_trigger(existing, cluster),
            knowledge_used=list(existing.knowledge_used) if existing is not None else [],
            retrieval_history_status=(
                existing.retrieval_history_status if existing else "available"
            ),
            retrieval_observation_status=(
                existing.retrieval_observation_status if existing else "not_measured"
            ),
            precedent_signal=(existing.precedent_signal if existing else None),
            **_procedure_history(existing),
            tags=_carried_tags(existing),
            # Reaching the candidate path means no live declaration covered this
            # cluster, so any stale marker from an earlier close is no longer true.
            analyst_policy=None,
        )
        # Round 15 (SPEC D6.10): people's work on the case survives the rebuild, and
        # the timeline names the real previous status if the candidate moved it.
        _carry_case_work(existing, case)
        _record_rebuild_transition(existing, case, reason=case.summary)
        await self._cases.save(case)
        await self._audit.record(
            action_type=ActionType.POLL, surface=source_surface.value, actor="poller",
            case_id=case_id,
            result_summary=f"registered candidate risk={case.risk_score} rules={cluster.rule_values}",
        )
        return case

    def _assemble_case(
        self,
        case_id: str,
        cluster: Cluster,
        verdict: VerdictResult,
        source_surface: SourceSurface,
        existing: Case | None,
        cost: float,
        prefs: Preferences,
        persona_id: str = "",
        runbook: RunbookGuidance | None = None,
        case_number: str = "",
        knowledge_used: list[dict[str, Any]] | None = None,
        retrieval_measured: bool = False,
        precedent_signal: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> Case:
        member_ids = list(dict.fromkeys(
            (existing.member_event_ids if existing else []) + cluster.member_event_ids
        ))
        member_keys = _merge_event_keys(existing, cluster)
        created_at = existing.created_at if existing else iso_now()
        history = existing.history if existing else []
        token_cost = (existing.token_cost if existing else 0.0) + cost
        title = machine_case_title(cluster)
        # P1 provenance: keep the original creating surface; never overwrite it with
        # the current call's surface (so an automated_scan case stays in the
        # Automated Scans tab after a manual investigate).
        surface = _preserved_surface(existing, source_surface)
        origin = _origin_surface(existing, source_surface)
        # P1: append to the verdict trail on each (re)investigation.
        verdict_history = list(existing.verdict_history) if existing else []
        verdict_history.append({
            "ts": iso_now(),
            "verdict": verdict.verdict.value,
            "confidence": verdict.confidence,
            "risk_score": cluster.risk_score,
        })
        # Normalise the reproduce query UNCONDITIONALLY so it always uses the
        # configured field syntax (e.g. `source.ip : "x"`), never a bare `ip:x` —
        # covers BOTH the router/benign path and the LLM/formatter path. The
        # entity_kql fallback is already correct; normalize_kql is idempotent on it.
        raw_reproduce = verdict.reproduce_query or entity_kql(cluster, prefs)
        reproduce_query = normalize_kql(raw_reproduce, prefs)
        # Partial fail-soft context remains visible in this run's audit provenance,
        # but only a fully measured retrieval may change the Case-level metric input.
        merged_knowledge = _merge_knowledge_references(
            existing.knowledge_used if existing else [],
            knowledge_used if retrieval_measured else None,
        )
        case = Case(
            case_id=case_id,
            case_number=(existing.case_number if existing and existing.case_number else case_number),
            cluster_signature=cluster.signature,
            # Round 15 (SPEC D6.10): the stored status, used ONLY as ``apply()``'s
            # previous status (as the analyst-policy path does), so the transition
            # ``apply()`` appends to the carried timeline names the real previous
            # status. ``apply()`` sets the decided status; ``decide()`` is untouched.
            status=(existing.status if existing else CaseStatus.OPEN),
            # Surfaces the REAL upstream cause on a run that failed for a reason the
            # verdict text alone cannot express (e.g. a provider outage behind a
            # timeout). None on every ordinary run, so existing cases are unchanged.
            error=truncate(error, 500) if error else None,
            **originating_record_provenance(existing),
            created_at=created_at,
            updated_at=iso_now(),
            source_surface=surface,
            origin_surface=origin,
            rule_ids=_merge_rules(existing, cluster),
            entity=cluster.entity,
            source_id=_source_id(existing, cluster),
            source_name=_source_name(existing, cluster),
            member_event_ids=member_ids,
            member_event_keys=member_keys,
            first_seen_millis=_first_seen(existing, cluster),
            risk_score=cluster.risk_score,
            risk_breakdown=cluster.risk_breakdown,
            verdict=verdict.verdict,
            confidence=verdict.confidence,
            evidence=verdict.evidence,
            mitre=verdict.mitre,
            recommended_action=verdict.recommended_action,
            reproduce_query=reproduce_query,
            title=truncate(title, 200),
            summary=truncate(verdict.recommended_action, 300),
            token_cost=round(token_cost, 6),
            history=history,
            verdict_history=verdict_history,
            trigger_reason=_trigger(existing, cluster),
            agent_persona=persona_id or (existing.agent_persona if existing else ""),
            # Round 14 (SPEC §4.10.9): ``playbook_id`` stays readable and is never
            # written by new code; ``runbook_id``/``runbook_version`` name the Published
            # runbook whose guidance the investigator received in the latest run that
            # received one (a run that did not consult one keeps the earlier values).
            playbook_id=(existing.playbook_id if existing else ""),
            runbook_id=(
                runbook.runbook_id if runbook is not None
                else (existing.runbook_id if existing else None)
            ),
            runbook_version=(
                runbook.version if runbook is not None
                else (existing.runbook_version if existing else None)
            ),
            # The case's tags (people's and automation rules' labels) survive a
            # re-investigation: a runbook can be conditioned on them (§4.10.4), and
            # the investigator's guidance already read them for this run.
            tags=_carried_tags(existing),
            knowledge_used=merged_knowledge,
            retrieval_history_status=(
                existing.retrieval_history_status if existing else "available"
            ),
            retrieval_observation_status=_retrieval_observation_status(
                existing, retrieval_measured
            ),
            # The precedent fact THIS run was given. A run that never reached the
            # investigator (kill switch, router shortcut, timeout) contributes nothing,
            # so the previous run's recorded signal is preserved rather than erased —
            # an absent signal must never be mistaken for "no precedent exists".
            precedent_signal=(
                precedent_signal
                if precedent_signal is not None
                else (existing.precedent_signal if existing else None)
            ),
            # An investigation SUPERSEDES a declaration: this case is no longer closed by
            # policy, so the durable marker is dropped rather than carried forward (the
            # append-only ``analyst_policy`` history event keeps the trail). Leaving it
            # set would keep a genuinely investigated case out of every agent statistic.
            analyst_policy=None,
        )
        return _carry_case_work(existing, case)


def _carry_case_work(existing: Case | None, case: Case) -> Case:
    """Carry people's work on a stored case onto its rebuilt document (Round 15 SPEC
    D6.10). The one helper of the three builders that rebuild an open case from a
    cluster: :meth:`InvestigationPipeline._assemble_case`, :func:`_fail_to_human_case`
    and :meth:`InvestigationPipeline._register_candidate_locked`. The case stores write
    the whole document, so a field a builder leaves out is erased.

    Carried: ``assignee``, ``comments``, ``feedback`` (a grade is independent ground
    truth, a review grade included), ``status_history`` (appended to by ``apply()`` or
    the builder), ``acknowledged_at``, ``status_reason``, ``notifications_sent``,
    ``automation_actions`` (append-only), the cross-source links ``related_case_ids``,
    ``cross_source_cluster_id`` and ``source_breakdown`` (Round 16 B09), and the
    disposition ONLY when an analyst explicitly classified it and the case still carries
    it (:func:`~app.engine.analyst_outcomes.standing_analyst_disposition`); otherwise the
    disposition stays ``None`` and ``apply()`` fills it from the verdict. ``apply()``
    fills a disposition only when it is ``None``, so a carried analyst disposition
    survives a re-verdict.

    NOT carried: ``status`` (``_assemble_case`` sets it only as ``apply()``'s previous
    status; the other two builders set their own), ``escalation_level`` (a positive
    value reads as escalated everywhere, which the rebuilt status may not be) and
    ``decision_by``. Never reads or changes the decision inputs (#3). Returns ``case``."""
    if existing is None:
        return case
    case.assignee = existing.assignee or ""
    case.comments = list(existing.comments or [])
    case.feedback = list(existing.feedback or [])
    case.status_history = list(existing.status_history or [])
    case.acknowledged_at = existing.acknowledged_at
    case.status_reason = existing.status_reason or ""
    case.notifications_sent = list(existing.notifications_sent or [])
    # Round 16 B09: the append-only automation record (a later run's automation
    # appends after it) and the cross-source links (``engine.ingest.link_cross_source``
    # writes them; a rebuild must not leave the link one-sided).
    case.automation_actions = list(existing.automation_actions or [])
    case.related_case_ids = list(existing.related_case_ids or [])
    case.cross_source_cluster_id = existing.cross_source_cluster_id or ""
    case.source_breakdown = dict(existing.source_breakdown or {})
    if standing_analyst_disposition(existing) is not None:
        case.disposition = existing.disposition
    return case


def _record_rebuild_transition(existing: Case | None, case: Case, *, reason: str) -> None:
    """Append ``existing.status -> case.status`` to the carried timeline when a builder
    that sets its own status (no ``apply()`` follows) moved it, by ``system`` (Round 15
    SPEC D6.10: the appended transition names the real previous status). A new case, or
    a status that did not move, appends nothing."""
    if existing is None or existing.status == case.status:
        return
    case.status_history.append(StatusHistoryEntry(
        from_status=(existing.status.value if existing.status else ""),
        to_status=case.status.value,
        by=DecisionBy.SYSTEM.value,
        at=case.updated_at,
        reason=truncate(reason or "", 500),
    ))


def _trigger(existing: Case | None, cluster: Cluster):
    """Keep the cluster's freshly-computed trigger reason, falling back to the
    existing case's (so a manual re-investigate doesn't erase the scan's reason)."""
    return cluster.trigger_reason or (existing.trigger_reason if existing else None)


def _first_seen(existing: Case | None, cluster: Cluster) -> int:
    """The EARLIEST first-event instant (epoch millis) seen for this case — the
    advisory MTTD (detection-latency) input only, NEVER read by ``decide()`` (#3).

    Earliest-wins across re-clusters: when the case is re-investigated with a cluster
    whose window opened earlier, we keep the smaller (earlier) of the existing and the
    new value so the detection instant never drifts LATER. 0 when neither is known."""
    candidates = [
        v
        for v in (
            (existing.first_seen_millis if existing else 0),
            cluster.first_seen_millis,
        )
        if isinstance(v, int) and v > 0
    ]
    return min(candidates) if candidates else 0


def _source_id(existing: Case | None, cluster: Cluster) -> str | None:
    """Record the originating source id on the case (multi-source provenance),
    preserving an existing case's value (never erased by a later attach)."""
    return cluster.source_id or (existing.source_id if existing else None)


def _case_event_keys(case: Case | None) -> list[str]:
    if case is None:
        return []
    return list(case.member_event_keys or case.member_event_ids)


def _cluster_event_keys(cluster: Cluster) -> list[str]:
    return list(cluster.member_event_keys or cluster.member_event_ids)


def _merge_event_keys(existing: Case | None, cluster: Cluster) -> list[str]:
    prior = _case_event_keys(existing)
    incoming = _cluster_event_keys(cluster)
    if existing is not None and not existing.member_event_keys:
        prior_ids = set(existing.member_event_ids)
        incoming = [
            key
            for key, event_id in zip(incoming, cluster.member_event_ids)
            if event_id not in prior_ids
        ]
    return list(dict.fromkeys(prior + incoming))


def _source_name(existing: Case | None, cluster: Cluster) -> str | None:
    return cluster.source_name or (existing.source_name if existing else None)


def _merge_rules(existing: Case | None, cluster: Cluster) -> list[str]:
    """Union previously-recorded rules with the new cluster's rules.

    Rules are deliberately NOT part of the cluster signature (Section 6.2), so a
    newly-seen rule for an already-open entity must ENRICH the case, never replace
    its rule history."""
    prior = set(existing.rule_ids) if existing else set()
    return sorted(prior | set(cluster.rule_values))


def _fail_to_human_case(
    case_id: str,
    cluster: Cluster,
    source_surface: SourceSurface,
    error: str,
    existing: Case | None,
    prefs: Preferences,
    *,
    knowledge_used: list[dict[str, Any]] | None = None,
    retrieval_measured: bool = False,
) -> Case:
    # Preserve any prior measured references, but do not promote partial/unavailable
    # context from this failed run into the Case-level measurement history.
    merged_knowledge = _merge_knowledge_references(
        existing.knowledge_used if existing else [],
        knowledge_used if retrieval_measured else None,
    )
    case = Case(
        case_id=case_id,
        # A failed run keeps the case's display number (Round 15): an empty number here
        # would make the next run mint a new one, so one case would read under two.
        case_number=(existing.case_number if existing else ""),
        cluster_signature=cluster.signature,
        **originating_record_provenance(existing),
        created_at=existing.created_at if existing else iso_now(),
        updated_at=iso_now(),
        source_surface=_preserved_surface(existing, source_surface),
        origin_surface=_origin_surface(existing, source_surface),
        rule_ids=_merge_rules(existing, cluster),
        entity=cluster.entity,
        source_id=_source_id(existing, cluster),
        source_name=_source_name(existing, cluster),
        member_event_ids=list(dict.fromkeys(
            (existing.member_event_ids if existing else []) + cluster.member_event_ids
        )),
        member_event_keys=_merge_event_keys(existing, cluster),
        first_seen_millis=_first_seen(existing, cluster),
        risk_score=cluster.risk_score,
        risk_breakdown=cluster.risk_breakdown,
        verdict=Verdict.NEEDS_HUMAN,
        confidence=0.0,
        recommended_action="Automated investigation failed; manual review required.",
        reproduce_query=entity_kql(cluster, prefs),
        status=CaseStatus.NEEDS_HUMAN,
        decision_by=DecisionBy.SYSTEM,
        title=f"[FAILED] {cluster.entity.type.value}:{cluster.entity.value}",
        error=truncate(error, 500),
        # A failed run never erases what the case already cost (Round 16 B12); the
        # caller raises it to the ledger total when the ledger holds this run's rows.
        token_cost=(existing.token_cost if existing else 0.0),
        history=(existing.history if existing else []),
        verdict_history=(existing.verdict_history if existing else []),
        trigger_reason=_trigger(existing, cluster),
        knowledge_used=merged_knowledge,
        retrieval_history_status=(
            existing.retrieval_history_status if existing else "available"
        ),
        retrieval_observation_status=_retrieval_observation_status(
            existing, retrieval_measured
        ),
        precedent_signal=(existing.precedent_signal if existing else None),
        **_procedure_history(existing),
        tags=_carried_tags(existing),
        # A failed investigation is still an investigation: the case is NEEDS_HUMAN, not
        # closed by declaration, so the durable marker does not survive.
        analyst_policy=None,
    )
    # Round 15 (SPEC D6.10): a failed run keeps people's work on the case (a review
    # grade included), and the timeline names the real previous status.
    _carry_case_work(existing, case)
    _record_rebuild_transition(existing, case, reason=case.recommended_action)
    return case


def _carried_tags(existing: Case | None) -> list[str]:
    """The stored case's tags, kept by every rebuild of the case (a re-investigation, a
    failed run, a re-registered candidate). They are labels people and automation
    rules put on the record, and a runbook may be conditioned on them (Round 14 SPEC
    §4.10.4), so the pipeline never drops them."""
    return list(existing.tags) if existing is not None else []


def _procedure_history(existing: Case | None) -> dict[str, Any]:
    """The procedure provenance a rebuilt case keeps from the stored one: the runbook
    whose guidance an earlier investigation received and the pre-Round 14
    ``playbook_id`` (history is never rewritten, SPEC §4.10.9). A path that consults no
    runbook (a candidate, a declared-benign close, a failed run) never erases them."""
    if existing is None:
        return {}
    return {
        "playbook_id": existing.playbook_id,
        "runbook_id": existing.runbook_id,
        "runbook_version": existing.runbook_version,
    }


def _retrieval_observation_status(
    existing: Case | None, retrieval_measured: bool
) -> str:
    """Preserve cumulative retrieval truth without deriving it from list contents."""
    if retrieval_measured:
        return "measured"
    if existing is not None:
        return existing.retrieval_observation_status
    return "not_measured"


def _merge_knowledge_references(
    prior: list[dict[str, Any]], current: list[dict[str, Any]] | None
) -> list[dict[str, Any]]:
    """Return the bounded cumulative reference set without duplicate evidence."""

    merged: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()
    for item in [*(prior or []), *(current or [])]:
        key = (
            str(item.get("source") or ""),
            str(item.get("document_id") or ""),
            str(item.get("content_hash") or item.get("snippet") or ""),
        )
        if key in seen:
            continue
        seen.add(key)
        merged.append(dict(item))
    return merged[-100:]


def _preserved_surface(existing: Case | None, source_surface: SourceSurface) -> SourceSurface:
    """Keep the original creating surface (P1 provenance). For an existing case we
    NEVER overwrite ``source_surface`` with the current call's surface, so e.g. an
    automated_scan case stays in the Automated Scans tab after a manual investigate."""
    return existing.source_surface if existing else source_surface


def _origin_surface(existing: Case | None, source_surface: SourceSurface) -> SourceSurface:
    """The FIRST surface this case ever had. Stable across (re)investigations."""
    if existing:
        return existing.origin_surface or existing.source_surface
    return source_surface
