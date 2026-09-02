"""The isolated replay stack — one per replay cell.

Built on the :class:`app.engine.demo_runtime.DemoStack` pattern (a fresh
``InMemoryESClient`` with every store hung off it, a history-free ``EventBus``
explicitly bound onto the pipeline, and a one-flip purge), with three deliberate
inversions:

* the GATEWAY IS REAL — no mock provider override and ``demo=False`` — because a
  mock proves nothing about model behaviour;
* usage rows land in the REAL ledger, tagged and separable, because real money must
  be visible (#6) — see :class:`_DualUsageStore`;
* the pipeline's collaborators MIRROR production rather than copying DemoStack's
  omissions (a real playbook registry, a frozen memory snapshot, a real log-query
  tool), because a replay that does not reproduce production is not a replay.

Lifetime is ONE stack per ``(fixture, arm, repeat)`` cell rather than per run. The
pipeline calls ``find_open_case_for_cluster`` on its case store, so a run-lived stack
would let arm B ATTACH to the case arm A saved for the same signature and inherit its
verdict through the no-material-change short-circuit — with zero model calls. A
per-cell stack makes that structurally impossible rather than a matter of care.
"""

from __future__ import annotations

import logging
from dataclasses import replace as dataclass_replace
from datetime import datetime, timezone
from typing import Any

from ...audit.audit_log import AuditLogger
from ...cache import Cache
from ...config import ModelConfig, Preferences
from ...connectors.base import PullConnector, SearchResult, StructuredQuery
from ...connectors.elastic import ElasticConnector
from ...constants import SourceSurface
from ...es.fake import InMemoryESClient
from ...llm.gateway import GatewayError, LLMGateway
from ...models import Case, Cursor, EnrichmentResult, RawEvent
from ...realtime import EventBus
from ...stores.cases import CaseStore
from ...stores.usage import UsageStore
from ...tools.rag import RagService
from ...tools.vectorstore import InMemoryVectorStore
from ...utils import relative_to_millis
from ..demo_runtime import sandbox_policy
from .fixtures import LoadedFixture

logger = logging.getLogger("tlsoc.engine.replay.stack")

# The local index a frozen event with no recorded index is seeded under, so a
# push-sourced fixture still serves the investigator's read tool. Deliberately a
# harness-owned literal, never an operator's index name.
REPLAY_LOCAL_INDEX = "replay-frozen-events"

# Ledger attribution: ONE stable, low-cardinality surface for every replay row.
#
# Deliberately NOT ``replay:<job_id>``. ``UsageStore.summary`` truncates ``by_surface``
# to the ten most expensive buckets before any consumer sees it, so a per-run key would
# occupy a slot per run and silently evict real production surfaces from the operator's
# cost view — a loss a consumer-side "drop the replay buckets" rule cannot repair,
# because the production buckets are already gone. Per-RUN spend is reported by the job
# record's own ``spend`` block and its keyed ``replay-spend`` audit row instead.
REPLAY_LEDGER_SURFACE = "replay"


class ReplaySpendLimiter:
    """The run's own spend ceiling, checked BEFORE every billable call.

    The tenant :class:`app.engine.budget.BudgetGate` is not sufficient on its own: a
    block there routes one case to NEEDS_HUMAN and the run continues, so an overrun
    would silently manufacture exactly the metric under study. This limiter instead
    latches ``tripped`` at the moment of refusal; the handler converts that into
    cooperative job cancellation, and every cell produced after the trip is excluded
    from scoring.
    """

    def __init__(self, bound_usd: float, mirror: UsageStore) -> None:
        self.bound_usd = float(bound_usd)
        self._mirror = mirror
        self.tripped = False
        self.tripped_reason: str | None = None

    async def accrued_usd(self) -> float:
        """Realised spend for THIS RUN, read from the run-scoped mirror.

        Deliberately not the tenant's ledger window: a replay must be gated on its
        own accrual, not on whatever else the deployment spent today.
        """
        try:
            summary = await self._mirror.summary(window_hours=24 * 30)
            return float(summary.get("total_cost", 0.0) or 0.0)
        except Exception as exc:  # noqa: BLE001 — a mirror glitch must not overrun
            logger.warning("replay spend read failed (%s); treating as at bound", exc)
            return self.bound_usd

    def trip(self, reason: str) -> None:
        if not self.tripped:
            self.tripped = True
            self.tripped_reason = reason

    async def authorize(self, estimate: float) -> bool:
        """Whether one call costing at most ``estimate`` may be dispatched.

        The estimate is worst-case in the OUTPUT dimension only (``max_tokens``);
        INPUT tokens are approximated at four characters per token, so a call whose
        realised tokenisation is denser AND whose completion saturates ``max_tokens``
        can record more than it estimated. Realised spend may therefore exceed the
        bound by at most the estimation error of ONE call — never by a whole call's
        cost, because ``accrued_usd`` re-reads realised actuals before every call so
        errors cannot accumulate — and the cell-boundary actuals check then trips and
        cancels the run. Once tripped it stays tripped until the handler cancels.
        """
        if self.tripped:
            return False
        accrued = await self.accrued_usd()
        if accrued + max(0.0, float(estimate)) > self.bound_usd:
            self.trip("replay_bound")
            return False
        return True


class ReplayBudgetGate:
    """The gateway-shaped pre-flight for a replay: the tenant ceiling AND the run bound.

    Consulting the tenant gate first means a replay can never push the deployment past
    its own configured ceiling; consulting the run limiter second means the operator's
    explicit per-run bound is enforced on the estimate, before the provider call and
    before any ledger write.
    """

    def __init__(self, tenant_gate: Any, limiter: ReplaySpendLimiter) -> None:
        self._tenant = tenant_gate
        self._limiter = limiter

    async def check(
        self, *, prompt_chars: int = 0, max_tokens: int = 0, model: str = "",
        overlay: tuple[float, float] | None = None,
    ) -> dict[str, Any]:
        if self._tenant is not None:
            try:
                decision = await self._tenant.check(
                    prompt_chars=prompt_chars, max_tokens=max_tokens,
                    model=model, overlay=overlay,
                )
            except Exception as exc:  # noqa: BLE001 — the tenant gate is fail-open
                logger.warning("replay tenant budget check failed (%s); continuing", exc)
                decision = None
            if decision is not None and decision.get("action") == "block":
                self._limiter.trip("tenant_budget")
                return decision
        estimate = _estimate(prompt_chars, max_tokens, model, overlay)
        if not await self._limiter.authorize(estimate):
            return {
                "action": "block",
                "reason": (
                    f"replay spend bound ${self._limiter.bound_usd:.4f} would be "
                    f"exceeded by an estimated ${estimate:.6f} call"
                ),
            }
        return {"action": "allow"}


def _estimate(
    prompt_chars: int, max_tokens: int, model: str,
    overlay: tuple[float, float] | None,
) -> float:
    """Worst-case USD for one call, using the SAME pricing the ledger will record."""
    from ..budget import BudgetGate

    # ``estimate_cost`` is pure over its arguments (it reads neither the getter nor the
    # ledger), so a throwaway instance is the cheapest way to reuse the exact pricing
    # resolution the ledger will apply.
    return BudgetGate(lambda: None, None).estimate_cost(
        prompt_chars, max_tokens, model, overlay
    )


class DualUsageStore:
    """Writes to the REAL ledger (tagged) and to a run-scoped mirror; reads the mirror.

    R5's "attributable AND separable": the real write keeps replay spend visible in the
    operator's ledger and inside their budget arithmetic, because it is real money; the
    single ``replay`` surface makes every replay row IDENTIFIABLE without adding
    per-run cardinality to the ledger's bounded surface breakdown. Reads come from the
    mirror so the run's own accrual — and each replayed case's reconciled pipeline
    cost — is exactly this run's.

    The surface rewrite happens HERE and not in the gateway: ``complete()`` still
    receives the production surface, so the service-tier preference a replay gets is
    the one production gets, with no gateway behaviour change.
    """

    def __init__(self, real: Any, mirror: UsageStore, job_id: str) -> None:
        self._real = real
        self._mirror = mirror
        self._job_id = job_id
        self._surface = REPLAY_LEDGER_SURFACE

    def _tagged(self, doc):
        return doc.model_copy(update={"surface": self._surface})

    async def write(self, doc) -> None:
        tagged = self._tagged(doc)
        await self._mirror.write(tagged)
        await self._real.write(tagged)

    async def write_strict(self, doc) -> None:
        tagged = self._tagged(doc)
        await self._mirror.write_strict(tagged)
        await self._real.write_strict(tagged)

    async def summary(self, window_hours: int = 24, case_id: str | None = None):
        return await self._mirror.summary(window_hours=window_hours, case_id=case_id)

    async def total_pipeline_cost_for_case(self, case_id: str) -> float | None:
        return await self._mirror.total_pipeline_cost_for_case(case_id)


class ReplayGateway(LLMGateway):
    """The real gateway, with the run's spend bound extended over embeddings.

    ``embed_with_provenance`` is metered but deliberately NOT budget-gated upstream, so
    a bound enforced only through the completion pre-flight would leave per-query
    retrieval spend unbounded. Subclassing keeps ``llm/gateway.py`` untouched.
    """

    def __init__(self, *args: Any, limiter: ReplaySpendLimiter, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._limiter = limiter

    async def embed_with_provenance(self, texts, model_cfg, *, surface="rag", case_id=None):
        estimate = _estimate(
            sum(len(str(text)) for text in texts), 0, model_cfg.model,
            await self._effective_price_tuple(model_cfg.model),
        )
        if not await self._limiter.authorize(estimate):
            raise GatewayError("replay spend bound reached before an embedding call")
        return await super().embed_with_provenance(
            texts, model_cfg, surface=surface, case_id=case_id
        )


class _ReplayCaseStore(CaseStore):
    """A CaseStore over the throwaway replay ES that ASSERTS its own isolation.

    The write-guard is the enforcement for "a replay writes zero rows to the production
    case store": a mis-binding fails loudly here instead of silently upserting a real
    case by cluster signature.
    """

    def __init__(self, es: InMemoryESClient, job_id: str) -> None:
        super().__init__(es)
        self._replay_es = es
        self._job_id = job_id

    async def save(self, case) -> None:  # noqa: ANN001
        if self._es is not self._replay_es:
            raise RuntimeError("replay case store is not bound to the isolated replay ES")
        tags = list(getattr(case, "tags", []) or [])
        for tag in ("replay", f"run:{self._job_id[:12]}"):
            if tag and tag not in tags:
                tags.append(tag)
        case.tags = tags
        await super().save(case)


class _FrozenRagService(RagService):
    """A RagService pinned to one restored corpus snapshot.

    Two overrides, both load-bearing:

    * ``ensure_seeded`` is a no-op that MARKS the service seeded. Without it the first
      retrieval would rebuild the managed projection (real embedding spend, possibly a
      different vector space) and then sweep every restored document whose id is not in
      the freshly expected set — the pinned corpus would be gone before the first query
      is answered. Marking it seeded also keeps ``retrieve_observed``'s measured check
      (``_seeded and _seed_signature == _source_signature()``) true, so the observation
      is honestly reported as measured.
    * ``index_resolved_case`` is a no-op so a terminal replay case cannot write a
      precedent chunk into the corpus and let arm A poison arm B mid-experiment.
    """

    async def ensure_seeded(self) -> None:
        self._seeded = True
        self._seed_signature = self._source_signature()

    async def index_resolved_case(self, case, note: str = "") -> int:  # noqa: ANN001
        return 0

    async def _reseed(self) -> None:
        """Refuse the embedding-space migration, PRESERVING the pin.

        The production recovery for a query/corpus space mismatch is a full reprojection
        that clears the store and re-embeds — which would silently replace the pinned
        snapshot mid-run (and bill for it). A replay must not do that: the run refuses
        an incompatible corpus up front, so if this is ever reached the honest outcome
        is a retrieval reported UNMEASURED against the corpus we pinned.
        """
        logger.warning(
            "replay refused an embedding-space reprojection; the pinned corpus stands "
            "and this retrieval is reported unmeasured"
        )


class _FrozenMemory:
    """The operator MEMORY snapshot, taken once per run and structurally read-only."""

    def __init__(self, entries: list[Any]) -> None:
        self._entries = list(entries)

    async def list(self, active_only: bool = True) -> list[Any]:  # noqa: ARG002
        return list(self._entries)


class _ReplayEnrichCache(Cache):
    """A process-local enrichment cache seeded from the fixture.

    Kept as a CACHE rather than disabling enrichment because ``enrich_ip`` checks
    ``cfg.enabled`` BEFORE the cache: disabling enrichment would return a neutral
    result and change ``compute_risk``'s reputation input, so the replay would score a
    different risk than the capture did. Any unseeded ``enrich:`` key gets a
    synthesised NEUTRAL result, which guarantees zero outbound HTTP/DNS even if the
    model invokes the enrich tool on an indicator the fixture never saw.
    """

    def __init__(self, seeded: dict[str, Any]) -> None:
        super().__init__(None)
        self._seeded = dict(seeded)

    @staticmethod
    def _is_legacy_enrich_key(key: str) -> bool:
        return key.startswith("enrich:") and not key.startswith("enrich:v2:")

    async def get_json(self, key: str) -> Any | None:
        if key in self._seeded:
            return self._seeded[key]
        if self._is_legacy_enrich_key(key):
            return EnrichmentResult(
                ip=key.split(":", 1)[1],
                reputation_score=0,
                is_malicious=False,
                sources={"note": "not captured in this fixture"},
            ).model_dump(mode="json")
        return None

    async def set_json(self, key: str, value: Any, ttl_seconds: int) -> None:
        if self._is_legacy_enrich_key(key):
            return
        await super().set_json(key, value, ttl_seconds)


class ReplayLogSource(PullConnector):
    """A frozen, deterministic log surface backed by one fixture's raw records.

    The investigator KEEPS its ``es_query`` tool: the tool list is rendered into the
    investigator SYSTEM PROMPT, so two arms with different tool sets are not
    comparable, and an empty-index tool teaches the model that absence of evidence is
    evidence of absence.

    Relative windows are re-anchored to the fixture's CAPTURE instant before the query
    is compiled. A frozen fixture is by definition old, and the tool's default window
    is ``now-24h``, so without this every model query would return zero hits against a
    real corpus of evidence.

    The capturing source's FIELD MAPPING travels with the fixture and is handed to the
    delegate as ordinary connector config, so ``_effective_prefs`` resolves it exactly
    as production did. Without it a non-ECS source's frozen records would be queried
    with the global ECS defaults and return nothing.
    """

    source_type = ElasticConnector.source_type

    def __init__(self, fixture: LoadedFixture, connector_id: str = "replay") -> None:
        self._es = InMemoryESClient()
        indices: list[str] = []
        for hit in fixture.raw_hits:
            index = str(hit.get("_index") or "") or REPLAY_LOCAL_INDEX
            if index not in indices:
                indices.append(index)
            self._es.add_log(index, dict(hit.get("_source") or {}), doc_id=str(hit.get("_id") or ""))
        config = {
            **fixture.mapping_overrides,
            # Always last: the frozen index list is derived from the fixture's own
            # records, never from the operator's current data-view pattern.
            "data_view_pattern": ",".join(indices) or REPLAY_LOCAL_INDEX,
        }
        self._delegate = ElasticConnector(self._es, config, connector_id)
        self._anchor = datetime.fromtimestamp(
            max(0, fixture.captured_at_millis) / 1000.0, tz=timezone.utc
        )
        super().__init__(config, connector_id)

    @classmethod
    def manifest(cls):
        return ElasticConnector.manifest()

    def _anchored(self, expr: str | None, default: str) -> str:
        millis = relative_to_millis(expr if expr is not None else default, now=self._anchor)
        return datetime.fromtimestamp(millis / 1000.0, tz=timezone.utc).isoformat()

    async def ping(self) -> bool:
        return True

    async def poll(self, prefs: Preferences, cursor: Cursor, from_millis: int) -> list[RawEvent]:
        return await self._delegate.poll(prefs, cursor, from_millis)

    async def search(self, prefs: Preferences, query: StructuredQuery) -> SearchResult:
        anchored = query.model_copy(update={
            "time_from": self._anchored(query.time_from, "now-24h"),
            "time_to": self._anchored(query.time_to, "now"),
        })
        return await self._delegate.search(prefs, anchored)

    async def fetch_by_ids(self, prefs: Preferences, ids: list[str], size: int) -> SearchResult:
        return await self._delegate.fetch_by_ids(prefs, ids, size)

    async def close(self) -> None:
        self._es.docs.clear()


def replay_prefs(base: Preferences, fixture: LoadedFixture, arm: Any) -> Preferences:
    """The Preferences one replay cell runs under.

    The evidence projection is PINNED from the fixture (with ``sources=[]`` so the
    per-source resolver falls back to those globals), because ``render_cluster``
    otherwise resolves it from live operator configuration and an unrelated settings
    edit would silently change what the model sees. Clearing ``sources`` also discards
    the capturing source's FIELD MAPPING, so the fixture's captured overlay is layered
    back on as globals — otherwise a non-ECS deployment would replay every fixture
    under ECS defaults. ``state.update_prefs`` is never called: this is a copy, exactly
    as ``sandbox_policy`` is for the policy.
    """
    prefs = base.model_copy(update={
        "auto_close": sandbox_policy(base.auto_close),
        "sources": [],
        **fixture.mapping_overrides,
        # After the overlay: the evidence projection is already RESOLVED in the
        # fixture and must never be re-overridden by a later operator edit.
        "evidence_fields": list(fixture.evidence_fields),
        "evidence_max_chars_per_event": fixture.evidence_max_chars,
        "realtime": base.realtime.model_copy(update={"enabled": False}),
        "threshold_automation": base.threshold_automation.model_copy(update={"enabled": False}),
        "notifications": base.notifications.model_copy(update={"enabled": False}),
    })
    updates: dict[str, Any] = {}
    models = dict(getattr(arm, "models", {}) or {})
    for role, override in models.items():
        current: ModelConfig = getattr(prefs, f"{role}_model")
        patch = {"provider": override.provider, "model": override.model}
        if override.temperature is not None:
            patch["temperature"] = override.temperature
        if override.max_tokens is not None:
            patch["max_tokens"] = override.max_tokens
        updates[f"{role}_model"] = current.model_copy(update=patch)
    rag_top_k = getattr(arm, "rag_top_k", None)
    precedent_enabled = getattr(arm, "precedent_enabled", None)
    if rag_top_k is not None or precedent_enabled is not None:
        rag_patch: dict[str, Any] = {}
        if rag_top_k is not None:
            rag_patch["top_k"] = int(rag_top_k)
        if precedent_enabled is not None:
            rag_patch["use_resolved_cases"] = bool(precedent_enabled)
        updates["rag"] = prefs.rag.model_copy(update=rag_patch)
    max_tool_calls = getattr(arm, "caps_max_tool_calls", None)
    if max_tool_calls is not None:
        updates["caps"] = prefs.caps.model_copy(update={"max_tool_calls": int(max_tool_calls)})
    playbooks_enabled = getattr(arm, "playbooks_enabled", None)
    if playbooks_enabled is not None:
        updates["playbooks"] = prefs.playbooks.model_copy(
            update={"enabled": bool(playbooks_enabled)}
        )
    personas_enabled = getattr(arm, "personas_enabled", None)
    if personas_enabled is not None:
        updates["personas"] = prefs.personas.model_copy(
            update={"enabled": bool(personas_enabled)}
        )
    return prefs.model_copy(update=updates) if updates else prefs


class ReplayStack:
    """One fully isolated investigation environment for one replay cell."""

    def __init__(self, *, run: Any, fixture: LoadedFixture, arm: Any) -> None:
        self.run = run
        self.fixture = fixture
        self.arm = arm
        self.prefs = replay_prefs(run.base_prefs, fixture, arm)
        self.es = InMemoryESClient()
        # History-free and never the global singleton, so a replay ``agent.step`` frame
        # can never reach a live Console session watching a real case room.
        self.event_bus = EventBus(history_per_topic=0)
        self.cases = _ReplayCaseStore(self.es, run.job_id)
        self.audit = AuditLogger(self.es)
        self.vectorstore = InMemoryVectorStore()
        self.source = ReplayLogSource(fixture)
        self.cache = _ReplayEnrichCache(self._enrichment_seed())
        self.rag = _FrozenRagService(
            run.gateway, self.prefs, store=self.vectorstore, cases=self.cases
        )
        # ``memory_enabled`` is an ARM knob: the run pins WHICH entries exist once, the
        # arm decides whether they are injected. Always a ``_FrozenMemory`` (never
        # ``None``) so the two arms differ in content only — passing ``None`` would make
        # the pipeline skip the whole load path and confound the experiment.
        memory_on = getattr(arm, "memory_enabled", None) is not False
        self.memory = _FrozenMemory(run.memory_entries if memory_on else [])
        self.pipeline = self._build_pipeline()

    def _enrichment_seed(self) -> dict[str, Any]:
        """Seed the captured enrichment under the key ``enrich_ip`` will look up."""
        enrichment = self.fixture.enrichment_json
        if not enrichment:
            return {}
        ip = str(enrichment.get("ip") or "")
        return {f"enrich:{ip}": enrichment} if ip else {}

    async def restore_corpus(self) -> None:
        """Load the run's pinned corpus snapshot, vectors included ($0, bit-identical)."""
        await self.vectorstore.add(
            [dataclass_replace(chunk) for chunk in self.run.corpus_chunks]
        )

    def _build_pipeline(self):
        from ...agents.pipeline import InvestigationPipeline

        state = self.run.state
        pipeline = InvestigationPipeline(
            self.es,
            state.secrets,
            self.cache,
            self.run.gateway,
            self.rag,
            self.cases,
            self.audit,
            source=self.source,
            playbooks=state.playbooks,
            memory=self.memory,
            # No tuning ledger: its snapshot only ever reaches an audit annotation,
            # never a prompt, so its absence cannot move a replayed verdict.
            tuning_store=None,
            # Never burn a real case number, page a human, or open a real HITL proposal.
            seq_store=None,
            notifier=None,
            automation=None,
            event_bus=self.event_bus,
            investigation_gate=state.investigation_gate,
        )
        return pipeline

    async def investigate(self) -> Case:
        """Run this cell's investigation end to end against the frozen inputs."""
        surface = _surface_of(self.fixture)
        return await self.pipeline.investigate_cluster(
            self.fixture.cluster(),
            surface,
            self.prefs,
            query_source=self.source,
            investigation_priority="background",
        )

    async def purge(self) -> None:
        """One-flip teardown of every isolated store. Idempotent; never raises."""
        try:
            self.es.docs.clear()
            self.es.alias_to_index.clear()
            self.event_bus.clear()
        except Exception as exc:  # noqa: BLE001 — teardown must never mask a result
            logger.warning("replay stack purge degraded: %s", exc)

    async def aclose(self) -> None:
        await self.purge()
        try:
            await self.source.close()
        except Exception as exc:  # noqa: BLE001
            logger.warning("replay log source close degraded: %s", exc)


def _surface_of(fixture: LoadedFixture) -> SourceSurface:
    """The captured origin surface, so the replay requests the SAME service tier.

    Both surfaces the capture point can produce are already in the gateway's
    discounted-tier allow-set, so tier fidelity is preserved without a gateway change.
    """
    try:
        return SourceSurface(fixture.source_surface)
    except ValueError:
        return SourceSurface.AUTOMATED_SCAN
