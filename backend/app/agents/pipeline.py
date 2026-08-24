"""Investigation pipeline — the shared spine used by every surface.

One code path produces a case from a cluster: enrich → deterministic risk →
cheap-router triage → (benign shortcut | strong investigator) → deterministic
Case Manager decision → persist + audit. Surfaces 2 (investigate), 3 (automated
scan) and the poller all call this, guaranteeing identical, auditable behaviour.

It NEVER raises: any failure yields a NEEDS_HUMAN case (Section 6.7).
"""

from __future__ import annotations

import asyncio
import logging
import weakref
from typing import TYPE_CHECKING, Any

from ..audit.audit_log import AuditLogger
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
    SourceSurface,
    Verdict,
)
from ..engine.case_manager import CaseManager
from ..engine.cost_gate import CaseBudget
from ..engine.precedent import match_analyst_rule_policy
from ..engine.risk import compute_risk
from ..engine.signatures import find_open_case_for_cluster
from ..es.base import BaseESClient
from ..llm.gateway import LLMGateway
from ..models import Case, Cluster, EnrichmentResult, VerdictResult
from ..stores.cases import CaseStore
from ..tools.base import ToolRegistry
from ..tools.enrich import EnrichTool
from ..tools.es_query import DEFAULT_MAX_RESULT_CHARS, EsQueryTool
from ..tools.rag import RagService, RagTool
from ..utils import iso_now, new_id, truncate
from .common import entity_kql, normalize_kql
from .formatter import Formatter
from .graph import run_investigation
from .investigator import Investigator
from .personas import select_persona_with_reason
from .router import Router

if TYPE_CHECKING:  # pragma: no cover - typing only
    from ..engine.case_id import SequenceStore
    from ..playbooks.registry import PlaybookRegistry
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
        playbooks: "PlaybookRegistry | None" = None,
        memory: "MemoryStore | None" = None,
        tuning_store: "TuningStore | None" = None,
        seq_store: "SequenceStore | None" = None,
        notifier: Any = None,
        automation: Any = None,
        event_bus: Any = None,
        investigation_gate: Any = None,
        mutation_task_spawner: Any = None,
    ) -> None:
        self._es = es
        # The agent's read-only log surface. Defaults to wrapping ``es`` in an
        # ElasticConnector (full back-compat) so a direct construction without a
        # source keeps working; state wiring injects the configured connector.
        self._source = source or ElasticConnector(es)
        self._secrets = secrets
        self._cache = cache
        self._gateway = gateway
        self._rag = rag_service
        self._cases = cases
        self._audit = audit
        self._router = Router(gateway, audit)
        # Markdown playbook registry (deterministic per-cluster selection). None →
        # no playbooks (generic investigator), preserving today's behaviour.
        self._playbooks = playbooks
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
        (#3/#11). ``detail`` is a SHORT, already-render-safe label (a persona/playbook
        id, a verdict enum, a status word) — never raw log/AI text (#9; the UI escapes
        it regardless)."""
        try:
            bus = self.event_bus
            if bus is None:
                from ..realtime import get_event_bus

                bus = get_event_bus()
            if bus is None or not case_id:
                return
            payload: dict = {"case_id": case_id, "step": step, "status": status}
            if detail:
                payload["detail"] = truncate(str(detail), 200)
            if extra:
                payload.update(extra)
            bus.publish(f"cases:{case_id}", "agent.step", payload)
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
            await automation.run(case, prefs, save=self._cases.save)
        except Exception as exc:  # noqa: BLE001 — automation must never affect the case flow
            logger.warning("threshold automation skipped for %s: %s", case.case_id, exc)

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
            from ..engine.case_id import render, reset_bucket

            bucket = reset_bucket(fmt.reset_period)
            seq = await self._seq_store.next(fmt.prefix, bucket, start=fmt.seq_start)
            return render(fmt.template, {
                "seq": seq,
                "prefix": fmt.prefix,
                "source": cluster.source_name or "",
            })
        except Exception as exc:  # noqa: BLE001 — numbering must never break creation
            logger.warning("Case-number allocation failed (%s); falling back to case_id", exc)
            return ""

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
        force_playbook_id: str | None = None,
        query_source: PullConnector | None | object = _DEFAULT_QUERY_SOURCE,
        investigation_priority: str = "ingest",
    ) -> Case:
        """Investigate a cluster into a case. The ``find_open_by_signature → save``
        critical section is serialized PER SIGNATURE (:meth:`signature_lock`) so two
        concurrent per-source pollers correlating the SAME signature never both mint a
        case (#4). Different signatures still run concurrently."""
        async with self.signature_lock(cluster.signature):
            return await self._investigate_cluster_locked(
                cluster, source_surface, prefs,
                force=force, force_playbook_id=force_playbook_id,
                query_source=query_source,
                investigation_priority=investigation_priority,
            )

    async def _investigate_cluster_locked(
        self,
        cluster: Cluster,
        source_surface: SourceSurface,
        prefs: Preferences,
        *,
        force: bool = False,
        force_playbook_id: str | None = None,
        query_source: PullConnector | None | object = _DEFAULT_QUERY_SOURCE,
        investigation_priority: str = "ingest",
    ) -> Case:
        gate = self._investigation_gate
        if gate is None:
            return await self._investigate_cluster_effect(
                cluster,
                source_surface,
                prefs,
                force=force,
                force_playbook_id=force_playbook_id,
                query_source=query_source,
            )
        async with gate.permit(
            max(1, int(getattr(prefs.caps, "max_concurrent", 3))),
            "background" if investigation_priority == "background" else "ingest",
        ):
            return await self._investigate_cluster_effect(
                cluster,
                source_surface,
                prefs,
                force=force,
                force_playbook_id=force_playbook_id,
                query_source=query_source,
            )

    async def _investigate_cluster_effect(
        self,
        cluster: Cluster,
        source_surface: SourceSurface,
        prefs: Preferences,
        *,
        force: bool = False,
        force_playbook_id: str | None = None,
        query_source: PullConnector | None | object = _DEFAULT_QUERY_SOURCE,
    ) -> Case:
        case_id = new_id("case-")
        existing: Case | None = None
        # Kept outside the investigation try block so a later failure can preserve a
        # successfully completed retrieval observation instead of erasing it.
        procedure_provenance: dict[str, Any] = {}
        try:
            existing = await find_open_case_for_cluster(self._cases, cluster)
            if existing:
                case_id = existing.case_id

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
            cluster.risk_score = breakdown.total
            cluster.risk_breakdown = breakdown

            budget = CaseBudget(prefs.caps)
            cost = 0.0

            # Multi-agent roster + Markdown playbooks (Vigil-inspired): both are
            # selected deterministically from the cluster. The persona specialises
            # the investigator; the matched playbook is injected as TRUSTED operator
            # procedure (it can only RECOMMEND — code/settings decide close/escalate).
            persona, persona_reason = select_persona_with_reason(cluster, prefs)
            playbook = None
            playbook_reason = "playbooks_disabled"
            if force_playbook_id and self._playbooks is not None:
                # Manual "run a playbook" (F10): the operator FORCES a specific
                # playbook as the injected TRUSTED procedure. This is CONTEXT-ONLY —
                # the playbook can still only RECOMMEND; the deterministic policy
                # decides close/escalate exactly as for an auto-selected playbook (#3).
                forced = self._playbooks.get(force_playbook_id)
                if forced is not None:
                    playbook = forced
                    playbook_reason = f"forced:{force_playbook_id}"
                else:
                    playbook_reason = f"forced_missing:{force_playbook_id}"
            elif prefs.playbooks.enabled and self._playbooks is not None:
                playbook, playbook_reason = self._playbooks.select(cluster)
            platform_tuning = await self._platform_tuning_snapshot(cluster, prefs)
            await self._audit.record(
                action_type=ActionType.DECISION, surface=source_surface.value,
                actor="playbook_selector", case_id=case_id,
                result_summary=(
                    f"playbook={f'{playbook.id} v{playbook.version}' if playbook else 'none'} "
                    f"persona={persona.id} reason={playbook_reason}"
                ),
                tool_input={
                    "playbook_selection": (
                        {
                            "id": playbook.id,
                            "version": playbook.version,
                            "reason": playbook_reason,
                            "forced": bool(force_playbook_id),
                        }
                        if playbook is not None
                        else None
                    ),
                    "persona_selection": {
                        "id": persona.id,
                        "reason": persona_reason,
                    },
                    "platform_tuning": platform_tuning,
                },
            )
            # Live progress: the specialist persona + playbook are selected.
            self._emit_step(
                case_id, "persona", status="running", detail=persona.id,
                extra={"playbook_id": (playbook.id if playbook else "")},
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
                    "playbook_consulted": False,
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
                    "playbook_consulted": False,
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
                try:
                    verdict, flow_cost = await asyncio.wait_for(
                        run_investigation(
                            self._router, investigator, self._rag, cluster, enrichment,
                            prefs, budget, source_surface.value, case_id,
                            persona=persona, playbook=playbook, memory=memory_entries,
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
                result_summary=(
                    f"persona selected={persona.id} consulted="
                    f"{bool(procedure_provenance.get('persona_consulted'))}; "
                    f"playbook selected={playbook.id if playbook else 'none'} consulted="
                    f"{bool(procedure_provenance.get('playbook_consulted'))}"
                ),
                tool_input={
                    "persona": {
                        "selected_id": persona.id,
                        "selection_reason": persona_reason,
                        "consulted": bool(procedure_provenance.get("persona_consulted")),
                    },
                    "playbook": {
                        "selected_id": playbook.id if playbook else None,
                        "selection_reason": playbook_reason,
                        "consulted": bool(procedure_provenance.get("playbook_consulted")),
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

            case_number = await self._allocate_case_number(existing, cluster, prefs)
            retrieval_measured = procedure_provenance.get("retrieval_status") == "measured"
            case = self._assemble_case(
                case_id, cluster, verdict, source_surface, existing, cost, prefs,
                persona_id=persona.id, playbook_id=(playbook.id if playbook else ""),
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
            await self._cases.save(case)
            await self._audit.record(
                action_type=ActionType.DECISION, surface=source_surface.value,
                actor="case_manager", case_id=case_id,
                result_summary=(
                    f"verdict={verdict.verdict.value} status={case.status.value} "
                    f"decision_by={case.decision_by.value if case.decision_by else None} "
                    f"risk={case.risk_score} cost={round(cost, 6)}"
                ),
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
            return case
        except Exception as exc:  # noqa: BLE001 — never drop an alert
            logger.exception("Pipeline failed for cluster %s; failing to human", cluster.signature)
            retrieval_measured = procedure_provenance.get("retrieval_status") == "measured"
            case = _fail_to_human_case(
                case_id,
                cluster,
                source_surface,
                str(exc),
                existing,
                prefs,
                knowledge_used=(
                    list(procedure_provenance.get("knowledge", []) or [])
                    if retrieval_measured
                    else None
                ),
                retrieval_measured=retrieval_measured,
            )
            persist_error: Exception | None = None
            try:
                await self._cases.save(case)
            except Exception as save_exc:  # noqa: BLE001
                persist_error = save_exc
                logger.exception("Could not persist fail-to-human case %s", case_id)
            try:
                await self._audit.record(
                    action_type=ActionType.ERROR, surface=source_surface.value,
                    actor="pipeline", case_id=case_id, result_summary=f"pipeline error: {exc}",
                )
            finally:
                if persist_error is not None:
                    # Returning an unsaved Case would make a webhook/broker ack work
                    # that vanished. Propagate only this terminal persistence failure;
                    # IngestService converts it to its retry boundary.
                    raise RuntimeError(
                        f"could not persist fail-to-human case {case_id}"
                    ) from persist_error
            return case

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
            from ..models import StatusHistoryEntry  # local import avoids a cycle

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
            title=truncate(
                f"{cluster.entity.type.value}:{cluster.entity.value} — "
                f"{', '.join(cluster.rule_values) or 'activity'}", 200),
            summary=truncate(rationale, 300),
            token_cost=(existing.token_cost if existing else 0.0),
            # Analyst-owned state on an un-investigated case survives the close: a grade
            # recorded here is independent ground truth, and tags/comments/assignment are
            # a person's work on the record.
            feedback=(list(existing.feedback) if existing else []),
            tags=(list(existing.tags) if existing else []),
            comments=(list(existing.comments) if existing else []),
            assignee=(existing.assignee if existing else ""),
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
        breakdown = compute_risk(cluster, prefs, 0.0)
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
            title=truncate(
                f"{cluster.entity.type.value}:{cluster.entity.value} — "
                f"{', '.join(cluster.rule_values) or 'activity'}", 200),
            summary=truncate(
                f"Candidate awaiting analysis — {awaiting_reason}." if awaiting_reason
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
            # Reaching the candidate path means no live declaration covered this
            # cluster, so any stale marker from an earlier close is no longer true.
            analyst_policy=None,
        )
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
        playbook_id: str = "",
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
        title = f"{cluster.entity.type.value}:{cluster.entity.value} — {', '.join(cluster.rule_values) or 'activity'}"
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
        return Case(
            case_id=case_id,
            case_number=(existing.case_number if existing and existing.case_number else case_number),
            cluster_signature=cluster.signature,
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
            playbook_id=playbook_id or (existing.playbook_id if existing else ""),
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
    return Case(
        case_id=case_id,
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
        # A failed investigation is still an investigation: the case is NEEDS_HUMAN, not
        # closed by declaration, so the durable marker does not survive.
        analyst_policy=None,
    )


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
