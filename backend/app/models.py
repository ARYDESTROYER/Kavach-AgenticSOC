"""Pydantic models: the Section 7 data contracts plus internal pipeline types.

The three persisted contracts (``Case``, ``AuditDoc``, ``UsageDoc``) map field-for-
field to Section 7. Internal types (``RawEvent``, ``Cluster``, ``VerdictResult``,
``EnrichmentResult``, ``RagChunk``) describe data flowing through the engine.
"""

from __future__ import annotations

import base64
import binascii
import re
from datetime import datetime
from typing import TYPE_CHECKING, Any, ClassVar, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from .config import Preferences

if TYPE_CHECKING:  # avoid an import cycle (ocsf imports config/constants, not models)
    from .ocsf import OCSFEvent
from .constants import (
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
    * ``misc`` — a small catch-all UI-prefs bag (density, etc.).
    """

    saved_views: list[SavedView] = Field(default_factory=list)
    tables: dict[str, ColumnState] = Field(default_factory=dict)
    theme_mode: Literal["light", "dark", "system"] = "system"
    last_list_state: dict[str, dict[str, Any]] = Field(default_factory=dict)
    pinned_view_ids: list[str] = Field(default_factory=list)
    dashboards: dict[str, DashboardLayout] = Field(default_factory=dict)
    misc: dict[str, Any] = Field(default_factory=dict)
    updated_at: str = Field(default_factory=iso_now)


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
    playbook_id: str = ""
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
class ChatTurn(BaseModel):
    role: str  # "user" | "assistant"
    content: str


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


class ChatConversation(ChatConversationSummary):
    messages: list[ChatConversationMessage] = Field(default_factory=list)


class ChatConversationRenameRequest(BaseModel):
    title: str = Field(min_length=1, max_length=80)

    @field_validator("title")
    @classmethod
    def clean_title(cls, value: str) -> str:
        title = " ".join(str(value).split()).strip()
        if not title:
            raise ValueError("title is required")
        if any(ord(ch) < 32 or ord(ch) == 127 for ch in title):
            raise ValueError("title must be plain single-line text")
        return title


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
