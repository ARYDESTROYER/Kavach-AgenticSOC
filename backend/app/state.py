"""Application state — the dependency-injection hub and lifecycle owner.

``AppState.create`` builds every component; in production it wires the real ES
client + real LLM gateway, and in tests it accepts an injected ES client and
provider overrides so the entire app runs in-process with no network.

``_wire`` is the single place all ES-derived components are (re)constructed, so a
wizard-driven credential change can re-point the whole graph at a fresh ES client
without a restart.
"""

from __future__ import annotations

import asyncio
import copy
import hashlib
import logging
import secrets as stdlib_secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from .agents.chat import ChatEngine
from .agents.overview import OverviewService
from .agents.pipeline import InvestigationPipeline
from .agents.standup import StandupService
from .audit.audit_log import AuditLogger
from .cache import Cache
from .config import Preferences, Secrets
from .engine.ingest import IngestService
from .engine.release_discovery import ReleaseDiscoveryService
from .es.base import BaseESClient
from .es.indices import bootstrap_indices
from .llm.gateway import LLMGateway
from .llm.providers import BaseProvider
from .stores.cases import CaseStore
from .stores.config_store import ConfigStore
from .stores.cursor_store import CursorStore
from .stores.usage import UsageStore
from .tools.rag import RagService

logger = logging.getLogger("tlsoc.state")

_ES_SECRET_FIELDS = {"es_api_key", "es_mgmt_api_key", "es_url", "es_ca_cert", "es_verify_certs"}


class AppState:
    def __init__(
        self,
        secrets: Secrets,
        es: BaseESClient,
        provider_overrides: dict[str, BaseProvider] | None = None,
    ) -> None:
        self.secrets = secrets
        self.es = es
        self.prefs = Preferences()
        self.cache = Cache(secrets.redis_url)
        # Read-only public GitHub release metadata discovery. This service owns only
        # an in-process TTL cache; it has no Git/deployment/process mutation surface.
        self.release_discovery = ReleaseDiscoveryService()
        self._provider_overrides = provider_overrides
        self._receivers: list = []
        self._receiver_tasks: list = []
        # Background receiver runtime is started only with the production poller.
        # Source CRUD may happen in test/demo states created with
        # ``start_poller=False``; those states must not unexpectedly bind sockets or
        # start broker clients.  In a normal runtime, CRUD calls reconcile the live
        # receiver set immediately through this gate.
        self._receivers_enabled = False
        # Async SQL engine for the SQL state backend (None on the ES backend).
        # Built lazily in _build_state_backend and disposed on shutdown.
        self._sql_engine = None
        # A per-source ES client OWNED by this AppState (built when the primary
        # source carries its own ES connection/TLS overrides); closed on rewire +
        # shutdown. None means the primary uses the shared global client.
        self._owned_log_client = None
        # Demo Mode (Wave 5): a SEPARATE, throwaway store stack + live simulator,
        # built ONLY while demo is engaged. None == demo off (the default). The
        # "active store" properties below switch every read/write store onto this
        # stack so REAL cases are hidden + isolated; disable GC's it + the real
        # state returns intact.
        self._demo = None
        self._demo_sim = None
        # Serialize enable/reset/disable as one lifecycle transaction. Without this,
        # concurrent enables can each create a live ticker before the later request
        # overwrites the only reachable handle, leaking an orphan simulator.
        self._demo_lifecycle_lock = asyncio.Lock()
        # Seeded/manual demo actions share one non-started simulator so explicit ticks
        # and incident-trigger cooldowns retain deterministic logical time. Live mode
        # uses ``_demo_sim`` instead. Both are throwaway and stopped on disable.
        self._demo_incident_sim = None
        # Round-4 Wave-3: the lazily-built batch service is memoised here; _wire()
        # clears it so a credential/store rebuild re-binds it to the fresh gateway/store.
        self._batch_service = None
        self._job_runner = None
        # Round-4 Wave-4: the gated background schedulers (threshold-tuner / campaign /
        # batch-jobs). Started in startup() (behind start_poller), cancelled in
        # shutdown(). Tuning observation and campaign grouping are default ON; async
        # Batch remains opt-in. Every loop still checks its live Preferences gate before
        # doing work.
        self._scheduler_tasks: list[asyncio.Task] = []
        self._scheduler_running = False
        # Terminal updater outcomes are durable in the host-side supervisor, but
        # the browser that initiated an update may disappear while this backend is
        # being replaced.  A separate reconciler replays the supervisor's bounded
        # public completion feed into our append-only audit after restart.  It is
        # intentionally outside the feature schedulers: audit recovery must run
        # even when setup is incomplete, polling is disabled, or the kill switch
        # is engaged.
        self._update_audit_task: asyncio.Task | None = None
        self._update_audit_running = False
        # Operator-visible worker health. A scheduler is not "healthy" merely
        # because its asyncio task exists: each pass records attempt, confirmed
        # success, failure, and processed count so silent/false-success loops are
        # diagnosable. This is runtime telemetry only; campaign/tuner stores retain
        # their durable last-success anchors across restarts.
        self._scheduler_health: dict[str, dict[str, Any]] = {
            name: {
                "last_attempt_at": "",
                "last_success_at": "",
                "last_error": "",
                "processed": 0,
            }
            for name in (
                "threshold_tuner",
                "campaign_correlation",
                "baseline_producer",
                "batch_jobs",
            )
        }
        # The single, long-lived streaming baseline model behind the EVENT-feed detection
        # funnel (Wave-4). Warmed from baseline_store on first use; None until built. It
        # holds per-(signature, bucket) sketches in memory so the funnel's anomaly pass
        # improves across polls. Rebuilt on _wire() (fresh prefs/store handles).
        self._funnel_baseline = None
        # Autopilot overhaul (A4): the long-lived REALTIME baseline PRODUCER — a SEPARATE
        # engine from the funnel one, fed every tick with per-cluster + per-source ingest
        # volume so the baseline learns from day one (advisory anomaly + silent-source /
        # flood detection). Warmed from baseline_store on first use; rebuilt on _wire().
        self._realtime_baseline = None
        # Per-source last-event wall clock (v0 flat silent-source check — works BEFORE the
        # baseline warm-up). Kept across _wire() rebuilds so a source edit never resets a
        # source's silence clock. Advisory only — never feeds decide() (#3).
        self._source_last_event: dict[str, datetime] = {}
        # Per-source count of NON-EMPTY observed ticks (how many times this source actually
        # delivered events). Kept across _wire() rebuilds like _source_last_event. Gates the
        # silent-source check (B3): only an ESTABLISHED source — one with a genuine activity
        # history — earns the raised long-quiet tolerance; a barely-seen / just-started
        # source keeps the conservative cold-start flat window. Advisory only — never feeds
        # decide() (#3).
        self._source_event_ticks: dict[str, int] = {}
        # Serialize preference writes. ``config_store.save`` is a full-document replace
        # with no CAS, and ``update_prefs`` assigns ``self.prefs`` outside any lock, so
        # two concurrent writers (e.g. an operator source edit racing the nightly
        # threshold-tuner's bounded-knob write) can interleave their save/assign and lose
        # an update — the symptom being a source rename that "did not persist". This lock
        # makes each write atomic, and ``mutate_prefs`` runs the read-modify-write under
        # it so a caller's edit is applied against the freshest prefs. Created in __init__
        # (not _wire) so it is a single stable lock across credential-driven rewires.
        self._prefs_lock = asyncio.Lock()
        from .engine.investigation_gate import InvestigationGate
        from .engine.mutation_gate import MutationAdmissionGate

        self.investigation_gate = InvestigationGate()
        # Process-local half of the factory-reset write fence. The durable Jobs and
        # Batch documents protect claims/submissions across replicas; this gate drains
        # already-admitted unsafe HTTP requests in the supported single-process runtime.
        self.mutation_gate = MutationAdmissionGate()
        # Detached notification/automation work can outlive the request that spawned
        # it. Keep every tenant-writing task reachable so factory reset can cancel and
        # await it after closing HTTP admission and before clearing state.
        self._mutation_tasks: set[asyncio.Task[Any]] = set()
        # BaseSettings folds environment values into mutable dicts. Capture their boot
        # value once so reset removes runtime UI additions without erasing environment-
        # supplied connector/SSO/notification credentials.
        self._runtime_secret_fields = frozenset(
            {
                # UI-set model and embedding credentials.
                # The read-only log-surface key is tenant/source authority; restore
                # its boot value while preserving the active management URL/key and
                # state backend that own this reset transaction.
                "es_api_key",
                "openai_api_key",
                "anthropic_api_key",
                "litellm_api_key",
                "azure_openai_api_key",
                "aws_access_key_id",
                "aws_secret_access_key",
                "aws_session_token",
                "vertex_api_key",
                "embedding_api_key",
                # Every provider field mutable through routes_enrichment.
                "abuseipdb_api_key",
                "virustotal_api_key",
                "greynoise_api_key",
                "shodan_api_key",
                "censys_api_id",
                "censys_api_secret",
                "binaryedge_api_key",
                "ipinfo_token",
                "otx_api_key",
                "pulsedive_api_key",
                "spur_api_key",
                "xforce_api_key",
                "xforce_api_password",
                "urlscan_api_key",
                "hibp_api_key",
                "honeypot_access_key",
                "abusech_auth_key",
                # Runtime maps managed by source/SSO/notification routes.
                "connector_secrets",
                "sso_client_secrets",
                "notification_secrets",
            }
        )
        self._boot_runtime_secrets = {
            field: copy.deepcopy(getattr(secrets, field))
            for field in self._runtime_secret_fields
        }
        # Continuation cursors for privileged portable exports are signed with a
        # purpose-separated server key.  A configured auth JWT secret makes the
        # key stable across replicas/restarts; the no-secret development profile
        # gets an unpredictable process-lifetime key instead.  The raw key is never
        # serialized or exposed through an API.
        cursor_seed = (
            secrets.auth_jwt_secret.encode("utf-8")
            if secrets.auth_jwt_secret
            else stdlib_secrets.token_bytes(48)
        )
        self._export_cursor_signing_key = hashlib.sha256(
            b"agentic-soc:portable-export-cursor:v2\x00" + cursor_seed
        ).digest()
        self._wire()

    # ------------------------------------------------------------------ #
    # Active-store indirection (Demo Mode, Wave 5).
    #
    # Every READ/WRITE endpoint reaches its store via these properties, NOT the raw
    # ``_real_*`` attributes. When demo is engaged (``self._demo`` is set) they
    # transparently return the throwaway demo stack, so the cases list / metrics /
    # overview / cost / standup / browse all serve DEMO data and the REAL cases are
    # hidden — without a single ``if demo`` in any route. When demo is off, the real
    # store is returned, byte-for-byte as before. A WRITE-GUARD asserts no demo row
    # can reach the real store (and vice-versa); see ``_write_guard``.
    # ------------------------------------------------------------------ #
    @property
    def demo_active(self) -> bool:
        return self._demo is not None

    def spawn_mutation_task(self, coro, *, name: str | None = None) -> asyncio.Task[Any]:
        """Spawn one tracked tenant-writing task, rejecting work after admission closes."""

        if self.mutation_gate.closed:
            close = getattr(coro, "close", None)
            if callable(close):
                close()
            raise RuntimeError("factory reset mutation fence is closed")
        task = asyncio.create_task(coro, name=name)
        self._mutation_tasks.add(task)
        task.add_done_callback(self._mutation_tasks.discard)
        return task

    async def cancel_mutation_tasks(self) -> int:
        """Cancel and await every detached tenant writer registered before reset."""

        cancelled = 0
        while self._mutation_tasks:
            tasks = list(self._mutation_tasks)
            cancelled += len(tasks)
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
        return cancelled

    def restore_environment_runtime_secrets(self) -> dict[str, int]:
        """Drop tenant runtime overlays while preserving deployment/boot values.

        State backend/management connection, auth/JWT, Redis, artifact and updater
        wiring are deliberately outside this allowlist; changing them mid-run would
        move the reset worker and durable receipt to a different authority surface.
        """

        restored: dict[str, int] = {}
        for field, boot_value in self._boot_runtime_secrets.items():
            current = getattr(self.secrets, field)
            if isinstance(current, dict) and isinstance(boot_value, dict):
                restored[field] = max(0, len(current) - len(boot_value))
            else:
                restored[field] = int(current != boot_value)
            setattr(self.secrets, field, copy.deepcopy(boot_value))
        self.gateway.reset_providers()
        return restored

    async def factory_recovery_bootstrap_allowed(self) -> bool:
        """Whether an empty identity store may bootstrap while a reset is degraded."""

        if not self.mutation_gate.degraded:
            return False
        try:
            if not await self.jobs.factory_recovery_fence_matches(
                self.mutation_gate.owner
            ):
                return False
            getter = getattr(self.kv, "get_strict", None) or self.kv.get
            from .constants import USERS_KEY, USERS_NS

            doc = await getter(USERS_NS, USERS_KEY)
            entries = doc.get("entries", []) if isinstance(doc, dict) else []
            return not entries
        except Exception:  # fail closed on identity-store uncertainty
            return False

    async def recover_factory_mutation_gate(self) -> str:
        """Rehydrate the process-local safe-stop from the durable Jobs fence.

        Called after the state backend schema is reachable but before tenant seeding,
        reconciliation, or any producer starts. A real owner is returned for tests
        and startup logging; an unreadable/corrupt registry raises so startup can
        install an opaque, non-recoverable safe-stop rather than fail open.
        """

        owner = await self.jobs.factory_fence_owner()
        if not owner:
            return ""
        await self.mutation_gate.close(owner)
        await self.mutation_gate.mark_degraded(owner)
        return owner

    # ------------------------------------------------------------------ #
    # Public accessors for the REAL (never demo-swapped) collaborators + KV.
    #
    # Round 5 (Coupling-F / G8): the multi-source poller, the reset engine, and the
    # tuning/rules/reset routers reach the REAL store side directly (even under demo
    # mode a poll/reset/rule-write always operates on the real backend — never the
    # throwaway demo store). These name-stable public properties are the ONE seam those
    # collaborators depend on (the :class:`app.engine.poller_manager.PollerHost` /
    # :class:`app.engine.reset.ResetHost` Protocols), so they no longer reach into the
    # ``_real_*``/``_kv`` privates. Behaviour is byte-identical — same objects, just a
    # documented public surface + a decoupling firewall. The demo-aware ``cases``/
    # ``audit``/``pipeline`` accessors above still swap; these deliberately DO NOT.
    # ------------------------------------------------------------------ #
    @property
    def real_cases(self):
        """The REAL case store (never the demo-swapped one)."""
        return self._real_cases

    @property
    def real_audit(self):
        """The REAL append-only audit logger (never the demo-swapped one)."""
        return self._real_audit

    @property
    def real_pipeline(self):
        """The REAL investigation pipeline (never the demo-swapped one)."""
        return self._real_pipeline

    @property
    def real_ingest_service(self):
        """The REAL push/queue ingest service (never the demo-swapped one)."""
        return self._real_ingest_service

    @property
    def real_memory(self):
        return self._real_memory

    @property
    def real_proposals(self):
        return self._real_proposals

    @property
    def real_tuning_store(self):
        return self._real_tuning_store

    @property
    def export_cursor_signing_key(self) -> bytes:
        """Process-private HMAC key for portable-export continuation state."""
        return self._export_cursor_signing_key

    @property
    def real_campaign_store(self):
        return self._real_campaign_store

    @property
    def real_baseline_store(self):
        return self._real_baseline_store

    @property
    def real_batch_job_store(self):
        return self._real_batch_job_store

    @property
    def real_inbox(self):
        return self._real_inbox

    @property
    def jobs(self):
        return self._jobs

    @property
    def job_runner(self):
        return self._job_runner

    @property
    def kv(self):
        """The shared KV doc store backing every KV-over-KVStore store (public alias
        for the historically-private ``_kv``)."""
        return self._kv

    @property
    def oidc_state(self):
        """The single-use OIDC ``state``-token store (Round 5 / Coupling-F) — the
        public seam the SSO routes use to stash/consume the Authorization-Code state
        instead of reaching into ``_kv``. Built lazily over the shared KV; rebound on a
        ``_wire()`` KV rebuild."""
        store = getattr(self, "_oidc_state_store", None)
        kv = getattr(self, "_kv", None)
        if store is None or getattr(store, "_kv", None) is not kv:
            from .auth.oidc import OidcStateStore

            store = OidcStateStore(kv)
            self._oidc_state_store = store
        return store

    @property
    def cases(self):
        return self._demo.cases if self._demo is not None else self._real_cases

    @property
    def audit(self):
        return self._demo.audit if self._demo is not None else self._real_audit

    @property
    def execution_audit(self):
        """Audit trail for active cases/agents (demo-swapped with the workload)."""
        return self.audit

    @property
    def control_audit(self):
        """Durable audit trail for auth, RBAC, secrets, users and real settings."""
        return self._real_audit

    @property
    def usage_store(self):
        return self._demo.usage_store if self._demo is not None else self._real_usage_store

    @property
    def memory(self):
        return self._demo.memory if self._demo is not None else self._real_memory

    @property
    def proposals(self):
        return self._demo.proposals if self._demo is not None else self._real_proposals

    @property
    def case_threads(self):
        return self._demo.case_threads if self._demo is not None else self._real_case_threads

    @property
    def chat_conversations(self):
        """Per-user Workspace history for the active real/demo state boundary."""
        return (
            self._demo.chat_conversations
            if self._demo is not None
            else self._real_chat_conversations
        )

    @property
    def case_activity(self):
        return self._demo.case_activity if self._demo is not None else self._real_case_activity

    @property
    def case_tasks(self):
        return self._demo.case_tasks if self._demo is not None else self._real_case_tasks

    @property
    def inbox(self):
        return self._demo.inbox if self._demo is not None else self._real_inbox

    @property
    def tuning_store(self):
        return self._demo.tuning_store if self._demo is not None else self._real_tuning_store

    @property
    def campaign_store(self):
        return self._demo.campaign_store if self._demo is not None else self._real_campaign_store

    @property
    def baseline_store(self):
        return self._demo.baseline_store if self._demo is not None else self._real_baseline_store

    @property
    def batch_job_store(self):
        """Active batch-job ledger; demo reads never expose durable tenant jobs."""
        return self._demo.batch_job_store if self._demo is not None else self._real_batch_job_store

    @property
    def shift_handoff(self):
        return self._demo.shift_handoff if self._demo is not None else self._real_shift_handoff

    @property
    def pipeline(self):
        return self._demo.pipeline if self._demo is not None else self._real_pipeline

    @property
    def execution_prefs(self) -> Preferences:
        """Prefs for whichever execution stack is currently active.

        Demo services must receive the sandbox copy, not the persisted tenant prefs:
        among other isolation controls it disables every network-backed enrichment
        provider while preserving the real configuration untouched.
        """
        return self._demo._demo_prefs() if self._demo is not None else self.prefs

    async def update_execution_prefs(self, prefs: Preferences) -> Preferences:
        """Persist normally, or keep the change inside the active demo sandbox."""
        if self._demo is not None:
            return await self._demo.update_execution_prefs(prefs)
        return await self.update_prefs(prefs)

    async def mutate_execution_prefs(
        self, mutate: Callable[[Preferences], Preferences]
    ) -> Preferences:
        """Read-modify-write the active execution preferences without stale appends.

        Real tenant writes use the existing strict persistence + application lock.
        Demo writes remain isolated inside the throwaway sandbox.
        """
        if self._demo is not None:
            return await self._demo.mutate_execution_prefs(mutate)
        return await self.mutate_prefs(mutate)

    @property
    def ingest_service(self):
        return self._demo.ingest_service if self._demo is not None else self._real_ingest_service

    @property
    def standup_service(self):
        return self._demo.standup_service if self._demo is not None else self._real_standup_service

    @property
    def overview_service(self):
        return self._demo.overview_service if self._demo is not None else self._real_overview_service

    @property
    def chat_engine(self):
        # In demo, chat MUST use the demo-bound engine ($0 demo gateway + demo
        # audit/cases) so a chat turn spends no real $, writes no permanent real
        # audit rows, and an in-case chat reads the DEMO case store. Off demo, the
        # real engine — byte-for-byte as before.
        return self._demo.chat_engine if self._demo is not None else self._real_chat_engine

    @property
    def rag_service(self):
        # In demo, the RAG service is the demo's SHARED (pipeline+chat) vector store so
        # the Knowledge surface reflects the demo corpus; off demo, the real service.
        return self._demo.rag_service if self._demo is not None else self.rag

    @property
    def noise_counters(self):
        # In demo, the Noise-Reduction funnel reads the DEMO counters so it reflects the
        # demo's ingested→clustered volume (the demo sink records into
        # ``DemoStack.noise_counters``); off demo, the real store — byte-identical.
        # The REAL poller/ingest sink always writes ``_real_noise_counters`` directly (see
        # ``_noise_and_baseline_sink``), so demo traffic never pollutes real counters and a
        # ``disable_demo`` purge of the demo store leaves real counters intact.
        return self._demo.noise_counters if self._demo is not None else self._real_noise_counters

    def _wire(self) -> None:
        es = self.es
        # OWN-state backend (Epoch A): cases/audit/usage/config/cursor live EITHER
        # in Elasticsearch (default) or a SQL database (sqlite/postgres). The
        # agent's read-only LOG surface always stays on the connector layer below.
        self._build_state_backend()
        # Round-3 Wave-2 (F9): construct the wave-1 KV stores BEFORE the gateway so the
        # operator PriceOverlayStore + a pre-flight BudgetGate are LIVE on every LLM
        # call. These stores depend only on self._kv (set in _build_state_backend just
        # above), so building them here is safe and they are NOT rebuilt later — the
        # later _build_wave1_stores() call below is removed in favour of this one.
        self._build_wave1_stores()
        # Round-4 Wave-3: the 4 KV stores (tuning ledger / campaign list /
        # anomaly-baseline sketch / batch-job registry) over the SAME shared KV. Tuning,
        # campaign, and baseline are enabled by current defaults; async Batch remains
        # opt-in. Built here so a live handle survives every _wire() rebuild (same
        # rationale as the Round-3 stores). Store construction itself performs no engine
        # work; Wave-4 schedulers start later and honour the live feature gates.
        self._build_round4_stores()
        # Round-5 (G7): per-user custom-dashboard store over the SAME shared KV — no new
        # index/table/migration. Built here so a live handle survives every _wire()
        # rebuild, exactly like the Round-3/4 stores. Advisory presentation state only
        # (#3-safe); never read by case_manager.decide().
        self._build_round5_stores()
        # Round-7: durable Noise-Reduction counter store over the SAME shared KV — no new
        # index/table/migration. Built here (BEFORE the poller/ingest service below) so its
        # ``record`` is available to wire as their fail-open counter sink, and so a live
        # handle survives every ``_wire()`` rebuild like the Round-3/4/5 stores. Advisory
        # presentation state only (#3-safe); never read by case_manager.decide().
        self._build_round7_stores()
        from .engine.jobs import JobRunner
        from .stores.jobs import JobStore

        self._jobs = JobStore(self._kv)
        if self._job_runner is None:
            self._job_runner = JobRunner(self, self._jobs)
        else:
            self._job_runner.state = self
            self._job_runner.store = self._jobs
        # Drop any memoised batch service so it re-binds to the freshly-built store +
        # gateway on the next access (a credential change rebuilds both).
        self._batch_service = None
        from .engine.budget import BudgetGate

        # Read-only pre-flight ceiling: reads the live BudgetConfig + usage ledger. A
        # block raises GatewayError → fail-to-human (never closes a case, #3). Demo/$0
        # calls bypass it inside the gateway. Fail-open on a ledger glitch.
        self.budget_gate = BudgetGate(
            get_budget=lambda: self.prefs.budget, usage_store=self._real_usage_store
        )
        self.gateway = LLMGateway(
            self.secrets, self._real_usage_store, self._provider_overrides,
            price_overlay=self.price_overlay, budget_gate=self.budget_gate,
            custom_models=self.custom_models,
            discounted_policy=lambda: self.prefs.batch,
        )
        # Auth service (Wave 2). Disabled unless secrets.auth_enabled — the no-auth
        # "old version" is the default. Building it is cheap and re-runs on rewire.
        from .auth.service import AuthService

        self.auth = AuthService(
            enabled=self.secrets.auth_enabled,
            jwt_secret=self.secrets.auth_jwt_secret or "",
            token_hours=self.secrets.auth_token_hours,
            users=self.secrets.auth_user_map(),
            admin_username=self.secrets.auth_admin_username,
            mfa_enforce_roles=list(getattr(getattr(self.prefs, "mfa", None), "enforce_for_roles", []) or []),
        )
        # Multi-USER store (Wave 1) over the SAME KV the MEMORY/PROPOSAL stores use
        # — no new index/table/migration. Seeded + folded into AuthService during
        # async startup() (and after user-mgmt mutations) via refresh_users().
        self.users = self._build_users()
        # Session registry (Wave 3) over the SAME shared KV — no new index/table.
        # Persisted so it survives _wire() rebuilds. The async revocation/expiry
        # check runs in the deps layer (require_auth) against this store; the per-user
        # token_version snapshot is folded into AuthService (set_session_versions).
        self.sessions = self._build_sessions()
        # Markdown playbook registry (loaded from disk; deterministic per-cluster
        # selection). Reloaded in startup() once prefs (and any dir override) load.
        self.playbooks = self._build_playbooks()
        # Runbooks are RAG reference knowledge: immutable bundled Markdown plus a
        # durable operator-authored layer over the shared KV store. No filesystem
        # write, new table, or index is required for Console authoring.
        self.runbooks = self._build_runbooks()
        # Operator MEMORY store (durable trusted facts). Backed by the SAME KV the
        # config/cursor stores use for the active backend (SQL: SqlKVStore; ES: a
        # thin EsKVStore over the config index) — no new index/table/migration.
        self._real_memory = self._build_memory()
        # Agent-DRAFTED proposals awaiting human approval (HITL). Backed by the SAME
        # KV as the MEMORY store — no new index/table/migration.
        self._real_proposals = self._build_proposals()
        # Per-USER personal preferences (Wave 7: pervasive customization — saved
        # views, per-table column state, theme mode). Backed by the SAME KV as the
        # MEMORY store — keyed by user_id, 'default' bucket when auth is off, no new
        # index/table/migration. Merged ORG ← USER by the cascade resolver.
        self.user_prefs = self._build_user_prefs()
        # Round-3 Wave-1 collaboration / notification / RBAC / pricing / shift-handoff
        # stores. Each mirrors the user_prefs/memory/sessions template EXACTLY:
        # backend-agnostic over the SAME shared KV (no new index/table/migration),
        # read-modify-write, never raises (degrades to a safe default). They hold ONLY
        # collaboration/notification/observability/pricing data — NONE feeds the
        # deterministic case_manager.decide() (#3); every free-text field they persist
        # is PLAIN data the UI render-escapes (#9). Built here (after user_prefs) so a
        # live handle survives every _wire() rebuild, just like sessions/user_prefs.
        # NOTE (Round-3 Wave-2): _build_wave1_stores() is now called EARLY (just before
        # the LLM gateway, above) so the PriceOverlayStore + BudgetGate are live on every
        # LLM call. It is NOT re-called here — re-calling would mint a fresh PriceOverlay
        # handle the already-built gateway would not see.
        # Case-number sequence store (F7) over the SAME shared KV — no new index/table.
        self.case_seq = self._build_case_seq()
        self.rag = self._build_rag()
        # The agent's read-only log surface as a connector (source-agnostic). The
        # poller, the es_query tool (via pipeline/chat) read through this. Behaviour
        # is identical to the legacy direct-ES path; swapping the primary source
        # type later re-points the whole graph here.
        self.log_source = self._build_log_source()
        self._real_pipeline = InvestigationPipeline(
            es, self.secrets, self.cache, self.gateway, self.rag, self._real_cases, self._real_audit,
            source=self.log_source, playbooks=self.playbooks, memory=self._real_memory,
            tuning_store=self._real_tuning_store,
            seq_store=self.case_seq,
            # Round 5 (Coupling-F): the realtime EventBus is a module-global singleton
            # already available here, so inject it at construction (an optional ctor
            # kwarg) rather than the post-hoc setter it used to be. ``notifier`` +
            # ``automation`` still setter-inject BELOW because they depend on
            # collaborators built AFTER the pipeline — the _wire() ordering (#6) is
            # preserved; only this already-available collaborator moves to the ctor.
            event_bus=self.event_bus,
            investigation_gate=self.investigation_gate,
            mutation_task_spawner=self.spawn_mutation_task,
        )
        self._real_chat_engine = ChatEngine(
            es, self.gateway, self._real_audit, self._real_cases, self.rag,
            source=self.log_source, memory=self._real_memory, threads=self._real_case_threads,
        )
        self._real_standup_service = StandupService(
            es, self.gateway, self._real_audit,
            cases=self._real_cases, shift_handoff=self._real_shift_handoff,
        )
        self._real_overview_service = OverviewService(self.gateway, self.secrets, self.cache, self._real_audit)
        # Round 4: fan the poller out across EVERY enabled PULL source (not just the
        # primary). The PollerManager owns N per-source Pollers (the primary child
        # wraps ``self.log_source``; non-primary sources get their own #1-safe
        # per-source client + connector). It IS ``self.poller`` and preserves the
        # single Poller's external contract (start/stop/poll_once/_source/_attach).
        from .engine.poller_manager import PollerManager

        self.poller = PollerManager(self)
        # Shared ingest path for PUSH receivers (webhook/syslog/queues/…): the same
        # correlate → case path the poller uses.
        self._real_ingest_service = IngestService(
            self._real_cases, self._real_audit, self._real_pipeline, self.get_prefs
        )
        # Fire-and-forget outbound notifications (F5 / Wave 4). Built AFTER the case
        # stores so the case-creation pipeline + lifecycle routes can fire it post-save.
        # It never blocks or alters the case decision (#3).
        from .notifications.dispatch import NotificationService

        self.notifications = NotificationService(
            get_prefs=self.get_prefs, secrets=self.secrets, cache=self.cache, audit=self._real_audit,
            inbox=self._real_inbox, notif_prefs=self.notif_prefs,
            users=self.users, event_bus=self.event_bus,
        )
        # Let the pipeline reach the dispatcher (post-save, fire-and-forget hook).
        self._real_pipeline.notifier = self.notifications

        # Threshold automation (F10 / Wave 6): post-decision, #3-safe. It runs AFTER
        # apply()+save and may ONLY tag/recommend/notify/queue a re-investigation
        # (which re-runs decide())/open a HITL Proposal — never set status/close.
        from .engine.threshold_automation import ThresholdAutomation

        self.automation = ThresholdAutomation(
            self._real_proposals, self._real_audit,
            notify=self._automation_notify,
            queue_playbook_run=self._automation_queue_playbook,
        )
        self._real_pipeline.automation = self.automation
        # (The realtime EventBus is now injected at pipeline CONSTRUCTION above — Round 5
        # Coupling-F — instead of this post-hoc setter. The bus is the module-global
        # singleton, best-effort + #3/#11-safe, and a no-op when realtime is off.)

        # Round-4 Wave-4: wire the EVENT-feed detection-funnel hook onto the poller so a
        # ``role=events`` feed is routed to the funnel (aggregate→rules→anomaly→batched
        # detection) INSTEAD OF the realtime correlate — but ONLY when batch + baseline
        # are BOTH enabled (checked live inside the poller). Default OFF → the poller
        # never calls the hook and the realtime path is byte-identical. Rebuilt on _wire()
        # (fresh baseline model). Best-effort — a rewire never breaks on this assignment.
        self._funnel_baseline = None
        # Autopilot overhaul (A4): reset the realtime baseline producer too so it re-warms
        # from the (possibly rebuilt) baseline_store on next observe. Cheap — it is lazily
        # rebuilt on first tick. The per-source silence clock (``_source_last_event``)
        # deliberately SURVIVES a rewire.
        self._realtime_baseline = None
        try:
            # Assign the hook DIRECTLY to the PRIMARY child so correctness does not depend
            # on a subsequent rebuild() running first (FINDING #8). The poller-concurrency
            # owner (H2) propagates the SAME ``_event_funnel`` attribute to ALL fan-out
            # children inside rebuild()/_build_child_for — the attribute name/contract is
            # kept stable so both edits compose.
            self.poller._primary._event_funnel = self._route_event_feed
        except Exception as exc:  # noqa: BLE001 — funnel wiring must never break a rewire
            logger.warning("event-funnel hook wiring failed (%s); routing disabled", exc)

        # Round-7: wire the Noise-Reduction counter sink onto BOTH ingest paths as SEPARATE
        # statements ALONGSIDE the EVENT-feed funnel above (P0 name-collision avoidance —
        # this never replaces ``_event_funnel``). ``PollerManager.set_noise_sink`` fans the
        # store's ``record`` out to EVERY child (primary + non-primary) and re-propagates it
        # on ``rebuild()`` (so a source edit keeps it wired — no re-attach needed); the push
        # ``IngestService`` records directly. Fail-open: the poll/ingest path is byte-identical
        # when the sink is unset, and a counter-wiring glitch never breaks a rewire.
        try:
            # Autopilot overhaul (A4): the sink is now a COMPOSITE — the durable
            # Noise-Reduction counters (Round-7) PLUS the realtime baseline producer
            # (per-source ingest volume for silent-source / flood detection). Both are
            # advisory + fail-open; the counter behaviour is byte-identical (the baseline
            # branch is a pure additive observer that never raises into the poll/ingest
            # path). ``noise_counters.record`` still receives the FULL payload unchanged.
            self.poller.set_noise_sink(self._noise_and_baseline_sink)
            self._real_ingest_service._noise_sink = self._noise_and_baseline_sink
        except Exception as exc:  # noqa: BLE001 — counter wiring must never break a rewire
            logger.warning("noise-counter sink wiring failed (%s); counters disabled", exc)

    async def _automation_notify(self, case, trigger: str) -> None:
        """Automation NOTIFY action → dispatch through the existing notification
        service. Fire-and-forget; never raises into the case path."""
        notifier = getattr(self, "notifications", None)
        if notifier is None:
            return
        await notifier.dispatch(case, trigger)

    async def _automation_queue_playbook(self, case, playbook_id: str) -> None:
        """Automation RUN_PLAYBOOK action → QUEUE a re-investigation of the case with
        the playbook forced as TRUSTED context. Detached so it never blocks the
        case path; the re-investigation itself re-runs the deterministic decide()."""
        async def _do() -> None:
            try:
                cluster = await self._automation_cluster_for_case(case)
                if cluster is None:
                    return
                query_source = self.poller.source_for_id(case.source_id)
                await self._real_pipeline.investigate_cluster(
                    cluster, case.source_surface, self.prefs,
                    force=True, force_playbook_id=playbook_id,
                    query_source=query_source,
                )
            except Exception:  # noqa: BLE001 — a queued re-investigation never breaks anything
                logger.debug("automation playbook re-investigation failed for %s", case.case_id)

        self.spawn_mutation_task(
            _do(), name=f"automation-playbook:{case.case_id}"
        )

    async def _automation_cluster_for_case(self, case):
        """Rebuild a cluster for a queued automation re-investigation (read-only).

        Mirrors the routes' ``_cluster_for_case`` but kept dependency-light here to
        avoid a routes import cycle. Returns None when no events remain."""
        from .engine.correlation import cluster_from_events
        from .models import RawEvent

        prefs = self.prefs
        if not case.member_event_ids:
            return None
        query_source = self.poller.source_for_id(case.source_id)
        events = []
        fetch_size = max(len(case.member_event_ids), len(case.member_event_keys or []))
        if query_source is not None:
            try:
                result = await query_source.fetch_by_ids(
                    prefs, case.member_event_ids, size=fetch_size
                )
                events = result.events
            except Exception:  # noqa: BLE001
                return None
        elif (
            case.source_id
            and not prefs.sources
            and case.source_id == getattr(self.log_source, "connector_id", None)
        ):
            try:
                result = await self.log_source.fetch_by_ids(
                    prefs, case.member_event_ids, size=fetch_size
                )
                events = result.events
            except Exception:  # noqa: BLE001
                return None
        elif case.source_id:
            # Push/deleted sources must never fall back to the primary/global log
            # surface. Rebuild a minimal source-local cluster from stored identity.
            for event_id in case.member_event_ids[:200]:
                event = RawEvent(
                    id=event_id,
                    timestamp_millis=case.first_seen_millis,
                    rule=(case.rule_ids[0] if case.rule_ids else None),
                    source={"reconstructed": True},
                    source_id=case.source_id,
                    source_name=case.source_name,
                )
                if case.entity.type.value == "ip":
                    event.ip = case.entity.value
                elif case.entity.type.value == "user":
                    event.user = case.entity.value
                elif case.entity.type.value == "host":
                    event.host = case.entity.value
                events.append(event)
        else:
            # Legacy no-source case: preserve the implicit connector behavior.
            try:
                result = await self.log_source.fetch_by_ids(
                    prefs, case.member_event_ids, size=fetch_size
                )
                events = result.events
            except Exception:  # noqa: BLE001
                return None
        members = [e for e in events if e.entity_value(case.entity.type) == case.entity.value] or events
        if not members:
            return None
        cluster = cluster_from_events(case.entity.type, case.entity.value, members)
        cluster.signature = case.cluster_signature
        cluster.source_id = case.source_id
        cluster.source_name = case.source_name
        cluster.member_event_keys = list(case.member_event_keys or cluster.member_event_keys)
        cluster.trigger_reason = None  # preserve the existing case's trigger reason
        return cluster

    async def cluster_for_case(self, case):
        """Public PollerHost seam for durable deferred-candidate reconstruction."""
        return await self._automation_cluster_for_case(case)

    def _is_sql_backend(self) -> bool:
        return self.secrets.state_backend in ("sqlite", "postgres")

    def is_sql_backend(self) -> bool:
        """Public alias for :meth:`_is_sql_backend` — the ``ResetHost`` seam the reset
        engine uses to pick the SQL-truncate vs ES-delete clear path (Round 5)."""
        return self._is_sql_backend()

    @property
    def sql_engine(self):
        """The SQLAlchemy async engine when on a SQL state backend (else ``None``) —
        the ``ResetHost`` seam for the SQL-truncate reset path (Round 5)."""
        return self._sql_engine

    def _build_state_backend(self) -> None:
        """Wire the suite's OWN-state stores per ``secrets.state_backend``.

        Default (``elasticsearch``): the ES-backed stores over ``self.es``,
        exactly as before. SQL (``sqlite``/``postgres``): build (or reuse) an
        async SQLAlchemy engine from ``state_db_url`` and wire the Sql* repos.
        Either way the resulting attributes (usage_store/audit/cases/cursor_store/
        config_store) satisfy the same repository interfaces, so every downstream
        caller is unchanged. asyncpg/pgvector are imported lazily, only on the
        postgres path, so this method imports/runs on SQLite with no pg deps."""
        if self._is_sql_backend():
            from .stores.sql import (
                SqlAuditRepository,
                SqlCaseRepository,
                SqlConfigStore,
                SqlCursorStore,
                SqlKVStore,
                SqlUsageRepository,
                build_async_engine,
            )
            from .stores.sql.engine import resolve_db_url

            if self._sql_engine is None:
                url = resolve_db_url(self.secrets.state_backend, self.secrets.state_db_url)
                self._sql_engine = build_async_engine(url)
            engine = self._sql_engine
            kv = SqlKVStore(engine)
            self._kv = kv  # shared KV (also backs the operator MEMORY store)
            self._real_usage_store = SqlUsageRepository(engine)
            self._real_audit = SqlAuditRepository(engine)
            self._real_cases = SqlCaseRepository(engine)
            self.cursor_store = SqlCursorStore(kv)
            self.config_store = SqlConfigStore(kv)
            logger.info("OWN-state backend: SQL (%s)", self.secrets.state_backend)
            return
        es = self.es
        from .stores.memory import EsKVStore

        # ES backend has no generic KV table; a thin adapter over the config index
        # gives the MEMORY store the same get/put contract the SQL backend provides.
        self._kv = EsKVStore(es)
        self._real_usage_store = UsageStore(es)
        self._real_audit = AuditLogger(es)
        self._real_cases = CaseStore(es)
        self.cursor_store = CursorStore(es)
        self.config_store = ConfigStore(es)

    def _playbooks_dir(self) -> Path:
        """Where playbook *.md files live: the override from prefs, else the default
        ``backend/playbooks`` (sibling of the ``app`` package)."""
        override = getattr(self.prefs, "playbooks", None)
        if override is not None and override.dir:
            return Path(override.dir)
        return Path(__file__).resolve().parent.parent / "playbooks"

    def _new_playbook_registry(self):
        """Build a registry with ownership metadata for the active directory.

        The Markdown procedures shipped in ``backend/playbooks`` are bundled
        reference content and therefore protected from runtime edits.  A configured
        override directory is operator-owned, so every valid playbook there may be
        edited by a principal holding ``playbooks:manage``.
        """
        from .playbooks.registry import (
            DEFAULT_BUNDLED_PLAYBOOK_FILES,
            PlaybookRegistry,
        )

        directory = self._playbooks_dir()
        bundled_directory = Path(__file__).resolve().parent.parent / "playbooks"
        uses_packaged_default = (
            directory.expanduser().resolve(strict=False)
            == bundled_directory.resolve(strict=False)
        )
        if uses_packaged_default:
            from .playbooks.durable import DurablePlaybookRegistry
            from .stores.playbooks import PlaybookStore

            return DurablePlaybookRegistry(
                bundled_directory,
                PlaybookStore(self._kv),
                protected_filenames=DEFAULT_BUNDLED_PLAYBOOK_FILES,
            )
        # A deliberate directory override retains the legacy file-backed workflow.
        # This is useful for Git-managed site-local catalogs; the default Console
        # authoring path above is state-backend durable and container-safe.
        return PlaybookRegistry(directory, protected_filenames=frozenset())

    def _build_memory(self):
        """Construct the operator MEMORY store over the active backend's KV. The KV
        is set in _build_state_backend, so this always has a valid handle."""
        from .stores.memory import MemoryStore

        return MemoryStore(self._kv)

    def _build_runbooks(self):
        from .engine.runbook_service import RunbookService
        from .stores.runbooks import RunbookStore

        return RunbookService(RunbookStore(self._kv))

    def _build_proposals(self):
        """Construct the agent-PROPOSAL store over the active backend's KV (the same
        KV the MEMORY store uses — works on ES + SQL, no new index/table)."""
        from .stores.proposals import ProposalStore

        return ProposalStore(self._kv)

    def _build_user_prefs(self):
        """Construct the per-USER personal-preferences store (Wave 7) over the active
        backend's KV (the same KV the MEMORY/USER stores use — works on ES + SQL, no
        new index/table). Holds saved views, per-table column state, theme mode."""
        from .stores.user_prefs import UserPrefsStore

        return UserPrefsStore(self._kv)

    def _build_wave1_stores(self) -> None:
        """Construct the 8 Round-3 Wave-1 KV-backed stores over the active backend's KV
        (the SAME shared ``self._kv`` the MEMORY/USER/USER-PREFS stores use — works on
        ES + SQL, no new index/table/migration). Each takes only ``self._kv`` so it
        survives every ``_wire()`` rebuild. Called from ``_wire()`` after user_prefs.

        Keying contract for the route layer:
          * case_threads / case_activity / case_tasks — keyed by ``case.case_id``.
          * inbox / notif_prefs — keyed by user_id (None → the shared 'default'
            bucket via the bundled ``normalize_user_id`` when auth is off).
          * custom_roles / price_overlay — ORG-scoped (single 'default' bucket).
        None of these influences the close/escalate decision (#3); every free-text
        field they persist is PLAIN data the UI render-escapes (#9)."""
        from .stores.case_activity import CaseActivityStore
        from .stores.case_tasks import CaseTaskStore
        from .stores.case_thread import CaseThreadStore
        from .stores.chat_conversations import ChatConversationStore
        from .stores.custom_models import CustomModelStore
        from .stores.custom_roles import CustomRoleStore
        from .stores.inbox import InboxStore
        from .stores.notif_prefs import NotificationPrefsStore
        from .stores.price_overlay import PriceOverlayStore
        from .stores.shift_handoff import ShiftHandoffStore

        kv = self._kv
        # Collaboration (#4 collaboration surface beside the authoritative audit trail).
        self._real_case_threads = CaseThreadStore(kv)
        self._real_chat_conversations = ChatConversationStore(kv)
        self._real_case_activity = CaseActivityStore(kv)
        self._real_case_tasks = CaseTaskStore(kv)
        # In-app notification fan-out + per-user delivery prefs (#8).
        self._real_inbox = InboxStore(kv)
        self.notif_prefs = NotificationPrefsStore(kv)
        # Operator-defined RBAC roles (org-scoped); folded into effective_matrix().
        self.custom_roles = CustomRoleStore(kv)
        # Advisory price overlay for the LLM cost LEDGER (#6) — never alters routing.
        self.price_overlay = PriceOverlayStore(kv)
        # Operator-added self-hosted / LiteLLM (OpenAI-compatible) models registered at
        # RUNTIME from the UI. Built here (BEFORE the gateway, like price_overlay) so the
        # gateway can resolve a bare custom model id's base_url + $0 price on every call.
        # Plain config data only; never feeds decide() (#3).
        self.custom_models = CustomModelStore(kv)
        # Shift-handoff action items + acknowledgements (org-scoped).
        self._real_shift_handoff = ShiftHandoffStore(kv)

    def _build_round4_stores(self) -> None:
        """Construct the 4 Round-4 Wave-3 KV-backed stores over the active backend's KV
        (the SAME shared ``self._kv`` the Round-3 stores use — works on ES + SQL, no new
        index/table/migration). Each takes only ``self._kv`` so it survives every
        ``_wire()`` rebuild, exactly like ``_build_wave1_stores`` above.

        ALL FOUR ARE ADVISORY / PLUMBING and DEFAULT-OFF (their engines only run when the
        matching ``Preferences.{threshold_tuning,campaign,baseline,batch}.enabled`` flag
        is set — the schedulers + feed-routing + API are Wave 4, NOT wired here):
          * tuning_store    — the auto-tuning audit/rollback ledger (never writes a case).
          * campaign_store  — the cross-case campaign list (references case ids only, #4).
          * baseline_store  — the anomaly-baseline sketch state (pure math, #3-safe).
          * batch_job_store — durable async LLM batch-job tracking (exactly-once #6).
        None feeds the deterministic ``case_manager.decide()`` (#3); none recomputes a
        ``cluster_signature`` (#4)."""
        from .stores.baseline import BaselineStore
        from .stores.batch_jobs import BatchJobStore
        from .stores.campaigns import CampaignStore
        from .stores.tuning import TuningStore

        kv = self._kv
        self._real_tuning_store = TuningStore(kv)
        self._real_campaign_store = CampaignStore(kv)
        self._real_baseline_store = BaselineStore(kv)
        self._real_batch_job_store = BatchJobStore(kv)

    def _build_round5_stores(self) -> None:
        """Construct the Round-5 KV-backed stores over the active backend's KV (the SAME
        shared ``self._kv`` the Round-3/4 stores use — works on ES + SQL, no new
        index/table/migration). Each takes only ``self._kv`` so it survives every
        ``_wire()`` rebuild, exactly like ``_build_round4_stores`` above.

        * ``dashboards``   — G7 per-user custom-dashboard layouts (advisory presentation
                             state only).
        * ``rule_versions`` — G6 per-rule immutable version ledger + rollback (a
                             config-adjacent audit ledger; it never writes ``Preferences``
                             itself, never touches a case/verdict/signature, and NEVER
                             imports ``case_manager.decide()`` #3).

        NONE of these feeds the deterministic ``case_manager.decide()`` (#3); every
        dashboard/widget/rule name is PLAIN data the UI render-escapes (#9)."""
        from .stores.dashboards import DashboardStore
        from .stores.rule_versions import RuleVersionStore

        self.dashboards = DashboardStore(self._kv)
        self.rule_versions = RuleVersionStore(self._kv)

    def _build_round7_stores(self) -> None:
        """Construct the Round-7 KV-backed store over the active backend's KV (the SAME
        shared ``self._kv`` the Round-3/4/5 stores use — works on ES + SQL, no new
        index/table/migration). Built here so a live handle survives every ``_wire()``
        rebuild, exactly like ``_build_round5_stores`` above.

        * ``noise_counters`` — durable raw-alert-by-severity ingest counters backing the
          Noise-Reduction funnel ("total alerts by severity → what the AI reduced it to").

        ADVISORY accounting only: it NEVER feeds the deterministic ``case_manager.decide()``
        (#3), recomputes a ``cluster_signature`` (#4), or slows the poll/ingest path (its
        record path is fail-open)."""
        from .stores.noise_counters import NoiseCounterStore

        self._real_noise_counters = NoiseCounterStore(self._kv)

    @property
    def enrichment_registry(self):
        """The process-wide :class:`app.enrichment.registry.ProviderRegistry`
        singleton (lazy; static manifests, per-request instances). Exposed read-only
        for symmetry so routes can reach it via ``state.enrichment_registry`` without
        constructing or holding anything — it needs no secrets at construction."""
        from .enrichment import get_provider_registry

        return get_provider_registry()

    @property
    def event_bus(self):
        """The active in-process SSE transport.

        Real activity uses the process singleton. Demo activity uses its throwaway,
        history-free bus so live steps reach the presentation without leaving demo
        case ids in the real replay buffer.
        """
        if self._demo is not None:
            return self._demo.event_bus
        from .realtime import get_event_bus

        return get_event_bus()

    def active_source_for_id(self, source_id: str | None):
        """Resolve a query source from the active real or demo tenant view."""
        if self._demo is not None:
            return self.demo_source_connector(source_id or "demo-splunk")
        return self.poller.source_for_id(source_id) if source_id else self.log_source

    # ------------------------------------------------------------------ #
    # Round-4 Wave-3 services — LAZY, wired for Wave-4 to drive. Current defaults
    # enable tuning observation, campaign grouping, and baseline production; async
    # Batch remains opt-in.
    #
    # Each is a thin, constructable/lazy accessor over the Wave-3 KV stores +
    # engine modules. NOTHING here starts a scheduler loop, reroutes an EVENT feed,
    # or makes an LLM call at construction — they are inert until a Wave-4 caller
    # (a route or a nightly loop) explicitly invokes them, AND each engine itself
    # no-ops unless its ``Preferences.{threshold_tuning,campaign,baseline,batch}``
    # block is enabled. None imports ``case_manager`` / calls ``decide()`` (#3) or
    # recomputes a ``cluster_signature`` (#4).
    # ------------------------------------------------------------------ #
    @property
    def threshold_tuner(self):
        """The deterministic nightly threshold-tuning observer, exposed as a bound
        ``run_once`` callable Wave-4 schedules. It reads CLOSED cases + the live
        ``Preferences.threshold_tuning`` block (observation defaults ON; automatic
        writes remain OFF), writes only to the ``tuning_store`` ledger + the HITL
        Proposal queue, and persists an auto-applied config change only when explicitly
        enabled through ``update_prefs`` (config-writer only). It NEVER runs merely by
        constructing this accessor; a scheduler or route must invoke
        ``state.threshold_tuner(...)``.

        Signature mirrors ``engine.threshold_tuner.run_once`` with this AppState's
        stores/writer pre-bound: ``await state.threshold_tuner(prefs, cases, **kw)``."""
        from functools import partial

        from .engine.threshold_tuner import run_once as _run_once

        return partial(
            _run_once,
            proposals=self.proposals,
            audit=self.audit,
            tuning_store=self.tuning_store,
            write_prefs=self.update_execution_prefs,
            mutate_prefs=self.mutate_execution_prefs,
        )

    @property
    def campaign_correlator(self):
        """The deterministic cross-case CAMPAIGN pass, exposed as a bound
        ``correlate_campaigns`` callable Wave-4 schedules. It is a read-time aggregator
        over already-persisted cases (default ON via ``Preferences.campaign``; the
        Wave-4 caller still gates on it), upserted into ``campaign_store``. It NEVER
        investigates, mutates a case, calls an LLM (#6), or touches ``decide()`` (#3).

        Call as ``await state.campaign_correlator(cases, prefs)`` (pass ``cases=None``
        + this AppState's case store to page the trailing window)."""
        from functools import partial

        from .engine.campaigns import correlate_campaigns

        return partial(correlate_campaigns, cases_store=self.cases)

    def build_baseline_engine(self):
        """Construct a fresh streaming anomaly-BASELINE model from the live
        ``Preferences.baseline`` config (default ON). Pure math advisory PRODUCER — it
        holds per-(signature, bucket) sketches in memory and is warmed/flushed via the
        ``baseline_store`` snapshot/restore bridge by the Wave-4 caller. NOTHING runs at
        construction; #3/#4/#6-safe. A fresh instance per call (the caller owns warming
        it from ``baseline_store.snapshot()``)."""
        from .engine.baseline import BaselineEngine

        return BaselineEngine(getattr(self.prefs, "baseline", None))

    def build_batch_provider(self, name: str):
        """Construct a batch-inference provider (``anthropic`` | ``openai``) with this
        deployment's API key + any ``base_url`` override, for the Wave-4 batch service to
        submit/poll. Reads ``self.secrets`` live; makes NO network call at construction.
        Raises ``KeyError`` on an unknown provider name."""
        from .llm.batch import make_batch_provider

        key = ""
        base_url = None
        if name == "anthropic":
            key = self.secrets.anthropic_api_key or ""
        elif name == "openai":
            key = self.secrets.openai_api_key or ""
            base_url = getattr(self.secrets, "openai_base_url", None) or None
        return make_batch_provider(name, api_key=key, base_url=base_url)

    @property
    def batch_service(self):
        """The durable BATCH-inference service (submit / poll / process), lazily built
        over the REAL ``batch_job_store`` + the batch-provider factory + the ONE LLM gateway
        ledger (#6 — exactly one UsageDoc per result, deduped by ``custom_id``). Default
        OFF via ``Preferences.batch``; the Wave-4 caller gates + drives it. Nothing runs
        at boot; the service holds no open connections until ``submit``/``poll`` is
        called. Memoised on the AppState (rebuilt on ``_wire()`` since it references the
        rebuilt store/gateway)."""
        svc = getattr(self, "_batch_service", None)
        if svc is None:
            svc = _BatchJobService(
                # Batch submission/polling is an out-of-band production scheduler and
                # remains disabled while Demo Mode is active.  Keep the service pinned
                # to the durable store; demo read routes use the active property above
                # and therefore expose an isolated, empty job list.
                store=self.real_batch_job_store,
                gateway=self.gateway,
                make_provider=self.build_batch_provider,
                get_prefs=self.get_prefs,
                reenter=self._reenter_detections,
                state=self,
            )
            self._batch_service = svc
        return svc

    # ------------------------------------------------------------------ #
    # Round-4 Wave-4 — EVENT-feed detection-funnel driver + gated schedulers.
    # ------------------------------------------------------------------ #
    async def _route_event_feed(self, events: list, prefs: Preferences) -> bool:
        """Route one EVENT feed's batch through the detection funnel (Wave-4).

        The poller calls this ONLY when batch + baseline are both enabled (it gates
        before calling). We run the cheap-first funnel (aggregate→rules→anomaly) over a
        long-lived, warmed baseline model, turn the survivors into an aggregate-only,
        fenced BATCH request set (#7/#9), and SUBMIT it out-of-band to the batch service
        (the batch-jobs scheduler later polls + folds the confirmations back into the
        SAME correlate→pipeline path, #4). Returns ``True`` only after an explicit
        no-candidate outcome or a durable local Batch outbox write. Failures propagate
        to the Poller so the contributing cursor remains untouched and work retries."""
        if not events:
            return True
        import copy

        from .engine import event_detection as evdet

        # Stage baseline observations on a private clone. If provider validation or the
        # durable local outbox write fails, this clone is discarded: replay sees the
        # exact pre-tick baseline and cannot consume a candidate twice into history.
        current_baseline = await self._ensure_funnel_baseline()
        staged_baseline = copy.deepcopy(current_baseline)
        candidates = evdet.funnel(events, prefs, staged_baseline)
        if not candidates:
            self._funnel_baseline = staged_baseline
            await self._flush_funnel_baseline(
                staged_baseline, candidates, events, prefs
            )
            return True
        requests = evdet.build_batch(candidates, prefs)
        if not requests:
            self._funnel_baseline = staged_baseline
            await self._flush_funnel_baseline(
                staged_baseline, candidates, events, prefs
            )
            return True
        provider, model = evdet.target_for_funnel(prefs)
        # Persist survivors + requests to the LOCAL outbox before any provider call.
        serialised = {c.custom_id: evdet.candidate_to_json(c) for c in candidates}
        await self.batch_service.submit(provider, model, requests, candidates=serialised)
        # Publish/flush staged learning only after local outbox acceptance.
        self._funnel_baseline = staged_baseline
        await self._flush_funnel_baseline(
            staged_baseline, candidates, events, prefs
        )
        return True

    async def _reenter_detections(self, job, results) -> int:
        """Re-enter LLM-CONFIRMED event-detections into the SAME pipeline path (#4/#3).

        Called by the batch scheduler AFTER ``process_results`` records the ledger (#6).
        Reconstructs the persisted funnel candidates for THIS job, maps the batch results
        (by ``custom_id``) onto the confirmed ones via
        :func:`event_detection.results_to_candidates` (fail-closed: an unconfirmed /
        unparseable result is NOT re-entered), and feeds each confirmed cluster through the
        EXISTING pipeline entry — ``register_candidate`` (idempotent, visible, $0) then
        ``investigate_cluster`` — so it acquires the SAME ``cluster_signature`` the normal
        correlate path would (#4), attaches to any open case for that signature, and runs
        the UNCHANGED deterministic ``decide()`` inside ``investigate_cluster`` (#3 — this
        method NEVER calls decide() directly). An entirely-suppressed cluster is dropped
        (the same defence-in-depth gate the realtime path uses). Returns the number of
        clusters investigated; operational failures propagate to the durable Batch
        re-entry lease so the scheduler can retry instead of losing the detection.

        Gated by the same default-OFF batch/detection toggle as the funnel; a job with no
        persisted candidates (a plain investigation batch) re-enters nothing."""
        from .constants import SourceSurface
        from .engine import event_detection as evdet
        from .engine.cost_gate import passes_suppression

        prefs = self.prefs
        if not (getattr(getattr(prefs, "batch", None), "enabled", False)
                and getattr(getattr(prefs, "baseline", None), "enabled", False)):
            return 0
        raw_candidates = getattr(job, "candidates", None) or {}
        if not raw_candidates:
            return 0
        try:
            candidates = []
            for raw in raw_candidates.values():
                cand = evdet.candidate_from_json(raw)
                if cand is not None:
                    candidates.append(cand)
            if not candidates:
                return 0
            results_by_id = {}
            for res in results or []:
                cid = str(getattr(res, "custom_id", "") or "")
                if cid:
                    results_by_id[cid] = res
            confirmed = evdet.results_to_candidates(candidates, results_by_id)
            if not confirmed:
                return 0
            count = 0
            for cluster, _src in confirmed:
                # Defence-in-depth: an entirely-suppressed cluster is the intended drop
                # (same gate the realtime handle_clusters walks). NEVER drops a single
                # below-floor event (#4) — that concept doesn't apply to a confirmed
                # aggregate detection.
                if not passes_suppression(cluster, prefs):
                    continue
                # register_candidate makes the case idempotent + visible ($0);
                # investigate_cluster runs the ReAct investigation + the UNCHANGED decide()
                # and dedups on the same signature (one open case per signature, #4).
                await self._real_pipeline.register_candidate(
                    cluster, SourceSurface.AUTOMATED_SCAN, prefs)
                await self._real_pipeline.investigate_cluster(
                    cluster, SourceSurface.AUTOMATED_SCAN, prefs,
                    query_source=self.poller.source_for_id(getattr(_src, "id", None)),
                )
                count += 1
            return count
        except Exception as exc:  # noqa: BLE001 — scheduler persists retry state
            logger.warning("event-detection re-entry failed for job %s: %s", getattr(job, "id", "?"), exc)
            raise

    async def _ensure_funnel_baseline(self):
        """The single long-lived streaming baseline behind the funnel, warmed from the
        persistent baseline_store on first build so the anomaly pass carries history
        across restarts. Built lazily; rebuilt (None) on _wire()."""
        if self._funnel_baseline is None:
            engine = self.build_baseline_engine()
            try:
                series = await self.baseline_store.snapshot()
                for sig, buckets in (series or {}).items():
                    engine.restore(sig, buckets)
            except Exception as exc:  # noqa: BLE001 — a cold baseline is fine
                logger.debug("funnel baseline warm-from-store failed (%s); cold start", exc)
            self._funnel_baseline = engine
        return self._funnel_baseline

    async def _flush_funnel_baseline(
        self, baseline, candidates, events, prefs: Preferences
    ) -> None:
        """Persist the sketches the funnel just touched back to the baseline_store so
        the base improves over time (#4-safe: the store only keys by signature, never a
        cluster_signature recompute). Best-effort; only the signatures observed this
        tick are re-written."""
        try:
            seen: set[str] = {c.signature for c in candidates}
            # Candidates are a subset; persist every aggregate signature so benign /
            # no-candidate ticks also warm the durable baseline.
            from .engine.event_detection import pre_aggregate

            seen.update(summary.signature for summary in pre_aggregate(events, prefs))
            for sig in seen:
                snap = baseline.snapshot(sig)
                if snap:
                    await self.baseline_store.put(sig, snap)
        except Exception as exc:  # noqa: BLE001 — persistence is best-effort
            logger.debug("funnel baseline flush failed (%s)", exc)

    # ------------------------------------------------------------------ #
    # Autopilot overhaul (A4) — the REALTIME baseline PRODUCER + silent-source detector.
    #
    # A pure advisory PRODUCER wired onto the per-tick noise sink: it folds per-source
    # ingest volume (and, when a caller supplies it, per-cluster volume) into a long-lived,
    # persisted baseline so "learn over time" is real from day one. It NEVER triggers an
    # investigation, closes/escalates a case, or touches ``decide()`` (#3) — learning-as-
    # producer is default-ON, learning-as-trigger stays opt-in. Every method is fail-open:
    # a glitch degrades to "no signal this tick", never a dropped/duplicated event.
    # ------------------------------------------------------------------ #
    async def _ensure_realtime_baseline(self):
        """The long-lived REALTIME baseline producer, warmed from the persistent
        ``baseline_store`` on first use (so it resumes a warmed baseline across restarts)
        + LRU-bounded by ``prefs.baseline.max_series``. Built lazily; reset on _wire()."""
        if self._realtime_baseline is None:
            engine = self.build_baseline_engine()
            try:
                series = await self.baseline_store.snapshot()
                for sig, buckets in (series or {}).items():
                    engine.restore(sig, buckets)
            except Exception as exc:  # noqa: BLE001 — a cold baseline is fine
                logger.debug("realtime baseline warm-from-store failed (%s); cold start", exc)
            self._realtime_baseline = engine
        return self._realtime_baseline

    def _baseline_learning_on(self) -> bool:
        """Whether the baseline PRODUCER should observe this tick: baseline learning is
        enabled AND we are not running against isolated demo data."""
        prefs = self.prefs
        if getattr(getattr(prefs, "demo", None), "active", False):
            return False
        return bool(getattr(getattr(prefs, "baseline", None), "enabled", False))

    async def _flush_realtime_baseline(self, engine, signature: str) -> bool:
        """Persist the ONE signature's sketches back to the baseline_store (best-effort),
        then delete any signatures the LRU bound evicted this tick so ``max_series`` bounds
        the durable store too, not just memory. The boolean is operator-health evidence
        only; callers remain fail-open exactly as before."""
        persisted = True
        try:
            snap = engine.snapshot(signature)
            if snap:
                await self.baseline_store.put_strict(signature, snap)
        except Exception as exc:  # noqa: BLE001 — persistence is best-effort
            persisted = False
            logger.debug("realtime baseline flush failed (%s)", exc)
        try:
            for evicted in engine.drain_evictions():
                if evicted != signature:
                    await self.baseline_store.delete_strict(evicted)
        except Exception as exc:  # noqa: BLE001 — eviction cleanup is best-effort
            persisted = False
            logger.debug("realtime baseline eviction cleanup failed (%s)", exc)
        return persisted

    async def observe_source_volume(self, source_id, count, *, when: datetime | None = None):
        """Fold ONE tick's PER-SOURCE ingest volume into the baseline (silent-source /
        flood producer, A4). ALWAYS stamps the source's last-event wall clock when
        ``count > 0`` (so the v0 flat silent check works BEFORE the baseline warm-up),
        then — only when baseline learning is on — folds ``count`` into the namespaced
        ``__source_volume__:<id>`` series and persists it. Returns the advisory
        :class:`BaselineSignal` (or None). Advisory only — NEVER triggers an
        investigation / touches ``decide()`` (#3). Fail-open."""
        sid = str(source_id or "").strip()
        if not sid:
            return None
        now = when or datetime.now(timezone.utc)
        try:
            if int(count) > 0:
                self._source_last_event[sid] = now
                # B3: count this non-empty tick so the silent-source check can tell an
                # established source (raised long-quiet tolerance) from a barely-seen one.
                self._source_event_ticks[sid] = self._source_event_ticks.get(sid, 0) + 1
        except (TypeError, ValueError):
            pass
        if not self._baseline_learning_on():
            return None
        self._scheduler_attempt("baseline_producer")
        try:
            from .engine.baseline import source_volume_signature

            engine = await self._ensure_realtime_baseline()
            sig = source_volume_signature(sid)
            signal = engine.observe(sig, engine.bucket_for_time(now), float(count))
            if await self._flush_realtime_baseline(engine, sig):
                self._scheduler_success("baseline_producer", processed=1)
            else:
                self._scheduler_failure(
                    "baseline_producer", "baseline persistence was not confirmed"
                )
            return signal
        except Exception as exc:  # noqa: BLE001 — the producer must never break a tick
            self._scheduler_failure("baseline_producer", exc)
            logger.debug("source-volume baseline observe failed (%s)", exc)
            return None

    async def observe_cluster_volume(self, signature, count, *, when: datetime | None = None):
        """Fold ONE tick's PER-CLUSTER volume into the baseline for an advisory anomaly
        chip (A4). A hook a caller (the poll/ingest batch) may invoke per correlated
        cluster; no-op unless baseline learning is on. Returns the advisory
        :class:`BaselineSignal` (or None). It can NEVER trigger an investigation by
        itself (#3) — the signal is presentation-only. Fail-open."""
        sig = str(signature or "").strip()
        if not sig or not self._baseline_learning_on():
            return None
        now = when or datetime.now(timezone.utc)
        self._scheduler_attempt("baseline_producer")
        try:
            engine = await self._ensure_realtime_baseline()
            signal = engine.observe(sig, engine.bucket_for_time(now), float(count))
            if await self._flush_realtime_baseline(engine, sig):
                self._scheduler_success("baseline_producer", processed=1)
            else:
                self._scheduler_failure(
                    "baseline_producer", "baseline persistence was not confirmed"
                )
            return signal
        except Exception as exc:  # noqa: BLE001 — the producer must never break a tick
            self._scheduler_failure("baseline_producer", exc)
            logger.debug("cluster-volume baseline observe failed (%s)", exc)
            return None

    #: Multiplier on ``poll_interval_seconds`` for the COLD-START flat check — the
    #: conservative fallback used before a source has a genuine activity history. k=4 ~
    #: four missed polls, an "it stopped" signal, not a single jittered gap.
    _SILENT_SOURCE_K = 4.0
    #: Absolute floor (seconds) on the silence threshold for an ESTABLISHED source. B3
    #: recalibration: the old flat check flagged a source SILENT after only ~k×poll_interval
    #: (~2 min at the default 30s interval), which false-positives constantly on the
    #: legitimately quiet / bursty ALERT feeds this overhaul makes standard. A source with a
    #: real activity history is therefore tolerated quiet for at least this long (30 minutes)
    #: before being called silent — so a true outage still surfaces without spamming normal
    #: quiet gaps. Advisory only — never feeds decide() (#3).
    _SILENT_SOURCE_FLOOR_SECONDS = 30 * 60
    #: Number of prior NON-EMPTY observed ticks that makes a source "established" (and thus
    #: eligible for the raised floor above). Below this a source keeps the conservative
    #: cold-start flat check — a barely-seen / just-started source is judged on the short
    #: window; an established one on the long window (so brief quiet gaps never spam).
    _SILENT_SOURCE_ESTABLISHED_OBS = 2

    def silent_sources(self, prefs: Preferences | None = None, *, now: datetime | None = None,
                       k: float | None = None) -> list[str]:
        """SILENT-SOURCE check: enabled sources whose last observed event is older than the
        silence threshold. Pure + advisory (feeds a UI flag, never ``decide()``, #3) and
        works BEFORE the ~14d baseline warm-up.

        Two-tier threshold (B3 recalibration — stop false-positives on quiet/bursty ALERT
        feeds): an ESTABLISHED source (one that has delivered at least
        ``_SILENT_SOURCE_ESTABLISHED_OBS`` non-empty ticks) is only flagged once quiet past
        ``max(k×poll_interval, _SILENT_SOURCE_FLOOR_SECONDS)`` — a raised, minutes-to-hours
        floor — so a normal quiet gap on a real feed is never spammed as silent. A barely-
        seen / just-started source keeps the conservative cold-start flat check
        (``k×poll_interval``). A source never yet seen is NOT flagged (it is 'awaiting first
        event', not 'went silent')."""
        prefs = prefs or self.prefs
        now = now or datetime.now(timezone.utc)
        kk = float(self._SILENT_SOURCE_K if k is None else k)
        interval = max(1, int(getattr(prefs, "poll_interval_seconds", 30) or 30))
        base = kk * interval
        floor = float(self._SILENT_SOURCE_FLOOR_SECONDS)
        silent: list[str] = []
        for s in getattr(prefs, "sources", []) or []:
            if not getattr(s, "enabled", False):
                continue
            sid = getattr(s, "id", None)
            last = self._source_last_event.get(sid)
            if last is None:
                continue  # never reported yet — awaiting first event, not silent
            # Established sources (a real activity history) get the raised long-quiet
            # tolerance; cold-start sources keep the short flat window. Observation counts
            # come from observe_source_volume; a directly-stamped clock with no count reads
            # as 0 → the conservative cold-start window.
            established = self._source_event_ticks.get(sid, 0) >= self._SILENT_SOURCE_ESTABLISHED_OBS
            threshold = max(base, floor) if established else base
            if last.tzinfo is None:
                last = last.replace(tzinfo=timezone.utc)
            if (now - last).total_seconds() > threshold:
                silent.append(s.id)
        return silent

    async def _noise_and_baseline_sink(self, payload: dict) -> None:
        """Composite per-tick sink (wired in _wire): the durable Noise-Reduction counters
        PLUS the realtime baseline producer. Both are advisory + fail-open; a glitch in
        either NEVER breaks a poll/ingest tick (#3). Counter behaviour is byte-identical —
        ``noise_counters.record`` receives the FULL payload unchanged; the baseline branch
        is a pure additive observer."""
        try:
            # The REAL poller/ingest tick always records to the REAL store (never the
            # demo-swap property) so demo mode never pollutes real counters (#isolation).
            await self._real_noise_counters.record(payload)
        except Exception as exc:  # noqa: BLE001 — counters never break a tick
            logger.debug("noise-counter record failed: %s", exc)
        try:
            await self._observe_tick_volume(payload)
        except Exception as exc:  # noqa: BLE001 — the producer never breaks a tick
            logger.debug("realtime baseline tick observe failed: %s", exc)

    async def _observe_tick_volume(self, payload: dict) -> None:
        """Extract the per-source ingest total from a noise-sink payload and feed it to the
        realtime baseline producer. ``source_id`` is threaded onto the payload by the
        poller/ingest sink call sites (coverage-observability); when it is absent (an older
        call site) there is no per-source key to attribute the volume to, so the per-source
        producer is skipped — direct callers (and the observability batch) can still invoke
        ``observe_source_volume``/``observe_cluster_volume`` explicitly."""
        if not isinstance(payload, dict):
            return
        source_id = payload.get("source_id")
        if not source_id:
            return
        ingested = payload.get("ingested") or {}
        total = 0
        if isinstance(ingested, dict):
            for v in ingested.values():
                try:
                    total += int(v)
                except (TypeError, ValueError):
                    continue
        await self.observe_source_volume(source_id, total)
        cluster_volumes = payload.get("cluster_volumes") or {}
        if isinstance(cluster_volumes, dict):
            for signature, count in cluster_volumes.items():
                try:
                    await self.observe_cluster_volume(signature, int(count))
                except (TypeError, ValueError):
                    continue

    def _funnel_batch_provider(self, prefs: Preferences) -> str:
        """Back-compatible wrapper around the validated router-model Batch target."""
        from .engine.event_detection import target_for_funnel

        provider, _model = target_for_funnel(prefs)
        return provider

    async def _run_schedulers(self) -> None:
        """Start the gated Wave-4 background schedulers (idempotent).

        Three loops modelled on the poller lifecycle: a nightly threshold-tuner pass, a
        daily campaign-correlation pass, and a batch-jobs poller loop. Each is a
        long-running task that, per tick, re-checks its gate flags (feature enabled +
        polling context + not kill_switch + not demo-active) and NO-OPs when its config is
        disabled. Fresh installations enable tuning and campaign correlation through the
        autopilot defaults, while setup state and the global runtime gates still prevent
        premature work; batch remains opt-in. Started once; cancelled in shutdown()."""
        if self._scheduler_running:
            return
        self._scheduler_running = True
        self._scheduler_tasks = [
            asyncio.create_task(self._tuner_scheduler_loop()),
            asyncio.create_task(self._campaign_scheduler_loop()),
            asyncio.create_task(self._batch_scheduler_loop()),
        ]
        logger.info("Background schedulers started; runtime feature gates apply per tick")

    async def reconcile_system_update_audit(self, *, limit: int = 64) -> int:
        """Replay durable terminal updater outcomes into application audit.

        This method is safe to call repeatedly and after process restarts.  The
        updater exposes only its bounded public job projection, while deterministic
        audit event IDs make replays exactly-once at the repository boundary.
        """
        from pydantic import ValidationError

        from .engine.update_audit import audit_terminal_jobs
        from .engine.update_service import UpdateService
        from .engine.update_supervisor import SupervisorRejected, SupervisorUnavailable

        service = UpdateService(self)
        if not service.client.socket_is_available():
            return 0
        try:
            page = await service.terminal_jobs(limit=limit)
        except (SupervisorUnavailable, SupervisorRejected):
            # The updater may be absent, older, or in its self-handoff window. The
            # loop retries; no application audit evidence is invented.
            return 0
        except ValidationError:
            # Protocol drift is not equivalent to absence. Let the supervisor loop
            # log and retry it rather than silently accepting malformed evidence.
            raise
        return await audit_terminal_jobs(self.control_audit, page.jobs)

    async def _system_update_audit_loop(self) -> None:
        """Continuously reconcile completion evidence independent of UI sessions."""
        while self._update_audit_running:
            try:
                await self.reconcile_system_update_audit()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — retry durable evidence next tick
                logger.warning("System-update audit reconciliation failed: %s", exc)
            await asyncio.sleep(15)

    async def _start_system_update_audit_reconciler(self) -> None:
        """Start one immediate-then-periodic terminal audit reconciliation loop."""
        if self._update_audit_running:
            return
        self._update_audit_running = True
        self._update_audit_task = asyncio.create_task(
            self._system_update_audit_loop()
        )

    async def _stop_system_update_audit_reconciler(self) -> None:
        """Cancel the terminal audit reconciler cleanly (idempotent)."""
        self._update_audit_running = False
        task = self._update_audit_task
        self._update_audit_task = None
        if task is None:
            return
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass

    def _schedulers_gated_off(self) -> bool:
        """The shared gate every scheduler tick honours BEFORE doing any real work:
        never run while setup is incomplete / the kill-switch is on / demo mode is
        engaged (so no real scheduler ever fires against demo data or a half-configured
        tenant). ``polling_enabled`` controls only PULL collection: a push/queue-only
        tenant still needs campaign, tuning, and already-submitted batch maintenance.
        Demo keeps ALL real schedulers OFF."""
        prefs = self.prefs
        demo_active = bool(getattr(getattr(prefs, "demo", None), "active", False))
        return (
            not prefs.setup_complete
            or bool(getattr(prefs.caps, "kill_switch", False))
            or demo_active
        )

    # How long a tuning cadence window is (seconds) — the scheduler runs run_once AT MOST
    # once per window regardless of the 6h tick, so a rule is never re-raised every tick
    # (FINDING #14). ``manual`` is instant (an operator triggered it explicitly).
    _TUNER_CADENCE_SECONDS = {
        "hourly": 3600,
        "nightly": 24 * 3600,
        "weekly": 7 * 24 * 3600,
        "manual": 0,
    }
    _CAMPAIGN_CADENCE_SECONDS = {
        "hourly": 3600,
        "daily": 24 * 3600,
        "weekly": 7 * 24 * 3600,
        "manual": 0,
    }

    @staticmethod
    def _scheduler_now() -> str:
        return datetime.now(timezone.utc).isoformat()

    def _scheduler_attempt(self, name: str) -> None:
        self._scheduler_health[name]["last_attempt_at"] = self._scheduler_now()

    def _scheduler_success(self, name: str, *, processed: int = 0) -> None:
        row = self._scheduler_health[name]
        row["last_success_at"] = self._scheduler_now()
        row["last_error"] = ""
        row["processed"] = max(0, int(processed))

    def _scheduler_failure(self, name: str, exc: object) -> None:
        self._scheduler_health[name]["last_error"] = str(exc)[:500]

    @staticmethod
    def _require_tuner_success(outcome: Any) -> None:
        """Raise unless a tuner pass completed with every durable effect confirmed."""
        reason = str(getattr(outcome, "reason", "") or "")
        persistence_errors = list(
            getattr(outcome, "persistence_errors", []) or []
        )
        if (
            reason.startswith("error:")
            or "write failed" in reason
            or persistence_errors
        ):
            raise RuntimeError(reason or persistence_errors[0])
        if not bool(getattr(outcome, "ran", False)):
            raise RuntimeError(reason or "tuning pass did not run")

    async def scheduler_health(self) -> dict[str, Any]:
        """Truthful health snapshot for every continuous-improvement worker."""
        gated = self._schedulers_gated_off()
        configs = {
            "threshold_tuner": getattr(self.prefs, "threshold_tuning", None),
            "campaign_correlation": getattr(self.prefs, "campaign", None),
            "baseline_producer": getattr(self.prefs, "baseline", None),
            "batch_jobs": getattr(self.prefs, "batch", None),
        }
        # Recover durable success anchors on a new process before the first tick.
        if not self._scheduler_health["threshold_tuner"]["last_success_at"]:
            try:
                self._scheduler_health["threshold_tuner"]["last_success_at"] = (
                    await self.tuning_store.get_last_run_at()
                ) or ""
            except Exception:  # noqa: BLE001 — health remains explicit/empty
                pass
        if not self._scheduler_health["campaign_correlation"]["last_success_at"]:
            try:
                self._scheduler_health["campaign_correlation"]["last_success_at"] = (
                    await self.campaign_store.get_last_reconciled_at()
                ) or ""
            except Exception:  # noqa: BLE001
                pass
        workers: dict[str, Any] = {}
        for name, cfg in configs.items():
            if name == "baseline_producer":
                enabled = bool(cfg is not None and getattr(cfg, "enabled", False))
                demo_gated = bool(
                    getattr(getattr(self.prefs, "demo", None), "active", False)
                )
                workers[name] = {
                    "enabled": enabled,
                    "gated": demo_gated,
                    # This producer is event-driven rather than an asyncio cadence:
                    # enabled + non-demo means it is ready on every ingest tick.
                    "running": bool(enabled and not demo_gated),
                    "cadence": "on_ingest",
                    **dict(self._scheduler_health[name]),
                }
                continue
            cadence = str(getattr(cfg, "cadence", "continuous"))
            enabled = bool(cfg is not None and getattr(cfg, "enabled", False))
            workers[name] = {
                "enabled": enabled,
                "gated": gated or cadence == "manual",
                "running": bool(self._scheduler_running and enabled and not gated and cadence != "manual"),
                "cadence": cadence,
                **dict(self._scheduler_health[name]),
            }
        return {"scheduler_runtime_running": self._scheduler_running, "workers": workers}

    async def _tuner_scheduler_loop(self) -> None:
        """Nightly threshold-tuning pass. Gated on ``prefs.threshold_tuning.enabled``;
        a disabled config makes this a pure sleep loop (NO-OP). Calls the bound
        ``threshold_tuner`` run_once (which itself never calls decide() and only writes
        the tuning ledger / HITL proposals / bounded config knobs). Never closes a case.

        The loop ticks every 6h but run_once fires AT MOST once per configured cadence
        window (``last_run_at`` in the tuning_store): a nightly cadence never re-raises the
        same knob four times a day (FINDING #14 — unbounded n growth)."""
        interval = 60
        while self._scheduler_running:
            try:
                cfg = getattr(self.prefs, "threshold_tuning", None)
                if (
                    cfg is not None and cfg.enabled
                    and not self._schedulers_gated_off()
                    and await self._tuner_cadence_elapsed(cfg)
                ):
                    self._scheduler_attempt("threshold_tuner")
                    outcome = await self.threshold_tuner(
                        self.prefs, self._closed_case_reader(),
                    )
                    self._require_tuner_success(outcome)
                    # Stamp the effective run so the next tick within the window no-ops.
                    await self.tuning_store.set_last_run_at_strict()
                    self._scheduler_success(
                        "threshold_tuner",
                        processed=len(getattr(outcome, "rule_stats", {}) or {}),
                    )
            except Exception as exc:  # noqa: BLE001 — the loop must never die
                self._scheduler_failure("threshold_tuner", exc)
                logger.warning("threshold-tuner scheduler tick failed: %s", exc)
            await asyncio.sleep(interval)

    async def _tuner_cadence_elapsed(self, cfg) -> bool:
        """True when the configured tuning cadence window has elapsed since the last
        effective run (so run_once fires at most once per cadence, FINDING #14). A missing
        / unparseable last_run is treated as "run now"; a read glitch fails OPEN (run) so a
        store outage never silently freezes tuning forever."""
        window = self._TUNER_CADENCE_SECONDS.get(getattr(cfg, "cadence", "nightly"), 24 * 3600)
        # "manual" is operator-only; the background loop must never treat it as
        # "run continuously".
        if window <= 0:
            return False
        try:
            last_iso = await self.tuning_store.get_last_run_at()
        except Exception:  # noqa: BLE001 — fail OPEN (run) on a read glitch
            return True
        if not last_iso:
            return True
        from datetime import datetime, timezone

        try:
            last = datetime.fromisoformat(str(last_iso).replace("Z", "+00:00"))
            if last.tzinfo is None:
                last = last.replace(tzinfo=timezone.utc)
        except (ValueError, TypeError):
            return True
        elapsed = (datetime.now(timezone.utc) - last).total_seconds()
        return elapsed >= window

    async def _campaign_scheduler_loop(self) -> None:
        """Daily cross-case campaign-correlation pass. Gated on ``prefs.campaign.enabled``;
        disabled → a pure sleep loop (NO-OP). Runs the DETERMINISTIC read-time aggregator
        and upserts the campaign list; it NEVER investigates, mutates a case, or calls
        decide()/an LLM."""
        interval = 60
        while self._scheduler_running:
            try:
                cfg = getattr(self.prefs, "campaign", None)
                if (
                    cfg is not None
                    and cfg.enabled
                    and not self._schedulers_gated_off()
                    and await self._campaign_cadence_elapsed(cfg)
                ):
                    self._scheduler_attempt("campaign_correlation")
                    campaigns = await self.campaign_correlator(None, self.prefs)
                    stored = await self.campaign_store.replace_all(list(campaigns or []))
                    self._scheduler_success("campaign_correlation", processed=len(stored))
            except Exception as exc:  # noqa: BLE001 — the loop must never die
                self._scheduler_failure("campaign_correlation", exc)
                logger.warning("campaign scheduler tick failed: %s", exc)
            await asyncio.sleep(interval)

    async def _campaign_cadence_elapsed(self, cfg) -> bool:
        window = self._CAMPAIGN_CADENCE_SECONDS.get(
            getattr(cfg, "cadence", "daily"), 24 * 3600
        )
        if window <= 0:
            return False
        try:
            last_iso = await self.campaign_store.get_last_reconciled_at()
        except Exception:  # noqa: BLE001 — fail open so an outage cannot freeze work
            return True
        if not last_iso:
            return True
        try:
            last = datetime.fromisoformat(str(last_iso).replace("Z", "+00:00"))
            if last.tzinfo is None:
                last = last.replace(tzinfo=timezone.utc)
        except (ValueError, TypeError):
            return True
        return (datetime.now(timezone.utc) - last).total_seconds() >= window

    async def _batch_scheduler_loop(self) -> None:
        """Batch-jobs poller loop. Gated on ``prefs.batch.enabled``; disabled → a pure
        sleep loop (NO-OP). Polls every OPEN durable BatchJob, processes any completed
        results through the ONE gateway ledger (exactly-once #6), and re-enters each
        LLM-CONFIRMED detection as a candidate cluster on the SAME correlate→pipeline
        path (which runs the unchanged decide()); it never closes a case here."""
        interval = 120
        while self._scheduler_running:
            try:
                svc = self.batch_service
                if svc.enabled() and not self._schedulers_gated_off():
                    # Batch Inbox is a durable projection outbox. Reconcile terminal
                    # as well as open provider rows so an Inbox outage at completion
                    # repairs itself without needing another submission.
                    await svc.reconcile_inbox()
                    open_jobs = await svc.store.load_open_jobs()
                    if open_jobs:
                        self._scheduler_attempt("batch_jobs")
                    processed = 0
                    failures: list[str] = []
                    for job in open_jobs:
                        try:
                            polled = await svc.poll(job)
                            await svc.process(polled)
                            processed += 1
                        except Exception as exc:  # noqa: BLE001 — isolate one job
                            failures.append(f"{job.id}: {exc}")
                            logger.debug("batch job %s poll/process failed: %s", job.id, exc)
                    if open_jobs:
                        if failures:
                            raise RuntimeError(
                                f"{len(failures)} of {len(open_jobs)} jobs failed; {failures[0]}"
                            )
                        self._scheduler_success("batch_jobs", processed=processed)
            except Exception as exc:  # noqa: BLE001 — the loop must never die
                self._scheduler_failure("batch_jobs", exc)
                logger.warning("batch-jobs scheduler tick failed: %s", exc)
            await asyncio.sleep(interval)

    def _closed_case_reader(self):
        """An async ``read(limit, offset) -> list[Case]`` pager over the TERMINAL cases
        (CLOSED **and** RESOLVED) for the threshold-tuner (which pages it, never a naive
        200-cap). Confirmed true-positives are frequently RESOLVED (worked to completion,
        pending final close) rather than CLOSED, so a CLOSED-only reader would leave
        shadow-eval blind to them and defeat the TP-protection rail (FINDING #4). We mirror
        ``routes_tuning._closed_reader``'s scope exactly. A store glitch on either status
        aborts the pass so the scheduler reports failure and retries with complete evidence."""
        from .engine.threshold_tuner import terminal_case_reader

        return terminal_case_reader(self.cases)

    async def _stop_schedulers(self) -> None:
        """Cancel the Wave-4 schedulers cleanly (shutdown). Idempotent."""
        self._scheduler_running = False
        tasks = self._scheduler_tasks
        self._scheduler_tasks = []
        for task in tasks:
            task.cancel()
        for task in tasks:
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass

    def _build_users(self):
        """Construct the multi-USER store over the active backend's KV (the same KV
        the MEMORY/PROPOSAL stores use — works on ES + SQL, no new index/table)."""
        from .stores.users import UserStore

        return UserStore(self._kv)

    def _build_sessions(self):
        """Construct the session registry store (Wave 3) over the active backend's KV
        (the same KV the MEMORY/USER stores use — works on ES + SQL, no new
        index/table). Persisted so it survives _wire() rebuilds."""
        from .stores.sessions import SessionStore

        return SessionStore(self._kv)

    def _build_case_seq(self):
        """Construct the case-number SequenceStore (F7) over the active backend's KV
        (the same KV the MEMORY store uses — its own namespace, no new index/table)."""
        from .engine.case_id import SequenceStore

        return SequenceStore(self._kv)

    async def seed_users(self) -> None:
        """First-run seeding of the demo super_admin (``Admin``/``Admin@123``), and
        of the env single-admin as a real user, when auth is ENABLED and the user
        store is EMPTY. Race-safe (create-if-absent only when empty) and a strict
        no-op when auth is disabled. Records a transient ``_seeded_default_admin``
        signal for /api/setup/status. Best-effort: a store failure never blocks
        startup."""
        self._seeded_default_admin = False
        if not self.secrets.auth_enabled:
            return
        try:
            if await self.users.count() > 0:
                return
            from .auth.passwords import hash_password
            from .constants import UserRole

            # When an env single-admin is configured (auth_admin_password set), that
            # IS the bootstrap admin — don't also seed the demo Admin (it would
            # collide on the lowercased username and shadow the env creds). The demo
            # seed is for the zero-config deployment that has no env admin.
            env_admin = bool(self.secrets.auth_admin_password)
            if self.secrets.auth_seed_admin and not env_admin:
                created = await self.users.create_if_absent(
                    username=self.secrets.auth_seed_admin_username,
                    password_hash=hash_password(self.secrets.auth_seed_admin_password),
                    role=UserRole.SUPER_ADMIN.value,
                    active=True,
                    must_change_password=False,
                )
                if created is not None:
                    self._seeded_default_admin = True
                    logger.info(
                        "Seeded demo super_admin '%s' (change the password!)",
                        created.username,
                    )
        except Exception as exc:  # noqa: BLE001 — seeding is best-effort
            logger.warning("User seeding failed (%s); continuing", exc)

    async def refresh_users(self) -> None:
        """Sync :attr:`auth` with the CURRENT multi-user store records (role / active
        / must_change_password / password hash) via ``AuthService.set_users`` —
        WITHOUT rebuilding the service (so the JWT signing secret is stable across
        refreshes and live sessions survive a user-mgmt mutation). Called after
        startup seeding and after any user-mgmt mutation so a new/disabled/role-
        changed user takes effect on the next request without a restart."""
        try:
            users = await self.users.list()
        except Exception as exc:  # noqa: BLE001
            logger.warning("Refreshing users into AuthService failed (%s)", exc)
            return
        # A transient store-read glitch degrades to an EMPTY list inside UserStore._load
        # (it swallows read errors), and an empty view collapses the synced auth snapshot
        # to the env base layer alone — on an OOBE-only deployment (no env-seeded admin)
        # that evicts EVERY persisted account and locks all logins out until a restart. An
        # empty list is therefore AMBIGUOUS: treat it as a failed read (keep the current
        # view, like the exception branch above) UNLESS the store is AUTHORITATIVELY empty.
        # ``has_any()`` is the raising probe — a read glitch propagates (→ keep view) and a
        # genuinely non-empty store is detected (→ keep view); only a clean "zero users"
        # answer authorises the empty base-only view.
        allow_empty = False
        if not users:
            try:
                store_has_users = await self.users.has_any()
            except Exception as exc:  # noqa: BLE001 — an unconfirmable empty is a failed read
                logger.warning(
                    "refresh_users: users.list() was empty and the has_any() authoritative "
                    "probe failed (%s); keeping the current auth view (a transient empty "
                    "read must never evict accounts)", exc,
                )
                return
            if store_has_users:
                logger.warning(
                    "refresh_users: users.list() returned empty but the store reports "
                    "accounts present — treating as a transient read and keeping the "
                    "current auth view"
                )
                return
            allow_empty = True  # the store is authoritatively empty → base-only view is valid
        try:
            self.auth.set_users(users, allow_empty=allow_empty)
            # Keep the MFA-enforce role set in sync with current prefs (Wave 2 / F3).
            self.auth.set_mfa_enforce_roles(
                list(getattr(getattr(self.prefs, "mfa", None), "enforce_for_roles", []) or [])
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("AuthService.set_users failed (%s)", exc)
        # Keep the per-user session token_version snapshot in AuthService current so
        # the next mint stamps the right ``tv`` (Wave 3). Best-effort.
        await self.refresh_sessions(users)

    async def refresh_sessions(self, users: list | None = None) -> None:
        """Fold the CURRENT per-user session ``token_version`` snapshot (from the
        persistent SessionStore) into AuthService so synchronous token minting stamps
        the right ``tv`` claim. Called on startup, after a user-mgmt mutation, and
        after a revoke-all (which bumps a tv). Best-effort + never raises."""
        sessions = getattr(self, "sessions", None)
        if sessions is None:
            return
        try:
            if users is None:
                users = await self.users.list()
        except Exception:  # noqa: BLE001
            users = []
        versions: dict[str, int] = {}
        try:
            for u in users or []:
                uname = str(getattr(u, "username", "") or "")
                if uname:
                    versions[uname] = await sessions.token_version_for(uname)
            # Include the AuthService BASE/env-admin username(s). They are NOT stored
            # Users, so iterating users.list() alone leaves their snapshot tv at 0 —
            # after a revoke-all bumps the persistent tv to >=1, a fresh env-admin
            # login would stamp tv=0 < current_tv → permanent reauth_required lockout.
            # Default each from the SessionStore's per-user tv (like a stored user);
            # skip any already resolved above (a stored user with the same name wins).
            seen = {k.strip().lower() for k in versions}
            auth = getattr(self, "auth", None)
            base_names = list(auth.base_usernames()) if auth is not None else []
            for uname in base_names:
                if uname and uname.strip().lower() not in seen:
                    versions[uname] = await sessions.token_version_for(uname)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Refreshing session token_versions failed (%s)", exc)
            return
        try:
            self.auth.set_session_versions(versions)
        except Exception as exc:  # noqa: BLE001
            logger.warning("AuthService.set_session_versions failed (%s)", exc)

    def _build_playbooks(self):
        """Construct + load the PlaybookRegistry (never raises; a bad file is
        skipped, an empty/missing dir yields zero playbooks → generic behaviour)."""
        reg = self._new_playbook_registry()
        try:
            summary = reg.reload()
            logger.info(
                "Loaded %d playbook(s); skipped %d",
                summary.get("loaded", 0), len(summary.get("skipped", [])),
            )
        except Exception as exc:  # noqa: BLE001 — registry should never raise; be safe
            logger.warning("Playbook load failed (%s); continuing with none", exc)
        return reg

    def reload_playbooks(self) -> dict:
        """Hot-reload playbooks from disk via the registry's ATOMIC validate-then-swap
        (a wholesale-broken dir keeps the prior good live set). Re-points at the
        configured dir first if it changed. Returns {loaded, skipped, ids}."""
        if str(self.playbooks._directory) != str(self._playbooks_dir()):
            self.playbooks = self._new_playbook_registry()
        summary = self.playbooks.reload()
        self._real_pipeline._playbooks = self.playbooks
        return summary

    async def refresh_playbooks(self) -> dict:
        """Refresh the active catalog from its authoritative storage layer."""
        if str(self.playbooks._directory) != str(self._playbooks_dir()):
            self.playbooks = self._new_playbook_registry()
        refresher = getattr(self.playbooks, "refresh", None)
        summary = await refresher() if callable(refresher) else self.playbooks.reload()
        self._real_pipeline._playbooks = self.playbooks
        return summary

    async def create_playbook(self, playbook_id: str, content: str, *, actor: str):
        """Create against durable state by default, or an explicit file override."""
        await self.refresh_playbooks()
        creator = getattr(self.playbooks, "create_durable", None)
        if callable(creator):
            return await creator(playbook_id, content, actor=actor)
        return self.playbooks.create_operator(playbook_id, content)

    async def update_playbook(
        self,
        playbook_id: str,
        content: str,
        *,
        actor: str,
        expected_revision: int | None = None,
    ):
        """Update with optimistic concurrency on the durable catalog."""
        await self.refresh_playbooks()
        updater = getattr(self.playbooks, "update_durable", None)
        if callable(updater):
            if expected_revision is None:
                current = self.playbooks.get(playbook_id)
                if current is None:
                    from .playbooks.registry import PlaybookNotFoundError

                    raise PlaybookNotFoundError(playbook_id)
                expected_revision = int(self.playbooks.metadata(current).get("revision", 1))
            return await updater(
                playbook_id,
                content,
                actor=actor,
                expected_revision=expected_revision,
            )
        return self.playbooks.update_operator(playbook_id, content)

    def es_client_for_source(self, src) -> tuple[BaseESClient, bool]:
        """Return (es_client, owned) honoring the source's per-source ES connection +
        TLS settings. `owned=True` means a fresh client the CALLER must close; `False`
        means the shared global `self.es`. Falls back to the shared client when the
        source has no connection overrides or a real client can't be built."""
        merged = {**(src.config or {}), **self.secrets.source_secrets(src.id)}
        overrides = _source_es_overrides(merged)
        if not overrides:
            return self.es, False
        overrides["es_mgmt_api_key"] = None  # never point a global mgmt key at a source URL
        try:
            from .es.client import RealESClient
            return RealESClient(self.secrets.model_copy(update=overrides)), True
        except Exception as exc:  # noqa: BLE001
            logger.warning("per-source ES client build failed (%s); using shared client", exc)
            return self.es, False

    def _set_owned_log_client(self, client) -> None:
        prev = getattr(self, "_owned_log_client", None)
        if prev is not None and prev is not client:
            self._schedule_close(prev)
        self._owned_log_client = client if client is not self.es else None

    def _schedule_close(self, client) -> None:
        try:
            import asyncio
            asyncio.get_running_loop().create_task(client.close())
        except RuntimeError:
            pass  # no running loop (sync init) — closed at shutdown

    def schedule_close(self, client) -> None:
        """Public alias for :meth:`_schedule_close` — the ``PollerHost`` seam the
        multi-source poller uses to close a per-source ES client it owns (Round 5)."""
        self._schedule_close(client)

    def _build_log_source(self):
        """Construct the primary pull connector for the agent's log surface.

        Honors the primary source's OWN ES connection + TLS settings (es_url/
        es_api_key/es_verify_certs/es_ca_cert) by building a per-source client when
        those overrides are present; otherwise wraps the shared scoped read-only ES
        client. Both Elasticsearch and OpenSearch read identically; the choice only
        affects provenance/query language. Defaults to Elasticsearch when no source
        is configured yet."""
        from .connectors.elastic import ElasticConnector
        from .connectors.opensearch import OpenSearchConnector
        from .connectors.wazuh import WazuhConnector
        from .constants import SourceType

        primary = self.prefs.primary_source()
        if primary is None:
            self._set_owned_log_client(None)
            if self.prefs.sources:
                from .connectors.unavailable import UnavailablePullConnector

                return UnavailablePullConnector(connector_id="no-pull-source")
            return ElasticConnector(self.es)
        es_client, owned = self.es_client_for_source(primary)
        self._set_owned_log_client(es_client if owned else None)
        # Pass the source's display_name through config so tagged events carry a
        # human-readable source_name (UI filter-by-source). Non-secret, additive.
        cfg = {**(primary.config or {})}
        if primary.display_name:
            cfg.setdefault("display_name", primary.display_name)
        cid = primary.id
        if primary.source_type == SourceType.OPENSEARCH:
            return OpenSearchConnector(es_client, config=cfg, connector_id=cid)
        if primary.source_type == SourceType.WAZUH:
            return WazuhConnector(es_client, config=cfg, connector_id=cid)
        return ElasticConnector(es_client, config=cfg, connector_id=cid)

    def _build_rag(self) -> RagService:
        """Construct the RAG service, wiring the CaseStore (resolved-case memory)
        and selecting a persistent vector store. On the SQL state backend the
        SqlVectorStore is used (pgvector on Postgres, JSON+Python cosine on
        SQLite); on the ES backend a persistent ES vector store is used ONLY when a
        real management ES client is present. Otherwise the in-memory store."""
        store = None
        if self._is_sql_backend() and self._sql_engine is not None:
            try:
                from .stores.sql import SqlVectorStore

                store = SqlVectorStore(self._sql_engine)
                logger.info("RAG using persistent SQL vector store (%s)", self.secrets.state_backend)
            except Exception as exc:  # noqa: BLE001
                logger.warning("Could not select SQL vector store (%s); using in-memory", exc)
            return RagService(
                self.gateway,
                self.prefs,
                store=store,
                cases=self._real_cases,
                runbooks=self.runbooks,
            )
        try:
            from .es.client import RealESClient
            from .tools.vectorstore import ESVectorStore

            if isinstance(self.es, RealESClient) and getattr(self.es, "_mgmt", None) is not None:
                store = ESVectorStore(self.es)
                logger.info("RAG using persistent ES vector store (tlsoc-agent-rag)")
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not select ES vector store (%s); using in-memory", exc)
        return RagService(
            self.gateway,
            self.prefs,
            store=store,
            cases=self._real_cases,
            runbooks=self.runbooks,
        )

    def rebuild_log_source(self) -> None:
        """Re-point the agent's log surface after the configured sources change.

        Rebuilds the primary connector from ``self.prefs`` and updates the live
        components that hold it (poller, pipeline, chat), so a wizard-driven source
        change takes effect without a restart. (Elastic/OpenSearch wrap the same
        scoped ES client, so this is behaviour-identical for those two.)

        Round 4: also rebuild the PollerManager's per-source fan-out so an added /
        removed / re-primaried source is polled (or stops being polled) immediately —
        ``rebuild()`` re-points the primary child at the fresh ``log_source`` and
        rebuilds every non-primary child (closing any owned clients, no leak)."""
        self.log_source = self._build_log_source()
        self.poller._source = self.log_source
        self._real_pipeline._source = self.log_source
        self._real_chat_engine._source = self.log_source
        try:
            self.poller.rebuild()
        except Exception as exc:  # noqa: BLE001 — fan-out rebuild must never break a source edit
            logger.warning("Poller fan-out rebuild failed (%s); continuing", exc)
        # Round-4 Wave-4: rebuild() minted a FRESH primary Poller (via _build_primary),
        # which does not carry the EVENT-feed funnel hook — re-attach it so a source edit
        # keeps EVENT-feed routing wired. Best-effort; a missing hook only means routing
        # stays off (byte-identical realtime path).
        try:
            self.poller._primary._event_funnel = self._route_event_feed
        except Exception as exc:  # noqa: BLE001
            logger.debug("re-attaching event-funnel hook after rebuild failed (%s)", exc)

    def get_prefs(self) -> Preferences:
        return self.prefs

    @classmethod
    def create(
        cls,
        secrets: Secrets | None = None,
        es: BaseESClient | None = None,
        provider_overrides: dict[str, BaseProvider] | None = None,
    ) -> "AppState":
        secrets = secrets or Secrets()
        if es is None:
            es = _build_es_client(secrets)
        return cls(secrets, es, provider_overrides)

    async def startup(self, *, start_poller: bool = True) -> None:
        await self.cache.connect()
        await self._bootstrap_state_backend()
        # Cache keys are namespaced by the latest sanitized factory receipt. An
        # unavailable Jobs registry chooses a unique fail-safe namespace rather than
        # risking reuse of prior-tenant Redis evidence.
        try:
            self.cache.set_tenant_epoch(await self.jobs.factory_cache_epoch())
        except Exception as exc:  # noqa: BLE001
            logger.warning("Factory cache epoch unavailable (%s); isolating this boot", exc)
            self.cache.set_tenant_epoch(f"unavailable-{stdlib_secrets.token_hex(16)}")
        # Rebuild the process-local HTTP boundary from the durable fence before any
        # producer or request can mutate tenant state. A malformed/unreadable registry
        # fails closed with an opaque recovery owner; explicit repair is then required.
        factory_recovery = False
        try:
            fence_owner = await self.recover_factory_mutation_gate()
        except Exception as exc:  # noqa: BLE001
            logger.error("Jobs factory-fence status unavailable; entering safe-stop: %s", exc)
            fence_owner = f"unavailable-{stdlib_secrets.token_hex(16)}"
            await self.mutation_gate.close(fence_owner)
            await self.mutation_gate.mark_degraded(fence_owner)
            factory_recovery = True
        if fence_owner:
            factory_recovery = True
        self.prefs = await self.config_store.load()
        if factory_recovery:
            # Recovery boots are deliberately minimal. Do not seed users/rules,
            # reconcile RAG/playbooks/tuning, restore demo state, or start any Job,
            # poller, receiver, or scheduler writer. Read-only identity hydration is
            # enough for env-admin login or the guarded empty-store setup bootstrap;
            # a freshly submitted factory retry starts the JobRunner explicitly.
            await self.refresh_users()
            logger.warning(
                "AppState started in factory-reset recovery safe-stop (owner=%s)",
                fence_owner,
            )
            return
        # First-run seeding of the built-in rule catalog (C3-1): idempotent and
        # guarded by rule_catalog_seed_version so operator edits are never clobbered.
        self.prefs = await self.config_store.seed_rule_catalog(self.prefs)
        # Seed the demo/first admin (when auth is on + the store is empty) and fold
        # the user store into the AuthService so login + RBAC use real accounts.
        await self.seed_users()
        await self.refresh_users()
        self.rag = self._build_rag()
        self._real_pipeline._rag = self.rag
        self._real_chat_engine._rag = self.rag
        # Reload playbooks now that prefs (incl. any dir override) are available.
        self.playbooks = self._build_playbooks()
        self._real_pipeline._playbooks = self.playbooks
        try:
            await self.refresh_playbooks()
        except Exception as exc:  # noqa: BLE001 — packaged procedures still remain live
            logger.warning("Durable playbook refresh failed (%s); using packaged set", exc)
        # Round 4: now that the PERSISTED prefs (incl. configured sources) are loaded,
        # re-point the primary log surface + (re)build the PollerManager fan-out so a
        # deployment that boots WITH multiple persisted PULL sources polls ALL of them,
        # not just the primary. Byte-identical for the 0/1-source case (the fallback
        # connector is rebuilt identically). Best-effort — never blocks startup.
        try:
            self.rebuild_log_source()
        except Exception as exc:  # noqa: BLE001 — never block startup on a source rebuild
            logger.warning("Log-source / poller rebuild on startup failed (%s); continuing", exc)
        # Round-3 Wave-1: apply the operator's realtime heartbeat cadence onto the
        # process-wide EventBus singleton (idempotent, tolerates None). The bus is a
        # default-OFF transport — publishing is always safe; the /api/events endpoint
        # gates serving on Preferences.realtime.enabled. Never blocks startup.
        try:
            from .realtime import configure_event_bus

            configure_event_bus(getattr(self.prefs, "realtime", None))
        except Exception as exc:  # noqa: BLE001 — realtime config is best-effort
            logger.warning("Realtime bus configuration failed (%s); continuing", exc)
        # Upgrade reconciliation: active tuning rows created before independent
        # outcome provenance must be visible in Approvals immediately, not only after
        # the next cadence-eligible nightly pass. This drafts deduplicated review work
        # only; it never changes or rolls back the historical threshold.
        try:
            from .engine.threshold_tuner import queue_legacy_tuning_reviews

            reconciliation = await queue_legacy_tuning_reviews(
                self.tuning_store,
                self.proposals,
                self.audit,
            )
            if reconciliation.persistence_errors:
                self._scheduler_failure(
                    "threshold_tuner",
                    reconciliation.reason,
                )
        except Exception as exc:  # noqa: BLE001 — startup remains available
            self._scheduler_failure("threshold_tuner", exc)
            logger.warning(
                "Legacy tuning review reconciliation failed (%s); scheduler will retry",
                exc,
            )
        # Demo Mode (Wave 5): if a demo run was persisted as active, rebuild the
        # throwaway stack + re-seed so the read endpoints have a demo store to serve
        # (demo data is in-memory; the FLAG persists across restarts — re-seeding
        # restores a believable demo deterministically from the same seed).
        demo = getattr(self.prefs, "demo", None)
        if demo is not None and demo.active:
            try:
                await self.enable_demo(
                    mode=demo.mode, seed=demo.seed, history_days=demo.history_days,
                    tick_seconds=demo.tick_seconds, tick_jitter=demo.tick_jitter,
                    incident_rate=demo.incident_rate,
                )
            except Exception as exc:  # noqa: BLE001 — never block startup on demo re-seed
                logger.warning("Demo re-seed on startup failed (%s); continuing", exc)
        # Durable operator jobs are independent of polling/scheduler enablement and
        # must recover queued/expired work even in push-only or test-controlled runs.
        await self.job_runner.start()
        if start_poller and not factory_recovery:
            self.poller.start()
            self._receivers_enabled = True
            await self._start_receivers()
            # Round-4 Wave-4: start the gated background schedulers alongside the poller.
            # Each loop independently honours its feature gate; setup, demo, and the kill
            # switch gate all work, while PULL polling may be disabled for a push-only
            # tenant. Started under the SAME ``start_poller`` process-runtime guard the
            # offline tests already use to skip background tasks, so the test suite never
            # spawns them unless asked.
            await self._run_schedulers()
            await self._start_system_update_audit_reconciler()
        logger.info(
            "AppState started (es=%s, setup_complete=%s, polling_enabled=%s)",
            type(self.es).__name__, self.prefs.setup_complete, self.prefs.polling_enabled,
        )

    async def _bootstrap_state_backend(self) -> None:
        """Create the OWN-state schema for the active backend.

        SQL backend → create the SQL tables (idempotent) and SKIP ES index
        bootstrap entirely (a SQL deployment needs no Elasticsearch for its own
        state). ES backend → bootstrap the tlsoc-agent-* indices as before."""
        if self._is_sql_backend() and self._sql_engine is not None:
            try:
                from .stores.sql import create_all

                await create_all(self._sql_engine)
            except Exception as exc:  # noqa: BLE001
                logger.error("SQL state schema bootstrap failed (%s); continuing", exc)
            return
        try:
            await bootstrap_indices(self.es)
        except Exception as exc:  # noqa: BLE001
            logger.error("Index bootstrap failed (%s); continuing", exc)

    async def _start_receivers(self) -> None:
        """Start background PUSH receivers for enabled configured sources.

        HTTP push receivers (webhook/HEC) are driven by the ``/api/ingest/{id}``
        route, not a task, so they are skipped here. Every other receiver
        (syslog/queues/object-store/file) runs as a guarded asyncio task whose
        ``emit`` feeds the shared :class:`IngestService`. A receiver that can't
        start (missing optional dep, bind error) is logged and skipped — it never
        blocks startup."""
        await self._stop_receivers()
        from .connectors.registry import get_registry
        from .constants import IngestMode

        reg = get_registry()
        for src in self.prefs.sources:
            if not src.enabled or not reg.is_receiver(src.source_type):
                continue
            cls = reg.get(src.source_type)
            if cls is None:
                continue
            if IngestMode.PUSH_HTTP in cls.manifest().ingest_modes:
                continue  # route-driven, no background task
            try:
                effective = {**src.config, **self.secrets.source_secrets(src.id)}
                receiver = cls(config=effective, connector_id=src.id)

                # Durable cursor for object-store / stream receivers (audit #7): persist
                # the last-processed marker keyed by this source id so a restart resumes.
                if hasattr(receiver, "attach_cursor_io"):
                    _cs = self.cursor_store
                    receiver.attach_cursor_io(
                        load=lambda _k=src.id: _cs.load_keyed(_k),
                        save=lambda cur, _k=src.id: _cs.save_keyed(_k, cur),
                    )

                async def _emit(events, _self=self, _sid=src.id):
                    # Real push receivers ALWAYS feed the REAL ingest path (even while
                    # demo is engaged) so live telemetry lands in the real store
                    # (hidden during demo, never mixed into the demo store).
                    await _self._real_ingest_service.ingest(events, _self.prefs, source_id=_sid)

                task = asyncio.create_task(
                    self._run_receiver(receiver, _emit, src.id)
                )
                task.add_done_callback(
                    lambda completed, _sid=src.id: self._receiver_done(_sid, completed)
                )
                self._receivers.append(receiver)
                self._receiver_tasks.append(task)
                logger.info("Started push receiver %s (%s)", src.id, src.source_type.value)
            except Exception as exc:  # noqa: BLE001 — one bad source must not block startup
                logger.error("Could not start receiver %s (%s): %s", src.id, src.source_type.value, exc)

    async def _run_receiver(self, receiver, emit, source_id: str) -> None:
        """Supervise one long-running receiver with bounded exponential backoff.

        Processing failures intentionally propagate out of transport loops so their
        offsets/messages remain unacknowledged. Without a supervisor that safety
        behavior permanently stopped the consumer. Restart the same configured
        receiver until reconciliation/shutdown cancels the task.
        """
        delay = 1.0
        while self._receivers_enabled:
            try:
                await receiver.start(emit, self.prefs)
                if not self._receivers_enabled:
                    return
                logger.warning("Push receiver %s stopped; restarting", source_id)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — supervised transport boundary
                logger.error(
                    "Push receiver %s failed; retrying in %.0fs: %s",
                    source_id,
                    delay,
                    exc,
                )
            try:
                await receiver.stop()
            except Exception:  # noqa: BLE001 — restart must continue after cleanup failure
                pass
            await asyncio.sleep(delay)
            delay = min(60.0, delay * 2.0)

    def _receiver_done(self, source_id: str, task: asyncio.Task) -> None:
        """Surface a receiver task exit instead of failing silently in the background."""
        if task.cancelled():
            return
        try:
            exc = task.exception()
        except asyncio.CancelledError:
            return
        if exc is None:
            if self._receivers_enabled:
                logger.warning("Push receiver %s stopped unexpectedly", source_id)
            return
        logger.error("Push receiver %s failed: %s", source_id, exc, exc_info=exc)

    async def reconcile_receivers(self) -> None:
        """Apply the current source/secret configuration to the live receivers.

        Reconciliation is intentionally idempotent and coarse-grained in version 0.1:
        stop the existing set cleanly, then start exactly the enabled configured set.
        This makes create/edit/delete/secret rotation effective without a process
        restart and prevents deleted file/syslog/queue consumers from lingering.
        Runtime states created with ``start_poller=False`` remain side-effect free.
        """
        if not self._receivers_enabled:
            return
        await self._start_receivers()

    async def _stop_receivers(self) -> None:
        for receiver in self._receivers:
            try:
                await receiver.stop()
            except Exception:  # noqa: BLE001
                pass
        tasks = list(self._receiver_tasks)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._receivers = []
        self._receiver_tasks = []

    async def reload_prefs(self) -> Preferences:
        self.prefs = await self.config_store.load()
        return self.prefs

    async def update_prefs(self, prefs: Preferences) -> Preferences:
        """Persist + publish a fully-built ``Preferences`` document atomically.

        Serialized under ``self._prefs_lock`` so a concurrent writer cannot interleave
        its ``config_store.save`` / ``self.prefs = …`` with this one (last-writer-wins
        lost update). A caller doing a read-modify-write should prefer
        :meth:`mutate_prefs`, which performs the read INSIDE the same lock so it builds
        on the freshest prefs rather than a snapshot that a background writer may already
        have superseded."""
        async with self._prefs_lock:
            return await self._apply_prefs_locked(prefs)

    async def mutate_prefs(
        self, mutate: Callable[[Preferences], Preferences]
    ) -> Preferences:
        """Atomic read-modify-write of ``Preferences`` under the write lock.

        ``mutate`` receives the CURRENT ``self.prefs`` (read inside the lock) and returns
        the new document to persist. Because the read, the transform, and the save all
        happen while the lock is held, a caller's edit can no longer be clobbered by a
        concurrent full-document write that started from a stale snapshot — the fix for a
        source rename silently not persisting. ``mutate`` must be a pure, non-blocking
        transform (typically ``prefs.model_copy(update=…)``) and must NOT call back into
        ``update_prefs``/``mutate_prefs`` (the lock is not reentrant)."""
        async with self._prefs_lock:
            new_prefs = mutate(self.prefs)
            return await self._apply_prefs_locked(new_prefs)

    async def _apply_prefs_locked(self, prefs: Preferences) -> Preferences:
        """Persist ``prefs`` + refresh the live components that cache it. MUST be called
        with ``self._prefs_lock`` held (via :meth:`update_prefs` / :meth:`mutate_prefs`)."""
        await self.config_store.save(prefs)
        self.prefs = prefs
        # Keep the long-lived RagService pointed at the latest prefs so a settings
        # change (rag.enabled / use_resolved_cases / min_score / top_k) is live.
        self.rag.set_prefs(prefs)
        # Keep the MFA-enforce role set live after a settings change (Wave 2 / F3).
        try:
            self.auth.set_mfa_enforce_roles(
                list(getattr(getattr(prefs, "mfa", None), "enforce_for_roles", []) or [])
            )
        except Exception:  # noqa: BLE001
            pass
        # Keep the realtime EventBus heartbeat cadence live after a settings change
        # (Round-3 Wave-1). Idempotent + best-effort; never blocks a prefs write.
        try:
            from .realtime import configure_event_bus

            configure_event_bus(getattr(prefs, "realtime", None))
        except Exception:  # noqa: BLE001
            pass
        return prefs

    async def apply_secrets(self, updates: dict[str, str | bool | None]) -> None:
        """Wizard-driven runtime secret update (kept in memory only).

        LLM/enrichment keys take effect immediately (the gateway/enrich tools read
        ``self.secrets`` live). If any ES credential changed, rebuild the ES client
        and re-wire all components, then re-bootstrap indices.
        """
        es_changed = False
        for key, value in updates.items():
            if not hasattr(self.secrets, key):
                continue
            setattr(self.secrets, key, value)
            if key in _ES_SECRET_FIELDS:
                es_changed = True
        # Force the gateway to rebuild provider clients with the new keys.
        self.gateway.reset_providers()
        if es_changed:
            await self.poller.stop()
            try:
                await self.es.close()
            except Exception:  # noqa: BLE001
                pass
            self.es = _build_es_client(self.secrets)
            self._wire()
            try:
                await self._bootstrap_state_backend()
            except Exception as exc:  # noqa: BLE001
                logger.error("Re-bootstrap after credential change failed: %s", exc)
            self.prefs = await self.config_store.load()
            # ``_wire()`` rebuilt a FRESH AuthService whose synced view is only the env
            # base layer — the persisted (store) accounts have been dropped. Without a
            # refresh, an ES-credential change would silently lock every OOBE/stored
            # account out until the next user mutation or a restart. Re-fold the store
            # into the auth view now (guarded: a transient empty read can't evict, and a
            # genuinely-empty store is honoured). Best-effort — never break a credential
            # change on a user-store read.
            try:
                await self.refresh_users()
            except Exception as exc:  # noqa: BLE001
                logger.warning("Refreshing users after credential change failed (%s)", exc)
            if self.prefs.setup_complete:
                self.poller.start()

    # ------------------------------------------------------------------ #
    # Demo Mode lifecycle (Wave 5) — enable / reset / disable / status.
    # All reversible + isolated: enable builds a throwaway demo stack + seeds a
    # backdated history; disable stops the ticker, hard-deletes demo data by run_id,
    # and flips the flag so the real state returns intact.
    # ------------------------------------------------------------------ #
    async def enable_demo(
        self, *, mode: str = "seeded", seed: int | None = None,
        history_days: int | None = None, tick_seconds: float | None = None,
        tick_jitter: float | None = None, incident_rate: float | None = None,
        alert_interval_seconds: float | None = None,
        event_rate_per_second: float | None = None,
        preseed_recent_minutes: int | None = None,
        preseed_case_count: int | None = None,
        preseed_event_count: int | None = None,
        force_capabilities: bool | None = None,
    ) -> dict:
        async with self._demo_lifecycle_lock:
            return await self._enable_demo_unlocked(
                mode=mode,
                seed=seed,
                history_days=history_days,
                tick_seconds=tick_seconds,
                tick_jitter=tick_jitter,
                incident_rate=incident_rate,
                alert_interval_seconds=alert_interval_seconds,
                event_rate_per_second=event_rate_per_second,
                preseed_recent_minutes=preseed_recent_minutes,
                preseed_case_count=preseed_case_count,
                preseed_event_count=preseed_event_count,
                force_capabilities=force_capabilities,
            )

    async def _enable_demo_unlocked(
        self, *, mode: str = "seeded", seed: int | None = None,
        history_days: int | None = None, tick_seconds: float | None = None,
        tick_jitter: float | None = None, incident_rate: float | None = None,
        alert_interval_seconds: float | None = None,
        event_rate_per_second: float | None = None,
        preseed_recent_minutes: int | None = None,
        preseed_case_count: int | None = None,
        preseed_event_count: int | None = None,
        force_capabilities: bool | None = None,
    ) -> dict:
        """Engage demo mode: stamp a run_id, build the isolated stack, pre-generate a
        backdated historical case spread + a tight "just happened" pre-seed (recent
        cases + already-processed events), eagerly seed the shared RAG corpus, run one
        demo-local capability pass, and (in ``live``) start the simulator. If a demo is
        already running it is disabled first (clean re-seed)."""
        from .config import DemoConfig
        from .engine.demo_generator import (
            build_org, generate_historical_cases, generate_recent_preseed, hits_to_raw,
        )
        from .engine.demo_runtime import DemoSimulator, DemoStack
        from .utils import new_id, now_utc, to_millis

        if self._demo is not None:
            await self._disable_demo_unlocked()

        cur = getattr(self.prefs, "demo", None) or DemoConfig()
        new_demo = DemoConfig(
            mode=("live" if mode == "live" else "seeded"),
            seed=int(seed if seed is not None else cur.seed),
            run_id=new_id("demorun-"),
            history_days=int(history_days if history_days is not None else cur.history_days),
            tick_seconds=float(tick_seconds if tick_seconds is not None else cur.tick_seconds),
            tick_jitter=float(tick_jitter if tick_jitter is not None else cur.tick_jitter),
            incident_rate=float(incident_rate if incident_rate is not None else cur.incident_rate),
            alert_interval_seconds=float(
                alert_interval_seconds if alert_interval_seconds is not None
                else cur.alert_interval_seconds),
            event_rate_per_second=float(
                event_rate_per_second if event_rate_per_second is not None
                else cur.event_rate_per_second),
            preseed_recent_minutes=int(
                preseed_recent_minutes if preseed_recent_minutes is not None
                else cur.preseed_recent_minutes),
            preseed_case_count=int(
                preseed_case_count if preseed_case_count is not None
                else cur.preseed_case_count),
            preseed_event_count=int(
                preseed_event_count if preseed_event_count is not None
                else cur.preseed_event_count),
            force_capabilities=bool(
                force_capabilities if force_capabilities is not None
                else cur.force_capabilities),
        )
        # Build and seed OFF to the side. Until the final synchronous swap, every
        # public read continues to see the complete real tenant; no caller can observe
        # a half-seeded demo (for example the 42 historical rows before capability
        # seeds finish). The closure serves pending prefs during construction and the
        # live prefs after this exact stack becomes active.
        pending_prefs = self.prefs.model_copy(deep=True)
        pending_prefs.demo = new_demo
        demo_stack = None

        def pending_or_live_prefs() -> Preferences:
            return (
                self.prefs
                if demo_stack is not None and self._demo is demo_stack
                else pending_prefs
            )

        demo_stack = DemoStack(
            self.secrets, pending_or_live_prefs, run_id=new_demo.run_id,
        )

        # Eagerly seed the SHARED demo RAG corpus so the Knowledge page shows a populated
        # corpus immediately (idempotent; picks up any CLOSED demo cases too).
        try:
            await demo_stack.rag_service.ensure_seeded()
        except Exception as exc:  # noqa: BLE001 — a cold RAG never breaks enable
            logger.debug("demo RAG eager-seed failed: %s", exc)

        # Pre-generate the backdated historical spread so "old" cases exist instantly.
        org = build_org(new_demo.seed)
        now_ms = to_millis(now_utc())
        cases = generate_historical_cases(
            new_demo.seed, org, history_days=new_demo.history_days,
            run_id=new_demo.run_id, now_millis=now_ms,
        )
        seeded_counter_cases = list(cases)
        for case in cases:
            self._write_guard(case, demo=True)
            await demo_stack.cases.save(case)

        # Pre-seed a tight "just happened" window: a varied trio of recent cases (1
        # TP-escalate, 1 NEEDS_HUMAN, 1 FP — not all terminal) + ~100 events already
        # batch-processed (fed through ingest ONCE so they count as ingested/correlated
        # volume in the noise-reduction/metrics surfaces, not decoration).
        recent_cases, recent_hits = generate_recent_preseed(
            new_demo.seed, org, run_id=new_demo.run_id, now_millis=now_ms,
            recent_minutes=new_demo.preseed_recent_minutes,
            case_count=new_demo.preseed_case_count,
            event_count=new_demo.preseed_event_count,
        )
        for case in recent_cases:
            self._write_guard(case, demo=True)
            await demo_stack.cases.save(case)
        seeded_counter_cases.extend(recent_cases)
        # Materialise the ~100 already-processed benign events now; the coherent
        # ingested/clustered counter delta is recorded after every seeded case is known
        # (including capability cases) so the visible funnel can never claim fewer
        # clusters than cases.
        preseed_raws = []
        if recent_hits:
            try:
                dprefs = demo_stack._demo_prefs()  # noqa: SLF001 — same module owner
                preseed_raws = hits_to_raw(recent_hits, dprefs)
                demo_stack.preseed_events = len(preseed_raws)
            except Exception as exc:  # noqa: BLE001 — a bad pre-seed count never breaks enable
                logger.warning("demo pre-seed event counting failed: %s", exc)

        # Capability seeding: make the HITL / campaign / adaptive-tuning capabilities show
        # REAL signal on a fresh enable (previously only RAG did). Deterministic + demo-
        # scoped — a shared-entity NEEDS_HUMAN pair (→ fired threshold-automation opens
        # HITL proposals AND the pair folds into >= 1 campaign) plus a block of same-rule
        # CLOSED false-positives (→ the tuner clears its min-samples/Wilson-LB bar and
        # records one bounded observation). Every write lands in the DEMO stores; the real
        # HITL/tuning/campaign ledgers are untouched. Gated on force_capabilities because
        # the seeded automation rule + the tuner/campaign blocks are only forced ON there.
        if new_demo.force_capabilities:
            try:
                from .engine.demo_generator import generate_capability_seed_cases

                hitl_cases, tuner_cases = generate_capability_seed_cases(
                    new_demo.seed, org, run_id=new_demo.run_id, now_millis=now_ms,
                )
                for case in (*hitl_cases, *tuner_cases):
                    self._write_guard(case, demo=True)
                    await demo_stack.cases.save(case)
                seeded_counter_cases.extend((*hitl_cases, *tuner_cases))
                # Fire threshold-automation on the NEEDS_HUMAN pair → >= 1 demo HITL proposal
                # (deterministic, $0 — runs on the already-saved demo cases; no LLM).
                await demo_stack.seed_hitl_proposals(hitl_cases)
            except Exception as exc:  # noqa: BLE001 — capability seeding never blocks enable
                logger.warning("demo capability seeding failed: %s", exc)

        # Seed one coherent, deterministic 24h funnel delta. The transient benign batch
        # contributes inbound volume only. Every seeded case in the current dashboard
        # window contributes one correlated cluster plus at least one source event (or
        # its actual member count), which mirrors how a real cluster becomes a case.
        # Recording the aggregate instead of replaying fixtures through the live spine
        # preserves deterministic case ids while guaranteeing the presenter sees the
        # truthful invariant ``events >= clusters >= cases`` from the first paint.
        try:
            from .constants import SEVERITY_BANDS
            from .engine import noise_counters as nc
            from .utils import parse_es_timestamp

            ingested = nc.count_events_by_band(preseed_raws, "ocsf_0_100")
            clustered = nc.zero_bands()
            case_events = nc.zero_bands()
            cutoff_ms = now_ms - 24 * 60 * 60 * 1000
            for case in seeded_counter_cases:
                created = parse_es_timestamp(case.created_at)
                if created is None or to_millis(created) < cutoff_ms:
                    continue
                band = case.severity_band if case.severity_band in SEVERITY_BANDS else "info"
                clustered[band] += 1
                members = case.member_event_keys or case.member_event_ids
                case_events[band] += max(1, len(members))
            ingested = nc.merge_bands(ingested, case_events)
            await demo_stack.noise_counters.record({
                "ingested": ingested,
                "clustered": clustered,
                "suppressed": 0,
                "ignored": 0,
            })
        except Exception as exc:  # noqa: BLE001 — metrics never block demo enable
            logger.warning("demo coherent funnel seed failed: %s", exc)

        # Run ONE synchronous capability pass so even a 'seeded' demo (no ticker) shows a
        # campaign + a tuning observation immediately.
        try:
            await demo_stack.run_capability_pass()
        except Exception as exc:  # noqa: BLE001 — never break enable on a capability pass
            logger.debug("demo initial capability pass failed: %s", exc)

        # Commit the fully-built stack. update_prefs() does not yield after assigning
        # self.prefs; the following synchronous assignment therefore presents one
        # atomic off→ready transition to other asyncio tasks.
        await self.update_prefs(pending_prefs)
        self._demo = demo_stack
        # Start the live simulator only after the complete stack is publicly visible.
        if new_demo.mode == "live":
            self._demo_sim = DemoSimulator(demo_stack, self.get_prefs, seed=new_demo.seed)
            self._demo_sim.start()
        logger.info("Demo mode ENABLED (mode=%s run_id=%s seeded %d + %d recent cases)",
                    new_demo.mode, new_demo.run_id, len(cases), len(recent_cases))
        return await self.demo_status()

    async def reset_demo(self) -> dict:
        async with self._demo_lifecycle_lock:
            return await self._reset_demo_unlocked()

    async def _reset_demo_unlocked(self) -> dict:
        """Delete the current demo data + re-seed from the SAME seed/run knobs (a
        fresh run_id). A no-op error-path when demo is not active."""
        cur = getattr(self.prefs, "demo", None)
        if self._demo is None or cur is None or not cur.active:
            return await self.demo_status()
        mode, seed = cur.mode, cur.seed
        hd, ts, tj, ir = cur.history_days, cur.tick_seconds, cur.tick_jitter, cur.incident_rate
        # Carry ALL the overhaul fields through the disable→enable round-trip so a reset
        # never silently drops them back to the DemoConfig defaults.
        ais, erps = cur.alert_interval_seconds, cur.event_rate_per_second
        prm, pcc, pec = cur.preseed_recent_minutes, cur.preseed_case_count, cur.preseed_event_count
        fc = cur.force_capabilities
        await self._disable_demo_unlocked()
        return await self._enable_demo_unlocked(
            mode=mode, seed=seed, history_days=hd, tick_seconds=ts,
            tick_jitter=tj, incident_rate=ir,
            alert_interval_seconds=ais, event_rate_per_second=erps,
            preseed_recent_minutes=prm, preseed_case_count=pcc, preseed_event_count=pec,
            force_capabilities=fc,
        )

    async def disable_demo(self) -> dict:
        async with self._demo_lifecycle_lock:
            return await self._disable_demo_unlocked()

    async def _disable_demo_unlocked(self) -> dict:
        """Stop the ticker, hard-delete ALL demo data (cases/audit/usage/events) by
        tearing down the throwaway stack, and flip demo OFF. The real state is
        untouched throughout, so it returns intact."""
        from .config import DemoConfig

        if self._demo_sim is not None:
            try:
                await self._demo_sim.stop()
            except Exception:  # noqa: BLE001
                pass
            self._demo_sim = None
        if self._demo_incident_sim is not None:
            try:
                await self._demo_incident_sim.stop()
            except Exception:  # noqa: BLE001
                pass
            self._demo_incident_sim = None
        if self._demo is not None:
            try:
                await self._demo.purge()
                await self._demo.aclose()
            except Exception:  # noqa: BLE001
                pass
            self._demo = None
        prefs = self.prefs.model_copy(deep=True)
        prefs.demo = DemoConfig()  # mode='off', run_id=''
        await self.update_prefs(prefs)
        logger.info("Demo mode DISABLED; real state restored")
        return await self.demo_status()

    async def demo_tick(self) -> dict:
        """Run ONE demo simulation tick on demand (a manual ``/poll`` while demo is
        engaged). Builds an ephemeral simulator for ``seeded`` mode (which has no
        background ticker) so the showcase can be driven manually. Returns the tick
        stats. A no-op when demo is off."""
        if self._demo is None:
            return {"benign": 0, "story": 0, "demo": False}
        sim = self._demo_control_simulator()
        stats = await sim.tick_once()
        stats["demo"] = True
        return stats

    def _demo_control_simulator(self):
        """Return the persistent simulator used by live or seeded/manual controls."""
        if self._demo_sim is not None:
            return self._demo_sim
        if self._demo_incident_sim is None:
            from .engine.demo_runtime import DemoSimulator

            seed = int(getattr(getattr(self.prefs, "demo", None), "seed", 1337) or 1337)
            self._demo_incident_sim = DemoSimulator(self._demo, self.get_prefs, seed=seed)
        return self._demo_incident_sim

    async def trigger_demo_incident(self, story_id: str | None = None) -> dict:
        """Trigger one cooldown-aware coherent attack inside the throwaway demo only."""
        if self._demo is None:
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
        return await self._demo_control_simulator().trigger_incident(story_id)

    async def demo_status(self) -> dict:
        """A small status payload for GET /api/demo/status."""
        demo = getattr(self.prefs, "demo", None)
        mode = getattr(demo, "mode", "off") if demo else "off"
        run_id = getattr(demo, "run_id", "") if demo else ""
        case_count = 0
        proposals_open = 0
        campaigns_found = 0
        tuning_events = 0
        rag_chunks = 0
        sources: list[str] = []
        source_activity: list[dict] = []
        if self._demo is not None:
            try:
                _cases, case_count = await self._demo.cases.list(limit=1)
            except Exception:  # noqa: BLE001
                case_count = 0
            # Per-capability signal so the UI can show "these are live" (all best-effort).
            try:
                proposals_open = await self._demo.open_proposal_count()
            except Exception:  # noqa: BLE001
                proposals_open = 0
            try:
                # CampaignStore.list() returns (page, total).
                _cpage, campaigns_found = await self._demo.campaign_store.list()
                campaigns_found = int(campaigns_found)
            except Exception:  # noqa: BLE001
                campaigns_found = 0
            try:
                tuning_events = len(await self._demo.tuning_store.list())
            except Exception:  # noqa: BLE001
                tuning_events = 0
            try:
                rag_chunks = int((await self._demo.vectorstore.stats()).get("total_chunks", 0))
            except Exception:  # noqa: BLE001
                rag_chunks = 0
            try:
                sources = [str(row["id"]) for row in self.demo_sources_overlay()]
            except Exception:  # noqa: BLE001
                sources = []
            try:
                snapshot = self._demo.source_runtime_snapshot(
                    running=self._demo_sim is not None,
                )
                source_activity = list(snapshot.get("sources", []))
            except Exception:  # noqa: BLE001
                source_activity = []
        return {
            "mode": mode,
            "active": bool(demo and demo.active),
            "run_id": run_id,
            "seed": getattr(demo, "seed", 0) if demo else 0,
            "history_days": getattr(demo, "history_days", 0) if demo else 0,
            "tick_seconds": getattr(demo, "tick_seconds", 0.0) if demo else 0.0,
            "incident_rate": getattr(demo, "incident_rate", 0.0) if demo else 0.0,
            "alert_interval_seconds": getattr(demo, "alert_interval_seconds", 0.0) if demo else 0.0,
            "event_rate_per_second": getattr(demo, "event_rate_per_second", 0.0) if demo else 0.0,
            "preseed_recent_minutes": getattr(demo, "preseed_recent_minutes", 0) if demo else 0,
            "preseed_case_count": getattr(demo, "preseed_case_count", 0) if demo else 0,
            "preseed_event_count": getattr(demo, "preseed_event_count", 0) if demo else 0,
            "force_capabilities": bool(getattr(demo, "force_capabilities", True)) if demo else True,
            "simulator_running": self._demo_sim is not None,
            "ticking": self._demo_sim is not None,
            "case_count": case_count,
            "preseed_events": int(getattr(self._demo, "preseed_events", 0)) if self._demo else 0,
            "proposals_open": proposals_open,
            "campaigns_found": campaigns_found,
            "tuning_events": tuning_events,
            "rag_chunks": rag_chunks,
            "sources": sources,
            "source_activity": source_activity,
        }

    def demo_sources_overlay(self) -> list[dict]:
        """The four native demo sources shaped like a ``SourceInstance.model_dump`` for the
        read-time-only active source view on GET /api/sources + /sources/health. Built from
        the live ``DemoStack`` — NEVER written into ``Preferences.sources`` (so the real
        PollerManager / PUT /api/settings / the wizard never see them). Returns ``[]``
        when demo is off; real source configuration remains preserved and hidden until
        Demo Mode is disabled."""
        if self._demo is None:
            return []
        from .engine.demo_sources import DEMO_SOURCE_SPECS

        rows: list[dict] = []
        for spec in DEMO_SOURCE_SPECS.values():
            source_type = (
                spec.source_type.value
                if hasattr(spec.source_type, "value") else str(spec.source_type)
            )
            ingest_mode = (
                spec.ingest_mode.value
                if hasattr(spec.ingest_mode, "value") else str(spec.ingest_mode)
            )
            rows.append({
                "id": spec.source_id,
                "display_name": spec.display_name,
                "source_type": source_type,
                "category": spec.category,
                "enabled": True,
                "is_primary": False,
                "ingest_mode": ingest_mode,
                "protocol": spec.protocol,
                "format": spec.wire_format,
                "can_browse": True,
                "demo": True,
                "config": {
                    "protocol": spec.protocol,
                    "format": spec.wire_format,
                },
                "configured_secrets": [],
            })
        return rows

    def demo_source_connector(self, source_id: str):
        """Return one isolated native demo adapter by public source id.

        This is a read-only route seam: the adapters and their bounded rings live on
        the throwaway ``DemoStack`` and are never registered as tenant connectors or
        persisted in ``Preferences.sources``. ``None`` is returned off-demo/unknown.
        """
        if self._demo is None:
            return None
        try:
            from .engine.demo_sources import DEMO_SOURCE_SPECS

            key = next(
                (key for key, spec in DEMO_SOURCE_SPECS.items()
                 if spec.source_id == source_id),
                None,
            )
            return self._demo.sources.get(key) if key else None
        except Exception:  # noqa: BLE001 — browse degrades to a normal not-found
            return None

    def demo_source_health_overlay(self) -> list[dict]:
        """Truthful, non-secret runtime health rows for the four demo adapters.

        Runtime counters come from the adapters' bounded activity rings. Static vendor
        identity comes from ``DEMO_SOURCE_SPECS``. No durable poll cursor is fabricated:
        these are push-style simulators, so ``last_poll_*`` remains ``None``/``0``.
        """
        if self._demo is None:
            return []
        runtime: dict[str, dict] = {}
        try:
            snapshot = self._demo.source_runtime_snapshot(
                running=self._demo_sim is not None,
            )
            runtime = {
                str(row.get("source_id") or row.get("id")): dict(row)
                for row in snapshot.get("sources", [])
                if isinstance(row, dict) and (row.get("source_id") or row.get("id"))
            }
        except Exception:  # noqa: BLE001 — health is advisory and fail-soft
            runtime = {}

        rows: list[dict] = []
        for source in self.demo_sources_overlay():
            sid = str(source["id"])
            activity = runtime.get(sid, {})
            last_event = int(activity.get("last_event_millis") or 0)
            events_total = int(
                activity.get("events_received", activity.get("events_total", 0)) or 0
            )
            alerts_total = int(
                activity.get("alerts_emitted", activity.get("alerts_total", 0)) or 0
            )
            system_detections_total = int(
                activity.get("system_detections_total", 0) or 0
            )
            try:
                events_per_min = float(activity.get("events_per_min") or 0.0)
            except (TypeError, ValueError):
                events_per_min = 0.0
            rows.append({
                "source_id": sid,
                "source_name": source.get("display_name") or sid,
                "source_type": source.get("source_type"),
                "enabled": True,
                "is_primary": False,
                "ingest_mode": source.get("ingest_mode"),
                "kind": "push",
                "protocol": source.get("protocol"),
                "format": source.get("format"),
                "can_browse": True,
                "buffer_depth": int(activity.get("buffer_depth") or 0),
                "events_total": events_total,
                "alerts_total": alerts_total,
                "system_detections_total": system_detections_total,
                # Human-readable API aliases retained for UI consumers.
                "events_received": events_total,
                "alerts_emitted": alerts_total,
                "last_poll_millis": 0,
                "last_poll_at": None,
                "last_poll_ok": None,
                "last_poll_error": None,
                "last_event_millis": last_event,
                "events_per_min": events_per_min,
                "silent": bool(activity.get("silent", False)),
                "healthy": bool(activity.get("healthy", True)),
                "state": activity.get("state") or "ready",
                "last_error": activity.get("last_error"),
                "demo": True,
            })
        return rows

    @staticmethod
    def _write_guard(case, *, demo: bool) -> None:
        """Assert a row's demo-ness matches the store it is about to be written to.

        A demo case MUST be tagged ``demo`` and carry a ``demo-…`` case_id; a real
        case must NOT. This is the belt-and-braces backstop ensuring no demo row ever
        leaks into the real store and vice-versa (#4)."""
        is_demo_row = ("demo" in (getattr(case, "tags", []) or [])) or str(
            getattr(case, "case_id", "")
        ).startswith("demo-")
        if demo and not is_demo_row:
            raise AssertionError("write-guard: a demo store write must carry a demo-tagged row")
        if not demo and is_demo_row:
            raise AssertionError("write-guard: a real store write must NOT carry a demo row")

    async def shutdown(self) -> None:
        try:
            await self.job_runner.stop()
        except Exception:  # noqa: BLE001
            pass
        try:
            await self.disable_demo()
        except Exception:  # noqa: BLE001
            pass
        try:
            await self._stop_system_update_audit_reconciler()
        except Exception:  # noqa: BLE001
            pass
        try:
            await self._stop_schedulers()
        except Exception:  # noqa: BLE001
            pass
        try:
            await self.poller.stop()
        except Exception:  # noqa: BLE001
            pass
        self._receivers_enabled = False
        await self._stop_receivers()
        await self.cancel_mutation_tasks()
        await self.gateway.aclose()
        await self.cache.aclose()
        owned = getattr(self, "_owned_log_client", None)
        if owned is not None and owned is not self.es:
            try:
                await owned.close()
            except Exception:  # noqa: BLE001
                pass
        try:
            await self.es.close()
        except Exception:  # noqa: BLE001
            pass
        if self._sql_engine is not None:
            try:
                await self._sql_engine.dispose()
            except Exception:  # noqa: BLE001
                pass
            self._sql_engine = None


def _coerce_bool(v: Any, default: bool = True) -> bool:
    if isinstance(v, bool):
        return v
    if isinstance(v, str):
        return v.strip().lower() not in ("false", "0", "no", "off", "")
    return default if v is None else bool(v)


def _source_es_overrides(merged: dict[str, Any]) -> dict[str, Any]:
    """Translate a source's merged config+secrets into Secrets connection overrides.
    Returns {} when the source specifies no ES connection settings (→ use the shared
    global client). This is what makes a source's es_verify_certs/es_ca_cert apply."""
    out: dict[str, Any] = {}
    if merged.get("es_url"):
        out["es_url"] = str(merged["es_url"])
    if merged.get("es_api_key"):
        out["es_api_key"] = str(merged["es_api_key"])
    if "es_verify_certs" in merged:
        out["es_verify_certs"] = _coerce_bool(merged.get("es_verify_certs"))
    if merged.get("es_ca_cert"):
        out["es_ca_cert"] = str(merged["es_ca_cert"])
    return out


def parse_user_agent(ua: str) -> dict[str, str]:
    """A tiny, dependency-free User-Agent parser (Wave 3, stdlib only).

    Returns ``{"ua_browser", "ua_os", "client_type"}`` — best-effort, never raises.
    This is heuristic (NOT a full UA database) and produces PLAIN labels rendered as
    text by the UI (#9). An unrecognised UA degrades to empty strings."""
    raw = (ua or "").strip()
    low = raw.lower()
    if not raw:
        return {"ua_browser": "", "ua_os": "", "client_type": ""}
    # Browser (order matters — Edge/Chrome share tokens; check the more specific first).
    browser = ""
    for needle, label in (
        ("edg/", "Edge"), ("edga/", "Edge"), ("edgios/", "Edge"),
        ("opr/", "Opera"), ("opera", "Opera"),
        ("chrome/", "Chrome"), ("crios/", "Chrome"),
        ("firefox/", "Firefox"), ("fxios/", "Firefox"),
        ("safari/", "Safari"),
        ("curl/", "curl"), ("python-requests", "python-requests"),
        ("postmanruntime", "Postman"), ("httpie", "HTTPie"),
    ):
        if needle in low:
            browser = label
            break
    # OS family.
    os_name = ""
    for needle, label in (
        ("windows nt 10", "Windows"), ("windows nt 11", "Windows"), ("windows", "Windows"),
        ("iphone", "iOS"), ("ipad", "iPadOS"),
        ("mac os x", "macOS"), ("macintosh", "macOS"),
        ("android", "Android"),
        ("cros", "ChromeOS"),
        ("linux", "Linux"),
    ):
        if needle in low:
            os_name = label
            break
    # Client type heuristic.
    if any(t in low for t in ("curl/", "python-requests", "postmanruntime", "httpie", "go-http", "okhttp")):
        client_type = "api"
    elif any(t in low for t in ("mobile", "iphone", "android")):
        client_type = "mobile"
    elif browser:
        client_type = "browser"
    else:
        client_type = ""
    return {"ua_browser": browser, "ua_os": os_name, "client_type": client_type}


def client_ip_from(request) -> str:
    """Best-effort client IP from a Starlette/FastAPI request (Wave 3, stdlib only).

    Honors a single ``X-Forwarded-For`` hop (first entry) when present, else the
    socket peer. PLAIN text, never raises. (No trust decision is made here — the IP
    is metadata only, never an authz input.)"""
    try:
        xff = request.headers.get("x-forwarded-for") or ""
        if xff:
            first = xff.split(",")[0].strip()
            if first:
                return first
        client = getattr(request, "client", None)
        return str(getattr(client, "host", "") or "")
    except Exception:  # noqa: BLE001
        return ""


def geo_for_ip(ip: str) -> dict[str, str]:
    """Best-effort IP → ``{"ip_city", "ip_country"}`` (Wave 3). Stdlib only and a
    NO-OP by default — we add NO geo dependency and make NO network call. A private/
    loopback/empty IP yields a friendly local label; everything else yields empties
    (a future operator-supplied offline geo DB could fill these in). Never raises."""
    addr = (ip or "").strip()
    if not addr:
        return {"ip_city": "", "ip_country": ""}
    try:
        import ipaddress

        parsed = ipaddress.ip_address(addr)
        if parsed.is_loopback or parsed.is_private or parsed.is_link_local:
            return {"ip_city": "", "ip_country": "Local network"}
    except ValueError:
        pass
    return {"ip_city": "", "ip_country": ""}


class _BatchJobService:
    """Durable BATCH-inference service (Round-4 Wave-3 — submit / poll / process).

    A THIN orchestrator that ties the batch-provider SPI (``llm/batch.py``) to the
    durable :class:`app.stores.batch_jobs.BatchJobStore` + the ONE LLM gateway ledger.
    It is INERT until Wave-4 calls it: constructing it opens no connection and reads no
    network; each provider is built on demand and closed after use.

    Ledger invariant (#6): result folding is delegated to
    ``BatchJobStore.process_results`` which writes EXACTLY ONE ``UsageDoc`` per result
    (deduped by ``custom_id``, at the 0.5× batch rate) — so a re-poll/restart never
    double-writes. It NEVER imports ``case_manager`` / calls ``decide()`` (#3) — folding
    verdict text into cases is the pipeline's job downstream.

    Provider acceptance and local provider-id persistence are not one transaction.
    The durable local outbox prevents duplicate submission on normal cursor replay,
    but neither bundled provider exposes a universal idempotency/recovery key for the
    narrow crash window after remote acceptance and before ``provider_batch_id`` is
    saved. That boundary is surfaced as an operational limitation rather than claimed
    as exactly-once remote submission."""

    def __init__(
        self, *, store, gateway, make_provider, get_prefs, reenter=None, state=None
    ) -> None:
        self._store = store
        self._gateway = gateway
        self._make_provider = make_provider
        self._get_prefs = get_prefs
        # Optional ``async reenter(job, results) -> int`` hook: re-enters LLM-CONFIRMED
        # event-detections into the SAME correlate→pipeline path (#4/#3). None → results
        # are only billed (a plain investigation batch), never re-entered here.
        self._reenter = reenter
        self._state = state

    async def _project_inbox(self, job) -> None:
        if self._state is None:
            return
        try:
            from .engine.batch_inbox import reconcile_batch_inbox

            await reconcile_batch_inbox(self._state, job)
        except Exception as exc:  # projection outbox is retried; provider work proceeds
            logger.warning("LLM Batch Inbox projection failed for %s: %s", job.id, exc)

    async def reconcile_inbox(self) -> None:
        """Retry every bounded Batch Inbox outbox, including terminal rows."""
        for job in await self._store.list_strict():
            await self._project_inbox(job)

    @property
    def store(self):
        return self._store

    def enabled(self) -> bool:
        """Whether batch inference is turned on (``Preferences.batch.enabled``). Wave-4
        gates on this; default OFF so nothing routes to batch out of the box."""
        return bool(getattr(getattr(self._get_prefs(), "batch", None), "enabled", False))

    @staticmethod
    def _outbox_id(provider: str, model: str, requests: list[dict]) -> str:
        """Deterministic identity for one local submission intent.

        It is derived from the provider/model plus the stable request bodies, so a
        cursor retry after an accepted local write finds the same outbox row and never
        issues a second remote submission from the normal replay path.
        """
        import hashlib
        import json

        payload = json.dumps(
            {"provider": provider, "model": model, "requests": requests},
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        ).encode("utf-8")
        return f"batch-outbox-{hashlib.sha256(payload).hexdigest()[:32]}"

    async def _submit_outbox(self, job):
        """Try one remote submission for a previously durable local outbox row.

        Provider/network errors are persisted on the row and returned as queued work;
        the scheduler retries them via :meth:`poll`.  A failure to persist either the
        initial row or the attempt status still raises to the Poller, preserving its
        cursor.
        """
        from .utils import iso_now

        # Every submission entry point shares one strict durable lease. The local row
        # is intentionally visible before this claim so the Poller cursor may advance,
        # but a scheduler pass racing this caller now observes the active lease and
        # performs no second provider call.
        job, lease_token = await self._store.claim_submission(job.id)
        if job is None:
            raise RuntimeError("batch outbox disappeared before provider submission")
        if lease_token is None:
            return job
        provider_client = None
        try:
            try:
                provider_client = self._make_provider(job.provider)
                remote = await provider_client.submit(job.model, list(job.requests))
                if not remote.provider_batch_id:
                    raise RuntimeError("batch provider accepted no provider_batch_id")
            except Exception as exc:  # noqa: BLE001 - durable retryable provider error
                failed = await self._store.fail_submission(job.id, lease_token, str(exc))
                if failed is None:
                    raise RuntimeError(
                        "batch outbox disappeared while recording provider failure"
                    ) from exc
                await self._project_inbox(failed)
                return failed

            # Persist acceptance before closing the client. A slow/hung close must not
            # leave a remotely accepted row looking unsubmitted long enough for its
            # lease to expire and a scheduler to POST it again.
            remote.id = job.id
            remote.requests = list(job.requests)
            remote.submitted_at = remote.submitted_at or job.submitted_at or iso_now()
            accepted = await self._store.complete_submission(
                job.id, lease_token, remote
            )
            if accepted is None:
                raise RuntimeError(
                    "batch outbox disappeared while recording provider acceptance"
                )
            await self._project_inbox(accepted)
            return accepted
        finally:
            if provider_client is not None:
                try:
                    await provider_client.aclose()
                except Exception as exc:  # noqa: BLE001 - close cannot erase acceptance
                    logger.debug("batch provider close failed after submit: %s", exc)

    async def submit(self, provider: str, model: str, requests: list[dict], *, candidates=None):
        """Persist a local outbox row, then opportunistically submit it remotely.

        The local write happens FIRST. Provider/network failure therefore leaves
        resume-safe queued work and does not lose an EVENT-feed tick.

        ``candidates`` — an optional ``{custom_id -> serialised CandidateAlert}`` map for an
        EVENT-detection batch. Persisted onto the job so :meth:`process` can reconstruct
        the survivors and RE-ENTER the pipeline (same-signature cluster #4) when the
        confirmations return. None/empty for a plain investigation batch."""
        from .constants import BatchJobState
        from .models import BatchJob
        from .utils import iso_now

        clean_requests = list(requests or [])
        local_id = self._outbox_id(provider, model, clean_requests)
        tracking: dict[str, dict] = {}
        for request in clean_requests:
            cid = str(request.get("custom_id", "") or "").strip()
            if cid:
                tracking[cid] = {"retrieved": False, "result_state": None}
        job = BatchJob(
            id=local_id,
            provider=provider,
            model=model,
            state=BatchJobState.SUBMITTED,
            custom_ids=tracking,
            requests=clean_requests,
            candidates=dict(candidates or {}),
            submitted_at=iso_now(),
        )
        if self._state is not None:
            from .engine.batch_inbox import prepare_batch_inbox_audience

            job = await prepare_batch_inbox_audience(self._state, job)
        # This is the acceptance boundary used by the Poller cursor. Creation is a
        # strict atomic CAS: simultaneous identical submitters share one local intent.
        # The provider call is separately leased because the scheduler can observe the
        # row between this creation and the opportunistic submit below.
        job, created = await self._store.create_if_absent(job)
        if not created:
            await self._project_inbox(job)
            return job
        await self._project_inbox(job)
        return await self._submit_outbox(job)

    async def poll(self, job):
        """Refresh one job's state from its provider and persist it. Returns the job."""
        if not job.provider_batch_id:
            if job.requests:
                return await self._submit_outbox(job)
            # Legacy/corrupt submitted rows without an outbox payload cannot be retried
            # safely. Keep them visible rather than inventing or dropping requests.
            return job
        prov = self._make_provider(job.provider)
        try:
            job = await prov.poll(job)
        finally:
            await prov.aclose()
        saved = await self._store.save(job)
        await self._project_inbox(saved)
        return saved

    async def process(self, job, *, role: str = "investigator", surface: str = "batch"):
        """Stream a completed job's results, fold them through the ONE gateway ledger
        EXACTLY once (deduped by ``custom_id``, #6), then RE-ENTER any LLM-CONFIRMED
        event-detection into the SAME correlate→pipeline path (#4/#3) via the injected
        ``reenter`` hook. Returns the newly-recorded results.

        Ledger retrieval and detection re-entry are separate durable transitions. A
        successful ledger fold marks a candidate ``reentry_state=pending``; this method
        leases each pending result, calls the case pipeline, then confirms completion.
        A failure returns it to pending, so the scheduler retries without another ledger
        row. Non-detection batches retain the historical newly-recorded return value."""
        prov = self._make_provider(job.provider)
        try:
            results = list(await prov.results(job))
        finally:
            await prov.aclose()
        recorded = await self._store.process_results(
            job, results, self._gateway, role=role, surface=surface
        )
        if not getattr(job, "candidates", None):
            current = await self._store.get_strict(job.id)
            if current is not None:
                await self._project_inbox(current)
            return recorded

        by_id = {
            str(getattr(result, "custom_id", "") or ""): result
            for result in results
            if str(getattr(result, "result_type", "succeeded")) == "succeeded"
        }
        claims = await self._store.claim_reentries(job.id, by_id)
        completed = []
        for custom_id, token in claims.items():
            result = by_id.get(custom_id)
            if result is None:
                await self._store.fail_reentry(
                    job.id, custom_id, token, "provider result unavailable for re-entry"
                )
                continue
            if self._reenter is None:
                await self._store.fail_reentry(
                    job.id, custom_id, token, "detection re-entry hook is not configured"
                )
                continue
            try:
                current = await self._store.get_strict(job.id)
                await self._reenter(current or job, [result])
            except Exception as exc:  # noqa: BLE001 — durable pending state retries
                await self._store.fail_reentry(
                    job.id, custom_id, token, f"detection re-entry failed: {exc}"
                )
                continue
            if await self._store.complete_reentry(job.id, custom_id, token):
                completed.append(result)
        current = await self._store.get_strict(job.id)
        if current is not None:
            await self._project_inbox(current)
        return completed


def _build_es_client(secrets: Secrets) -> BaseESClient:
    use_real = secrets.es_store_enabled and bool(secrets.es_mgmt_api_key or secrets.es_api_key)
    if use_real:
        try:
            from .es.client import RealESClient

            return RealESClient(secrets)
        except Exception as exc:  # noqa: BLE001
            logger.error("Could not build real ES client (%s); using in-memory store", exc)
    else:
        logger.warning(
            "No ES key configured (or es_store_enabled=false); using IN-MEMORY store. "
            "Data will NOT persist. Set ES_MGMT_API_KEY for a real deployment."
        )
    from .es.fake import InMemoryESClient

    return InMemoryESClient()
