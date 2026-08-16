"""Stable constants and enums shared across the suite.

Keeping these in one place means the data contracts (Section 7 of the spec) and
the policy boundaries (Section 6.4) are defined exactly once.
"""

from __future__ import annotations

from enum import Enum

# --------------------------------------------------------------------------- #
# Elasticsearch indices OWNED by the backend (Section 7).
# These are write targets that use the management credential, NEVER the
# read-only agent key. Date-suffixed indices are written through a write alias
# created from the index template.
# --------------------------------------------------------------------------- #
CASES_INDEX = "tlsoc-agent-cases"
AUDIT_INDEX = "tlsoc-agent-audit"
USAGE_INDEX = "tlsoc-agent-usage"
# Non-secret, UI-editable preferences (Section 5/8.5) and the durable cursor
# (Section 6.1) live in single-doc bookkeeping indices.
CONFIG_INDEX = "tlsoc-agent-config"
CURSOR_INDEX = "tlsoc-agent-cursor"

# Write aliases (rollover-friendly). The template maps `<index>-*`; the backend
# writes through `<index>-000001` behind the `<index>` alias on first boot.
CASES_WRITE_ALIAS = CASES_INDEX
AUDIT_WRITE_ALIAS = AUDIT_INDEX
USAGE_WRITE_ALIAS = USAGE_INDEX

# Read patterns for queries/dashboards.
CASES_READ_PATTERN = f"{CASES_INDEX}-*"
AUDIT_READ_PATTERN = f"{AUDIT_INDEX}-*"
USAGE_READ_PATTERN = f"{USAGE_INDEX}-*"

# Singleton doc ids for the single-doc bookkeeping indices.
CONFIG_DOC_ID = "preferences"
CURSOR_DOC_ID = "primary"

# Operator MEMORY (durable facts the agents remember). Backend-agnostic: stored
# as a single KV document (one JSON list of entries) under this namespace/key, so
# it needs NO new ES index / SQL table / migration. The ES backend stores it as a
# doc in the existing CONFIG_INDEX; the SQL backend uses the shared KV table.
MEMORY_NS = "memory"
MEMORY_KEY = "entries"
MEMORY_DOC_ID = "memory"      # ES doc id within CONFIG_INDEX

# Operator-managed RUNBOOK Markdown. Bundled runbooks remain packaged under
# ``app/runbooks``; additions created in the Console are persisted in the shared
# backend-agnostic KV store so they survive container/image upgrades without a new
# index, table, or migration. The stored document is a bounded id -> Markdown map.
RUNBOOKS_NS = "runbooks"
RUNBOOKS_KEY = "documents"

# Operator-managed PLAYBOOK Markdown. Packaged procedures stay immutable files;
# Console-authored procedures live in this backend-agnostic KV document so image
# replacement/container recreation cannot silently discard them. The exact wire
# namespace is new application-owned state (no new ES index / SQL migration).
PLAYBOOKS_NS = "playbooks"
PLAYBOOKS_KEY = "documents"

# Agent-DRAFTED proposals awaiting human approval (HITL). Stored exactly like the
# operator MEMORY set — one KV document (a single JSON list) under this namespace/
# key — so it needs NO new ES index / SQL table / migration. The ES backend stores
# it as a doc in the existing CONFIG_INDEX; the SQL backend uses the shared KV table.
PROPOSALS_NS = "proposals"
PROPOSALS_KEY = "entries"
PROPOSALS_DOC_ID = "proposals"   # ES doc id within CONFIG_INDEX

# Multi-USER store (Wave 1: real users for login + RBAC). Stored exactly like the
# operator MEMORY / agent PROPOSAL sets — ONE KV document (a single JSON list) under
# this namespace/key — so it needs NO new ES index / SQL table / migration. The ES
# backend stores it as a doc in the existing CONFIG_INDEX; the SQL backend uses the
# shared KV table.
USERS_NS = "users"
USERS_KEY = "entries"
USERS_DOC_ID = "users"   # ES doc id within CONFIG_INDEX

# Session registry (Wave 3: sessions & access policy — login/idle/absolute TTL +
# revocation + per-session metadata). Stored exactly like the operator MEMORY /
# agent PROPOSAL / multi-USER sets — ONE KV document (a single JSON list of session
# rows) under this namespace/key — so it needs NO new ES index / SQL table /
# migration. The ES backend stores it as a doc in the existing CONFIG_INDEX; the
# SQL backend uses the shared KV table. The JWT signature stays the root of trust;
# this registry only ADDS revocation + idle/absolute expiry + per-session metadata
# on top of a validly-signed access token.
SESSIONS_NS = "sessions"
SESSIONS_KEY = "entries"
SESSIONS_DOC_ID = "sessions"   # ES doc id within CONFIG_INDEX

# Per-USER personal preferences (Wave 7: pervasive customization — saved views,
# table column state, theme mode, last-used list state, pinned default views, a
# misc prefs bag). Stored exactly like the operator MEMORY / agent PROPOSAL /
# multi-USER / SESSION sets — ONE KV document (a single JSON object keyed by
# user_id) under this namespace/key — so it needs NO new ES index / SQL table /
# migration. The ES backend stores it as a doc in the existing CONFIG_INDEX; the
# SQL backend uses the shared KV table. The ``default`` bucket is used as the
# user_id when auth is OFF, so the no-auth profile still has personal prefs.
USER_PREFS_NS = "user_prefs"
USER_PREFS_KEY = "buckets"
USER_PREFS_DOC_ID = "user_prefs"   # ES doc id within CONFIG_INDEX
# The bucket key used when there is no authenticated principal (auth OFF).
USER_PREFS_DEFAULT_BUCKET = "default"

# Per-USER Workspace chat history.  This is intentionally separate from the
# per-case collaboration thread: Workspace conversations are owned by one
# principal, while case chat remains attached to the case thread. Each principal
# uses a hashed KV partition; the legacy root id now holds the partition registry
# and supports lazy migration from the former shared document. No new index/table
# migration is required on either ES or SQL.
CHAT_CONVERSATIONS_NS = "chat_conversations"
CHAT_CONVERSATIONS_KEY = "conversations"
CHAT_CONVERSATIONS_DOC_ID = "chat_conversations"

# --------------------------------------------------------------------------- #
# Round 3 KV-store namespaces (collaboration / notifications / RBAC / pricing /
# shift-handoff). Every one follows the SAME single-KV-document pattern as the
# Wave-1..7 namespaces above (MEMORY / PROPOSALS / USERS / SESSIONS / USER_PREFS):
# one JSON document under ``<NS>/<KEY>`` so each needs NO new ES index / SQL table /
# migration. The ES backend stores each as a doc in the existing CONFIG_INDEX; the
# SQL backend uses the shared KV table. Later waves OWN the store classes over these.
# --------------------------------------------------------------------------- #
# Per-case threaded discussion (CaseMessage list). Keyed per case so a hot case
# thread doesn't bloat one global doc — the store keys by case_id within the NS.
CASE_THREAD_NS = "case_thread"
CASE_THREAD_KEY = "threads"
CASE_THREAD_DOC_ID = "case_thread"      # ES doc id within CONFIG_INDEX

# Per-case activity timeline (CaseActivity list) — append-only audit of human/ai
# collaboration events surfaced beside the thread.
CASE_ACTIVITY_NS = "case_activity"
CASE_ACTIVITY_KEY = "activity"
CASE_ACTIVITY_DOC_ID = "case_activity"  # ES doc id within CONFIG_INDEX

# Per-case checklist / tasks (CaseTask list).
CASE_TASKS_NS = "case_tasks"
CASE_TASKS_KEY = "tasks"
CASE_TASKS_DOC_ID = "case_tasks"        # ES doc id within CONFIG_INDEX

# Per-user in-app notification inbox (InAppNotification list), keyed by recipient.
INBOX_NS = "inbox"
INBOX_KEY = "items"
INBOX_DOC_ID = "inbox"                  # ES doc id within CONFIG_INDEX

# Per-user notification preferences (NotificationPref), keyed by user.
NOTIF_PREFS_NS = "notif_prefs"
NOTIF_PREFS_KEY = "prefs"
NOTIF_PREFS_DOC_ID = "notif_prefs"      # ES doc id within CONFIG_INDEX

# Operator-defined custom RBAC roles (CustomRole list). NOTE: custom roles ALSO
# ride on ``Preferences.rbac.custom_roles`` (config tier); this KV namespace is
# reserved for any out-of-band/admin-managed role set a later wave may want to keep
# off the Preferences doc. Wave 1 of Round 3 resolves the effective matrix.
CUSTOM_ROLES_NS = "custom_roles"
CUSTOM_ROLES_KEY = "roles"
CUSTOM_ROLES_DOC_ID = "custom_roles"    # ES doc id within CONFIG_INDEX

# Operator price overrides for the LLM cost ledger (model -> per-token override),
# layered ON TOP OF the built-in pricing catalog (PRICE OVERLAY).
PRICE_OVERLAY_NS = "price_overlay"
PRICE_OVERLAY_KEY = "overlay"
PRICE_OVERLAY_DOC_ID = "price_overlay"  # ES doc id within CONFIG_INDEX

# Shift handoff / standup attention-queue acknowledgements (ShiftAck +
# ActionItem lists) — the running standup handoff log.
SHIFT_HANDOFF_NS = "shift_handoff"
SHIFT_HANDOFF_KEY = "handoff"
SHIFT_HANDOFF_DOC_ID = "shift_handoff"  # ES doc id within CONFIG_INDEX

# --------------------------------------------------------------------------- #
# Round 4 KV-store namespaces (campaign clustering / anomaly baseline sketches /
# batch-inference jobs / threshold tuning). Every one follows the SAME single-KV-
# document pattern as the Wave-1..7 + Round-3 namespaces above: one JSON document
# under ``<NS>/<KEY>`` so each needs NO new ES index / SQL table / migration. The ES
# backend stores each as a doc in the existing CONFIG_INDEX; the SQL backend uses the
# shared KV table. Later waves OWN the store classes over these.
# --------------------------------------------------------------------------- #
# Cross-case CAMPAIGN clustering (Campaign list) — related cases grouped by shared
# entities/MITRE into a running campaign.
CAMPAIGNS_NS = "campaigns"
CAMPAIGNS_KEY = "campaigns"
CAMPAIGNS_DOC_ID = "campaigns"          # ES doc id within CONFIG_INDEX

# Anomaly-detection BASELINE sketch state (BaselineState per keyed series) — the
# compact Welford/EWMA/t-digest sketches the detection engine warms over time.
BASELINE_NS = "baseline"
BASELINE_KEY = "baseline"
BASELINE_DOC_ID = "baseline"            # ES doc id within CONFIG_INDEX

# BATCH-inference jobs (BatchJob list) — submitted/polling/retrieving provider batch
# jobs (Anthropic/OpenAI batch APIs) awaiting async result retrieval.
BATCH_JOBS_NS = "batch_jobs"
BATCH_JOBS_KEY = "jobs"
BATCH_JOBS_DOC_ID = "batch_jobs"        # ES doc id within CONFIG_INDEX

# Durable operator jobs (server-owned long operations).  The complete registry is
# one strict-CAS document in the existing state-backend KV, so this introduces no
# Elasticsearch index, SQL table, or migration.
JOBS_NS = "jobs"
JOBS_KEY = "jobs"
JOBS_DOC_ID = "jobs"                    # ES doc id within CONFIG_INDEX

# Threshold TUNING state (per-rule tuning suggestions + counters) — the nightly
# auto-tuner's proposed threshold adjustments awaiting apply/shadow-eval.
TUNING_NS = "tuning"
TUNING_KEY = "tuning"
TUNING_DOC_ID = "tuning"                # ES doc id within CONFIG_INDEX

# --------------------------------------------------------------------------- #
# Round 5 KV-store namespace (custom DASHBOARDS). Follows the SAME single-KV-
# document pattern as every namespace above: one JSON document under ``<NS>/<KEY>``
# whose value is ``{"dashboards": {"<user_id>": {"<dash_id>": <DashboardLayout>}}}``
# so it needs NO new ES index / SQL table / migration. Per-user keyed (like the
# INBOX / USER_PREFS namespaces): a user's custom dashboards live under their
# normalised user_id bucket ('default' when auth is OFF). ADVISORY presentation
# state only — never feeds ``case_manager.decide()`` (#3); every dashboard/widget
# name is PLAIN data the UI render-escapes (#9).
# --------------------------------------------------------------------------- #
DASHBOARDS_NS = "dashboards"
DASHBOARDS_KEY = "dashboards"
DASHBOARDS_DOC_ID = "dashboards"        # ES doc id within CONFIG_INDEX

# --------------------------------------------------------------------------- #
# Round 7 KV-store namespace (durable NOISE-REDUCTION counters). Mirrors the same
# single-KV-document pattern as BASELINE_NS above: one JSON document under
# ``<NS>/<KEY>`` (the ES backend stores it in CONFIG_INDEX, the SQL backend in the
# shared KV table) so it needs NO new ES index / SQL table / migration. Holds the
# durable raw-alert-by-severity ingest counters ("total alerts by severity → what
# the AI reduced it to") that back the Noise-Reduction funnel. Counters are advisory
# presentation state only — they NEVER feed ``case_manager.decide()`` (#3) and the
# increments are fail-open so they never slow or break the poll/ingest path.
# --------------------------------------------------------------------------- #
NOISE_NS = "noise_counters"
NOISE_KEY = "noise_counters"
NOISE_DOC_ID = "noise_counters"         # ES doc id within CONFIG_INDEX

# --------------------------------------------------------------------------- #
# Operator-added CUSTOM MODELS (self-hosted / LiteLLM / vLLM / Ollama — any
# OpenAI-compatible endpoint) registered at RUNTIME from the UI, so a local model
# can be added with no rebuild. Same single-KV-document pattern as PRICE_OVERLAY_NS
# above: one JSON document under ``<NS>/<KEY>`` (the ES backend stores it in
# CONFIG_INDEX, the SQL backend in the shared KV table) so it needs NO new ES index /
# SQL table / migration. The value is ``{"models": {"<id>": {label, base_url,
# provider, context_window, input_per_million, output_per_million}}}`` — all
# NON-SECRET config data the UI render-escapes (#9/#10); the optional endpoint API
# key lives in the SECRET tier (``Secrets.litellm_api_key``), NEVER here. Advisory to
# the model catalog + the LLM cost LEDGER only — it NEVER feeds
# ``case_manager.decide()`` (#3).
# --------------------------------------------------------------------------- #
CUSTOM_MODELS_NS = "custom_models"
CUSTOM_MODELS_KEY = "models"
CUSTOM_MODELS_DOC_ID = "custom_models"  # ES doc id within CONFIG_INDEX


class Verdict(str, Enum):
    """LLM-produced verdict (Section 7.1). The verdict is a *recommendation*."""

    FALSE_POSITIVE = "FALSE_POSITIVE"
    TRUE_POSITIVE = "TRUE_POSITIVE"
    NEEDS_HUMAN = "NEEDS_HUMAN"


class CaseStatus(str, Enum):
    """Lifecycle of a case (Section 7.1). DECISION is deterministic code.

    Two-axis model (see docs/research/.../STATUS_TAXONOMY.md): this is the
    LIFECYCLE axis; the investigative outcome is the separate :class:`Disposition`.
    The three ORIGINAL string values (``open``/``needs_human``/``closed``) are kept
    BYTE-FOR-BYTE so stored cases load unchanged and ``decide()`` (#3) is untouched;
    the richer states below are ADDED additively and reached via analyst lifecycle
    actions + the existing ``escalate`` flag — never by rewriting the deterministic
    decision. ``NEEDS_HUMAN`` is a RETAINED, deprecated alias of "open · awaiting
    analyst" (the UI renders it that way)."""

    NEW = "new"                    # created, not yet investigated (candidate / pre-LLM)
    OPEN = "open"                  # retained — investigated, awaiting analyst
    NEEDS_HUMAN = "needs_human"    # retained alias of "open · awaiting analyst" (decide() still uses it)
    INVESTIGATING = "investigating"  # an analyst / re-investigation is actively working it
    ESCALATED = "escalated"        # marked for analyst escalation; never a displayed tier
    ON_HOLD = "on_hold"            # paused (awaiting info / maintenance / third party)
    RESOLVED = "resolved"          # worked to completion, pending final close / audit
    CLOSED = "closed"              # retained — terminal


# Lifecycle statuses that count as STILL OPEN for the case-signature idempotency
# lookup (Non-negotiable #4 / find_open_by_signature). Any non-terminal status must
# attach to its existing case rather than spawn a duplicate; only RESOLVED + CLOSED
# are terminal. This is the single source of truth for "is this case still live?",
# used by BOTH the ES and SQL case stores so the F8 statuses don't break dedupe.
OPEN_CASE_STATUSES: tuple[str, ...] = (
    CaseStatus.NEW.value,
    CaseStatus.OPEN.value,
    CaseStatus.NEEDS_HUMAN.value,
    CaseStatus.INVESTIGATING.value,
    CaseStatus.ESCALATED.value,
    CaseStatus.ON_HOLD.value,
)
# Terminal statuses (a case here is DONE; a new occurrence opens a fresh case).
TERMINAL_CASE_STATUSES: tuple[str, ...] = (
    CaseStatus.RESOLVED.value,
    CaseStatus.CLOSED.value,
)


class Disposition(str, Enum):
    """Investigative OUTCOME (verdict-class) axis — the analyst-confirmable,
    reportable classification on/after close. Orthogonal to :class:`CaseStatus`
    (lifecycle). Defaulted to ``None`` on the Case so old stored cases load
    unchanged; the LLM ``Verdict`` is unchanged and still feeds ``decide()``."""

    TRUE_POSITIVE = "true_positive"
    FALSE_POSITIVE = "false_positive"
    BENIGN = "benign"
    SUSPICIOUS = "suspicious"
    DUPLICATE = "duplicate"
    UNDETERMINED = "undetermined"


class FeedbackOutcome(str, Enum):
    """Human-confirmed outcome accepted by the analyst feedback endpoint.

    This is deliberately broader than :class:`Disposition`: evaluation can record a
    true/false negative even when that classification is not a live case disposition.
    Keeping the vocabulary here makes the HTTP contract explicit and prevents arbitrary
    strings from silently becoming tuner ground truth.
    """

    TRUE_POSITIVE = "true_positive"
    FALSE_POSITIVE = "false_positive"
    TRUE_NEGATIVE = "true_negative"
    FALSE_NEGATIVE = "false_negative"
    UNKNOWN = "unknown"


class SourceSurface(str, Enum):
    """Where a case originated (Section 7.1)."""

    INVESTIGATE = "investigate"
    AUTOMATED_SCAN = "automated_scan"
    CHAT = "chat"


class DecisionBy(str, Enum):
    AGENT = "agent"          # FP auto-close only, under strict conditions
    ANALYST = "analyst"      # human action
    SYSTEM = "system"        # deterministic routing (e.g. fail-to-human)
    # An operator's explicit, audited, revocable per-rule declaration ("this detection
    # is benign in my estate"), applied deterministically with NO LLM call. It is
    # deliberately its OWN owner rather than a flavour of the three above:
    #   * not ``agent``   — no model produced it, so it must never count as agent
    #                       performance (automation rate, auto-close health, noise
    #                       funnel, agent-improvement evidence);
    #   * not ``analyst`` — ``engine.analyst_outcomes.analyst_confirmed_outcome`` would
    #                       then read it as INDEPENDENT ground truth and the tuner and
    #                       precedent corpus would train on the automation's own output;
    #   * not ``system``  — it is an operator decision, not deterministic routing.
    ANALYST_POLICY = "analyst_policy"


class Role(str, Enum):
    """The four model roles (Section 6.4). Every LLM call is tagged with one."""

    ROUTER = "router"
    INVESTIGATOR = "investigator"
    FORMATTER = "formatter"
    STANDUP = "standup"
    CHAT = "chat"            # the shared chat engine (Surface 1/2 follow-up)
    OVERVIEW = "overview"    # single-event AI overview (Feature 2)
    EMBEDDING = "embedding"  # embedding calls also pass through the gateway


# Roles whose usage belongs to the deterministic case-investigation pipeline.
# Case.token_cost historically represents these calls only; case-scoped Chat and
# overview rows remain visible in the global ledger but must not inflate it.
CASE_PIPELINE_USAGE_ROLES: tuple[str, ...] = (
    Role.ROUTER.value,
    Role.INVESTIGATOR.value,
    Role.FORMATTER.value,
)


class ActionType(str, Enum):
    """Audit action types (Section 7.2)."""

    PROMPT = "prompt"
    ES_QUERY = "es_query"
    TOOL_CALL = "tool_call"
    VERDICT = "verdict"
    DECISION = "decision"
    ERROR = "error"
    POLL = "poll"
    SCAN = "scan"
    FEEDBACK = "feedback"      # analyst graded an AI verdict (eval loop)
    COLLAB = "collab"          # analyst comment / tag / assignment
    STATUS = "status"          # analyst case-lifecycle transition (hold/resume/resolve/escalate/set_disposition/...)
    CONTEXT = "context"        # the injected investigation context (RAG/memory/enrichment) — explainability
    PROPOSAL = "proposal"      # agent drafted / human approved-rejected a HITL proposal
    AUTOMATION = "automation"  # a post-decision threshold-automation action (tag/recommend/notify/run_playbook/request_approval) — NEVER sets status (#3)
    PLAYBOOK = "playbook"        # operator-authored Markdown playbook create/update/reload (recommendation context only, #3)
    RUNBOOK = "runbook"          # operator-authored RAG runbook knowledge create/update/delete (#3-safe)
    NOTIFICATION = "notification"  # an outbound notification send attempt (email/slack/teams/webhook/...)
    USER_MGMT = "user_mgmt"        # user-management action (create/update/delete/role/password reset)
    AUTH_EVENT = "auth"            # login success/failure, logout, password change (auth events)
    ACCESS_DENIED = "access_denied"  # an authenticated caller was denied by the RBAC policy
    # --- Round 3 collaboration / notifications (additive; all ADVISORY audit rows —
    # none of these ever feeds the deterministic case decision, #3). ---
    THREAD_POST = "thread_post"    # a human/ai message posted to a case thread (collaboration)
    REACTION = "reaction"          # a reaction added/removed on a case message
    TASK_UPDATE = "task_update"    # a case task created / reassigned / status-changed
    INAPP_NOTIFY = "inapp_notify"  # an in-app notification delivered to a user inbox
    # --- Round 4 (additive; both ADVISORY audit rows — neither ever feeds the
    # deterministic case decision, #3). ---
    TUNING = "tuning"              # a threshold-tuning suggestion applied / shadow-evaluated
    RESET = "reset"                # an operator reset of cases/sources/factory state
    DATA_EXPORT = "data_export"    # privileged, secret-free portable application-state export
    JOB = "job"                    # durable operator-job lifecycle transition
    SYSTEM_UPDATE = "system_update"  # operator-authorized supervised app update / rollback


class UserRole(str, Enum):
    """SOC operator roles for multi-user RBAC (Wave 1). Distinct from the LLM
    :class:`Role` (model roles). The permission matrix that maps each role to
    ``resource:action`` grants lives in ``app/rbac/policy.py`` (DEFAULT_MATRIX),
    and is operator-overridable via ``Preferences.rbac.roles``."""

    SUPER_ADMIN = "super_admin"
    SOC_MANAGER = "soc_manager"
    ANALYST_TIER2 = "analyst_tier2"
    ANALYST_TIER1 = "analyst_tier1"
    RESPONDER = "responder"
    AUDITOR = "auditor"


class ToolTier(str, Enum):
    """Capability tier for a tool — a declarative authorisation firewall, ported
    from Vigil's safe/managed/requires_approval/forbidden model and generalising
    non-negotiable #3 (a TRUE_POSITIVE is never auto-closed; irreversible actions
    need a human).

    Today every Agentic SOC tool is ``SAFE`` (read-only logs / cached enrichment / RAG),
    but this tier travels with the tool definition so the moment a write/response
    tool is added the investigator can gate it WITHOUT touching agent logic:

    * ``SAFE``              — read-only; an autonomous agent may call freely.
    * ``MANAGED``          — mutates our OWN state (e.g. annotate a case); allowed
                              autonomously but always audited.
    * ``REQUIRES_APPROVAL`` — an outward/irreversible action (isolate host, block
                              IP, disable user); the agent may only PROPOSE it — a
                              human approves before it executes.
    * ``FORBIDDEN``        — never permitted to an autonomous agent (e.g. close a
                              case, approve an action) — hard-blocked in code.
    """

    SAFE = "safe"
    MANAGED = "managed"
    REQUIRES_APPROVAL = "requires_approval"
    FORBIDDEN = "forbidden"


class CorrelationMode(str, Enum):
    """Per-rule correlation mode (Section 6.2)."""

    EVERY = "every"          # investigate every occurrence (N=1 rare/high-sev)
    THRESHOLD = "threshold"  # investigate when >= N within window, grouped
    NEVER = "never"          # manual only


class EntityType(str, Enum):
    IP = "ip"
    USER = "user"
    HOST = "host"
    # Richer cross-source correlation keys (Wave 5 / F6). These are ADDITIVE: the
    # per-source auto/IP/HOST/USER/RULE fallback ladder is unchanged (RULE is still
    # the always-resolvable terminal fallback). FILE_HASH/DOMAIN are NOT part of the
    # per-rule grouping ladder — they are extra entity keys the OPT-IN cross-source
    # pass may group on (engine/correlation.cross_source_correlate).
    FILE_HASH = "file_hash"
    DOMAIN = "domain"
    # Fallback grouping key when an event carries no IP/USER/HOST (entity-agnostic
    # correlation). A RULE-grouped cluster keys on the rule name + a coarse time
    # bucket so an in-scope event is NEVER silently dropped just because every
    # standard entity field is null (see engine/correlation.resolve_entity).
    RULE = "rule"


# Indicator kind for ENRICHMENT (Round 3 multi-provider threat-intel). Distinct
# from :class:`EntityType` (correlation grouping keys): EntityType drives how events
# CLUSTER; IndicatorKind classifies a single observable so the right enrichment
# providers are queried (an IP → GreyNoise/Shodan/AbuseIPDB; a file hash →
# VirusTotal/MalwareBazaar/ThreatFox; a domain → URLhaus/RDAP; …). The overlapping
# members (IP/DOMAIN/FILE_HASH/HOST) intentionally MIRROR EntityType so a correlation
# entity maps cleanly onto an enrichment indicator; URL + EMAIL are enrichment-only.
class IndicatorKind(str, Enum):
    IP = "ip"
    DOMAIN = "domain"
    URL = "url"
    FILE_HASH = "file_hash"
    EMAIL = "email"
    HOST = "host"


# Author of a collaboration message / activity event (Round 3 case threads). Keeps
# the human vs AI vs system distinction the UI badges and the audit trail records.
class AuthorType(str, Enum):
    HUMAN = "human"
    AI = "ai"
    SYSTEM = "system"


# In-app notification category (Round 3 inbox). Each notification is filed under one
# category so the inbox + per-user NotificationPref can filter/route per category.
class NotificationCategory(str, Enum):
    CASE_NEW = "case_new"
    CASE_ESCALATED = "case_escalated"
    CASE_RESOLVED = "case_resolved"
    MENTION = "mention"
    ASSIGNMENT = "assignment"
    APPROVAL = "approval"
    SYSTEM = "system"
    DIGEST = "digest"


# Visual "material" / density mode for the themed UI shell (Round 3 theming). The
# branding default theme + per-user theme select between a calm ``quiet`` surface and
# a high-contrast ``command`` (command-center) surface. Carried as plain config data.
class Material(str, Enum):
    QUIET = "quiet"
    COMMAND = "command"


# Lifecycle of a cross-case CAMPAIGN (Round 4 campaign clustering). A campaign groups
# related cases (shared entities / MITRE) into a running incident: ``open`` while
# active, ``monitoring`` once contained but still watched, ``resolved`` when closed.
# Carried as plain data; ADVISORY — never feeds the deterministic case decision (#3).
class CampaignStatus(str, Enum):
    OPEN = "open"
    MONITORING = "monitoring"
    RESOLVED = "resolved"


# State of an async BATCH-inference job (Round 4 batch LLM). A job is ``submitted`` to
# a provider batch API, then ``polling`` for completion, ``retrieving``/``retrieved``
# as results come back, ``errored`` on provider failure, or ``expired`` past its TTL.
class BatchJobState(str, Enum):
    SUBMITTED = "submitted"
    POLLING = "polling"
    RETRIEVING = "retrieving"
    RETRIEVED = "retrieved"
    ERRORED = "errored"
    EXPIRED = "expired"


class JobKind(str, Enum):
    """Registered server-owned long-operation kinds."""

    CASE_REINVESTIGATE = "case_reinvestigate"
    CASE_LIFECYCLE = "case_lifecycle"
    CASE_ASSIGN = "case_assign"
    CASE_TAG = "case_tag"
    DATA_EXPORT_ARCHIVE = "data_export_archive"
    DATA_EXPORT_SEGMENT = "data_export_segment"
    PRECEDENT_BOOTSTRAP = "precedent_bootstrap"
    RUNBOOK_REINDEX = "runbook_reindex"
    RAG_IMPORT = "rag_import"
    TIERED_RESET = "tiered_reset"
    STORAGE_LIFECYCLE_APPLY = "storage_lifecycle_apply"


class JobStatus(str, Enum):
    """Durable lifecycle of a server-owned operator job."""

    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    PARTIAL = "partial"
    FAILED = "failed"
    CANCELLED = "cancelled"


# How a candidate case was surfaced for triage (Round 4 detection sources). ``detection``
# is a signature/correlation match; ``anomaly`` is a statistical baseline deviation;
# ``rule`` is an explicit operator rule. ADVISORY provenance only — never feeds #3.
class DetectionSource(str, Enum):
    DETECTION = "detection"
    ANOMALY = "anomaly"
    RULE = "rule"


# Scope of an operator RESET action (Round 4). ``cases`` clears the case store only;
# ``sources`` clears configured sources/feeds; ``factory`` is a full reset to defaults.
# Carried as plain data; the action itself is audited (:attr:`ActionType.RESET`).
class ResetScope(str, Enum):
    CASES = "cases"
    SOURCES = "sources"
    FACTORY = "factory"


# Per-source entity-resolution strategy for correlation (Preferences.entity_strategy
# default + SourceInstance.config["entity_strategy"] override). ``auto`` tries
# IP → HOST → USER → RULE so a case always forms; the others pin one entity (with
# RULE as the always-present fallback so an event is never dropped).
class EntityStrategy(str, Enum):
    AUTO = "auto"
    IP = "ip"
    HOST = "host"
    USER = "user"
    RULE = "rule"


# Role a configured index pattern / feed plays for a source (multi-feed sources).
# ``events`` patterns keep the correlate→auto-forward-allowlist behaviour;
# ``alerts`` patterns are SIEM-generated detections every one of which the operator
# wants triaged, so alerts-role clusters are AUTO-FORWARDED (bypass the allowlist).
# ``ignore`` patterns are dropped entirely at ingest (a per-feed mute) — they are the
# ONLY role that skips ingest; a below-severity_floor event on an events/alerts feed is
# never dropped (it still registers a candidate + live-tail, just not auto-forwarded).
class IndexRole(str, Enum):
    EVENTS = "events"
    ALERTS = "alerts"
    IGNORE = "ignore"


class UsageOutcome(str, Enum):
    OK = "ok"
    ERROR = "error"
    CAPPED = "capped"


# Router triage buckets (Section 6.3). Only UNCERTAIN/SERIOUS reach the
# expensive investigator.
class TriageBucket(str, Enum):
    BENIGN = "obviously_benign"
    SERIOUS = "needs_strong_model"
    UNCERTAIN = "uncertain"


# The strict verdict JSON schema keys (Section 8.2). The formatter must emit
# exactly these.
VERDICT_KEYS = (
    "verdict",
    "confidence",
    "evidence",
    "mitre",
    "recommended_action",
    "reproduce_query",
)

# Prompt-injection seam (Section 3.3 / 11.9): every log-derived value placed in
# a prompt is wrapped in these labelled, delimited fences so a later hardening
# pass can treat fenced content as untrusted DATA without restructuring.
UNTRUSTED_OPEN = "<<<UNTRUSTED_LOG_DATA>>>"
UNTRUSTED_CLOSE = "<<<END_UNTRUSTED_LOG_DATA>>>"


# --------------------------------------------------------------------------- #
# Vendor-agnostic ingestion (AGNOSTIC_ARCHITECTURE.md).
#
# A "source" is any system we read security events from. Every connector
# normalises its native records into OCSF (the canonical internal schema) before
# the engine ever sees them. ``SourceType`` enumerates the connectors we know
# how to build; ``IngestMode`` enumerates HOW data physically reaches us. A
# single source may support several modes (e.g. Elasticsearch is PULL; Wazuh is
# PULL via its indexer AND PUSH via integratord).
# --------------------------------------------------------------------------- #
class SourceType(str, Enum):
    # Pull-based SIEM / log stores
    ELASTICSEARCH = "elasticsearch"
    OPENSEARCH = "opensearch"
    SPLUNK = "splunk"
    SENTINEL = "sentinel"
    QRADAR = "qradar"
    CHRONICLE = "chronicle"
    # EDR / XDR
    CROWDSTRIKE = "crowdstrike"
    SENTINELONE = "sentinelone"
    DEFENDER = "defender"
    WAZUH = "wazuh"
    # Generic transports / receivers (push, queues, object stores)
    WEBHOOK = "webhook"            # generic HTTP(S) JSON/NDJSON/CEF/LEEF push
    HEC = "hec"                    # Splunk HEC-compatible receiver
    SYSLOG = "syslog"             # RFC 3164 / 5424 over UDP/TCP/TLS
    BEATS = "beats"               # Elastic Lumberjack (Filebeat/Winlogbeat)
    FLUENTD = "fluentd"           # Fluentd/Fluent Bit forward protocol
    OTLP = "otlp"                 # OpenTelemetry logs (gRPC/HTTP)
    KAFKA = "kafka"               # Kafka / Redpanda / Confluent
    PULSAR = "pulsar"
    RABBITMQ = "rabbitmq"
    NATS = "nats"
    MQTT = "mqtt"
    REDIS_STREAMS = "redis_streams"
    AWS_SQS = "aws_sqs"
    AWS_KINESIS = "aws_kinesis"
    AZURE_EVENT_HUB = "azure_event_hub"
    GCP_PUBSUB = "gcp_pubsub"
    S3 = "s3"                      # S3 / Security Lake (OCSF Parquet), object store
    GCS = "gcs"
    AZURE_BLOB = "azure_blob"
    FILE = "file"                  # local file / directory tail
    GENERIC = "generic"


class IngestMode(str, Enum):
    """How events physically arrive. Drives the connector driver the engine uses."""

    PULL = "pull"                  # we poll a search/query API on a durable cursor
    PUSH_HTTP = "push_http"        # we run an HTTP listener; the source POSTs to us
    PUSH_SYSLOG = "push_syslog"    # we run a syslog listener (UDP/TCP/TLS)
    PUSH_SOCKET = "push_socket"    # raw TCP/UDP/gRPC line/stream listener
    QUEUE = "queue"                # we consume a broker (Kafka/SQS/PubSub/...): durable offsets
    OBJECT_STORE = "object_store"  # we list+get objects (S3/GCS/Blob), cursor = key/marker
    STREAM = "stream"              # long-lived provider stream (e.g. CrowdStrike Event Streams)


# Cursor shapes a connector may use to read incrementally without skip/dup.
class CursorKind(str, Enum):
    TIMESTAMP = "timestamp"        # watermark + tiebreaker id (the suite default)
    TOKEN = "token"                # opaque continuation token (session-scoped)
    OFFSET = "offset"              # durable broker/partition offset
    OBJECT_KEY = "object_key"      # last processed object key/marker


# --------------------------------------------------------------------------- #
# OCSF (Open Cybersecurity Schema Framework) — the canonical internal schema.
# We pin a version and store it on every event (classes are renumbered across
# minor versions). Only the small, high-traffic subset of categories/classes the
# triage engine reasons over is enumerated here; the full taxonomy lives in OCSF.
# --------------------------------------------------------------------------- #
OCSF_VERSION = "1.4.0"

# Categories (category_uid)
OCSF_CAT_SYSTEM = 1
OCSF_CAT_FINDINGS = 2
OCSF_CAT_IAM = 3
OCSF_CAT_NETWORK = 4
OCSF_CAT_DISCOVERY = 5
OCSF_CAT_APPLICATION = 6

# Classes (class_uid) — the ones connectors map into most often.
OCSF_CLASS_FILE_ACTIVITY = 1001
OCSF_CLASS_PROCESS_ACTIVITY = 1007
OCSF_CLASS_AUTHENTICATION = 3002
OCSF_CLASS_NETWORK_ACTIVITY = 4001
OCSF_CLASS_HTTP_ACTIVITY = 4002
OCSF_CLASS_SECURITY_FINDING = 2001
OCSF_CLASS_DETECTION_FINDING = 2004
OCSF_CLASS_BASE_EVENT = 0          # fallback when the source class is unknown

# severity_id (OCSF standard 0..6) → a 0..100 score the risk engine uses.
OCSF_SEVERITY_TO_SCORE = {0: 0.0, 1: 10.0, 2: 30.0, 3: 50.0, 4: 75.0, 5: 90.0, 6: 100.0}

# Canonical 5-band SEVERITY ladder (highest → lowest). Names ONLY — the numeric
# cut-points that map a 0..100 magnitude onto these bands live in
# ``engine/priority.py`` (the single source of truth for the 74/48/22/8 cuts), NOT
# here, so there is exactly one place to tune them. Used as the shared band vocabulary
# for the advisory severity axis + the Noise-Reduction funnel's per-band buckets.
SEVERITY_BANDS = ("critical", "high", "medium", "low", "info")
