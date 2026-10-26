"""Pydantic models: the Section 7 data contracts plus internal pipeline types.

The three persisted contracts (``Case``, ``AuditDoc``, ``UsageDoc``) map field-for-
field to Section 7. Internal types (``RawEvent``, ``Cluster``, ``VerdictResult``,
``EnrichmentResult``, ``RagChunk``) describe data flowing through the engine.
"""

from __future__ import annotations

import base64
import binascii
import ipaddress
import json
import math
import re
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Annotated, Any, ClassVar, Iterable, Literal, NamedTuple, get_args
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_serializer, model_validator
from typing_extensions import TypedDict

# The answer-block contract module depends only on constants + pydantic (never on
# this module), so importing its sanitiser/validators here cannot form a cycle.
from .agents.blocks import (
    BLOCK_ID_PATTERN,
    BLOCKS_VERSION,
    CASE_ID_PATTERN,
    DOC_REF_PATTERN,
    MAX_SECTION_BLOCKS,
    PAGE_PATTERN,
    TECHNIQUE_PATTERN,
    clean_nav_opts,
    display_text,
    parse_persisted_blocks,
    parse_timestamp,
    strip_lone_surrogates,
)
from .config import Preferences

if TYPE_CHECKING:  # avoid an import cycle (ocsf imports config/constants, not models)
    from .ocsf import OCSFEvent
from .constants import (
    INVISIBLE_TEXT_CLASS,
    MAX_REPORT_ITEMS,
    MAX_REPORT_NEXT_STEPS,
    MAX_REPORT_NOTE_CHARS,
    MAX_REPORT_SUMMARY_CHARS,
    MAX_REPORT_TITLE_CHARS,
    ActionType,
    BatchJobState,
    CampaignStatus,
    CaseStatus,
    DecisionBy,
    Disposition,
    EntityType,
    JobKind,
    JobStatus,
    SourceSurface,
    UsageOutcome,
    UserRole,
    Verdict,
)
from .utils import coerce_float, dotted_get, iso_now, new_id, parse_es_timestamp, to_millis


# --------------------------------------------------------------------------- #
# Entities and events
# --------------------------------------------------------------------------- #
_CURSOR_KEY_SEPARATOR = "\x1f"


def make_cursor_event_key(index: str, event_id: str) -> str:
    """Return an opaque cursor identity, qualified by the originating index."""
    index = str(index or "")
    event_id = str(event_id or "")
    return f"{index}{_CURSOR_KEY_SEPARATOR}{event_id}" if index else event_id


def split_cursor_event_key(value: str) -> tuple[str | None, str]:
    """Decode a cursor key; bare ids are legacy cursor entries."""
    value = str(value or "")
    if _CURSOR_KEY_SEPARATOR not in value:
        return None, value
    index, event_id = value.split(_CURSOR_KEY_SEPARATOR, 1)
    return index, event_id


class Entity(BaseModel):
    type: EntityType
    value: str

    def key(self) -> str:
        return f"{self.type.value}:{self.value}"


class RawEvent(BaseModel):
    """A normalised view over one Elasticsearch hit from the log surface.

    Extraction uses the configurable field mapping (Section 5.3) so we never
    hardcode assumptions about the upstream ECS schema.
    """

    id: str
    index: str = ""
    source: dict[str, Any] = Field(default_factory=dict)

    # Extracted, config-driven projections (populated by ``from_hit``).
    timestamp_millis: int = 0
    ip: str | None = None
    user: str | None = None
    host: str | None = None
    rule: str | None = None
    rule_name: str | None = None
    severity: float = 0.0
    # Multi-pattern provenance (entity-agnostic + per-pattern role). ``index_role``
    # is the role of the configured pattern this event came from ("events" default,
    # "alerts" for SIEM-generated detections that auto-forward). ``source_id`` records
    # which configured source emitted it. Both default to back-compat values.
    index_role: str = "events"
    source_id: str | None = None
    source_name: str | None = None
    # Per-FEED provenance (Wave 6 — multi-feed sources). ``feed_id`` is the id of the
    # configured feed this event was read from (blank for legacy/un-fed sources).
    # ``auto_investigate_eligible`` is FALSE when the event is below its feed's
    # ``severity_floor``: such an event is STILL correlated + live-tailed (NEVER
    # dropped, #4) but its cluster is NOT auto-forwarded. Defaults preserve today's
    # behaviour byte-for-byte (every event eligible, no feed).
    feed_id: str = ""
    auto_investigate_eligible: bool = True

    def cursor_key(self) -> str:
        """Stable, source-index-qualified identity for pull bookkeeping.

        Elasticsearch ``_id`` values are unique only within an index.  A data-view
        can span many rollover indices, so a bare ``_id`` cannot safely drive cursor
        or in-process deduplication. The source-native ``id`` remains available for
        display and ``ids`` queries; this opaque identity is persisted separately.
        """
        return make_cursor_event_key(self.index, self.id)

    def event_key(self) -> str:
        """Canonical event identity used for deduplication and case membership."""
        return self.cursor_key()

    @classmethod
    def from_hit(cls, hit: dict[str, Any], prefs: Preferences) -> "RawEvent":
        src = hit.get("_source", {}) or {}
        ts = parse_es_timestamp(dotted_get(src, prefs.time_field))
        # Rule identity (C3-1): when the rule catalog is non-empty, classify via
        # ``prefs.match_rule`` (so ModSec events resolve to their XSS/SQLi/...
        # sub-rule); on no catalog match, fall back to today's single-field value.
        # When the catalog is EMPTY this is byte-identical to the original
        # single-``rule_field`` derivation (critical backward compat).
        fallback_rule = _as_str(dotted_get(src, prefs.rule_field))
        if prefs.rule_catalog:
            matched = prefs.match_rule(src)
            rule = matched.name if matched is not None else fallback_rule
        else:
            rule = fallback_rule
        ev = cls(
            id=str(hit.get("_id", "")),
            index=str(hit.get("_index", "")),
            source=src,
            timestamp_millis=to_millis(ts) if ts else 0,
            ip=_as_str(dotted_get(src, prefs.source_ip_field)),
            user=_as_str(dotted_get(src, prefs.user_field)),
            host=_as_str(dotted_get(src, prefs.host_field)),
            rule=rule,
            rule_name=_as_str(dotted_get(src, prefs.rule_name_field)),
            severity=coerce_float(dotted_get(src, prefs.severity_field), 0.0),
        )
        return ev

    @classmethod
    def from_ocsf(cls, ev: "OCSFEvent") -> "RawEvent":
        """Project a canonical OCSF event onto the engine's ``RawEvent``.

        This is the source-agnostic counterpart to ``from_hit``: any connector
        normalises to OCSF, and the engine consumes the projection. ``source`` is
        the event's original record (``raw_data``) so existing downstream readers
        keep working for ECS-shaped sources; ``ocsf`` carries the full normalised
        event for source-agnostic consumers. No ``prefs`` needed — OCSF is already
        normalised.
        """
        src = dict(ev.raw_data) if ev.raw_data else ev.model_dump(mode="json")
        return cls(
            id=ev.event_id,
            index=ev.metadata.source_type or "",
            source=src,
            timestamp_millis=ev.time,
            ip=ev.ip,
            user=ev.user,
            host=ev.host,
            rule=ev.rule_uid,
            rule_name=ev.finding_title,
            severity=ev.severity_score,
        )

    # Coarse time bucket (seconds) used when grouping by RULE so a rule-grouped
    # cluster is still time-bounded (a case forms per rule per bucket). 5 minutes.
    RULE_BUCKET_SECONDS: ClassVar[int] = 300

    def entity_value(self, group_by: EntityType) -> str | None:
        """The grouping value for ``group_by`` (None when this event lacks it).

        For IP/USER/HOST this is the extracted field. For RULE (the entity-agnostic
        fallback) it is ``"<rule>|<time-bucket>"`` so events of the same rule within
        the same coarse window cluster together, but distant bursts do not merge —
        guaranteeing a case forms even when every standard entity field is null.

        FILE_HASH/DOMAIN (Wave 5 cross-source keys) are NOT used by per-rule grouping,
        so they are resolved from the raw ``source`` document by
        :meth:`cross_source_value` (used only by the opt-in cross-source pass)."""
        if group_by == EntityType.RULE:
            rule = self.rule or self.rule_name
            if not rule:
                return None
            bucket = self.timestamp_millis // (self.RULE_BUCKET_SECONDS * 1000)
            return f"{rule}|{bucket}"
        if group_by in (EntityType.FILE_HASH, EntityType.DOMAIN):
            return self.cross_source_value(group_by)
        return {
            EntityType.IP: self.ip,
            EntityType.USER: self.user,
            EntityType.HOST: self.host,
        }[group_by]

    # Common dotted paths a file hash / domain is found under across sources (ECS +
    # OCSF + a few SIEM-native shapes). The cross-source pass reads the FIRST present.
    _FILE_HASH_FIELDS: ClassVar[tuple[str, ...]] = (
        "file.hash.sha256", "file.hash.sha1", "file.hash.md5",
        "process.hash.sha256", "hash.sha256", "sha256", "data.sha256",
    )
    _DOMAIN_FIELDS: ClassVar[tuple[str, ...]] = (
        "url.domain", "destination.domain", "dns.question.name",
        "domain", "data.domain", "host.domain",
    )

    def cross_source_value(self, entity_type: EntityType) -> str | None:
        """Resolve one cross-source entity key (IP/HOST/USER/FILE_HASH/DOMAIN) for
        this event — the SOURCE-AGNOSTIC value the cross-source pass groups on.

        IP/HOST/USER reuse the already-extracted projections; FILE_HASH/DOMAIN are
        pulled from the raw ``source`` document via a small list of common dotted
        paths (ECS/OCSF/SIEM). Returns ``None`` when absent — a missing key simply
        does not participate in cross-source grouping (never raises)."""
        if entity_type == EntityType.IP:
            return self.ip
        if entity_type == EntityType.HOST:
            return self.host
        if entity_type == EntityType.USER:
            return self.user
        fields = (
            self._FILE_HASH_FIELDS if entity_type == EntityType.FILE_HASH
            else self._DOMAIN_FIELDS if entity_type == EntityType.DOMAIN
            else ()
        )
        for f in fields:
            val = _as_str(dotted_get(self.source or {}, f))
            if val:
                return val.lower() if entity_type == EntityType.FILE_HASH else val
        return None


def _as_str(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, list):
        value = value[0] if value else None
    if value is None:
        return None
    return str(value)


# --------------------------------------------------------------------------- #
# Correlation / risk
# --------------------------------------------------------------------------- #
class RiskBreakdown(BaseModel):
    volume: float = 0.0
    velocity: float = 0.0
    reputation: float = 0.0
    diversity: float = 0.0
    asset_criticality: float = 0.0
    total: float = 0.0


class TriggerReason(BaseModel):
    """Deterministic explanation of WHY a cluster was triggered (Feature 3).

    Computed in code by correlation, copied onto the Case, and surfaced in the UI
    ("Why this fired"). Records the PRIMARY triggering rule for a multi-rule entity.
    """

    rule_value: str = ""
    mode: str = ""                       # CorrelationMode value
    n: int = 0
    window_seconds: int = 0
    group_by: str = ""                   # EntityType value
    observed_count: int = 0
    window_start: int = 0                # epoch millis of the matched window
    window_end: int = 0
    entity: str = ""
    rule_values: list[str] = Field(default_factory=list)
    severity_min: float | None = None
    severity_max: float | None = None
    sentence: str = ""                   # human-readable one-liner


class Cluster(BaseModel):
    """A correlated group of events forming one candidate investigation."""

    signature: str
    entity: Entity
    group_by: EntityType
    rule_values: list[str] = Field(default_factory=list)
    member_event_ids: list[str] = Field(default_factory=list)
    # Source-index-qualified identities. ``member_event_ids`` stays as the native
    # id list for backwards-compatible queries/UI; keys own dedup/count semantics.
    member_event_keys: list[str] = Field(default_factory=list)
    member_events: list[RawEvent] = Field(default_factory=list)
    first_seen_millis: int = 0
    last_seen_millis: int = 0
    count: int = 0
    risk_score: float = 0.0
    risk_breakdown: RiskBreakdown = Field(default_factory=RiskBreakdown)
    trigger_reason: TriggerReason | None = None
    # Source provenance (multi-source UI filter + per-source behaviour). Derived
    # from the cluster's member events; default None preserves prior behaviour.
    source_id: str | None = None
    source_name: str | None = None
    # Entity-only signature used by pre-source-scoping releases. It is retained for
    # one-way, in-place migration of an already-open legacy case.
    legacy_signature: str | None = None
    # True when ANY member event came from an ``alerts``-role index pattern: such
    # clusters are SIEM-generated detections and are auto-forwarded to investigation
    # regardless of the auto-forward allowlist (see engine/ingest.handle_clusters).
    is_alert: bool = False
    # Per-feed severity_floor gate (Wave 6, #4). FALSE only when EVERY member event is
    # below its feed's ``severity_floor`` — the cluster is then registered as a
    # candidate + live-tailed but NOT auto-forwarded (never dropped). TRUE (the
    # default) when ANY member is at/above its floor (or no floor is set), preserving
    # today's behaviour byte-for-byte. ``feed_ids`` records the distinct feeds that
    # contributed members (multi-feed provenance; usually 0/1).
    auto_investigate_eligible: bool = True
    feed_ids: list[str] = Field(default_factory=list)
    # Cross-source provenance (Wave 5 / F6 — multi-source telemetry). ``source_ids``
    # is the DISTINCT set of source ids whose member events contributed to this
    # cluster (today a cluster is single-source, so usually a 0/1-length list);
    # ``cross_source_cluster_id`` is set ONLY by the opt-in cross-source correlation
    # pass when this cluster shares an entity with clusters from OTHER sources inside
    # the configured window. Both are ADDITIVE/defaulted — when cross-source is OFF
    # (the default) they stay empty and per-source behaviour is byte-identical.
    source_ids: list[str] = Field(default_factory=list)
    cross_source_cluster_id: str = ""

    @property
    def window_seconds(self) -> float:
        if self.last_seen_millis and self.first_seen_millis:
            return max(0.0, (self.last_seen_millis - self.first_seen_millis) / 1000.0)
        return 0.0

    def contributing_source_ids(self) -> list[str]:
        """The distinct sources whose events are in this cluster, order-stable.

        ``source_ids`` is populated by the cross-source pass and is usually empty on
        a single-source cluster, which still carries a scalar ``source_id``; this
        reconciles both into one list so a caller resolving per-source configuration
        (e.g. ``Preferences.evidence_fields_for``) does not have to know which of the
        two provenance fields a given ingest path happened to fill in.
        """
        out: list[str] = []
        for value in [*self.source_ids, self.source_id]:
            if value and value not in out:
                out.append(value)
        return out

    def primary_rule(self) -> str | None:
        """The rule that best identifies this cluster, for per-rule model selection
        (C3-6b). Prefers the deterministic ``trigger_reason.rule_value`` (the
        PRIMARY triggering rule), else the dominant member-event rule (most
        frequent, ties broken alphabetically), else None."""
        if self.trigger_reason and self.trigger_reason.rule_value:
            return self.trigger_reason.rule_value
        counts: dict[str, int] = {}
        for ev in self.member_events:
            if ev.rule:
                counts[ev.rule] = counts.get(ev.rule, 0) + 1
        if not counts:
            return self.rule_values[0] if self.rule_values else None
        return sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]


# --------------------------------------------------------------------------- #
# Enrichment / RAG
# --------------------------------------------------------------------------- #
class EnrichmentResult(BaseModel):
    ip: str
    reputation_score: float = 0.0   # 0 (clean) .. 100 (malicious)
    is_malicious: bool = False
    country: str | None = None
    sources: dict[str, Any] = Field(default_factory=dict)
    cached: bool = False
    error: str | None = None


class RagChunk(BaseModel):
    text: str
    source: str = "unknown"
    score: float = 0.0
    metadata: dict[str, Any] = Field(default_factory=dict)


class ThreatContextPanel(BaseModel):
    """The assembled, read-only threat-context panel for a case (Wave 6 / F11).

    Every section is ADVISORY and FAIL-OPEN: a missing enrichment / MITRE map /
    related-cases lookup degrades that section to empty rather than erroring the
    whole panel. Nothing here touches the deterministic decision. All free-text
    fields are case/log-derived and are rendered as plain text / code blocks by the
    UI (never trusted as instructions, #9)."""

    case_id: str = ""
    ioc_reputation: list[dict[str, Any]] = Field(default_factory=list)   # [{indicator, type, score, is_malicious, country, sources}]
    mitre_techniques: list[dict[str, Any]] = Field(default_factory=list)  # [{id, name, tactics, platforms, url, description}]
    related_cases: list[dict[str, Any]] = Field(default_factory=list)     # [{case_id, verdict, entity, score, snippet}]
    # Redacted deterministic alert → correlation-cluster → case explanation. Event
    # identities are one-way stable references; no raw source payload is returned.
    clustering: dict[str, Any] = Field(default_factory=dict)
    asset_context: dict[str, Any] = Field(default_factory=dict)           # {entity, criticality, is_internal, networks}
    evidence: list[dict[str, Any]] = Field(default_factory=list)          # [{summary, event_ids, query}]
    generated_at: str = Field(default_factory=iso_now)


# --------------------------------------------------------------------------- #
# Verdict (LLM output schema, Section 8.2)
# --------------------------------------------------------------------------- #
class EvidenceItem(BaseModel):
    summary: str
    event_ids: list[str] = Field(default_factory=list)
    query: str | None = None


class VerdictResult(BaseModel):
    verdict: Verdict = Verdict.NEEDS_HUMAN
    confidence: float = 0.0
    evidence: list[EvidenceItem] = Field(default_factory=list)
    mitre: list[str] = Field(default_factory=list)
    recommended_action: str = ""
    reproduce_query: str = ""


class FeedbackEntry(BaseModel):
    """An analyst's grade of an AI verdict on a case (the eval / quality loop,
    Vigil-inspired). Append-only on the case; aggregated by /api/feedback/stats to
    measure agreement rate, grading quality, outcome mix and time saved."""

    ts: str = Field(default_factory=iso_now)
    analyst: str = ""
    assessment: str = ""                    # agree | partial | disagree
    accuracy: float = 0.0                   # 0..1
    reasoning_quality: float = 0.0          # 0..1
    action_appropriateness: float = 0.0     # 0..1
    actual_outcome: str = ""                # true_positive|false_positive|true_negative|false_negative|unknown
    time_saved_minutes: int = 0
    comment: str = ""
    ai_verdict: str = ""                    # snapshot of the AI verdict that was graded
    ai_confidence: float = 0.0


class CaseComment(BaseModel):
    """An append-only analyst comment on a case (collaboration). ``author``/``body``
    are user input — render-escaped in the UI, never trusted as prompt instructions."""

    ts: str = Field(default_factory=iso_now)
    author: str = ""
    body: str = ""


class StatusHistoryEntry(BaseModel):
    """One append-only lifecycle transition on a case (status taxonomy / F8).

    Records WHO moved the case FROM which status TO which, WHEN, and WHY. Written
    by analyst lifecycle actions (and by the deterministic decision when it changes
    the status); rendered as a status timeline in the case overview. ``by``/``reason``
    are operator/agent text — render-escaped in the UI, never trusted as prompt."""

    from_status: str = ""
    to_status: str = ""
    by: str = ""
    at: str = Field(default_factory=iso_now)
    reason: str = ""


class MemoryEntry(BaseModel):
    """A durable operator FACT the agents remember across cases + chats (the
    Claude.ai-style "MEMORY" feature). Examples: "10.0.0.0/8 is internal",
    "Nessus scans run Sun 02:00 from 10.1.2.3", "bastion01 is a jump box".

    Only ``review_status="approved"`` entries are injected as TRUSTED operator
    context. Agent-authored entries remain ``pending`` and are fenced as UNTRUSTED
    review candidates until an operator with ``memory:manage`` approves them. This
    prevents a chat model (or a read-only chat caller) from silently minting durable
    trusted instructions. ``source`` records how the candidate originated; trust is
    represented independently by ``review_status``.
    """

    id: str = Field(default_factory=lambda: new_id("mem-"))
    text: str = ""
    category: str = ""
    tags: list[str] = Field(default_factory=list)
    source: str = "human"            # human | agent
    author: str = ""
    review_status: Literal["approved", "pending"] = "approved"
    approved_by: str = ""
    approved_at: str = ""
    # Approval-side-effect idempotency key. A retry after a proposal-finalisation
    # failure reuses the already-confirmed trusted fact instead of duplicating it.
    approval_proposal_id: str = ""
    created_at: str = Field(default_factory=iso_now)
    updated_at: str = Field(default_factory=iso_now)
    active: bool = True

    @model_validator(mode="before")
    @classmethod
    def _migrate_legacy_trust(cls, data: Any) -> Any:
        """Give pre-review records a conservative, deterministic trust class.

        Historical human entries remain approved. Historical ``source="agent"``
        entries did not pass a human approval boundary, so they migrate to pending
        on read. An explicit stored ``review_status`` always wins.
        """
        if isinstance(data, dict) and "review_status" not in data:
            migrated = dict(data)
            migrated["review_status"] = (
                "pending" if str(migrated.get("source") or "human") == "agent" else "approved"
            )
            return migrated
        return data


class Proposal(BaseModel):
    """An agent-DRAFTED change the analyst must explicitly APPROVE before it goes
    live (HITL — human-in-the-loop).

    A proposal is a *pending* recommendation only: drafting one NEVER mutates a live
    rule, Preferences, or memory — the approve endpoint is the single write path.
    Today the proposer drafts ``suppression`` rules (a deterministically-derived
    ``field==value`` filter for a closed FALSE_POSITIVE) and may draft ``memory``
    facts; the threshold observer also drafts review-first ``tuning`` work. Generic
    automation checkpoints use ``automation_ack``: approving one records the operator's
    acknowledgement only and deliberately materialises no configuration, Memory,
    suppression, or case-state change. Suppression
    and memory proposals are anti-poisoning constrained (the field+value must LITERALLY
    appear in the closed case's member events, never a bare entity/severity/cross-
    rule selector). ``payload`` carries the SuppressionRule-shaped dict (or the
    memory text/category, bounded tuning evidence, or acknowledgement context) the
    approve path validates and, where applicable, materialises.

    A pending proposal is a claim about EVIDENCE THAT EXISTED WHEN IT WAS DRAFTED, so
    it decays. ``expires_at`` bounds its life (the queue projects a lapsed row as
    ``expired`` and :meth:`app.stores.proposals.ProposalStore.sweep_expired` makes that
    durable; an expired proposal can be rejected but never approved), and
    ``evidence_fingerprint`` binds the row to the exact evidence counters and their
    PROVENANCE that justified it. Approving a threshold change whose evidence basis can
    no longer be verified is refused so it is re-drafted from current evidence rather
    than applied from stale — or bulk-ratified, model-derived — reasoning.
    """

    id: str = Field(default_factory=lambda: new_id("prop-"))
    kind: Literal["suppression", "memory", "tuning", "automation_ack"] = "suppression"
    status: Literal["pending", "applying", "approved", "rejected", "expired"] = "pending"
    payload: dict[str, Any] = Field(default_factory=dict)
    rationale: str = ""
    confidence: float = 0.0
    source_case_ids: list[str] = Field(default_factory=list)
    created_by: str = "agent"
    created_at: str = Field(default_factory=iso_now)
    decided_by: str | None = None
    decided_at: str | None = None
    # The first durable decision claim fixes the operator's intent and audit
    # identity/timestamp. A failed strict write can be retried by another worker or
    # operator, but the original decision actor remains the author of every effect,
    # the append-only audit row, and the final public decision. ``decision_actor``
    # is internal recovery state and is removed by the API's public projection.
    # The intent likewise cannot silently change from approve to reject (or vice
    # versa) after effects may exist.
    decision_actor: str | None = None
    decision_intent: Literal["approve", "reject"] | None = None
    decision_audit_at: str | None = None
    applying_token: str | None = None
    applying_at: str | None = None
    approval_error: str | None = None
    expires_at: str | None = None
    # Bounded, operator-authored justification captured by the first rejection claim
    # (single or bulk). Immutable afterwards, exactly like ``decision_actor``.
    decision_reason: str | None = None
    # ``ev1:<sha256>`` over the recommendation AND the evidence counters + provenance
    # it was derived from (see :func:`app.stores.proposals.evidence_fingerprint`).
    # ``None`` means the drafter recorded no verifiable basis — the honest answer for
    # every row written before provenance was tracked, and the reason such a row can
    # no longer be applied.
    evidence_fingerprint: str | None = None


# Max accepted profile-avatar data-URL length. The browser resizes to 256×256
# WebP q0.85 before upload, so a real avatar is a tiny string; cap defends the KV
# doc (and #10 — no large blobs in a user record).
MAX_AVATAR_LEN: int = 64_000

# (raster image type → magic-byte prefix(es)) used to sniff a decoded avatar body.
# SVG is intentionally absent — it is rejected (it can carry script; #9/#10).
_AVATAR_MAGIC: dict[str, tuple[bytes, ...]] = {
    "png": (b"\x89PNG\r\n\x1a\n",),
    "jpeg": (b"\xff\xd8\xff",),
    "webp": (b"RIFF",),  # "RIFF"...."WEBP" container; sniffed below
}
_AVATAR_RE = re.compile(r"^data:image/(png|webp|jpeg);base64,(.+)$", re.DOTALL)


def validate_avatar(v: str) -> str:
    """Validate a profile avatar data-URL. Returns the value unchanged when valid.

    Accepts an empty string (cleared avatar) OR a
    ``data:image/(png|webp|jpeg);base64,<body>`` URL whose base64 body decodes and
    whose decoded bytes start with the matching raster magic. SVG is rejected (it
    can embed script). Bounded by :data:`MAX_AVATAR_LEN`. Mirrors the
    :class:`app.config.BrandingConfig` logo validator, tightened for user input.

    Raises ``ValueError`` on any malformed / oversize / wrong-type / non-decoding
    input so callers (the model + the route) reject with one consistent rule (#9)."""
    if not v:
        return v
    if len(v) > MAX_AVATAR_LEN:
        raise ValueError(f"avatar too large (max ~{MAX_AVATAR_LEN} characters)")
    m = _AVATAR_RE.match(v)
    if not m:
        raise ValueError(
            "avatar must be empty or a data:image/(png|webp|jpeg);base64,<body> URL"
        )
    kind, body = m.group(1), m.group(2)
    try:
        # validate=True so stray (e.g. svg/markup) chars fail rather than being skipped.
        raw = base64.b64decode(body, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("avatar base64 body is malformed") from exc
    if not raw:
        raise ValueError("avatar image body is empty")
    if kind == "webp":
        # RIFF container: "RIFF"<4-byte size>"WEBP".
        if not (raw[:4] == b"RIFF" and raw[8:12] == b"WEBP"):
            raise ValueError("avatar is not a valid webp image")
    else:
        if not any(raw.startswith(p) for p in _AVATAR_MAGIC[kind]):
            raise ValueError(f"avatar is not a valid {kind} image")
    return v


class User(BaseModel):
    """A multi-user SOC account (Wave 1: login + RBAC).

    Persisted backend-agnostically as one entry in the single ``users`` KV document
    (the same JSON-list-in-KV pattern as :class:`MemoryEntry`/:class:`Proposal`) —
    NO new ES index / SQL table / migration. ``password_hash`` is a PBKDF2 string
    from :func:`app.auth.passwords.hash_password`; it is NEVER returned by any API
    (routes project to a safe public view). ``role`` is a :class:`app.constants.UserRole`
    value. ``must_change_password`` forces a password reset on next login.
    """

    username: str = ""
    password_hash: str = ""
    role: UserRole = UserRole.ANALYST_TIER1
    active: bool = True
    must_change_password: bool = False
    created_at: str = Field(default_factory=iso_now)
    updated_at: str = Field(default_factory=iso_now)
    last_login_at: str | None = None
    groups: list[str] = Field(default_factory=list)

    # --- MFA (Wave 2 / F3; all additive + defaulted — a user with mfa_enabled=False
    # logs in EXACTLY as Wave 1). ``mfa_secret`` is the TOTP shared secret OBFUSCATED
    # at rest (HMAC keystream XOR keyed by the server key; see auth/mfa.py) — never
    # returned by any API. ``mfa_recovery_hashes`` are PBKDF2-hashed single-use codes
    # (a code is consumed by dropping its hash). ``mfa_last_step`` is the last accepted
    # TOTP time-step (replay rejection). ---
    mfa_enabled: bool = False
    mfa_secret: str = ""
    mfa_recovery_hashes: list[str] = Field(default_factory=list)
    mfa_last_step: int = 0
    # ``mfa_required`` is an ADMIN-SET MANDATE (users:manage): the account must
    # enroll + clear a second factor at its next login. DISTINCT from
    # ``mfa_enabled`` (the user is actually ENROLLED) — setting the mandate never
    # mints or implies a TOTP secret. Additive + defaulted so old stored KV docs
    # load unchanged (no migration).
    mfa_required: bool = False

    # --- SSO (Wave 2 / F4; additive). When a user is provisioned via OIDC these
    # record the originating provider id + the IdP's stable subject so a returning
    # SSO user maps back to the SAME local account. Empty for password accounts. ---
    oauth_provider: str = ""
    oauth_sub: str = ""

    # --- Self-service profile (Wave 2 / W2; ALL additive + defaulted → old stored
    # KV docs load unchanged, no index/migration). Every field here is NON-secret
    # and user-influenceable, so it is rendered as PLAIN text by the UI (#9). The
    # avatar is a bounded data-URL (see :func:`validate_avatar`); ``prefs`` is a
    # small free-form UI-preferences bag (capped at the route). ---
    display_name: str = ""
    alias: str = ""
    avatar: str = ""
    alt_email: str = ""
    timezone: str = ""
    locale: str = ""
    prefs: dict[str, Any] = Field(default_factory=dict)

    # --- Admin-managed contact fields (additive + defaulted → old stored KV docs
    # load unchanged). ``email``/``phone`` are FIRST-CLASS contact fields set at
    # creation (or later) by a users:manage admin; ``alt_email`` stays the separate
    # self-service "alternate email". Non-secret, operator/user-influenceable →
    # rendered as PLAIN text only (#9), never interpolated into a prompt. ---
    email: str = ""
    phone: str = ""

    @field_validator("avatar")
    @classmethod
    def _check_avatar(cls, v: str) -> str:
        return validate_avatar(v)

    def public(self) -> dict[str, Any]:
        """A safe projection for API responses — NEVER includes the password hash
        or the MFA secret/recovery hashes (only the ``mfa_enabled`` boolean)."""
        return {
            "username": self.username,
            "role": self.role.value if isinstance(self.role, UserRole) else str(self.role),
            "active": self.active,
            "must_change_password": self.must_change_password,
            "created_at": self.created_at,
            "last_login_at": self.last_login_at,
            "mfa_enabled": self.mfa_enabled,
            # The admin-set enrollment mandate (a boolean policy flag — no secret).
            "mfa_required": self.mfa_required,
            "oauth_provider": self.oauth_provider,
            # Self-service profile (non-secret; W2).
            "display_name": self.display_name,
            "alias": self.alias,
            "avatar": self.avatar,
            "alt_email": self.alt_email,
            "timezone": self.timezone,
            "locale": self.locale,
            "prefs": self.prefs,
            # Admin-managed contact fields (non-secret).
            "email": self.email,
            "phone": self.phone,
        }


# --------------------------------------------------------------------------- #
# Pervasive customization (Wave 7) — saved views, per-table column state, and a
# per-user personal-preferences bag. ALL of this is operator/user-INFLUENCEABLE
# config rendered as PLAIN data by the UI (#9): a SavedView name / filter, a
# column id, a terminology label — none of it is ever interpolated unfenced into
# an LLM prompt. Persisted backend-agnostically as ONE KV document keyed by
# user_id (the same JSON-in-KV pattern as MemoryEntry/User) — no new index/table.
# --------------------------------------------------------------------------- #
class SavedView(BaseModel):
    """A named, reusable list configuration (filters + sort + optional columns) for
    a UI surface (``cases``/``sources``/…). ``owner`` records who created it;
    ``shared`` marks an org-shared view (org defaults live on Preferences, but a
    user may clone one into their personal set). ``filters`` is a small free-form
    dict the frontend interprets; ``sort`` is e.g. ``"-created_at"``; ``columns``
    optionally pins the visible/ordered column ids for the view. All free-text is
    plain data (#9)."""

    id: str = Field(default_factory=lambda: new_id("view-"))
    name: str = ""
    scope: str = "cases"                       # cases | sources | ... (UI surface)
    owner: str = ""                            # username that created it ("" = system/org)
    shared: bool = False                       # an org-shared view
    filters: dict[str, Any] = Field(default_factory=dict)
    sort: str = ""
    columns: list[str] | None = None           # None → the surface default columns
    created_at: str = Field(default_factory=iso_now)
    updated_at: str = Field(default_factory=iso_now)


class ColumnState(BaseModel):
    """Per-table column layout the user customised: the ordered column ids, the
    hidden column ids, and a ``widths`` map (column id → pixel width). A table that
    has no stored ColumnState renders its built-in default — this only ever ADDS an
    override, never removes a column from existence."""

    order: list[str] = Field(default_factory=list)        # ordered visible-or-not column ids
    hidden: list[str] = Field(default_factory=list)       # column ids the user hid
    widths: dict[str, int] = Field(default_factory=dict)  # column id → px width


class DashboardWidget(BaseModel):
    """One placed widget on a custom dashboard (Round 5 / G7). The geometry fields
    (``i``/``x``/``y``/``w``/``h``/``minW``/``minH``/``static``) ARE the
    ``react-grid-layout`` item shape: 12-column absolute grid coordinates the RGL
    edit surface reads/writes verbatim, so the persistence schema and the layout
    library share one contract (no adapter). ``i`` is the stable item id used both
    as the RGL key AND the widget instance id.

    ``type`` selects a widget from the client widget registry (a WidgetType enum
    value, kept a str so an unknown/legacy type round-trips and is dropped by the
    client's reconcile-on-load); ``options`` is the widget's declarative config
    (title, series, source id, …) — small free-form PLAIN data the UI
    render-escapes (#9), NEVER interpolated unfenced into a prompt. A widget layout
    is ADVISORY presentation only — it never feeds ``case_manager.decide()`` (#3)."""

    i: str = ""                                    # stable item id (RGL key + widget id)
    type: str = ""                                 # WidgetType (client registry) — plain str
    x: int = 0                                      # 12-col grid column
    y: int = 0                                      # grid row
    w: int = 4                                      # width in grid columns
    h: int = 4                                      # height in grid rows
    minW: int | None = None                         # min width (RGL constraint)
    minH: int | None = None                         # min height (RGL constraint)
    static: bool = False                            # locked (not draggable/resizable)
    options: dict[str, Any] = Field(default_factory=dict)  # declarative widget config (#9)


#: Round 14 (SPEC §4.4.1): the board windows a dashboard may start on.
DashboardWindow = Literal["now-24h", "now-7d", "now-30d", "now-90d"]
DASHBOARD_WINDOWS: tuple[str, ...] = get_args(DashboardWindow)
#: ``DashboardLayout.derived_from``: a board id in the client's ``NAV_ID`` alphabet.
DASHBOARD_DERIVED_FROM_PATTERN = r"^[A-Za-z0-9_.:-]{1,64}$"
_DASHBOARD_DERIVED_FROM_RE = re.compile(r"[A-Za-z0-9_.:-]{1,64}")
#: Board ids the server refuses to CREATE (SPEC §2.2 item 4, E4): the builder's draft
#: id and the two reserved prefixes. Older stored boards keep working whatever their
#: id; only a new create is refused (``400 dashboard_id_reserved``).
DASHBOARD_RESERVED_IDS: frozenset[str] = frozenset({"new"})
DASHBOARD_RESERVED_ID_PREFIXES: tuple[str, ...] = ("builtin:", "u:")
#: The built-in boards (code-defined in the client's ``dashboard/builtins.ts``, never
#: stored). The Cyber Defence Center is the landing page and cannot be hidden.
BUILTIN_DASHBOARD_LANDING_ID = "builtin:cyber-defence-center"
BUILTIN_DASHBOARD_ID_PATTERN = r"^builtin:[a-z-]{1,40}$"
_BUILTIN_DASHBOARD_ID_RE = re.compile(BUILTIN_DASHBOARD_ID_PATTERN)
#: ``UserPrefs.misc.dashboards_hidden`` holds at most this many built-in ids.
MAX_HIDDEN_DASHBOARDS = 8


def is_reserved_dashboard_id(dashboard_id: str) -> bool:
    """True when ``dashboard_id`` may not be used to CREATE a personal board."""
    return dashboard_id in DASHBOARD_RESERVED_IDS or dashboard_id.startswith(DASHBOARD_RESERVED_ID_PREFIXES)


class DashboardLayout(BaseModel):
    """One named custom dashboard (Round 5 / G7). A user owns a set of these keyed
    by ``id`` on :attr:`UserPrefs.dashboards`. Persisted backend-agnostically as
    part of the per-user prefs KV document — NO new index/table/migration.

    ``widgets`` is the default (single-breakpoint) placement; ``layouts`` optionally
    carries a per-breakpoint override map (``{"lg": [...], "md": [...], ...}`` — the
    RGL responsive shape) so a dashboard can reflow at different widths. ``columns``
    is the grid column count (12 by default). ``schema_version`` is stamped from day
    one so a future migration can evolve the widget shape without a data reset (a
    lower/absent version is upgraded on read by the client/store, never blocks load).

    ``name`` is UNTRUSTED user input — rendered as PLAIN text/SVG by the UI, never
    ``dangerouslySetInnerHTML`` and never a prompt instruction (#9). A dashboard is
    ADVISORY presentation state only; it never feeds ``case_manager.decide()`` (#3)."""

    id: str = Field(default_factory=lambda: new_id("dash-"))
    name: str = ""
    schema_version: int = 1
    columns: int = 12
    widgets: list[DashboardWidget] = Field(default_factory=list)
    # Optional per-breakpoint override (RGL responsive layouts). Keyed by breakpoint
    # name (lg/md/sm/xs/xxs); each value is a list of widget placements. Defaulted
    # empty → the single ``widgets`` layout is authoritative.
    layouts: dict[str, list[DashboardWidget]] = Field(default_factory=dict)
    created_at: str = Field(default_factory=iso_now)
    updated_at: str = Field(default_factory=iso_now)
    # --- Round 14 (SPEC §4.4.1; additive, defaulted ``None`` so every stored board
    # loads unchanged and a build before Round 14 ignores them). ---
    # The window the board's time-range picker starts on. Only the four relative
    # presets exist because every widget provider takes a trailing ``window_hours``
    # (24, 168, 720, 2,160) and ``breakdown`` the same token. Absent means the client
    # default ``now-24h``. A duplicate of a built-in board copies its window here.
    default_window: DashboardWindow | None = None
    # The board this one was copied from (a built-in id such as
    # ``builtin:soc-operations``). Plain data shown as "Copied from SOC operations";
    # never a link target the server resolves.
    derived_from: str | None = Field(default=None, max_length=64, pattern=DASHBOARD_DERIVED_FROM_PATTERN)

    # Read leniently. Every user's boards share ONE stored document, and the store
    # skips a board that fails validation and re-encodes the rest on the next write,
    # so a strict read would let one drifted cosmetic value (a window preset added by a
    # later release, then a rollback to this one) erase that whole board for good.
    # An unknown value reads as ``None`` instead. Requests are validated strictly by
    # :class:`DashboardLayoutIn`, which overrides this validator.
    @field_validator("default_window", "derived_from", mode="before")
    @classmethod
    def _lenient_round14_fields(cls, value: Any, info: Any) -> Any:
        if value is None:
            return None
        if info.field_name == "default_window":
            return value if value in DASHBOARD_WINDOWS else None
        if isinstance(value, str) and _DASHBOARD_DERIVED_FROM_RE.fullmatch(value):
            return value
        return None


class DashboardLayoutIn(DashboardLayout):
    """The create and update request body of a personal board (``POST
    /api/dashboards``, ``PUT /api/dashboards/{id}``): :class:`DashboardLayout` with the
    Round 14 fields validated strictly, so a bad ``default_window`` or
    ``derived_from`` is refused at the write boundary instead of being dropped."""

    @field_validator("default_window", "derived_from", mode="before")
    @classmethod
    def _lenient_round14_fields(cls, value: Any, info: Any) -> Any:  # strict: no rewrite
        return value


MAX_CHAT_PROMPTS = 50
MAX_CHAT_PROMPT_TITLE_CHARS = 60
MAX_CHAT_PROMPT_TEXT_CHARS = 2_000
CHAT_PROMPT_ID_PATTERN = r"^[A-Za-z0-9._:-]{1,64}$"
_CHAT_PROMPT_ID_RE = re.compile(CHAT_PROMPT_ID_PATTERN)


ChatPromptCategory = Literal["triage", "hunt", "ioc", "posture", "reporting", "app_help"]
CHAT_PROMPT_CATEGORIES: tuple[str, ...] = get_args(ChatPromptCategory)

#: Round 13 (SPEC-chat §3.2.1): the personal suggestion switches in ``UserPrefs.misc``
#: (``chat_suggest_start``: start cards and the thread catch-up line;
#: ``chat_suggest_follow_ups``: follow-up chips). Absent means on; a non-bool is removed.
CHAT_SUGGEST_PREF_KEYS: tuple[str, ...] = ("chat_suggest_start", "chat_suggest_follow_ups")

#: Round 14 (SPEC §4.4.1, §4.9.2): personal list keys in ``UserPrefs.misc``.
#: ``dashboards_hidden`` lists the built-in boards the viewer hid from the Dashboards
#: library; ``dismissed_intros`` lists the ``Callout intro`` notices the viewer
#: dismissed. Both are normalised on load (never rejected), so a bad value can never
#: fail the whole prefs bucket.
DASHBOARDS_HIDDEN_PREF_KEY = "dashboards_hidden"
DISMISSED_INTROS_PREF_KEY = "dismissed_intros"
DISMISSED_INTRO_ID_PATTERN = r"^[a-z0-9][a-z0-9_.:-]{0,63}$"
_DISMISSED_INTRO_ID_RE = re.compile(DISMISSED_INTRO_ID_PATTERN)
MAX_DISMISSED_INTROS = 50


def _normalise_hidden_dashboards(value: Any) -> list[str] | None:
    """``misc.dashboards_hidden``: built-in ids only (never the landing board), in
    their first order, de-duplicated, at most :data:`MAX_HIDDEN_DASHBOARDS`. ``None``
    when the value is not a list (the key is then removed)."""
    if not isinstance(value, (list, tuple)):
        return None
    out: list[str] = []
    for item in value:
        if not isinstance(item, str) or not _BUILTIN_DASHBOARD_ID_RE.fullmatch(item):
            continue
        if item == BUILTIN_DASHBOARD_LANDING_ID or item in out:
            continue
        out.append(item)
        if len(out) >= MAX_HIDDEN_DASHBOARDS:
            break
    return out


def _normalise_dismissed_intros(value: Any) -> list[str] | None:
    """``misc.dismissed_intros``: notice ids in the lower-case id alphabet, first
    order, de-duplicated, at most :data:`MAX_DISMISSED_INTROS`; ``None`` for a
    non-list (the key is then removed)."""
    if not isinstance(value, (list, tuple)):
        return None
    out: list[str] = []
    for item in value:
        if not isinstance(item, str) or not _DISMISSED_INTRO_ID_RE.fullmatch(item) or item in out:
            continue
        out.append(item)
        if len(out) >= MAX_DISMISSED_INTROS:
            break
    return out


_ROUND14_LIST_PREFS: dict[str, Any] = {
    DASHBOARDS_HIDDEN_PREF_KEY: _normalise_hidden_dashboards,
    DISMISSED_INTROS_PREF_KEY: _normalise_dismissed_intros,
}


class ChatPrompt(BaseModel):
    """One saved composer prompt (chat revamp SPEC §10.4). Plain user text: rendered
    as text, sent as an ordinary user message (it is the user's own words).

    Round 12 prompt library (SPEC §3.1): an optional ``category`` and a ``favorite``
    star; ``{name}`` placeholders in ``text`` are filled in by the composer before
    sending (client-side; the server stores the template as plain text)."""

    id: str = Field(pattern=CHAT_PROMPT_ID_PATTERN)
    title: str = Field(min_length=1, max_length=MAX_CHAT_PROMPT_TITLE_CHARS)
    text: str = Field(min_length=1, max_length=MAX_CHAT_PROMPT_TEXT_CHARS)
    category: ChatPromptCategory | None = None
    favorite: bool = False


def _repair_chat_prompts(value: Any) -> list[dict[str, Any]]:
    """Lenient stored-prompt repair: sanitise + clamp, drop unusable or duplicate
    entries, keep at most 50. A bad entry must never fail the WHOLE prefs bucket —
    the store skips a bucket that fails validation, which would silently wipe the
    user's saved views, dashboards and theme along with it."""
    if not isinstance(value, (list, tuple)):
        return []
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in value:
        if isinstance(item, ChatPrompt):
            item = item.model_dump()
        if not isinstance(item, dict):
            continue
        prompt_id = item.get("id")
        if not isinstance(prompt_id, str) or not _CHAT_PROMPT_ID_RE.match(prompt_id) or prompt_id in seen:
            continue
        text = display_text(item.get("text"), MAX_CHAT_PROMPT_TEXT_CHARS, multiline=True).strip()
        if not text:
            continue
        title = display_text(item.get("title"), MAX_CHAT_PROMPT_TITLE_CHARS) or display_text(
            text, MAX_CHAT_PROMPT_TITLE_CHARS
        )
        seen.add(prompt_id)
        entry: dict[str, Any] = {"id": prompt_id, "title": title, "text": text}
        category = item.get("category")
        if isinstance(category, str) and category in CHAT_PROMPT_CATEGORIES:
            entry["category"] = category
        if item.get("favorite") is True:
            entry["favorite"] = True
        out.append(entry)
        if len(out) >= MAX_CHAT_PROMPTS:
            break
    return out


class UserPrefs(BaseModel):
    """One user's PERSONAL preferences bucket (Wave 7). Every field is additive +
    defaulted so an empty/legacy bucket loads unchanged. Distinct from the ORG
    defaults (which live on Preferences and are admin-edited): the cascade resolver
    merges ORG ← USER so a user override always wins.

    * ``saved_views`` — the user's personal saved views (+ clones of org/shared ones).
    * ``tables`` — per-table column state, keyed by a stable ``table_id``.
    * ``theme_mode`` — the user's light/dark/system preference (overrides the org default).
    * ``last_list_state`` — last-used filter/sort per surface (so a page reopens where
      the user left it), keyed by surface id; small free-form dicts.
    * ``pinned_view_ids`` — saved-view ids the user pinned as quick-access defaults.
    * ``dashboards`` — the user's custom dashboards (Round 5 / G7), keyed by dashboard
      id; each is a :class:`DashboardLayout`. Additive + defaulted ``{}`` (mirrors
      ``saved_views``) so a legacy bucket loads unchanged.
    * ``misc`` — a small catch-all UI-prefs bag (density, etc.). ``misc.chat_stream_mode``
      is the viewer's D2 chat mode (``"steps"``/``"text"``; normalised on load, an
      invalid value is removed so the org default applies). Round 13 (SPEC-chat
      §3.2.1): ``misc.chat_suggest_start`` (start cards and the thread catch-up line)
      and ``misc.chat_suggest_follow_ups`` (follow-up chips) are personal switches;
      absent means on, and a value that is not a bool is removed on load. Round 14
      (SPEC §4.4.1, §4.9.2): ``misc.dashboards_hidden`` (built-in board ids hidden
      from the Dashboards library, never the landing board, at most 8) and
      ``misc.dismissed_intros`` (dismissed ``Callout intro`` ids, at most 50) are
      lists normalised on load; a value that is not a list is removed.
    * ``chat_prompts`` — the user's saved chat prompts (chat revamp SPEC §10.4).
    """

    saved_views: list[SavedView] = Field(default_factory=list)
    tables: dict[str, ColumnState] = Field(default_factory=dict)
    theme_mode: Literal["light", "dark", "system"] = "system"
    last_list_state: dict[str, dict[str, Any]] = Field(default_factory=dict)
    pinned_view_ids: list[str] = Field(default_factory=list)
    dashboards: dict[str, DashboardLayout] = Field(default_factory=dict)
    misc: dict[str, Any] = Field(default_factory=dict)
    chat_prompts: list[ChatPrompt] = Field(default_factory=list, max_length=MAX_CHAT_PROMPTS)
    updated_at: str = Field(default_factory=iso_now)

    @field_validator("chat_prompts", mode="before")
    @classmethod
    def _chat_prompts(cls, value: Any) -> list[dict[str, str]]:
        return _repair_chat_prompts(value)

    @field_validator("misc", mode="before")
    @classmethod
    def _misc_chat_stream_mode(cls, value: Any) -> Any:
        if not isinstance(value, dict):
            return value
        if (
            "chat_stream_mode" not in value
            and not any(k in value for k in CHAT_SUGGEST_PREF_KEYS)
            and not any(k in value for k in _ROUND14_LIST_PREFS)
        ):
            return value
        out = dict(value)
        # Round 14 (SPEC §4.4.1, §4.9.2): the personal list keys are normalised, a
        # non-list value is removed, never coerced.
        for key, normalise in _ROUND14_LIST_PREFS.items():
            if key in out:
                cleaned = normalise(out[key])
                if cleaned is None:
                    out.pop(key, None)
                else:
                    out[key] = cleaned
        if "chat_stream_mode" in out:
            mode = out.get("chat_stream_mode")
            normalised = mode.strip().lower() if isinstance(mode, str) else None
            if normalised in ("steps", "text"):
                out["chat_stream_mode"] = normalised
            else:
                out.pop("chat_stream_mode", None)
        # Round 13 (SPEC-chat §3.2.1): the personal suggestion switches are bools or
        # absent (absent = on). Anything else is removed, never coerced.
        for key in CHAT_SUGGEST_PREF_KEYS:
            if key in out and not isinstance(out[key], bool):
                out.pop(key, None)
        return out

    @property
    def chat_stream_mode(self) -> Literal["steps", "text"] | None:
        """The viewer's D2 preference, or ``None`` (use ``chat_agent.default_stream_mode``)."""
        mode = self.misc.get("chat_stream_mode")
        return mode if mode in ("steps", "text") else None

    @property
    def chat_suggest_start(self) -> bool:
        """Round 13: the viewer's "Suggestions when a chat starts" switch (default on)."""
        return self.misc.get("chat_suggest_start") is not False

    @property
    def chat_suggest_follow_ups(self) -> bool:
        """Round 13: the viewer's "Suggested follow-ups" switch (default on)."""
        return self.misc.get("chat_suggest_follow_ups") is not False

    @property
    def dashboards_hidden(self) -> list[str]:
        """Round 14: the built-in boards this viewer hid from the Dashboards library."""
        value = self.misc.get(DASHBOARDS_HIDDEN_PREF_KEY)
        return list(value) if isinstance(value, list) else []

    @property
    def dismissed_intros(self) -> list[str]:
        """Round 14: the ``Callout intro`` notices this viewer dismissed."""
        value = self.misc.get(DISMISSED_INTROS_PREF_KEY)
        return list(value) if isinstance(value, list) else []


# --------------------------------------------------------------------------- #
# Round 3 scaffolding — observables / enrichment / collaboration / notifications /
# custom RBAC / shift-handoff / trace. ALL of these are NEW additive contracts with
# sane defaults; later waves add the BEHAVIOUR (pipeline wiring, stores, routes).
# They are NOT wired into the pipeline here and NONE of them is read by
# ``engine/case_manager.decide()`` (#3). Every free-text field that can carry
# user/source-influenceable text (a message ``body``, a tag, an observable ``value``,
# a provider ``raw`` blob) is PLAIN DATA: the UI render-escapes it and it is never
# interpolated UNFENCED into an LLM prompt (#9).
# --------------------------------------------------------------------------- #
class Observable(BaseModel):
    """One OCSF-style observable extracted from a case/event — the unit enrichment
    operates on (an ip / domain / url / file_hash / email / host). ``type`` is an
    :class:`app.constants.IndicatorKind` value (kept as a str so legacy/unknown kinds
    round-trip). ``value`` is the indicator itself (UNTRUSTED, source-derived — plain
    data, never a prompt instruction, #9). ``extra`` carries any side metadata."""

    type: str = ""
    value: str = ""
    name: str | None = None
    extra: dict[str, Any] = Field(default_factory=dict)


class ProviderResult(BaseModel):
    """One enrichment provider's verdict on one indicator (Round 3 multi-provider
    threat-intel). FAIL-OPEN: ``ok=False`` + ``error`` records a provider miss
    without erroring the whole enrichment. ``score`` is a 0..100 maliciousness score
    (provider-normalised); ``malicious``/``confidence`` are the provider's own call.
    ``raw`` is the provider's response excerpt — UNTRUSTED data, rendered as a code
    block, never trusted as instructions (#9). Advisory only — never feeds #3."""

    provider: str = ""
    indicator: str = ""
    indicator_kind: str = ""              # IndicatorKind value
    score: int | None = None             # 0..100 maliciousness (provider-normalised)
    malicious: bool | None = None
    confidence: float | None = None
    tags: list[str] = Field(default_factory=list)
    raw: dict[str, Any] = Field(default_factory=dict)
    ok: bool = True
    error: str | None = None
    ts: datetime | None = None


class CaseMessage(BaseModel):
    """One message in a case's threaded discussion (Round 3 collaboration). Supports
    human + AI + system authors, threaded replies (``parent_id``), @mentions,
    emoji reactions, edit/delete tombstones, and an ``ai_meta`` bag for AI-authored
    messages (model / cost / token provenance). ``author_type`` is an
    :class:`app.constants.AuthorType` value. ``body``/``mentions`` are user input —
    render-escaped by the UI, never trusted as prompt instructions (#9)."""

    id: str = Field(default_factory=lambda: new_id("msg-"))
    case_id: str = ""
    parent_id: str | None = None
    author_type: str = "human"            # human | ai | system (AuthorType)
    author: str = ""
    body: str = ""
    mentions: list[str] = Field(default_factory=list)
    reactions: list[dict[str, Any]] = Field(default_factory=list)  # [{emoji, user}]
    kind: str = "comment"
    created_at: str = Field(default_factory=iso_now)
    edited_at: str | None = None
    deleted_at: str | None = None
    ai_meta: dict[str, Any] | None = None


class CaseActivity(BaseModel):
    """One entry on a case's human-facing activity timeline (Round 3 collaboration) —
    an append-only, render-escaped record of who did what (assigned / commented /
    reacted / status-changed) for the case overview. ``summary``/``ref`` are plain
    data. Distinct from the authoritative ``AuditDoc`` trail (which stays the source
    of truth); this is the friendly UI feed."""

    id: str = Field(default_factory=lambda: new_id("act-"))
    case_id: str = ""
    kind: str = ""
    actor: str = ""
    ts: str = Field(default_factory=iso_now)
    summary: str = ""
    ref: dict[str, Any] = Field(default_factory=dict)


class CaseTask(BaseModel):
    """One checklist item / task on a case (Round 3 collaboration). ``status`` tracks
    open→done; ``order`` keeps a stable manual ordering; ``logs`` is an append-only
    note trail ``[{ts, by, note}]``. ``title``/``logs`` are plain data (#9)."""

    id: str = Field(default_factory=lambda: new_id("task-"))
    case_id: str = ""
    title: str = ""
    assignee: str | None = None
    status: str = "open"                  # open | in_progress | done | blocked
    order: int = 0
    created_at: str = Field(default_factory=iso_now)
    logs: list[dict[str, Any]] = Field(default_factory=list)


class JobProgress(BaseModel):
    """Bounded progress projection shared by Jobs, Inbox, SSE, and the Console."""

    done: int = Field(default=0, ge=0)
    total: int = Field(default=0, ge=0)
    unit: str = Field(default="items", min_length=1, max_length=40)


class JobFailure(BaseModel):
    item_ref: str = Field(default="", max_length=200)
    reason: str = Field(default="", max_length=500)


class JobResult(BaseModel):
    kind: str = Field(default="summary", min_length=1, max_length=80)
    artifact_id: str | None = Field(default=None, max_length=120)
    counts: dict[str, int] = Field(default_factory=dict)


class JobPermission(BaseModel):
    resource: str = Field(min_length=1, max_length=80)
    action: str = Field(min_length=1, max_length=80)


class JobTransition(BaseModel):
    seq: int = Field(ge=1)
    name: str = Field(min_length=1, max_length=40)
    at: str = Field(default_factory=iso_now)
    summary: str = Field(default="", max_length=500)
    audited: bool = False


class JobArtifact(BaseModel):
    """Internal artifact metadata; the opaque id derives its private-root path."""

    artifact_id: str = Field(min_length=1, max_length=120)
    filename: str = Field(min_length=1, max_length=240)
    content_type: str = Field(min_length=1, max_length=120)
    size: int = Field(ge=0)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    created_at: str = Field(default_factory=iso_now)


class Job(BaseModel):
    """Durable internal job record stored in the existing state-backend KV."""

    job_id: str = Field(default_factory=lambda: new_id("job-"), max_length=120)
    kind: JobKind
    actor: str = Field(default="", max_length=160)
    actor_generation: str = Field(default="", max_length=64)
    created_at: str = Field(default_factory=iso_now)
    started_at: str | None = None
    finished_at: str | None = None
    status: JobStatus = JobStatus.QUEUED
    progress: JobProgress = Field(default_factory=JobProgress)
    failures: list[JobFailure] = Field(default_factory=list)
    failure_count: int = Field(default=0, ge=0)
    failures_truncated: int = Field(default=0, ge=0)
    # Empty only on the deliberately sanitized system-owned factory-reset receipt.
    request_fingerprint: str = Field(pattern=r"^(?:[0-9a-f]{64})?$")
    # Purpose-separated SHA-256(actor + NUL + caller key); the raw idempotency key
    # is never persisted or returned.
    idempotency_key_hash: str = Field(pattern=r"^(?:[0-9a-f]{64})?$")
    result: JobResult | None = None
    params: dict[str, Any] = Field(default_factory=dict)
    required_permissions: list[JobPermission] = Field(default_factory=list)
    # Sensitive jobs are admitted only after step-up authentication. Persist the
    # bounded authorization deadline and originating session id so execution cannot
    # silently outlive/replay that authority after the HTTP request disappears.
    fresh_authorized_until_millis: int = Field(default=0, ge=0)
    fresh_session_id: str | None = Field(default=None, max_length=160)
    fresh_token_version: int | None = Field(default=None, ge=0)
    cancel_requested: bool = False
    # Resume/dedup journal. A post-crash ambiguous ``processing`` item is failed
    # closed rather than re-executed and potentially billed/applied twice.
    item_states: dict[str, Literal["pending", "processing", "succeeded", "failed"]] = Field(
        default_factory=dict
    )
    lease_owner: str | None = Field(default=None, max_length=160)
    lease_token: str | None = Field(default=None, max_length=160)
    lease_expires_at_millis: int = Field(default=0, ge=0)
    transition_seq: int = Field(default=0, ge=0)
    transitions: list[JobTransition] = Field(default_factory=list)
    artifact: JobArtifact | None = None
    # A worker reserves an opaque artifact identity in the durable row before it
    # creates/writes the private file. Startup cleanup therefore cannot mistake a
    # different replica's in-progress archive for an orphan.
    pending_artifact_id: str | None = Field(default=None, max_length=120)
    pending_artifact_suffix: str | None = Field(default=None, max_length=16)
    inbox_synced: bool = False
    # Set when an account generation is deleted while its worker is in flight.
    # The worker may finish/audit, but no later projection may target a recreated
    # account with the same mutable username.
    retired: bool = False
    app_version: str | None = None
    build_sha: str | None = None

    @model_validator(mode="after")
    def _factory_receipt_or_executable(self) -> "Job":
        empty_identity = not self.request_fingerprint or not self.idempotency_key_hash
        if not empty_identity:
            return self
        valid_receipt = (
            not self.request_fingerprint
            and not self.idempotency_key_hash
            and self.kind == JobKind.TIERED_RESET
            and self.actor == ""
            and self.actor_generation == ""
            and self.status
            in {
                JobStatus.SUCCEEDED,
                JobStatus.PARTIAL,
                JobStatus.FAILED,
                JobStatus.CANCELLED,
            }
            and self.params == {"scope": "factory"}
            and not self.required_permissions
            and not self.fresh_session_id
            and self.fresh_token_version is None
            and not self.item_states
            and not self.failures
            and self.failure_count == 0
            and self.artifact is None
            and self.pending_artifact_id is None
            and not self.retired
        )
        if not valid_receipt:
            raise ValueError("empty job identity is reserved for sanitized factory receipts")
        return self


class JobPublic(BaseModel):
    """Secret-free/self-scoped wire projection returned by the Jobs API and SSE."""

    job_id: str
    kind: JobKind
    actor: str
    created_at: str
    started_at: str | None = None
    finished_at: str | None = None
    status: JobStatus
    progress: JobProgress
    failures: list[JobFailure] = Field(default_factory=list)
    failure_count: int = 0
    failures_truncated: int = 0
    request_fingerprint: str
    result: JobResult | None = None
    params: dict[str, Any] = Field(default_factory=dict)
    cancel_requested: bool = False


class RelatedBatchJobPublic(BaseModel):
    """Bounded, provider-secret-free LLM Batch summary on the unified Jobs view."""

    id: str = Field(max_length=2000)
    provider: str = Field(max_length=2000)
    state: str = Field(max_length=80)
    model: str = Field(max_length=2000)
    discount: float
    requests: int = Field(ge=0)
    retrieved: int = Field(ge=0)
    submitted_at: str | None = None
    polled_at: str | None = None


class RelatedJobsPublic(BaseModel):
    llm_batches: list[RelatedBatchJobPublic] = Field(default_factory=list)
    total: int = Field(ge=0)
    truncated: bool = False


class SchedulerWorkerPublic(BaseModel):
    enabled: bool
    gated: bool
    running: bool
    cadence: str = Field(max_length=80)
    last_attempt_at: str = ""
    last_success_at: str = ""
    last_error: str = Field(default="", max_length=500)
    processed: int = Field(default=0, ge=0)


class SchedulerHealthPublic(BaseModel):
    scheduler_runtime_running: bool
    workers: dict[str, SchedulerWorkerPublic] = Field(default_factory=dict)


class JobListResponse(BaseModel):
    jobs: list[JobPublic]
    total: int = Field(ge=0)
    limit: int = Field(ge=1, le=100)
    offset: int = Field(ge=0)
    related: RelatedJobsPublic | None = None
    system_workers: SchedulerHealthPublic | None = None


class InAppNotification(BaseModel):
    """One item in a user's in-app notification inbox (Round 3). ``category`` is a
    :class:`app.constants.NotificationCategory` value; ``state`` tracks the read
    lifecycle. ``title``/``body`` are render-escaped plain text (#9). Advisory — never
    feeds #3. Persisted per-recipient in the INBOX KV namespace."""

    id: str = Field(default_factory=lambda: new_id("ntf-"))
    recipient: str = ""
    category: str = "system"              # NotificationCategory value
    title: str = ""
    body: str = ""
    severity: str | None = None
    case_id: str | None = None
    url: str | None = None
    state: str = "unseen"                 # unseen | seen | read | archived
    created_at: str = Field(default_factory=iso_now)
    read_at: str | None = None
    ref: dict[str, Any] = Field(default_factory=dict)
    # Durable Jobs integration. These are additive and default null so historical
    # inbox rows load byte-compatibly. The item id remains stable while these values
    # are updated in place.
    job_id: str | None = None
    job_status: JobStatus | None = None
    progress: JobProgress | None = None
    result: JobResult | None = None
    # Internal generation binding for every durable application/LLM Batch Job
    # projection. API routes explicitly omit it; it exists only so a recreated
    # same-name principal cannot inherit a predecessor's durable Inbox row.
    audience_generation: str | None = Field(default=None, max_length=64)


class NotificationPref(BaseModel):
    """One user's in-app + channel notification preferences (Round 3 inbox). Keyed by
    ``user``. ``categories`` maps a :class:`app.constants.NotificationCategory` value →
    ``{channels:[...], enabled:bool}`` so a user routes/mutes per category.
    ``quiet_hours``/``digest`` are optional batching controls. Persisted in the
    NOTIF_PREFS KV namespace; ``default`` bucket when auth is OFF."""

    user: str = ""
    categories: dict[str, Any] = Field(default_factory=dict)  # category -> {channels:[], enabled:bool}
    quiet_hours: dict[str, Any] | None = None                 # {start, end, tz}
    digest: str | None = None                                 # off | hourly | daily


class CustomRole(BaseModel):
    """An operator-defined RBAC role (Round 3). ADDITIVE on top of the six built-in
    :class:`app.constants.UserRole` roles: ``inherits`` lists base roles whose grants
    it starts from, ``grants`` ADDS ``resource -> [action]`` permissions, and
    ``denies`` REMOVES them (deny wins). Wave 1 of Round 3 implements the effective-
    matrix resolution; here this only CARRIES the data (defaulted empty). Lives on
    ``Preferences.rbac.custom_roles`` (config tier) and/or the CUSTOM_ROLES KV ns."""

    name: str = ""
    description: str = ""
    inherits: list[str] = Field(default_factory=list)           # base role names
    grants: dict[str, list[str]] = Field(default_factory=dict)  # resource -> [action]
    denies: dict[str, list[str]] = Field(default_factory=dict)  # resource -> [action]


class ActionItem(BaseModel):
    """One follow-up action item carried across a shift handoff / standup (Round 3
    attention queue). ``title``/``note`` are plain data; ``status`` tracks open→done.
    Persisted in the SHIFT_HANDOFF KV namespace alongside :class:`ShiftAck`."""

    id: str = Field(default_factory=lambda: new_id("ai-"))
    title: str = ""
    owner: str | None = None
    status: str = "open"                  # open | in_progress | done
    created_at: str = Field(default_factory=iso_now)
    note: str = ""


class ShiftAck(BaseModel):
    """One analyst's acknowledgement of a shift handoff window (Round 3 standup). A
    user confirms they have read the handoff for a given ``window``. ``note`` is plain
    data. Persisted in the SHIFT_HANDOFF KV namespace."""

    user: str = ""
    window: str = ""                      # e.g. "2026-06-30/day"
    at: str = Field(default_factory=iso_now)
    note: str = ""


class TraceSpan(BaseModel):
    """One span in an agent-pipeline execution trace (Round 3 observability). A richer,
    structured sibling of :class:`TraceStep` (which projects an AuditDoc): a TraceSpan
    records ONE step of the LangGraph pipeline with timing + cost + token + trust
    metadata so the UI can render a waterfall. ``trusted`` is False when the span's
    ``summary``/payload carries fenced UNTRUSTED log data (the UI renders those as code
    blocks, #9). ``payload_ref`` POINTS at the heavy payload (e.g. an audit doc id)
    rather than inlining it. Advisory/observability only — never feeds #3."""

    id: str = Field(default_factory=lambda: new_id("span-"))
    case_id: str = ""
    step_index: int = 0
    kind: str = ""                        # invoke_agent | chat | execute_tool | decision
    name: str = ""
    ts: str = Field(default_factory=iso_now)
    latency_ms: int | None = None
    cost: float | None = None
    tokens: int | None = None
    trusted: bool = True
    summary: str = ""
    payload_ref: dict[str, Any] = Field(default_factory=dict)


class StageRiskFactor(BaseModel):
    """One deterministic risk input and its exact term in the weighted sum.

    ``value`` is the persisted, normalised 0–100 factor score. ``weight`` is the
    currently configured coefficient. ``weighted_value`` is the numerator term
    (``value * weight``), while ``contribution`` is that term divided by the
    calculation denominator and therefore expressed in final risk-score points.
    Read-time explainability only; none of these fields feed scoring or decide().
    """

    factor: str = ""
    label: str = ""
    value: float = 0.0
    weight: float = 0.0
    weighted_value: float = 0.0
    contribution: float = 0.0


class StageRiskCalculation(BaseModel):
    """Reproducible arithmetic behind a Timeline risk score.

    The factor values are persisted on the Case; weights are read from the current
    Preferences at projection time. ``matches_displayed_score`` makes a historical
    weight change visible instead of pretending the current configuration produced
    an older stored score.
    """

    factors: list[StageRiskFactor] = Field(default_factory=list)
    numerator: float = 0.0
    denominator: float = 1.0
    calculated_score: float = 0.0
    recorded_score: float = 0.0
    displayed_score: int = 0
    matches_displayed_score: bool = True
    weight_basis: str = "current_preferences"


class StageState(BaseModel):
    """Derived scalars/labels at a stage (safe to render inline; never raw source text)."""

    severity: float | None = None
    severity_band: str | None = None
    severity_source: str | None = None       # "source_asserted" | "derived"
    risk_score: float | None = None
    risk_calculation: StageRiskCalculation | None = None
    verdict: str | None = None
    confidence: float | None = None


class StageStep(BaseModel):
    """A chronological sub-step under a stage. trusted=False ⇒ body is fenced UNTRUSTED (#9)."""

    kind: str = ""            # reasoning | tool | knowledge | memory | note
    label: str = ""
    body: str = ""
    trusted: bool = True
    ts: str | None = None


class TimelineStage(BaseModel):
    """One of the six ordered pipeline stages of the Timeline narrative. Read-time
    projection over Case + audit rows; advisory only, never feeds decide() (#3).
    ``headline`` is always our TRUSTED prose (source specifics go in a fenced step)."""

    id: str = ""
    kind: str = ""            # input | correlate | risk | triage | investigate | decide
    label: str = ""
    status: str = "done"      # done | skipped | pending
    deterministic: bool = False
    ts: str | None = None
    headline: str = ""
    state: StageState = Field(default_factory=StageState)
    steps: list[StageStep] = Field(default_factory=list)


class TimelineStagesResponse(BaseModel):
    """``GET /api/cases/{id}/stages`` — the six ordered stages. Never 404s."""

    case_id: str = ""
    stages: list[TimelineStage] = Field(default_factory=list)
    total: int = 0


# --------------------------------------------------------------------------- #
# Round 4 scaffolding — cross-case campaigns / anomaly-baseline sketch state /
# batch-inference jobs / a unified detection-rule carrier. ALL of these are NEW
# additive contracts with sane defaults; later waves add the BEHAVIOUR (clustering,
# the streaming baseline detector, the batch submit/poll/retrieve loop, and the
# migrate-on-read rule unifier). They are NOT wired into the pipeline here and NONE
# of them is read by ``engine/case_manager.decide()`` (#3). Every free-text field that
# can carry source-influenceable text (an entity ``value``, a MITRE id) is PLAIN DATA:
# the UI render-escapes it and it is never interpolated UNFENCED into a prompt (#9).
# --------------------------------------------------------------------------- #
class CampaignEntity(BaseModel):
    """One entity that ties cases together within a campaign (Round 4). A compact
    ``{entity_type, value}`` pair — the SAME shape as :class:`Entity` but kept as a
    plain typed pair (loose ``entity_type`` str) so cross-source/unknown kinds
    round-trip. ``value`` is source-derived (UNTRUSTED — plain data, never a prompt
    instruction, #9)."""

    entity_type: str = ""
    value: str = ""


class Campaign(BaseModel):
    """A cross-case CAMPAIGN — a running group of related cases (Round 4 campaign
    clustering). Cases are grouped by shared ``entities`` + overlapping ``mitre``
    techniques into one incident narrative the UI surfaces above the case list.

    IDENTITY: a campaign's identity is the hash of its members' sorted
    ``cluster_signature`` values (so the SAME set of member clusters always resolves
    to the SAME campaign id, idempotently). The hash is NOT implemented here — this
    model only CARRIES the data; a later wave computes + assigns ``id``.

    ADVISORY: a campaign is presentation/reporting only. It NEVER force-merges cases
    (each case keeps its 1:1 cluster signature, #4) and NEVER feeds the deterministic
    case decision (#3). All free-text is plain data (#9)."""

    id: str = ""
    name: str = ""
    case_ids: list[str] = Field(default_factory=list)
    entities: list[CampaignEntity] = Field(default_factory=list)
    mitre: list[str] = Field(default_factory=list)
    first_seen: str | None = None
    last_seen: str | None = None
    # A rolled-up severity label for the campaign (e.g. "critical"/"high"/…) a later
    # wave derives from its member cases. Plain data — never feeds #3.
    severity_rollup: str | None = None
    status: CampaignStatus = CampaignStatus.OPEN
    created_at: str = Field(default_factory=iso_now)


class BaselineState(BaseModel):
    """Compact, JSON-serialisable ANOMALY-BASELINE sketch state (Round 4 anomaly
    detection). One instance holds the streaming summary statistics for ONE keyed
    series (e.g. per-source event volume per hour-of-week bucket) so the detector can
    flag a modified-z-score deviation WITHOUT storing raw history — it stays small
    enough to live in the BASELINE KV document.

    * ``welford_m``/``welford_s``/``n`` — Welford's online mean (``m``) + sum-of-
      squared-deviations (``s``) + count, for a numerically-stable running variance.
    * ``ewma``/``ewma_sq`` — exponentially-weighted moving average of the value and of
      its square (for a decaying variance), or ``None`` until the first observation.
    * ``tdigest`` — a compact serialisable t-digest quantile sketch as a list of
      ``[mean, weight]`` centroids (empty until warmed).
    * ``n_samples`` — total observations folded in; ``warm`` flips True once enough
      samples accumulate for the estimate to be trusted. ``version`` tags the sketch
      layout for forward-compatible migration.

    ADVISORY: baselines surface anomaly candidates for triage; they NEVER feed the
    deterministic case decision (#3)."""

    welford_m: float = 0.0
    welford_s: float = 0.0
    n: int = 0
    ewma: float | None = None
    ewma_sq: float | None = None
    tdigest: list[list[float]] = Field(default_factory=list)  # [[mean, weight], ...] centroids
    n_samples: int = 0
    warm: bool = False
    version: int = 1


class BatchInboxAudience(BaseModel):
    """One generation-bound recipient in a BatchJob's durable Inbox outbox."""

    username: str = Field(default="", max_length=160)
    account_generation: str = Field(default="", max_length=64)
    state: Literal["pending", "projected", "revoked"] = "pending"
    projection_signature: str = Field(default="", pattern=r"^(?:[0-9a-f]{64})?$")


class BatchJob(BaseModel):
    """One async BATCH-inference job (Round 4 batch LLM). Tracks a batch of LLM calls
    submitted to a provider's async batch API (Anthropic/OpenAI ~50% discounted) so a
    later wave can submit → poll → retrieve results out-of-band.

    * ``provider``/``provider_batch_id`` — which provider + its returned batch id.
    * ``state`` — a :class:`app.constants.BatchJobState` value (submit→poll→retrieve).
    * ``custom_ids`` — per-request tracking keyed by our ``custom_id``; each value is
      ``{retrieved: bool, result_state: str|None}`` so partial retrieval is safe.
    * ``model`` — the model the batch runs; ``discount`` the applied price multiplier
      (0.5 == 50% off) a later wave threads onto the resulting :class:`UsageDoc`.
    * ``candidates`` — for an EVENT-detection batch, the surviving funnel candidates keyed
      by ``custom_id`` (each an aggregate summary + its member events + detection_source),
      persisted at submit so the batch scheduler can reconstruct them when confirmations
      return and RE-ENTER the pipeline on the SAME correlate path (byte-identical
      ``cluster_signature`` #4). Empty for a non-detection batch — purely additive.

    ADVISORY plumbing — a batch job never touches the deterministic decision (#3), and
    #6 is preserved (one UsageDoc per resolved call when results are folded back in)."""

    id: str = Field(default_factory=lambda: new_id("batch-"))
    provider: str = ""
    provider_batch_id: str | None = None
    state: BatchJobState = BatchJobState.SUBMITTED
    custom_ids: dict[str, dict[str, Any]] = Field(default_factory=dict)  # custom_id -> {retrieved, result_state}
    model: str = ""
    discount: float = 0.5
    submitted_at: str | None = None
    polled_at: str | None = None
    # Durable LOCAL submission outbox.  Requests are persisted before a provider
    # network call, allowing the scheduler to retry a failed/crashed submit without
    # advancing the EVENT-feed cursor past unaccepted work.  Old jobs load unchanged.
    requests: list[dict[str, Any]] = Field(default_factory=list)
    submit_attempts: int = 0
    last_error: str | None = None
    # Strict provider-submission lease shared by the immediate submit path and the
    # out-of-band scheduler.  Without it, both can observe the same durable outbox
    # row before ``provider_batch_id`` is saved and call the provider concurrently.
    # The timestamp makes an abandoned lease reclaimable after a bounded interval.
    submission_lease_token: str | None = None
    submission_lease_at_millis: int = 0
    # EVENT-detection re-entry payload (Wave-6). custom_id -> serialised CandidateAlert
    # (see engine/event_detection.candidate_to_json). Additive; default empty.
    candidates: dict[str, dict[str, Any]] = Field(default_factory=dict)
    # Personal Inbox projection is a durable OUTBOX over a strict snapshot of the
    # active accounts that held ``models:read`` when this batch was accepted. Old
    # rows default to ``legacy`` and are intentionally list-only: we never guess a
    # historical audience after the fact. A new row is ``pending`` only when the
    # security snapshot could not be read; the reconciler retries without blocking
    # the provider/security workflow. Per-recipient state makes a crash between the
    # Inbox CAS and this acknowledgement safe (the same stable note is upserted).
    inbox_audience_state: Literal["legacy", "pending", "ready"] = "legacy"
    inbox_audience: list[BatchInboxAudience] = Field(default_factory=list, max_length=200)
    inbox_audience_truncated: int = Field(default=0, ge=0)
    # Terminal compaction keeps the shared single-document registry bounded. The
    # aggregate counts survive after request/custom-id/candidate payloads are scrubbed.
    summary_total: int = Field(default=0, ge=0)
    summary_retrieved: int = Field(default=0, ge=0)
    summary_failed: int = Field(default=0, ge=0)
    terminal_compacted: bool = False


class DetectionRule(BaseModel):
    """A COMPOSITE detection rule carrier (Round 4) — the migrate-on-read seam that a
    later wave uses to UNIFY the two halves of a detection into one shape:

    * the CLASSIFY half — a match spec (which raw events belong to this rule), today
      carried by :class:`app.config.RuleDefinition`; and
    * the FIRE half — a trigger/correlation spec (when a group of matched events fires
      a case), today carried by :class:`app.config.CorrelationRule`.

    This model REFERENCES those two halves as loose dicts (``match`` + ``trigger``) so
    it can be assembled from — and migrated back to — the existing config models
    without a config↔config import cycle. It is a DEFAULTED CARRIER ONLY: correlation
    is NOT rewired to consume it this wave. ``source`` is a
    :class:`app.constants.DetectionSource` value (detection|anomaly|rule). ADVISORY —
    never feeds the deterministic decision (#3)."""

    model_config = {"protected_namespaces": ()}

    id: str = Field(default_factory=lambda: new_id("det-"))
    name: str = ""
    enabled: bool = True
    description: str = ""
    source: str = "detection"             # DetectionSource value
    # The CLASSIFY half — a RuleMatch/RuleDefinition-shaped dict (field/op/value). Loose
    # dict to avoid a config import cycle; a later wave validates it into RuleDefinition.
    match: dict[str, Any] = Field(default_factory=dict)
    # The FIRE half — a CorrelationRule-shaped dict (mode/n/window_seconds/group_by).
    trigger: dict[str, Any] = Field(default_factory=dict)
    priority: int = 100
    tags: list[str] = Field(default_factory=list)


# --------------------------------------------------------------------------- #
# Section 7.1 — tlsoc-agent-cases-*
# --------------------------------------------------------------------------- #
class Case(BaseModel):
    case_id: str
    cluster_signature: str
    # Immutable creation-build provenance.  New cases are stamped explicitly by
    # their producer; legacy rows remain None even when a later build reads or updates
    # them, so deployment boundaries are never reconstructed from invented history.
    app_version: str | None = None
    build_sha: str | None = None
    created_at: str = Field(default_factory=iso_now)
    updated_at: str = Field(default_factory=iso_now)
    source_surface: SourceSurface
    # The FIRST surface this case was ever created from. Unlike ``source_surface``
    # (which is preserved from the original creation), this never changes and is a
    # stable provenance marker for the UI (P1).
    origin_surface: SourceSurface | None = None
    rule_ids: list[str] = Field(default_factory=list)
    entity: Entity
    # Originating source (multi-source provenance; enables UI filter-by-source).
    # Derived from the cluster's member events at creation; default None == the
    # legacy single implicit source (full back-compat).
    source_id: str | None = None
    source_name: str | None = None
    member_event_ids: list[str] = Field(default_factory=list)
    member_event_keys: list[str] = Field(default_factory=list)
    risk_score: float = 0.0
    verdict: Verdict | None = None
    confidence: float = 0.0
    evidence: list[EvidenceItem] = Field(default_factory=list)
    mitre: list[str] = Field(default_factory=list)
    recommended_action: str = ""
    reproduce_query: str = ""
    status: CaseStatus = CaseStatus.OPEN
    # Investigative OUTCOME axis (status taxonomy / F8) — orthogonal to ``status``
    # (lifecycle). Defaulted None so old stored cases load unchanged; populated in
    # CaseManager.apply() from the verdict (when unset) or refined by an analyst.
    disposition: Disposition | None = None
    # Free-text reason for the current lifecycle state (why on hold / how resolved).
    status_reason: str = ""
    # Legacy compatibility flag. Older stored cases and clients use this integer
    # wire key, but current operator surfaces expose only the Escalated lifecycle
    # state, never numbered tiers. Any positive value means escalated.
    escalation_level: int = Field(
        default=0,
        title="Escalated compatibility flag",
        description=(
            "Legacy storage compatibility: zero means not escalated and any positive "
            "value means Escalated. Operator surfaces do not display numbered tiers."
        ),
        json_schema_extra={"deprecated": True},
    )
    # Append-only lifecycle transition trail (from→to, by, when, reason).
    status_history: list[StatusHistoryEntry] = Field(default_factory=list)
    # Human-facing DISPLAY id (template-driven, F7). ``case_id`` stays the immutable
    # internal id; ``case_number`` is "" until set at creation (then renders e.g.
    # "CASE-000001"). The UI falls back to ``case_id`` when empty.
    case_number: str = ""
    decision_by: DecisionBy | None = None
    objection_window_expires_at: str | None = None
    # The specialized investigator persona deterministically assigned to this case
    # (multi-agent roster, Vigil-inspired). Empty == the generalist. Recorded for
    # the UI/audit so you can see WHICH specialist handled the cluster.
    agent_persona: str = ""
    # The Markdown playbook selected for this case (deterministic match), empty when
    # none matched / playbooks disabled. Recorded for the UI/audit "why".
    # Round 14 (SPEC §4.10.9): kept readable for stored cases and never written by new
    # code; readers prefer ``runbook_id``.
    playbook_id: str = ""
    # Round 14 (SPEC §4.10.9): the Published runbook (built-in or operator) whose
    # guidance the investigator received, and its version. ``None`` on every case
    # investigated before Round 14 or with no matching runbook; history is never
    # rewritten. Advisory provenance only, never read by ``decide()`` (#3).
    runbook_id: str | None = None
    runbook_version: int | None = None
    # Append-only analyst feedback on the AI verdict (the eval/quality loop).
    feedback: list[FeedbackEntry] = Field(default_factory=list)
    # Collaboration: free-form analyst tags, threaded comments, and an owner.
    tags: list[str] = Field(default_factory=list)
    comments: list[CaseComment] = Field(default_factory=list)
    assignee: str = ""
    # Helpful, non-contract-breaking extras for the UI / audit:
    title: str = ""
    summary: str = ""
    # Explicit machine-readable reason an undecided candidate is waiting. In
    # particular, ``deferred:`` candidates are durably drained on a later tick.
    awaiting_reason: str = ""
    risk_breakdown: RiskBreakdown = Field(default_factory=RiskBreakdown)
    token_cost: float = 0.0
    error: str | None = None
    # --- Round 3 ADVISORY triage axes (severity / impact / urgency / priority + SLA
    # lifecycle timestamps). ALL optional + defaulted None so old stored cases load
    # unchanged. ⚠ NON-NEGOTIABLE #3: these are PRESENTATION/REPORTING ONLY — they
    # are NEVER read by ``engine/case_manager.decide()`` and MUST NOT be (the close/
    # escalate decision stays a pure fn of verdict/confidence/risk_score/policy).
    # ``severity_band`` is the human label (e.g. "critical"/"high"/...) a later wave
    # derives or copies from the source; ``severity_source`` records whether it was
    # asserted by the source ("source_asserted") or derived by us ("derived").
    # ``impact_band``/``urgency_band`` feed the ITIL ``priority_level`` ("P1".."P4")
    # via the PriorityMatrix; none of them ever changes the deterministic verdict.
    severity_band: str | None = None
    severity_source: str | None = None       # "source_asserted" | "derived"
    impact_band: str | None = None
    urgency_band: str | None = None
    priority_level: str | None = None         # "P1" | "P2" | "P3" | "P4"
    # Lifecycle interval anchors for SLA / MTTR derivation (additive). ``created_at``
    # already exists (string ISO); these add the optional detection / acknowledgement /
    # first-response instants so response-time intervals derive cleanly. Defaulted None
    # → no SLA interval is asserted until a later wave populates them.
    detected_at: datetime | None = None
    acknowledged_at: datetime | None = None
    first_response_at: datetime | None = None
    # Epoch-millis of the EARLIEST member event of the originating cluster (the
    # cluster's ``first_seen_millis``). Populated at case creation from the cluster;
    # 0 for old stored cases / cases with no timed events. ⚠ NON-NEGOTIABLE #3: this is
    # REPORTING ONLY — it is the input to the advisory MTTD (mean-time-to-detect =
    # ``created_at`` − ``first_seen_millis``) rollup and is NEVER read by
    # ``engine/case_manager.decide()`` (its name MUST stay OUT of case_manager.py).
    first_seen_millis: int = 0
    # --- Round 4 ADVISORY provenance (campaign membership + detection source). BOTH
    # optional + defaulted None so old stored cases load unchanged. ⚠ NON-NEGOTIABLE #3:
    # these are PRESENTATION/REPORTING ONLY — they are NEVER read by
    # ``engine/case_manager.decide()`` and their names MUST stay OUT of case_manager.py.
    # ``campaign_id`` links this case into a cross-case :class:`Campaign` (never a
    # force-merge — the 1:1 cluster signature is untouched, #4); ``detection_source`` is
    # a :class:`app.constants.DetectionSource` value (detection|anomaly|rule). ---
    campaign_id: str | None = None
    detection_source: str | None = None
    history: list[dict[str, Any]] = Field(default_factory=list)
    # Append-only verdict trail: {ts, verdict, confidence, risk_score} on each
    # investigation. Lets the UI show how a case's verdict evolved (P1).
    verdict_history: list[dict[str, Any]] = Field(default_factory=list)
    # Deterministic "why was this triggered" explanation (Feature 3).
    trigger_reason: TriggerReason | None = None
    # Append-only record of outbound notifications fired for this case (F5). Each
    # entry is ``{ts, trigger, channel_id, channel_type, ok, detail}`` — the detail
    # is redacted (never a secret). Additive + defaulted so old cases load unchanged.
    notifications_sent: list[dict[str, Any]] = Field(default_factory=list)
    # Cross-source correlation (Wave 5 / F6). ALL additive/defaulted — the per-cluster
    # 1:1 signature stays intact; cross-source linking only ADDS these RELATED markers
    # and NEVER force-merges or changes the existing cluster signature. ``related_case_ids``
    # are OTHER open cases (from other sources) that share an entity within the window;
    # ``cross_source_cluster_id`` is the stable id of that cross-source group (the SAME
    # value on every member case); ``source_breakdown`` maps source_id -> contributing
    # event count for the multi-source UI. Empty/zero out of the box (cross-source OFF).
    related_case_ids: list[str] = Field(default_factory=list)
    cross_source_cluster_id: str = ""
    source_breakdown: dict[str, int] = Field(default_factory=dict)
    # Threshold automation (Wave 6 / F10). Append-only audit list of the post-decision
    # automation actions matched + applied for this case. Each entry is
    # ``{ts, rule_id, action, detail, proposal_id?}`` — a NON-BINDING record. Automation
    # NEVER sets status/disposition (#3): SAFE actions (tag/recommend/notify/run_playbook)
    # apply directly; ``request_approval`` only records that a HITL Proposal was created.
    automation_actions: list[dict[str, Any]] = Field(default_factory=list)
    # Reusable-knowledge loop (Wave 6 / F11). Cumulative record of the retrieved
    # knowledge (resolved cases / threat-intel) surfaced for this case — each entry is
    # ``{source, snippet, score?}``.  Keep the historical array wire shape so older
    # generated clients never receive a surprise ``null``.  The separate observation
    # status below is authoritative: an empty list is a measured zero ONLY when that
    # status is ``measured``.
    knowledge_used: list[dict[str, Any]] = Field(default_factory=list)
    # Authoritative lifetime-history marker.  New case producers set ``available`` at
    # creation so a later completed attempt can be interpreted; a pre-marker case stays
    # ``unavailable`` forever even if a modern reinvestigation adds some references,
    # because its earlier lifetime cannot be reconstructed.
    retrieval_history_status: Literal["available", "unavailable"] = "unavailable"
    # Whether this case has at least one completed, instrumented retrieval attempt.
    # ``not_measured`` is used for new, history-available cases whose RAG path has not
    # completed (whether skipped or interrupted); legacy rows default to
    # ``unavailable``.  This marker—not
    # list presence—is what makes ``knowledge_used=[]`` an observed zero.
    retrieval_observation_status: Literal[
        "measured", "not_measured", "unavailable"
    ] = "unavailable"
    # The deterministic rule-identity precedent fact this investigation was given, and
    # WHY it did or did not qualify (``engine.precedent.PrecedentSignal.as_dict()``).
    # Additive and nullable: ``None`` means the run predates the seam or never reached
    # the investigator, never "no precedent exists" — an explicit ``status`` says which.
    # Recorded so a close that leaned on analyst precedent is auditable and reversible,
    # and so a NEEDS_HUMAN that ignored abundant precedent explains itself. NEVER read
    # by ``engine.case_manager.decide()`` (#3) — it is evidence, not authority.
    precedent_signal: dict[str, Any] | None = None
    # The operator declaration that closed this case without an LLM call, when one did
    # (``engine.precedent.AnalystPolicyMatch.as_dict()``). ``None`` on every ordinary
    # case. Paired with ``decision_by == analyst_policy``.
    analyst_policy: dict[str, Any] | None = None

    @field_validator("knowledge_used", mode="before")
    @classmethod
    def _legacy_null_knowledge_is_unavailable_empty(cls, value: Any) -> Any:
        """Keep the array wire shape even if a transitional/handwritten row has null.

        The authoritative status fields remain unavailable by default, so coercing
        null to an empty array cannot fabricate a measured zero.
        """
        return [] if value is None else value


# --------------------------------------------------------------------------- #
# Section 7.2 — tlsoc-agent-audit-* (append-only)
# --------------------------------------------------------------------------- #
# Round 14 (SPEC §4.5.3): the structured fields a new audit row may carry. Every one
# is optional and written at append time only; there is no backfill. Values that come
# from a caller (a user agent, a forwarded header, a setting value) are bounded here so
# an audit append never fails because the caller sent something long.
AuditOutcome = Literal["success", "failure", "denied", "partial", "unknown"]
AUDIT_OUTCOMES: tuple[str, ...] = get_args(AuditOutcome)
AuditActorType = Literal["human", "agent", "system", "service"]
AUDIT_ACTOR_TYPES: tuple[str, ...] = get_args(AuditActorType)
AuditTargetType = Literal[
    "case", "user", "role", "source", "setting", "job", "rule", "runbook", "dashboard", "export",
]
AUDIT_TARGET_TYPES: tuple[str, ...] = get_args(AuditTargetType)
#: ``AuditDoc.action``: ``<resource>.<verb>`` (``auth.login``, ``runbook.publish_failed``).
AUDIT_ACTION_PATTERN = r"^[a-z_]+\.[a-z_]+$"
_AUDIT_ACTION_RE = re.compile(r"[a-z_]+\.[a-z_]+")
AUDIT_ACTION_MAX_CHARS = 64
#: ``X-Request-ID`` is honoured only in this alphabet; otherwise a UUIDv4 is minted.
AUDIT_REQUEST_ID_PATTERN = r"^[A-Za-z0-9._-]{8,64}$"
#: ``session_ref``: the first 16 hex characters of an HMAC of the session id.
AUDIT_SESSION_REF_PATTERN = r"^[0-9a-f]{16}$"
AUDIT_FORWARDED_FOR_MAX_CHARS = 256
AUDIT_USER_AGENT_MAX_CHARS = 512
AUDIT_TARGET_ID_MAX_CHARS = 256
AUDIT_TARGET_LABEL_MAX_CHARS = 200
AUDIT_ROLE_MAX_CHARS = 64
AUDIT_RUN_ID_MAX_CHARS = 128
AUDIT_MAX_CHANGES = 50
AUDIT_CHANGE_VALUE_MAX_CHARS = 500
AUDIT_CHANGE_FIELD_MAX_CHARS = 200
#: Every free-text audit field is capped at this length when written (the inspector
#: says "Stored truncated at 1,000 characters" for a field that hit it).
AUDIT_TEXT_WRITE_CAP = 1_000


def _clip_text(value: Any, limit: int) -> Any:
    """Cut a string to ``limit`` characters; any other value passes to validation."""
    return value[:limit] if isinstance(value, str) else value


_IPV4_WITH_PORT_RE = re.compile(r"(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}")
_BRACKETED_IPV6_RE = re.compile(r"\[([^\]]{1,64})\](?::\d{1,5})?")


def normalise_audit_ip(value: Any) -> str | None:
    """A client address as Elasticsearch's ``ip`` type stores it, or ``None``.

    ``client.ip`` is mapped as type ``ip`` (SPEC §4.5.3), which rejects the WHOLE
    document for an empty or non-address value, so an audit row must never carry one.
    Accepts IPv4, IPv6, a bracketed IPv6 (``[2001:db8::1]:443``), an ``address:port``
    IPv4 and an IPv6 zone (``fe80::1%eth0``, the zone is dropped); returns the
    canonical text. Anything else (``""``, ``"testclient"``, ``"unix:"``, a host name)
    returns ``None``: the raw value stays readable in ``peer`` or ``forwarded_for``.
    A value that is not a string is left to validation (a programming error)."""
    if value is None or not isinstance(value, str):
        return value
    text = value.strip()
    if not text or len(text) > 100:
        return None
    bracketed = _BRACKETED_IPV6_RE.fullmatch(text)
    if bracketed:
        text = bracketed.group(1)
    else:
        with_port = _IPV4_WITH_PORT_RE.fullmatch(text)
        if with_port:
            text = with_port.group(1)
    text = text.split("%", 1)[0]
    try:
        return str(ipaddress.ip_address(text))
    except ValueError:
        return None


class AuditClient(BaseModel):
    """Where a request-driven audit row came from (SPEC §4.5.3, personal data, D9).

    ``ip`` is believed from a forwarded header only when the socket peer is a named
    trusted proxy, and then only the rightmost entry (``ip_source="trusted_proxy"``);
    otherwise it is the socket peer (``ip_source="peer"``) whatever the caller sent.
    ``ip`` is always a parsed address or ``None`` (:func:`normalise_audit_ip`): it is
    mapped as Elasticsearch type ``ip``, which refuses the whole row for ``""`` or a
    non-address such as a Unix-socket peer. ``peer`` keeps the raw socket address as
    text. ``forwarded_for`` keeps the raw header as untrusted text, never used to
    filter or group. Values are bounded on write."""

    ip: str | None = Field(default=None, max_length=64)
    ip_source: Literal["peer", "trusted_proxy"] = "peer"
    peer: str = Field(default="", max_length=64)
    forwarded_for: str | None = None
    user_agent: str = ""

    @field_validator("ip", mode="before")
    @classmethod
    def _parsed_address(cls, value: Any) -> Any:
        return normalise_audit_ip(value)

    @field_validator("peer", mode="before")
    @classmethod
    def _bounded_address(cls, value: Any) -> Any:
        return "" if value is None else _clip_text(value, 64)

    @field_validator("forwarded_for", mode="before")
    @classmethod
    def _bounded_forwarded_for(cls, value: Any) -> Any:
        return _clip_text(value, AUDIT_FORWARDED_FOR_MAX_CHARS)

    @field_validator("user_agent", mode="before")
    @classmethod
    def _bounded_user_agent(cls, value: Any) -> Any:
        return "" if value is None else _clip_text(value, AUDIT_USER_AGENT_MAX_CHARS)


class AuditTarget(BaseModel):
    """What an audit row acted on: ``{type, id, label, revision}`` (SPEC §4.5.3,
    §3.6). ``label`` is the human name at the time (a case number, a dashboard name)
    and is plain data. ``revision`` is the store revision the write creates, written
    by ``audited_write`` on the action row BEFORE the store write: if the process
    stops between the two, a reader can see that the named revision never existed
    (the documented crash limit). ``None`` for targets without a revision."""

    type: AuditTargetType
    id: str = Field(min_length=1, max_length=AUDIT_TARGET_ID_MAX_CHARS)
    label: str = ""
    revision: int | None = Field(default=None, ge=0)

    @field_validator("id", mode="before")
    @classmethod
    def _bounded_id(cls, value: Any) -> Any:
        return _clip_text(value, AUDIT_TARGET_ID_MAX_CHARS)

    @field_validator("label", mode="before")
    @classmethod
    def _bounded_label(cls, value: Any) -> Any:
        return "" if value is None else _clip_text(value, AUDIT_TARGET_LABEL_MAX_CHARS)


def _audit_change_text(value: Any) -> Any:
    """A changed value as the text ``AuditChange`` stores (``str | None``).

    Settings, role and rule values are often numbers, booleans, lists or objects. They
    become canonical JSON text (``20``, ``true``, ``["a", "b"]``, sorted keys) so a
    writer that forgets to stringify one can never fail the audit-first append (a
    failed append refuses the user's write with ``503 audit_unavailable``)."""
    if value is None or isinstance(value, str):
        return value
    try:
        return json.dumps(value, sort_keys=True, ensure_ascii=False, default=str)
    except (TypeError, ValueError):  # a circular or unsortable structure
        return str(value)


class AuditChange(BaseModel):
    """One changed field in a settings, user, role, rule or runbook write (SPEC
    §4.5.3). A secret is written as ``{field, before: None, after: None, secret:
    True}``; a URL is reduced to scheme and host by the writer, which sets ``secret``
    when anything was removed. A value that is not text is stored as canonical JSON
    text (:func:`_audit_change_text`); ``before`` and ``after`` are cut to 500
    characters."""

    field: str = Field(min_length=1, max_length=AUDIT_CHANGE_FIELD_MAX_CHARS)
    before: str | None = None
    after: str | None = None
    secret: bool = False

    @field_validator("field", mode="before")
    @classmethod
    def _bounded_field(cls, value: Any) -> Any:
        return _clip_text(value, AUDIT_CHANGE_FIELD_MAX_CHARS)

    @field_validator("before", "after", mode="before")
    @classmethod
    def _bounded_value(cls, value: Any) -> Any:
        return _clip_text(_audit_change_text(value), AUDIT_CHANGE_VALUE_MAX_CHARS)


#: The Round 14 ``AuditDoc`` keys. A row that leaves one unset is stored without the
#: key, so every row written by a writer that does not use them keeps its exact
#: pre-Round-14 shape (and a keyed retry across the upgrade still matches its first
#: append). Readers treat an absent key as "not recorded".
AUDIT_ROUND14_FIELDS: tuple[str, ...] = (
    "outcome", "actor_type", "action", "actor_role", "client", "session_ref",
    "target", "changes", "request_id", "run_id",
)


class AuditDoc(BaseModel):
    # Optional deterministic idempotency key for privileged append-only events.
    # Proposal decisions use this so a retry after an ambiguous response confirms
    # the same evidence row instead of appending a duplicate. Ordinary telemetry
    # keeps the historical auto-id behaviour.
    event_id: str | None = None
    # Producing build for this immutable append.  None is reserved for historical rows
    # written before record-level build provenance existed.
    app_version: str | None = None
    build_sha: str | None = None
    ts: str = Field(default_factory=iso_now)
    case_id: str | None = None
    # Coverage observability (A5.3): the source this action pertains to (e.g. the poller's
    # connector_id / a push receiver's source_id). Additive + optional — old audit docs
    # simply lack it and ES/SQL tolerate the unset field like every other optional one —
    # so the append-only trail becomes a real per-source poll history (GET /api/audit?
    # source_id=). Advisory provenance only; never read by ``decide()`` (#3).
    source_id: str | None = None
    surface: str = ""
    actor: str = ""                 # which agent role / analyst id
    action_type: ActionType
    model: str | None = None
    prompt_excerpt: str | None = None       # log fields delimited & labelled untrusted
    query_text: str | None = None           # exact ES|QL/DSL issued (reproducible)
    tool_name: str | None = None
    tool_input: Any = None
    tool_output_summary: str | None = None
    result_summary: str | None = None
    # --- Round 14 (SPEC §4.5.3; additive, optional, new rows only, no backfill). ---
    # How the action ended. Legacy rows carry none; readers derive ``denied`` for
    # ``access_denied`` and ``failure`` for ``error`` and mark it derived.
    outcome: AuditOutcome | None = None
    # Who acted: a person, the AI agent, the system, or a service acting for a person.
    actor_type: AuditActorType | None = None
    # The structured event name, ``<resource>.<verb>`` (``auth.login``,
    # ``settings.updated``, ``runbook.published``). ``action_type`` stays the coarse
    # category every existing reader and filter keeps using.
    action: str | None = Field(default=None, max_length=AUDIT_ACTION_MAX_CHARS, pattern=AUDIT_ACTION_PATTERN)
    # The actor's role at the time of a request-driven write.
    actor_role: str | None = Field(default=None, max_length=AUDIT_ROLE_MAX_CHARS)
    client: AuditClient | None = None
    session_ref: str | None = Field(default=None, pattern=AUDIT_SESSION_REF_PATTERN)
    target: AuditTarget | None = None
    changes: list[AuditChange] | None = None
    request_id: str | None = Field(default=None, pattern=AUDIT_REQUEST_ID_PATTERN)
    # One id per investigation run, so the Agent activity scope can group its rows.
    run_id: str | None = Field(default=None, max_length=AUDIT_RUN_ID_MAX_CHARS)

    @field_validator("actor_role", mode="before")
    @classmethod
    def _bounded_actor_role(cls, value: Any) -> Any:
        return _clip_text(value, AUDIT_ROLE_MAX_CHARS)

    @field_validator("changes", mode="before")
    @classmethod
    def _bounded_changes(cls, value: Any) -> Any:
        """At most :data:`AUDIT_MAX_CHANGES` entries, in the writer's order."""
        if isinstance(value, (list, tuple)):
            return list(value)[:AUDIT_MAX_CHANGES]
        return value

    # No return annotation on purpose: pydantic then keeps the field-based schema
    # (an annotated ``dict`` would publish an untyped object).
    @model_serializer(mode="wrap")
    def _omit_unset_round14(self, handler: Any):  # noqa: ANN202
        data = handler(self)
        if isinstance(data, dict):
            for key in AUDIT_ROUND14_FIELDS:
                if key in data and data[key] is None:
                    del data[key]
        return data


class TraceStep(BaseModel):
    """One agent-pipeline step surfaced from tlsoc-agent-audit (C3-3).

    A read-only projection of an ``AuditDoc`` for the case-detail trace timeline.
    All fields optional except ``ts``/``actor``. ``prompt_excerpt`` /
    ``tool_output_summary`` carry fenced UNTRUSTED log data — the FE renders them
    in code blocks; the trace endpoint can omit ``prompt_excerpt`` when
    ``prefs.trace.include_prompts`` is false."""

    ts: str = ""
    app_version: str | None = None
    build_sha: str | None = None
    actor: str = ""
    action_type: str | None = None
    model: str | None = None
    query_text: str | None = None
    tool_name: str | None = None
    tool_input: Any = None
    tool_output_summary: str | None = None
    result_summary: str | None = None
    prompt_excerpt: str | None = None


# --------------------------------------------------------------------------- #
# Section 7.3 — tlsoc-agent-usage-* (token & cost ledger)
# --------------------------------------------------------------------------- #
class UsageDoc(BaseModel):
    # Producing build for this immutable ledger append.  Historical rows remain None;
    # newly persisted rows carry an explicit SHA or the honest literal ``unknown``.
    app_version: str | None = None
    build_sha: str | None = None
    ts: str = Field(default_factory=iso_now)
    surface: str = ""
    case_id: str | None = None
    role: str = ""
    model: str = ""
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    cost: float = 0.0
    currency: str = "USD"
    latency_ms: int = 0
    outcome: UsageOutcome = UsageOutcome.OK
    # Provenance of the price used: exact | heuristic | zero | default (Vigil-
    # inspired). Lets the cost surface badge an approximate cost vs a verified one.
    pricing_source: str = "exact"
    # --- Round 4 (ALL additive + defaulted → old stored usage docs load unchanged).
    # The gateway now applies prompt-cache and Batch/Flex rates when computing ``cost``;
    # these fields retain the metering inputs and actual execution-tier provenance.
    # ⚠ NON-NEGOTIABLE #6 is preserved: still ONE UsageDoc per LLM call. ---
    # Prompt-cache accounting (Anthropic/OpenAI prompt caching): tokens READ from the
    # cache (cheaper) and tokens WRITTEN to the cache (a one-time surcharge).
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    # True when this call received a provider's discounted Batch/Flex rate. Retained
    # for backwards-compatible cost math; ``processing_tier`` distinguishes the two.
    batch: bool = False
    # Actual metered tier: standard | flex | batch. Old rows load as standard.
    processing_tier: str = "standard"
    # Retry-safe identity for durable asynchronous folds.  Ordinary live calls leave
    # this unset; Batch results use ``batch:<local-job-id>:<custom-id>`` so the bundled
    # ledgers can upsert/check one authoritative row before marking retrieval complete.
    idempotency_key: str | None = None
    # --- Resilience provenance (additive + defaulted → every stored row loads
    # unchanged, and #6 is preserved: still exactly ONE UsageDoc per LLM call). ---
    # WHY a call failed, as one ``gateway.PROVIDER_FAILURE_CLASSES`` literal — plus the
    # one deliberate non-member, ``gateway.FAILURE_ABANDONED``, for a request that WAS
    # issued and that the caller then stopped waiting for (a case time budget, a hard
    # pipeline timeout).  That one is kept out of the provider vocabulary on purpose: it
    # is our own decision, not evidence about the provider, so it never feeds the health
    # tracker or the circuit breaker — but the row still has to exist, because the call
    # reached the provider and #6 says every LLM call reaches the ledger.  Empty on
    # a successful call.  It is one of OUR closed-vocabulary strings and NEVER provider
    # response text: an error body is attacker-influenceable UNTRUSTED DATA (#9) and a
    # ledger column is read back by cost and diagnostics surfaces.  On an embedding row
    # it also names the reason a local-hash fallback engaged, which is how a degraded
    # (rather than absent) embedding space is attributable after the fact.
    failure_class: str = ""
    # Attempts the provider call actually consumed inside its bounded retry budget.
    # 1 means "answered, or failed, first time"; >1 means the retry budget was spent,
    # which is what separates an exhausted quota from a single rate-limit burst.
    attempts: int = 1
    # True when the token counts on this row were ESTIMATED (chars/4) rather than read
    # from provider usage: a provider that omitted usage, a stream interrupted after its
    # first delta, or a request the caller abandoned (SPEC §6.3: billed input is never
    # recorded as 0). Additive and defaulted, so every stored row loads unchanged.
    usage_estimated: bool = False


# --------------------------------------------------------------------------- #
# Durable cursor (Section 6.1)
# --------------------------------------------------------------------------- #
class Cursor(BaseModel):
    """Durable polling cursor (Section 6.1).

    Stores only stable document attributes so it survives restarts: the last
    processed event timestamp, opaque source-index-qualified identities at that
    exact boundary, and a bounded exact identity ledger for the late-arrival
    overlap.  The frontier remains logically inclusive; boundary identities are
    excluded at query time and checked again here, so a same-millisecond page can
    be drained without replay.  Case-signature idempotency remains the final
    backstop; this contract does not claim distributed exactly-once delivery.
    """

    timestamp_millis: int = 0
    boundary_ids: list[str] = Field(default_factory=list)
    # Exact, bounded identity ledger for the late-arrival overlap window.  Values
    # are event timestamps in epoch millis; keys are ``RawEvent.cursor_key()``.
    # Additive defaults keep every existing stored cursor readable.  An old cursor
    # first backfills this ledger without treating historical rows as new, then
    # enables late-arrival processing on the next complete scan.
    recent_event_millis: dict[str, int] = Field(default_factory=dict)
    overlap_initialized: bool = False
    overlap_saturated: bool = False
    # Runtime callers that intentionally perform a fixed historical window scan
    # (for correlation/evidence) disable the extra late-arrival pass explicitly.
    # Durable poll cursors keep the default enabled value.
    late_arrival_overlap_enabled: bool = True
    # Durable markers for PUSH object-store / stream receivers (audit #7). Additive —
    # every existing stored cursor reads these as empty. ``object_marker`` is the last
    # processed object key (S3/GCS/Azure-Blob list mode); ``shard_markers`` is the
    # per-shard last-processed SequenceNumber (Kinesis), so a restart resumes AFTER it
    # instead of losing data (LATEST) or re-processing from the configured start.
    object_marker: str = ""
    shard_markers: dict[str, str] = Field(default_factory=dict)

    def is_set(self) -> bool:
        return self.timestamp_millis > 0

    def should_skip(self, ev: "RawEvent") -> bool:
        """True if this event was already processed at the cursor boundary.

        Events with an unparseable/missing timestamp (millis <= 0) are NEVER
        skipped — they are processed (case-signature idempotency dedups them) so a
        malformed timestamp cannot silently drop an alert."""
        if ev.timestamp_millis <= 0:
            return False
        event_key = ev.cursor_key()
        if ev.timestamp_millis < self.timestamp_millis:
            # Pre-upgrade cursors have no recent-id ledger.  During their bounded
            # backfill all older rows remain skipped, preventing a one-time replay.
            if not self.overlap_initialized or self.overlap_saturated:
                return True
            return event_key in self.recent_event_millis
        if ev.timestamp_millis == self.timestamp_millis:
            # New cursors persist source-index-qualified keys.  The bare-id check
            # keeps cursors written by older releases backward-compatible.
            boundary = set(self.boundary_ids)
            if event_key in boundary or ev.id in boundary:
                return True
        return False


# --------------------------------------------------------------------------- #
# API request/response shapes (plugin contract)
# --------------------------------------------------------------------------- #
# --------------------------------------------------------------------------- #
# Chat revamp contracts (docs/research/2026-10-chat-revamp/SPEC.md §3, §4.5, §8,
# §9.1). Mirrored in webui/src/lib/types.ts; the shared enums are pinned to
# webui/src/soc/chat/chat-stream-events.contract.json by paired tests.
#
# Every PERSISTED field validates LENIENTLY: an unknown enum value coerces to its
# fallback, an invalid sub-item is dropped, and an invalid optional sub-object
# becomes ``None``. A stored answer replays even when one of its fields drifted
# between releases; replay must never 503 because of presentation data. Every
# string a client will display passes through ``display_text`` (strips C0/C1,
# bidi and zero-width characters, bounds length; BLOCKS.md amendment 4).
# --------------------------------------------------------------------------- #
ChatStreamMode = Literal["steps", "text"]
ChatScope = Literal["logs", "cases", "metrics", "intel", "docs", "platform"]
ChatOrigin = Literal[
    "user", "follow_up", "starter", "command", "continue",
    # Round 12 (SPEC §3.1): a clarify-option pick and a step-inspector retry. Both carry the
    # follow_up taint class (#9): their text is model-authored and may echo log values.
    "clarify", "retry_step",
]
ChatStepKind = Literal["tool", "model"]
ChatStepStatus = Literal["ok", "error", "denied", "timeout", "skipped", "cancelled"]
ChatStepBasis = Literal["exact", "newest_n", "sample", "cached"]
ChatAnswerKind = Literal["data", "product_help", "mixed", "conversation"]
# Round 12 (final review): a reply to a chat COMMAND (``/compact``), not an answer. The
# console shows it as a quiet note without answer actions, and it is never replayed or
# summarised as part of the conversation.
ChatCommand = Literal["compact"]
TurnNoticeKind = Literal[
    "partial", "cap", "budget", "provider", "breaker", "denied", "timeout", "cancelled",
    "unsupported", "not_saved",
    # Round 12 (SPEC D2/D4/D9): answered with what chat can read; the loop guard ended a
    # repeated lookup; earlier context was summarised to keep going.
    "limited", "stopped_repeating", "compacted",
]
CitationKind = Literal["doc", "case", "knowledge", "mitre", "query"]
MemoryProposalOp = Literal["add", "remove"]
ChatBudgetState = Literal["ok", "approaching", "reached"]
TextStreamingReason = Literal["disabled_by_admin", "model_does_not_stream"]
ReportTemplateName = Literal[
    "investigation", "hunt", "ioc", "shift", "posture", "custom",
    # Round 12 (SPEC D11).
    "executive", "monthly", "infographic", "investigation_brief",
]
ReportItemKind = Literal["block", "section"]

CHAT_STREAM_MODES: tuple[str, ...] = get_args(ChatStreamMode)
CHAT_SCOPES: tuple[str, ...] = get_args(ChatScope)
CHAT_ORIGINS: tuple[str, ...] = get_args(ChatOrigin)
CHAT_STEP_KINDS: tuple[str, ...] = get_args(ChatStepKind)
CHAT_STEP_STATUSES: tuple[str, ...] = get_args(ChatStepStatus)
CHAT_STEP_BASES: tuple[str, ...] = get_args(ChatStepBasis)
CHAT_ANSWER_KINDS: tuple[str, ...] = get_args(ChatAnswerKind)
CHAT_COMMANDS: tuple[str, ...] = get_args(ChatCommand)
TURN_NOTICE_KINDS: tuple[str, ...] = get_args(TurnNoticeKind)
CITATION_KINDS: tuple[str, ...] = get_args(CitationKind)
MEMORY_PROPOSAL_OPS: tuple[str, ...] = get_args(MemoryProposalOp)
CHAT_BUDGET_STATES: tuple[str, ...] = get_args(ChatBudgetState)
TEXT_STREAMING_REASONS: tuple[str, ...] = get_args(TextStreamingReason)
REPORT_TEMPLATE_NAMES: tuple[str, ...] = get_args(ReportTemplateName)


class ChatTurn(BaseModel):
    role: str  # "user" | "assistant"
    content: str
    # Who authored a USER turn's text (SPEC §4.8.2; additive, optional). Client
    # ``history`` is replayed text only, so the server cannot know who wrote it: a
    # history turn counts as user-authored for the indicator taint rule ONLY when it
    # says ``origin: "user"``. Absent (an older client), unknown, or any other origin
    # (a follow-up chip, a starter, a slash command) is NOT user-authored, so a
    # model-written follow-up never becomes authorising user text on a later turn.
    # An unknown value is dropped, never a 422.
    origin: ChatOrigin | None = None

    @field_validator("origin", mode="before")
    @classmethod
    def _lenient_origin(cls, value: Any) -> Any:
        return value if isinstance(value, str) and value in CHAT_ORIGINS else None


# Bounds on chat presentation strings (display chips, labels, summaries).
_STEP_LABEL_CHARS = 120
_STEP_SUMMARY_CHARS = 600
_STEP_PARAM_CHARS = 120
_STEP_UNTRUSTED_PARAM_CHARS = 200
_STEP_QUERY_CHARS = 4_096           # live; the persisted form keeps <= 1 kB (§7.5)
_STEP_COVERAGE_CHARS = 200
_STEP_MAX_PARAMS = 12
_STEP_MAX_SOURCES = 20
_FOLLOW_UP_CHARS = 140
_MAX_FOLLOW_UPS = 3
_MAX_STEPS = 64
_MAX_CITATIONS = 40
_MAX_CONSOLE_LINKS = 12
_NOTICE_MESSAGE_CHARS = 400
_CITATION_TITLE_CHARS = 200
_CITATION_SNIPPET_CHARS = 280
_CONSOLE_LABEL_CHARS = 80
_MEMORY_PROPOSAL_CHARS = 500
_MEMORY_PROPOSAL_MAX_IDS = 20

_PARAM_KEY_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,40}$")
_TOOL_NAME_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
_SAFE_ID_PATTERN = r"^[A-Za-z0-9._:-]{1,128}$"
_SAFE_ID_RE = re.compile(_SAFE_ID_PATTERN)
_CITATION_ID_PATTERN = r"^[A-Z][0-9]{1,3}$"
_CONSOLE_LINK_ID_PATTERN = r"^[a-z0-9_]{1,40}:[a-z0-9_.-]{1,80}$"
_GRANT_PATTERN = r"^[a-z_]{1,40}:[a-z_]{1,40}$"


def _lenient_enum(value: Any, allowed: tuple[str, ...], fallback: Any) -> Any:
    """Case-insensitive enum match; anything else takes ``fallback`` (persisted
    enum fields never fail validation because a stored value drifted)."""
    if isinstance(value, str):
        candidate = value.strip().lower()
        if candidate in allowed:
            return candidate
    return fallback


def _lenient_model(model: type[BaseModel], value: Any) -> Any:
    """``model.model_validate(value)``, or ``None`` when it is invalid (dropped)."""
    if value is None or isinstance(value, model):
        return value
    try:
        return model.model_validate(value)
    except Exception:  # noqa: BLE001 -- an invalid optional sub-object is dropped
        return None


def _lenient_models(model: type[BaseModel], value: Any, limit: int) -> list[Any]:
    """Validate a list item by item, DROPPING invalid items; keep at most ``limit``."""
    if not isinstance(value, (list, tuple)):
        return []
    out: list[Any] = []
    for item in value:
        parsed = _lenient_model(model, item)
        if parsed is None:
            continue
        out.append(parsed)
        if len(out) >= limit:
            break
    return out


# A turn may plan more steps than an answer keeps (an oversized ``tools`` batch is
# one step per call, most of them ``skipped``). The bound trims by WEIGHT, never by
# position: placeholders that ran nothing go first (newest first within a class), so
# every model step and every executed tool call (at most ``max_tool_calls`` +
# ``max_model_calls``, below the bound) survives, the run log stays complete, and
# the per-conversation egress count (A13), derived from the stored indicator steps,
# never loses a lookup that left the deployment.
_STEP_INPUT_LIMIT = 4_096


def _step_trim_rank(step: Any) -> int:
    """Lower ranks are dropped first when a turn's steps exceed ``_MAX_STEPS``."""
    if step.kind == "model":
        return 6
    if step.status == "skipped":
        return 0
    if step.status == "denied":
        return 1
    if step.status == "error":
        return 2
    if step.status == "cancelled":
        return 3
    if step.tool == "lookup_indicator":
        return 5
    return 4


def _bounded_steps(value: Any) -> list[Any]:
    """``ChatResponse.steps``: validated leniently, at most ``_MAX_STEPS`` kept."""
    if not isinstance(value, (list, tuple)):
        return []
    steps = [s for s in (_lenient_model(ChatStep, item) for item in list(value)[:_STEP_INPUT_LIMIT]) if s is not None]
    excess = len(steps) - _MAX_STEPS
    if excess <= 0:
        return steps
    ranks = [_step_trim_rank(step) for step in steps]
    dropped: set[int] = set()
    for rank in range(7):
        for position in range(len(steps) - 1, -1, -1):
            if excess <= 0:
                break
            if ranks[position] == rank:
                dropped.add(position)
                excess -= 1
        if excess <= 0:
            break
    return [step for position, step in enumerate(steps) if position not in dropped]


def _display_list(value: Any, limit: int, chars: int) -> list[str]:
    """A bounded list of display-sanitised, non-empty, single-line strings (non-string
    items are dropped, never stringified)."""
    if not isinstance(value, (list, tuple)):
        return []
    out: list[str] = []
    for item in value:
        if not isinstance(item, str):
            continue
        text = display_text(item, chars)
        if text:
            out.append(text)
        if len(out) >= limit:
            break
    return out


# --- §3.1 time window --------------------------------------------------------- #
_RELATIVE_TIME_RE = re.compile(r"^now(?:-(\d{1,5})([mhdw]))?$")
_RELATIVE_SECONDS = {"m": 60, "h": 3_600, "d": 86_400, "w": 604_800}
# Round 12 (SPEC D7/P0-3): calendar months and years. ``now-6M`` is six MONTHS (an
# upper-case M; a lower-case ``m`` stays minutes) and ``now-1y`` one year, in calendar
# arithmetic (the day clamped to the target month), so a "6 months" chip is never six
# minutes. Matched case-sensitively, after the prefix is lower-cased.
_CALENDAR_RELATIVE_RE = re.compile(r"^now-(\d{1,4})([My])$")
_TIME_EXPR_HELP = (
    "expected 'now', 'now-<n>[m|h|d|w]' (m = minutes), 'now-<n>[M|y]' (M = months, y = years) "
    "or an ISO-8601 timestamp"
)


def _months_before(moment: datetime, months: int) -> datetime | None:
    """``moment`` moved back ``months`` calendar months (UTC; the day clamped to the
    target month's length), or ``None`` before year 1."""
    from calendar import monthrange

    index = moment.year * 12 + (moment.month - 1) - months
    year, month = divmod(index, 12)
    month += 1
    if year < 1:
        return None
    return moment.replace(year=year, month=month, day=min(moment.day, monthrange(year, month)[1]))


def resolve_time_expr(expr: str, now: datetime | None = None) -> datetime | None:
    """Resolve one composer time expression to an aware UTC datetime, else ``None``.
    The grammar is deliberately narrow (SPEC §3.1): ``now``, ``now-<n>[m|h|d|w]``
    (``m`` = minutes), ``now-<n>[M|y]`` (calendar months and years) or an ISO-8601
    timestamp (a naive one is read as UTC). No ``now+``, no epoch numbers."""
    if not isinstance(expr, str):
        return None
    reference = now or datetime.now(timezone.utc)
    text = expr.strip()
    calendar = _CALENDAR_RELATIVE_RE.match(text)
    if calendar:
        months = int(calendar.group(1)) * (12 if calendar.group(2) == "y" else 1)
        return _months_before(reference, months)
    match = _RELATIVE_TIME_RE.match(text.lower())
    if match:
        if match.group(1) is None:
            return reference
        try:
            return reference - timedelta(
                seconds=int(match.group(1)) * _RELATIVE_SECONDS[match.group(2)]
            )
        except OverflowError:
            return None
    # The ONE timestamp grammar shared with answer blocks and the webui
    # (``blocks.TIMESTAMP_PATTERN``, pinned by the answer-blocks contract).
    return parse_timestamp(text)


# The serialised form of :class:`TimeRange` (``from`` is a keyword, hence the
# functional syntax). ``typing_extensions`` because pydantic needs it before 3.12.
TimeRangeWire = TypedDict("TimeRangeWire", {"from": str, "to": str})


# Round 12 (SPEC D7/D7a): ``from: "all"`` is the composer's "All time" chip. It resolves
# to the start of the epoch and never clamps a tool's window.
TIME_RANGE_ALL = "all"
_ALL_TIME_START = datetime(1970, 1, 1, tzinfo=timezone.utc)
_RELATIVE_WORDS = {"m": "minute", "h": "hour", "d": "day", "w": "week", "M": "month", "y": "year"}


def humanise_relative_window(amount: int, unit: str) -> str:
    """"last 24 hours", "last 7 days", "last 30 days", "last 6 months" for a trailing
    ``now-<amount><unit>`` window (never "last 720h"). Whole days read as days, so
    ``now-720h`` is "last 30 days". ``unit`` is ``m`` (minutes), ``h``, ``d``, ``w``,
    ``M`` (months) or ``y``."""
    if unit == "h" and amount >= 48 and amount % 24 == 0:
        amount, unit = amount // 24, "d"
    if unit == "d" and amount == 1:
        amount, unit = 24, "h"
    if unit == "w" and amount == 1:
        amount, unit = 7, "d"
    if amount == 1 and unit in ("M", "y"):
        return f"past {_RELATIVE_WORDS[unit]}"
    word = _RELATIVE_WORDS.get(unit, unit)
    return f"last {word}" if amount == 1 else f"last {amount:,} {word}s"


class TimeRange(BaseModel):
    """The composer time window ``{from, to}`` (SPEC §3.1).

    Each bound is ``now``, ``now-<n>[m|h|d|w|M|y]`` (lower-case ``m`` is minutes,
    ``M`` months, ``y`` years) or ISO-8601, and ``from`` may also be ``all``
    (``{"from": "all"}``, the "All time" chip, Round 12, which never clamps); ``from``
    must be strictly before ``to``, else 422. Round 12 (SPEC D7a): chat scope windows
    have no span limit (:attr:`MAX_SPAN_DAYS` is ``None``). It applies to every
    windowed chat tool; precedence is the model's explicit window from the user's
    words, then this, then ``context.time_range``, then the tool's own default. Serialises as ``{"from",
    "to"}`` (both keys, always) regardless of ``by_alias`` or ``exclude_defaults``, so
    stored and wire shapes never diverge."""

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    MAX_SPAN_DAYS: ClassVar[int | None] = None

    from_: str = Field(alias="from", min_length=1, max_length=40)
    to: str = Field(default="now", min_length=1, max_length=40)

    @field_validator("from_", "to", mode="before")
    @classmethod
    def _normalise(cls, value: Any) -> Any:
        if not isinstance(value, str):
            return value
        text = value.strip()
        if text.lower() in (TIME_RANGE_ALL, "all_time", "all time", "lifetime"):
            return TIME_RANGE_ALL
        # Relative expressions are canonicalised to lower case ("NOW-24H" → "now-24h"),
        # except a month or year unit: "now-6M" is six MONTHS and must never become
        # "now-6m" (six minutes); "now-1Y" is "now-1y".
        lowered = text.lower()
        if not lowered.startswith("now"):
            return text
        unit = text[-1:]
        if unit in ("M", "y", "Y"):
            calendar = lowered[:-1] + ("M" if unit == "M" else "y")
            if _CALENDAR_RELATIVE_RE.match(calendar):
                return calendar
        return lowered

    @field_validator("from_", "to")
    @classmethod
    def _grammar(cls, value: str, info: Any) -> str:
        if value == TIME_RANGE_ALL and info.field_name == "from_":
            return value
        if resolve_time_expr(value) is None:
            raise ValueError(_TIME_EXPR_HELP)
        return value

    @model_validator(mode="after")
    def _window(self) -> "TimeRange":
        start, end = self.resolve()
        if start >= end:
            raise ValueError("time_range.from must be before time_range.to")
        if self.MAX_SPAN_DAYS is not None and end - start > timedelta(days=self.MAX_SPAN_DAYS):
            raise ValueError(f"time_range spans at most {self.MAX_SPAN_DAYS} days")
        return self

    @property
    def is_all_time(self) -> bool:
        """True for the "All time" chip (``from: "all"``), which never clamps."""
        return self.from_ == TIME_RANGE_ALL

    # ``plain`` + a TypedDict return: the wire shape is always both keys, and the
    # annotation is what gives ``openapi.json`` a typed ``{from, to}`` output schema
    # (an untyped ``Any`` serializer renders as an empty object).
    @model_serializer(mode="plain")
    def _serialise(self) -> TimeRangeWire:
        return {"from": self.from_, "to": self.to}

    def resolve(self, now: datetime | None = None) -> tuple[datetime, datetime]:
        """``(from, to)`` as aware UTC datetimes against one shared ``now``."""
        reference = now or datetime.now(timezone.utc)
        start = _ALL_TIME_START if self.is_all_time else resolve_time_expr(self.from_, reference)
        end = resolve_time_expr(self.to, reference)
        assert start is not None and end is not None  # guaranteed by _grammar
        return start, end

    def span_hours(self, now: datetime | None = None) -> float:
        start, end = self.resolve(now)
        return (end - start).total_seconds() / 3_600

    def window_hours(self, *, lo: int = 1, hi: int = 720, now: datetime | None = None) -> int:
        """The window as whole hours clamped to ``lo..hi`` (metrics, cases and cost
        tools take ``window_hours``; SPEC §3.1 clamps it to 1..720)."""
        hours = math.ceil(self.span_hours(now))
        return min(max(hours, lo), hi)

    def label(self) -> str:
        """Short caption text: ``last 24 hours`` / ``all time`` for a trailing window,
        else ``a → b``."""
        if self.is_all_time:
            return "all time" if self.to == "now" else f"all time → {self.to}"
        if self.to == "now":
            match = _RELATIVE_TIME_RE.match(self.from_) or _CALENDAR_RELATIVE_RE.match(self.from_)
            if match and match.group(1):
                return humanise_relative_window(int(match.group(1)), match.group(2))
        return f"{self.from_} → {self.to}"


def _lenient_time_range(value: Any) -> Any:
    return _lenient_model(TimeRange, value)


class ChatConversationMessage(BaseModel):
    """One durable Workspace-chat message.

    ``response`` keeps the bounded structured result needed to restore tables,
    query links, cost and memory feedback.  It is plain JSON presentation data;
    the authoritative chat engine still receives only ``role`` + ``content`` as
    prior model history.
    """

    id: str = Field(default_factory=lambda: new_id("chatmsg-"))
    role: Literal["user", "assistant"]
    content: str
    created_at: str = Field(default_factory=iso_now)
    response: dict[str, Any] | None = None
    model: str | None = None
    source_id: str | None = None
    source_name: str | None = None
    idempotency_key: str | None = None


class ChatConversationSummary(BaseModel):
    id: str
    title: str
    preview: str = ""
    created_at: str
    updated_at: str
    message_count: int = 0
    total_message_count: int = 0
    history_truncated: bool = False
    oldest_retained_at: str | None = None
    model: str | None = None
    source_id: str | None = None
    source_name: str | None = None
    # --- Chat revamp (SPEC §7.5; additive, legacy rows load with these defaults). ---
    # Pinned conversations (<= 10) are exempt from the 50-conversation eviction.
    pinned: bool = False
    # The conversation's draft report, when one exists (§9.1).
    report_id: str | None = None
    # The last composer window used in this conversation (the scope chip).
    time_range: TimeRange | None = None
    # Cumulative usage, incremented per completed exchange so it survives trimming.
    # ``None`` on legacy rows: the UI shows "—", never 0.
    total_tokens: int | None = Field(default=None, ge=0)
    total_cost: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    usage_turns: int | None = Field(default=None, ge=0)
    # --- Round 12 (SPEC §3.1; additive). Live state for the history rail and the nav
    # indicator (D13): a question is running, waiting for a clarify pick, or failed; an
    # answer arrived that the owner has not opened yet.
    status: Literal["idle", "running", "needs_input", "failed"] = "idle"
    unread: bool = False

    @field_validator("pinned", mode="before")
    @classmethod
    def _pinned(cls, value: Any) -> Any:
        return value if isinstance(value, bool) else False

    @field_validator("time_range", mode="before")
    @classmethod
    def _time_range(cls, value: Any) -> Any:
        # A stored window that no longer validates (e.g. an absolute bound that has
        # since aged past 90 days) is dropped, never fatal.
        return _lenient_time_range(value)

    @field_validator("total_tokens", "usage_turns", mode="before")
    @classmethod
    def _counter(cls, value: Any) -> Any:
        if value is None or isinstance(value, bool):
            return None
        return value if isinstance(value, int) and value >= 0 else None

    @field_validator("total_cost", mode="before")
    @classmethod
    def _cost(cls, value: Any) -> Any:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        return float(value) if math.isfinite(value) and value >= 0 else None


class ChatConversation(ChatConversationSummary):
    messages: list[ChatConversationMessage] = Field(default_factory=list)
    # Round 12 (SPEC D4): the newest message id folded into the stored conversation summary.
    summary_covers_through: str | None = None
    # Round 12 (WP-API; additive): how many older messages of this conversation are
    # not in ``messages`` (``GET /chat/conversations/{id}`` returns the newest window;
    # read older ones with ``GET .../messages?before=<first message id>``). Never stored.
    earlier_message_count: int = Field(default=0, ge=0)


class ChatConversationMatch(BaseModel):
    """Where a ``?q=`` search hit a conversation (SPEC §7.5 Search)."""

    message_id: str | None = None
    snippet: str = Field(default="", max_length=160)

    @field_validator("snippet", mode="before")
    @classmethod
    def _snippet(cls, value: Any) -> str:
        return display_text(value, 160)


class ChatConversationSearchHit(ChatConversationSummary):
    """A conversation summary returned by a content search (never persisted)."""

    match: ChatConversationMatch | None = None


def _clean_conversation_title(value: Any) -> str:
    title = " ".join(str(value).split()).strip()
    if not title:
        raise ValueError("title is required")
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in title):
        raise ValueError("title must be plain single-line text")
    return title


class ChatConversationRenameRequest(BaseModel):
    title: str = Field(min_length=1, max_length=80)

    @field_validator("title")
    @classmethod
    def clean_title(cls, value: str) -> str:
        return _clean_conversation_title(value)


class ChatConversationUpdateRequest(BaseModel):
    """``PATCH /api/chat/conversations/{id}`` (SPEC §7.5 Pin): rename and/or pin.
    At least one field is required; pinning never changes ``updated_at``."""

    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, min_length=1, max_length=80)
    pinned: bool | None = None

    @field_validator("title")
    @classmethod
    def clean_title(cls, value: str | None) -> str | None:
        return None if value is None else _clean_conversation_title(value)

    @model_validator(mode="after")
    def _at_least_one(self) -> "ChatConversationUpdateRequest":
        if self.title is None and self.pinned is None:
            raise ValueError("provide title and/or pinned")
        return self


class ChatContext(BaseModel):
    """On-screen context snapshot the global chat flyout may attach (Feature 1).

    ALL fields optional + best-effort. ``query``/``selection`` are
    attacker-influenceable and MUST be fenced as UNTRUSTED in prompts; the context
    is used only to DEFAULT the es_query tool (data view / time range), never as
    instructions.
    """

    app: str | None = None
    url: str | None = None
    data_view: str | None = None
    query: str | None = None
    language: str | None = None
    time_range: dict[str, Any] | None = None   # {from, to}
    case_id: str | None = None
    selection: str | None = None
    search_session: str | None = None


# The revamp request fields are fingerprinted with ``exclude_defaults`` so a
# pre-revamp request body hashes byte-identically (SPEC §3.1); ``stream_mode`` is
# presentation only and never part of the identity.
CHAT_REQUEST_FINGERPRINT_EXCLUDE: frozenset[str] = frozenset(
    {"idempotency_key", "persist_conversation", "stream_mode"}
)
CHAT_REQUEST_REVAMP_FIELDS: frozenset[str] = frozenset(
    {"scopes", "time_range", "origin", "continue_of", "topic"}
)
# A console_map topic id (``kpi:mtta``, ``settings:detection.detection-autoclose``):
# ``<family>:<anchor>``, at most 40 + 1 + 80 characters: the console link id grammar
# (one definition, also used by the ``GET /api/chat/topics/{topic_id}`` path).
CONSOLE_TOPIC_ID_PATTERN = _CONSOLE_LINK_ID_PATTERN
CHAT_TOPIC_MAX_CHARS = 121
# ``ChatRequest.topic`` accepts a SUPERSET of that grammar (same characters, same
# length bound, colon not required). The field is only a retrieval hint whose
# unknown ids are ignored, while a 422 would fail the whole turn: every console_map
# id must pass, and so must anything a client's own sender filter lets through.
CHAT_TOPIC_PATTERN = rf"^[a-z0-9_:.-]{{1,{CHAT_TOPIC_MAX_CHARS}}}$"


class ChatRequest(BaseModel):
    message: str
    case_id: str | None = None          # Surface 2: seed with a case
    history: list[ChatTurn] = Field(default_factory=list)
    context: ChatContext | None = None  # Feature 1: global flyout screen context
    # Optional per-call model override (additive; the proxy forwards it). When set,
    # the chat-role model is overridden to this id for THIS turn only via a prefs
    # copy — no gateway plumbing change. Still routed through the single gateway.
    model: str | None = None
    # Optional per-call SOURCE scoping (multi-source): when set, the chat engine
    # queries THAT configured source's connector (built per-call like the browse
    # endpoint) instead of the primary. Absent → the primary source (today's
    # behaviour). NOTE: this is single-source SELECT, not cross-source aggregation.
    source_id: str | None = None
    # Workspace chat opts into durable per-user history explicitly. Existing
    # stateless callers and every case-scoped embed remain byte-compatible.
    conversation_id: str | None = None
    persist_conversation: bool = False
    # A retry-safe Workspace-turn identity. The server reserves this key before
    # invoking the model, so concurrent/retried sends cannot double-bill or append
    # duplicate turns. Older clients may omit it; the server then returns a generated
    # key for the completed turn.
    idempotency_key: str | None = Field(
        default=None,
        min_length=8,
        max_length=128,
        pattern=r"^[A-Za-z0-9._:-]+$",
    )
    # --- Chat revamp (SPEC §3.1; additive). ---
    # D2 presentation mode for THIS turn: "steps" streams lookups + usage, "text" also
    # streams the final answer word by word. Never part of the request identity.
    stream_mode: ChatStreamMode = "steps"
    # Composer @-scopes narrowing which tool families may run. Unknown values are
    # DROPPED (an older/newer client never 422s on a scope it does not know).
    scopes: list[ChatScope] = Field(default_factory=list, max_length=len(CHAT_SCOPES))
    # The composer window chip (validated grammar, from < to, <= 90 days; else 422).
    time_range: TimeRange | None = None
    # Who authored the message text. Only "user" counts as user-authored for the
    # indicator taint rule (§4.8): follow-up chips, starters and slash commands do not.
    origin: ChatOrigin = "user"
    # The assistant message id this turn continues after a cap notice.
    continue_of: str | None = Field(default=None, max_length=128, pattern=_SAFE_ID_PATTERN)
    # "Ask about this" (SPEC A7): the console_map topic this turn was started from. It
    # is never prompt text: ``app_help`` pins that topic's glossary sections first and
    # the $0 Help Center answer does the same. Part of the request identity (it changes
    # retrieval) but, like the other revamp fields, only when set, so a body without
    # it fingerprints exactly as before. A malformed id is 422; a well-formed id the
    # corpus does not know is ignored.
    topic: str | None = Field(default=None, max_length=CHAT_TOPIC_MAX_CHARS, pattern=CHAT_TOPIC_PATTERN)

    @field_validator("topic", mode="before")
    @classmethod
    def _blank_topic(cls, value: Any) -> Any:
        return None if isinstance(value, str) and not value.strip() else value

    @field_validator("scopes", mode="before")
    @classmethod
    def _known_scopes(cls, value: Any) -> list[str]:
        if isinstance(value, str):
            value = [value]
        if not isinstance(value, (list, tuple)):
            return []
        out: list[str] = []
        for item in value:
            scope = _lenient_enum(item, CHAT_SCOPES, None)
            if scope and scope not in out:
                out.append(scope)
        return out

    def fingerprint_payload(self) -> dict[str, Any]:
        """The JSON-able identity of this request for idempotency (SPEC §3.1).

        Pre-revamp fields are dumped exactly as before (minus the excluded keys); the
        revamp fields are added only when they differ from their defaults, so a body
        that does not use them fingerprints byte-identically to a pre-revamp body. The
        same key is therefore valid across ``/chat`` and ``/chat/stream``."""
        payload = self.model_dump(
            mode="json",
            exclude=set(CHAT_REQUEST_FINGERPRINT_EXCLUDE | CHAT_REQUEST_REVAMP_FIELDS),
        )
        # A history turn's ``origin`` is part of the identity only when the client set
        # it, so a body whose history carries no origins hashes exactly as before.
        for turn in payload.get("history") or ():
            if isinstance(turn, dict) and turn.get("origin") is None:
                turn.pop("origin", None)
        payload.update(self.model_dump(
            mode="json", include=set(CHAT_REQUEST_REVAMP_FIELDS), exclude_defaults=True,
        ))
        return payload


class DiscoverLink(BaseModel):
    """Payload the plugin feeds to Kibana's locators API (Section 8.1)."""

    query: str
    language: str = "kuery"             # "kuery" | "lucene" | "esql"
    data_view_pattern: str = "all-logs-*"
    time_from: str = "now-24h"
    time_to: str = "now"


class MemorySuggestion(BaseModel):
    """A durable fact the chat agent NOTICED and proposes to remember. The UI shows
    it for the analyst to confirm before it is saved — the agent never auto-saves a
    suggestion (only explicit "remember: …" commands are executed)."""

    text: str = ""
    reason: str = ""


# --- §3.4 usage --------------------------------------------------------------- #
class StepUsage(BaseModel):
    """Usage of ONE model call (or one query-embedding call on a tool step).
    ``estimated`` marks a provider that omitted usage or a call cancelled mid-stream
    (input = provider count or chars/4, output = chars/4 of what was received)."""

    input_tokens: int = Field(default=0, ge=0)
    cache_read_tokens: int = Field(default=0, ge=0)
    cache_write_tokens: int = Field(default=0, ge=0)
    output_tokens: int = Field(default=0, ge=0)
    cost: float = Field(default=0.0, ge=0, allow_inf_nan=False)
    latency_ms: int = Field(default=0, ge=0)
    estimated: bool = False
    embedding_calls: int = Field(default=0, ge=0)
    embedding_tokens: int = Field(default=0, ge=0)
    embedding_cost: float = Field(default=0.0, ge=0, allow_inf_nan=False)

    @property
    def prompt_tokens(self) -> int:
        """Everything sent (uncached + cache read + cache write; §3.4 definition)."""
        return self.input_tokens + self.cache_read_tokens + self.cache_write_tokens

    @property
    def total_tokens(self) -> int:
        return self.prompt_tokens + self.output_tokens + self.embedding_tokens


class TurnUsage(BaseModel):
    """Running/final usage of one turn: the sum of its model calls plus any
    query-embedding calls. ``cost`` includes embedding cost; ``simulated`` marks Demo
    Mode synthetic pricing; ``estimated`` is true when any part was estimated."""

    calls: int = Field(default=0, ge=0)
    embedding_calls: int = Field(default=0, ge=0)
    input_tokens: int = Field(default=0, ge=0)
    cache_read_tokens: int = Field(default=0, ge=0)
    cache_write_tokens: int = Field(default=0, ge=0)
    output_tokens: int = Field(default=0, ge=0)
    # input + cache_read + cache_write + output (+ embedding tokens)
    total_tokens: int = Field(default=0, ge=0)
    cost: float = Field(default=0.0, ge=0, allow_inf_nan=False)
    latency_ms: int = Field(default=0, ge=0)
    model: str | None = None
    pricing_source: str | None = None
    simulated: bool = False
    estimated: bool = False
    context_window: int | None = Field(default=None, ge=0)
    # The largest single prompt of the turn (hover-card detail only).
    peak_prompt_tokens: int = Field(default=0, ge=0)

    @classmethod
    def from_steps(
        cls,
        model_calls: "Iterable[StepUsage]",
        embeddings: "Iterable[StepUsage]" = (),
        *,
        model: str | None = None,
        pricing_source: str | None = None,
        simulated: bool = False,
        context_window: int | None = None,
        latency_ms: int | None = None,
    ) -> "TurnUsage":
        """Aggregate model-call usages and embedding usages into a turn total.
        ``latency_ms`` defaults to the sum of the model calls' latencies."""
        calls = list(model_calls)
        embeds = list(embeddings)
        input_tokens = sum(u.input_tokens for u in calls)
        cache_read = sum(u.cache_read_tokens for u in calls)
        cache_write = sum(u.cache_write_tokens for u in calls)
        output = sum(u.output_tokens for u in calls)
        embedding_tokens = sum(u.embedding_tokens for u in calls + embeds)
        return cls(
            calls=len(calls),
            embedding_calls=sum(u.embedding_calls for u in calls + embeds),
            input_tokens=input_tokens,
            cache_read_tokens=cache_read,
            cache_write_tokens=cache_write,
            output_tokens=output,
            total_tokens=input_tokens + cache_read + cache_write + output + embedding_tokens,
            cost=round(sum(u.cost + u.embedding_cost for u in calls)
                       + sum(u.cost + u.embedding_cost for u in embeds), 10),
            latency_ms=sum(u.latency_ms for u in calls) if latency_ms is None else max(0, latency_ms),
            model=model,
            pricing_source=pricing_source,
            simulated=simulated,
            estimated=any(u.estimated for u in calls + embeds),
            context_window=context_window,
            peak_prompt_tokens=max((u.prompt_tokens for u in calls), default=0),
        )


# --- §3.3 steps --------------------------------------------------------------- #
# Every invisible, bidi, tag and control character (``INVISIBLE_TEXT_RANGES``) and
# every lone surrogate half: what ``visible_display_text`` writes as an escape.
_VISIBLE_ESCAPE_RE = re.compile(f"[{INVISIBLE_TEXT_CLASS}]|[\ud800-\udfff]")
# A ``\uXXXX`` escape (or the high half of an astral pair) a length bound cut.
_PARTIAL_ESCAPE_RE = re.compile(r"(?:\\ud[89ab][0-9a-f]{2})?(?:\\(?:u[0-9a-f]{0,3})?)?$")


def _escape_char(match: "re.Match[str]") -> str:
    """``\\uXXXX``; an astral code point as its UTF-16 pair, as ``ensure_ascii``
    (and the step inspector's JSON view) writes it."""
    code = ord(match.group())
    if code > 0xFFFF:
        code -= 0x10000
        return f"\\u{0xD800 + (code >> 10):04x}\\u{0xDC00 + (code & 0x3FF):04x}"
    return f"\\u{code:04x}"


def visible_display_text(value: Any, limit: int, *, multiline: bool = False) -> str:
    """:func:`display_text` for a model- or log-derived value a person must read
    EXACTLY (a run-log step's ``untrusted_params`` and ``query``, Round 12 P1-1): every
    invisible, bidi, tag or control character and lone surrogate is WRITTEN as visible
    ``\\uXXXX`` escape text instead of being deleted. Deleting it would show "admin" +
    ZWSP as "admin" (the real account) and let a right-to-left override reorder what
    the analyst reads, while the stored observation shows the escape (the model read
    it through ``fence_block``'s ``ensure_ascii``). The escapes are ASCII, so the web
    normalisers keep them. Line breaks fold to a space unless ``multiline``; the bound
    never cuts an escape in half. Never raises."""
    if isinstance(value, str):
        text = value
    elif isinstance(value, bool) or (isinstance(value, (int, float)) and math.isfinite(value)):
        return display_text(value, limit)
    else:
        return ""
    text = display_text(_VISIBLE_ESCAPE_RE.sub(_escape_char, text), 0, multiline=multiline)
    if limit > 0 and len(text) > limit:
        text = _PARTIAL_ESCAPE_RE.sub("", text[: max(0, limit - 1)]).rstrip() + "…"
    return text


def display_params(
    value: Any,
    *,
    chars: int = _STEP_PARAM_CHARS,
    strings_only: bool = False,
    visible: bool = False,
) -> dict[str, Any]:
    """Whitelist-shaped display chips: safe keys (``[A-Za-z0-9_.:-]{1,40}``), scalar
    values, display-sanitised text, at most 12 entries. ``strings_only`` renders
    numbers as text (``untrusted_params`` is ``dict[str, str]``); ``visible`` writes
    invisible characters as escapes (:func:`visible_display_text`) instead of deleting
    them. Never raises."""
    if not isinstance(value, dict):
        return {}
    def text_of(raw: str) -> str:
        return visible_display_text(raw, chars) if visible else display_text(raw, chars)

    out: dict[str, Any] = {}
    for key, raw in value.items():
        if len(out) >= _STEP_MAX_PARAMS:
            break
        if not isinstance(key, str) or not _PARAM_KEY_RE.match(key):
            continue
        if isinstance(raw, str):
            out[key] = text_of(raw)
        elif strings_only:
            if isinstance(raw, (int, float)) and not isinstance(raw, bool) and math.isfinite(raw):
                out[key] = text_of(str(raw))
        elif raw is None or isinstance(raw, bool) or isinstance(raw, int):
            out[key] = raw
        elif isinstance(raw, float) and math.isfinite(raw):
            out[key] = raw
    return out


class ChatStep(BaseModel):
    """One row of a turn's run log (SPEC §3.3). Every string is engine-authored or
    display-sanitised; ``untrusted_params`` and ``query`` may carry model/log-derived
    values, which the UI renders as untrusted text/code and prompts fence."""

    index: int = Field(ge=0)                       # display order, 1-based
    ordinal: int | None = Field(default=None, ge=1)  # tool-call ordinal N (tN refs)
    kind: ChatStepKind = "tool"
    tool: str | None = None
    label: str = Field(default="", max_length=_STEP_LABEL_CHARS)
    params: dict[str, str | int | float | bool | None] = Field(default_factory=dict)
    status: ChatStepStatus = "ok"
    duration_ms: int = Field(default=0, ge=0)
    summary: str = Field(default="", max_length=_STEP_SUMMARY_CHARS)
    untrusted_params: dict[str, str] = Field(default_factory=dict)
    query: str | None = Field(default=None, max_length=_STEP_QUERY_CHARS)
    rows: int | None = Field(default=None, ge=0)
    basis: ChatStepBasis | None = None
    coverage: str | None = Field(default=None, max_length=_STEP_COVERAGE_CHARS)
    sources: list[str] = Field(default_factory=list, max_length=_STEP_MAX_SOURCES)
    usage: StepUsage | None = None
    group: int | None = Field(default=None, ge=0)
    # --- Round 12 (SPEC §3.1; additive). Owner-scoped key for the step inspector
    # (GET /api/chat/conversations/{id}/messages/{mid}/steps/{index}); progress of a long
    # aggregate scan ("Counted 42,000 of 118,402 cases").
    observation_ref: str | None = Field(default=None, max_length=200)
    progress: ChatStepProgress | None = None

    @model_validator(mode="before")
    @classmethod
    def _lenient(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        out = dict(data)
        out["kind"] = _lenient_enum(out.get("kind"), CHAT_STEP_KINDS, "tool")
        # An unknown stored status reads as a failure, never as a silent success.
        out["status"] = _lenient_enum(out.get("status"), CHAT_STEP_STATUSES, "error")
        out["basis"] = _lenient_enum(out.get("basis"), CHAT_STEP_BASES, None)
        tool = out.get("tool")
        out["tool"] = tool if isinstance(tool, str) and _TOOL_NAME_RE.match(tool) else None
        out["label"] = display_text(out.get("label"), _STEP_LABEL_CHARS)
        out["summary"] = display_text(out.get("summary"), _STEP_SUMMARY_CHARS)
        out["params"] = display_params(out.get("params"), chars=_STEP_PARAM_CHARS, strings_only=False)
        # Model- or log-derived values: invisible and bidi characters are written as
        # visible escapes, never deleted, so the run log and the step inspector show
        # exactly what was sent ("admin" + ZWSP never reads as "admin", #9, P1-1).
        out["untrusted_params"] = display_params(
            out.get("untrusted_params"), chars=_STEP_UNTRUSTED_PARAM_CHARS,
            strings_only=True, visible=True,
        )
        query = out.get("query")
        out["query"] = (
            (visible_display_text(query, _STEP_QUERY_CHARS, multiline=True) or None)
            if isinstance(query, str) else None
        )
        coverage = out.get("coverage")
        out["coverage"] = (
            (display_text(coverage, _STEP_COVERAGE_CHARS) or None)
            if isinstance(coverage, str) else None
        )
        out["sources"] = _display_list(out.get("sources"), _STEP_MAX_SOURCES, 120)
        out["usage"] = _lenient_model(StepUsage, out.get("usage"))
        for name in ("ordinal", "rows", "group"):
            raw = out.get(name)
            if raw is not None and (isinstance(raw, bool) or not isinstance(raw, int) or raw < (1 if name == "ordinal" else 0)):
                out[name] = None
        duration = out.get("duration_ms")
        if isinstance(duration, float) and math.isfinite(duration):
            duration = int(duration)
        out["duration_ms"] = duration if isinstance(duration, int) and not isinstance(duration, bool) and duration >= 0 else 0
        return out


# --- §3.5 citations, console links, memory proposals --------------------------- #
class Citation(BaseModel):
    """A source the answer cites by id (``D1`` doc, ``C2`` case, ``K3`` knowledge,
    ``M1`` ATT&CK, ``Q1`` query). The model references ids only; the server resolves
    them; the client re-validates every target."""

    id: str = Field(pattern=_CITATION_ID_PATTERN)
    kind: CitationKind
    title: str = Field(min_length=1, max_length=_CITATION_TITLE_CHARS)
    untrusted: bool = False
    doc: str | None = Field(default=None, pattern=DOC_REF_PATTERN)
    case_id: str | None = Field(default=None, pattern=CASE_ID_PATTERN)
    technique: str | None = Field(default=None, pattern=TECHNIQUE_PATTERN)
    snippet: str | None = Field(default=None, max_length=_CITATION_SNIPPET_CHARS)

    @model_validator(mode="before")
    @classmethod
    def _sanitise(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        out = dict(data)
        if isinstance(out.get("kind"), str):
            out["kind"] = out["kind"].strip().lower()
        out["title"] = display_text(out.get("title"), _CITATION_TITLE_CHARS)
        snippet = out.get("snippet")
        out["snippet"] = (display_text(snippet, _CITATION_SNIPPET_CHARS, multiline=True) or None) if isinstance(snippet, str) else None
        if isinstance(out.get("technique"), str):
            out["technique"] = out["technique"].strip().upper()
        if not isinstance(out.get("untrusted"), bool):
            out["untrusted"] = True if "untrusted" in out else False
        return out

    @model_validator(mode="after")
    def _target(self) -> "Citation":
        # A citation is only useful with the target its kind names.
        required = {"doc": self.doc, "case": self.case_id, "mitre": self.technique}
        if self.kind in required and not required[self.kind]:
            raise ValueError(f"a {self.kind} citation needs its target")
        return self


class ConsoleLink(BaseModel):
    """A console destination resolved from ``console_map`` (never from model text).
    ``allowed`` comes from the caller's grants; a disallowed link renders as plain
    text naming the grant it ``requires``."""

    id: str = Field(pattern=_CONSOLE_LINK_ID_PATTERN)
    label: str = Field(min_length=1, max_length=_CONSOLE_LABEL_CHARS)
    page: str = Field(pattern=PAGE_PATTERN)
    opts: dict[str, str | int] = Field(default_factory=dict)
    allowed: bool = False
    requires: str | None = Field(default=None, pattern=_GRANT_PATTERN)

    @model_validator(mode="before")
    @classmethod
    def _sanitise(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        out = dict(data)
        out["label"] = display_text(out.get("label"), _CONSOLE_LABEL_CHARS)
        out["opts"] = clean_nav_opts(out.get("opts"))
        # Fail closed: only an explicit True grants navigation.
        out["allowed"] = out.get("allowed") is True
        return out


class MemoryProposal(BaseModel):
    """A memory change the MODEL proposed (§4.8). Never executed by the engine: the
    UI confirms it through the existing memory routes under ``memory:manage``.
    ``remove`` takes exact entry ids only (no text matching from chat)."""

    op: MemoryProposalOp
    text: str | None = Field(default=None, max_length=_MEMORY_PROPOSAL_CHARS)
    ids: list[str] = Field(default_factory=list, max_length=_MEMORY_PROPOSAL_MAX_IDS)

    @model_validator(mode="before")
    @classmethod
    def _sanitise(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        out = dict(data)
        if isinstance(out.get("op"), str):
            out["op"] = out["op"].strip().lower()
        text = out.get("text")
        out["text"] = (display_text(text, _MEMORY_PROPOSAL_CHARS) or None) if isinstance(text, str) else None
        ids = out.get("ids")
        out["ids"] = [
            i for i in (ids if isinstance(ids, (list, tuple)) else [])
            if isinstance(i, str) and _SAFE_ID_RE.match(i)
        ][:_MEMORY_PROPOSAL_MAX_IDS]
        return out

    @model_validator(mode="after")
    def _shape(self) -> "MemoryProposal":
        if self.op == "add" and not self.text:
            raise ValueError("an add proposal needs text")
        if self.op == "remove" and not self.ids:
            raise ValueError("a remove proposal needs exact entry ids")
        return self


# --- §4.5 notices -------------------------------------------------------------- #
class TurnNotice(BaseModel):
    """Why a turn is partial, stopped, refused or not saved. ``message`` is an engine
    template; ``retryable`` decides whether the UI offers Retry."""

    kind: TurnNoticeKind
    message: str = Field(default="", max_length=_NOTICE_MESSAGE_CHARS)
    retryable: bool = False

    @model_validator(mode="before")
    @classmethod
    def _lenient(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        out = dict(data)
        out["kind"] = _lenient_enum(out.get("kind"), TURN_NOTICE_KINDS, "partial")
        out["message"] = display_text(out.get("message"), _NOTICE_MESSAGE_CHARS)
        out["retryable"] = out.get("retryable") is True
        return out


class ChatResponse(BaseModel):
    answer: str
    table: dict[str, Any] | None = None     # {columns:[], rows:[[...]]}
    query: str | None = None
    discover: DiscoverLink | None = None
    case_id: str | None = None
    cost: float = 0.0
    # Memory feedback (operator MEMORY feature): what the agent changed deterministically
    # on this turn (echoed for the UI), and an optional un-saved suggestion to confirm.
    memory_action: dict[str, Any] | None = None
    memory_suggestion: MemorySuggestion | None = None
    # Set only for opt-in Workspace persistence. Stateless/case-scoped callers
    # continue to receive ``None``/omitted-compatible additive fields.
    conversation_id: str | None = None
    conversation_title: str | None = None
    idempotency_key: str | None = None
    effective_model: str | None = None
    effective_source_id: str | None = None
    effective_source_name: str | None = None
    truncated: bool = False
    # --- Chat revamp (SPEC §3.2; additive and lenient — see the section note). ---
    # Validated answer blocks (agents/blocks.py). Re-checked on every construction, so
    # a drifted stored block becomes a quiet fallback callout instead of a replay 503.
    blocks: list[dict[str, Any]] = Field(default_factory=list)
    blocks_version: int = BLOCKS_VERSION
    steps: list[ChatStep] = Field(default_factory=list)
    # None on legacy replays and compatibility-mode turns that recorded no usage.
    usage: TurnUsage | None = None
    citations: list[Citation] = Field(default_factory=list)
    console_links: list[ConsoleLink] = Field(default_factory=list)
    follow_ups: list[str] = Field(default_factory=list, max_length=_MAX_FOLLOW_UPS)
    answer_kind: ChatAnswerKind = "conversation"
    notice: TurnNotice | None = None
    # The D2 mode this answer ran with (None on legacy rows).
    stream_mode: ChatStreamMode | None = None
    turn_id: str | None = None
    # The assistant message id when persisted (reports reference it).
    message_id: str | None = None
    # Round 12 (WP-FIX1): the persisted id of the QUESTION this answers, when saved, so a
    # live transcript can name its own question like a restored one does (a search hit
    # or a link to it then finds it on screen). Never stored: the message is the truth.
    user_message_id: str | None = None
    # A model-proposed memory change awaiting human confirmation (§4.8).
    memory_proposal: MemoryProposal | None = None
    # Case-scoped turns (§4.6): whether the answer reached the case thread, apart from
    # the top ``notice`` (which a partial/timeout/cap/denied/policy notice can hold).
    # ``None`` when no case thread applied (Workspace, legacy rows, a D1 failure, a
    # turn stopped before it answered). The ``not_saved`` notice is still attached
    # when no other notice exists, so a client that ignores this field keeps working.
    case_saved: bool | None = None
    # The ``not_saved`` notice whenever ``case_saved`` is False, whatever the top
    # notice is: its ``retryable`` is True only for a store failure (SPEC A25: a re-run
    # bills again, so "Run again to save" is offered only when it can help; a missing
    # grant or case would fail the same way). ``None`` otherwise.
    case_save_notice: TurnNotice | None = None
    # --- Round 12 (SPEC §3.1; additive). A clarifying question instead of a guess (D10);
    # the report the server saved from this answer (D11); continuation steps used for the
    # final answer (D3); whether earlier context was summarised in this turn (D4).
    clarify: ChatClarify | None = None
    saved_report: ChatSavedReport | None = None
    # Additive (WP-API): the report the header asked for could not be saved.
    saved_report_error: ChatReportSaveError | None = None
    continued: int = Field(default=0, ge=0)
    compacted: bool = False
    # Round 12 (final review; additive): the command this turn answered (``"compact"``),
    # or None for an answer. A command reply makes no lookups, names no source, and
    # carries real usage (zero when no model call ran), never "not recorded".
    command: ChatCommand | None = None

    @model_validator(mode="before")
    @classmethod
    def _drop_lone_surrogates(cls, data: Any) -> Any:
        # Model text (``answer``) and log-derived values (table cells, a query) can
        # carry a lone surrogate from a JSON ``\ud800`` escape. Pydantic would reject
        # it and UTF-8 cannot encode it, which would abort ``turn.done`` or the
        # history write of an otherwise good answer, so it is dropped everywhere.
        return strip_lone_surrogates(data) if isinstance(data, dict) else data

    @field_validator("blocks", mode="before")
    @classmethod
    def _blocks(cls, value: Any) -> list[dict[str, Any]]:
        return parse_persisted_blocks(value)

    @field_validator("blocks_version", mode="before")
    @classmethod
    def _blocks_version(cls, value: Any) -> int:
        return value if isinstance(value, int) and not isinstance(value, bool) and value >= 1 else BLOCKS_VERSION

    @field_validator("steps", mode="before")
    @classmethod
    def _steps(cls, value: Any) -> list[Any]:
        return _bounded_steps(value)

    @field_validator("usage", mode="before")
    @classmethod
    def _usage(cls, value: Any) -> Any:
        return _lenient_model(TurnUsage, value)

    @field_validator("citations", mode="before")
    @classmethod
    def _citations(cls, value: Any) -> list[Any]:
        return _lenient_models(Citation, value, _MAX_CITATIONS)

    @field_validator("console_links", mode="before")
    @classmethod
    def _console_links(cls, value: Any) -> list[Any]:
        return _lenient_models(ConsoleLink, value, _MAX_CONSOLE_LINKS)

    @field_validator("follow_ups", mode="before")
    @classmethod
    def _follow_ups(cls, value: Any) -> list[str]:
        return _display_list(value, _MAX_FOLLOW_UPS, _FOLLOW_UP_CHARS)

    @field_validator("answer_kind", mode="before")
    @classmethod
    def _answer_kind(cls, value: Any) -> str:
        return _lenient_enum(value, CHAT_ANSWER_KINDS, "conversation")

    @field_validator("command", mode="before")
    @classmethod
    def _command(cls, value: Any) -> Any:
        return _lenient_enum(value, CHAT_COMMANDS, None)

    @field_validator("notice", mode="before")
    @classmethod
    def _notice(cls, value: Any) -> Any:
        return _lenient_model(TurnNotice, value)

    @field_validator("stream_mode", mode="before")
    @classmethod
    def _stream_mode(cls, value: Any) -> Any:
        return _lenient_enum(value, CHAT_STREAM_MODES, None)

    @field_validator("memory_proposal", mode="before")
    @classmethod
    def _memory_proposal(cls, value: Any) -> Any:
        return _lenient_model(MemoryProposal, value)

    @field_validator("case_saved", mode="before")
    @classmethod
    def _case_saved(cls, value: Any) -> bool | None:
        # Lenient like the other presentation fields: only a real bool is kept.
        return value if isinstance(value, bool) else None

    @field_validator("case_save_notice", mode="before")
    @classmethod
    def _case_save_notice(cls, value: Any) -> Any:
        return _lenient_model(TurnNotice, value)

    @model_validator(mode="after")
    def _cost_matches_usage(self) -> "ChatResponse":
        # SPEC §3.2: ``cost == usage.cost`` whenever usage is present.
        if self.usage is not None:
            self.cost = self.usage.cost
        return self


# --- §8 live token meter -------------------------------------------------------- #
class ChatToolInfo(BaseModel):
    """One row of the caller's tool catalogue ("What can the assistant access?")."""

    name: str
    label: str
    scope: ChatScope
    data_source: str = ""
    requires: list[str] = Field(default_factory=list)   # "resource:action", all-of
    # A kind-gated tool (no ``requires``, only per-kind grants) is allowed when at
    # least one of its kinds is.
    allowed: bool = False
    # The grants the caller lacks (empty when allowed). For a kind-gated tool with no
    # usable kind: every per-kind grant, any ONE of which unlocks it.
    missing: list[str] = Field(default_factory=list)
    # kind -> the extra "resource:action" that kind needs (empty for most tools).
    kind_requires: dict[str, str] = Field(default_factory=dict)
    # The kinds the caller may use (starters/popover show the rest as locked).
    kinds_allowed: list[str] = Field(default_factory=list)
    # False when this deployment switched the tool off by configuration (e.g.
    # ``max_indicator_lookups == 0``): no grant unlocks it, an administrator can turn
    # it back on in Settings. Independent of ``allowed`` (that is grants only).
    available: bool = True


class TextStreamingInfo(BaseModel):
    """Whether "Type out answers" can work for the effective chat model (§6.3)."""

    available: bool = False
    reason: TextStreamingReason | None = None


class ChatContextBounds(BaseModel):
    """The §4.2 bounds the meter and the run log display (no internal_domains)."""

    max_model_calls: int
    max_tool_calls: int
    max_parallel: int
    tool_timeout_s: int
    model_step_timeout_s: int
    turn_timeout_s: int
    turn_token_ceiling: int
    final_reserve_tokens: int
    observation_chars: int
    final_max_tokens: int
    max_indicator_lookups: int
    default_stream_mode: ChatStreamMode = "steps"
    allow_text_streaming: bool = True
    # Round 12 (SPEC D13): the org's "animate the console logo while chat works"
    # switch (``ChatAgentConfig.animated_brand``), so every viewer's brand ring honours it.
    animated_brand: bool = True

    model_config = ConfigDict(protected_namespaces=())

    @classmethod
    def from_config(cls, config: Any) -> "ChatContextBounds":
        """Project ``Preferences.chat_agent`` onto the public bounds."""
        return cls.model_validate({
            name: getattr(config, name) for name in cls.model_fields if hasattr(config, name)
        })


class ChatRates(BaseModel):
    """Effective per-million-token rates (demo-aware). ``models:read`` only."""

    input_per_million: float = Field(ge=0, allow_inf_nan=False)
    output_per_million: float = Field(ge=0, allow_inf_nan=False)
    cache_read_per_million: float | None = Field(default=None, ge=0, allow_inf_nan=False)


class ChatBudgetInfo(BaseModel):
    """The daily budget the meter's ring measures against. ``models:read`` only."""

    enabled: bool = False
    daily_limit: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    soft_warn_pct: float = Field(default=0.8, ge=0, le=1)
    on_exceed: Literal["warn", "block"] = "block"


class ChatContextInfo(BaseModel):
    """``GET /api/chat/context`` (SPEC §8): everything the composer meter needs.
    Money and budget fields are present only with ``models:read``; ``spent_today`` /
    ``remaining`` additionally need ``cost:view``. Without them the meter shows
    tokens only plus ``budget_state``."""

    model: str | None = None
    context_window: int | None = Field(default=None, ge=0)
    max_output_tokens: int = Field(default=0, ge=0)
    chars_per_token: int = Field(default=4, ge=1)
    # System prompt + the caller's granted tool signatures.
    static_prompt_tokens: int = Field(default=0, ge=0)
    # Estimate for the selected conversation's replayed history (<= 12 exchanges).
    history_tokens: int = Field(default=0, ge=0)
    history_exchanges: int = Field(default=0, ge=0)
    tools: list[ChatToolInfo] = Field(default_factory=list)
    text_streaming: TextStreamingInfo = Field(default_factory=TextStreamingInfo)
    bounds: ChatContextBounds
    # actual ÷ estimate of the last turn in this conversation (None until measured).
    calibration: float | None = Field(default=None, gt=0, allow_inf_nan=False)
    budget_state: ChatBudgetState | None = None
    rates: ChatRates | None = None
    simulated: bool | None = None
    budget: ChatBudgetInfo | None = None
    spent_today: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    remaining: float | None = Field(default=None, allow_inf_nan=False)
    # §10.5 empty-state starters, built server-side so Demo and production share one
    # shape (Demo: engine.demo_chat.DEMO_STARTERS; production: templated from live
    # context, never literal IOCs). The page shows a card only if all its tools are allowed.
    starters: list[ChatStarter] = Field(default_factory=list)
    # --- Round 12 (SPEC §3.1; additive). Chat limits mode (D1) and the operator timezone
    # used for calendar windows and buckets (D7). ``context_window`` above drives the
    # composer's context-use ring.
    limits_mode: Literal["unlimited", "bounded"] = "unlimited"
    timezone: str = "UTC"

    model_config = ConfigDict(protected_namespaces=())


# =========================================================================== #
# Round 13 chat starters (docs/research/2026-10-round13/SPEC-chat.md §3.2.1).
# Additive only: every field added to ChatStarter has a default, so a payload
# written before Round 13 (the six §10.5 starters, ``DEMO_STARTERS``) stays valid.
# Wording lives in ``agents/chat_starter_text.py``; ranking and the family registry
# in ``engine/chat_starters.py``. Starters are computed by code, never by a model
# (#6), and a referenced value is typed and fenced on the way to the model (#9).
# =========================================================================== #
StarterAction = Literal["send", "open_conversation", "use_prompt"]
StarterRefKind = Literal["case", "rule", "source", "campaign", "technique", "conversation", "prompt"]
StarterUrgency = Literal["none", "attention", "critical"]
StarterSurface = Literal["home", "thread", "case"]
STARTER_REF_KINDS: tuple[str, ...] = get_args(StarterRefKind)
STARTER_SURFACES: tuple[str, ...] = get_args(StarterSurface)
#: A starter key: the first 16 hex characters of ``sha256("<family>|<kind>|<value>")``
#: (``"<family>|"`` without a reference). Opaque to the client.
STARTER_KEY_PATTERN = r"^[0-9a-f]{16}$"
_STARTER_KEY_RE = re.compile(r"[0-9a-f]{16}")
#: At most this many cards per read, and keys per event (SPEC §3.5 step 3).
MAX_STARTERS = 6


class ChatStarterRef(BaseModel):
    """A typed reference a starter names (a case, rule, source, campaign, ATT&CK
    technique) or opens (a conversation, a saved prompt). ``value`` passes its kind's
    strict grammar (``chat_starter_text.ref_value``) unchanged, or the model refuses it:
    a value is never cut, quoted or altered (SPEC §3.8.1)."""

    model_config = ConfigDict(extra="forbid")

    kind: StarterRefKind
    value: str = Field(min_length=1, max_length=128)

    @model_validator(mode="after")
    def _grammar(self) -> "ChatStarterRef":
        from .agents.chat_starter_text import ref_value  # lazy: agents import models

        if ref_value(self.kind, self.value) != self.value:
            raise ValueError(f"not a valid {self.kind} reference")
        return self


class ChatStarter(BaseModel):
    """One starter card (SPEC §10.5; Round 13 SPEC-chat §3.2.1).

    ``id`` is the FAMILY id (one card per family; the pre-Round-13 ids investigate,
    hunt, posture, shift_brief, explain_metric and learn_app stay valid). ``label`` is
    a short family name and ``description`` equals ``reason``, for older clients. For
    action ``send``, ``prompt`` is both the visible question and the exact text the
    client sends with ``origin: "starter"`` (never edited, never put in the composer);
    dynamic templates render at most 100 characters. Action ``open_conversation`` and
    ``use_prompt`` cards are display-only: ``prompt`` is their card text (at most 120
    characters) and is never sent; ``ref`` names the conversation or saved prompt."""

    id: str = Field(min_length=1, max_length=40, pattern=r"^[a-z0-9_]+$")
    label: str = Field(min_length=1, max_length=40)
    description: str = Field(default="", max_length=120)
    prompt: str = Field(min_length=1, max_length=400)
    # Every tool the starter's plan needs; the card is hidden unless all are allowed.
    tools: list[str] = Field(default_factory=list, max_length=8)
    # --- Round 13 (additive; defaults keep every old payload valid) --------------- #
    #: The ``chat_starter_text`` template id the card was worded from.
    template: str | None = Field(default=None, pattern=r"^[a-z0-9_]{1,40}$")
    #: Why the card is here (at most 60 characters by copy): numbers, durations,
    #: times, closed-vocabulary words and configured source names only, never
    #: log-derived free text (SPEC §3.7).
    reason: str = Field(default="", max_length=80)
    action: StarterAction = "send"
    ref: ChatStarterRef | None = None
    #: Opaque key for ``POST /api/chat/starters/events`` (:data:`STARTER_KEY_PATTERN`).
    key: str | None = Field(default=None, pattern=STARTER_KEY_PATTERN)
    urgency: StarterUrgency = "none"
    as_of: str | None = None        # ISO 8601 UTC
    expires_at: str | None = None   # ISO 8601 UTC


class ChatCatchUpClause(BaseModel):
    """One clause of the catch-up line ("5 new cases (2 critical)") and the starter
    it sends when clicked (action ``send`` only; SPEC §3.6)."""

    text: str = Field(min_length=1, max_length=60)
    starter: ChatStarter

    @model_validator(mode="after")
    def _sends(self) -> "ChatCatchUpClause":
        if self.starter.action != "send":
            raise ValueError("a catch-up clause sends its starter")
        return self


class ChatCatchUp(BaseModel):
    """"Since {since_label}: clause, clause and clause." (at most 160 characters as a
    whole line; the server drops clauses from the end until it fits)."""

    since: str                     # ISO 8601 UTC
    since_label: str               # "09:12", "yesterday 18:40", "Mon 18:40", "12 Oct" (operator tz)
    clauses: list[ChatCatchUpClause] = Field(default_factory=list, max_length=4)


class ChatStartersInfo(BaseModel):
    """``GET /api/chat/starters`` (SPEC §3.2.2). ``enabled`` mirrors
    ``chat_agent.dynamic_starters``; when it is false the server returns the evergreen
    set only and no catch-up line. ``expires_at`` is ``as_of`` + 120 s."""

    surface: StarterSurface
    enabled: bool
    as_of: str
    expires_at: str
    timezone: str                  # IANA name (SlaPolicy.timezone)
    starters: list[ChatStarter] = Field(default_factory=list, max_length=MAX_STARTERS)
    catch_up: ChatCatchUp | None = None


class ChatStarterEvent(BaseModel):
    """``POST /api/chat/starters/events`` body (SPEC §3.2.2, §3.6). Presentation state
    only: it updates the caller's own starter state document, writes no audit row and
    stores no text (D10). A ``thread`` ``viewed`` event carries no keys."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["viewed", "used", "dismissed"]
    surface: StarterSurface = "home"
    keys: list[str] = Field(default_factory=list, max_length=MAX_STARTERS)

    @field_validator("keys")
    @classmethod
    def _keys(cls, value: list[str]) -> list[str]:
        for key in value:
            if not isinstance(key, str) or not _STARTER_KEY_RE.fullmatch(key):
                raise ValueError("each key is 16 lowercase hex characters")
        return value


class ChatTopicQuestion(BaseModel):
    """``GET /api/chat/topics/{topic_id}`` (SPEC §10.7 "Ask about this"): the
    templated question for a console_map topic. The page sends this text with
    ``origin="starter"``; it never sends free text of its own for a topic."""

    topic: str
    question: str


# --- Round 12 chat contracts (docs/research/2026-10-round12/SPEC.md §3.1) --------- #


class ChatStepProgress(BaseModel):
    """Progress of one long-running lookup (an exact aggregate scan). ``total`` is None
    when the store cannot say up front; ``unit`` is a display noun ("cases")."""

    done: int = Field(default=0, ge=0)
    total: int | None = Field(default=None, ge=0)
    unit: str = Field(default="", max_length=40)


class ChatClarify(BaseModel):
    """A clarifying question the model asked instead of guessing (SPEC D10). Option
    text is model-authored and may echo log values: the UI renders it as untrusted
    text, and a pick is sent with ``origin="clarify"`` (follow_up taint class, #9)."""

    question: str = Field(min_length=1, max_length=200)
    options: list[str] = Field(default_factory=list, max_length=4)
    allow_custom: bool = True

    @field_validator("options", mode="before")
    @classmethod
    def _options(cls, value: Any) -> list[str]:
        if not isinstance(value, list):
            return []
        out: list[str] = []
        for item in value:
            text = display_text(item, 80) if isinstance(item, str) else ""
            if text and text not in out:
                out.append(text)
            if len(out) == 4:
                break
        return out


class ChatSavedReport(BaseModel):
    """The report the server saved from this answer (SPEC D11). Created by the server
    from the persisted message, never by the model. ``skipped`` (additive): sections
    of the answer that did not fit the report's item or size limit."""

    id: str
    title: str = Field(default="", max_length=200)
    items: int = Field(default=0, ge=0)
    skipped: int = Field(default=0, ge=0)


ChatReportSaveErrorCode = Literal["report_limit", "report_unavailable", "report_empty"]


class ChatReportSaveError(BaseModel):
    """Why the report a chat answer asked for was NOT saved (SPEC D11; additive). The
    answer itself is saved; ``message`` is a server template, never model text.
    ``retryable``: the same save may work later (a store outage), so the UI can offer
    "Save as report"; a full library or an answer with nothing to save cannot.

    ``title`` and ``template`` (additive) record what the answer's header asked for, so
    "Save as report" (``POST /api/reports/from-answer``) saves the SAME report the server
    could not; the server reads them from the stored answer, never from the client.
    ``title`` is model-derived display text (#9); both are lenient on replay."""

    code: ChatReportSaveErrorCode
    message: str = Field(default="", max_length=300)
    retryable: bool = False
    title: str | None = Field(default=None, max_length=MAX_REPORT_TITLE_CHARS)
    template: ReportTemplateName | None = None

    @field_validator("title", mode="before")
    @classmethod
    def _requested_title(cls, value: Any) -> str | None:
        return (display_text(value, MAX_REPORT_TITLE_CHARS) or None) if isinstance(value, str) else None

    @field_validator("template", mode="before")
    @classmethod
    def _requested_template(cls, value: Any) -> Any:
        return _lenient_enum(value, REPORT_TEMPLATE_NAMES, None)


class ChatActiveTurn(BaseModel):
    """``GET /api/chat/turns/active`` (SPEC D13): one of the caller's running turns.
    ``label`` is an engine template, never model or log text."""

    turn_id: str
    conversation_id: str | None = None
    case_id: str | None = None
    started_at: str
    label: str = Field(default="", max_length=120)
    lookups: int = Field(default=0, ge=0)
    tokens: int = Field(default=0, ge=0)
    status: Literal["running", "needs_input"] = "running"


ChatFeedbackRating = Literal["up", "down"]
ChatFeedbackReason = Literal["wrong", "incomplete", "slow", "other"]


class ChatFeedbackRequest(BaseModel):
    """``POST /api/chat/feedback`` (SPEC §3.2). Stored per user and audited; never used
    to train a model."""

    conversation_id: str = Field(min_length=1, max_length=200)
    message_id: str = Field(min_length=1, max_length=200)
    rating: ChatFeedbackRating
    reason: ChatFeedbackReason | None = None
    comment: str = Field(default="", max_length=1000)


ChatContextInfo.model_rebuild()
ChatStep.model_rebuild()
ChatResponse.model_rebuild()


# --- §9.1 reports ----------------------------------------------------------------- #
def _report_title(value: Any) -> str:
    return display_text(value, MAX_REPORT_TITLE_CHARS)


class ReportItemSource(BaseModel):
    """Where an item came from (a caller-owned persisted Workspace message)."""

    conversation_id: str = Field(min_length=1, max_length=128)
    message_id: str = Field(min_length=1, max_length=128)
    block_id: str | None = Field(default=None, max_length=48)


# A report item's scope window: every distinct window its blocks state, joined with
# "; " (a whole answer can hold several), so it is bounded like a block caption.
REPORT_SCOPE_WINDOW_CHARS = 280


class ReportItemScope(BaseModel):
    """Scope captured server-side at add time (never client-supplied)."""

    window: str | None = Field(default=None, max_length=REPORT_SCOPE_WINDOW_CHARS)
    sources: list[str] = Field(default_factory=list, max_length=20)
    generated_by: str | None = Field(default=None, max_length=120)   # the model id
    app_version: str | None = Field(default=None, max_length=40)
    demo: bool = False

    @model_validator(mode="before")
    @classmethod
    def _sanitise(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        out = dict(data)
        for name, limit in (("window", REPORT_SCOPE_WINDOW_CHARS), ("generated_by", 120), ("app_version", 40)):
            raw = out.get(name)
            out[name] = (display_text(raw, limit) or None) if isinstance(raw, str) else None
        out["sources"] = _display_list(out.get("sources"), 20, 120)
        out["demo"] = out.get("demo") is True
        return out


class ReportSectionSnapshot(BaseModel):
    """The ``block`` of a ``section`` item: a whole added answer, titled by the
    user's question, holding the Markdown answer then that turn's blocks — up to
    ``MAX_SECTION_BLOCKS`` (the answer plus a full turn's 12). Anything past that is
    clipped and ``truncated`` says so (G4), never a silent loss."""

    title: str = Field(default="", max_length=MAX_REPORT_TITLE_CHARS)
    blocks: list[dict[str, Any]] = Field(default_factory=list, max_length=MAX_SECTION_BLOCKS)
    truncated: bool = False

    @model_validator(mode="before")
    @classmethod
    def _clip(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        out = dict(data)
        blocks = out.get("blocks")
        clipped = isinstance(blocks, (list, tuple)) and len(blocks) > MAX_SECTION_BLOCKS
        out["truncated"] = out.get("truncated") is True or clipped
        out["blocks"] = parse_persisted_blocks(blocks, limit=MAX_SECTION_BLOCKS)
        return out

    @field_validator("title", mode="before")
    @classmethod
    def _title(cls, value: Any) -> str:
        return _report_title(value)


class ReportItem(BaseModel):
    """One report item: a validated block snapshot or a whole-answer section."""

    id: str = Field(pattern=_SAFE_ID_PATTERN)
    kind: ReportItemKind = "block"
    # kind=block: one AnswerBlock dict; kind=section: a ReportSectionSnapshot dict.
    block: dict[str, Any]
    # User-authored; UNTRUSTED for any model call (fenced in the summary digest).
    note: str | None = Field(default=None, max_length=MAX_REPORT_NOTE_CHARS)
    source: ReportItemSource
    scope: ReportItemScope = Field(default_factory=ReportItemScope)
    added_at: str = Field(default_factory=iso_now)

    @model_validator(mode="before")
    @classmethod
    def _lenient(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        out = dict(data)
        out["kind"] = _lenient_enum(out.get("kind"), ("block", "section"), "block")
        note = out.get("note")
        out["note"] = (display_text(note, MAX_REPORT_NOTE_CHARS, multiline=True) or None) if isinstance(note, str) else None
        block = out.get("block")
        if out["kind"] == "section":
            snapshot = _lenient_model(ReportSectionSnapshot, block)
            out["block"] = snapshot.model_dump(mode="json") if snapshot else {"title": "", "blocks": [], "truncated": False}
        else:
            parsed = parse_persisted_blocks([block] if isinstance(block, dict) else [])
            out["block"] = parsed[0] if parsed else parse_persisted_blocks([{}])[0]
        if not isinstance(out.get("scope"), (dict, ReportItemScope)):
            out["scope"] = {}
        return out


class ReportSummary(BaseModel):
    """The AI-written executive summary (one gateway call over the §9.4 digest).
    Stale when ``based_on_version`` lags the report's ``version``."""

    executive_summary: str = Field(default="", max_length=MAX_REPORT_SUMMARY_CHARS)
    next_steps: list[str] = Field(default_factory=list, max_length=MAX_REPORT_NEXT_STEPS)
    model: str | None = None
    usage: TurnUsage = Field(default_factory=TurnUsage)
    generated_at: str = Field(default_factory=iso_now)
    based_on_version: int = Field(default=0, ge=0)

    @model_validator(mode="before")
    @classmethod
    def _lenient(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        out = dict(data)
        out["executive_summary"] = display_text(
            out.get("executive_summary"), MAX_REPORT_SUMMARY_CHARS, multiline=True,
        )
        out["next_steps"] = _display_list(out.get("next_steps"), MAX_REPORT_NEXT_STEPS, 280)
        out["usage"] = _lenient_model(TurnUsage, out.get("usage")) or TurnUsage()
        return out


class ReportSummaryEstimate(BaseModel):
    """``POST /api/reports/{id}/summary?dry_run=1``: what generating would cost."""

    prompt_tokens: int = Field(ge=0)
    max_output_tokens: int = Field(ge=0)
    total_tokens: int = Field(ge=0)
    # Present only with models:read (like the meter's money fields).
    cost: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    simulated: bool = False
    model: str | None = None


class Report(BaseModel):
    """A per-user report document (SPEC §9.1): <= 40 items, strict-CAS ``version``."""

    id: str = Field(pattern=_SAFE_ID_PATTERN)
    owner: str
    title: str = Field(min_length=1, max_length=MAX_REPORT_TITLE_CHARS)
    template: ReportTemplateName = "custom"
    # The conversation whose draft this is (<= 1 draft per conversation).
    conversation_id: str | None = None
    items: list[ReportItem] = Field(default_factory=list, max_length=MAX_REPORT_ITEMS)
    summary: ReportSummary | None = None
    created_at: str = Field(default_factory=iso_now)
    updated_at: str = Field(default_factory=iso_now)
    version: int = Field(default=1, ge=0)

    @model_validator(mode="before")
    @classmethod
    def _lenient(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        out = dict(data)
        out["title"] = _report_title(out.get("title")) or "Untitled report"
        out["template"] = _lenient_enum(out.get("template"), REPORT_TEMPLATE_NAMES, "custom")
        out["items"] = _lenient_models(ReportItem, out.get("items"), MAX_REPORT_ITEMS)
        out["summary"] = _lenient_model(ReportSummary, out.get("summary"))
        return out

    @property
    def summary_stale(self) -> bool:
        return self.summary is not None and self.summary.based_on_version < self.version


class ReportListEntry(BaseModel):
    """One row of the per-user report index (``GET /api/reports``).

    ``conversation_id`` names the conversation whose DRAFT this report is (at most one
    per conversation); ``source_conversation_id`` names the conversation the report
    came from (the one conversation all its items name, else the draft's), for the
    library's "Source conversation" column. A report saved from an answer or a whole
    conversation is never a draft, so it carries only the second. Rows written before
    the field existed read ``None`` until the report next changes."""

    id: str
    title: str
    template: ReportTemplateName = "custom"
    conversation_id: str | None = None
    source_conversation_id: str | None = None
    item_count: int = Field(default=0, ge=0)
    created_at: str | None = None
    updated_at: str
    version: int = Field(default=1, ge=0)
    has_summary: bool = False

    @model_validator(mode="before")
    @classmethod
    def _lenient(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        out = dict(data)
        out["title"] = _report_title(out.get("title")) or "Untitled report"
        out["template"] = _lenient_enum(out.get("template"), REPORT_TEMPLATE_NAMES, "custom")
        return out


class ReportCreateRequest(BaseModel):
    """``POST /api/reports``."""

    model_config = ConfigDict(extra="forbid")

    title: str = Field(default="Untitled report", min_length=1, max_length=MAX_REPORT_TITLE_CHARS)
    template: ReportTemplateName = "custom"
    conversation_id: str | None = Field(default=None, max_length=128, pattern=_SAFE_ID_PATTERN)

    @field_validator("title")
    @classmethod
    def _title(cls, value: str) -> str:
        return _clean_conversation_title(value)


class ReportPatchRequest(BaseModel):
    """``PATCH /api/reports/{id}``: title, template, item order, notes, removals —
    all under ``expected_version`` (409 ``report_version_conflict`` on mismatch).
    ``item_order`` must be a permutation of the remaining item ids; ``notes`` maps
    item id → note (``null`` clears it)."""

    model_config = ConfigDict(extra="forbid")

    expected_version: int = Field(ge=0)
    title: str | None = Field(default=None, min_length=1, max_length=MAX_REPORT_TITLE_CHARS)
    template: ReportTemplateName | None = None
    item_order: list[str] | None = Field(default=None, max_length=MAX_REPORT_ITEMS)
    notes: dict[str, str | None] | None = Field(default=None, max_length=MAX_REPORT_ITEMS)
    remove_items: list[str] | None = Field(default=None, max_length=MAX_REPORT_ITEMS)

    @field_validator("title")
    @classmethod
    def _title(cls, value: str | None) -> str | None:
        return None if value is None else _clean_conversation_title(value)

    @field_validator("item_order", "remove_items")
    @classmethod
    def _ids(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        if any(not _SAFE_ID_RE.match(i) for i in value):
            raise ValueError("item ids must be plain ids")
        if len(set(value)) != len(value):
            raise ValueError("item ids must be unique")
        return value

    @field_validator("notes")
    @classmethod
    def _notes(cls, value: dict[str, str | None] | None) -> dict[str, str | None] | None:
        if value is None:
            return None
        out: dict[str, str | None] = {}
        for item_id, note in value.items():
            if not _SAFE_ID_RE.match(item_id):
                raise ValueError("note keys must be item ids")
            if note is not None and len(note) > MAX_REPORT_NOTE_CHARS:
                raise ValueError(f"a note is at most {MAX_REPORT_NOTE_CHARS} characters")
            out[item_id] = None if note is None else (display_text(note, MAX_REPORT_NOTE_CHARS, multiline=True) or None)
        return out


class ReportDeleteRequest(BaseModel):
    """``DELETE /api/reports/{id}`` body (strict tombstone under ``expected_version``)."""

    model_config = ConfigDict(extra="forbid")

    expected_version: int = Field(ge=0)


class ReportAddRequest(BaseModel):
    """``POST /api/reports/add``: add BY REFERENCE. The server loads the block (or the
    whole answer as a ``section`` when ``block_id`` is absent) from the caller-owned
    persisted Workspace message and snapshots it; client-supplied block JSON is never
    accepted, so case-scoped content cannot be added by construction."""

    model_config = ConfigDict(extra="forbid")

    conversation_id: str = Field(min_length=1, max_length=128, pattern=_SAFE_ID_PATTERN)
    message_id: str = Field(min_length=1, max_length=128, pattern=_SAFE_ID_PATTERN)
    block_id: str | None = Field(default=None, max_length=48, pattern=BLOCK_ID_PATTERN)
    report_id: str | None = Field(default=None, max_length=128, pattern=_SAFE_ID_PATTERN)


class ReportSummaryRequest(BaseModel):
    """``POST /api/reports/{id}/summary`` body (``?dry_run=1`` is a query flag)."""

    model_config = ConfigDict(extra="forbid")

    idempotency_key: str | None = Field(default=None, min_length=8, max_length=128, pattern=r"^[A-Za-z0-9._:-]+$")
    expected_version: int | None = Field(default=None, ge=0)


class InvestigateRequest(BaseModel):
    """Start an investigation. Provide either a known cluster signature/case, or an
    ad-hoc entity + event ids (Surface 2 row click)."""

    cluster_signature: str | None = None
    entity: Entity | None = None
    group_by: EntityType = EntityType.IP
    event_ids: list[str] = Field(default_factory=list)
    rule_values: list[str] = Field(default_factory=list)
    # Explicit originating PULL source. Additive for older clients; when supplied,
    # both event reconstruction and every investigator query stay on this connector.
    source_id: str | None = None
    source_surface: SourceSurface = SourceSurface.INVESTIGATE
    # Optional per-request override of the starting lookback window for an entity
    # investigation (additive; the proxy forwards it). Falls back to
    # ``Preferences.investigate_lookback``. The route auto-widens from here on 0 hits.
    lookback: str | None = None


# =========================================================================== #
# Round 14 contracts (docs/research/2026-10-round14/SPEC.md). This module is the one
# home of every new wire model; the engines import them (``runbook_model.py`` and the
# routes never redefine a field) and ``webui/src/lib/types-*.ts`` mirror them. Every
# model below is presentation or human-workflow data: none is ever read by
# ``engine/case_manager.decide()`` or ``AutoClosePolicy`` (#3), and every free-text
# value that came from a log, a case or a person is plain data the Console renders as
# text and a prompt only ever sees inside an untrusted fence (#9).
# =========================================================================== #

# --------------------------------------------------------------------------- #
# §4.4.2 GET /api/metrics/breakdown
# --------------------------------------------------------------------------- #
BreakdownKind = Literal["cases", "usage"]
#: ``by`` and ``then`` for ``kind=cases`` (``case_aggregate`` group fields).
BreakdownCaseField = Literal[
    "rule", "source", "severity", "status", "verdict", "closed_by", "assignee",
    "mitre_tactic", "mitre_technique",
]
#: ``by`` and ``then`` for ``kind=usage`` (``case_aggregate.USAGE_GROUP_FIELDS``).
BreakdownUsageField = Literal["surface", "role", "model", "provider", "service_tier"]
BreakdownField = Literal[
    "rule", "source", "severity", "status", "verdict", "closed_by", "assignee",
    "mitre_tactic", "mitre_technique",
    "surface", "role", "model", "provider", "service_tier",
]
BREAKDOWN_CASE_FIELDS: tuple[str, ...] = get_args(BreakdownCaseField)
BREAKDOWN_USAGE_FIELDS: tuple[str, ...] = get_args(BreakdownUsageField)
#: A case counts once in each value of these fields (a case with two rules is in both
#: rows), so their rows never sum to ``total``.
BREAKDOWN_MULTI_VALUED_FIELDS: frozenset[str] = frozenset({"rule", "mitre_tactic", "mitre_technique"})
BreakdownBucket = Literal["hour", "day", "week"]
BreakdownStatusGroup = Literal["open", "closed"]
#: The case metric families every ``kind=cases`` group carries. AI verdict family:
#: ``verdicted = verdict_tp + verdict_fp + verdict_needs_human``. Analyst outcome
#: family (analyst-policy closes excluded): ``count = analyst_tp + analyst_fp +
#: analyst_ungraded``. A surface names the family it shows and never mixes them.
BREAKDOWN_CASE_METRICS: tuple[str, ...] = (
    "count", "open_now", "verdicted", "verdict_tp", "verdict_fp", "verdict_needs_human",
    "analyst_tp", "analyst_fp", "analyst_ungraded",
)
BREAKDOWN_USAGE_METRICS: tuple[str, ...] = ("calls", "cost_usd")
BREAKDOWN_DEFAULT_TOP = 10
BREAKDOWN_MAX_TOP = 50
BREAKDOWN_DEFAULT_WINDOW = "now-7d"
#: ``filter_rule``: one exact rule value, 1 to 256 printable characters.
BREAKDOWN_FILTER_RULE_MAX_CHARS = 256


class MetricsBreakdownGroup(BaseModel):
    """One row of a breakdown. ``key`` is the ``by`` value (``None`` is the empty
    group, for example the unassigned cases); ``then_key`` the ``then`` value;
    ``bucket`` the zero-filled calendar bucket label. Keys are untrusted plain
    strings (rule ids, source names, technique names). Case metrics are filled for
    ``kind=cases`` and ``None`` for ``kind=usage``; ``calls`` and ``cost_usd`` the
    other way round (for usage ``count`` equals ``calls``)."""

    key: str | None = None
    then_key: str | None = None
    bucket: str | None = None
    count: int = 0
    open_now: int | None = None
    verdicted: int | None = None
    verdict_tp: int | None = None
    verdict_fp: int | None = None
    verdict_needs_human: int | None = None
    analyst_tp: int | None = None
    analyst_fp: int | None = None
    analyst_ungraded: int | None = None
    calls: int | None = None
    cost_usd: float | None = None


class MetricsBreakdownOther(BaseModel):
    """The exact remainder past ``top``: how many records and how many groups."""

    count: int = 0
    groups: int = 0
    calls: int | None = None
    cost_usd: float | None = None


class MetricsBreakdownBucket(BaseModel):
    """One zero-filled calendar bucket of a bucketed breakdown, in order."""

    label: str
    in_progress: bool = False


class MetricsBreakdown(BaseModel):
    """``GET /api/metrics/breakdown`` (SPEC §4.4.2): exact case or usage counts by one
    or two fields over a window, from the same engine as the chat's ``case_stats``,
    so dashboards and chat agree on every number. ``exact`` is false and ``partial``
    true when a store failure cut the scan (the figures are then lower bounds, said
    so by the widget). ``multi_valued`` warns that rows do not sum to ``total``."""

    kind: BreakdownKind = "cases"
    by: BreakdownField
    then: BreakdownField | None = None
    bucket: BreakdownBucket | None = None
    status_group: BreakdownStatusGroup | None = None
    window_label: str = ""
    window_from: str | None = None
    window_to: str | None = None
    total: int = 0
    exact: bool = True
    partial: bool = False
    partial_reason: str | None = None
    multi_valued: bool = False
    groups: list[MetricsBreakdownGroup] = Field(default_factory=list)
    buckets: list[MetricsBreakdownBucket] = Field(default_factory=list)
    other: MetricsBreakdownOther | None = None


# --------------------------------------------------------------------------- #
# §4.5.5, §4.5.10 the audit read API
# --------------------------------------------------------------------------- #
AuditScope = Literal["people", "agent", "all"]
AUDIT_SCOPES: tuple[str, ...] = get_args(AuditScope)
AuditCategory = Literal["access", "config", "case_work", "agent", "system"]
AUDIT_CATEGORIES: tuple[str, ...] = get_args(AuditCategory)
AuditCountRelation = Literal["eq", "gte"]
#: E12: opaque store-prefixed record ids, ``demo:`` first for Demo store rows:
#:
#: * ``es:<index>:<b64>``: the hit's index (never contains ``:``) and its ``_id`` as
#:   unpadded base64url of the UTF-8 bytes. Keyed rows use their ``event_id`` as the
#:   ``_id`` (``job:<id>:transition:3``, ``proposal-decision:<id>:approve``, up to the
#:   512-byte Elasticsearch limit, so at most 683 encoded characters), and encoding
#:   every ``_id`` keeps any of them, auto-generated or keyed, inside one URL-safe
#:   alphabet (no ``/`` or ``%`` in ``GET /api/audit/records/{record_id}``).
#: * ``sql:<row id>``: canonical decimal; keyed rows have a negative surrogate id.
#: * ``mem:<n>``: an in-memory store's sequence number.
#:
#: Build and parse them only with :func:`encode_audit_record_id` and
#: :func:`decode_audit_record_id`. ASCII classes on purpose: the Rust regex engine.
AUDIT_ES_ID_MAX_BYTES = 512
AUDIT_ES_INDEX_MAX_CHARS = 255
AUDIT_RECORD_ID_PATTERN = (
    r"^(demo:)?(es:[a-z0-9._+-]{1,255}:[A-Za-z0-9_-]{2,683}"
    r"|sql:-?[1-9][0-9]{0,18}|mem:[0-9]{1,12})$"
)
#: The longest record id the grammar admits (``demo:es:`` + index + ``:`` + 683).
AUDIT_RECORD_ID_MAX_CHARS = len("demo:es:") + AUDIT_ES_INDEX_MAX_CHARS + 1 + 683
_AUDIT_RECORD_ID_RE = re.compile(AUDIT_RECORD_ID_PATTERN)
_AUDIT_ES_INDEX_RE = re.compile(r"[a-z0-9._+-]{1,255}")
_SQL_ROW_ID_LIMIT = (1 << 63) - 1
AuditRecordStore = Literal["es", "sql", "mem"]


class AuditRecordRef(NamedTuple):
    """A parsed audit record id: which store, and where in it. ``ref`` is the raw
    Elasticsearch ``_id`` (decoded), the SQL row id or the in-memory number."""

    store: AuditRecordStore
    ref: str | int
    index: str | None = None
    demo: bool = False


def encode_audit_record_id(
    store: AuditRecordStore, ref: str | int, *, index: str | None = None, demo: bool = False,
) -> str:
    """The E12 ``record_id`` of one stored audit row (the only way to build one).
    Raises ``ValueError`` for a value the store cannot hold (an empty or over-long
    ``_id``, an index with ``:`` or upper case, a SQL id of 0 or out of range)."""
    if store == "es":
        if not isinstance(index, str) or not _AUDIT_ES_INDEX_RE.fullmatch(index):
            raise ValueError("an Elasticsearch audit record needs its lower-case index name")
        raw = str(ref).encode("utf-8")
        if not raw or len(raw) > AUDIT_ES_ID_MAX_BYTES:
            raise ValueError("an Elasticsearch _id is 1 to 512 bytes")
        body = f"es:{index}:{base64.urlsafe_b64encode(raw).rstrip(b'=').decode('ascii')}"
    elif store == "sql":
        if isinstance(ref, bool) or not isinstance(ref, int) or ref == 0 or abs(ref) > _SQL_ROW_ID_LIMIT:
            raise ValueError("a SQL audit row id is a non-zero 64-bit integer")
        body = f"sql:{ref}"
    elif store == "mem":
        if isinstance(ref, bool) or not isinstance(ref, int) or not 0 <= ref < 10**12:
            raise ValueError("an in-memory audit record number is 0 to 999,999,999,999")
        body = f"mem:{ref}"
    else:
        raise ValueError(f"unknown audit record store {store!r}")
    record_id = f"demo:{body}" if demo else body
    if not _AUDIT_RECORD_ID_RE.fullmatch(record_id):  # defensive: never mint an unparsable id
        raise ValueError("the audit record id does not fit the E12 grammar")
    return record_id


def decode_audit_record_id(record_id: str) -> AuditRecordRef:
    """Parse an E12 ``record_id`` (``GET /api/audit/records/{record_id}``, the
    ``#/audit?record=`` link). Raises ``ValueError`` for anything
    :func:`encode_audit_record_id` would not have produced, including a
    non-canonical base64url form, so one row has exactly one id."""
    if not isinstance(record_id, str) or not _AUDIT_RECORD_ID_RE.fullmatch(record_id):
        raise ValueError("not an audit record id")
    demo = record_id.startswith("demo:")
    body = record_id[5:] if demo else record_id
    store, _, rest = body.partition(":")
    if store == "sql":
        row_id = int(rest)
        if abs(row_id) > _SQL_ROW_ID_LIMIT:
            raise ValueError("not an audit record id")
        return AuditRecordRef("sql", row_id, None, demo)
    if store == "mem":
        return AuditRecordRef("mem", int(rest), None, demo)
    index, _, encoded = rest.partition(":")
    try:
        raw = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
        doc_id = raw.decode("utf-8")
    except (binascii.Error, ValueError) as exc:
        raise ValueError("not an audit record id") from exc
    if not raw or len(raw) > AUDIT_ES_ID_MAX_BYTES or (
        base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii") != encoded
    ):
        raise ValueError("not an audit record id")
    return AuditRecordRef("es", doc_id, index, demo)
AUDIT_PAGE_DEFAULT_LIMIT = 50
AUDIT_LEGACY_DEFAULT_LIMIT = 100
AUDIT_PAGE_MAX_LIMIT = 200
AUDIT_TOTAL_TRACK_LIMIT = 10_000
AUDIT_EXPORT_MAX_ROWS = 100_000
#: ``GET /api/audit/count?cap=``: at most one past the export ceiling.
AUDIT_COUNT_MAX_CAP = 100_001
AUDIT_SEARCH_MAX_CHARS = 200


class AuditRecord(BaseModel):
    """One audit row as the read API returns it (SPEC §4.5.10): the stored
    :class:`AuditDoc` fields, the Round 14 fields when the row carries them (absent on
    legacy rows, never shown empty) and the read-time projections.

    Read leniently: a stored row is never rejected because a value drifted. An
    unknown ``action_type`` keeps its token (it is categorised as System, never
    hidden); an invalid Round 14 value is dropped as not recorded. ``outcome`` and
    ``actor_type`` may be derived for a legacy row, which ``*_derived`` says.
    ``category`` and ``event_label`` come from ``audit/event_categories.json``. Every
    value renders as plain text (#9); ``prompt_excerpt`` and ``tool_output_summary``
    carry fenced untrusted log data."""

    record_id: str = Field(pattern=AUDIT_RECORD_ID_PATTERN)
    event_id: str | None = None
    app_version: str | None = None
    build_sha: str | None = None
    ts: str = ""
    case_id: str | None = None
    source_id: str | None = None
    surface: str = ""
    actor: str = ""
    action_type: str = ""
    model: str | None = None
    prompt_excerpt: str | None = None
    query_text: str | None = None
    tool_name: str | None = None
    tool_input: Any = None
    tool_output_summary: str | None = None
    result_summary: str | None = None
    outcome: AuditOutcome | None = None
    actor_type: AuditActorType | None = None
    action: str | None = Field(default=None, max_length=AUDIT_ACTION_MAX_CHARS, pattern=AUDIT_ACTION_PATTERN)
    actor_role: str | None = None
    client: AuditClient | None = None
    session_ref: str | None = None
    target: AuditTarget | None = None
    changes: list[AuditChange] | None = None
    request_id: str | None = None
    run_id: str | None = None
    outcome_derived: bool = False
    actor_type_derived: bool = False
    category: AuditCategory = "system"
    event_label: str = ""
    demo: bool = False
    truncated_fields: list[str] = Field(default_factory=list)

    @field_validator("outcome", mode="before")
    @classmethod
    def _lenient_outcome(cls, value: Any) -> Any:
        return _lenient_enum(value, AUDIT_OUTCOMES, None)

    @field_validator("actor_type", mode="before")
    @classmethod
    def _lenient_actor_type(cls, value: Any) -> Any:
        return _lenient_enum(value, AUDIT_ACTOR_TYPES, None)

    @field_validator("action", mode="before")
    @classmethod
    def _lenient_action(cls, value: Any) -> Any:
        if isinstance(value, str) and len(value) <= AUDIT_ACTION_MAX_CHARS and _AUDIT_ACTION_RE.fullmatch(value):
            return value
        return None

    @field_validator("client", mode="before")
    @classmethod
    def _lenient_client(cls, value: Any) -> Any:
        return _lenient_model(AuditClient, value)

    @field_validator("target", mode="before")
    @classmethod
    def _lenient_target(cls, value: Any) -> Any:
        return _lenient_model(AuditTarget, value)

    @field_validator("changes", mode="before")
    @classmethod
    def _lenient_changes(cls, value: Any) -> Any:
        """A stored ``[]`` is a recorded "no changes"; a value that is not a list, or
        a non-empty list none of whose entries is readable, is "not recorded"
        (``None``), never presented as an empty change set."""
        if not isinstance(value, (list, tuple)):
            return None
        if not value:
            return []
        return _lenient_models(AuditChange, value, AUDIT_MAX_CHANGES) or None

    @field_validator("category", mode="before")
    @classmethod
    def _lenient_category(cls, value: Any) -> Any:
        return _lenient_enum(value, AUDIT_CATEGORIES, "system")

    @field_validator(
        "case_id", "source_id", "model", "prompt_excerpt", "query_text", "tool_name",
        "tool_output_summary", "result_summary", "actor_role", "session_ref", "request_id",
        "run_id", "event_id", "app_version", "build_sha", mode="before",
    )
    @classmethod
    def _optional_text(cls, value: Any) -> Any:
        if value is None or isinstance(value, str):
            return value
        return str(value)

    @field_validator("ts", "surface", "actor", "action_type", "event_label", mode="before")
    @classmethod
    def _text(cls, value: Any) -> Any:
        if value is None:
            return ""
        return value if isinstance(value, str) else str(value)

    # Fields a legacy row lacks are omitted from the response, not sent as ``null``
    # (the inspector shows only what the row recorded).
    @model_serializer(mode="wrap")
    def _omit_unrecorded(self, handler: Any):  # noqa: ANN202
        data = handler(self)
        if isinstance(data, dict):
            for key in AUDIT_ROUND14_FIELDS:
                if key in data and data[key] is None:
                    del data[key]
        return data


class AuditRetention(BaseModel):
    """How long the deployment keeps the audit log, for the page's scope line. A
    volatile store keeps it in memory only (lost on restart)."""

    hot_days: int | None = None
    warm_days: int | None = None
    volatile: bool = False


class AuditPage(BaseModel):
    """``GET /api/audit`` (SPEC §4.5.10). ``records`` and ``total`` keep the old
    ``AuditListResponse`` keys so existing clients keep working. ``total`` is exact
    when ``total_relation`` is ``eq`` and a lower bound when it is ``gte``.
    ``run_totals`` gives, for every ``run_id`` on this page, the run's event count
    under the same filters, so a group split across pages says "6 of 10 steps"."""

    records: list[AuditRecord] = Field(default_factory=list)
    total: int = 0
    next_cursor: str | None = None
    total_relation: AuditCountRelation = "eq"
    run_totals: dict[str, int] = Field(default_factory=dict)
    retention: AuditRetention = Field(default_factory=AuditRetention)


class AuditCount(BaseModel):
    """``GET /api/audit/count``: exact up to the requested cap, then ``gte``."""

    count: int = 0
    relation: AuditCountRelation = "eq"


# --------------------------------------------------------------------------- #
# §4.6.2 GET /api/rules/summary
# --------------------------------------------------------------------------- #
SeverityLevel = Literal["info", "low", "medium", "high", "critical"]
SEVERITY_LEVELS: tuple[str, ...] = get_args(SeverityLevel)
#: The fixed display order of every severity breakdown (all five, zeros included).
SEVERITY_LEVELS_DESCENDING: tuple[str, ...] = ("critical", "high", "medium", "low", "info")
RuleSectionStatus = Literal["ok", "forbidden", "unsupported", "unavailable"]
RULE_SUMMARY_DEFAULT_WINDOW = "now-3d"
RULE_VALUE_MAX_CHARS = 256
RULE_SUMMARY_TOP_ROWS = 10
RULE_SUMMARY_LATEST_CASES = 5

RuleSummaryWindowWire = TypedDict("RuleSummaryWindowWire", {"label": str, "from": str, "to": str})


class RuleSummaryWindow(BaseModel):
    """The window a rule summary measured: ``{label, from, to}`` (ISO UTC)."""

    model_config = ConfigDict(populate_by_name=True)

    label: str = ""
    from_: str = Field(default="", alias="from")
    to: str = ""

    # ``plain`` + a TypedDict return keeps the wire key ``from`` whatever the caller's
    # ``by_alias`` setting (the TimeRange pattern).
    @model_serializer(mode="plain")
    def _serialise(self) -> RuleSummaryWindowWire:
        return {"label": self.label, "from": self.from_, "to": self.to}


class RuleSeverityPoint(BaseModel):
    """One time bucket of a rule's alerts, counted per named level."""

    t: str
    critical: int = 0
    high: int = 0
    medium: int = 0
    low: int = 0
    info: int = 0


class RuleSeveritySeries(BaseModel):
    """Alerts over time by named level. ``bucket`` is the bucket width ("12h")."""

    bucket: str = ""
    levels: list[SeverityLevel] = Field(default_factory=lambda: list(SEVERITY_LEVELS_DESCENDING))
    points: list[RuleSeverityPoint] = Field(default_factory=list)


class RuleSummarySource(BaseModel):
    """A source that contributed to the alert figures, and whether it could filter
    on the rule exactly (``False``: counted from a bounded newest-N sample)."""

    id: str
    name: str = ""
    exact: bool = True


class RuleSummaryAlerts(BaseModel):
    """The alert figures. ``count_relation`` is ``gte`` when any source was sampled;
    the Console then never names the count in "Open all N in Logs"."""

    status: RuleSectionStatus = "ok"
    reason: str | None = None
    count: int | None = None
    count_relation: AuditCountRelation = "eq"
    first_seen: str | None = None
    last_seen: str | None = None
    series: RuleSeveritySeries | None = None
    sources: list[RuleSummarySource] = Field(default_factory=list)


class RuleTopRow(BaseModel):
    """One row of a top list (an IP, a host or a user) with its count. Untrusted."""

    value: str
    kind: str | None = None
    count: int = 0


class RuleSummaryTopList(BaseModel):
    """A bounded top list (at most 10 rows); ``exact`` false when sampled."""

    status: RuleSectionStatus = "ok"
    reason: str | None = None
    rows: list[RuleTopRow] = Field(default_factory=list)
    exact: bool = True


class RuleCaseOutcomes(BaseModel):
    """The analyst-outcome family only (analyst-policy closes excluded); the AI
    verdict family is never labelled as an analyst outcome."""

    analyst_tp: int = 0
    analyst_fp: int = 0
    analyst_ungraded: int = 0


class RuleCaseRow(BaseModel):
    """One of the newest cases from the rule (at most 5), named by case number."""

    case_id: str
    case_number: str = ""
    title: str = ""
    status: str = ""
    verdict: str | None = None


class RuleSummaryCases(BaseModel):
    """Cases whose ``rule_ids`` hold the rule, exact through ``case_aggregate``."""

    status: RuleSectionStatus = "ok"
    reason: str | None = None
    count: int | None = None
    open_now: int | None = None
    outcomes: RuleCaseOutcomes | None = None
    latest: list[RuleCaseRow] = Field(default_factory=list)


class RuleSuiteDefinition(BaseModel):
    """The summary of a suite detection rule (``Preferences.rule_catalog``)."""

    name: str
    enabled: bool = True
    description: str = ""
    mitre: list[str] = Field(default_factory=list)
    priority: int | None = None


class RuleSummaryDefinition(BaseModel):
    """Where the rule is defined: ``suite`` with its summary, or ``source`` meaning
    "Defined in the source SIEM" (no settings link)."""

    status: RuleSectionStatus = "ok"
    reason: str | None = None
    kind: Literal["suite", "source"] | None = None
    suite_rule: RuleSuiteDefinition | None = None


class RuleSummaryTuning(BaseModel):
    """The rule's threshold-tuning state (needs ``automation:read``)."""

    status: RuleSectionStatus = "ok"
    reason: str | None = None
    wilson_lower_bound: float | None = None
    samples: int | None = None
    proposed_change: dict[str, Any] | None = None
    last_tuned: str | None = None


class RuleSummaryAnalystPolicy(BaseModel):
    """The operator's "declared benign" policy for the rule, or ``None``."""

    status: RuleSectionStatus = "ok"
    reason: str | None = None
    policy: dict[str, Any] | None = None


class RuleSummary(BaseModel):
    """``GET /api/rules/summary`` (SPEC §4.6.2): one rule's picture. Each section
    checks its own grant and carries its own status, so the rule sheet degrades per
    section. No model call (#6) and no raw rows (#7): the latest alerts come from
    ``GET /api/logs?rule=``. The rule value and every IP, host and title are
    untrusted plain strings (#9)."""

    rule: str = Field(min_length=1, max_length=RULE_VALUE_MAX_CHARS)
    window: RuleSummaryWindow = Field(default_factory=RuleSummaryWindow)
    alerts: RuleSummaryAlerts = Field(default_factory=RuleSummaryAlerts)
    top_source_ips: RuleSummaryTopList = Field(default_factory=RuleSummaryTopList)
    top_targets: RuleSummaryTopList = Field(default_factory=RuleSummaryTopList)
    cases: RuleSummaryCases = Field(default_factory=RuleSummaryCases)
    definition: RuleSummaryDefinition = Field(default_factory=RuleSummaryDefinition)
    tuning: RuleSummaryTuning = Field(default_factory=RuleSummaryTuning)
    analyst_policy: RuleSummaryAnalystPolicy = Field(default_factory=RuleSummaryAnalystPolicy)


# --------------------------------------------------------------------------- #
# §4.10.2 the runbook model (``engine/runbook_model.py`` imports these and owns
# ``validate_runbook``, the Markdown parser and ``render_runbook_prompt``).
#
# The Pydantic models fix the shape: field types, the closed vocabularies and the
# numeric bounds. The content rules (lengths, list sizes, id grammars, the closed
# template-value set, cross-references between steps, the prompt budget) are checked
# by ``validate_runbook`` so the editor, import and migration report every problem
# as a plain sentence instead of failing on the first one. A draft may therefore hold
# content that ``validate_runbook`` rejects; only a valid version can be published,
# and only Published text ever reaches a prompt as trusted guidance (#9).
# --------------------------------------------------------------------------- #
StepKind = Literal["check", "lookup", "decision", "action", "record"]
STEP_KINDS: tuple[str, ...] = get_args(StepKind)
#: Phases are a fixed vocabulary (NIST SP 800-61r3 and SANS PICERL, SPEC §4.10.2); a
#: runbook uses any ordered subset.
PhaseId = Literal["triage", "investigate", "contain", "eradicate", "recover", "close"]
PHASE_IDS: tuple[str, ...] = get_args(PhaseId)
#: Console labels of the phases (sentence case, never the retired word).
PHASE_LABELS: dict[str, str] = {
    "triage": "Triage",
    "investigate": "Investigate",
    "contain": "Contain",
    "eradicate": "Eradicate",
    "recover": "Recover",
    "close": "Close and learn",
}
RunbookEntityType = Literal["ip", "host", "user", "domain", "hash", "url", "email", "process", "file"]
RUNBOOK_ENTITY_TYPES: tuple[str, ...] = get_args(RunbookEntityType)
RunbookVerdict = Literal["TRUE_POSITIVE", "FALSE_POSITIVE", "NEEDS_HUMAN"]
LookupTool = Literal["log_stats", "log_search", "enrich", "related_cases", "campaign", "mitre"]
LOOKUP_TOOLS: tuple[str, ...] = get_args(LookupTool)
LookupRunMode = Literal["on_attach", "on_demand"]
StepEvidenceRule = Literal["none", "note", "note_or_attachment"]
StepStatus = Literal["todo", "in_progress", "done", "not_applicable", "blocked"]
STEP_STATUSES: tuple[str, ...] = get_args(StepStatus)

#: Built-in runbook ids: kebab-case.
RUNBOOK_BUILTIN_ID_PATTERN = r"^[a-z0-9][a-z0-9-]{1,62}$"
#: Operator runbook ids: the legacy procedure grammar, so migrated ids such as
#: ``brute_force_login`` stay valid. Also the ``#/runbooks?id=`` deep-link validator.
RUNBOOK_OPERATOR_ID_PATTERN = r"^[a-z0-9][a-z0-9_-]{0,63}$"
#: Ids no runbook may take: the fixed sub-paths of ``/api/runbooks`` and the
#: editor's draft id (``422 runbook_id_reserved``).
RUNBOOK_RESERVED_IDS: frozenset[str] = frozenset({
    "new", "metrics", "validate", "import", "progress", "match-preview", "lookup-test",
    "reindex", "readme", "index",
})
#: Step and decision-option ids: a lower-case slug, stable across versions.
RUNBOOK_SLUG_PATTERN = r"^[a-z0-9][a-z0-9_-]{0,63}$"
#: The closed set of lookup template values (SPEC §4.10.8). Each resolves from the
#: case's stored values and is bound as a structured parameter, never concatenated
#: into query text.
RUNBOOK_TEMPLATE_VALUES: tuple[str, ...] = (
    "case.rule", "case.source_id", "case.first_seen", "case.last_seen",
    "entity.ip", "entity.user", "entity.host", "entity.domain", "entity.hash",
    "entity.url", "entity.email",
)
RUNBOOK_DEFAULT_LOOKUP_WINDOW = "case_first_seen-1h..case_last_seen+1h"

# Content limits ``validate_runbook`` enforces (SPEC §4.10.2, §4.10.5, §4.10.7).
RUNBOOK_MAX_TITLE_CHARS = 120
RUNBOOK_MAX_SUMMARY_CHARS = 280
RUNBOOK_MAX_USE_WHEN_CHARS = 500
RUNBOOK_MAX_PREREQUISITES_CHARS = 500
RUNBOOK_MAX_PHASES = 6
RUNBOOK_MAX_STEPS = 40
RUNBOOK_MAX_RETRIEVAL_QUERIES = 5
RUNBOOK_MAX_RETRIEVAL_QUERY_CHARS = 200
RUNBOOK_MAX_REFERENCES = 10
RUNBOOK_MAX_SOURCE_BYTES = 65_536
RUNBOOK_STEP_MAX_TITLE_CHARS = 160
RUNBOOK_STEP_MAX_INSTRUCTIONS_CHARS = 2_000
RUNBOOK_STEP_MAX_GUIDANCE_CHARS = 300          # focus, escalate_if, benign_if
RUNBOOK_DECISION_MIN_OPTIONS = 2
RUNBOOK_DECISION_MAX_OPTIONS = 6
RUNBOOK_DECISION_MAX_LABEL_CHARS = 80
RUNBOOK_APPLIES_MAX_RULES = 50
RUNBOOK_APPLIES_MAX_RULE_CHARS = 256
RUNBOOK_APPLIES_MAX_MITRE = 50
RUNBOOK_APPLIES_MAX_SOURCES = 20
RUNBOOK_APPLIES_MAX_STATUSES = 10
RUNBOOK_APPLIES_MAX_TAGS = 20
RUNBOOK_APPLIES_MAX_TAG_CHARS = 64
RUNBOOK_LOOKUP_MAX_FILTERS = 8
RUNBOOK_LOOKUP_MAX_GROUP_BY = 2
RUNBOOK_LOOKUP_MAX_WINDOW_DAYS = 30
RUNBOOK_LOOKUP_SEARCH_MAX_ROWS = 20
RUNBOOK_DEFAULT_REVIEW_DAYS = 180
RUNBOOK_MIN_REVIEW_DAYS = 30
RUNBOOK_MAX_REVIEW_DAYS = 730
MAX_OPERATOR_RUNBOOKS = 200
MAX_RUNBOOK_VERSIONS = 100
MAX_RUNS_PER_CASE = 5


class AppliesWhen(BaseModel):
    """When a runbook applies to a case. Every present criterion is any-of; all
    present criteria must match. ``always`` marks only the Generic incident fallback
    (the lowest specificity). Limits (checked by ``validate_runbook``): ``rule_ids``
    at most 50 values of 1 to 256 characters; ``mitre`` at most 50 ``T####`` or
    ``T####.###`` ids (a parent matches its sub-techniques); ``sources`` at most 20
    source ids or ``type:<SourceType>``; ``statuses`` at most 10 ``CaseStatus``
    values; ``any_tags`` at most 20 tags of at most 64 characters."""

    rule_ids: list[str] = Field(default_factory=list)
    mitre: list[str] = Field(default_factory=list)
    entity_types: list[RunbookEntityType] = Field(default_factory=list)
    severity_at_least: SeverityLevel | None = None
    sources: list[str] = Field(default_factory=list)
    verdicts: list[RunbookVerdict] = Field(default_factory=list)
    statuses: list[str] = Field(default_factory=list)
    any_tags: list[str] = Field(default_factory=list)
    min_event_count: int | None = Field(default=None, ge=1, le=1_000_000)
    always: bool = False


class LookupTemplate(BaseModel):
    """A declarative, read-only lookup a Lookup step runs (SPEC §4.10.8). ``filter``
    maps a field (validated against the evidence-fields grammar) to a literal or one
    ``{{template value}}``, at most 8 entries; ``group_by`` (``log_stats`` only) at
    most 2 fields; ``indicator`` (``enrich`` only) one template value. The window
    spans at most 30 days; ``log_search`` returns at most 20 rows."""

    tool: LookupTool
    filter: dict[str, str] = Field(default_factory=dict)
    group_by: list[str] = Field(default_factory=list)
    indicator: str | None = None
    window: str = RUNBOOK_DEFAULT_LOOKUP_WINDOW
    limit: int = Field(default=20, ge=1, le=50)
    run: LookupRunMode = "on_attach"


class DecisionOption(BaseModel):
    """One option of a Decision step. ``marks_not_applicable`` names later step ids
    this option skips (only steps still To do)."""

    id: str
    label: str
    marks_not_applicable: list[str] = Field(default_factory=list)


class RunbookStep(BaseModel):
    """One step (SPEC §4.10.2, §4.10.3). ``id`` is a slug unique in the runbook and
    stable across versions. Checks are written as questions. ``instructions`` is
    restricted Markdown for people (never part of the investigator prompt);
    ``focus``, ``escalate_if`` and ``benign_if`` are what the investigator reads.
    ``lookup`` is required on Lookup steps and absent elsewhere; ``options`` holds 2
    to 6 options on Decision steps. ``approval_role`` is honoured only when step
    approvals are on; ``target_minutes`` is shown, never enforced."""

    id: str
    phase: PhaseId
    kind: StepKind
    title: str
    instructions: str = ""
    focus: str | None = None
    escalate_if: str | None = None
    benign_if: str | None = None
    required: bool = True
    evidence: StepEvidenceRule = "none"
    owner_role: str | None = None
    approval_role: str | None = None
    target_minutes: int | None = Field(default=None, ge=1, le=10_080)
    lookup: LookupTemplate | None = None
    options: list[DecisionOption] = Field(default_factory=list)
    react: str | None = None
    d3fend: str | None = None


class RunbookDefinition(BaseModel):
    """A runbook's canonical definition (SPEC §4.10.2). It has no ``version`` field:
    a version is metadata of the stored document (``RunbookVersionDoc.version``) and
    of a built-in's front matter. ``phases`` is ordered, 1 to 6, each used by at least
    one step; ``steps`` holds 1 to 40. ``references`` are https links only, at most
    10. ``review_every_days`` defaults to 180 (E6)."""

    id: str
    title: str
    summary: str
    use_when: str = ""
    prerequisites: str = ""
    applies_when: AppliesWhen = Field(default_factory=AppliesWhen)
    priority: int = Field(default=50, ge=0, le=100)
    mitre: list[str] = Field(default_factory=list)
    phases: list[PhaseId] = Field(default_factory=list)
    steps: list[RunbookStep] = Field(default_factory=list)
    retrieval_queries: list[str] = Field(default_factory=list)
    owner: str | None = None
    review_every_days: int = Field(
        default=RUNBOOK_DEFAULT_REVIEW_DAYS, ge=RUNBOOK_MIN_REVIEW_DAYS, le=RUNBOOK_MAX_REVIEW_DAYS,
    )
    references: list[str] = Field(default_factory=list)


# --------------------------------------------------------------------------- #
# §4.10.7 per-case runs (``runbook_runs`` KV namespace; ``engine/runbook_runs.py``).
# --------------------------------------------------------------------------- #
LookupResultStatus = Literal["ok", "empty", "partial", "error", "not_applicable"]
LookupTableKind = Literal["aggregate", "rows"]
RUNBOOK_SYSTEM_RUNNER = "agentic_soc"
RUNBOOK_LOOKUP_MAX_FACTS = 8
RUNBOOK_LOOKUP_TABLE_MAX_COLUMNS = 6
RUNBOOK_LOOKUP_TABLE_MAX_ROWS = 20
RUNBOOK_LOOKUP_TABLE_MAX_CELL_CHARS = 200
RUNBOOK_STEP_MAX_NOTE_CHARS = 4_000
RUNBOOK_STEP_MAX_REASON_CHARS = 500
RUNBOOK_STEP_MAX_EVIDENCE = 10
RUNBOOK_EVIDENCE_MAX_URL_CHARS = 500
RUNBOOK_EVIDENCE_MAX_LABEL_CHARS = 120
RUNBOOK_ACTION_MAX_WHERE_CHARS = 200
RUNBOOK_ACTION_MAX_OUTCOME_CHARS = 500
RUNBOOK_AI_DRAFT_MAX_CHARS = 2_000
RUNBOOK_CASE_DOC_MAX_BYTES = 1_048_576
RUNBOOK_CASE_EVIDENCE_MAX_BYTES = 524_288
RUNBOOK_LEDGER_MONTH_MAX_BYTES = 524_288
RUNBOOK_LEDGER_MONTHS_KEPT = 13
#: Characters an https link may never contain: whitespace, controls, the quote and
#: angle characters that break out of an attribute, and the backslash some browsers
#: read as a slash.
_UNSAFE_URL_CHARS_RE = re.compile(r"[\s\x00-\x1f\x7f-\x9f<>\"'`\\]")


def https_url(value: Any, *, max_chars: int = RUNBOOK_EVIDENCE_MAX_URL_CHARS) -> str | None:
    """``value`` as a safe absolute https link, or ``None`` when it is not one.

    Evidence links and runbook references are rendered as ``href``s to every viewer of
    a case (React 18 still runs ``javascript:`` URLs), so only ``https:`` with a host
    is ever accepted: never ``javascript:``, ``data:``, ``http:`` or a relative path.
    The scheme is matched case-insensitively and written lower case; surrounding
    whitespace is removed. Used strictly on input (a bad link is refused) and leniently
    on stored rows (a bad stored link reads as no link)."""
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text or len(text) > max_chars or _UNSAFE_URL_CHARS_RE.search(text):
        return None
    try:
        parts = urlsplit(text)
    except ValueError:
        return None
    if parts.scheme.lower() != "https" or not parts.hostname:
        return None
    return "https" + text[len(parts.scheme):]


class LookupResult(BaseModel):
    """The stored result of one lookup run (SPEC §4.10.7, §4.10.8). Every value is
    untrusted plain text (#9). ``params`` are the resolved values; ``ran_by`` is
    ``agentic_soc`` for a background ``on_attach`` run or the person who pressed Run.
    ``table`` is ``{columns <= 6, rows <= 20, cells <= 200 chars}``: an ``aggregate``
    table holds counts per key; a ``rows`` table holds raw ``log_search`` rows,
    shown to people only and reduced by code to a row count and top values before
    any prompt (#7). ``window_clamped`` says ``window_to`` was cut to ``ran_at``."""

    tool: str
    params: dict[str, str] = Field(default_factory=dict)
    window_from: str = ""
    window_to: str = ""
    ran_at: str = ""
    ran_by: str = ""
    status: LookupResultStatus = "ok"
    reason: str | None = None
    count: int | None = None
    count_relation: AuditCountRelation = "eq"
    facts: list[dict[str, str]] = Field(default_factory=list)
    table: dict[str, Any] | None = None
    table_kind: LookupTableKind | None = None
    window_clamped: bool = False


class StepEvidence(BaseModel):
    """One piece of evidence on a step: a stored lookup result, an https link or a
    ticket reference (``url`` at most 500, ``label`` at most 120 characters).

    ``url`` is https only (:func:`https_url`). A stored value that is not a safe https
    link reads as ``None`` (the label still shows), so a row written before this rule,
    or by hand, can never reach a viewer as a ``javascript:`` or ``data:`` link."""

    kind: Literal["lookup_result", "link", "ticket"]
    lookup: LookupResult | None = None
    url: str | None = None
    label: str | None = None

    @field_validator("url", mode="before")
    @classmethod
    def _https_only(cls, value: Any) -> Any:
        return https_url(value)


class StepState(BaseModel):
    """The live state of one step in a run. ``note`` is plain text (at most 4,000);
    ``reason`` (1 to 500) is required for ``not_applicable`` and ``blocked``.

    The dict-valued fields have fixed shapes (the TypeScript mirror types them):
    ``decision`` ``{option_id, label, by, at}``; ``action_record`` ``{performed_by,
    performed_at, where, outcome}``; ``approval`` ``{required_role, status:
    pending|approved|rejected, by, at, reason}``; ``ai_draft`` ``{text <= 2,000,
    created_at, model, usage_id, confirmed}``. An AI draft is never part of the case
    until a person confirms it, and the AI never sets a status (§4.10.10)."""

    status: StepStatus = "todo"
    assignee: str | None = None
    started_at: str | None = None
    completed_at: str | None = None
    completed_by: str | None = None
    note: str = ""
    reason: str | None = None
    evidence: list[StepEvidence] = Field(default_factory=list)
    decision: dict[str, Any] | None = None
    action_record: dict[str, Any] | None = None
    approval: dict[str, Any] | None = None
    ai_draft: dict[str, Any] | None = None
    revision: int = 0


RunAttachedBy = Literal["rule", "fallback", "person", "suggestion"]
RunStatus = Literal["active", "completed", "abandoned"]


class RunbookRun(BaseModel):
    """One runbook run on one case (SPEC §4.10.7). A run pins its version: the
    ``snapshot`` lets it render without the catalog, and "Switch to v5" is an
    explicit, audited step. ``attached_reason`` is the match explanation
    (:class:`MatchExplanation`) or ``{by: <user>, note}``. Completing or abandoning a
    run never changes the case (#3); one run per case and runbook (#4)."""

    run_id: str
    case_id: str
    runbook_id: str
    version: int
    title: str = ""
    snapshot: RunbookDefinition
    attached_by: RunAttachedBy
    attached_reason: dict[str, Any] = Field(default_factory=dict)
    attached_at: str = ""
    attached_actor: str = ""
    status: RunStatus = "active"
    completed_at: str | None = None
    abandoned_reason: str | None = None
    steps: dict[str, StepState] = Field(default_factory=dict)
    revision: int = 0


class RunbookProgress(BaseModel):
    """Progress derived on read from a run (never stored). ``done`` counts only Done
    steps; Not applicable is counted on its own and never as done. The chip reads
    "4/11", "5/9 · 1 blocked" or "4/11 · 1 waiting"."""

    done: int = 0
    not_applicable: int = 0
    total: int = 0
    required_open: int = 0
    blocked: int = 0
    waiting: int = 0


# --------------------------------------------------------------------------- #
# §4.10.4 the match explanation (``engine/runbook_match.py`` produces it; stored on a
# run as ``attached_reason`` and returned by the match preview and candidates).
# --------------------------------------------------------------------------- #
MatchCriterion = Literal[
    "rule_ids", "mitre", "entity_types", "severity_at_least", "sources", "verdicts",
    "statuses", "any_tags", "min_event_count", "always",
]
MATCH_CRITERIA: tuple[str, ...] = get_args(MatchCriterion)
MatchValue = str | int | list[str] | None


class MatchedCriterion(BaseModel):
    """A criterion that matched, and the case value that matched it."""

    criterion: MatchCriterion
    value: MatchValue = None


class MissedCriterion(BaseModel):
    """A criterion that failed: what the runbook expects and what the case has."""

    criterion: MatchCriterion
    expected: MatchValue = None
    actual: MatchValue = None


class MatchExplanation(BaseModel):
    """Why a runbook was chosen (SPEC §4.10.4). ``tier`` is 3 (rule matched), 2
    (technique matched, the runbook names no rules), 1 (other criteria only) or 0 (the
    fallback). ``tie`` says a tie survived to the id rule."""

    tier: int = Field(ge=0, le=3)
    matched: list[MatchedCriterion] = Field(default_factory=list)
    missed: list[MissedCriterion] = Field(default_factory=list)
    tie: bool = False


# --------------------------------------------------------------------------- #
# §4.10.15a library and case responses (``routes_runbooks.py``,
# ``routes_case_runbooks.py``).
# --------------------------------------------------------------------------- #
RunbookOrigin = Literal["builtin", "operator", "imported"]
RunbookState = Literal["draft", "in_review", "published", "retired"]
RunbookVersionState = Literal["draft", "in_review", "published", "superseded", "retired"]


class RunbookRef(BaseModel):
    """A pinned reference to one version of a runbook (``derived_from``)."""

    id: str
    version: int


class RunbookAppliesTo(BaseModel):
    """The first rule and technique chips of a library row; ``more`` counts the rest."""

    rule_ids: list[str] = Field(default_factory=list)
    mitre: list[str] = Field(default_factory=list)
    more: int = 0


class RunbookMigratedFrom(BaseModel):
    """The legacy document a migrated runbook came from (SPEC §4.10.17)."""

    namespace: str
    id: str
    revision: int | None = None


class RunbookSummary(BaseModel):
    """One library row (SPEC §4.10.15a). ``state`` is the most advanced visible
    state. ``runs_30d`` is ``None`` without ``cases:read``. ``review_due_at`` is
    ``last_reviewed_at + review_every_days``; imported content is due at once (D38).
    ``replaced_by`` names the Published operator copy that stopped a built-in
    matching. Titles and summaries are plain text."""

    id: str
    title: str = ""
    summary: str = ""
    origin: RunbookOrigin
    state: RunbookState
    live_version: int | None = None
    draft_version: int | None = None
    in_review_version: int | None = None
    retired: bool = False
    replaces: str | None = None
    replaced_by: str | None = None
    derived_from: RunbookRef | None = None
    owner: str | None = None
    phases: list[PhaseId] = Field(default_factory=list)
    step_count: int = 0
    applies_to: RunbookAppliesTo = Field(default_factory=RunbookAppliesTo)
    runs_30d: int | None = None
    review_due_at: str | None = None
    last_reviewed_at: str | None = None
    last_reviewed_by: str | None = None
    updated_at: str | None = None
    updated_by: str | None = None
    migrated_from: RunbookMigratedFrom | None = None


class RunbookReviewNote(BaseModel):
    """A reviewer's note on a version (a rejection reason, a review comment)."""

    by: str
    at: str
    text: str


class RunbookVersionDoc(BaseModel):
    """One immutable version (SPEC §4.10.5, §4.10.15a). ``content_hash`` is the
    SHA-256 of the canonical definition; ``source`` its Markdown; ``prompt_chars`` the
    investigator rendering's length (the budget is 3,000, E10)."""

    version: int = Field(ge=1)
    state: RunbookVersionState
    definition: RunbookDefinition
    source: str = ""
    content_hash: str = ""
    author: str = ""
    created_at: str = ""
    submitted_by: str | None = None
    submitted_at: str | None = None
    published_by: str | None = None
    published_at: str | None = None
    superseded_at: str | None = None
    retired_by: str | None = None
    retired_at: str | None = None
    review_notes: list[RunbookReviewNote] = Field(default_factory=list)
    import_notes: list[str] = Field(default_factory=list)
    prompt_chars: int = 0


class RunbookVersionListItem(BaseModel):
    """One row of a runbook's version history."""

    version: int
    state: RunbookVersionState
    published_by: str | None = None
    published_at: str | None = None


class RunbookDetail(BaseModel):
    """``GET /api/runbooks/{id}`` (SPEC §4.10.15a). ``draft`` and ``in_review`` are
    present only to a holder of ``runbooks:manage`` or ``runbooks:publish``.
    ``open_runs_by_version`` maps a version to the active runs pinned to it.
    ``revision`` is the library document's CAS revision, sent back as
    ``expected_revision``."""

    summary: RunbookSummary
    live: RunbookVersionDoc | None = None
    draft: RunbookVersionDoc | None = None
    in_review: RunbookVersionDoc | None = None
    versions: list[RunbookVersionListItem] = Field(default_factory=list)
    open_runs_by_version: dict[int, int] = Field(default_factory=dict)
    revision: int = 0


class RunbookMigrationNotice(BaseModel):
    """The one-shot migration's counts (from its marker, §4.10.17), for the Runbooks
    page's dismissible intro: "Your 10 procedures from the previous version are now
    runbooks. 9 are published and due for review; 1 is a draft with problems to fix."
    ``None`` on the library response when nothing was migrated."""

    completed_at: str | None = None
    published: int = 0
    draft: int = 0
    skipped: int = 0


class RunbookLibrary(BaseModel):
    """``GET /api/runbooks`` (the new shape): built-ins and operator runbooks. There
    is no empty library: the 12 built-ins are always listed."""

    runbooks: list[RunbookSummary] = Field(default_factory=list)
    migration: RunbookMigrationNotice | None = None


class RunbookIssue(BaseModel):
    """One validation problem: where (``steps[3].lookup.filter``), a stable code and
    a plain sentence naming the fix."""

    path: str = ""
    code: str
    message: str


class RunbookValidation(BaseModel):
    """``POST /api/runbooks/validate``: the issues and the investigator guidance
    length against its budget. Nothing is written."""

    issues: list[RunbookIssue] = Field(default_factory=list)
    prompt_chars: int = 0
    prompt_budget: int = 0


class MatchPreviewCase(BaseModel):
    """A case the previewed runbook would get, with why."""

    case_id: str
    case_number: str = ""
    title: str = ""
    explanation: MatchExplanation | None = None


class MatchPreviewOther(BaseModel):
    """A case another runbook would win, naming the winner."""

    case_id: str
    case_number: str = ""
    title: str = ""
    winner_id: str
    winner_title: str = ""


class MatchPreviewNearMiss(BaseModel):
    """A case that nearly matched, with the criteria that failed."""

    case_id: str
    case_number: str = ""
    title: str = ""
    failed: list[MissedCriterion] = Field(default_factory=list)


class MatchPreviewCounts(BaseModel):
    """Exact group sizes; each list above holds at most 50."""

    gets_it: int = 0
    another_wins: int = 0
    near_misses: int = 0


class MatchPreview(BaseModel):
    """``POST /api/runbooks/match-preview`` (SPEC §4.10.15a): which of the last 500
    cases in 30 days the definition would get. Nothing is attached and no metric
    changes. ``truncated`` says a list was cut at 50; ``counts`` are always exact."""

    considered: int = 0
    window_label: str = ""
    gets_it: list[MatchPreviewCase] = Field(default_factory=list)
    another_wins: list[MatchPreviewOther] = Field(default_factory=list)
    near_misses: list[MatchPreviewNearMiss] = Field(default_factory=list)
    counts: MatchPreviewCounts = Field(default_factory=MatchPreviewCounts)
    truncated: bool = False


class RunbookMetricsRunbookRow(BaseModel):
    """Runs started, completed and abandoned for one runbook in the window."""

    id: str
    title: str = ""
    started: int = 0
    completed: int = 0
    abandoned: int = 0
    median_minutes_to_complete: float | None = None


class RunbookMetricsPhaseRow(BaseModel):
    """The median time to finish one phase of one runbook."""

    runbook_id: str
    phase: PhaseId
    median_minutes: float | None = None


class RunbookMetricsStepRow(BaseModel):
    """The median time and the skip count of one step."""

    runbook_id: str
    step_id: str
    title: str = ""
    median_minutes: float | None = None
    skipped: int = 0


class RunbookMetricsCoverage(BaseModel):
    """Human-handled cases in the window, and how many had a run."""

    cases_with_run: int = 0
    human_handled_cases: int = 0


class RunbookMetricsRuleGap(BaseModel):
    """A rule seen in the window that no Published runbook matches. Untrusted."""

    rule: str
    cases: int = 0


class RunbookMetricsCohort(BaseModel):
    """One response-time cohort: its size and median time to resolve."""

    cases: int = 0
    mttr_p50_minutes: float | None = None


class RunbookMetricsCohorts(BaseModel):
    """Cases with and without a completed run. A comparison, never a cause."""

    with_completed_run: RunbookMetricsCohort = Field(default_factory=RunbookMetricsCohort)
    without: RunbookMetricsCohort = Field(default_factory=RunbookMetricsCohort)
    note: Literal["comparison, not cause"] = "comparison, not cause"


class RunbookMetricsRecentRun(BaseModel):
    """One of the most recent runs, for the library's Recent runs panel."""

    run_id: str
    case_id: str
    case_number: str = ""
    runbook_id: str
    title: str = ""
    version: int | None = None
    status: RunStatus = "active"
    attached_actor: str = ""
    started_at: str = ""
    completed_at: str | None = None
    duration_minutes: float | None = None


class RunbookMetrics(BaseModel):
    """``GET /api/runbooks/metrics`` (SPEC §4.10.15a). ``partial`` is true when a
    ledger month document reached its cap inside the window. Every figure states its
    population and none claims a runbook caused a time change."""

    window_label: str = ""
    partial: bool = False
    per_runbook: list[RunbookMetricsRunbookRow] = Field(default_factory=list)
    per_phase: list[RunbookMetricsPhaseRow] = Field(default_factory=list)
    per_step: list[RunbookMetricsStepRow] = Field(default_factory=list)
    coverage: RunbookMetricsCoverage = Field(default_factory=RunbookMetricsCoverage)
    rules_without_runbook: list[RunbookMetricsRuleGap] = Field(default_factory=list)
    cohorts: RunbookMetricsCohorts = Field(default_factory=RunbookMetricsCohorts)
    recent_runs: list[RunbookMetricsRecentRun] = Field(default_factory=list)


class CaseRunbooks(BaseModel):
    """``GET /api/cases/{case_id}/runbooks`` (SPEC §4.10.15a): the case's runs with
    evidence redacted per viewer by the lookup grants, progress per run, the newer
    published version per run, the free-form case tasks ("Other tasks") and the case
    document's CAS revision."""

    runs: list[RunbookRun] = Field(default_factory=list)
    progress: dict[str, RunbookProgress] = Field(default_factory=dict)
    newer_versions: dict[str, int] = Field(default_factory=dict)
    other_tasks: list[CaseTask] = Field(default_factory=list)
    revision: int = 0


class RunbookCandidate(BaseModel):
    """One entry of the Start runbook picker (``GET .../runbooks/candidates``)."""

    id: str
    title: str = ""
    summary: str = ""
    version: int
    origin: RunbookOrigin
    group: Literal["best", "other", "fallback", "all", "suggested"]
    phases: list[PhaseId] = Field(default_factory=list)
    explanation: MatchExplanation | None = None
    reason: str | None = None


class RunbookCandidates(BaseModel):
    """The Start runbook picker list, best match first."""

    candidates: list[RunbookCandidate] = Field(default_factory=list)


class RunbookDiscardResult(BaseModel):
    """``DELETE /api/runbooks/{id}/draft``: the runbook after its draft is gone, or
    ``removed`` when it was never published (it disappears)."""

    id: str
    removed: bool = False
    detail: RunbookDetail | None = None


class RunbookAttachResult(BaseModel):
    """``POST /api/cases/{case_id}/runbooks``: the new run, or ``already_attached``
    (idempotent per case and runbook, #4)."""

    already_attached: bool = False
    run: RunbookRun | None = None
    progress: RunbookProgress | None = None
    revision: int = 0


class RunbookRunUpdate(BaseModel):
    """The result of any write to one run: a step update, a lookup, an approval, an AI
    draft or its confirmation, a version switch or an abandon. ``revision`` is the case
    document's CAS revision after the write."""

    run: RunbookRun
    progress: RunbookProgress
    revision: int = 0


class RunbookSuggestion(BaseModel):
    """``POST /api/cases/{case_id}/runbooks/suggest``: the AI's suggestion, which a
    person must select (it is never attached), or with ``dry_run=true`` only the
    estimate of the one gateway call (#6)."""

    candidate: RunbookCandidate | None = None
    estimate: ReportSummaryEstimate | None = None


class RunbookStepDraftResult(BaseModel):
    """``POST .../steps/{step_id}/draft``: the run with the step's new AI draft
    (labelled "AI draft" until a person confirms it), or with ``dry_run=true`` only
    the estimate of the one gateway call (#6)."""

    update: RunbookRunUpdate | None = None
    estimate: ReportSummaryEstimate | None = None


class RunbookStepsOpen(BaseModel):
    """One required step still open when a person closes a case (``409
    runbook_steps_open`` when the request asked to be told)."""

    run_id: str
    step_id: str
    title: str = ""
    status: StepStatus = "todo"


class RunbookStepsOpenDetail(BaseModel):
    """The body of ``409 runbook_steps_open``."""

    required_open: int = 0
    steps: list[RunbookStepsOpen] = Field(default_factory=list)


# --------------------------------------------------------------------------- #
# §4.10.15 request bodies. They fix field types and transport bounds only; content
# rules are ``validate_runbook``'s, so a bad definition becomes a list of issues
# (``422 runbook_invalid``) instead of a framework error. Every body refuses an
# unknown key (``extra="forbid"``, the report bodies' convention), so a misspelt field
# is a 422, never a silent no-op. The old write shape (``{id, content}``) validates
# as :class:`RunbookSourceBody` with ``content`` set, which the route answers with
# ``410 runbooks_moved`` (E14).
# --------------------------------------------------------------------------- #
#: A transport bound well above the 64 KiB content limit, so an oversized source is
#: reported as an issue, not refused by the framework.
RUNBOOK_SOURCE_TRANSPORT_MAX_CHARS = 262_144
#: The same bound for a structured definition, measured as its JSON text: well above
#: what ``validate_runbook``'s own limits allow (40 steps of at most about 3,000
#: characters each), so a realistic overrun is still reported as issues, while an
#: arbitrarily large body never reaches model or content validation.
RUNBOOK_DEFINITION_TRANSPORT_MAX_CHARS = 262_144
#: A lookup template in ``POST /api/runbooks/lookup-test`` (at most 8 filters).
RUNBOOK_LOOKUP_TRANSPORT_MAX_CHARS = 16_384
RUNBOOK_NOTE_MAX_CHARS = 500
RUNBOOK_PROGRESS_MAX_CASES = 100
RUNBOOK_CASE_ID_MAX_CHARS = 128
RUNBOOK_ID_MAX_CHARS = 64
#: ``RunbookPublishBody.content_hash``: the SHA-256 of the canonical definition.
RUNBOOK_CONTENT_HASH_PATTERN = r"^[0-9a-f]{64}$"


def _json_text_chars(value: Any) -> int:
    """The length of ``value`` as compact JSON text (a model counts as its dump)."""
    if isinstance(value, BaseModel):
        return len(value.model_dump_json())
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str))


def _within_transport_bound(value: Any, limit: int, what: str) -> Any:
    if value is not None and _json_text_chars(value) > limit:
        raise ValueError(f"{what} is larger than {limit:,} characters")
    return value


class _RunbookRequest(BaseModel):
    """Base of the §4.10.15 request bodies: unknown keys are refused."""

    model_config = ConfigDict(extra="forbid")


class RunbookSourceBody(_RunbookRequest):
    """``POST /api/runbooks`` (create a draft), ``/validate``, ``/import`` and
    ``/match-preview``: a definition, or Markdown source, or (match preview only) an
    existing runbook id.

    ``content`` is the old write shape's key, accepted only so the route can tell
    ``{id, content}`` apart after validation: any request that sets it (``"content" in
    model_fields_set``) answers ``410 runbooks_moved``, because an old-shape write
    cannot be honoured without making unreviewed text trusted (#9, E14)."""

    definition: RunbookDefinition | None = None
    source: str | None = Field(default=None, max_length=RUNBOOK_SOURCE_TRANSPORT_MAX_CHARS)
    id: str | None = Field(default=None, max_length=RUNBOOK_ID_MAX_CHARS)
    content: Any = Field(
        default=None,
        description="Legacy key of the old write shape; any value answers 410 runbooks_moved.",
    )

    @field_validator("definition", mode="before")
    @classmethod
    def _bounded_definition(cls, value: Any) -> Any:
        return _within_transport_bound(value, RUNBOOK_DEFINITION_TRANSPORT_MAX_CHARS, "The definition")


class RunbookDraftBody(_RunbookRequest):
    """``PUT /api/runbooks/{id}/draft``: the new draft and the revision it edits."""

    definition: RunbookDefinition | None = None
    source: str | None = Field(default=None, max_length=RUNBOOK_SOURCE_TRANSPORT_MAX_CHARS)
    expected_revision: int = Field(ge=0)

    @field_validator("definition", mode="before")
    @classmethod
    def _bounded_definition(cls, value: Any) -> Any:
        return _within_transport_bound(value, RUNBOOK_DEFINITION_TRANSPORT_MAX_CHARS, "The definition")


class RunbookVersionBody(_RunbookRequest):
    """``POST /api/runbooks/{id}/submit``: the version sent for review. Publishing
    takes :class:`RunbookPublishBody`, which requires the revision."""

    version: int = Field(ge=1)
    expected_revision: int | None = Field(default=None, ge=0)


class RunbookPublishBody(_RunbookRequest):
    """``POST /api/runbooks/{id}/publish`` (SPEC §4.10.15): the version and the
    library revision the publisher reviewed, both required. Publishing is the one
    transition that makes runbook text trusted investigator guidance (#9), and drafts
    are edited in place, so a publish is bound to exactly what was reviewed: a stale
    ``expected_revision`` answers ``409 runbook_conflict`` with the latest state.
    ``content_hash`` (the reviewed version's ``RunbookVersionDoc.content_hash``) also
    binds it across a discard and re-create, where a new library document can repeat
    an old revision number; when given, a different stored hash is ``409
    runbook_conflict`` too. The Console always sends it."""

    version: int = Field(ge=1)
    expected_revision: int = Field(ge=0)
    content_hash: str | None = Field(default=None, pattern=RUNBOOK_CONTENT_HASH_PATTERN)


class RunbookRejectBody(_RunbookRequest):
    """``POST /api/runbooks/{id}/reject``: back to draft with a reason."""

    version: int = Field(ge=1)
    reason: str = Field(min_length=1, max_length=RUNBOOK_STEP_MAX_REASON_CHARS)
    expected_revision: int | None = Field(default=None, ge=0)


class RunbookRevisionBody(_RunbookRequest):
    """``retire``, ``restore``, ``reviewed``, ``duplicate`` and ``versions/{n}/restore``:
    the revision the action is based on (optional for the idempotent ones)."""

    expected_revision: int | None = Field(default=None, ge=0)


class RunbookAttachBody(_RunbookRequest):
    """``POST /api/cases/{case_id}/runbooks``: attach one runbook by hand."""

    runbook_id: str = Field(min_length=1, max_length=RUNBOOK_ID_MAX_CHARS)
    note: str | None = Field(default=None, max_length=RUNBOOK_NOTE_MAX_CHARS)


class StepDecisionInput(_RunbookRequest):
    """The option a person picked on a Decision step."""

    option_id: str = Field(min_length=1, max_length=64)


class StepActionRecordInput(_RunbookRequest):
    """What a person recorded on an Action or Record step."""

    where: str = Field(default="", max_length=RUNBOOK_ACTION_MAX_WHERE_CHARS)
    outcome: str = Field(default="", max_length=RUNBOOK_ACTION_MAX_OUTCOME_CHARS)
    performed_at: str | None = Field(default=None, max_length=64)


class StepEvidenceLinkInput(_RunbookRequest):
    """An https link or ticket reference attached as evidence. ``url`` must be an
    absolute https link (:func:`https_url`; ``javascript:``, ``data:``, ``http:`` and
    relative links are refused with a 422)."""

    kind: Literal["link", "ticket"] = "link"
    url: str | None = Field(default=None, max_length=RUNBOOK_EVIDENCE_MAX_URL_CHARS)
    label: str | None = Field(default=None, max_length=RUNBOOK_EVIDENCE_MAX_LABEL_CHARS)

    @field_validator("url", mode="before")
    @classmethod
    def _https_only(cls, value: Any) -> Any:
        if value is None:
            return None
        url = https_url(value)
        if url is None:
            raise ValueError("Use an https link of at most 500 characters.")
        return url


class RunbookStepUpdate(_RunbookRequest):
    """``PATCH /api/cases/{case_id}/runbooks/{run_id}/steps/{step_id}``. A stale
    ``expected_revision`` is never retried (``409 runbook_conflict``). ``assignee``
    sent as ``null`` clears the assignment; an absent key leaves it (the route reads
    ``model_fields_set``)."""

    expected_revision: int = Field(ge=0)
    status: StepStatus | None = None
    assignee: str | None = Field(default=None, max_length=128)
    note: str | None = Field(default=None, max_length=RUNBOOK_STEP_MAX_NOTE_CHARS)
    reason: str | None = Field(default=None, max_length=RUNBOOK_STEP_MAX_REASON_CHARS)
    decision: StepDecisionInput | None = None
    action_record: StepActionRecordInput | None = None
    evidence_link: StepEvidenceLinkInput | None = None


class StepApprovalBody(_RunbookRequest):
    """``POST .../steps/{step_id}/approval``: the recorder can never approve."""

    decision: Literal["approve", "reject"]
    reason: str | None = Field(default=None, max_length=RUNBOOK_STEP_MAX_REASON_CHARS)


class StepDraftConfirmBody(_RunbookRequest):
    """``POST .../steps/{step_id}/draft/confirm``: the draft as the person edited it."""

    text: str = Field(min_length=1, max_length=RUNBOOK_AI_DRAFT_MAX_CHARS)


class RunSwitchVersionBody(_RunbookRequest):
    """``POST .../runbooks/{run_id}/switch-version``."""

    version: int = Field(ge=1)


class RunAbandonBody(_RunbookRequest):
    """``POST .../runbooks/{run_id}/abandon``."""

    reason: str = Field(min_length=1, max_length=RUNBOOK_STEP_MAX_REASON_CHARS)


class RunbookProgressBody(_RunbookRequest):
    """``POST /api/runbooks/progress``: progress for up to 100 cases at once, each id
    1 to 128 characters (an id becomes part of a store key)."""

    case_ids: list[Annotated[str, Field(min_length=1, max_length=RUNBOOK_CASE_ID_MAX_CHARS)]] = Field(
        default_factory=list, max_length=RUNBOOK_PROGRESS_MAX_CASES,
    )


class RunbookLookupTestBody(_RunbookRequest):
    """``POST /api/runbooks/lookup-test``: run a draft lookup against one case,
    read-only, storing nothing."""

    lookup: LookupTemplate
    case_id: str = Field(min_length=1, max_length=RUNBOOK_CASE_ID_MAX_CHARS)

    @field_validator("lookup", mode="before")
    @classmethod
    def _bounded_lookup(cls, value: Any) -> Any:
        return _within_transport_bound(value, RUNBOOK_LOOKUP_TRANSPORT_MAX_CHARS, "The lookup")


#: §4.10.15 ``open_steps_reason`` on every human terminal transition (D34).
OPEN_STEPS_REASON_MAX_CHARS = 500
