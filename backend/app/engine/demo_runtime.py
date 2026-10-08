"""Demo Mode runtime (Wave 5) — the isolated demo store stack + the live simulator.

Two pieces, both completely SEPARATE from the real state:

* :class:`DemoStack` — a throwaway store stack built on a FRESH ``InMemoryESClient``:
  its own CaseStore / AuditLogger / UsageStore + a $0 deterministic mock gateway +
  an InvestigationPipeline + IngestService bound to it, PLUS demo-scoped
  Proposal/Campaign/Baseline/Tuning stores and ONE shared vector store so the
  overhaul's "all capabilities ON" showcase runs in a fully ISOLATED sandbox. NOTHING
  here can reach the real ES/SQL stores or the real HITL/tuning/campaign/baseline
  ledgers. The whole thing is garbage-collected when demo is disabled.

* :class:`DemoSimulator` — an asyncio task (mirrors the receiver tasks) that, while
  demo is in ``live`` mode, drives five standards-faithful sources: Splunk HEC,
  QRadar LEEF/offenses, Wazuh archive/alert JSON, RFC 5424/3164 syslog, and Microsoft
  Entra ID sign-in/Identity Protection JSON. Benign EVENT
  traffic is pre-aggregated through the SAME ``event_detection.funnel()`` real EVENT
  feeds use; occasional Splunk/QRadar/Wazuh native alerts enter normal ingest, while a
  syslog incident is raised by Agentic SOC's own threshold detection. A coherent attack is
  guaranteed on the 20–30 second live-demo boundary, and a cooldown-aware manual trigger
  is exposed for the API. Confirmed candidates are investigated SYNCHRONOUSLY through
  the REAL pipeline against the MOCK LLM + a SANDBOXED AutoClosePolicy copy. Every
  write lands in the demo store; the real durable cursor is never advanced.
"""

from __future__ import annotations

import asyncio
import logging
import random
import time
from typing import Any, Callable

from ..audit.audit_log import AuditLogger
from ..cache import Cache
from ..config import AutoClosePolicy, Preferences, Secrets
from ..constants import SourceSurface
from ..es.fake import InMemoryESClient
from ..llm.gateway import LLMGateway
from ..llm.providers import DemoMockProvider
from ..realtime import EventBus
from ..stores.cases import CaseStore
from ..stores.usage import UsageStore
from ..utils import now_utc, to_millis
from .ingest import IngestService
from . import demo_generator as gen

logger = logging.getLogger("tlsoc.engine.demo")

DEMO_TAG = "demo"

# The first coherent attack is deterministic and appears during a normal product tour,
# rather than depending on a lucky RNG roll.  With the default 10s tick it fires on the
# third tick (at ~20s wall-clock because the first tick runs immediately).
_FIRST_INCIDENT_MIN_SECONDS = 20.0
_MANUAL_INCIDENT_COOLDOWN_SECONDS = 5.0
_MAX_EVENTS_PER_TICK = 2_000


class _DemoCaseStore(CaseStore):
    """A CaseStore over the throwaway demo ES that TAGS every saved case ``demo`` and
    asserts isolation (a write-guard, #4). Cases produced by the demo pipeline get the
    ``demo`` tag here, so the read endpoints' SAMPLE badge + the disable-by-run_id
    purge both work, and no demo row can be mistaken for a real one."""

    def __init__(self, es: InMemoryESClient, run_id: str) -> None:
        super().__init__(es)
        self._run_id = run_id

    async def save(self, case) -> None:  # noqa: ANN001
        tags = list(getattr(case, "tags", []) or [])
        if DEMO_TAG not in tags:
            tags.append(DEMO_TAG)
        run_tag = f"run:{self._run_id[:12]}" if self._run_id else ""
        if run_tag and run_tag not in tags:
            tags.append(run_tag)
        case.tags = tags
        await super().save(case)


def sandbox_policy(base: AutoClosePolicy) -> AutoClosePolicy:
    """A SANDBOXED copy of the auto-close policy for the demo pipeline.

    decide()/apply() are NEVER edited (#3); passing a *different policy instance* to
    the pure decide() is the supported way to isolate demo behaviour. The demo copy
    keeps FALSE_POSITIVE auto-close ENABLED (so the benign baseline auto-closes and
    showcases the deterministic gate) and NEEDS_HUMAN never auto-closes (code-enforced
    regardless). The real ``prefs.auto_close`` is untouched."""
    return base.model_copy(deep=True)


class DemoStack:
    """The isolated demo store stack (built once per enable; GC'd on disable)."""

    def __init__(self, secrets: Secrets, get_prefs: Callable[[], Preferences],
                 *, run_id: str = "") -> None:
        # A FRESH in-memory ES client — physically separate from the real store.
        self.es = InMemoryESClient()
        self.run_id = run_id
        # An ISOLATED, throwaway realtime bus for the demo pipeline's ``agent.step``
        # frames. ``history_per_topic=0`` disables the replay ring so a publish is a
        # true no-op (nothing retained/replayed) and nothing leaks. It has NO
        # subscribers and is garbage-collected with the stack on disable, so demo
        # progress frames NEVER reach the live global EventBus singleton (isolation
        # boundary, mirrors the separate stores). The pipeline is explicitly bound to
        # this bus below so ``_emit_step``'s ``get_event_bus()`` fallback never fires.
        self.event_bus = EventBus(history_per_topic=0)
        self.cases = _DemoCaseStore(self.es, run_id)
        self.audit = AuditLogger(self.es)
        self.usage_store = UsageStore(self.es)
        # A KV adapter over the demo ES (same one the real _wire() uses for the ES
        # backend). Every demo-scoped store below writes into CONFIG_INDEX on this ES,
        # so ``purge()``'s ``self.es.docs.clear()`` ALREADY wipes them all — one-flip.
        from ..stores.memory import EsKVStore
        self.kv = EsKVStore(self.es)
        # Demo-scoped capability stores. NONE of these is the real HITL/tuning/campaign/
        # baseline ledger — every write here is fully isolated to the demo ES.
        from ..stores.baseline import BaselineStore
        from ..stores.batch_jobs import BatchJobStore
        from ..stores.campaigns import CampaignStore
        from ..stores.case_activity import CaseActivityStore
        from ..stores.case_tasks import CaseTaskStore
        from ..stores.case_thread import CaseThreadStore
        from ..stores.chat_conversations import ChatConversationStore
        from ..stores.inbox import InboxStore
        from ..stores.memory import MemoryStore
        from ..stores.proposals import ProposalStore
        from ..stores.shift_handoff import ShiftHandoffStore
        from ..stores.tuning import TuningStore
        self.memory = MemoryStore(self.kv)
        self.proposals = ProposalStore(self.kv)
        self.campaign_store = CampaignStore(self.kv)
        self.baseline_store = BaselineStore(self.kv)
        self.batch_job_store = BatchJobStore(self.kv)
        self.tuning_store = TuningStore(self.kv)
        self.case_threads = CaseThreadStore(self.kv)
        self.chat_conversations = ChatConversationStore(self.kv)
        self.case_activity = CaseActivityStore(self.kv)
        self.case_tasks = CaseTaskStore(self.kv)
        self.inbox = InboxStore(self.kv)
        self.shift_handoff = ShiftHandoffStore(self.kv)
        # Durable raw-alert-by-severity ingest counters backing the demo's
        # noise-reduction surface (over the demo ES — purged on disable).
        from ..stores.noise_counters import NoiseCounterStore
        self.noise_counters = NoiseCounterStore(self.kv)
        # Chat reports made during the demo (chat revamp SPEC §9.1) live on the demo
        # KV too, so disabling Demo Mode purges them with everything else and no demo
        # report can ever reach the tenant's library.
        self.reports = self._build_reports()
        # How many pre-seed "already processed" events were counted (for status/tests).
        self.preseed_events = 0
        # ONE shared vector store for BOTH the pipeline RAG and the chat RAG (the old
        # code built two disconnected InMemoryVectorStores → chat could not see what the
        # pipeline indexed and vice-versa). Sharing it is the RAG-building fix.
        from ..tools.vectorstore import InMemoryVectorStore
        self.vectorstore = InMemoryVectorStore()
        # Sticky, demo-isolated tuned correlation-n bumps: the threshold-tuner's writer
        # stashes bumps here (never on the real prefs) and ``_demo_prefs`` merges them
        # every call so a tuned change is visible on the next tick.
        from ..config import CorrelationRule
        self._tuned_correlation_rules: dict[str, CorrelationRule] = {}
        self._prefs_override: Preferences | None = None
        # The long-lived streaming baseline behind the demo EVENT funnel (warmed/flushed
        # against the demo baseline_store). None → built lazily.
        self._funnel_baseline = None
        # The deterministic, $0 mock provider keyed by storyline. Override EVERY
        # provider accepted by ModelConfig, not merely the two direct SaaS defaults:
        # Demo Mode must never egress if a tenant selected Azure, Bedrock, Vertex, or
        # a custom OpenAI-compatible endpoint before entering the sandbox.
        self._provider = DemoMockProvider()
        overrides = {
            name: self._provider
            for name in (
                "anthropic", "openai", "mock", "azure", "bedrock", "vertex",
                "openai_compatible",
            )
        }
        # demo=True → every usage row is pricing_source='zero' with a synthetic $.
        self.gateway = LLMGateway(secrets, self.usage_store, overrides, demo=True)
        self._get_prefs = get_prefs
        # An offline cache (no Redis) for the demo enrich tool.
        self._cache = Cache(None)
        # FIVE standards-faithful source adapters built once + reused by the
        # pipeline/simulator.  Construction primes their bounded recent rings so Logs
        # and source health are populated before the first background tick.
        from .demo_sources import build_native_demo_sources

        seed = int(getattr(getattr(get_prefs(), "demo", None), "seed", 1337) or 1337)
        self.sources = build_native_demo_sources(
            seed, get_prefs(), now_millis=to_millis(now_utc()), prime_count=12,
        )
        # Lazily built so we avoid importing the (heavy) pipeline at module import.
        self.pipeline = self._build_pipeline(secrets)
        # A handle on the pipeline's RagService so demo /api/rag/* + the shared-store
        # identity check reach it.
        self.rag_service = self.pipeline._rag  # noqa: SLF001 — same module owner
        self.ingest_service = IngestService(self.cases, self.audit, self.pipeline, self._demo_prefs)
        # Wire the demo noise sink so LIVE ticks record raw-alert-by-severity volume into
        # the DEMO counters (the noise-reduction surface then reflects the demo traffic).
        self.ingest_service._noise_sink = self.noise_counters.record  # noqa: SLF001
        # A chat engine bound to the DEMO gateway/audit/cases (NOT the real ones), so a
        # /chat turn while demo is engaged spends $0 (demo gateway → pricing_source
        # 'zero'), writes ONLY demo audit rows (purged on disable), and an in-case chat
        # reads the DEMO case store (so it finds the demo case). This mirrors the
        # demo-switchable active-store @properties on AppState — chat is no exception.
        self.chat_engine = self._build_chat_engine()
        # A standup service over the demo ES (case stats reflect the demo store).
        from ..agents.standup import StandupService

        self.standup_service = StandupService(
            self.es, self.gateway, self.audit,
            cases=self.cases, shift_handoff=self.shift_handoff,
        )
        from ..agents.overview import OverviewService

        self.overview_service = OverviewService(self.gateway, secrets, self._cache, self.audit)

    def _build_pipeline(self, secrets: Secrets):
        from ..agents.pipeline import InvestigationPipeline
        from ..engine.threshold_automation import ThresholdAutomation

        prefs = self._get_prefs()
        source = self.sources["splunk"]  # the SIEM an analyst queries most
        from ..tools.rag import RagService

        rag = RagService(self.gateway, prefs, store=self.vectorstore, cases=self.cases)
        # Wire the demo-scoped HITL automation so a matching case opens a demo Proposal
        # (never the real HITL queue). Leave notifier=None — demo never sends real
        # emails/Slack/webhooks (mirrors the intentional memory=None below).
        automation = ThresholdAutomation(self.proposals, self.audit)
        pipeline = InvestigationPipeline(
            self.es, secrets, self._cache, self.gateway, rag, self.cases, self.audit,
            source=source, automation=automation, memory=self.memory,
            tuning_store=self.tuning_store,
        )
        # Bind the demo's ISOLATED bus so live ``agent.step`` frames never touch the
        # global singleton (isolation boundary). Without this the pipeline's
        # ``_emit_step`` would fall back to ``get_event_bus()`` and leak demo frames.
        pipeline.event_bus = self.event_bus
        return pipeline

    def _build_chat_engine(self):
        """A ChatEngine wired to the DEMO gateway/audit/cases + a demo log source +
        the SHARED demo RAG store, so chat during demo is $0 and isolated — never the
        real gateway/audit/cases. No operator MEMORY is injected in demo (memory=None)
        so a real operator's durable facts never bleed into the demo."""
        from ..agents.chat import ChatEngine
        from ..tools.rag import RagService

        prefs = self._get_prefs()
        source = self.sources["splunk"]
        rag = RagService(self.gateway, prefs, store=self.vectorstore, cases=self.cases)
        return ChatEngine(
            self.es, self.gateway, self.audit, self.cases, rag,
            source=source, memory=self.memory, threads=self.case_threads,
        )

    def _build_reports(self):
        """``stores.reports.ReportStore`` over the demo KV, or None while the reports
        package is not installed."""
        try:
            from ..stores.reports import ReportStore
        except ImportError:
            return None
        return ReportStore(self.kv)

    def chat_context_extras(
        self,
        *,
        prefs: Preferences,
        query_source_for: Callable[[str | None], Any],
    ) -> dict[str, Any]:
        """What Demo Mode changes in a chat turn's tool context (chat revamp SPEC §2,
        §5.1). ``AppState.build_chat_tool_context`` reads everything else through the
        demo-switchable properties already, so this lists only what has no property:

        * no third-party enrichment (``lookup_indicator`` returns its labelled
          synthetic result) and no budget gate (demo spend is simulated);
        * no tenant secrets status and no tenant runbook/playbook/rule-version
          catalogues (the tools report the bundled catalogue instead);
        * case clusters rebuilt from the DEMO log surface, never the tenant one."""
        from .case_cluster import bind_cluster_for_case

        return {
            "enrich": None,
            "budget_gate": None,
            "secrets_status": None,
            "runbooks": None,
            "playbooks": None,
            "rule_versions": None,
            "cluster_for_case": bind_cluster_for_case(
                es=self.es, log_source=self.sources.get("splunk"), prefs=prefs,
                query_source_for=query_source_for,
            ),
        }

    def _demo_prefs(self) -> Preferences:
        """Prefs the demo pipeline runs under: the live prefs but with a SANDBOXED
        auto-close policy (so decide() runs against the demo copy, not the real
        policy), EVERY-mode correlation (so each synthetic storyline event forms a
        cluster) and background scan ON. When ``force_capabilities`` (the default) is
        set, the threshold-tuning / baseline / campaign / threshold-automation / batch
        blocks are forced ON in the SANDBOX COPY ONLY — the REAL prefs (which these are
        read from) are never mutated (this is a model_copy). External enrichment is
        always disabled: even keyless providers perform real HTTP/DNS traffic, which
        an offline synthetic demo must never emit. Read live so safe presentation
        settings still apply during the demo."""
        from ..config import (
            CaseAutomationRule, CorrelationRule, ThresholdAutomationConfig,
        )
        from ..constants import CorrelationMode

        prefs = self._prefs_override or self._get_prefs()
        every = CorrelationRule(mode=CorrelationMode.EVERY, n=1)
        updates: dict = {
            "auto_close": sandbox_policy(prefs.auto_close),
            "default_correlation": every,
            "background_scan_enabled": True,
            "enrichment": prefs.enrichment.model_copy(update={"enabled": False}),
            "realtime": prefs.realtime.model_copy(update={"enabled": True}),
        }
        demo = getattr(prefs, "demo", None)
        force = bool(getattr(demo, "force_capabilities", True)) if demo is not None else True
        if force:
            # Force the capability blocks ON in the SANDBOX only (real prefs untouched).
            # The synthetic tenant deliberately demonstrates one completed tuning
            # observation as well as the separate HITL approval queue.  Its seeded
            # outcomes carry explicit synthetic analyst grades (never model
            # self-grades), so it may auto-apply inside this throwaway sandbox while
            # the real tenant remains review-first by default.
            updates["threshold_tuning"] = prefs.threshold_tuning.model_copy(update={
                "enabled": True,
                "auto_apply_confirmed": True,
            })
            updates["baseline"] = prefs.baseline.model_copy(update={"enabled": True})
            updates["campaign"] = prefs.campaign.model_copy(update={"enabled": True})
            # The EVENT funnel gates on BOTH batch.enabled AND baseline.enabled; force
            # batch ON in the sandbox so the XDR/EDR pre-aggregating funnel actually runs
            # (the demo processes survivors SYNCHRONOUSLY — it never submits to the real
            # batch service).
            updates["batch"] = prefs.batch.model_copy(update={"enabled": True})
            # Threshold automation: force ON + seed a request_approval rule when the
            # operator has none (never clobber their own rules).
            ta = prefs.threshold_automation
            if not ta.rules:
                ta = ThresholdAutomationConfig(enabled=True, rules=[CaseAutomationRule(
                    id="demo-seed-approval",
                    name="Escalate ambiguous verdicts for review",
                    enabled=True, priority=10,
                    conditions={"verdict": "NEEDS_HUMAN"},
                    action="request_approval",
                    payload={"note": "Demo: ambiguous verdict — approve/reject to see HITL."},
                )])
            else:
                ta = ta.model_copy(update={"enabled": True})
            updates["threshold_automation"] = ta
        # Sticky tuned correlation-n bumps (isolated to the sandbox) on top, every call.
        if self._tuned_correlation_rules:
            merged = dict(prefs.correlation_rules)
            merged.update(self._tuned_correlation_rules)
            updates["correlation_rules"] = merged
        return prefs.model_copy(update=updates)

    # ------------------------------------------------------------------ #
    # EVENT-feed routing (XDR/EDR) — pre-aggregate → funnel → sync investigate.
    # ------------------------------------------------------------------ #
    def _demo_event_prefs(self) -> Preferences:
        """Prefs for the HIGH-VOLUME native EVENT funnel. Identical to ``_demo_prefs``
        EXCEPT the correlation default is a high threshold instead of the native ALERT
        path's ``EVERY, n=1`` — otherwise ``event_detection._rule_fires`` would treat
        EVERY benign bucket as a rule hit (a case per event → unbounded). With this the
        funnel relies on the ANOMALY path, so only genuine deviations survive (bounded
        memory + bounded cases).

        It ALSO pins the funnel's grouping entity to HOST. The benign generator stamps a
        random source IP on every event, so an IP-keyed pre-aggregate mints a NEW baseline
        signature per unique IP — the demo baseline_store then grows unboundedly (~5000
        per-IP signatures) tick over tick. Grouping by the BOUNDED host pool (~a few dozen
        hosts) caps the signature cardinality (and therefore the per-tick baseline flush)
        to a small, saturating set — mirroring the real path's bounded-write intent while
        still letting every benign bucket warm the base across ticks."""
        from ..config import CorrelationRule
        from ..constants import CorrelationMode, EntityType
        from .demo_sources import SYSLOG_DETECTION_RULE_IDS

        prefs = self._demo_prefs()
        # Raw syslog never pretends to be a vendor alert.  During a coherent incident
        # its four same-rule events clear this explicit deterministic threshold and
        # Agentic SOC raises its OWN detection through the deterministic event/correlation path.
        correlation_rules = dict(prefs.correlation_rules)
        correlation_rules.update({
            rule_id: CorrelationRule(
                mode=CorrelationMode.THRESHOLD,
                n=4,
                window_seconds=300,
                group_by=EntityType.IP,
            )
            for rule_id in SYSLOG_DETECTION_RULE_IDS
        })
        return prefs.model_copy(update={
            "default_correlation": CorrelationRule(
                mode=CorrelationMode.THRESHOLD, n=10_000, group_by=EntityType.HOST,
            ),
            "correlation_rules": correlation_rules,
            "auto_forward_allowlist": sorted(
                set(prefs.auto_forward_allowlist) | set(SYSLOG_DETECTION_RULE_IDS)
            ),
        })

    async def seed_hitl_proposals(self, cases: list) -> int:
        """Fire threshold-automation on each seeded NEEDS_HUMAN demo case so the seeded
        ``request_approval`` rule opens a demo HITL Proposal — DETERMINISTIC + $0 (no LLM,
        no ``case-<uuid>`` minted; the automation runs on already-persisted demo cases).
        Writes ONLY the demo proposal store (never the real HITL queue). Best-effort —
        never raises. Returns the number of proposals opened (for status/tests)."""
        automation = getattr(self.pipeline, "automation", None)
        if automation is None or not cases:
            return 0
        dprefs = self._demo_prefs()
        opened = 0
        for case in cases:
            try:
                before = await self.open_proposal_count()
                await automation.run(case, dprefs, save=self.cases.save)
                after = await self.open_proposal_count()
                opened += max(0, after - before)
            except Exception as exc:  # noqa: BLE001 — a HITL seed glitch never breaks enable
                logger.debug("demo HITL proposal seed failed for %s: %s",
                             getattr(case, "case_id", "?"), exc)
        return opened

    def build_baseline_engine(self):
        """A fresh streaming anomaly-BASELINE model from the demo prefs' baseline block
        (forced ON in the sandbox). Warmed/flushed against the DEMO baseline_store."""
        from ..engine.baseline import BaselineEngine

        return BaselineEngine(getattr(self._demo_prefs(), "baseline", None))

    async def _ensure_funnel_baseline(self):
        if self._funnel_baseline is None:
            engine = self.build_baseline_engine()
            try:
                series = await self.baseline_store.snapshot()
                for sig, buckets in (series or {}).items():
                    engine.restore(sig, buckets)
            except Exception as exc:  # noqa: BLE001 — a cold baseline is fine
                logger.debug("demo funnel baseline warm-from-store failed (%s); cold start", exc)
            self._funnel_baseline = engine
        return self._funnel_baseline

    async def route_event_batch(self, events: list, segment: str) -> int:
        """Route ONE transient EVENT batch (XDR/EDR) through the cheap-first funnel and
        investigate the survivors SYNCHRONOUSLY, then DROP the raw list.

        The funnel pre-aggregates ``events`` into a bounded number of per-(signature,
        bucket) sketches, folds every bucket into the (demo) baseline (so it warms), and
        emits only the anomalous/rule-fired handful. Memory is bounded by the sketch
        size, NEVER by the retained-events count — this is what keeps ``40/s`` sane and
        $0. Confirmed survivors go straight to ``register_candidate`` +
        ``investigate_cluster`` (mock LLM, fast, deterministic, UNCHANGED decide() #3) —
        never the real batch service. Best-effort; never raises. Returns the number of
        clusters investigated (for logs/tests)."""
        if not events:
            return 0
        from ..engine import event_detection as evdet
        from ..engine.cost_gate import passes_suppression

        prefs = self._demo_event_prefs()
        try:
            baseline = await self._ensure_funnel_baseline()
            # pre_aggregate is a pure read (no observe) — compute the observed signatures
            # up front so we can flush EVERY warmed bucket (not just the candidate ones)
            # and the baseline visibly learns across ticks.
            summaries = evdet.pre_aggregate(events, prefs)
            candidates = evdet.funnel(events, prefs, baseline)
            await self._flush_funnel_baseline(baseline, summaries)
            count = 0
            for cand in candidates:
                cluster = evdet.shape_candidate_cluster(cand)
                # Same defence-in-depth gate the realtime path walks: an entirely-
                # suppressed cluster is the intended drop.
                if not passes_suppression(cluster, prefs):
                    continue
                source = self.sources.get(segment)
                await self.pipeline.register_candidate(cluster, SourceSurface.AUTOMATED_SCAN, prefs)
                await self.pipeline.investigate_cluster(
                    cluster,
                    SourceSurface.AUTOMATED_SCAN,
                    prefs,
                    query_source=source,
                )
                count += 1
            return count
        except Exception as exc:  # noqa: BLE001 — a bad batch must never break the ticker
            logger.warning("demo event-batch routing failed (%s): %s", segment, exc)
            return 0

    async def _flush_funnel_baseline(self, baseline, summaries) -> None:
        """Persist EVERY observed signature's sketch back to the demo baseline_store so
        the base visibly warms across ticks. Best-effort; never raises."""
        try:
            for s in summaries:
                snap = baseline.snapshot(s.signature)
                if snap:
                    await self.baseline_store.put(s.signature, snap)
        except Exception as exc:  # noqa: BLE001 — persistence is best-effort
            logger.debug("demo funnel baseline flush failed (%s)", exc)

    # ------------------------------------------------------------------ #
    # Capability pass (threshold-tuning + campaigns) — demo-scoped, isolated.
    # ------------------------------------------------------------------ #
    def _closed_case_reader(self):
        """An async ``read(limit, offset) -> list[Case]`` pager over the DEMO terminal
        cases (CLOSED + RESOLVED) for the threshold-tuner. Mirrors AppState's, bound to
        the demo case store. Best-effort per status."""
        from ..engine.threshold_tuner import terminal_case_reader

        return terminal_case_reader(self.cases)

    async def _demo_write_prefs(self, new_prefs: Preferences) -> Preferences:
        """The tuner's config-writer, ISOLATED: it NEVER calls state.update_prefs (which
        would persist to the REAL tenant). Instead it stashes the tuned correlation
        rules on the DemoStack so ``_demo_prefs`` merges them on the next tick."""
        try:
            self._tuned_correlation_rules.update(dict(new_prefs.correlation_rules or {}))
        except Exception:  # noqa: BLE001
            pass
        self._prefs_override = new_prefs.model_copy(deep=True)
        return new_prefs

    async def update_execution_prefs(self, new_prefs: Preferences) -> Preferences:
        """Apply an operator change to this throwaway run without durable writes."""
        self._prefs_override = new_prefs.model_copy(deep=True)
        return self._prefs_override

    async def mutate_execution_prefs(
        self, mutate: Callable[[Preferences], Preferences]
    ) -> Preferences:
        """Apply a pure preference delta to the current isolated demo snapshot."""
        return await self._demo_write_prefs(mutate(self._demo_prefs()))

    async def run_capability_pass(self) -> None:
        """One demo-local capability pass: threshold-tuning + campaign correlation, both
        against the DEMO-scoped stores. NEVER touches the real tuning/campaign/proposal
        ledgers. Best-effort — a failure in one leg never breaks the other or the ticker.

        (a) threshold-tuning: since the 3 demo sources are deliberately NOT in
        ``prefs.sources``, a severity_floor suggestion can't locate its source and the
        tuner falls back to a HITL Proposal (a FEATURE, not a bug — the demo naturally
        exercises BOTH auto-tune (correlation_n) AND the approval path). Do NOT "fix"
        this by adding demo sources to prefs.sources.
        (b) campaigns: a pure read-time aggregator over the demo cases (no decide()/LLM)."""
        prefs = self._demo_prefs()
        # (a) threshold tuning.
        try:
            from ..engine.threshold_tuner import run_once

            await run_once(
                prefs, self._closed_case_reader(),
                self.proposals, self.audit,
                tuning_store=self.tuning_store,
                write_prefs=self._demo_write_prefs,
                mutate_prefs=self.mutate_execution_prefs,
            )
        except Exception as exc:  # noqa: BLE001 — tuning must never break the pass
            logger.debug("demo tuning pass failed: %s", exc)
        # (b) campaigns.
        try:
            from ..engine.campaigns import correlate_campaigns

            campaigns = await correlate_campaigns(None, prefs, cases_store=self.cases)
            if campaigns:
                await self.campaign_store.upsert_many(campaigns)
        except Exception as exc:  # noqa: BLE001 — campaigns must never break the pass
            logger.debug("demo campaign pass failed: %s", exc)

    async def open_proposal_count(self) -> int:
        """Number of PENDING (awaiting-review) demo HITL proposals (best-effort → 0)."""
        try:
            props = await self.proposals.list(status="pending")
            return len(props)
        except Exception:  # noqa: BLE001
            try:
                return len(await self.proposals.list())
            except Exception:  # noqa: BLE001
                return 0

    def source_runtime_snapshot(self, *, running: bool | None = None) -> dict[str, Any]:
        """Serializable five-source health/log contract for demo API overlays.

        Source adapters own their bounded recent rings and counters; this accessor is
        intentionally read-only so ``state.py``/routes need no knowledge of receiver
        internals and can never mutate demo or real state while rendering health.
        """
        rows: list[dict[str, Any]] = []
        demo = getattr(self._get_prefs(), "demo", None)
        mode = str(getattr(demo, "mode", "seeded") or "seeded")
        is_running = bool(mode == "live" if running is None else running)
        tick_seconds = float(getattr(demo, "tick_seconds", 10.0) or 10.0)
        snapshot_now = to_millis(now_utc())
        for key in self.sources:
            source = self.sources[key]
            try:
                rows.append(source.activity_snapshot(
                    now_millis=snapshot_now,
                    mode=mode,
                    running=is_running,
                    tick_seconds=tick_seconds,
                ))
            except Exception as exc:  # noqa: BLE001 -- health degrades per source
                rows.append({
                    "key": key,
                    "source_id": getattr(source, "connector_id", f"demo-{key}"),
                    "display_name": key,
                    "enabled": True,
                    "healthy": False,
                    "state": "degraded",
                    "buffer_depth": 0,
                    "events_total": 0,
                    "alerts_total": 0,
                    "last_event_millis": 0,
                    "events_per_min": 0.0,
                    "can_browse": False,
                    "last_error": str(exc),
                    "demo": True,
                })
        return {"sources": rows}

    async def purge(self) -> None:
        """Hard-delete ALL demo data (cases/audit/usage/events + the demo-scoped
        capability stores, which all live on this ES) by dropping the demo ES client's
        in-memory docs. Idempotent; never raises."""
        # Defense-in-depth: the demo pipeline publishes onto ``self.event_bus`` (an
        # isolated, history-disabled throwaway bus), so the global singleton should
        # already be clean. But if a FUTURE wiring regression ever let a demo
        # ``cases:{id}`` frame land in the global bus replay ring, scrub it here so a
        # demo run can never leave frames replayable past teardown. Collect the demo
        # case ids BEFORE we drop the in-memory docs below. Best-effort; never raises.
        try:
            from ..realtime import get_event_bus

            demo_case_ids = {
                str(doc.get("case_id"))
                for index in self.es.docs.values()
                for doc in index.values()
                if isinstance(doc, dict) and doc.get("case_id")
            }
            global_bus = get_event_bus()
            history = getattr(global_bus, "_history", None)
            if isinstance(history, dict) and demo_case_ids:
                for topic in list(history.keys()):
                    if topic.startswith("cases:") and topic.split("cases:", 1)[1] in demo_case_ids:
                        history.pop(topic, None)
        except Exception:  # noqa: BLE001 — purge is best-effort, never raises
            pass
        try:
            self.event_bus.clear()
        except Exception:  # noqa: BLE001
            pass
        try:
            self.es.docs.clear()
            self.es.alias_to_index.clear()
        except Exception:  # noqa: BLE001
            pass

    async def aclose(self) -> None:
        try:
            await self.gateway.aclose()
        except Exception:  # noqa: BLE001
            pass


# A capability pass runs roughly every ~60s of demo wall-clock regardless of the tick
# cadence (a live demo session is minutes long, not the real "nightly/daily").
_CAPABILITY_TARGET_SECONDS = 60.0


class DemoSimulator:
    """The live demo ticker (only runs in ``mode == 'live'``).

    Each tick gives every source benign traffic through the cheap EVENT funnel.  On a
    deterministic cadence Splunk/QRadar/Wazuh emit their native alert contracts; a
    five-source storyline is guaranteed during the first 20–30 seconds. Syslog remains
    raw telemetry and clears an Agentic SOC correlation threshold instead of claiming a vendor
    alert.  All calls are synchronous against the isolated $0 stack, bounded, and cleanly
    cancellable."""

    def __init__(
        self,
        stack: DemoStack,
        get_prefs: Callable[[], Preferences],
        *,
        seed: int,
        monotonic: Callable[[], float] | None = None,
    ) -> None:
        self._stack = stack
        self._get_prefs = get_prefs
        self._rng = random.Random(seed ^ 0x71C)
        self._task: asyncio.Task | None = None
        self._running = False
        self._stories = list(gen.STORYLINES)
        self._story_idx = 0
        self._native_alert_idx = 0
        self._logical_elapsed = 0.0
        self._alert_elapsed = 0.0
        self._monotonic = monotonic or time.monotonic
        self._started_monotonic = self._monotonic()
        self._cooldown_until_monotonic = 0.0
        self._first_incident_fired = False
        self._incident_lock = asyncio.Lock()
        self._tick_count = 0
        self._capability_tick = 0

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._running = True
            self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            self._task = None

    async def tick_once(self) -> dict[str, int]:
        """One simulation tick (also callable directly from tests for determinism).

        Returns stable counters while preserving the legacy ``benign/story/events``
        keys used by callers.  ``alerts`` counts source-native alerts only; the raw
        syslog contribution is counted under ``system_detections`` when it fires."""
        prefs = self._get_prefs()
        demo = getattr(prefs, "demo", None)
        if demo is None or not demo.active:
            return {
                "benign": 0, "story": 0, "events": 0,
                "alerts": 0, "system_detections": 0,
            }
        now = to_millis(now_utc())
        dprefs = self._stack._demo_prefs()  # noqa: SLF001 — same module owner
        tick_s = float(getattr(demo, "tick_seconds", 10.0) or 10.0)
        self._tick_count += 1
        self._logical_elapsed += tick_s
        self._alert_elapsed += tick_s

        # Every configured source gets a fair share of the logical event volume.  Raw
        # values exist only for this bounded tick and are dropped after aggregation;
        # each adapter retains at most its 500-event browse ring.
        events_n = await self._route_event_feeds(now, dprefs, demo)
        story_n = 0
        alerts_n = 0
        system_detections = 0

        # The first incident is deterministic, not RNG.  The logical boundary keeps
        # manual tick tests reproducible; the monotonic boundary + _run delay clamp make
        # a real live session fire at ~20s even with a heavily customized tick/jitter.
        first_due = _FIRST_INCIDENT_MIN_SECONDS + tick_s
        live_elapsed = self._monotonic() - self._started_monotonic
        incident_result: dict[str, Any] | None = None
        if (
            not self._first_incident_fired
            and (
                self._logical_elapsed >= first_due
                or live_elapsed >= _FIRST_INCIDENT_MIN_SECONDS
            )
        ):
            incident_result = await self.trigger_incident(force=True, scheduled_first=True)
            self._first_incident_fired = (
                self._first_incident_fired or bool(incident_result.get("triggered"))
            )
        else:
            alert_s = max(1.0, float(
                getattr(demo, "alert_interval_seconds", 120.0) or 120.0
            ))
            if self._alert_elapsed >= alert_s:
                self._alert_elapsed %= alert_s
                if self._rng.random() < float(demo.incident_rate):
                    incident_result = await self.trigger_incident()
                else:
                    alerts_n += await self._emit_native_alert(now, dprefs)

        if incident_result and incident_result.get("triggered"):
            story_n = 1
            alerts_n += int(incident_result.get("native_alerts", 0) or 0)
            system_detections += int(incident_result.get("system_detections", 0) or 0)

        return {
            "benign": events_n,
            "story": story_n,
            "events": events_n,
            "alerts": alerts_n,
            "system_detections": system_detections,
        }

    @staticmethod
    def _allocate_source_counts(total: int) -> dict[str, int]:
        """Deterministically split ``total`` by source shares; give every source traffic."""
        from .demo_sources import DEMO_SOURCE_SPECS

        keys = list(DEMO_SOURCE_SPECS)
        if total <= 0:
            return {key: 0 for key in keys}
        total = max(total, len(keys))
        counts = {
            key: int(total * DEMO_SOURCE_SPECS[key].rate_share)
            for key in keys
        }
        # Guarantee every source one event, then distribute rounding remainder in the
        # stable dashboard order.  If this overshoots, take from the largest buckets.
        for key in keys:
            counts[key] = max(1, counts[key])
        while sum(counts.values()) < total:
            key = keys[(sum(counts.values()) - len(keys)) % len(keys)]
            counts[key] += 1
        while sum(counts.values()) > total:
            key = max(keys, key=lambda item: (counts[item], -keys.index(item)))
            if counts[key] <= 1:
                break
            counts[key] -= 1
        return counts

    async def _route_event_feeds(self, now: int, dprefs: Preferences, demo) -> int:
        """Materialise each native EVENT feed, funnel it, then drop the raw batch."""
        tick_s = float(getattr(demo, "tick_seconds", 10.0) or 10.0)
        rate = float(getattr(demo, "event_rate_per_second", 40.0) or 0.0)
        weight = gen.diurnal_weight(now)
        total = min(_MAX_EVENTS_PER_TICK, int(round(rate * tick_s * weight)))
        if total <= 0:
            return 0
        materialised = 0
        for source_key, n in self._allocate_source_counts(total).items():
            if n <= 0:
                continue
            source = self._stack.sources[source_key]
            events = source.benign_batch_raw(self._rng, now, n, dprefs)
            materialised += len(events)
            await self._stack.route_event_batch(events, source_key)
        return materialised

    async def _emit_native_alert(self, now: int, dprefs: Preferences) -> int:
        """Rotate a low-confidence native alert across Splunk, QRadar, and Wazuh."""
        from .demo_sources import SOURCE_NATIVE_ALERT_KEYS

        if not SOURCE_NATIVE_ALERT_KEYS:
            return 0
        key = SOURCE_NATIVE_ALERT_KEYS[self._native_alert_idx % len(SOURCE_NATIVE_ALERT_KEYS)]
        self._native_alert_idx += 1
        source = self._stack.sources[key]
        events = source.native_alert_raw(self._rng, now, dprefs)
        if events:
            await self._stack.ingest_service.ingest(
                events,
                dprefs,
                source_surface=SourceSurface.AUTOMATED_SCAN,
                source_id=source.connector_id,
                query_source=source,
            )
        return len(events)

    async def trigger_incident(
        self,
        story_id: str | None = None,
        *,
        force: bool = False,
        scheduled_first: bool = False,
    ) -> dict[str, Any]:
        """Emit one coherent five-source attack, respecting a short trigger cooldown.

        This is the presentation-safe seam for ``POST /api/demo/incident``.  It never
        reaches a network or real store. Splunk/QRadar/Wazuh/Entra emit native detections;
        four RFC 5424 syslog records remain events and clear Agentic SOC's explicit threshold.
        The return value is fully serializable and attributes every count per source.
        """
        prefs = self._get_prefs()
        demo = getattr(prefs, "demo", None)
        if demo is None or not demo.active:
            return {
                "triggered": False,
                "reason": "demo mode is off",
                "scenario_id": story_id or "",
                "events": 0,
                "native_alerts": 0,
                "system_detections": 0,
                "cooldown_seconds": 0.0,
                "sources": {},
            }
        remaining = max(0.0, self._cooldown_until_monotonic - self._monotonic())
        if remaining > 0.0 and not force:
            return {
                "triggered": False,
                "reason": "incident trigger is cooling down",
                "scenario_id": story_id or "",
                "events": 0,
                "native_alerts": 0,
                "system_detections": 0,
                "cooldown_seconds": round(remaining, 3),
                "sources": {},
            }

        async with self._incident_lock:
            # A due background tick may have decided to emit before a concurrent
            # manual request acquired the lock. If that manual request completed
            # first, its incident already fulfils the guaranteed-first promise; the
            # scheduled path must not bypass cooldown with `force=True` and duplicate it.
            if scheduled_first and self._first_incident_fired:
                return {
                    "triggered": False,
                    "reason": "first demo incident was already emitted",
                    "scenario_id": story_id or "",
                    "events": 0,
                    "native_alerts": 0,
                    "system_detections": 0,
                    "cooldown_seconds": round(max(
                        0.0, self._cooldown_until_monotonic - self._monotonic()
                    ), 3),
                    "sources": {},
                }
            # Re-check after acquiring: two concurrent API requests can both pass the
            # optimistic check above, but only the first may emit.  The second observes
            # the cooldown written before the first releases this lock.
            remaining = max(0.0, self._cooldown_until_monotonic - self._monotonic())
            if remaining > 0.0 and not force:
                return {
                    "triggered": False,
                    "reason": "incident trigger is cooling down",
                    "scenario_id": story_id or "",
                    "events": 0,
                    "native_alerts": 0,
                    "system_detections": 0,
                    "cooldown_seconds": round(remaining, 3),
                    "sources": {},
                }
            if story_id:
                story = next((item for item in self._stories if item.id == story_id), None)
                if story is None:
                    return {
                        "triggered": False,
                        "reason": f"unknown demo scenario: {story_id}",
                        "scenario_id": story_id,
                        "events": 0,
                        "native_alerts": 0,
                        "system_detections": 0,
                        "cooldown_seconds": 0.0,
                        "sources": {},
                    }
            else:
                story = self._stories[self._story_idx % len(self._stories)]
            self._story_idx += 1
            now = to_millis(now_utc())
            dprefs = self._stack._demo_prefs()  # noqa: SLF001 -- same-module owner
            per_source: dict[str, dict[str, Any]] = {}
            total_events = 0
            native_alerts = 0
            system_detections = 0
            for key in self._stack.sources:
                source = self._stack.sources[key]
                events = source.storyline_raw(story, self._rng, now, dprefs)
                total_events += len(events)
                if key == "syslog":
                    # Direct push ingest performs deterministic N=4 correlation under
                    # _demo_event_prefs; the raw source never claims alert provenance.
                    stats = await self._stack.ingest_service.ingest(
                        events,
                        self._stack._demo_event_prefs(),  # noqa: SLF001
                        source_surface=SourceSurface.AUTOMATED_SCAN,
                        source_id=source.connector_id,
                        query_source=source,
                    )
                    detected = max(
                        int(stats.get("investigated", 0) or 0),
                        int(stats.get("candidates", 0) or 0),
                    )
                    source.record_system_detections(detected)
                    system_detections += detected
                    per_source[key] = {
                        "source_id": source.connector_id,
                        "events": len(events),
                        "native_alerts": 0,
                        "system_detections": detected,
                        "investigated": int(stats.get("investigated", 0) or 0),
                    }
                else:
                    stats = await self._stack.ingest_service.ingest(
                        events,
                        dprefs,
                        source_surface=SourceSurface.AUTOMATED_SCAN,
                        source_id=source.connector_id,
                        query_source=source,
                    )
                    native_alerts += len(events)
                    per_source[key] = {
                        "source_id": source.connector_id,
                        "events": len(events),
                        "native_alerts": len(events),
                        "system_detections": 0,
                        "investigated": int(stats.get("investigated", 0) or 0),
                    }
            self._cooldown_until_monotonic = (
                self._monotonic() + _MANUAL_INCIDENT_COOLDOWN_SECONDS
            )
            # A manual incident already fulfils the guaranteed-first-story promise;
            # do not surprise the presenter with another forced story ~20s later.
            self._first_incident_fired = True
            return {
                "triggered": True,
                "reason": "coherent synthetic attack emitted",
                "scenario_id": story.id,
                "scenario_name": story.name,
                "events": total_events,
                "native_alerts": native_alerts,
                "system_detections": system_detections,
                "cooldown_seconds": _MANUAL_INCIDENT_COOLDOWN_SECONDS,
                "sources": per_source,
            }

    def runtime_snapshot(self) -> dict[str, Any]:
        """Serializable simulator + source state for status/health endpoints."""
        snapshot = self._stack.source_runtime_snapshot(running=self._running)
        snapshot.update({
            "running": self._running,
            "tick_count": self._tick_count,
            "logical_elapsed_seconds": round(self._logical_elapsed, 3),
            "wall_elapsed_seconds": round(
                max(0.0, self._monotonic() - self._started_monotonic), 3
            ),
            "first_incident_fired": self._first_incident_fired,
            "next_story_index": self._story_idx,
            "cooldown_seconds": round(
                max(0.0, self._cooldown_until_monotonic - self._monotonic()), 3
            ),
        })
        return snapshot

    async def _run(self) -> None:
        logger.info("Demo simulator started")
        while self._running:
            prefs = self._get_prefs()
            demo = getattr(prefs, "demo", None)
            base = float(getattr(demo, "tick_seconds", 10.0) or 10.0) if demo else 10.0
            jitter = float(getattr(demo, "tick_jitter", 0.3) or 0.0) if demo else 0.0
            delay = max(0.5, base * (1.0 + self._rng.uniform(-jitter, jitter)))
            if not self._first_incident_fired:
                remaining = max(
                    0.0,
                    _FIRST_INCIDENT_MIN_SECONDS
                    - (self._monotonic() - self._started_monotonic),
                )
                if remaining > 0.0:
                    delay = min(delay, max(0.5, remaining))
            try:
                if demo is not None and demo.mode == "live":
                    await self.tick_once()
                    self._capability_tick += 1
                    every_n = max(1, round(_CAPABILITY_TARGET_SECONDS / max(1.0, base)))
                    if self._capability_tick % every_n == 0:
                        # Awaited INSIDE this task so a disable/stop() cancel tears down
                        # any in-flight capability pass cleanly (never create_task'd).
                        await self._stack.run_capability_pass()
            except Exception as exc:  # noqa: BLE001 — a bad tick must not kill the loop
                logger.warning("demo tick failed (loop continues): %s", exc)
            await asyncio.sleep(delay)
