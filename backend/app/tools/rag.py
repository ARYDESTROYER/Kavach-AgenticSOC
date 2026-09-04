"""RAG retrieval over a small seed SOC knowledge base (Section 6.6).

The corpus ships in-process as Python constants — SOC runbook snippets, ATT&CK
techniques and suppression guidance — so RAG works with zero extra services and
degrades gracefully (Gate 2): if embedding fails the store is simply left empty
and ``retrieve`` returns ``[]`` rather than raising. Embeddings flow through the
single LLM gateway, which itself falls back to deterministic local hashing when
no embedding key is configured, so the whole path stays offline-capable.

A Chroma-backed ``VectorStore`` can be dropped in behind the same interface
(Section 6.6) without touching this module's callers.
"""

from __future__ import annotations

import hashlib
import asyncio
import logging
import math
import re
from collections import Counter
from dataclasses import dataclass, replace as dataclass_replace
from datetime import datetime, timedelta, timezone
from time import monotonic
from typing import TYPE_CHECKING, Any, Awaitable, Callable

from ..config import Preferences
from ..constants import CaseStatus, DecisionBy, Verdict
from ..engine.analyst_outcomes import analyst_confirmed_outcome, is_classification_entry
from ..engine.chunking import chunk_text
from ..engine.precedent import (
    RULE_IDENTITY_KEY,
    RULE_IDS_KEY,
    PrecedentDistribution,
    case_rule_identity,
    disabled_distribution,
    distribution_from_metadata,
    rule_identity_members,
    stratified_selection,
    unavailable_distribution,
)
from ..engine.runbooks import corpus_items as runbook_corpus_items
from ..llm.gateway import FAILURE_NOT_CONFIGURED, LLMGateway
from ..models import RagChunk
from ..stores.precedent_exclusions import normalise_reason as normalise_exclusion_reason
from ..utils import iso_now
from .base import Tool, ToolResult
from .vectorstore import (
    EmbeddingSpaceMismatch,
    InMemoryVectorStore,
    StoredChunk,
    VectorStore,
)

if TYPE_CHECKING:  # pragma: no cover - typing only
    from ..config import (
        PrecedentRepairConfig,
        PrecedentWindowConfig,
        UnconfirmedPrecedentConfig,
    )
    from ..engine.runbook_service import RunbookService
    from ..models import Case
    from ..stores.cases import CaseStore
    from ..stores.precedent_exclusions import PrecedentExclusionStore
    from ..stores.rag_health import RagHealthStore

logger = logging.getLogger("tlsoc.tools.rag")

# --------------------------------------------------------------------------- #
# Why a projection was refused — a CLOSED vocabulary, not prose.
# --------------------------------------------------------------------------- #
# ``ProjectionCollapsed`` carried only a message, so every refusal reached the job
# surface and the health record as one undifferentiated FAILED. That flattens two
# categorically different events: a corpus-destroying build failure (an outage, an
# unreadable store) and an operator DELIBERATELY narrowing the precedent window to drop
# a poisoned tail — which is a repair, refused because it looks like a shrink.
#
# ``REFUSAL_EMPTY_PROJECTION`` is UNCONDITIONAL AND UNTUNABLE and always stays that way:
# a rebuild that yields nothing while a live corpus exists is never legitimate, whatever
# the operator configured.
REFUSAL_EMPTY_PROJECTION = "empty_projection"
REFUSAL_EMPTY_UNVERIFIABLE = "empty_projection_unverifiable"
REFUSAL_RETENTION_FLOOR = "retention_floor"
REFUSAL_WINDOW_REDUCTION = "window_size_reduction"

# Why an explicit precedent TEXT REPAIR run refused. A refusal is a REPORTED OUTCOME
# with its own code, never an exception: the repair is an operator-invoked maintenance
# pass that must never be able to abort seeding, and "I refused, here is why" is the
# only answer that tells the operator what to change.
REPAIR_REFUSAL_NO_CASE_STORE = "repair_no_case_store"
REPAIR_REFUSAL_EXCLUSIONS_UNKNOWN = "repair_exclusion_set_unknown"
REPAIR_REFUSAL_CORPUS_UNREADABLE = "repair_corpus_unreadable"
REPAIR_REFUSAL_EMBEDDING_SPACE = "repair_embedding_space_changed"
REPAIR_REFUSAL_EMBEDDING_DEGRADED = "repair_embedding_degraded"
REPAIR_REFUSAL_MASS_EVICTION = "repair_mass_eviction"
REPAIR_REFUSAL_TIER_EMPTIED = "repair_tier_emptied"

# The four classes a stored precedent chunk falls into when its text is compared with
# what the CURRENT projector renders for the same case. Exactly one applies per chunk.
REPAIR_CURRENT = "current"
REPAIR_STALE = "stale"
REPAIR_UNDETERMINED = "undetermined"
REPAIR_NOT_PROJECTING = "not_projecting"

# WHY a chunk does not project. Three different situations reach one code path, and
# only ONE of them may ever delete:
#   * ``excluded``  — the operator excluded the case. Its home is the exclusion API,
#                     which already removed the chunk and reports when it could not.
#   * ``withdrawn`` — the case is still there but no longer carries the label the tier
#                     projects from. Deleting on that turns "an analyst changed their
#                     mind" into data loss.
#   * ``absent``    — the case is POSITIVELY gone from the case store, established by a
#                     read that fails closed. This is the only removable one.
REPAIR_EXCLUDED = "excluded"
REPAIR_WITHDRAWN = "withdrawn"
REPAIR_ABSENT = "absent"


class ExclusionSetUnavailable(RuntimeError):
    """The operator exclusion set is UNKNOWN, so no projection may derive precedent.

    "Unknown" is not "empty". On a process that has never managed to read the store —
    a cold start whose first read failed — an empty in-memory set is the absence of
    knowledge, and treating it as "nothing is excluded" makes the very next projection
    re-derive EVERY excluded precedent. Because ``resolved_case`` is exempt from the
    stale sweep, those resurrected chunks then survive a full ``rebuild_corpus()``, so
    the exclusion silently undoes itself with no operator-visible signal.

    A projection that raises this instead leaves the last known-good corpus exactly as
    it is. That is strictly the safer failure: stale knowledge, not poisoned knowledge.
    A process that HAS read the set once keeps its last known-good copy and marks it
    stale, which is a different (and much weaker) condition — that one never raises.
    """


class ProjectionCollapsed(RuntimeError):
    """A rebuilt projection was empty (or a fraction of) the corpus it would replace.

    Distinct from an ordinary seeding error so the two can be logged at DIFFERENT
    levels: a transient seed failure is a WARNING an operator may reasonably ignore,
    while losing the corpus is an ERROR with a persisted health state. The single
    ``RAG seeded with N chunk(s)`` INFO line was the only trace of this outcome BOTH
    times it happened in production; it must never be the sole record again.

    ``reason_code`` carries the closed vocabulary above so a refusal that is ATTRIBUTABLE
    to a deliberate operator action reads differently from one that is not. It is
    additive: the message text is unchanged in shape and every existing caller that only
    reads ``str(exc)`` is unaffected.
    """

    def __init__(self, message: str, *, reason_code: str = REFUSAL_EMPTY_PROJECTION) -> None:
        super().__init__(message)
        self.reason_code = str(reason_code or REFUSAL_EMPTY_PROJECTION)


# Built-in seed corpus sources — guarded from deletion via the management API
# unless an explicit force=True is passed (so an operator cannot accidentally wipe
# the shipped knowledge base while curating imported documents). ``resolved_case``
# (the institutional-memory loop) is accumulated at runtime, not seeded; it is
# guarded here so a bulk "clear imported docs" cannot drop prior analyst decisions.
SEED_SOURCES = frozenset({"runbook", "mitre", "suppression", "resolved_case"})

# The precedent (institutional-memory) corpus source. Accumulated at runtime from
# analyst-confirmed cases, never shipped, and — unlike every other seed source —
# only ever projected through a BOUNDED window (see ``_RESOLVED_CASE_PAGE_SIZE`` /
# ``_resolved_case_items``).
RESOLVED_CASE_SOURCE = "resolved_case"

# Managed sources whose projection is a FULL reconciliation of the source of truth:
# every enabled document is rebuilt on each projection, so a managed document that
# is absent from the new projection genuinely no longer exists and may be evicted.
#
# ``resolved_case`` is deliberately EXCLUDED. Its projection is a bounded window
# (``_resolved_case_items(limit=200)`` over the newest qualifying terminal cases),
# so "not in the current projection" means "outside the window", NOT "deleted".
# Sweeping it as stale destroyed the entire accumulated precedent corpus on the
# next unrelated reprojection. Precedent removal stays possible EXPLICITLY (a
# per-document delete via ``delete_document(..., force=True)``) — just never as a
# side effect of reprojecting some other source.
FULLY_RECONCILED_SEED_SOURCES = frozenset(SEED_SOURCES - {RESOLVED_CASE_SOURCE})

# The scope the collapse guard compares in ``ensure_seeded``: exactly the sources that
# projection can DESTROY, which is exactly what ``_drop_stale_managed_projection``
# sweeps.
#
# Everything else is deliberately excluded, for two different reasons:
#   * ``imported`` / ``threat_context`` — preserved in place, never re-embedded and
#     never swept here. Counting them made an ordinary reseed look like a catastrophic
#     shrink on any deployment with a sizeable imported library.
#   * ``resolved_case`` — a BOUNDED WINDOW over the newest qualifying cases, not a
#     reconciliation. Its projected size legitimately varies (and is legitimately zero
#     when nothing currently qualifies), and it is never swept, so a smaller precedent
#     projection deletes nothing. Guarding it would refuse every projection on a
#     deployment holding precedent that the current window no longer covers.
MANAGED_PROJECTION_SOURCES = FULLY_RECONCILED_SEED_SOURCES

# Bounded scan for the precedent projection. The window counts QUALIFYING
# (analyst-confirmed) cases, not raw terminal ones, so an autonomous deployment's
# own unlabelled auto-closes can no longer evict every precedent; the scan cap keeps
# that search bounded when the unlabelled backlog is large.
_RESOLVED_CASE_PAGE_SIZE = 200
_RESOLVED_CASE_SCAN_CAP = 5000

# The terminal statuses the CONFIRMED precedent scan walks, in a FIXED order. The scan
# budget is shared out per status rather than consumed first-come: CLOSED is by far the
# larger population in a self-running deployment, so one shared counter let it exhaust
# the cap before RESOLVED — the analyst-RESOLVED cases — was read at all.
_PRECEDENT_SCAN_STATUSES = (CaseStatus.CLOSED.value, CaseStatus.RESOLVED.value)

# The ``model_unconfirmed`` tier scans CLOSED ONLY, and that is not an optimisation.
# RESOLVED is reachable exclusively through the analyst case-action path, which stamps
# ``DecisionBy.ANALYST`` on the way, and ``_unconfirmed_candidate`` rejects anything a
# human decided — so ``RESOLVED ∩ (decision_by == AGENT)`` is empty BY CONSTRUCTION.
# Sharing the confirmed tier's status list spent half this tier's budget on a status
# that cannot yield a single candidate, halving its effective CLOSED coverage (and its
# recurrence tallies, which are counted over whatever the scan saw) the moment a
# deployment had any resolved cases at all.
_UNCONFIRMED_SCAN_STATUSES = (CaseStatus.CLOSED.value,)

# ``PrecedentWindowConfig`` fields that are DELIBERATELY excluded from the corpus
# source signature's window dump, and appended separately only when they are not at
# their default. Naively widening the dump would change the signature for every
# deployment on upgrade and force a full, BILLABLE re-embed of the corpus purely
# because the schema grew. A default-constructed config must therefore serialise to the
# exact pre-change bytes; ``tests/test_precedent_authority.py`` pins that literal.
_WINDOW_SIGNATURE_APPENDED_FIELDS = ("stratify_by", "max_transaction_fraction")

# How coarsely the admission cap buckets time when a case carries no explicit batch
# marker. Approximate ON PURPOSE, in both directions: it merges independent labels made
# within the same hour, and splits one bulk action that straddles an hour boundary. The
# alternative is no cap at all on exactly the historical backlog the cap exists for.
_ADMISSION_TIME_BUCKET_SECONDS = 3600

# --------------------------------------------------------------------------- #
# The TWO precedent trust tiers.
# --------------------------------------------------------------------------- #
# ``analyst_confirmed`` — independent human ground truth, accepted by
# ``engine/analyst_outcomes.analyst_confirmed_outcome``. This is the ONLY tier the
# threshold tuner and every other ground-truth consumer has ever seen, and this module
# does not change that.
#
# ``model_unconfirmed`` — the agent's OWN auto-closed judgement, never reviewed by a
# human. Indexed only when ``rag.use_unconfirmed_resolved_cases`` is explicitly enabled
# (default OFF), bounded by the ``rag.unconfirmed_precedent`` compounding guards, always
# outranked by the confirmed tier, capped as a share of retrieved context, and rendered
# under its OWN prompt heading so the investigator can never mistake it for an analyst
# decision. It is a weaker PRIOR, never ground truth, and it is never promoted.
TRUST_ANALYST_CONFIRMED = "analyst_confirmed"
TRUST_MODEL_UNCONFIRMED = "model_unconfirmed"

# Independent bounded scan for the unconfirmed tier. Deliberately SEPARATE from
# ``_RESOLVED_CASE_SCAN_CAP`` so the analyst-confirmed projection is byte-identical
# (it must never spend its budget looking for unconfirmed candidates), and so the extra
# read only happens at all when the tier is switched on.
_UNCONFIRMED_SCAN_CAP = 2000

# The Elasticsearch vector store reads its corpus through ONE bounded document scan
# (``ESVectorStore._scan_all`` issues a single ``size: 10000`` page). A corpus at that
# ceiling may have been cut short, so every count derived from it is reported as a lower
# bound rather than a confident total.
#
# This ceiling is a property of THAT backend, not of the corpus. The in-memory and SQL
# stores materialise every row, so applying it to them would report a perfectly complete
# read of a large corpus as truncated — and, because a truncated read now withholds both
# precedent promotion and the futility report, would silently disable the feature on a
# PostgreSQL deployment that simply grew past 10k chunks.
_CORPUS_SCAN_TRUNCATION_HINT = 10000

# Bound the one-time rule-identity re-tag of pre-existing precedent so a large legacy
# corpus costs a bounded management read per projection rather than an unbounded one.
_RULE_IDENTITY_RECONCILE_CAP = 2000

# How many case-scoped precedent EXCLUSION markers a deployment may hold, expressed as a
# MULTIPLE OF THE CONFIGURED WINDOW SIZE and never as a constant. Rationale: exclusion is
# for individually wrong precedent. Once the deny list runs several windows deep, the
# corpus composition itself is wrong and the answer is a policy change (a different
# window, different stratification axes, or better ground truth) — not a hand-maintained
# list that keeps growing. Tying the bound to the operator's own window means a
# deployment that legitimately runs a large window gets a proportionally larger allowance
# without anybody encoding one deployment's volume here.
_EXCLUSION_BOUND_WINDOWS = 4

# Bound on the metadata-filtered BULK exclusion selection, again derived from the window
# rather than fixed. Selection filters on the projection's OWN metadata keys only.
_EXCLUSION_SELECT_WINDOWS = 4

# How many chunks ONE explicit repair run may rewrite or evict, again expressed as a
# MULTIPLE OF THE CONFIGURED WINDOW and never as a constant, for the same reason as the
# two exclusion bounds above. Drift deeper than several windows is not drift: the
# projection changed wholesale, and the cheaper, better-understood answer is an ordinary
# reseed, which re-derives every chunk from the current builder in one metered batch.
# The run reports what it did not reach and is resumable, so the bound costs coverage,
# never correctness.
_REPAIR_CAP_WINDOWS = 4

# The ADAPTIVE default for the repair collapse guard's absolute eviction floor: a
# twentieth of the configured precedent window. An operator may pin an explicit floor in
# ``prefs.precedent.repair``; ``0`` (the default) means "derive it", so a deployment that
# legitimately runs a large window gets a proportionally larger allowance and nobody
# encodes one estate's volume here.
_REPAIR_EVICTION_FLOOR_DIVISOR = 20

# Bound the per-cell/per-rule rows a composition report puts on the wire. The report is a
# diagnostic, not an export: the head of each ranking is what answers the question, and an
# unbounded per-rule map on a large estate would be the payload rather than the finding.
_MAX_COMPOSITION_ROWS = 50

# The projection metadata keys a bulk exclusion selection may filter on.
#
# An ALLOWLIST of keys THIS MODULE writes, deliberately. The tempting alternative —
# matching a rule TITLE or any other free-text field — makes the operator's selection
# depend on prose that a detection content update can rewrite underneath them, so the
# same saved filter silently selects a different population later. Every key here is
# minted by ``_resolved_case_item``/``_unconfirmed_case_item`` and is exact-matched.
EXCLUSION_SELECTABLE_KEYS: frozenset[str] = frozenset(
    {
        RULE_IDENTITY_KEY,
        "outcome",
        "verdict",
        "trust_class",
        "ground_truth_source",
        "entity",
        "status",
        "bulk_ratified",
        "ratification_batch",
    }
)

# The bulk ground-truth bootstrap (see ``routes_rag.py``). Ratification is recorded as
# its OWN append-only ``case.history`` event type — never as a ``FeedbackEntry`` and
# never as an ``analyst_action`` — precisely so that a consumer (RAG, the threshold
# tuner, a metrics rollup, a human reading the case) can tell a bulk ratification of
# MODEL verdicts apart from genuinely independent analyst outcomes. Backfilling model
# verdicts through the analyst-feedback endpoint is what made 2062 model verdicts look
# like analyst ground truth; this event is deliberately invisible to
# ``analyst_confirmed_outcome``.
PRECEDENT_RATIFICATION_EVENT = "precedent_ratification"
PRECEDENT_RATIFICATION_PROVENANCE = "bulk_model_ratification"
PRECEDENT_RATIFICATION_ACKNOWLEDGEMENT = (
    "I am ratifying model verdicts, not independent analyst ground truth"
)

# The analyst note is the one operator-authored free-text field that becomes durable
# model-facing corpus text. Bound it hard.
_ANALYST_NOTE_MAX_CHARS = 500

# --------------------------------------------------------------------------- #
# Precedent chunk TEXT — the field ALLOWLISTS.
# --------------------------------------------------------------------------- #
# ``_render_precedent_text`` emits ONLY the field names listed below, in exactly the
# listed order, so neither of the two load-bearing properties can be lost by an
# ordinary edit to a builder:
#
# 1. NO MODEL JUDGEMENT IN THE ANALYST-CONFIRMED TIER. That chunk is rendered under
#    "## Prior analyst decisions (baseline)" and opens by claiming analyst
#    provenance. Rendering the model's OWN verdict as the next clause of that same
#    sentence is an autophagous loop: the agent reads its own earlier escalations
#    back as if a human had confirmed them, and a bad streak ratifies itself. The
#    verdict and confidence stay in METADATA, which is where every consumer already
#    reads them (``engine/precedent.py`` reads metadata only; ``engine/threat_context.py``
#    reads ``metadata['verdict']``).
# 2. HUMAN-PROVENANCE CONTENT FIRST. ``agents.prompts.fence`` truncates every rendered
#    chunk at 600 characters, so the tail of a long chunk never reaches the model at
#    all. Under the old ordering a realistic 365-character analyst note began at
#    offset 523 and only its first 77 characters survived, while the model verdict at
#    offset 67 always did. The human fields now lead, and the block is deliberately
#    CASE-ID-INDEPENDENT: the outcome clause plus a MAXIMUM-length note
#    (``_ANALYST_NOTE_MAX_CHARS`` = 500) measures at most 557 characters — the longer
#    of the two outcome tokens — for EVERY case, whatever its id, so it fits the
#    600-char budget whole and only machine-derived context can be cut. The
#    id used to prefix the outcome clause, which made the guarantee depend on the id's
#    length — and the ids this product actually mints (``new_id("case-")`` = 37 chars)
#    pushed the block to 611 and amputated the tail of a long note. The id is
#    machine-derived context, so it now renders as ``case_ref`` on the machine side of
#    the boundary, where truncation is allowed to reach it. The measurement is pinned
#    by ``tests/test_precedent_corpus.py`` AGAINST A PRODUCT-MINTED ID; keep the human
#    block short and id-free if you extend it.
#
# Adding a field to a tier means EDITING THE TUPLE, which is exactly what
# ``tests/test_precedent_corpus.py`` asserts against.
_PRECEDENT_HUMAN_TEXT_FIELDS: tuple[str, ...] = ("outcome", "analyst_note")

# The case reference. Machine-derived (a minted uuid), so it sits on the machine side
# of the human/machine boundary — but FIRST there, because it is what lets the
# investigator name the precedent it is citing, and the fields after it are the ones
# truncation should eat first. The ``model_unconfirmed`` tier does not use it: its
# leading provenance disclaimer already carries the id.
_PRECEDENT_CASE_REF_TEXT_FIELDS: tuple[str, ...] = ("case_ref",)

# Case-derived context, shared by both tiers. Machine-produced, so it renders after
# the human fields and is what truncation eats first. ``recommended_action`` is
# model-authored ADVICE and is kept deliberately (it is part of the superset text
# contract both indexing paths must agree on); it is not a claim about ground truth.
_PRECEDENT_CONTEXT_TEXT_FIELDS: tuple[str, ...] = (
    "entity",
    "rules",
    "risk",
    "trigger",
    "evidence",
    "recommended_action",
)

_PRECEDENT_CONFIRMED_TEXT_FIELDS: tuple[str, ...] = (
    _PRECEDENT_HUMAN_TEXT_FIELDS
    + _PRECEDENT_CASE_REF_TEXT_FIELDS
    + _PRECEDENT_CONTEXT_TEXT_FIELDS
)

# The ``model_unconfirmed`` tier is the ONE deliberate exception: carrying the
# model's own unreviewed judgement is its entire purpose. It leads with the
# disclaimer field so truncation can never drop "nobody confirmed this" while
# keeping the judgement, and it has no analyst field because it has no analyst.
_PRECEDENT_UNCONFIRMED_TEXT_FIELDS: tuple[str, ...] = (
    ("unconfirmed_provenance", "model_judgement") + _PRECEDENT_CONTEXT_TEXT_FIELDS
)

# Field names that carry the MODEL's own outcome judgement about a case. None of
# these may ever appear in ``_PRECEDENT_CONFIRMED_TEXT_FIELDS``.
PRECEDENT_MODEL_JUDGEMENT_FIELDS: frozenset[str] = frozenset(
    {
        "model_judgement",
        "verdict",
        "model_verdict",
        "model_outcome",
        "confidence",
        "model_confidence",
        "decision_by",
        "auto_close",
    }
)


def _render_precedent_text(fields: tuple[str, ...], values: dict[str, str]) -> str:
    """Render a precedent chunk from an ALLOWLIST of field names, in allowlist order.

    The allowlist is the authority: a value whose key is not in ``fields`` is DROPPED
    (and logged), never appended. That inversion is the whole point. The read side
    renders ``chunk.text`` opaquely — ``agents/prompts.py`` fences the string without
    inspecting it — so a model-derived field smuggled into a tier's text cannot be
    caught downstream by anything. Here it produces nothing at all until a
    contributor also edits the module-level tuple above, where a test can see it.
    """
    dropped = sorted(set(values) - set(fields))
    if dropped:
        logger.warning(
            "Precedent chunk text dropped non-allowlisted field(s): %s",
            ", ".join(dropped),
        )
    return " ".join(
        segment
        for name in fields
        if (segment := str(values.get(name) or "").strip())
    )


def _case_entity_key(case: "Case") -> str:
    """``type:value`` for the case entity (log-derived; stays UNTRUSTED-fenced)."""
    return f"{case.entity.type.value}:{case.entity.value}"


def _case_rule_list(case: "Case") -> str:
    return ", ".join(case.rule_ids) or "n/a"


def _case_trigger_sentence(case: "Case") -> str:
    if case.trigger_reason and case.trigger_reason.sentence:
        return case.trigger_reason.sentence
    return "n/a"


def _case_evidence_summary(case: "Case") -> str:
    """The top-3 evidence summaries, exactly as both tiers have always bounded them."""
    return "; ".join(e.summary for e in case.evidence[:3]) or "n/a"


def _case_context_text_values(case: "Case") -> dict[str, str]:
    """The shared machine-derived context segments for BOTH precedent tiers."""
    return {
        "entity": f"Observed entity {_case_entity_key(case)}.",
        "rules": f"Rules: {_case_rule_list(case)}.",
        "risk": f"Risk: {round(case.risk_score, 1)}.",
        "trigger": f"Trigger: {_case_trigger_sentence(case)}.",
        "evidence": f"Evidence: {_case_evidence_summary(case)}.",
        "recommended_action": (
            f"Recommended action: {case.recommended_action or 'n/a'}."
        ),
    }


def _empty_repair_tier() -> dict[str, Any]:
    """One tier's repair tally. Every key is reported even at zero, so a tier that
    happens to be absent from a corpus reads as an explicit zero rather than a gap."""
    return {
        "scanned": 0,
        "current": 0,
        "stale": 0,
        "undetermined": 0,
        "not_projecting": 0,
        # The three reasons a chunk does not project, broken out because only ONE of
        # them is ever removable and an operator has to be able to see which is which.
        "excluded": 0,
        "withdrawn": 0,
        "absent": 0,
        "would_repair": 0,
        "would_evict": 0,
        "repaired": 0,
        "evicted": 0,
        "remaining": 0,
        "complete": True,
    }


def _tally_precedent_findings(
    findings: "list[PrecedentTextFinding]",
) -> dict[str, dict[str, Any]]:
    """Per-tier counts over a classified corpus. Counts only — never chunk text."""
    tiers: dict[str, dict[str, Any]] = {
        TRUST_ANALYST_CONFIRMED: _empty_repair_tier(),
        TRUST_MODEL_UNCONFIRMED: _empty_repair_tier(),
    }
    for finding in findings:
        tier = tiers.setdefault(finding.tier, _empty_repair_tier())
        tier["scanned"] += 1
        tier[finding.classification] += 1
        if finding.classification == REPAIR_NOT_PROJECTING and finding.reason in (
            REPAIR_EXCLUDED,
            REPAIR_WITHDRAWN,
            REPAIR_ABSENT,
        ):
            tier[finding.reason] += 1
    return tiers


@dataclass(frozen=True)
class PrecedentTextFinding:
    """One stored precedent chunk, classified against the CURRENT projector.

    ``item`` is the freshly rendered projection item and is populated ONLY for a STALE
    finding — it is what a repair writes, carrying the stale chunk's own ``doc_id`` so
    the store upserts in place instead of landing a second chunk beside it.
    """

    document_id: str
    doc_id: str
    case_id: str
    tier: str
    classification: str
    reason: str = ""
    item: dict[str, Any] | None = None
    #: The STORED chunk, carried so an eviction can write the payload it is about to
    #: destroy to the append-only trail BEFORE destroying it.
    text: str = ""
    metadata: dict[str, Any] | None = None


@dataclass(frozen=True)
class RagRetrievalObservation:
    """One retrieval outcome with an explicit measurement boundary.

    ``chunks=[]`` alone is ambiguous because the public fail-soft API historically
    returned that value for both a valid zero-hit search and an unavailable backend.
    Investigation metrics consume ``measured`` and ``reason`` instead of guessing
    from the list.
    """

    chunks: list[RagChunk]
    measured: bool
    reason: str

# Legacy grouping key for pre-fix incrementally indexed precedent (chunks written
# with a stable ``doc_id`` but no ``metadata.document_id``).
_LEGACY_RESOLVED_CASE_DOCUMENT = f"seed:{RESOLVED_CASE_SOURCE}"

# The corpus source tag for operator-imported threat-intelligence documents (F11).
# Retrievable like any other knowledge and injected as a TRUSTED fenced block.
THREAT_CONTEXT_SOURCE = "threat_context"

# TRUSTED-KNOWLEDGE ALLOWLIST (OWASP LLM01 hardening). Only chunks whose ``source``
# is in this allowlist are rendered as TRUSTED reference material in a prompt; ANY
# other retrieved chunk — notably operator/user-IMPORTED documents
# (``import_document`` → source="imported"), pasted threat-intel
# (``threat_context``), or any future/unknown source — is attacker-influenceable
# and MUST be wrapped in the UNTRUSTED fence (#9) before it enters a prompt, exactly
# like raw log evidence. This is an ALLOWLIST (default-deny), not a denylist, so a
# new corpus source is UNTRUSTED until someone deliberately adds it here.
#
# The set is the system-verified seed corpus: shipped operator runbooks, the bundled
# MITRE ATT&CK technique descriptions, and our own suppression guidance. NOTE:
# ``resolved_case`` is intentionally NOT trusted-rendered — its text is derived from
# case fields (entity/rules/evidence/notes), which are log-derived and therefore
# attacker-influenceable, so it is fenced as an UNTRUSTED baseline at render time.
TRUSTED_KNOWLEDGE_SOURCES = frozenset({"runbook", "mitre", "suppression"})

def is_trusted_knowledge(source: str | None) -> bool:
    """Whether a retrieved RAG chunk's ``source`` is in the TRUSTED allowlist.

    Default-deny: anything not explicitly allow-listed (imported docs, pasted
    threat-intel, unknown/future sources) is UNTRUSTED and must be fenced before it
    reaches a model prompt (#9 / OWASP LLM01)."""
    return source in TRUSTED_KNOWLEDGE_SOURCES


_SLUG_RE = re.compile(r"[^a-z0-9]+")

# Control characters (incl. newlines/tabs) that must never survive into a stored
# precedent chunk: they let a single operational note restructure the corpus text.
_CONTROL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f-\x9f]")


def _flatten_analyst_note(note: str | None) -> str:
    """Bound + flatten a free-text analyst note before it becomes durable corpus text.

    The note is operator-authored, but it is stored verbatim in a ``resolved_case``
    chunk that is replayed into future prompts, so an oversized or multi-line note
    silently reshapes the precedent corpus around it (and dilutes its retrieval
    vector). Strip control characters/newlines, collapse whitespace, and bound the
    length to ``_ANALYST_NOTE_MAX_CHARS``.

    This is defence in depth, NOT a substitute for the fence: ``resolved_case``
    remains UNTRUSTED-fenced at render time (#9 / OWASP LLM01)."""
    text = _CONTROL_CHARS_RE.sub(" ", str(note or ""))
    text = " ".join(text.split())
    if len(text) > _ANALYST_NOTE_MAX_CHARS:
        text = text[: _ANALYST_NOTE_MAX_CHARS - 1].rstrip() + "…"
    return text


def _slugify(title: str) -> str:
    slug = _SLUG_RE.sub("-", (title or "").strip().lower()).strip("-")
    return slug[:60] or "document"


def _shorthash(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8", "replace")).hexdigest()[:8]


def _sanitise_source_label(source: str | None) -> str:
    """Sanitise an imported document's ``source`` at write time (#9 defense-in-depth).

    The source is rendered as a fenced ``source=`` provenance label; drop newlines and
    any character that could help forge a fence/PLAYBOOK/MEMORY delimiter (``<``/``>``),
    collapse whitespace, and length-bound it. ``fence()`` neutralises this again at
    render time, but a stored value should never carry an escape attempt in the first
    place."""
    s = (source or "").replace("<", "").replace(">", "")
    s = " ".join(s.split())  # collapse newlines/runs of whitespace
    value = s[:64].strip() or "imported"
    # A generic import can carry a useful display label, but provenance/trust is
    # server-assigned. Never let a caller mint a TRUSTED seed source by submitting
    # source="runbook"/"mitre"/"suppression".
    if value in TRUSTED_KNOWLEDGE_SOURCES:
        return "imported"
    return value


def _parse_iso(value: Any) -> datetime | None:
    """Best-effort ISO-8601 → aware datetime; ``None`` when unparseable."""
    try:
        parsed = datetime.fromisoformat(str(value or "").replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _metadata_axis(key: str) -> Callable[[dict[str, Any]], str]:
    """A stratification axis that reads ONE metadata KEY off a projected item.

    The indirection is the point: the window can be stratified on anything the
    projection writes without the selector — or this factory — ever learning what a
    rule or an outcome is. An absent key yields ``""``, which is a group like any
    other, so a partially-stamped corpus degrades instead of raising.
    """

    def _read(item: dict[str, Any]) -> str:
        return str((item.get("metadata") or {}).get(key) or "")

    return _read


def _admission_time_bucket(value: Any) -> str:
    """Coarse, deterministic time bucket used when no explicit batch marker exists."""
    parsed = _parse_iso(value)
    if parsed is None:
        return ""
    epoch = int(parsed.timestamp())
    return f"t:{epoch - (epoch % _ADMISSION_TIME_BUCKET_SECONDS)}"


def _window_signature_extras(window: "PrecedentWindowConfig") -> tuple[Any, ...]:
    """The non-default later-added window fields, as stable signature members.

    Empty for a default-constructed config — that is the whole contract: adding a field
    to the window policy must not change the corpus source signature, because a changed
    signature reseeds and re-embeds the entire corpus at the operator's expense.
    """
    from ..config import PrecedentWindowConfig as _Window

    defaults = _Window()
    out: list[Any] = []
    for name in _WINDOW_SIGNATURE_APPENDED_FIELDS:
        value = getattr(window, name, None)
        if value != getattr(defaults, name, None):
            out.append(f"precedent.window.{name}={value!r}")
    return tuple(out)


def _created_at_rank(case: "Case") -> tuple[int, float]:
    """Sort key for a globally newest-first merge of separately-paged statuses.

    A missing, blank or unparseable ``created_at`` cannot be shown to be newer than
    anything, so it ranks LAST under the descending sort (``0`` in the first member)
    rather than being silently treated as epoch-zero-old or as now-new. Python's sort is
    stable and ``reverse=True`` does not reverse equal runs, so cases sharing a rank keep
    the scan order they arrived in and the result stays deterministic.
    """
    parsed = _parse_iso(getattr(case, "created_at", "") or "")
    if parsed is None:
        return (0, 0.0)
    return (1, parsed.timestamp())


def is_bulk_ratified(case: "Case") -> bool:
    """Whether this case already carries a bulk precedent-ratification marker.

    The marker is what makes the bootstrap IDEMPOTENT + resumable: a re-run over the
    same backlog skips everything already ratified instead of re-writing it. It also
    carries the PROVENANCE that keeps bulk ratification distinguishable from
    independent analyst outcomes.
    """
    for entry in reversed(list(getattr(case, "history", None) or [])):
        if isinstance(entry, dict) and entry.get("event") == PRECEDENT_RATIFICATION_EVENT:
            return True
    return False


def precedent_ratification_entry(
    *, actor: str, batch_id: str, outcome: str, confidence: float
) -> dict[str, Any]:
    """Build the append-only ``case.history`` provenance record for a ratification.

    Deliberately NOT an ``analyst_action`` and NOT a ``FeedbackEntry``: this asserts
    only that an authorised operator agreed to reuse the MODEL's own verdict as a
    weak precedent. ``trust_class`` stays ``model_unconfirmed`` and ``analyst`` is
    intentionally absent — no analyst identity is fabricated.
    """
    return {
        "ts": iso_now(),
        "event": PRECEDENT_RATIFICATION_EVENT,
        "provenance": PRECEDENT_RATIFICATION_PROVENANCE,
        "trust_class": TRUST_MODEL_UNCONFIRMED,
        "ratified_by": str(actor or ""),
        "batch_id": str(batch_id or ""),
        "model_outcome": str(outcome or ""),
        "model_confidence": round(float(confidence or 0.0), 4),
        "independent_analyst_outcome": False,
        "acknowledgement": PRECEDENT_RATIFICATION_ACKNOWLEDGEMENT,
    }


# --------------------------------------------------------------------------- #
# Seed corpus — each item is {text, source, metadata}.
# --------------------------------------------------------------------------- #
SEED_RUNBOOKS: list[dict[str, Any]] = [
    {
        "text": (
            "SSH brute force / failed login runbook: A burst of failed authentication "
            "attempts (sshd 'Failed password', many auth failures) from one source IP "
            "against a host indicates brute force. Confirm whether any attempt succeeded, "
            "check the breadth of targeted usernames, and block the source IP if hostile."
        ),
        "source": "runbook",
        "metadata": {"topic": "brute_force", "rule": "sshd", "mitre": "T1110"},
    },
    {
        "text": (
            "Web application / ModSecurity WAF alert runbook: ModSec or WAF rule triggers "
            "(SQLi, XSS, path traversal, LFI) against a public web app. Inspect the request "
            "payload and response code — a 200 on a flagged request suggests the exploit may "
            "have reached the app. Correlate by client IP across endpoints."
        ),
        "source": "runbook",
        "metadata": {"topic": "web_attack", "rule": "modsecurity", "mitre": "T1190"},
    },
    {
        "text": (
            "Port scan / Suricata reconnaissance runbook: Suricata 'ET SCAN' or many "
            "connection attempts to distinct ports from a single source IP indicate port "
            "scanning. Treat as reconnaissance; assess how many ports/hosts were probed and "
            "whether any service responded before deciding to block."
        ),
        "source": "runbook",
        "metadata": {"topic": "port_scan", "rule": "suricata", "mitre": "T1046"},
    },
    {
        "text": (
            "Suspicious mail / Postfix runbook: Postfix logs showing high-volume relay "
            "attempts, repeated rejected recipients, or auth failures on submission can mean "
            "spam relay abuse or credential stuffing against mail. Check sender reputation, "
            "rejection reasons and whether any authentication succeeded."
        ),
        "source": "runbook",
        "metadata": {"topic": "mail_abuse", "rule": "postfix", "mitre": "T1566"},
    },
    {
        "text": (
            "Vulnerability scan / Nessus-OpenVAS runbook: Bursts of varied requests probing "
            "known CVEs and default paths from one IP indicate an automated vulnerability "
            "scanner (Nessus, OpenVAS, nikto). Distinguish authorised internal scans from "
            "hostile external scanning before escalating."
        ),
        "source": "runbook",
        "metadata": {"topic": "vuln_scan", "rule": "nessus-openvas", "mitre": "T1595"},
    },
    {
        "text": (
            "Malicious IP reputation runbook: When threat-intel enrichment flags a source IP "
            "with a high reputation score (AbuseIPDB/VirusTotal), prioritise the case. "
            "Correlate the IP's activity across rules and hosts, capture all touched assets "
            "and recommend blocking at the perimeter."
        ),
        "source": "runbook",
        "metadata": {"topic": "ip_reputation", "rule": "enrichment", "mitre": "T1071"},
    },
]

SEED_MITRE: list[dict[str, Any]] = [
    {
        "text": "T1110 Brute Force: Adversaries guess passwords via repeated authentication attempts.",
        "source": "mitre",
        "metadata": {"technique_id": "T1110", "name": "Brute Force"},
    },
    {
        "text": "T1046 Network Service Discovery: Adversaries scan for listening services to map attack surface.",
        "source": "mitre",
        "metadata": {"technique_id": "T1046", "name": "Network Service Discovery"},
    },
    {
        "text": "T1190 Exploit Public-Facing Application: Adversaries exploit a flaw in an internet-facing app.",
        "source": "mitre",
        "metadata": {"technique_id": "T1190", "name": "Exploit Public-Facing Application"},
    },
    {
        "text": "T1566 Phishing: Adversaries send malicious messages to obtain access or credentials.",
        "source": "mitre",
        "metadata": {"technique_id": "T1566", "name": "Phishing"},
    },
    {
        "text": "T1071 Application Layer Protocol: Adversaries use common protocols (HTTP/DNS) for C2 to blend in.",
        "source": "mitre",
        "metadata": {"technique_id": "T1071", "name": "Application Layer Protocol"},
    },
    {
        "text": "T1595 Active Scanning: Adversaries actively probe infrastructure to gather information before attack.",
        "source": "mitre",
        "metadata": {"technique_id": "T1595", "name": "Active Scanning"},
    },
    {
        "text": "T1078 Valid Accounts: Adversaries use legitimate credentials to gain or maintain access.",
        "source": "mitre",
        "metadata": {"technique_id": "T1078", "name": "Valid Accounts"},
    },
    {
        "text": "T1499 Endpoint Denial of Service: Adversaries flood a service to exhaust resources and deny access.",
        "source": "mitre",
        "metadata": {"technique_id": "T1499", "name": "Endpoint Denial of Service"},
    },
]

SEED_SUPPRESSION_GUIDANCE: list[dict[str, Any]] = [
    {
        "text": (
            "Benign pattern: Authenticated vulnerability scans from a known internal scanner "
            "IP on its scheduled window are expected and benign. Match the scanner's source "
            "IP and the maintenance schedule before suppressing."
        ),
        "source": "suppression",
        "metadata": {"topic": "internal_scanner"},
    },
    {
        "text": (
            "Benign pattern: A health-check or monitoring service repeatedly hitting an "
            "endpoint generates high request volume but is not an attack. Identify the "
            "monitoring user-agent or source IP to avoid false positives."
        ),
        "source": "suppression",
        "metadata": {"topic": "health_check"},
    },
    {
        "text": (
            "Benign pattern: A user fat-fingering a password a few times then succeeding is "
            "normal. Only a sustained burst of failures, especially across many usernames or "
            "with no eventual success, should be treated as brute force."
        ),
        "source": "suppression",
        "metadata": {"topic": "password_typo"},
    },
]


class RagService:
    """Embeds the enabled seed corpus once and serves nearest-neighbour retrieval.

    Beyond the static seed corpus it can index past CLOSED cases as institutional
    memory (``use_resolved_cases``), so an investigation can surface "we have seen
    this entity / verdict before". Every stored chunk is tagged with the embedding
    model + dim so an embedding-space change clears + reseeds rather than silently
    mixing incompatible vectors.
    """

    def __init__(
        self,
        gateway: LLMGateway,
        prefs: Preferences,
        store: VectorStore | None = None,
        cases: "CaseStore | None" = None,
        runbooks: "RunbookService | None" = None,
        health: "RagHealthStore | None" = None,
        exclusions: "PrecedentExclusionStore | None" = None,
    ) -> None:
        self._gateway = gateway
        self._prefs = prefs
        self._store: VectorStore = store or InMemoryVectorStore()
        self._cases = cases
        self._runbooks = runbooks
        # Optional durable projection-health record (see stores/rag_health.py).
        # Defaulted None so every historical/test construction is unchanged; when
        # absent, the in-process ``last_projection`` below is the only record.
        self._health = health
        # Optional durable per-case precedent EXCLUSION set (stores/precedent_exclusions).
        # Defaulted None exactly like ``health`` above, so every historical/test
        # construction — and any deployment that never excludes anything — is byte-
        # identical: with no store there are no markers and every predicate below is a
        # no-op.
        self._exclusions = exclusions
        # The exclusion set held IN MEMORY. The projection is synchronous and runs the
        # predicate once per scanned case, so the predicate must never do I/O; the set is
        # refreshed at the START of every projection (inside the seed lock) and
        # immediately after every write instead.
        self._excluded_cases: frozenset[str] = frozenset()
        # Whether the in-memory set has ever been loaded successfully, and whether the
        # last refresh FAILED. A failed refresh keeps the last known-good set rather than
        # falling back to "no exclusions": defaulting to empty on a transient store glitch
        # would resurrect every excluded precedent on that projection, which is precisely
        # the silent self-undoing this whole mechanism exists to end. The staleness is
        # published so the operator surface can say so instead of quietly guessing.
        self._exclusions_loaded: bool = False
        self.exclusions_stale: bool = False
        self._seeded = False
        self._seed_signature: tuple[Any, ...] | None = None
        self._seed_lock = asyncio.Lock()
        # Last projection outcome PER SOURCE, so a health surface can show that a
        # re-seed shrank (or collapsed) a corpus instead of that fact living only in
        # a log line. Shape per source:
        #   {source, before, after, delta, shrank, collapsed, source_enabled, at}
        # ``before``/``after`` are stored chunk counts either side of the projection.
        self.last_projection: dict[str, dict[str, Any]] = {}
        # The last REFUSED projection, in-process, for the health surfaces that must
        # answer without touching the store (``/api/health`` is anonymous and must
        # never be able to trigger a corpus scan or an embedding spend). Shape:
        #   {reason, collapsed, outgoing_total, at}
        self.last_refusal: dict[str, Any] | None = None
        # Whether the corpus is POSITIVELY KNOWN to be empty, from the most recent
        # count this service actually read. Deliberately a two-state flag with a
        # "not known empty" default: an unread corpus must never be reported as a
        # degradation. Updated by every path that already reads the count, so the
        # anonymous ``/api/health`` probe can answer without touching the store (and
        # therefore without being able to trigger an embedding spend).
        self.corpus_known_empty: bool = False
        # Whether that emptiness is a DEGRADATION rather than an expected state.
        #
        # "Empty" alone is not a fault: a freshly started deployment has not seeded
        # yet, and an operator who disabled every source has an empty corpus on
        # purpose. It becomes a degradation once the corpus is empty even though a
        # projection has been attempted or previously succeeded — which is exactly
        # the incident state (seeding reported complete, corpus at zero, for 3 days).
        # Kept separate so a cold start can never raise a false alarm and the real
        # condition can never be dismissed as one.
        self.corpus_degraded: bool = False
        # Cached per-rule analyst-confirmed precedent distribution + the monotonic
        # instant it was computed. In-process only and TTL-bounded; every precedent
        # write invalidates it, so a stale count can never outlive a corpus change.
        self._precedent_distribution: PrecedentDistribution | None = None
        self._precedent_distribution_at: float | None = None

    @property
    def store(self) -> VectorStore:
        """The backing vector store — a READ-ONLY accessor for corpus snapshotting.

        The replay harness pins one corpus snapshot per run (``list_all_chunks`` +
        restore), which needs the store itself rather than a projection. Exposed as a
        property so that seam is a contract instead of a private-attribute reach.
        """
        return self._store

    def set_prefs(self, prefs: Preferences) -> None:
        """Point the service at the latest preferences so a live settings change
        (e.g. toggling rag.enabled / use_resolved_cases / min_score) takes effect
        without a full rewire."""
        self._prefs = prefs
        # A precedent-source or window change can change what the distribution counts.
        self.invalidate_precedent_distribution()

    # ------------------------------------------------------------------ #
    # Case-scoped precedent EXCLUSION — making a force-delete stay deleted.
    # ------------------------------------------------------------------ #
    # Deleting a ``resolved_case`` document removes its chunks; the next projection then
    # re-derives that precedent from the case store and puts it straight back. The
    # operator's action silently undid itself and nothing reported that it had. The only
    # workaround was to destroy the analyst's own label on the case, which rewrites
    # ground truth and corrupts the tuner's independent-evidence count.
    #
    # The fix is a PREDICATE AT EVERY PRODUCER, not one edit. A precedent item can be
    # (re-)derived by five distinct paths, and missing any one of them resurrects the
    # exclusion:
    #   1. ``_resolved_case_item``      — the analyst-CONFIRMED window projection, and
    #                                     the incremental close-time path, which share it;
    #   2. ``_unconfirmed_candidate``   — the lower-trust ``model_unconfirmed`` tier, and
    #                                     through it the bulk-ratification bootstrap seam;
    #   3. ``_preserved_resolved_case_items`` — the PRESERVED-ITEMS path taken on an
    #                                     embedding-model change, which re-embeds straight
    #                                     from the pre-migration snapshot and never
    #                                     consults the per-case projector at all, so
    #                                     missing it means the FIRST embedding change
    #                                     resurrects every exclusion at once;
    #   4. ``index_precedent_items``    — the explicit bootstrap indexer, which is handed
    #                                     already-projected items from outside;
    #   5. the two in-place chunk reconciliations, which re-write existing precedent
    #      chunks (legacy document identity, and rule identity).
    # The delete route itself is the sixth seam and is where an exclusion is recorded.
    #
    # ``_reseed``'s ROLLBACK is deliberately NOT on that list. It restores a verified
    # snapshot of the corpus as it was moments earlier, which is the one thing a rollback
    # must do; filtering it would make a failed migration silently lossy. A chunk it
    # restores for an excluded case can only exist if the exclusion's delete half did not
    # complete, which the exclusion call reports (``complete: false``) and a re-issue
    # finishes.
    def _filter_excluded_precedent(
        self, survivors: list[tuple[Any, float]]
    ) -> list[tuple[Any, float]]:
        """Drop retrieved precedent whose case is operator-excluded. See the call site."""
        if not self._excluded_cases:
            return survivors
        return [
            (chunk, score)
            for chunk, score in survivors
            if chunk.source != RESOLVED_CASE_SOURCE
            or not self._is_case_excluded((chunk.metadata or {}).get("case_id"))
        ]

    def _is_case_excluded(self, case_id: Any) -> bool:
        """Whether this case is operator-excluded from the precedent corpus.

        Pure, synchronous and I/O-free by contract: it is called once per scanned case
        inside the projection. The set it reads is refreshed at projection boundaries.
        """
        key = str(case_id or "")
        return bool(key) and key in self._excluded_cases

    async def _refresh_exclusions(self, *, force: bool = False) -> bool:
        """Reload the in-memory exclusion set. Never raises.

        Called at the START of every projection (inside the seed lock) and lazily by the
        async single-case entry points, so the synchronous predicate never touches the
        store.

        Returns whether the set is USABLE. There are three outcomes, and conflating the
        last two is what let an exclusion undo itself:

        * **Loaded** — the set is current. ``True``.
        * **Stale but KNOWN** — the read failed on a process that has read it before, so
          the last known-good set is kept and marked stale. ``True``: a slightly old deny
          list still denies, and re-deriving from it is safe.
        * **UNKNOWN** — the read failed and this process has NEVER held the set, so the
          empty in-memory set means "we do not know", not "nothing is excluded".
          ``False``. A producer that proceeds here re-derives every excluded precedent,
          and ``resolved_case`` is exempt from the stale sweep, so the resurrected chunks
          survive even a full ``rebuild_corpus()``. Callers must fail closed —
          :meth:`_require_exclusions` is the projection's way of doing that.

        A deployment with no exclusion store wired has nothing to exclude and is always
        usable, so the whole mechanism stays a no-op there (#5).
        """
        if self._exclusions is None:
            return True
        if self._exclusions_loaded and not force:
            return True
        rows = await self._exclusions.load()
        if rows is None:
            self.exclusions_stale = True
            if not self._exclusions_loaded:
                logger.error(
                    "Precedent exclusion set is UNKNOWN (it could not be read and this "
                    "process has never held it); refusing to derive precedent rather "
                    "than re-adding every excluded case"
                )
                return False
            logger.warning(
                "Precedent exclusion set could not be read; keeping the last known set "
                "of %d exclusion(s) rather than re-deriving excluded precedent",
                len(self._excluded_cases),
            )
            return True
        self._excluded_cases = frozenset(rows)
        self._exclusions_loaded = True
        self.exclusions_stale = False
        return True

    async def _require_exclusions(self, *, force: bool = False) -> None:
        """Refresh the exclusion set, raising when it is UNKNOWN. See above."""
        if not await self._refresh_exclusions(force=force):
            raise ExclusionSetUnavailable(
                "the precedent exclusion set could not be read and has never been "
                "loaded by this process; the existing corpus was left untouched rather "
                "than re-deriving precedent an operator excluded"
            )

    def _exclusion_bound(self) -> int:
        """The largest exclusion set this deployment may hold.

        Derived from the operator's configured precedent window size, never a constant —
        see ``_EXCLUSION_BOUND_WINDOWS`` for why the bound is relative.
        """
        return max(1, int(self._window_config().size)) * _EXCLUSION_BOUND_WINDOWS

    def _source_signature(self) -> tuple[Any, ...]:
        cfg = self._prefs.rag
        runbooks = getattr(self._prefs, "runbooks", None)
        return (
            bool(cfg.enabled),
            bool(cfg.use_runbooks),
            bool(runbooks is None or runbooks.enabled),
            bool(cfg.use_mitre),
            bool(cfg.use_resolved_cases),
            bool(cfg.use_suppression_rules),
            bool(cfg.use_threat_context),
            # The lower-trust tier and its compounding guards change WHAT is projected,
            # so tightening a guard must reproject rather than leave stale, now-illegal
            # precedent in the corpus. Appended (never inserted) so the existing
            # positional members are unchanged.
            bool(cfg.use_unconfirmed_resolved_cases),
            self._unconfirmed_cfg().model_dump_json(),
            # The precedent WINDOW policy changes WHICH qualifying cases are projected
            # (size + per-rule stratification), so a settings change must reseed.
            # Appended, never inserted.
            #
            # The dump EXCLUDES the later-added window fields, which are appended at the
            # very end of this tuple and only when they differ from their defaults. A
            # default-constructed window config therefore still serialises to the exact
            # pre-change bytes, so growing this schema cannot by itself invalidate every
            # deployment's cached signature and force a full, BILLABLE re-embed.
            self._window_config().model_dump_json(
                exclude=set(_WINDOW_SIGNATURE_APPENDED_FIELDS)
            ),
            # The EMBEDDING SPACE the corpus is projected into.
            #
            # Scope note, so this is not mis-cited later: this term tracks the
            # CONFIGURED embedding MODEL, which does not change during a provider
            # outage — recovery from an outage is handled by the corpus-emptiness
            # self-heal in ``retrieve_observed`` and by ``rebuild_corpus``, not by this
            # tuple. What it does fix is the adjacent hole: an operator changing the
            # embedding model previously left the cached signature untouched, so
            # ``ensure_seeded`` short-circuited and the corpus kept serving vectors
            # from a space the queries no longer live in.
            #
            # This is a REAL SPEND event when an operator changes the embedding model:
            # the whole corpus is re-embedded. That is the correct behaviour — vectors
            # from two different models are not comparable — and it is exactly what the
            # existing ``EmbeddingSpaceMismatch``/``_reseed`` path already does on read.
            # Appended, never inserted.
            self._embedding_space()[0],
            # The later-added window fields, appended ONLY when non-default so the
            # tuple a default deployment produces is byte-identical to the pre-change
            # one. See ``_WINDOW_SIGNATURE_APPENDED_FIELDS``.
            *_window_signature_extras(self._window_config()),
        )

    def _unconfirmed_cfg(self) -> "UnconfirmedPrecedentConfig":
        """The compounding-guard block (falls back to shipped defaults if absent)."""
        cfg = getattr(self._prefs.rag, "unconfirmed_precedent", None)
        if cfg is None:  # pragma: no cover - a stored pre-tier config
            from ..config import UnconfirmedPrecedentConfig

            return UnconfirmedPrecedentConfig()
        return cfg

    def _unconfirmed_enabled(self) -> bool:
        """Whether the LOWER-TRUST precedent tier is active.

        It is a SUB-TIER of the precedent corpus, so it requires ``use_resolved_cases``
        as well as its own explicit opt-in. Default OFF (#10)."""
        cfg = self._prefs.rag
        return bool(
            cfg.use_resolved_cases
            and getattr(cfg, "use_unconfirmed_resolved_cases", False)
        )

    def _source_enabled(self, source: str) -> bool:
        cfg = self._prefs.rag
        runbooks = getattr(self._prefs, "runbooks", None)
        if source == "runbook":
            return bool(cfg.use_runbooks and (runbooks is None or runbooks.enabled))
        if source == "mitre":
            return bool(cfg.use_mitre)
        if source == "suppression":
            return bool(cfg.use_suppression_rules)
        if source == "resolved_case":
            return bool(cfg.use_resolved_cases)
        if source == THREAT_CONTEXT_SOURCE:
            return bool(cfg.use_threat_context)
        return True

    async def _drop_stale_managed_projection(self, expected: set[str]) -> int:
        """Delete stale system projections after their replacements are durable.

        ``expected`` contains the document ids that were embedded, written, and
        verified for the new projection.  This method is intentionally called only
        after that verification so an embedding/provider failure can never erase
        the last known-good corpus.  Operator imports are never considered here.

        Only FULLY RECONCILED sources are swept (see
        ``FULLY_RECONCILED_SEED_SOURCES``): for those, the projection rebuilds every
        enabled document, so absence from ``expected`` proves the document was
        withdrawn.  ``resolved_case`` is excluded because its projection is a bounded
        window over the newest qualifying cases — absence there only means "older
        than the window", and sweeping it wiped the entire accumulated precedent
        corpus on any unrelated reprojection.  Explicit per-document deletion still
        removes a specific precedent.
        """
        removed = 0
        for document in await self._store.list_documents():
            if str(document.get("source") or "") not in FULLY_RECONCILED_SEED_SOURCES:
                continue
            document_id = str(document.get("document_id") or "")
            if document_id and document_id not in expected:
                removed += await self._store.delete_document(document_id)
        return removed

    def _embedding_space(self) -> tuple[str, int]:
        """The CONFIGURED embedding space identity, as ``(model, dim)``.

        Part of ``_source_signature`` so a change of embedding model reprojects the
        corpus rather than mixing incomparable vector spaces.
        """
        cfg = self._prefs.model_for("embedding")
        # dim is settled at first embed; the model id is the stable space tag.
        return (cfg.model, 0)

    async def _runbook_seed_items(self) -> list[dict[str, Any]]:
        if self._runbooks is not None:
            return await self._runbooks.corpus_items()
        return runbook_corpus_items()

    async def _enabled_seeds(self) -> list[dict[str, Any]]:
        cfg = self._prefs.rag
        seeds: list[dict[str, Any]] = []
        runbooks = getattr(self._prefs, "runbooks", None)
        if cfg.use_runbooks and (runbooks is None or runbooks.enabled):
            # Prefer the plain-text runbook FILES (Vigil's "playbooks are files")
            # when runbooks are enabled and present; fall back to the in-code seed
            # snippets so RAG always has runbook coverage.
            file_items: list[dict[str, Any]] = []
            try:
                file_items = await self._runbook_seed_items()
            except Exception as exc:  # noqa: BLE001
                logger.warning("Runbook corpus load failed; using seed runbooks: %s", exc)
            seeds.extend(file_items or SEED_RUNBOOKS)
        if cfg.use_mitre:
            seeds.extend(SEED_MITRE)
        if cfg.use_suppression_rules:
            seeds.extend(SEED_SUPPRESSION_GUIDANCE)
        # ``use_resolved_cases`` is handled separately by index_resolved_cases()
        # because it requires an async load from the CaseStore.
        return seeds

    @staticmethod
    def _managed_items(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Give every managed seed a stable document and chunk identity.

        Older projections grouped anonymous seeds under ``seed:<source>``. Stable
        ids let every concrete store upsert the replacement before stale documents
        are removed, while preserving the same document grouping in the UI.
        """
        out: list[dict[str, Any]] = []
        for raw in items:
            item = dict(raw)
            source = str(item.get("source") or "unknown")
            metadata = dict(item.get("metadata") or {})
            explicit_chunk_id = str(item.get("doc_id") or "")
            document_id = str(metadata.get("document_id") or "")
            if not document_id:
                document_id = explicit_chunk_id or f"seed:{source}"
            if not explicit_chunk_id:
                identity = "\0".join(
                    (
                        document_id,
                        source,
                        str(item.get("embedding_text") or ""),
                        str(item.get("text") or ""),
                    )
                )
                explicit_chunk_id = (
                    f"{document_id}:{hashlib.sha256(identity.encode('utf-8', 'replace')).hexdigest()[:20]}"
                )
            metadata["document_id"] = document_id
            item["metadata"] = metadata
            item["doc_id"] = explicit_chunk_id
            out.append(item)
        return out

    async def _embed_items(self, items: list[dict[str, Any]]) -> list[StoredChunk]:
        """Embed and validate items without mutating the vector store."""
        if not items:
            return []
        # A source may provide a compact retrieval representation while retaining a
        # fuller stored/rendered chunk. Runbooks use this to avoid a duplicate
        # descriptor-only prompt chunk without diluting their retrieval vector.
        texts = [str(s.get("embedding_text") or s["text"]) for s in items]
        configured_model = self._prefs.model_for("embedding").model
        batch = await self._gateway.embed_with_provenance(
            texts, self._prefs.model_for("embedding"), surface="rag"
        )
        # ------------------------------------------------------------------ #
        # A DEGRADED embedding space may never become a durable write.
        # ------------------------------------------------------------------ #
        # The gateway falls back to deterministic local hash embeddings when the
        # configured provider cannot answer. For a READ that is a good trade:
        # degraded retrieval beats no retrieval. For a WRITE it is corruption —
        # hash-space vectors are meaningless in the real embedding space, and once
        # persisted they are indistinguishable from real ones, so the corpus is
        # silently wrong until someone reprojects it (which is exactly how a
        # provider outage turned into three days of 0% auto-close).
        #
        # ``not_configured`` is the ONE fallback we still persist: a deployment with
        # no embedding key is running the supported keyless/offline profile (Gate 2),
        # where hash embeddings are the intended and self-consistent space.
        if batch.fallback and batch.fallback_reason != FAILURE_NOT_CONFIGURED:
            raise EmbeddingSpaceMismatch(
                "refusing to persist chunks embedded by the local fallback: the "
                f"configured embedding provider is degraded ({batch.fallback_reason or 'unavailable'}). "
                "The existing corpus is left intact."
            )
        vectors = batch.vectors
        if len(vectors) != len(items):
            raise EmbeddingSpaceMismatch(
                f"embedding cardinality {len(vectors)} != input cardinality {len(items)}"
            )
        dims = {len(vector) for vector in vectors}
        if not vectors or 0 in dims or len(dims) != 1:
            raise EmbeddingSpaceMismatch(
                f"embedding batch has invalid or inconsistent dimensions: {sorted(dims)}"
            )
        # A correctly SHAPED but all-zero vector is not a usable embedding: cosine
        # similarity against it is undefined and it silently ranks as a constant.
        # The documented contract already promises this check ("all-zero vectors fail
        # before a partial write"); only the dimension half was actually implemented.
        if any(not any(vector) for vector in vectors):
            raise EmbeddingSpaceMismatch(
                "embedding batch contains an all-zero vector; refusing a partial write"
            )
        return [
            StoredChunk(
                text=s["text"],
                source=s.get("source", "unknown"),
                metadata={
                    **dict(s.get("metadata", {})),
                    "embedding_provider": batch.provider,
                    "embedding_fallback": batch.fallback,
                    # Closed-vocabulary provenance so a MIXED-space corpus is
                    # detectable rather than silently wrong. Only ``""`` (the real
                    # provider answered) and ``not_configured`` (the supported keyless
                    # profile) can ever reach a durable chunk — the guard above
                    # refuses every other value — but the tag is written either way so
                    # the space a chunk was produced in is always attributable.
                    "embedding_fallback_reason": batch.fallback_reason,
                    "configured_embedding_model": configured_model,
                },
                embedding=vec,
                embedding_model=batch.model,
                dim=len(vec),
                doc_id=s.get("doc_id"),
            )
            for s, vec in zip(items, vectors)
        ]

    async def _embed_and_add(self, items: list[dict[str, Any]]) -> int:
        """Embed ``items`` and add them after full batch validation."""
        chunks = await self._embed_items(items)
        if not chunks:
            return 0
        await self._store.add(chunks)
        return len(chunks)

    async def _verify_projection(self, chunks: list[StoredChunk]) -> set[str]:
        """Read back every expected managed document before stale deletion."""
        expected_counts = Counter(
            str((chunk.metadata or {}).get("document_id") or "") for chunk in chunks
        )
        expected_counts.pop("", None)
        documents = {
            str(document.get("document_id") or ""): int(document.get("chunk_count") or 0)
            for document in await self._store.list_documents()
        }
        missing = {
            document_id: count
            for document_id, count in expected_counts.items()
            if documents.get(document_id, 0) < count
        }
        if missing:
            raise RuntimeError(f"managed RAG projection read-back failed: {missing}")
        return set(expected_counts)

    async def _snapshot_store_chunks(self) -> list[StoredChunk]:
        """Read a complete rollback snapshot before replacing a vector space.

        A model/dimension migration is the only reconciliation path that must replace
        the physical vector space. Refuse to begin that destructive swap unless the
        management API returned every stored chunk; an empty or partial fail-soft read
        must never be mistaken for a safe snapshot.
        """
        expected = await self._store.count()
        chunks: list[StoredChunk] = []
        for document in await self._store.list_documents():
            document_id = str(document.get("document_id") or "")
            if document_id:
                chunks.extend(await self._store.list_chunks(document_id))
        if len(chunks) != expected:
            raise RuntimeError(
                f"RAG migration snapshot incomplete: read {len(chunks)} of {expected} chunks"
            )
        return chunks

    @staticmethod
    def _operator_items_from_snapshot(chunks: list[StoredChunk]) -> list[dict[str, Any]]:
        """Project non-managed documents for re-embedding in a new vector space."""
        return [
            {
                "text": chunk.text,
                "embedding_text": chunk.text,
                "source": chunk.source,
                "metadata": dict(chunk.metadata or {}),
                "doc_id": chunk.doc_id,
            }
            for chunk in chunks
            if chunk.source not in SEED_SOURCES
        ]

    async def _preserved_resolved_case_items(
        self, chunks: list[StoredChunk]
    ) -> list[dict[str, Any]]:
        """Carry EXISTING precedent through a vector-space migration.

        ``_reseed`` physically replaces the vector space, and the precedent it can
        re-derive from the CaseStore is only the bounded window. Carrying the stored
        precedent chunks keeps everything older than that window alive; the freshly
        derived window wins on doc-id collision so the canonical text is still the
        shared builder's.

        This path never consulted the per-case projector at all, which left it as a
        SECOND producer of durable precedent text that could only ever reproduce
        whatever generation of the builder happened to write the chunk. An out-of-window
        chunk therefore carried its stale rendering through every future migration, and
        no amount of repairing the corpus could reach it. It now routes through the SAME
        derive-and-compare the explicit repair uses and falls back to the STORED chunk
        — its text AND its metadata, together, never a half-derived mix of the two —
        only when the case is unavailable (unreadable, gone, or no longer projecting),
        because a migration must never drop a chunk it cannot re-derive.

        It also needs its own exclusion check: without one, the first embedding-model
        change a deployment ever makes would resurrect every operator exclusion at once,
        silently, in the single code path that carries precedent the bounded window can
        no longer reach. It is an instance method for exactly that reason — the
        predicate, and now the projector, live on the service.
        """
        out: list[dict[str, Any]] = []
        derived: dict[tuple[str, str], dict[str, Any] | None] = {}
        for chunk in chunks:
            if chunk.source != RESOLVED_CASE_SOURCE:
                continue
            doc_id = str(chunk.doc_id or "")
            metadata = dict(chunk.metadata or {})
            case_id = str(metadata.get("case_id") or "")
            if self._is_case_excluded(case_id):
                continue
            document_id = str(metadata.get("document_id") or "")
            if not document_id:
                if doc_id.startswith(f"{RESOLVED_CASE_SOURCE}:"):
                    document_id = doc_id
                elif case_id:
                    document_id = f"{RESOLVED_CASE_SOURCE}:{case_id}"
                else:
                    continue
            metadata["document_id"] = document_id
            text = chunk.text
            if case_id:
                tier = (
                    TRUST_MODEL_UNCONFIRMED
                    if self._is_unconfirmed(chunk)
                    else TRUST_ANALYST_CONFIRMED
                )
                key = (case_id, tier)
                if key not in derived:
                    derived[key] = await self._current_precedent_projection(
                        case_id, tier, metadata
                    )
                current = derived[key]
                current_text = str((current or {}).get("text") or "")
                if current is not None and current_text:
                    # TEXT AND METADATA MOVE TOGETHER, exactly as the explicit repair
                    # moves them. Adopting the fresh sentence while keeping the stored
                    # ``verdict``/``outcome``/``status``/``note``/``rule_identity``/
                    # ``trust_class`` would leave a HALF-repaired chunk — and the
                    # repair's selector compares TEXT, so that chunk would then read as
                    # CURRENT and its stale metadata would be permanently unreachable by
                    # the one pass built to find drift. Two of those keys steer
                    # retrieval, so the mismatch is not cosmetic.
                    #
                    # The merge direction mirrors the repair's: STORED keys neither
                    # projector mints are carried forward (the bulk-ratification stamp
                    # is written by the bootstrap indexer alone, and it is what keeps a
                    # ratified MODEL verdict distinguishable from independent analyst
                    # ground truth — and it is a selectable exclusion key, so dropping
                    # it would silently stop an operator's saved selection matching),
                    # and the projector wins on collision. ``document_id`` is re-pinned
                    # afterwards because the stored chunk's document identity is the one
                    # this migration must preserve.
                    text = current_text
                    metadata = {**metadata, **dict(current.get("metadata") or {})}
                    metadata["document_id"] = document_id
            out.append(
                {
                    "text": text,
                    "embedding_text": text,
                    "source": chunk.source,
                    "metadata": metadata,
                    "doc_id": doc_id or document_id,
                }
            )
        return out

    def _guard_projection_collapse(
        self,
        outgoing: dict[str, int] | None,
        chunks: list[StoredChunk],
        *,
        scope: frozenset[str] | None = None,
    ) -> None:
        """Refuse a projection that collapsed or shrank past the configured floor.

        A projection is a rebuild of a source of truth that has NOT shrunk. So a
        rebuild that yields zero documents while the previous corpus held thousands
        is never a legitimately smaller corpus — it is a failed build (a provider
        outage, an unreadable store, a load error). Publishing it destroys the corpus
        and, because the stale sweep runs immediately afterwards, does so
        irreversibly.

        Raising here is deliberate and load-bearing: every caller stages the new
        projection BEFORE any old document is removed, so an exception at this point
        leaves the previous corpus completely intact. That is the whole
        "keep the previous corpus and raise" requirement.

        **KNOW WHAT THIS GUARD DOES NOT DO.** It is a SIZE guard and nothing else. A
        reprojection that keeps the chunk count identical and flips every verdict, or
        replaces a balanced corpus with a unanimous one, passes it completely cleanly —
        composition is not a dimension it can see. :meth:`corpus_composition` is what
        answers that question, and it must be read separately; a clean pass here is not
        evidence that the corpus is healthy.

        **REFUSALS ARE CLASSIFIED.** Every refusal used to reach the job surface and the
        health record as one undifferentiated failure, which flattens two categorically
        different events. The worst case is the repair itself: an operator who narrows
        ``precedent.window.size`` to drop a poisoned tail is DELIBERATELY shrinking the
        projection, and that trips the ratio floor and reports as a generic collapse — so
        the product tells the operator their repair failed. ``reason_code`` names that
        case (``window_size_reduction``) distinctly. The ZERO-PROJECTION refusal is
        unaffected and stays UNCONDITIONAL AND UNTUNABLE: no configuration, and no
        attribution, may ever let an empty rebuild replace a live corpus.
        """
        if outgoing is None:
            # The previous corpus could not be READ, so "did this shrink?" is
            # unanswerable. Fail SAFE rather than open: allow a projection that
            # produced content (it cannot be a collapse), and refuse only the
            # empty one, whose safety we cannot establish.
            if not chunks:
                raise ProjectionCollapsed(
                    "RAG projection produced 0 chunk(s) and the previous corpus could "
                    "not be read to prove the replacement is safe; refusing. The "
                    "existing corpus is left intact.",
                    reason_code=REFUSAL_EMPTY_UNVERIFIABLE,
                )
            return
        # Compare LIKE WITH LIKE — on BOTH sides.
        #
        # ``chunks`` is the new projection; ``outgoing`` counts every stored chunk,
        # including operator imports and threat-context documents that this projection
        # never rebuilds and never sweeps. Comparing those two populations refused an
        # ordinary reseed on any deployment whose imported library outnumbered its seed
        # corpus — a safety guard turning itself into an outage. ``scope`` names the
        # sources this projection is responsible for, and BOTH sides are restricted to
        # it before any comparison.
        # A source the operator just DISABLED is EXPECTED to project to zero, so its
        # existing chunks must not count as something the rebuild "lost" — otherwise
        # turning a knowledge source off refuses every subsequent projection forever
        # AND strands that source's chunks in the corpus, because the sweep that would
        # remove them never runs. This is the same distinction
        # ``_record_projection_outcome`` already makes before warning.
        incoming_by_source = Counter(str(chunk.source or "unknown") for chunk in chunks)
        if scope is None:
            relevant = {
                name: count
                for name, count in outgoing.items()
                if self._source_enabled(name)
            }
            incoming_total = len(chunks)
        else:
            relevant = {
                name: count
                for name, count in outgoing.items()
                if name in scope and self._source_enabled(name)
            }
            incoming_total = sum(
                count for name, count in incoming_by_source.items() if name in scope
            )
        outgoing_total = sum(int(v or 0) for v in relevant.values())
        if outgoing_total <= 0:
            # Nothing to lose: a first seed (or a genuinely empty corpus) proceeds.
            return
        if incoming_total == 0:
            # UNCONDITIONAL AND UNTUNABLE. No attribution branch runs before this, and
            # none may ever be added: an empty rebuild replacing a live corpus is never
            # legitimate, however deliberate the configuration change behind it was.
            raise ProjectionCollapsed(
                "RAG projection produced 0 chunk(s) while the previous corpus held "
                f"{outgoing_total}; refusing to replace a live corpus with an empty "
                "one. The existing corpus is left intact.",
                reason_code=REFUSAL_EMPTY_PROJECTION,
            )
        retention = float(getattr(self._prefs.rag, "min_projection_retention", 0.0) or 0.0)
        if retention > 0.0 and incoming_total < outgoing_total * retention:
            attributed = self._window_reduction_attribution(
                relevant, incoming_by_source, scope=scope
            )
            if attributed:
                raise ProjectionCollapsed(
                    f"RAG projection SHRANK from {outgoing_total} to {incoming_total} "
                    f"chunk(s), below the configured retention floor ({retention:.0%}); "
                    "refusing the rebuild and keeping the existing corpus. This shrink "
                    f"is ATTRIBUTABLE to a deliberate reduction of the precedent window: "
                    f"{attributed}. Nothing was lost — the previous corpus is intact — "
                    "but the narrower window cannot be applied while the retention floor "
                    "stands. Lower rag.min_projection_retention (or set it to 0) to let "
                    "the intended reduction through; a projection reaching ZERO is still "
                    "refused regardless.",
                    reason_code=REFUSAL_WINDOW_REDUCTION,
                )
            raise ProjectionCollapsed(
                f"RAG projection SHRANK from {outgoing_total} to {incoming_total} "
                f"chunk(s), below the configured retention floor "
                f"({retention:.0%}); refusing the rebuild and keeping the existing "
                "corpus. Raise rag.min_projection_retention if this shrink is intended.",
                reason_code=REFUSAL_RETENTION_FLOOR,
            )

    def _window_reduction_attribution(
        self,
        relevant: dict[str, int],
        incoming_by_source: "Counter[str]",
        *,
        scope: frozenset[str] | None,
    ) -> str:
        """Explain a ratio refusal as an operator window reduction, or return ``""``.

        The attribution is deliberately CONSERVATIVE, because a wrong one turns a real
        corpus loss into a reassuring message. All three must hold:

        1. the precedent source is in the compared scope at all (with the default
           ``ensure_seeded`` scope it is not, so this never fires there);
        2. NO other source shrank — a genuine build failure takes runbooks and ATT&CK
           down with it, and a window change cannot touch them; and
        3. the new precedent count is bounded by the configured window while the previous
           one exceeded it, i.e. the drop is arithmetically EXPLAINED by the window bound
           rather than merely coincident with it.

        Returns the operator-facing explanation, or ``""`` when the shrink cannot be
        attributed — in which case the caller reports the ordinary retention refusal.
        """
        if scope is not None and RESOLVED_CASE_SOURCE not in scope:
            return ""
        before = int(relevant.get(RESOLVED_CASE_SOURCE, 0))
        after = int(incoming_by_source.get(RESOLVED_CASE_SOURCE, 0))
        if before <= 0 or after <= 0 or after >= before:
            return ""
        for name, previous in relevant.items():
            if name == RESOLVED_CASE_SOURCE:
                continue
            if int(incoming_by_source.get(name, 0)) < int(previous or 0):
                return ""  # something else shrank too — this is not a window change
        size = int(self._window_config().size)
        if not (after <= size < before):
            return ""
        return (
            f"the precedent source went from {before} to {after} chunk(s) against a "
            f"configured window of {size}, and no other knowledge source shrank"
        )

    async def _chunk_counts_by_source(self) -> dict[str, int] | None:
        """Stored chunk count per source, or ``None`` when the store cannot be read.

        ``None`` and ``{}`` mean very different things and must never be conflated:
        an EMPTY corpus is a real, trustworthy zero, while an UNREADABLE one is an
        unknown. Returning ``{}`` for both previously disabled the collapse guard in
        exactly the failure mode it exists for, and let a transient stats() error
        publish "the corpus is empty" on the public health endpoint.
        """
        try:
            stats = await self._store.stats()
            return {
                str(source): int(count or 0)
                for source, count in dict(stats.get("by_source") or {}).items()
            }
        except Exception as exc:  # noqa: BLE001 — observability must never break seeding
            logger.warning("Reading RAG source counts failed: %s", exc)
            return None

    def _record_projection_outcome(
        self, outgoing: dict[str, int] | None, incoming: dict[str, int] | None
    ) -> None:
        """Compare the OUTGOING corpus with the INCOMING one, per source.

        A re-seed must never silently shrink a source. ``RAG seeded with N chunk(s)``
        reads like an ordinary startup line even when N collapsed from ~2000 to 0, so
        an actual corpus wipe left no distinguishable trace. Any decrease for a source
        that is still ENABLED is logged at WARNING with both counts, and the full
        per-source outcome is published on ``self.last_projection`` so a health
        endpoint can surface it without re-deriving anything. A source the operator
        just disabled is expected to go to zero, so it is recorded but not warned on.
        """
        at = iso_now()
        outcome: dict[str, dict[str, Any]] = {}
        if incoming is None:
            # The post-projection read failed. The projection itself SUCCEEDED, so the
            # corpus is not empty — publishing a zeroed outcome here would manufacture
            # exactly the false collapse signal this record exists to make trustworthy.
            logger.warning(
                "RAG projection succeeded but its outcome could not be read; leaving "
                "the previous projection record in place"
            )
            self.last_refusal = None
            return
        known_outgoing = outgoing or {}
        for source in sorted(set(known_outgoing) | set(incoming)):
            before = int(known_outgoing.get(source, 0))
            after = int(incoming.get(source, 0))
            enabled = self._source_enabled(source)
            outcome[source] = {
                "source": source,
                "before": before,
                "after": after,
                "delta": after - before,
                "shrank": after < before,
                "collapsed": before > 0 and after == 0,
                "source_enabled": enabled,
                "at": at,
            }
            if after < before and enabled:
                logger.warning(
                    "RAG projection SHRANK an enabled source: %s %d -> %d chunk(s) "
                    "(delta %+d)%s",
                    source,
                    before,
                    after,
                    after - before,
                    " — the source COLLAPSED to zero" if after == 0 else "",
                )
        self.last_projection = outcome
        # A projection completed, so any standing refusal is resolved.
        self.last_refusal = None
        self.corpus_known_empty = sum(int(v or 0) for v in incoming.values()) == 0
        # A projection just RAN. If it produced nothing while sources are enabled,
        # the corpus is empty for a reason that is not configuration.
        self.corpus_degraded = bool(
            self.corpus_known_empty and self._any_source_enabled()
        )

    async def _persist_projection_health(self) -> None:
        """Persist the just-recorded successful projection. Fail-open."""
        if self._health is None:
            return
        try:
            await self._health.record_projection(dict(self.last_projection))
        except Exception as exc:  # noqa: BLE001 — never fail a good projection
            logger.warning("RAG health record could not be persisted: %s", exc)

    async def _record_projection_refusal(
        self,
        outgoing: dict[str, int] | None,
        reason: str,
        *,
        collapsed: bool = True,
        reason_code: str = "",
    ) -> None:
        """Publish + persist a projection that did NOT happen.

        ``_record_projection_outcome`` only ever ran on the SUCCESS paths, so the one
        outcome that actually matters — the rebuild that was refused, or failed —
        left no structured record at all. Fail-open: recording a refusal must never
        turn into a second failure.
        """
        record = {
            "reason": str(reason)[:500],
            "collapsed": bool(collapsed),
            "outgoing_total": sum(int(v or 0) for v in (outgoing or {}).values()),
            "at": iso_now(),
            # The closed refusal vocabulary. In-process only: the durable record keeps
            # the reason TEXT (which already names an attributed window reduction in
            # full), so persisting the code as well would need a store schema change for
            # information the message already carries.
            "reason_code": str(reason_code or ""),
        }
        self.last_refusal = record
        if self._health is None:
            return
        try:
            await self._health.record_refusal(
                reason=record["reason"],
                collapsed=record["collapsed"],
                outgoing_total=record["outgoing_total"],
            )
        except Exception as exc:  # noqa: BLE001 — never mask the original failure
            logger.warning("RAG health refusal could not be persisted: %s", exc)

    async def _reconcile_legacy_resolved_case_documents(self) -> int:
        """One-time, tolerant migration of pre-fix incrementally indexed precedent.

        Before the per-case document identity fix, ``index_resolved_case`` wrote its
        chunk with a stable ``doc_id`` but no ``metadata.document_id``, so the vector
        store grouped EVERY feedback-indexed precedent under the single synthetic
        ``seed:resolved_case`` document. Re-tag those chunks in place: the doc id is
        unchanged, so the store upserts (no duplicate, no re-embedding, no extra
        gateway spend), and each case converges on its own
        ``resolved_case:{case_id}`` document exactly like a freshly indexed one.

        Chunks whose per-case identity cannot be derived are LEFT ALONE rather than
        dropped — they stay visible and retrievable under the legacy grouping, and
        the stale sweep no longer touches ``resolved_case`` at all, so nothing is
        orphaned. Idempotent: after migration the legacy grouping is empty.
        """
        try:
            legacy = await self._store.list_chunks(_LEGACY_RESOLVED_CASE_DOCUMENT)
        except Exception as exc:  # noqa: BLE001 — migration is best-effort
            logger.warning("Legacy resolved_case reconciliation could not read: %s", exc)
            return 0
        upgraded: list[StoredChunk] = []
        for chunk in legacy:
            if chunk.source != RESOLVED_CASE_SOURCE:
                continue
            metadata = dict(chunk.metadata or {})
            doc_id = str(chunk.doc_id or "")
            case_id = str(metadata.get("case_id") or "")
            # An excluded case is re-tagged like any other, ON PURPOSE. Converging the
            # chunk onto ``resolved_case:{case_id}`` cannot resurrect anything — this
            # migration only RE-TAGS chunks that already exist and never creates one,
            # and every producer (``_resolved_case_item``, ``_unconfirmed_candidate``,
            # ``_preserved_resolved_case_items``, ``index_precedent_items`` and the rule-
            # identity reconciliation) filters excluded cases itself. What it DOES do is
            # give the exclusion's delete the only handle it has: a chunk left under the
            # pre-fix shared ``seed:resolved_case`` grouping is addressable by no
            # per-case document id, so skipping it here made the exclusion a permanent
            # no-op that reported success while the precedent kept reaching prompts.
            if doc_id.startswith(f"{RESOLVED_CASE_SOURCE}:"):
                document_id = doc_id
            elif case_id:
                document_id = f"{RESOLVED_CASE_SOURCE}:{case_id}"
            else:
                continue
            metadata["document_id"] = document_id
            upgraded.append(dataclass_replace(chunk, metadata=metadata))
        if not upgraded:
            return 0
        try:
            await self._store.add(upgraded)
        except Exception as exc:  # noqa: BLE001 — never block seeding on a migration
            logger.warning("Legacy resolved_case reconciliation could not write: %s", exc)
            return 0
        logger.info(
            "Reconciled %d legacy resolved_case chunk(s) into per-case documents",
            len(upgraded),
        )
        return len(upgraded)

    async def ensure_seeded(self) -> None:
        """Idempotently embed and store the enabled sources. Fails closed.

        Includes resolved-case memory when ``prefs.rag.use_resolved_cases``."""
        async with self._seed_lock:
            signature = self._source_signature()
            if self._seeded and self._seed_signature == signature:
                return
            # ``None`` means the previous corpus could not be READ (distinct from an
            # empty one); the guard fails safe on that rather than silently switching
            # itself off.
            outgoing: dict[str, int] | None = None
            try:
                # Refresh the operator exclusion set FIRST, inside the lock, so every
                # producer below runs the predicate against the current set without any
                # of them doing I/O. A read failure on a process that has held the set
                # keeps the last known-good copy; a set this process has NEVER held is
                # UNKNOWN, and raising here lands in the handler below that preserves the
                # existing corpus instead of re-deriving excluded precedent into it.
                await self._require_exclusions(force=True)
                outgoing = await self._chunk_counts_by_source()
                # Converge any pre-fix precedent onto per-case document identity
                # before the projection reads/writes documents.
                await self._reconcile_legacy_resolved_case_documents()
                # Stamp rule identity onto precedent projected before it was metadata,
                # so an EXISTING corpus becomes rule-matchable without a re-embed.
                if self._prefs.rag.use_resolved_cases:
                    await self._reconcile_precedent_rule_identity()
                # Stage and validate the complete managed projection before ANY
                # old document is removed. This preserves the last known-good
                # corpus when loading, embedding, or persistence fails.
                seeds = await self._enabled_seeds()
                if self._prefs.rag.use_resolved_cases:
                    seeds.extend(await self._resolved_case_items())
                    seeds.extend(await self._unconfirmed_precedent_addition(seeds))
                managed = self._managed_items(seeds)
                chunks = await self._embed_items(managed)
                # REFUSE a collapsed/shrunken rebuild BEFORE anything is written and,
                # critically, before the stale sweep below deletes the documents this
                # projection was supposed to replace.
                #
                # Scoped to MANAGED_PROJECTION_SOURCES: those are the sources this
                # projection actually rebuilds, and (for the fully reconciled ones) the
                # only sources ``_drop_stale_managed_projection`` can delete. Operator
                # imports and threat-context documents are neither rebuilt nor swept
                # here, so counting them would compare two different populations.
                self._guard_projection_collapse(
                    outgoing, chunks, scope=MANAGED_PROJECTION_SOURCES
                )
                if chunks:
                    await self._store.add(chunks)
                expected = await self._verify_projection(chunks)
                await self._drop_stale_managed_projection(expected)
                if self._runbooks is not None:
                    for record in await self._runbooks.list():
                        await self._runbooks.mark_indexed(record.runbook.id, record.revision)
                self._seeded = True
                self._seed_signature = signature
                self.invalidate_precedent_distribution()
                logger.info("RAG seeded with %d chunk(s)", len(chunks))
                self._record_projection_outcome(
                    outgoing, await self._chunk_counts_by_source()
                )
                await self._persist_projection_health()
            except ProjectionCollapsed as exc:
                # The corpus-destroying outcome. Loud (ERROR), and recorded as a
                # durable health state so it survives the restart that erased the
                # evidence both times this happened.
                self._seeded = False
                self._seed_signature = None
                logger.error(
                    "RAG projection REFUSED (%s) — the existing corpus was preserved: %s",
                    getattr(exc, "reason_code", REFUSAL_EMPTY_PROJECTION),
                    exc,
                )
                await self._record_projection_refusal(
                    outgoing,
                    str(exc),
                    reason_code=getattr(exc, "reason_code", REFUSAL_EMPTY_PROJECTION),
                )
            except Exception as exc:  # noqa: BLE001
                self._seeded = False
                self._seed_signature = None
                logger.warning("RAG seeding failed; store left as-is: %s", exc)
                await self._record_projection_refusal(outgoing, str(exc), collapsed=False)

    async def refresh_corpus_health(self) -> bool | None:
        """Read the corpus size WITHOUT seeding and publish the emptiness flag.

        Called at startup so a deployment that comes back up with a lost corpus
        reports degraded immediately, instead of waiting for the first investigation
        to discover it. Seed-free and fail-open by construction: it must never
        trigger an embedding spend, and an unreadable store leaves the flag untouched
        (unknown is not a degradation).

        Returns the emptiness verdict, or ``None`` when the store could not be read.
        """
        try:
            count = int(await self._store.count())
        except Exception as exc:  # noqa: BLE001 — a probe never breaks startup
            logger.warning("RAG corpus health probe could not read the store: %s", exc)
            return None
        self.corpus_known_empty = count == 0
        if count > 0:
            self.corpus_degraded = False
            return False
        # Empty. Distinguish "never seeded yet" (a cold start — expected) from
        # "we HAD a corpus and it is gone" (the incident). The durable projection
        # record is what makes that distinction survive the restart.
        previously_projected = False
        if self._health is not None:
            try:
                doc = await self._health.load()
                previously_projected = bool((doc or {}).get("healthy_at"))
            except Exception as exc:  # noqa: BLE001
                logger.warning("RAG health record unreadable during probe: %s", exc)
        self.corpus_degraded = bool(
            (previously_projected or self._seeded) and self._any_source_enabled()
        )
        if self.corpus_degraded:
            logger.error(
                "RAG corpus is EMPTY at startup although it was previously projected: "
                "every investigation will run with no runbook, ATT&CK or precedent "
                "context until it is rebuilt"
            )
        return self.corpus_known_empty

    def _any_source_enabled(self) -> bool:
        """Whether retrieval is on AND at least one knowledge source is enabled.

        An operator who turned every source off has an empty corpus on purpose; that
        is configuration, not a fault, and must never raise a health alarm.
        """
        cfg = self._prefs.rag
        if not bool(getattr(cfg, "enabled", False)):
            return False
        return any(
            bool(getattr(cfg, name, False))
            for name in (
                "use_runbooks",
                "use_mitre",
                "use_suppression_rules",
                "use_resolved_cases",
                "use_threat_context",
            )
        )

    async def rebuild_corpus(self, *, dry_run: bool = False) -> dict[str, Any]:
        """Explicitly rebuild the whole knowledge projection. Idempotent.

        ``dry_run=True`` embeds nothing, writes nothing and mutates nothing: it returns
        the :meth:`corpus_composition` report — the corpus as it stands beside the one a
        rebuild WOULD produce — under a ``composition`` key, with ``dry_run: true`` and
        every count field left at its pre-rebuild value. Default ``False``, so an
        existing caller's behaviour is byte-identical.

        Read the composition BEFORE rebuilding, because **a successful rebuild is not
        evidence of repair**. The projection pages the case store newest-first, so if a
        bulk confirmation put a skewed run at the head of the qualifying population, a
        rebuild re-selects it and converges on the same skew it just replaced. The
        composition report shows the qualifying POOL beside the selected window, and the
        joint outcome-by-verdict distribution rather than outcome alone, precisely so
        that "the rebuild succeeded" cannot be mistaken for "the corpus is now healthy".

        The recovery gap this closes: ``ensure_seeded`` is lazy AND signature-cached,
        so once it has run it considers itself done regardless of what the corpus
        actually holds. After the incident's provider outage cleared, the corpus did
        NOT come back — recovery took a container recreate plus a manual investigation
        to trigger the lazy path. There was no supported "rebuild the corpus" action at
        all: the only trigger was poking a private attribute, which only tests did.

        Safe to call repeatedly and safe to call on a healthy deployment: it reuses the
        SAME staged-then-verified projection path as ordinary seeding, so the existing
        corpus is preserved if the rebuild cannot complete (and is refused outright if
        it would collapse). Stable document ids mean a successful rebuild converges on
        the identical corpus rather than duplicating it.

        Returns a JSON-safe summary: the chunk count before and after, whether the
        projection was refused, and the per-source outcome.
        """
        before = await self._store.count()
        if dry_run:
            # Nothing is invalidated, nothing is seeded, nothing is written. The
            # composition report is derived from a management read plus the ordinary
            # per-case projector, so this branch cannot reach the embedding gateway.
            return {
                "dry_run": True,
                "chunks_before": int(before),
                "chunks_after": int(before),
                "rebuilt": False,
                "refused": False,
                "refusal_reason": "",
                "refusal_code": "",
                "by_source": {},
                "composition": await self.corpus_composition(),
                "at": iso_now(),
            }
        # Reset the cache OUTSIDE the seed lock: ``_seed_lock`` is a plain,
        # non-reentrant asyncio.Lock that ``ensure_seeded`` acquires itself.
        self._seeded = False
        self._seed_signature = None
        await self.ensure_seeded()
        after = await self._store.count()
        self.corpus_known_empty = int(after) == 0
        self.corpus_degraded = bool(self.corpus_known_empty and self._any_source_enabled())
        refusal = self.last_refusal
        return {
            "dry_run": False,
            "chunks_before": int(before),
            "chunks_after": int(after),
            "rebuilt": bool(self._seeded),
            "refused": refusal is not None,
            "refusal_reason": str((refusal or {}).get("reason") or ""),
            # The CLOSED refusal vocabulary, so a deliberate operator-initiated window
            # narrowing is distinguishable from a corpus-destroying build failure.
            "refusal_code": str((refusal or {}).get("reason_code") or ""),
            "by_source": {
                name: {"before": row.get("before"), "after": row.get("after")}
                for name, row in dict(self.last_projection).items()
            },
            "at": iso_now(),
        }

    async def reindex_runbooks(self, ids: set[str] | None = None) -> dict[str, Any]:
        """Reconcile only the runbook projection, preserving every other source.

        The authoritative Markdown remains in the bundled catalog/KV store even if
        embedding fails. Stable per-runbook document/chunk ids make retries safe.
        """
        if self._runbooks is None:
            return {
                "ok": False,
                "indexed": 0,
                "deleted": 0,
                "failed": 1,
                "errors": ["runbook catalog is unavailable"],
            }
        cfg = self._prefs.rag
        runbook_cfg = getattr(self._prefs, "runbooks", None)
        if not (cfg.enabled and cfg.use_runbooks and (runbook_cfg is None or runbook_cfg.enabled)):
            return {
                "ok": True,
                "indexed": 0,
                "deleted": 0,
                "failed": 0,
                "errors": [],
                "disabled": True,
            }
        async with self._seed_lock:
            records = await self._runbooks.list()
            active = {record.runbook.id: record for record in records}
            requested = set(ids) if ids is not None else set(active)
            pending = set(await self._runbooks.pending_deletes())
            missing = sorted(
                runbook_id
                for runbook_id in requested
                if runbook_id not in active and runbook_id not in pending
            )
            target_ids = requested | (pending if ids is None else pending & requested)
            deleted = 0
            errors: list[str] = []
            try:
                documents = await self._store.list_documents()
                selected = set(active) if ids is None else requested & set(active)
                items = self._managed_items(await self._runbooks.corpus_items(selected))
                chunks = await self._embed_items(items)
                if chunks:
                    await self._store.add(chunks)
                expected_selected = await self._verify_projection(chunks)

                # Only remove stale/withdrawn runbook documents after every selected
                # replacement has been written and read back successfully.
                for document in documents:
                    if document.get("source") != "runbook":
                        continue
                    document_id = str(document.get("document_id") or "")
                    should_remove = (
                        document_id == "seed:runbook"
                        or document_id in {f"runbook:{rid}" for rid in pending & target_ids}
                        or (ids is None and document_id not in expected_selected)
                    )
                    if should_remove and document_id:
                        deleted += await self._store.delete_document(document_id)

                indexed = len(chunks)
                for runbook_id in sorted(selected):
                    record = active[runbook_id]
                    await self._runbooks.mark_indexed(runbook_id, record.revision)
                for runbook_id in sorted(pending & target_ids):
                    await self._runbooks.mark_delete_projected(runbook_id)
                if missing:
                    errors.extend(f"runbook {runbook_id} not found" for runbook_id in missing)
                return {
                    "ok": not errors,
                    "indexed": indexed,
                    "deleted": deleted,
                    "failed": len(errors),
                    "errors": errors,
                }
            except Exception as exc:  # noqa: BLE001
                message = "runbook retrieval indexing failed"
                logger.warning("%s: %s", message, exc)
                selected = set(active) if ids is None else requested & set(active)
                for runbook_id in sorted(selected):
                    record = active[runbook_id]
                    try:
                        await self._runbooks.mark_indexed(
                            runbook_id, record.revision, error=message
                        )
                    except Exception:  # noqa: BLE001 — preserve the original error
                        pass
                return {
                    "ok": False,
                    "indexed": 0,
                    "deleted": deleted,
                    "failed": max(1, len(selected)),
                    "errors": [message],
                }

    async def runbook_projection_revisions(self) -> dict[str, int]:
        """Active ``runbook id -> indexed revision`` projection, without seeding."""
        out: dict[str, int] = {}
        try:
            for document in await self._store.list_documents():
                document_id = str(document.get("document_id") or "")
                if document.get("source") != "runbook" or not document_id.startswith("runbook:"):
                    continue
                runbook_id = document_id.removeprefix("runbook:")
                chunks = await self._store.list_chunks(document_id)
                revision = max(
                    (int((chunk.metadata or {}).get("revision", 0) or 0) for chunk in chunks),
                    default=0,
                )
                if runbook_id and revision:
                    out[runbook_id] = revision
        except Exception as exc:  # noqa: BLE001
            logger.warning("Reading runbook projection status failed: %s", exc)
        return out

    @staticmethod
    def _case_analyst_note(case: "Case", ground_truth_source: str | None = None) -> str:
        """Recover the durable analyst note already stored on the case.

        Both writers persist the note on the case BEFORE indexing: a close /
        confirm-FP appends ``{"event": "analyst_action", ..., "note": ...}`` to
        ``case.history``, and grading appends ``FeedbackEntry.comment``. Reading it
        back from the case is what lets the BULK projection reproduce exactly the
        same chunk the incremental path wrote, instead of the two paths disagreeing
        about the same case.
        """
        def _from_feedback() -> str:
            for entry in reversed(list(case.feedback or [])):
                comment = str(getattr(entry, "comment", "") or "").strip()
                if comment:
                    return comment
            return ""

        if ground_truth_source == "analyst_feedback":
            comment = _from_feedback()
            if comment:
                return comment
        for entry in reversed(list(case.history or [])):
            if isinstance(entry, dict) and entry.get("event") == "analyst_action":
                note = str(entry.get("note") or "").strip()
                if note:
                    return note
        return _from_feedback()

    @staticmethod
    def _resolved_case_text(case: "Case", outcome: str, note: str) -> str:
        """The ONE precedent-chunk representation, shared by BOTH indexing paths.

        The bulk projection and the incremental close/feedback path both upsert the
        same deterministic ``resolved_case:{case_id}`` doc id, so whichever ran last
        used to win — and they emitted DIFFERENT text (the bulk path carried evidence
        + recommended action; the incremental path carried risk + trigger + note).
        Two identical deployments therefore accumulated materially different
        precedent, which is the control input for auto-close comparisons.

        This builder is the SUPERSET of both: the analyst-confirmed outcome, the
        bounded/flattened analyst note, the case reference, entity, rules, risk, the
        trigger sentence, the top-3 evidence summaries and the recommended action.
        ``note`` is expected to have already passed through
        :func:`_flatten_analyst_note`.

        The MODEL'S OWN VERDICT IS DELIBERATELY ABSENT from this text. It used to be
        the second clause of a sentence whose first clause claims analyst provenance,
        rendered under a heading that claims it again — so the agent read its own
        earlier escalations back as if an analyst had confirmed them. It remains in
        ``metadata['verdict']``, which is where every legitimate consumer already
        reads it, and (because the BM25 tokeniser indexes the metadata alongside the
        text) it stays lexically matchable for retrieval.

        Field order and membership are owned by
        ``_PRECEDENT_CONFIRMED_TEXT_FIELDS``: human-provenance fields lead, so
        ``agents.prompts.fence``'s 600-character truncation can only ever eat
        machine-derived context. The case id is machine-derived and VARIABLE-LENGTH,
        so it renders as ``case_ref`` AFTER the human block rather than prefixing it:
        prefixing made the "a maximum-length note always fits" guarantee depend on the
        id's length, and at the 37-character ids ``new_id("case-")`` actually mints the
        block ran to 611 characters and the analyst's own words were cut again.
        """
        return _render_precedent_text(
            _PRECEDENT_CONFIRMED_TEXT_FIELDS,
            {
                "outcome": f"Analyst-confirmed outcome {outcome}.",
                "analyst_note": f"Analyst note: {note or 'n/a'}.",
                "case_ref": f"Resolved case {case.case_id}.",
                **_case_context_text_values(case),
            },
        )

    def _resolved_case_item(
        self, case: "Case", note: str | None = None
    ) -> dict[str, Any] | None:
        """Project ONE case into its precedent item, or ``None`` when it is not
        analyst-confirmed ground truth.

        The single per-case projection used by both the bulk window and the
        incremental close/feedback path, so the stored text + metadata cannot drift
        between them. ``doc_id`` stays the durable
        ``resolved_case:{case_id}`` storage identity across all three vector-store
        backends, and ``metadata.document_id`` mirrors it so one case is one
        document (never a shared, single-delete blob).

        Returns ``None`` for an operator-EXCLUDED case as well. Because this projection
        is SHARED, that one check covers BOTH the bounded window and the incremental
        close-time indexing path — which is the documented side effect of excluding a
        case: closing (or re-closing) it no longer re-indexes it either.
        """
        if self._is_case_excluded(getattr(case, "case_id", "")):
            return None
        outcome, ground_truth_source = analyst_confirmed_outcome(case)
        if outcome is None:
            return None
        supplied = str(note or "").strip()
        resolved_note = _flatten_analyst_note(
            supplied or self._case_analyst_note(case, ground_truth_source)
        )
        document_id = f"{RESOLVED_CASE_SOURCE}:{case.case_id}"
        identity = case_rule_identity(case)
        return {
            "text": self._resolved_case_text(case, outcome, resolved_note),
            "source": RESOLVED_CASE_SOURCE,
            "doc_id": document_id,
            "metadata": {
                "case_id": case.case_id,
                "verdict": case.verdict.value if case.verdict else "n/a",
                "outcome": outcome,
                "entity": f"{case.entity.type.value}:{case.entity.value}",
                "status": case.status.value if case.status else "",
                "note": resolved_note,
                "ground_truth_source": ground_truth_source,
                "trust_class": TRUST_ANALYST_CONFIRMED,
                "document_id": document_id,
                # Rule identity as MATCHABLE metadata, not just a substring of the text.
                # Precedent is promoted on rule identity, never on embedding similarity
                # alone — a perfect-score hit from a DIFFERENT rule must not qualify —
                # and that comparison has to read a canonical key rather than parse
                # prose. Blank when the case carries no rule ids (never matches).
                RULE_IDENTITY_KEY: identity,
                RULE_IDS_KEY: list(rule_identity_members(identity)),
            },
        }

    # ------------------------------------------------------------------ #
    # The LOWER-TRUST ``model_unconfirmed`` precedent tier.
    # ------------------------------------------------------------------ #
    @staticmethod
    def _unconfirmed_outcome(case: "Case") -> str | None:
        """The MODEL's own binary judgement, or ``None`` when it did not make one.

        ``NEEDS_HUMAN`` is deliberately excluded: it is the absence of a judgement,
        so it carries no precedent value and must never look like one."""
        verdict = getattr(case.verdict, "value", case.verdict)
        if verdict == Verdict.FALSE_POSITIVE.value:
            return "false_positive"
        if verdict == Verdict.TRUE_POSITIVE.value:
            return "true_positive"
        return None

    @staticmethod
    def _recurrence_key(case: "Case", outcome: str) -> str:
        """The pattern a recurrence count is taken over.

        Entity TYPE + the rule set + the outcome, NOT the entity VALUE: the useful
        generalisation is "this detection pattern keeps resolving the same way", and a
        per-value key would essentially never reach a recurrence threshold on the
        rotating IPs an autonomous deployment actually sees."""
        rules = "|".join(sorted(str(r) for r in (case.rule_ids or [])))
        entity_type = getattr(case.entity.type, "value", case.entity.type)
        return f"{entity_type}|{rules}|{outcome}"

    @staticmethod
    def _terminal_at(case: "Case") -> str:
        """Best-effort instant the case became terminal (for the age-out guard)."""
        for entry in reversed(list(case.status_history or [])):
            if str(getattr(entry, "to_status", "") or "") in (
                CaseStatus.CLOSED.value,
                CaseStatus.RESOLVED.value,
            ):
                at = str(getattr(entry, "at", "") or "")
                if at:
                    return at
        return str(case.updated_at or case.created_at or "")

    @staticmethod
    def _unconfirmed_case_text(case: "Case", outcome: str) -> str:
        """The ``model_unconfirmed`` chunk text.

        Deliberately a DIFFERENT sentence from :meth:`_resolved_case_text`: that one
        opens "analyst-confirmed outcome", which would be an outright lie here. This
        text states, in the corpus itself, that no human reviewed it — so the claim
        survives even if a future renderer loses the heading. There is no "Analyst
        note" field because there is no analyst.

        This is the ONE tier permitted to render the model's own verdict, because
        surfacing an explicitly UNREVIEWED prior judgement is the tier's entire
        purpose. The discipline that makes that safe is ORDERING, enforced by
        ``_PRECEDENT_UNCONFIRMED_TEXT_FIELDS``: the provenance disclaimer is the
        FIRST field, so ``agents.prompts.fence``'s 600-character truncation can never
        drop "nobody confirmed this" while leaving the judgement behind. ``trust_class``
        and the shared ``resolved_case:{case_id}`` document identity are unchanged, so
        a later analyst confirmation still upserts the confirmed projection in place.
        """
        verdict = case.verdict.value if case.verdict else "n/a"
        confidence = round(float(case.confidence or 0.0), 2)
        return _render_precedent_text(
            _PRECEDENT_UNCONFIRMED_TEXT_FIELDS,
            {
                "unconfirmed_provenance": (
                    f"Prior case {case.case_id}: UNCONFIRMED model outcome {outcome} "
                    "— closed by the agent, NOT reviewed or confirmed by an analyst."
                ),
                "model_judgement": (
                    f"Model verdict {verdict} at confidence {confidence}."
                ),
                **_case_context_text_values(case),
            },
        )

    def _unconfirmed_case_item(
        self, case: "Case", *, outcome: str, recurrence: int
    ) -> dict[str, Any]:
        """Project ONE agent-closed case into a ``model_unconfirmed`` precedent item.

        Shares the ``resolved_case:{case_id}`` document identity with the confirmed
        tier ON PURPOSE: a case is in exactly one tier at a time, so when an analyst
        later confirms it the confirmed projection UPSERTS over this one — an upgrade
        in place, never a duplicate and never two disagreeing chunks about one case.
        """
        document_id = f"{RESOLVED_CASE_SOURCE}:{case.case_id}"
        identity = case_rule_identity(case)
        return {
            "text": self._unconfirmed_case_text(case, outcome),
            "source": RESOLVED_CASE_SOURCE,
            "doc_id": document_id,
            "metadata": {
                "case_id": case.case_id,
                "verdict": case.verdict.value if case.verdict else "n/a",
                "outcome": outcome,
                "entity": f"{case.entity.type.value}:{case.entity.value}",
                "status": case.status.value if case.status else "",
                # Mirrors the confirmed tier so the two never disagree about one case.
                # It is still NOT promotable: ``trust_class`` below keeps this tier out
                # of every precedent-promotion and distribution tally.
                RULE_IDENTITY_KEY: identity,
                RULE_IDS_KEY: list(rule_identity_members(identity)),
                # No analyst note and NO ground-truth source: nothing independent
                # backs this item, and pretending otherwise is the whole failure mode.
                "note": "",
                "ground_truth_source": "",
                "trust_class": TRUST_MODEL_UNCONFIRMED,
                "document_id": document_id,
                "confidence": round(float(case.confidence or 0.0), 4),
                "recurrence": int(recurrence),
                "terminal_at": self._terminal_at(case),
                "bulk_ratified": is_bulk_ratified(case),
            },
        }

    def _unconfirmed_candidate(self, case: "Case", *, now: datetime) -> str | None:
        """The per-case guards. Returns the model outcome, or ``None`` to reject.

        Rejects anything the confirmed tier owns, anything the model did not actually
        judge, anything a human decided (an analyst close without an explicit
        classification is neither confirmed ground truth NOR a model judgement — it
        belongs in no tier), anything under the confidence floor, and anything older
        than the age-out horizon. The population-level recurrence guard is applied by
        the caller, which is the only place it can be evaluated.
        """
        guards = self._unconfirmed_cfg()
        if self._is_case_excluded(getattr(case, "case_id", "")):
            return None  # operator-excluded: no tier may re-derive it
        if analyst_confirmed_outcome(case)[0] is not None:
            return None  # the CONFIRMED tier owns it — never demote a real label
        if getattr(case.decision_by, "value", case.decision_by) != DecisionBy.AGENT.value:
            return None
        outcome = self._unconfirmed_outcome(case)
        if outcome is None:
            return None
        if float(case.confidence or 0.0) < float(guards.min_confidence):
            return None
        terminal_at = _parse_iso(self._terminal_at(case))
        if terminal_at is None:
            return None  # an undatable case can never be aged out — refuse it
        if terminal_at < now - timedelta(days=int(guards.max_age_days)):
            return None
        return outcome

    async def _scan_unconfirmed_candidates(
        self, limit: int | None = None
    ) -> list[tuple["Case", dict[str, Any]]]:
        """Bounded scan → the guard-passing ``model_unconfirmed`` precedent items.

        Returns ``(case, item)`` pairs so the bulk bootstrap can stamp provenance onto
        the same cases it indexes. Inert (returns ``[]`` immediately) unless the tier
        is explicitly enabled, so the default deployment pays nothing at all.

        The scan walks ``_UNCONFIRMED_SCAN_STATUSES`` — CLOSED only. A RESOLVED case is
        analyst-decided by construction and ``_unconfirmed_candidate`` rejects it, so
        including it would spend half the budget on a status that cannot produce a
        single candidate.
        """
        if self._cases is None or not self._unconfirmed_enabled():
            return []
        # The public ``unconfirmed_precedent_candidates`` seam feeds the bulk bootstrap
        # directly, outside any projection, so the exclusion set is loaded here too. An
        # UNKNOWN set derives NOTHING rather than everything: this tier is an addition,
        # so producing none of it is a loss of enrichment, while producing it blind would
        # re-add precedent an operator excluded.
        if not await self._refresh_exclusions():
            logger.warning(
                "unconfirmed precedent skipped: the exclusion set is unknown"
            )
            return []
        guards = self._unconfirmed_cfg()
        cap = int(limit if limit is not None else guards.max_items)
        if cap <= 0:
            return []
        now = datetime.now(timezone.utc)
        # Pass 1 — collect every guard-passing candidate within the bounded scan, and
        # count each recurrence pattern. Recurrence CANNOT be decided one case at a
        # time, which is exactly why the incremental close path never writes this tier.
        candidates: list[tuple["Case", str]] = []
        counts: Counter[str] = Counter()

        def _visit(case: "Case") -> bool:
            outcome = self._unconfirmed_candidate(case, now=now)
            if outcome is not None:
                candidates.append((case, outcome))
                counts[self._recurrence_key(case, outcome)] += 1
            return True

        await self._scan_terminal_cases(
            scan_cap=_UNCONFIRMED_SCAN_CAP,
            visit=_visit,
            statuses=_UNCONFIRMED_SCAN_STATUSES,
        )
        # Pass 2 — keep only patterns that RECUR. One auto-close is an anecdote; a
        # single hallucinated close must never become quotable precedent.
        minimum = max(1, int(guards.min_recurrence))
        survivors: list[tuple["Case", dict[str, Any]]] = []
        for case, outcome in candidates:
            recurrence = counts[self._recurrence_key(case, outcome)]
            if recurrence < minimum:
                continue
            survivors.append(
                (case, self._unconfirmed_case_item(case, outcome=outcome, recurrence=recurrence))
            )
        # Pass 3 — the SAME window fairness as the confirmed tier (globally newest-first,
        # then the operator's axes and admission cap). This tier runs after the window
        # with its own scan cap, so leaving it flat would simply reintroduce single-group
        # flooding one trust class down. It reuses ``precedent.window.stratify_by`` on
        # purpose: adding an axis field to the unconfirmed block would change
        # ``_unconfirmed_cfg().model_dump_json()``, which is a source-signature member,
        # and force a reprojection nobody asked for.
        window = self._window_config()
        survivors.sort(key=lambda pair: _created_at_rank(pair[0]), reverse=True)
        return self._stratify(
            survivors,
            axes=self._window_axes(window),
            limit=cap,
            admission_cap=self._admission_cap(window, cap),
        )

    async def _unconfirmed_case_items(self, limit: int | None = None) -> list[dict[str, Any]]:
        """The bounded ``model_unconfirmed`` slice of the precedent projection."""
        return [item for _, item in await self._scan_unconfirmed_candidates(limit)]

    async def _unconfirmed_precedent_addition(
        self, staged: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """Unconfirmed items that do NOT collide with anything already staged.

        The two tiers share one document identity per case, so a collision would make
        ``_verify_projection`` expect two chunks where the store upserts one and abort
        the whole projection. The guards already exclude analyst-confirmed cases, so
        this is belt-and-braces — and it settles the tie the right way round: an
        already-staged CONFIRMED item always wins."""
        addition = await self._unconfirmed_case_items()
        if not addition:
            return []
        staged_ids = {str(item.get("doc_id") or "") for item in staged}
        return [
            item for item in addition if str(item.get("doc_id") or "") not in staged_ids
        ]

    async def unconfirmed_precedent_candidates(
        self, limit: int | None = None
    ) -> list[tuple["Case", dict[str, Any]]]:
        """Public seam for the bulk bootstrap: guard-passing candidates + their items."""
        return await self._scan_unconfirmed_candidates(limit)

    async def index_precedent_items(
        self, items: list[dict[str, Any]], *, ratified_by: str = "", batch_id: str = ""
    ) -> int:
        """Embed + upsert already-projected precedent items. Never raises.

        ``ratified_by``/``batch_id`` are stamped into the chunk metadata so the corpus
        itself records that these entries arrived through a BULK RATIFICATION of model
        verdicts. Stamping provenance never changes ``trust_class``: a ratified item is
        still ``model_unconfirmed``, because an operator agreeing to reuse a model
        verdict is not an independent analyst outcome."""
        if not items:
            return 0
        # The explicit bootstrap indexer is handed ALREADY-PROJECTED items from outside
        # this service, so it cannot rely on the per-case projector's own exclusion
        # check. Refresh (lazily) and filter here, or a bulk ratification re-indexes
        # precedent an operator has excluded — and an UNKNOWN set cannot filter at all,
        # so it indexes nothing rather than everything.
        if not await self._refresh_exclusions():
            logger.warning(
                "precedent bootstrap indexing skipped: the exclusion set is unknown"
            )
            return 0
        items = [
            item
            for item in items
            if not self._is_case_excluded((item.get("metadata") or {}).get("case_id"))
        ]
        if not items:
            return 0
        stamped: list[dict[str, Any]] = []
        for raw in items:
            item = dict(raw)
            metadata = dict(item.get("metadata") or {})
            if ratified_by or batch_id:
                metadata["bulk_ratified"] = True
                metadata["ratified_by"] = str(ratified_by or "")
                metadata["ratification_batch"] = str(batch_id or "")
                metadata["ratification_provenance"] = PRECEDENT_RATIFICATION_PROVENANCE
            item["metadata"] = metadata
            stamped.append(item)
        try:
            added = await self._embed_and_add(self._managed_items(stamped))
            self.invalidate_precedent_distribution()
            return added
        except Exception as exc:  # noqa: BLE001 — corpus writes are always fail-safe
            logger.warning("index_precedent_items failed: %s", exc)
            return 0

    def _window_config(self) -> "PrecedentWindowConfig":
        """The operator's precedent-window policy (size + per-rule stratification)."""
        block = getattr(self._prefs, "precedent", None)
        window = getattr(block, "window", None)
        if window is not None:
            return window
        from ..config import PrecedentWindowConfig as _Window  # local: avoids a cycle

        return _Window()

    def _window_axes(self, window: "PrecedentWindowConfig") -> list[str]:
        """The ordered projection METADATA KEYS the window stratifies on.

        ``stratify_by_rule`` is the DEPRECATED alias and is now the master switch:
        ``False`` means a stored pre-``stratify_by`` preference still switches window
        fairness off — axes and admission cap both — and restores the scan's early exit.
        It does not restore the pre-stratification ORDERING; see
        :meth:`_resolved_case_items` for what stays unconditional and why.
        """
        if not bool(getattr(window, "stratify_by_rule", True)):
            return []
        axes = getattr(window, "stratify_by", None)
        if axes is None:  # pragma: no cover — a stored pre-``stratify_by`` config object
            return [RULE_IDENTITY_KEY]
        return [str(axis).strip() for axis in axes if str(axis).strip()]

    def _admission_cap(self, window: "PrecedentWindowConfig", size: int) -> int | None:
        """The largest number of window slots ONE operator transaction may occupy.

        ``None`` when uncapped. Derived from a FRACTION of the window so it carries no
        deployment-specific volume; ``1.0`` (or the master switch off) means a single
        transaction may legitimately fill the window.
        """
        if not bool(getattr(window, "stratify_by_rule", True)):
            return None
        fraction = float(getattr(window, "max_transaction_fraction", 0.0) or 0.0)
        if fraction <= 0.0 or fraction >= 1.0:
            return None
        return max(1, math.ceil(size * fraction))

    @staticmethod
    def _admission_group(case: "Case") -> str:
        """The APPROXIMATE operator transaction a case's confirmation belongs to.

        A bulk analyst action is ONE human decision applied to hundreds of cases, and a
        bounded window that cannot tell it apart from hundreds of independent decisions
        lets it buy every slot. There was no batch/job marker on the analyst path, so
        ``POST /api/cases/bulk`` now stamps one (``history[].batch``) and this reads it.

        For every case labelled BEFORE that stamp existed — and for the grading path,
        which has no batch concept at all — it falls back to a coarse TIME BUCKET of the
        confirming timestamp. That fallback is APPROXIMATE in both directions (it merges
        independent labels made in the same hour and splits a bulk action that straddles
        an hour boundary) and is documented as such; the alternative is no cap at all on
        exactly the historical backlog the cap exists for. An undatable case falls back
        to one shared ``""`` group, which is deterministic and, being a group like any
        other, is itself capped rather than exempted.
        """
        for entry in reversed(list(getattr(case, "history", None) or [])):
            # The SHARED classification predicate (engine.analyst_outcomes) — the same
            # one that decided this case is confirmed at all. It also matches the
            # Console's primary Close-with-disposition, which stamps the explicit
            # classification on an ``action="close"`` entry; matching only the
            # classification VERBS here would miss the batch marker on exactly the bulk
            # closes this cap exists to bound.
            if not is_classification_entry(entry):
                continue
            batch = str(entry.get("batch") or "").strip()
            if batch:
                return f"batch:{batch}"
            bucket = _admission_time_bucket(entry.get("ts"))
            if bucket:
                return bucket
            break
        for item in reversed(list(getattr(case, "feedback", None) or [])):
            bucket = _admission_time_bucket(
                item.get("ts") if isinstance(item, dict) else getattr(item, "ts", "")
            )
            if bucket:
                return bucket
        return _admission_time_bucket(RagService._terminal_at(case))

    def _stratify(
        self,
        pairs: list[tuple["Case", dict[str, Any]]],
        *,
        axes: list[str],
        limit: int,
        admission_cap: int | None,
    ) -> list[tuple["Case", dict[str, Any]]]:
        """Rank ``(case, item)`` pairs by the configured axes + admission cap.

        The axes read projection METADATA KEYS off the item; the admission cap reads the
        operator transaction off the case. Neither this method nor
        ``stratified_selection`` knows what any of those keys mean.
        """
        readers = [_metadata_axis(key) for key in axes]
        return stratified_selection(
            pairs,
            [(lambda pair, read=read: read(pair[1])) for read in readers],
            limit,
            transaction_key=(lambda pair: self._admission_group(pair[0])),
            max_per_transaction=admission_cap,
        )

    async def _scan_terminal_cases(
        self,
        *,
        scan_cap: int,
        visit: Callable[["Case"], bool],
        statuses: tuple[str, ...] = _PRECEDENT_SCAN_STATUSES,
    ) -> int:
        """Walk terminal cases within ONE bounded scan, fairly shared across statuses.

        Returns HOW MANY distinct cases were actually visited. That number, not the size
        of the qualifying result, is what says whether the scan ran to completion: a scan
        that examined the full cap and found few qualifying cases looks identical, from
        the result alone, to one that examined a handful and found the same few. Reporting
        the second as a complete measurement is the false confidence this whole surface
        exists to remove.

        ``visit`` is called once per distinct case and returns ``False`` to stop the
        whole scan early (the plain newest-N path, which only ever needs its first
        ``limit`` qualifying items).

        The budget is shared out per status in two phases: an EQUAL share first, then
        whatever that left over, spent in status order. One shared counter meant CLOSED —
        by far the larger population in a self-running deployment — could exhaust the cap
        before RESOLVED was read at all, and RESOLVED is where the analyst-resolved cases
        live. The two-phase shape keeps a single-status deployment spending the FULL cap,
        so nothing is lost by being fair.

        ``statuses`` is a PARAMETER rather than a module constant because the two tiers
        genuinely disagree about which statuses can yield a candidate: the confirmed
        tier draws real precedent from both, while for ``model_unconfirmed`` a RESOLVED
        case is analyst-decided by construction and can never qualify. Sharing one list
        would spend half that tier's budget on a guaranteed-empty status.
        """
        if self._cases is None:  # pragma: no cover — callers guard this
            return 0
        if not statuses:  # pragma: no cover — callers pass a non-empty tuple
            return 0
        seen: set[str] = set()
        scanned = 0
        offsets: dict[str, int] = {status: 0 for status in statuses}
        exhausted: dict[str, bool] = {status: False for status in statuses}
        keep_going = True

        async def _spend(status: str, budget: int) -> None:
            nonlocal scanned, keep_going
            spent = 0
            while spent < budget and scanned < scan_cap and keep_going:
                if exhausted[status]:
                    return
                page_size = min(
                    _RESOLVED_CASE_PAGE_SIZE, budget - spent, scan_cap - scanned
                )
                if page_size <= 0:
                    return
                page, total = await self._cases.list(
                    status=status, limit=page_size, offset=offsets[status]
                )
                if not page:
                    exhausted[status] = True
                    return
                for case in page:
                    if case.case_id in seen:
                        continue
                    seen.add(case.case_id)
                    scanned += 1
                    spent += 1
                    if not visit(case):
                        keep_going = False
                        break
                offsets[status] += len(page)
                if offsets[status] >= total:
                    exhausted[status] = True
                    return

        # The fair share is rounded DOWN to a whole number of pages (never below one),
        # so being fair costs no extra round trips: the cap is still reached in whole
        # pages rather than one fragmented page per status boundary.
        share = max(
            _RESOLVED_CASE_PAGE_SIZE,
            (scan_cap // len(statuses))
            // _RESOLVED_CASE_PAGE_SIZE
            * _RESOLVED_CASE_PAGE_SIZE,
        )
        for status in statuses:
            if not keep_going:
                return scanned
            await _spend(status, share)
        for status in statuses:
            if not keep_going:
                return scanned
            leftover = scan_cap - scanned
            if leftover <= 0:
                return scanned
            if not exhausted[status]:
                await _spend(status, leftover)
        return scanned

    async def _resolved_case_items(self, limit: int | None = None) -> list[dict[str, Any]]:
        """The ``limit`` QUALIFYING precedents to project (bounded scan).

        The window is counted in analyst-confirmed items, NOT in raw terminal cases.
        Counting raw cases meant a self-running deployment's own unlabelled
        auto-closes — which are newer than every labelled case and unbounded in
        number — consumed every slot, so the precedent corpus eroded to zero exactly
        as the agent succeeded. ``_RESOLVED_CASE_SCAN_CAP`` bounds the raw cases
        examined, so a large unlabelled backlog costs a bounded scan rather than the
        whole corpus.

        **N-axis stratification** (``prefs.precedent.window.stratify_by``, rule identity
        then the ANALYST-CONFIRMED OUTCOME by default). A flat newest-N window has the
        same starvation shape one level up: a bulk analyst action on ONE rule produces
        hundreds of qualifying cases that are all newer than every other rule's, so the
        next projection fills every slot with that rule. Rule identity alone does not
        finish the job either — inside each rule's bucket the newest-first tiebreak fills
        the slots with whatever outcome the deployment currently produces most of, so the
        corpus can end up unanimous about a rule it has never actually resolved two ways.
        The second axis is the analyst's ``outcome`` and NOT the model's ``verdict`` on
        purpose: on a rule the agent calls one way every time, the verdict axis is
        all-identical and skipped, and the cases the analysts OVERTURNED — the oldest,
        and the most valuable precedent in the tier — are exactly what the newest-first
        tiebreak then evicts. Round-robin over the ordered axes gives every active group
        an equal floor inside the same bounded window; an axis whose values are all
        identical is skipped, so a single-rule or single-outcome deployment falls back to
        the remaining axes, and then to newest-first, by itself.

        The axes are METADATA KEYS. This method reads the operator's list, hands the
        selector one reader per key, and never learns what any of them mean.

        **Globally newest-first.** The two terminal statuses are paged separately, so the
        concatenation of two separately-sorted runs is NOT newest-first — the ordering
        contract ``stratified_selection`` documents about its input, and the tiebreak
        every axis falls back on. The collected cases are merge-sorted on ``created_at``
        descending before selection; see ``_created_at_rank`` for how an unusable
        timestamp is ordered.

        Stratifying means the scan can no longer stop at the first ``limit`` qualifying
        items (that would only ever see the dominant group), so it runs to the scan cap.
        That is a bounded, paged case-store read that happens on projection only.

        **What the master switch does and does not restore.** With window fairness off
        (``stratify_by_rule=False``) the axes, the admission cap and the full scan are
        all disabled, so the early exit is restored. The global newest-first merge and
        the fair per-status scan budget are UNCONDITIONAL and apply on that path too, so
        it is not a byte-for-byte replay of the pre-stratification code: that code
        appended each status's page in scan order (all CLOSED, then all RESOLVED) and
        let CLOSED consume the whole cap. Both are deliberate fixes to the input
        ordering ``stratified_selection`` has always documented, and gating them on the
        switch would simply hand the defect back to anyone who set it.
        """
        _pool, picked, _meta = await self._collect_confirmed_precedent(limit)
        return [item for _case, item in picked]

    async def _collect_confirmed_precedent(
        self, limit: int | None = None, *, force_full_scan: bool = False
    ) -> tuple[
        list[tuple["Case", dict[str, Any]]],
        list[tuple["Case", dict[str, Any]]],
        dict[str, Any],
    ]:
        """The bounded scan behind :meth:`_resolved_case_items`, with its POOL exposed.

        Returns ``(pool, picked, meta)``. ``pool`` is every qualifying case the bounded
        scan saw; ``picked`` is the window the operator's policy actually selects from it.
        Splitting them out is what makes "200 of 889" answerable: a composition report
        that only ever sees ``picked`` cannot say how much of the qualifying population
        the window represents, and it is exactly that ratio — a window drawn from a pool
        that is MORE skewed than the window itself — which proves a rebuild cannot repair
        the corpus.

        ``force_full_scan`` is for the read-only composition report: with window fairness
        switched off the ordinary scan stops at the first ``limit`` qualifying items, so
        the pool would trivially equal the window and the ratio would be a tautology.
        The projection itself NEVER passes it, so the projection's scan cost and output
        are byte-identical to before this seam existed.
        """
        window = self._window_config()
        cap_items = max(1, int(limit if limit is not None else window.size))
        axes = self._window_axes(window)
        admission_cap = self._admission_cap(window, cap_items)
        full_scan = bool(axes) or admission_cap is not None or bool(force_full_scan)
        meta: dict[str, Any] = {
            "window_size": cap_items,
            "axes": list(axes),
            "admission_cap": admission_cap,
            "full_scan": bool(full_scan),
            "scan_cap": _RESOLVED_CASE_SCAN_CAP,
            "scanned": 0,
            "scan_complete": True,
        }
        if self._cases is None:
            return [], [], meta
        collected: list[tuple["Case", dict[str, Any]]] = []

        def _visit(case: "Case") -> bool:
            item = self._resolved_case_item(case)
            if item is not None:
                collected.append((case, item))
            return full_scan or len(collected) < cap_items

        scanned = await self._scan_terminal_cases(
            scan_cap=_RESOLVED_CASE_SCAN_CAP, visit=_visit
        )
        meta["scanned"] = int(scanned)
        # Complete only when the scan STOPPED because it ran out of cases, not because it
        # ran out of budget. Comparing the qualifying count against the cap instead would
        # report a truncated scan as complete on any deployment whose qualifying rate is
        # low — which is every deployment this report matters on.
        meta["scan_complete"] = bool(int(scanned) < int(_RESOLVED_CASE_SCAN_CAP))
        collected.sort(key=lambda pair: _created_at_rank(pair[0]), reverse=True)
        picked = self._stratify(
            collected, axes=axes, limit=cap_items, admission_cap=admission_cap
        )
        return collected, picked, meta

    # ----------------------------------------------------------------- #
    # Corpus COMPOSITION — the dry run that costs zero embedding calls.
    # ----------------------------------------------------------------- #
    @staticmethod
    def _composition_tally(rows: list[dict[str, Any]]) -> dict[str, Any]:
        """Cross-tabulate precedent metadata by (analyst outcome x model verdict).

        THE CROSS-TAB IS THE POINT, and reporting outcomes alone is the trap.

        Per-outcome counts read PRISTINE on a corpus that is actively poisoning the
        model. A corpus of 200 records that is 100% ``outcome=false_positive`` looks like
        a healthy benign baseline under an outcome-only report — and stays looking
        healthy for the entire incident — while every one of those records also carries
        ``verdict=NEEDS_HUMAN``, i.e. the agent escalated every single one. What the
        investigator then reads back is "we have seen this 200 times and escalated it
        every time", which is the opposite of the benign precedent the outcome column
        advertises. Only the JOINT distribution separates
        ``false_positive x FALSE_POSITIVE`` (a rule the agent and the analysts agree is
        benign) from ``false_positive x NEEDS_HUMAN`` (a rule the analysts keep
        overturning), and the two have opposite operational meanings.

        Both marginals are still reported, because an operator reasonably wants them —
        but never on their own.
        """
        cross: Counter[tuple[str, str]] = Counter()
        outcomes: Counter[str] = Counter()
        verdicts: Counter[str] = Counter()
        trust: Counter[str] = Counter()
        rules: Counter[str] = Counter()
        documents: set[str] = set()
        for row in rows:
            outcome = str(row.get("outcome") or "")
            verdict = str(row.get("verdict") or "")
            cross[(outcome, verdict)] += 1
            outcomes[outcome] += 1
            verdicts[verdict] += 1
            trust[str(row.get("trust_class") or "")] += 1
            rules[str(row.get(RULE_IDENTITY_KEY) or "")] += 1
            document_id = str(row.get("document_id") or "") or str(row.get("case_id") or "")
            if document_id:
                documents.add(document_id)
        ranked = sorted(cross.items(), key=lambda kv: (-kv[1], kv[0]))
        ranked_rules = sorted(rules.items(), key=lambda kv: (-kv[1], kv[0]))
        return {
            "chunks": len(rows),
            "documents": len(documents),
            "rule_identities": len(rules),
            # The JOINT distribution. Never read the two marginals without it.
            "outcome_by_verdict": [
                {"outcome": outcome, "verdict": verdict, "count": count}
                for (outcome, verdict), count in ranked[:_MAX_COMPOSITION_ROWS]
            ],
            "outcome_by_verdict_truncated": len(ranked) > _MAX_COMPOSITION_ROWS,
            "by_outcome": dict(sorted(outcomes.items())),
            "by_verdict": dict(sorted(verdicts.items())),
            "by_trust_class": dict(sorted(trust.items())),
            "by_rule": {
                rule: count for rule, count in ranked_rules[:_MAX_COMPOSITION_ROWS]
            },
            "by_rule_truncated": len(ranked_rules) > _MAX_COMPOSITION_ROWS,
        }

    def _admission_concentration(
        self, picked: list[tuple["Case", dict[str, Any]]]
    ) -> dict[str, Any]:
        """How concentrated the selected window is in ONE operator transaction.

        A window that is 96% one bulk analyst action is one human decision wearing 192
        faces, and it is invisible in any per-outcome or per-rule count. The GROUP LABELS
        are deliberately omitted from the payload: an admission group is either an opaque
        batch id or a coarse time bucket, and neither is useful to an operator while both
        would leak the shape of individual analyst sessions onto a diagnostics surface.
        Only the concentration is reported.
        """
        groups: Counter[str] = Counter()
        for case, _item in picked:
            groups[self._admission_group(case)] += 1
        total = sum(groups.values())
        largest = max(groups.values(), default=0)
        return {
            "selected": total,
            "transactions": len(groups),
            "max_transaction_documents": int(largest),
            "max_transaction_share": (round(largest / total, 4) if total else 0.0),
        }

    async def corpus_composition(self) -> dict[str, Any]:
        """Compare the CURRENT precedent corpus with the one a rebuild WOULD produce.

        A DRY RUN THAT COSTS ZERO EMBEDDING CALLS. Both halves are derivable without
        embedding anything: the current corpus is read through the management API
        (``_precedent_chunk_metadata``), and the would-be projection is the ordinary
        per-case projector, which already writes the analyst outcome AND the model verdict
        into each item's metadata. Nothing here embeds, seeds, writes or mutates.

        **A SUCCESSFUL REBUILD IS NOT A REPAIR, and this report exists to prove it.** The
        projection pages the case store newest-first, so on a deployment whose newest
        analyst-confirmed terminal cases are the bulk-confirmed ones, a rebuild
        RE-SELECTS exactly those cases. If the qualifying POOL is more skewed than the
        window drawn from it — which is what ``pool`` here measures — then no selection
        policy over that pool can produce a healthy corpus, and reprojecting will simply
        reproduce the composition it just replaced. That is why this report shows the
        pool size beside the window ("200 of 889"), the joint outcome x verdict
        distribution rather than outcome alone, and the admission concentration: those
        three together are what let an operator tell "the projection broke" apart from
        "the ground truth this corpus is projected from is itself skewed".
        """
        window = self._window_config()
        report: dict[str, Any] = {
            "at": iso_now(),
            # Stated on the payload so nobody has to infer it from the docstring.
            "embedding_calls": 0,
            "costs_provider_spend": False,
            "window": {
                "size": int(window.size),
                "axes": self._window_axes(window),
                "admission_cap": self._admission_cap(window, int(window.size)),
                "max_transaction_fraction": float(
                    getattr(window, "max_transaction_fraction", 0.0) or 0.0
                ),
                "scan_cap": _RESOLVED_CASE_SCAN_CAP,
            },
            "unconfirmed_tier_enabled": self._unconfirmed_enabled(),
        }

        # ---- the corpus as it stands -------------------------------------- #
        try:
            rows, truncated = await self._precedent_chunk_metadata()
            current = {
                "available": True,
                "reason": "",
                # A truncated backend read makes every count below a LOWER BOUND.
                "truncated": bool(truncated),
                **self._composition_tally(rows),
            }
        except Exception as exc:  # noqa: BLE001 — a report degrades, never raises
            logger.warning("corpus composition could not read the corpus: %s", exc)
            current = {
                "available": False,
                "reason": f"the precedent corpus could not be read ({type(exc).__name__})",
                "truncated": False,
            }
        report["current"] = current

        # ---- the projection a rebuild WOULD produce ----------------------- #
        if self._cases is None:
            report["projected"] = {
                "available": False,
                "reason": "no case store is wired, so no projection can be derived",
            }
            return report
        if not self._prefs.rag.use_resolved_cases:
            report["projected"] = {
                "available": False,
                "reason": (
                    "the resolved-case precedent source is turned off, so a rebuild "
                    "would project no precedent at all"
                ),
            }
            return report
        try:
            # Read-only report: an UNKNOWN exclusion set does not stop it, because
            # refusing to describe the corpus helps nobody — but it is disclosed, via
            # ``report["exclusions_stale"]`` below and ``precedent_exclusions()``'s own
            # ``available: false``, so the composition is never read as authoritative
            # about a deny list that could not be loaded.
            await self._refresh_exclusions(force=True)
            pool, picked, meta = await self._collect_confirmed_precedent(
                force_full_scan=True
            )
            unconfirmed = (
                await self._unconfirmed_case_items() if self._unconfirmed_enabled() else []
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("corpus composition could not derive a projection: %s", exc)
            report["projected"] = {
                "available": False,
                "reason": f"the case store could not be scanned ({type(exc).__name__})",
            }
            return report

        picked_rows = [dict(item.get("metadata") or {}) for _case, item in picked]
        pool_rows = [dict(item.get("metadata") or {}) for _case, item in pool]
        unconfirmed_rows = [dict(item.get("metadata") or {}) for item in unconfirmed]
        report["projected"] = {
            "available": True,
            "reason": "",
            "confirmed": self._composition_tally(picked_rows),
            "unconfirmed": self._composition_tally(unconfirmed_rows),
            "admission": self._admission_concentration(picked),
            # The QUALIFYING POOL the window was drawn from. "200 of 889".
            "pool": {
                "qualifying": len(pool),
                "selected": len(picked),
                "share": (round(len(picked) / len(pool), 4) if pool else 0.0),
                # False when the bounded scan itself stopped short, which makes the
                # pool a LOWER BOUND rather than the whole qualifying population.
                "scan_complete": bool(meta["scan_complete"]),
                "scanned_cases": int(meta.get("scanned") or 0),
                "scan_cap": int(meta["scan_cap"]),
                "composition": self._composition_tally(pool_rows),
            },
        }
        report["excluded_cases"] = len(self._excluded_cases)
        report["exclusions_stale"] = bool(self.exclusions_stale)
        return report

    # ----------------------------------------------------------------- #
    # Per-rule precedent distribution (the deterministic half of promotion)
    # ----------------------------------------------------------------- #
    def invalidate_precedent_distribution(self) -> None:
        """Drop the cached per-rule distribution after the corpus changed."""
        self._precedent_distribution = None
        self._precedent_distribution_at = None

    async def _precedent_chunk_metadata(self) -> tuple[list[dict[str, Any]], bool]:
        """Every stored precedent chunk's metadata, in ONE corpus read, plus a
        truncation hint.

        Reads through the management API rather than the search path so asking about
        precedent never embeds, never seeds and never mutates the projection. It uses
        the single-pass ``list_all_chunks`` deliberately: fanning ``list_chunks`` out per
        document would make every backend re-scan the whole corpus once PER PRECEDENT
        DOCUMENT, so a deployment with 846 precedents would pay 846 full scans for one
        diagnostics request.

        The Elasticsearch backend reads its corpus in one bounded page, so a corpus AT
        that ceiling may have been cut short. The hint therefore compares the CHUNK
        count against the chunk ceiling (comparing a grouped DOCUMENT count against it
        could never detect the truncation it exists to report), and every count derived
        from a truncated read is a lower bound rather than a confident total.
        """
        chunks, truncated = await self._precedent_chunks()
        return [dict(chunk.metadata or {}) for chunk in chunks], truncated

    async def _precedent_chunks(self) -> tuple[list[StoredChunk], bool]:
        """Every stored precedent chunk, in ONE corpus read, plus the truncation hint.

        The same single-pass read :meth:`_precedent_chunk_metadata` has always used, kept
        as its own method because the text repair needs the CHUNKS (their text and their
        durable chunk ids) and not just the metadata rows the reporting surfaces read.
        The truncation hint is computed against the WHOLE chunk count before the source
        filter, exactly as before, because that is the count the backend's page ceiling
        actually bounds.
        """
        chunks = await self._store.list_all_chunks()
        truncated = self._read_may_be_truncated(len(chunks))
        return (
            [chunk for chunk in chunks if chunk.source == RESOLVED_CASE_SOURCE],
            truncated,
        )

    def _read_may_be_truncated(self, chunk_count: int) -> bool:
        """Whether a whole-corpus read could have been cut short by the BACKEND.

        Only the Elasticsearch store has a scan ceiling; the in-memory and SQL stores
        return every row. Reporting a complete PostgreSQL read as truncated would be a
        false unknown — and since a truncated read withholds promotion and the futility
        report, it would quietly disable the feature on a healthy large deployment.
        """
        from .vectorstore import ESVectorStore  # local: avoids an import cycle at load

        if not isinstance(self._store, ESVectorStore):
            return False
        return chunk_count >= _CORPUS_SCAN_TRUNCATION_HINT

    async def precedent_distribution(self, *, force: bool = False) -> PrecedentDistribution:
        """Analyst-confirmed precedent, counted per rule identity. Never raises.

        This is what makes "N analyst-confirmed benign outcomes exist for this exact
        rule" a deterministic fact rather than an inference from four retrieved
        snippets. It counts what is actually IN the corpus (reachable by retrieval),
        which is the honest population to gate promotion on.

        Cached for ``prefs.precedent.distribution_ttl_seconds`` and invalidated whenever
        precedent is written, so an investigation pays a bounded management read at most
        once per TTL. A read failure returns an explicitly UNAVAILABLE distribution —
        never an empty one that would read as a confident zero.
        """
        cfg = self._prefs.rag
        if not (cfg.enabled and cfg.use_resolved_cases):
            # DISABLED, not unreadable. Reporting the operator's own configuration as an
            # unmeasurable unknown would put a permanent "could not be evaluated" entry
            # on the diagnostics surface for a deployment that is behaving exactly as
            # configured — the same distinction ``_precedent_corpus_block`` already makes.
            return disabled_distribution(
                "the resolved-case precedent source is turned off, so no per-rule "
                "precedent is reachable by an investigation"
            )
        ttl = float(getattr(getattr(self._prefs, "precedent", None), "distribution_ttl_seconds", 0) or 0)
        now = monotonic()
        cached = self._precedent_distribution
        if (
            not force
            and cached is not None
            and ttl > 0
            and self._precedent_distribution_at is not None
            and (now - self._precedent_distribution_at) < ttl
        ):
            return cached
        try:
            rows, truncated = await self._precedent_chunk_metadata()
        except Exception as exc:  # noqa: BLE001 — an outage must read as UNKNOWN
            logger.warning("Precedent distribution could not be read: %s", exc)
            return unavailable_distribution(
                f"the precedent corpus could not be read ({type(exc).__name__})"
            )
        distribution = distribution_from_metadata(rows, truncated=truncated)
        self._precedent_distribution = distribution
        self._precedent_distribution_at = now
        return distribution

    async def _reconcile_precedent_rule_identity(self) -> int:
        """Stamp rule identity onto precedent projected BEFORE it was metadata.

        Rule identity became projection metadata with this change, so an existing
        deployment's corpus carries none of it — and rule-identity matching would then
        silently find nothing for precisely the operator who already did the work. Re-tag
        those chunks in place from the CASE STORE (exact, never parsed out of the chunk
        prose): the doc id is unchanged, so the store upserts with no re-embedding and no
        gateway spend, exactly like :meth:`_reconcile_legacy_resolved_case_documents`.

        This re-tags OUR OWN projection metadata; it never writes to the case. Chunks
        whose case can no longer be read are left alone (they stay retrievable and are
        reported as ``unattributed`` by the distribution rather than counted as absent).
        Idempotent, bounded and best-effort: a failure never blocks seeding.
        """
        if self._cases is None:
            return 0
        try:
            chunks = await self._store.list_all_chunks()
        except Exception as exc:  # noqa: BLE001 — migration is best-effort
            logger.warning("Precedent rule-identity reconciliation could not read: %s", exc)
            return 0
        # ONE corpus read, then a bounded number of CASE lookups. Fanning list_chunks out
        # per document would re-scan the whole corpus once per precedent document on
        # every seed — and because the cap only counted chunks MISSING the key, a fully
        # migrated corpus never reached it, so that cost would have been paid forever
        # rather than once.
        stale = [
            chunk
            for chunk in chunks
            if chunk.source == RESOLVED_CASE_SOURCE
            and RULE_IDENTITY_KEY not in (chunk.metadata or {})
        ]
        if not stale:
            return 0  # converged: nothing to look up, nothing to write
        upgraded: list[StoredChunk] = []
        for chunk in stale[:_RULE_IDENTITY_RECONCILE_CAP]:
            metadata = dict(chunk.metadata or {})
            case_id = str(metadata.get("case_id") or "")
            if not case_id:
                continue
            if self._is_case_excluded(case_id):
                continue  # never re-write a chunk for an operator-excluded case
            try:
                case = await self._cases.get(case_id)
            except Exception:  # noqa: BLE001
                continue
            if case is None:
                continue
            identity = case_rule_identity(case)
            metadata[RULE_IDENTITY_KEY] = identity
            metadata[RULE_IDS_KEY] = list(rule_identity_members(identity))
            upgraded.append(dataclass_replace(chunk, metadata=metadata))
        if not upgraded:
            return 0
        try:
            await self._store.add(upgraded)
        except Exception as exc:  # noqa: BLE001 — never block seeding on a migration
            logger.warning("Precedent rule-identity reconciliation could not write: %s", exc)
            return 0
        logger.info(
            "Stamped rule identity onto %d existing precedent chunk(s)", len(upgraded)
        )
        return len(upgraded)

    async def index_resolved_cases(self, limit: int | None = None) -> int:
        """Load CLOSED cases and index one chunk per case as institutional memory.

        Only analyst-confirmed cases qualify, and the window counts QUALIFYING cases
        rather than raw terminal ones. The chunk text comes from the shared
        :meth:`_resolved_case_text` builder (identical to the incremental path), which
        renders an ALLOWLIST of fields — human-provenance first, and never the model's
        own verdict; source="resolved_case"; metadata carries case_id / verdict /
        entity so the UI/agent can cite the source case and so the verdict stays
        available to its legitimate consumers without being replayed as prose.
        Returns the number of chunks added. Never raises (logs + returns 0)."""
        if self._cases is None:
            return 0
        try:
            # An UNKNOWN exclusion set indexes nothing: this bulk window would otherwise
            # re-derive every excluded precedent in one write.
            await self._require_exclusions()
            added = await self._embed_and_add(await self._resolved_case_items(limit))
            self.invalidate_precedent_distribution()
            return added
        except Exception as exc:  # noqa: BLE001
            logger.warning("Indexing resolved cases failed: %s", exc)
            return 0

    async def index_resolved_case(self, case: "Case", note: str = "") -> int:
        """Index ONE resolved-case chunk on close as institutional memory (C3-5).

        Triggered from the case-action endpoint when an analyst closes / confirms-FP
        a case. The chunk is built by the SHARED :meth:`_resolved_case_item`
        projection, so it is byte-identical to what the bulk window would write for
        the same case (previously the two paths emitted different text and the last
        writer won). Uses a DETERMINISTIC ``doc_id = resolved_case:{case_id}`` so
        re-closing OVERWRITES rather than duplicating, and routes through
        ``_managed_items`` so the chunk carries the same per-case
        ``metadata.document_id`` — one case is one document, never a shared
        ``seed:resolved_case`` blob that a single delete can wipe. Gated by
        ``rag.enabled`` AND ``rag.use_resolved_cases``. FAIL-SAFE: returns 0 (never
        raises) so a failed embedding/vector-store write never breaks the close
        action (it still 200s)."""
        cfg = self._prefs.rag
        if not (cfg.enabled and cfg.use_resolved_cases):
            return 0
        try:
            # Lazily load the exclusion set once per process. A close can be the FIRST
            # precedent write after a restart, before any projection has run, so without
            # this an excluded case would be re-indexed by the very next close — and an
            # UNKNOWN set cannot answer the question at all, so this close indexes no
            # precedent (the case itself is unaffected; the write is fail-soft by design).
            await self._require_exclusions()
            item = self._resolved_case_item(case, note=note)
            if item is None:
                return 0
            added = await self._embed_and_add(self._managed_items([item]))
            # New precedent changes the per-rule counts promotion reads, so the cached
            # distribution must never survive the write that invalidated it.
            self.invalidate_precedent_distribution()
            return added
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "index_resolved_case failed for %s: %s", getattr(case, "case_id", "?"), exc
            )
            return 0

    # ----------------------------------------------------------------- #
    # RAG knowledge-base management (see + manage the corpus). A "document"
    # is the set of chunks sharing ``metadata.document_id``. Imports affect
    # ``retrieve`` immediately (same corpus). All methods FAIL-SAFE.
    # ----------------------------------------------------------------- #
    async def import_document(
        self,
        title: str,
        text: str,
        *,
        source: str = "imported",
        tags: list[str] | None = None,
    ) -> dict[str, Any]:
        """Chunk + embed ``text`` and add it as a managed document.

        Returns ``{document_id, title, source, chunk_count}``. A stable
        ``document_id = imported:<slug>:<shorthash>`` groups the chunks; each chunk
        gets ``doc_id = f"{document_id}:{i}"`` and the management metadata
        (document_id/title/source/tags/added_at/chunk_index/n_chunks). FAIL-SAFE:
        on any failure logs and returns ``chunk_count: 0`` (never raises)."""
        title = (title or "").strip() or "Untitled"
        # Defense-in-depth (#9): the ``source`` becomes a fenced ``source=`` provenance
        # label at render time. Strip newlines/marker characters here too so a stored
        # imported-document source can never help break out of the UNTRUSTED fence.
        source = _sanitise_source_label(source)
        tags = list(tags or [])
        try:
            await self.ensure_seeded()
            pieces = chunk_text(text or "")
            if not pieces:
                return {"document_id": "", "title": title, "source": source, "chunk_count": 0}
            document_id = f"imported:{_slugify(title)}:{_shorthash(text)}"
            added_at = iso_now()
            n = len(pieces)
            items: list[dict[str, Any]] = [
                {
                    "text": piece,
                    "source": source or "imported",
                    "doc_id": f"{document_id}:{i}",
                    "metadata": {
                        "document_id": document_id,
                        "title": title,
                        "source": source or "imported",
                        "tags": tags,
                        "added_at": added_at,
                        "chunk_index": i,
                        "n_chunks": n,
                    },
                }
                for i, piece in enumerate(pieces)
            ]
            added = await self._embed_and_add(items)
            return {
                "document_id": document_id,
                "title": title,
                "source": source or "imported",
                "chunk_count": added,
            }
        except Exception as exc:  # noqa: BLE001
            logger.warning("RAG import_document(%r) failed: %s", title, exc)
            return {"document_id": "", "title": title, "source": source, "chunk_count": 0}

    async def import_threat_context(
        self, title: str, content: str, *, tags: list[str] | None = None
    ) -> dict[str, Any]:
        """Ingest an operator-supplied THREAT-INTEL document into the RAG corpus as
        ``source="threat_context"`` (F11). Retrievable like any knowledge and injected
        as a TRUSTED fenced block. Thin wrapper over :meth:`import_document` so all
        the chunking/embedding/dedup/fail-safe behaviour is reused. The content is
        UNTRUSTED corpus text — the investigator's render path fences it (#9)."""
        return await self.import_document(
            title, content, source=THREAT_CONTEXT_SOURCE, tags=tags
        )

    async def list_documents(self) -> list[dict[str, Any]]:
        """All documents in the corpus (seeds grouped as ``seed:<source>``). Never raises."""
        try:
            await self.ensure_seeded()
            return await self._store.list_documents()
        except Exception as exc:  # noqa: BLE001
            logger.warning("RAG list_documents failed: %s", exc)
            return []

    async def snapshot_documents(self) -> list[dict[str, Any]]:
        """Read existing document metadata without seeding or embedding.

        Portable export must be a read-only snapshot: merely asking for an export
        must not populate the corpus or incur an embedding call. The ordinary
        Knowledge page continues to use :meth:`list_documents` and its lazy-seed
        contract; this narrow seam exposes only what is already persisted.
        """
        try:
            return await self._store.list_documents()
        except Exception as exc:  # noqa: BLE001
            logger.warning("RAG snapshot failed: %s", exc)
            return []

    async def snapshot_documents_strict(self) -> list[dict[str, Any]]:
        """Read persisted document metadata or propagate availability failures.

        This remains seed-free and embedding-free like :meth:`snapshot_documents`,
        but is reserved for evidence/export paths where ``[]`` must mean a confirmed
        empty corpus rather than a swallowed backend outage.
        """
        rows = await self._store.list_documents()
        if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
            raise ValueError("RAG document metadata is malformed")
        return rows

    async def get_document(self, document_id: str) -> dict[str, Any] | None:
        """A document + its chunks (as dicts), or None if no such document. Never raises."""
        try:
            await self.ensure_seeded()
            chunks = await self._store.list_chunks(document_id)
            if not chunks:
                return None
            first = chunks[0]
            meta = first.metadata or {}
            return {
                "document_id": document_id,
                "title": str(meta.get("title") or document_id),
                "source": first.source,
                "tags": list(meta.get("tags") or []),
                "added_at": meta.get("added_at") or "",
                "chunk_count": len(chunks),
                "embedding_model": first.embedding_model,
                "dim": int(first.dim or len(first.embedding) or 0),
                "chunks": [
                    {
                        "text": c.text,
                        "source": c.source,
                        "chunk_index": int((c.metadata or {}).get("chunk_index", i) or i),
                        "metadata": dict(c.metadata or {}),
                    }
                    for i, c in enumerate(chunks)
                ],
            }
        except Exception as exc:  # noqa: BLE001
            logger.warning("RAG get_document(%s) failed: %s", document_id, exc)
            return None

    async def delete_document(self, document_id: str, *, force: bool = False) -> dict[str, Any]:
        """Delete a document's chunks. Guards the built-in seed sources
        (runbook/mitre/suppression/resolved_case) unless ``force=True``.

        Returns ``{deleted, guarded, found}``: ``found`` is whether the document
        existed, ``guarded`` is True when a seed source was refused, ``deleted`` is
        the chunk count removed. Never raises."""
        try:
            await self.ensure_seeded()
            chunks = await self._store.list_chunks(document_id)
            if not chunks:
                return {"deleted": 0, "guarded": False, "found": False}
            src = chunks[0].source
            # A seed pseudo-document_id is "seed:<source>"; the source itself also
            # identifies a guarded built-in corpus.
            is_seed = src in SEED_SOURCES or document_id.startswith("seed:")
            if is_seed and not force:
                return {"deleted": 0, "guarded": True, "found": True}
            removed = await self._store.delete_document(document_id)
            if src == RESOLVED_CASE_SOURCE:
                # A precedent deletion changes the per-rule counts promotion reads; a
                # cached distribution must never outlive the write that invalidated it.
                self.invalidate_precedent_distribution()
            return {"deleted": removed, "guarded": False, "found": True}
        except Exception as exc:  # noqa: BLE001
            logger.warning("RAG delete_document(%s) failed: %s", document_id, exc)
            return {"deleted": 0, "guarded": False, "found": False}

    # ----------------------------------------------------------------- #
    # Operator precedent EXCLUSION — the supported way to evict one precedent.
    # ----------------------------------------------------------------- #
    async def precedent_exclusions(self) -> dict[str, Any]:
        """The current exclusion set, with the breakdown the diagnostics surface needs.

        Read-only, seed-free and embedding-free. ``available`` is False when the store
        could not be read, so an unreadable set is never reported as an empty one.
        """
        if self._exclusions is None:
            return {
                "available": False,
                "supported": False,
                "reason": (
                    "this deployment has no durable exclusion store wired, so precedent "
                    "exclusion is unavailable"
                ),
                "count": 0,
                "case_ids": [],
                "by_rule": {},
                "by_reason": {},
                "entries": {},
                "stale": False,
                "max_entries": self._exclusion_bound(),
            }
        rows = await self._exclusions.load()
        if rows is None:
            # Report the LAST KNOWN set, explicitly flagged unreadable, rather than an
            # empty one: an unreadable exclusion set is an unknown, not "nothing is
            # excluded", and the projection is still honouring the cached set.
            return {
                "available": False,
                "supported": True,
                "reason": "the precedent exclusion set could not be read",
                "count": len(self._excluded_cases),
                "case_ids": sorted(self._excluded_cases),
                "by_rule": {},
                "by_reason": {},
                "entries": {},
                "stale": True,
                "max_entries": self._exclusion_bound(),
            }
        self._excluded_cases = frozenset(rows)
        self._exclusions_loaded = True
        self.exclusions_stale = False
        by_rule: Counter[str] = Counter()
        by_reason: Counter[str] = Counter()
        for entry in rows.values():
            by_rule[str(entry.get("rule_identity") or "")] += 1
            by_reason[str(entry.get("reason") or "")] += 1
        return {
            "available": True,
            "supported": True,
            "reason": "",
            "count": len(rows),
            "case_ids": sorted(rows),
            "by_rule": dict(sorted(by_rule.items())),
            "by_reason": dict(sorted(by_reason.items())),
            "entries": {case_id: dict(entry) for case_id, entry in sorted(rows.items())},
            "stale": False,
            "max_entries": self._exclusion_bound(),
        }

    def excluded_case_ids(self) -> frozenset[str]:
        """The in-memory exclusion set, for surfaces that must not trigger a read."""
        return self._excluded_cases

    async def exclude_precedent_case(
        self,
        case_id: str,
        *,
        reason: str,
        note: str = "",
        actor: str = "",
    ) -> dict[str, Any]:
        """EXCLUDE = DELETE + MARK, in that order. Writing the marker alone removes nothing.

        The marker is written FIRST on purpose: from the instant it lands no producer can
        re-derive the precedent, so the delete that follows cannot race a concurrent
        projection that puts it straight back. If the delete then fails, the exclusion
        still HOLDS (nothing new is derived) and the call reports ``deleted: 0`` with
        ``complete: false``; re-issuing the same exclusion is idempotent and finishes the
        removal. There is no background eviction sweep — that is deliberately a separate
        change — so an incomplete exclusion is reported, never quietly retried.

        This NEVER touches ground truth: no feedback row, no ``disposition``, no
        ``decision_by``, no ``status``, no history rewrite. The case keeps its analyst
        label, so ``analyst_confirmed_outcome`` — and the threshold tuner's independent
        evidence count, which is derived from it — are unchanged.
        """
        key = str(case_id or "").strip()
        if not key:
            return {"ok": False, "reason": "a case id is required"}
        if self._exclusions is None:
            return {
                "ok": False,
                "reason": (
                    "this deployment has no durable exclusion store wired, so an "
                    "exclusion could not be made durable; the delete was not performed"
                ),
            }
        rule_identity = ""
        if self._cases is not None:
            try:
                case = await self._cases.get(key)
            except Exception as exc:  # noqa: BLE001 — an unreadable case still excludes
                logger.warning("exclusion could not read case %s: %s", key, exc)
                case = None
            if case is not None:
                rule_identity = case_rule_identity(case)
        marker = await self._exclusions.exclude(
            key,
            reason=reason,
            note=note,
            actor=actor,
            rule_identity=rule_identity,
            max_entries=self._exclusion_bound(),
        )
        if marker.get("capped"):
            return {
                "ok": False,
                "capped": True,
                "count": int(marker.get("count") or 0),
                "max_entries": self._exclusion_bound(),
                "reason": (
                    "the exclusion set is already at its bound of "
                    f"{self._exclusion_bound()} case(s) (four times the configured "
                    "precedent window). A deny list this deep means the corpus "
                    "composition itself needs a policy change rather than more "
                    "individual exclusions."
                ),
            }
        if not marker.get("ok"):
            return {"ok": False, "reason": "the exclusion marker could not be written"}
        # The marker is durable; adopt it in memory immediately so a projection that
        # starts before the next refresh already honours it.
        self._excluded_cases = frozenset(self._excluded_cases | {key})
        self._exclusions_loaded = True
        document_id = f"{RESOLVED_CASE_SOURCE}:{key}"
        removed = await self.delete_document(document_id, force=True)
        deleted = int(removed.get("deleted") or 0)
        complete = await self._precedent_is_gone(key, document_id)
        self.invalidate_precedent_distribution()
        return {
            "ok": True,
            "case_id": key,
            "document_id": document_id,
            "reason_code": normalise_exclusion_reason(reason),
            "already_excluded": bool(marker.get("already")),
            "deleted": deleted,
            "found": bool(removed.get("found")),
            # False when the marker landed but the chunks did not come out. The exclusion
            # is in force either way; re-issue the same call to finish the removal.
            #
            # VERIFIED BY RE-READ, never inferred from the delete's return value:
            # ``delete_document`` is fail-soft and answers "the store raised" with the
            # very same ``{deleted: 0, found: False}`` it uses for "no such document", so
            # deriving completeness from it reported a store outage as a finished
            # removal — the operator was told the precedent was gone while it was still
            # in the corpus and still being retrieved into prompts.
            "complete": complete,
            "count": int(marker.get("count") or 0),
            "max_entries": self._exclusion_bound(),
            "rule_identity": rule_identity,
        }

    async def _precedent_is_gone(self, case_id: str, document_id: str) -> bool:
        """Whether this case's precedent really has left the corpus. FAILS CLOSED.

        Re-reads the per-case document AND the pre-fix shared ``seed:resolved_case``
        grouping, because a deployment that indexed precedent before the per-case
        document-identity fix may still hold a chunk there. Anything that cannot be
        READ is reported INCOMPLETE: "I could not check" and "it is gone" are the two
        answers the previous inference conflated, and only the honest one prompts the
        documented re-issue.
        """
        try:
            if await self._store.list_chunks(document_id):
                return False
            legacy = await self._store.list_chunks(_LEGACY_RESOLVED_CASE_DOCUMENT)
        except Exception as exc:  # noqa: BLE001 — unverifiable is reported, not assumed
            logger.warning(
                "exclusion of %s could not be verified (%s); reporting it incomplete",
                case_id, exc,
            )
            return False
        return not any(
            str((chunk.metadata or {}).get("case_id") or "") == case_id
            for chunk in legacy
            if chunk.source == RESOLVED_CASE_SOURCE
        )

    async def restore_precedent_case(self, case_id: str) -> dict[str, Any]:
        """Drop an exclusion marker. The precedent returns on the NEXT projection.

        Nothing is written to the corpus here: restoring simply stops the projection
        skipping the case, so it is re-derived from the case store exactly as it would
        have been. That asymmetry is deliberate — an un-exclusion must not be able to
        mint a precedent chunk that the ordinary projection would not have produced.
        """
        key = str(case_id or "").strip()
        if not key:
            return {"ok": False, "reason": "a case id is required"}
        if self._exclusions is None:
            return {"ok": False, "reason": "this deployment has no durable exclusion store"}
        outcome = await self._exclusions.restore(key)
        if outcome.get("ok"):
            self._excluded_cases = frozenset(self._excluded_cases - {key})
            self.invalidate_precedent_distribution()
        return {
            "ok": bool(outcome.get("ok")),
            "case_id": key,
            "found": bool(outcome.get("found")),
            "count": int(outcome.get("count") or 0),
        }

    async def select_precedent_cases(self, filters: dict[str, Any]) -> dict[str, Any]:
        """Case ids whose CURRENT precedent chunks match every supplied metadata filter.

        Filters are exact matches on :data:`EXCLUSION_SELECTABLE_KEYS` — the projection's
        OWN metadata keys — and nothing else. A free-text rule-title match is deliberately
        not offered: titles are content that a detection-content update rewrites
        underneath the operator, so the same saved selection would silently pick a
        different population later. Read-only; selecting excludes nothing.
        """
        unknown = sorted(set(filters or {}) - set(EXCLUSION_SELECTABLE_KEYS))
        if unknown:
            return {
                "ok": False,
                "reason": (
                    "unsupported selection key(s): "
                    + ", ".join(unknown)
                    + "; selection filters on the projection's own metadata keys only"
                ),
                "case_ids": [],
                "count": 0,
                "truncated": False,
            }
        try:
            rows, truncated = await self._precedent_chunk_metadata()
        except Exception as exc:  # noqa: BLE001 — selection degrades, never raises
            logger.warning("precedent selection could not read the corpus: %s", exc)
            return {
                "ok": False,
                "reason": f"the precedent corpus could not be read ({type(exc).__name__})",
                "case_ids": [],
                "count": 0,
                "truncated": False,
            }
        wanted = {str(key): str(value).strip().lower() for key, value in (filters or {}).items()}
        limit = max(1, int(self._window_config().size)) * _EXCLUSION_SELECT_WINDOWS
        matched: list[str] = []
        seen: set[str] = set()

        def _match(row: dict[str, Any], key: str, value: str) -> bool:
            # Case-insensitive exact match on the stored scalar. Booleans are compared
            # as ``true``/``false`` so ``bulk_ratified=true`` works from a query string
            # without the caller having to know Python's ``True`` spelling.
            stored = row.get(key)
            if isinstance(stored, bool):
                return ("true" if stored else "false") == value
            return str(stored or "").strip().lower() == value

        for row in rows:
            if any(not _match(row, key, value) for key, value in wanted.items()):
                continue
            case_id = str(row.get("case_id") or "")
            if not case_id or case_id in seen:
                continue
            seen.add(case_id)
            matched.append(case_id)
        matched.sort()
        return {
            "ok": True,
            "reason": "",
            "case_ids": matched[:limit],
            "count": len(matched),
            "limit": limit,
            "selection_truncated": len(matched) > limit,
            # The CORPUS read itself may have been cut short by the backend, so the
            # selection is a lower bound rather than every matching precedent.
            "truncated": bool(truncated),
        }


    # ----------------------------------------------------------------- #
    # Precedent TEXT repair — re-render from the CURRENT builder, compare, rewrite.
    # ----------------------------------------------------------------- #
    def _repair_config(self) -> "PrecedentRepairConfig":
        """The repair bounds block (falls back to shipped defaults if absent)."""
        cfg = getattr(getattr(self._prefs, "precedent", None), "repair", None)
        if cfg is None:  # pragma: no cover - see below: not a stored-config case
            # NOT "a preference stored before this block existed": the field carries a
            # ``default_factory``, so validation refills it and a stored configuration
            # written without the key still arrives here complete. This branch exists
            # only for a caller that hands the service an object which is not a
            # validated ``Preferences`` at all, which is why it is unreachable from
            # the product's own configuration path.
            from ..config import PrecedentRepairConfig

            return PrecedentRepairConfig()
        return cfg

    def _repair_cap(self) -> int:
        """How many chunks ONE repair run may mutate.

        A MULTIPLE OF THE CONFIGURED WINDOW, never a constant — see
        ``_REPAIR_CAP_WINDOWS``. Embeddings are metered but deliberately NOT pre-flight
        budget-gated, so the shipped budget backstop cannot stop a runaway sweep; this
        bound is the only thing that can, and it has to be the operator's own scale
        rather than one estate's volume encoded here.
        """
        return max(1, int(self._window_config().size)) * _REPAIR_CAP_WINDOWS

    def _repair_eviction_floor(self) -> int:
        """The collapse guard's absolute eviction floor: the operator's, else derived."""
        pinned = int(getattr(self._repair_config(), "eviction_floor", 0) or 0)
        if pinned > 0:
            return pinned
        window = max(1, int(self._window_config().size))
        return max(1, window // _REPAIR_EVICTION_FLOOR_DIVISOR)

    def _reprojected_precedent_item(
        self, case: "Case", tier: str, stored: dict[str, Any]
    ) -> dict[str, Any] | None:
        """The item the CURRENT projector renders for ``case``, WITHIN ``tier``.

        Repair re-renders a chunk inside the tier it is already in and never moves one
        between tiers. A tier transition is an upsert the ordinary projection already
        performs — both tiers share the ``resolved_case:{case_id}`` document identity
        precisely so a later analyst confirmation replaces the lower-trust chunk in
        place — and letting a maintenance pass re-grade precedent instead would make
        "repair the text" silently mean "change what this chunk claims about its own
        provenance".

        ``None`` means the current projector produces NOTHING for this case in this
        tier: the analyst label was withdrawn, or the model never made a binary
        judgement. That is a report, never a delete (see :meth:`repair_precedent_projection`).
        """
        if tier == TRUST_MODEL_UNCONFIRMED:
            outcome = self._unconfirmed_outcome(case)
            if outcome is None:
                return None
            # ``recurrence`` is a POPULATION statistic counted over whatever the
            # projection scan happened to see, not a property of this case, so a TEXT
            # repair carries the stored one forward rather than minting a new one from
            # a different scan. It is metadata only and never reaches the chunk text.
            try:
                recurrence = int(stored.get("recurrence") or 0)
            except (TypeError, ValueError):
                recurrence = 0
            return self._unconfirmed_case_item(
                case, outcome=outcome, recurrence=recurrence
            )
        return self._resolved_case_item(case)

    async def _current_precedent_projection(
        self, case_id: str, tier: str, stored: dict[str, Any]
    ) -> dict[str, Any] | None:
        """What the CURRENT projector renders for this case, or ``None`` if unavailable.

        Returns the WHOLE item — text and metadata together — and never one half of
        it. The two are one rendering of one case: a caller that adopted the fresh
        text while keeping the stored metadata would leave a chunk whose sentence
        says one thing and whose ``verdict``/``outcome``/``rule_identity`` say
        another, and (worse) would make that chunk read as CURRENT to the
        derive-and-compare selector, which compares text. The mismatch would then be
        permanently unreachable by the one pass built to find drift.

        Collapses "unreadable", "absent" and "no longer projects" into one ``None``
        on purpose: the single caller — the vector-space migration's preserved-items
        path — must FALL BACK to the stored chunk for all three, never drop it. The
        explicit repair keeps those three apart because only one of them may delete.
        """
        if self._cases is None:
            return None
        try:
            case = await self._cases.get(case_id)
        except Exception as exc:  # noqa: BLE001 — a migration never fails on a case read
            logger.warning(
                "precedent text could not be re-derived for case %s: %s", case_id, exc
            )
            return None
        if case is None:
            return None
        return self._reprojected_precedent_item(case, tier, stored)

    async def _classify_precedent_text(
        self,
        chunks: list[StoredChunk],
        resolve: Callable[[str], Awaitable[tuple["Case | None", bool]]],
    ) -> list[PrecedentTextFinding]:
        """Classify every stored precedent chunk against the CURRENT projector.

        **THE SELECTOR IS DERIVE-AND-COMPARE, and it cannot be anything else.** No
        metadata key records which generation of the builder produced a chunk's text —
        runbooks carry a ``revision``, precedent carries nothing equivalent — so the
        only way to know whether stored text is current is to render the case again
        through the SAME projector the projection uses and compare the two strings.

        A prose selector is the tempting alternative and it is a corpus-destroying one.
        ``_unconfirmed_case_text`` renders the model's verdict sentence UNCONDITIONALLY
        for every lower-trust chunk, while ``tests/test_precedent_corpus.py`` asserts
        that same phrase never appears in the confirmed tier: one phrase, two opposite
        meanings. A substring match on it deletes an entire trust tier — one that is
        empty on most deployments, so nothing would notice until the deployment that
        did enable it lost the tier whole. Confirmed-tier text also carries the analyst
        note, the model's recommended action and log-derived evidence summaries, so any
        substring selector over precedent text is a selector over attacker- and
        operator-influenceable content (#9).

        ``resolve`` answers ``(case, readable)``. ``(None, True)`` is a POSITIVE "no
        such case"; ``(None, False)`` is "I could not tell". Conflating them is what
        turns a store outage into a mass deletion, so they stay separate all the way
        through.
        """
        findings: list[PrecedentTextFinding] = []
        seen: dict[str, tuple["Case | None", bool]] = {}
        for chunk in chunks:
            if chunk.source != RESOLVED_CASE_SOURCE:
                continue
            metadata = dict(chunk.metadata or {})
            case_id = str(metadata.get("case_id") or "")
            doc_id = str(chunk.doc_id or "")
            document_id = str(metadata.get("document_id") or "") or doc_id
            # A chunk with NO ``trust_class`` reads as CONFIRMED, exactly as
            # ``_is_unconfirmed`` has always treated it, so a legacy chunk keeps the
            # retrieval treatment it already has (#10). Tier is resolved through that
            # ONE predicate; a second tier test here could disagree with retrieval.
            tier = (
                TRUST_MODEL_UNCONFIRMED
                if self._is_unconfirmed(chunk)
                else TRUST_ANALYST_CONFIRMED
            )
            base = {
                "document_id": document_id,
                "doc_id": doc_id,
                "case_id": case_id,
                "tier": tier,
                "text": str(chunk.text or ""),
                "metadata": metadata,
            }
            if not case_id:
                findings.append(
                    PrecedentTextFinding(
                        **base,
                        classification=REPAIR_UNDETERMINED,
                        reason="the chunk carries no case id to re-derive from",
                    )
                )
                continue
            if not doc_id:
                # Without a durable chunk id the store cannot upsert in place, and
                # writing anyway would land a SECOND chunk beside the stale one under
                # the same document. Re-homing legacy chunks is the legacy-document
                # reconciliation's job, not this pass's.
                findings.append(
                    PrecedentTextFinding(
                        **base,
                        classification=REPAIR_UNDETERMINED,
                        reason="the stored chunk has no durable chunk id to rewrite in place",
                    )
                )
                continue
            if case_id not in seen:
                seen[case_id] = await resolve(case_id)
            case, readable = seen[case_id]
            if not readable:
                findings.append(
                    PrecedentTextFinding(
                        **base,
                        classification=REPAIR_UNDETERMINED,
                        reason="the backing case could not be read",
                    )
                )
                continue
            if case is None:
                findings.append(
                    PrecedentTextFinding(
                        **base,
                        classification=REPAIR_NOT_PROJECTING,
                        reason=REPAIR_ABSENT,
                    )
                )
                continue
            if self._is_case_excluded(case_id):
                findings.append(
                    PrecedentTextFinding(
                        **base,
                        classification=REPAIR_NOT_PROJECTING,
                        reason=REPAIR_EXCLUDED,
                    )
                )
                continue
            item = self._reprojected_precedent_item(case, tier, metadata)
            if item is None:
                findings.append(
                    PrecedentTextFinding(
                        **base,
                        classification=REPAIR_NOT_PROJECTING,
                        reason=REPAIR_WITHDRAWN,
                    )
                )
                continue
            if str(item.get("text") or "") == str(chunk.text or ""):
                findings.append(
                    PrecedentTextFinding(**base, classification=REPAIR_CURRENT)
                )
                continue
            # THE repair item. ``doc_id`` and ``metadata.document_id`` are the STALE
            # chunk's own, never the projector's freshly minted pair: ``_managed_items``
            # mints a TEXT-DERIVED chunk id whenever ``doc_id`` is absent, so a repair
            # that let the id drift would land the corrected chunk ALONGSIDE the stale
            # one under the same document and double it in every tally.
            repaired = dict(item)
            # Stored keys the projector does not mint are CARRIED FORWARD, projector
            # keys win on collision. The bulk-ratification stamp is the reason: it is
            # written by the bootstrap indexer, never by either projector, and it is
            # what keeps a ratified MODEL verdict distinguishable from independent
            # analyst ground truth. Dropping it while repairing a sentence would
            # silently erase that distinction — and it is a selectable exclusion key,
            # so an operator's saved selection would quietly stop matching.
            repaired_metadata = {**metadata, **dict(repaired.get("metadata") or {})}
            repaired_metadata["document_id"] = document_id
            repaired["metadata"] = repaired_metadata
            repaired["doc_id"] = doc_id
            findings.append(
                PrecedentTextFinding(
                    **base, classification=REPAIR_STALE, item=repaired
                )
            )
        return findings

    async def precedent_text_staleness(self, cases: list["Case"]) -> dict[str, Any]:
        """Per-tier stale-text counts for the read-only diagnostics surface.

        FREE by construction: ONE management read of the corpus, the already-fetched
        case page as the only case source, and the ordinary per-case projector. It
        embeds nothing, seeds nothing, writes nothing and deletes nothing.

        A case that is not on the supplied page is UNDETERMINED, never absent — a page
        is not the store, and reporting "the case is gone" from a bounded read is the
        exact inference that turns an eviction path into a data-loss path.
        """
        if self._cases is None or not self._prefs.rag.use_resolved_cases:
            return {
                "available": False,
                "reason": (
                    "the resolved-case precedent source is turned off, so no precedent "
                    "text is projected"
                ),
                "complete": False,
                "truncated": False,
                "scanned": 0,
                "stale": 0,
                "by_trust_class": {},
            }
        try:
            # Fail-OPEN, exactly like the composition report: refusing to describe the
            # corpus because a deny list could not be read helps nobody, and the
            # exclusion surface publishes its own ``available: false`` beside this one.
            await self._refresh_exclusions(force=True)
            chunks, truncated = await self._precedent_chunks()
        except Exception as exc:  # noqa: BLE001 — diagnostics degrade, never raise
            logger.warning("precedent staleness could not read the corpus: %s", exc)
            return {
                "available": False,
                "reason": f"the precedent corpus could not be read ({type(exc).__name__})",
                "complete": False,
                "truncated": False,
                "scanned": 0,
                "stale": 0,
                "by_trust_class": {},
            }
        page = {str(getattr(case, "case_id", "") or ""): case for case in cases or []}

        async def _resolve(case_id: str) -> tuple["Case | None", bool]:
            case = page.get(case_id)
            return (case, True) if case is not None else (None, False)

        findings = await self._classify_precedent_text(chunks, _resolve)
        tiers = _tally_precedent_findings(findings)
        undetermined = sum(int(t["undetermined"]) for t in tiers.values())
        stale = sum(int(t["stale"]) for t in tiers.values())
        for tier in tiers.values():
            tier["complete"] = bool(not truncated and not tier["undetermined"])
        return {
            "available": True,
            "reason": "",
            # False whenever the backend read may have been cut short, or any chunk's
            # case was off the fetched page: either way "0 stale" would be a claim the
            # measurement cannot support.
            "complete": bool(not truncated and undetermined == 0),
            "truncated": bool(truncated),
            "scanned": len(findings),
            "stale": stale,
            "by_trust_class": tiers,
        }

    async def repair_precedent_projection(
        self,
        *,
        dry_run: bool = True,
        on_evict: Callable[[dict[str, Any]], Awaitable[None]] | None = None,
    ) -> dict[str, Any]:
        """Re-render every stored precedent chunk from the CURRENT builder and, where
        the stored text differs, re-embed and upsert it IN PLACE.

        EXPLICIT ONLY. Nothing calls this — not ``ensure_seeded``, not ``_reseed``, not
        any projection. ``resolved_case`` is deliberately exempt from the stale sweep
        because its projection is a bounded WINDOW, so a chunk the window no longer
        covers is archived precedent, not a deletion; a repair that ran as a side effect
        of seeding would quietly re-acquire the authority that exemption removed.

        **COST.** A changed text means the embedded input changed, so the stored vector
        is wrong for it and MUST be recomputed — writing corrected text against a stale
        vector decouples the two permanently and silently, which is worse than the
        staleness. That makes this a real, ledgered provider spend of exactly one
        embedding per repaired chunk (#6), and embeddings are metered but deliberately
        NOT pre-flight budget-gated, so this pass carries its OWN window-derived bound
        (:meth:`_repair_cap`). A byte-identical re-render costs nothing: it is simply
        not written. ``dry_run`` is the DEFAULT and spends nothing at all.

        **REVERSIBILITY, stated honestly.** A repair is IDEMPOTENT and RE-DERIVABLE —
        running it again renders the same text from the same case — but it is NOT
        reversible to the prior render, because the store upserts and the prior render
        is by definition the stale one nobody wants back. For the DELETE path only, the
        evicted payload written to the append-only trail before removal IS the
        reconstruction path; ``on_evict`` is therefore mandatory for an eviction, and
        without it evictions are reported and skipped rather than performed.

        **WHAT IT MAY DELETE.** Exactly one thing: a chunk whose case is POSITIVELY
        ABSENT from the case store, established by a read that fails closed. An
        operator-EXCLUDED case and a case whose analyst label was WITHDRAWN both stop
        projecting too, and both are REPORTED — those are operator decisions whose home
        is the exclusion API, and deleting on them would turn "an analyst changed their
        mind" into data loss. Removal is verified by RE-READ through the existing
        fail-closed helper, never inferred from the delete's return value, which answers
        "the store raised" with the very same shape it uses for "no such document".

        **BOTH MUTATIONS ARE VERIFIED BY RE-READ.** The same argument applies to a
        repair: ``_embed_and_add`` reports how many chunks it handed to the store, not
        how many the store kept, so a repaired chunk is counted only once a read-back
        shows the new text under its own chunk id. Anything the read-back cannot show —
        including anything a truncated read could not reach — is reported in
        ``unverified_repairs`` and left counted as outstanding, so a partial write can
        never surface as ``ok: true``.
        """
        cap = self._repair_cap()
        report: dict[str, Any] = {
            "at": iso_now(),
            "dry_run": bool(dry_run),
            "ok": True,
            "refused": False,
            "reason_code": "",
            "reason": "",
            "complete": True,
            "truncated": False,
            "repair_cap": cap,
            "eviction_floor": self._repair_eviction_floor(),
            "eviction_fraction": float(
                getattr(self._repair_config(), "eviction_fraction", 0.0) or 0.0
            ),
            "scanned": 0,
            # The four classes, totalled over the tiers (see ``_settle``).
            "current": 0,
            "stale": 0,
            "undetermined": 0,
            "not_projecting": 0,
            "excluded": 0,
            "withdrawn": 0,
            "absent": 0,
            "would_repair": 0,
            "would_evict": 0,
            "mutated": 0,
            "repaired": 0,
            "evicted": 0,
            "remaining": 0,
            # Gateway calls, and the chunks those calls embedded. One batch is one
            # call; the ledgered spend is one embedding PER CHUNK.
            "embedding_calls": 0,
            "embedded_chunks": 0,
            "evictions_unrecorded": 0,
            "tiers": {
                TRUST_ANALYST_CONFIRMED: _empty_repair_tier(),
                TRUST_MODEL_UNCONFIRMED: _empty_repair_tier(),
            },
            "repaired_documents": [],
            "evicted_documents": [],
            "incomplete_evictions": [],
            #: Written, but not visible on the read-back that followed. Counted as
            #: outstanding rather than repaired.
            "unverified_repairs": [],
        }

        def _refuse(code: str, reason: str) -> dict[str, Any]:
            """A refusal is a REPORTED OUTCOME, never an exception (it must never be
            able to abort seeding), and it always leaves ``mutated == 0``."""
            report["ok"] = False
            report["refused"] = True
            report["reason_code"] = code
            report["reason"] = reason
            report["complete"] = False
            report["mutated"] = 0
            report["repaired"] = 0
            report["evicted"] = 0
            for tier in report["tiers"].values():
                tier["complete"] = False
                tier["repaired"] = 0
                tier["evicted"] = 0
            # Keep the CLASS totals: a refusal is a finding, and the counts that
            # triggered it are the operator's evidence for what to do next.
            for key in (
                "current",
                "stale",
                "undetermined",
                "not_projecting",
                "excluded",
                "withdrawn",
                "absent",
                "would_repair",
                "would_evict",
            ):
                report[key] = sum(
                    int(tier[key]) for tier in report["tiers"].values()
                )
            logger.warning("precedent repair REFUSED (%s): %s", code, reason)
            return report

        if self._cases is None:
            return _refuse(
                REPAIR_REFUSAL_NO_CASE_STORE,
                "no case store is wired, so no precedent text can be re-derived",
            )
        try:
            # The same discipline every producer follows: an UNKNOWN exclusion set is
            # not an empty one, and re-rendering a chunk for a case an operator excluded
            # would put excluded precedent back into a current-looking state.
            await self._require_exclusions(force=True)
        except Exception as exc:  # noqa: BLE001 — reported, never raised
            return _refuse(REPAIR_REFUSAL_EXCLUSIONS_UNKNOWN, str(exc))
        try:
            stored_space = await self._store.embedding_space()
            chunks, truncated = await self._precedent_chunks()
        except Exception as exc:  # noqa: BLE001
            return _refuse(
                REPAIR_REFUSAL_CORPUS_UNREADABLE,
                f"the precedent corpus could not be read ({type(exc).__name__})",
            )
        report["truncated"] = bool(truncated)
        configured_model = str(self._embedding_space()[0])
        if stored_space is not None and str(stored_space[0] or "") != configured_model:
            # The corpus is already due for a whole-space migration, which re-derives
            # every chunk from the current builder anyway. Repairing text into the old
            # space would be spend that the very next reseed throws away, and it would
            # mix two incomparable spaces in the meantime.
            return _refuse(
                REPAIR_REFUSAL_EMBEDDING_SPACE,
                f"the corpus holds {stored_space[0]!r} vectors but "
                f"{configured_model!r} is configured; the ordinary reseed owns that "
                "migration and re-derives every chunk from the current builder",
            )

        cases = self._cases

        async def _resolve(case_id: str) -> tuple["Case | None", bool]:
            try:
                return await cases.get(case_id), True
            except Exception as exc:  # noqa: BLE001 — unreadable is NEVER "absent"
                logger.warning(
                    "precedent repair could not read case %s: %s", case_id, exc
                )
                return None, False

        findings = await self._classify_precedent_text(chunks, _resolve)
        tiers = _tally_precedent_findings(findings)
        report["tiers"] = tiers
        report["scanned"] = len(findings)

        stale = sorted(
            (f for f in findings if f.classification == REPAIR_STALE),
            key=lambda f: (f.tier, f.doc_id),
        )
        evictable = sorted(
            (
                f
                for f in findings
                if f.classification == REPAIR_NOT_PROJECTING
                and f.reason == REPAIR_ABSENT
            ),
            key=lambda f: (f.tier, f.doc_id),
        )
        # Repairs first, then evictions with whatever budget is left: the pass exists to
        # correct text, and a run that spent its whole allowance deleting would report
        # the corpus repaired while every stale chunk it never reached is still served.
        to_repair = stale[:cap]
        to_evict = evictable[: max(0, cap - len(to_repair))]
        for finding in to_repair:
            tiers[finding.tier]["would_repair"] += 1
        for finding in to_evict:
            tiers[finding.tier]["would_evict"] += 1

        # ---- the guards, evaluated on the UNCAPPED intent and BEFORE any write ---- #
        #
        # Uncapped on purpose: judging them on what this run happens to fit inside its
        # budget would let a large eviction walk past both guards a few chunks at a time.
        floor = int(report["eviction_floor"])
        fraction = float(report["eviction_fraction"])
        for name, tier in tiers.items():
            stored = int(tier["scanned"])
            intent = int(tier["absent"])
            if not stored or not intent:
                continue
            if intent >= stored:
                # UNCONDITIONAL AND UNTUNABLE, exactly like the empty-projection refusal:
                # no configuration may let a maintenance pass empty a trust tier.
                return _refuse(
                    REPAIR_REFUSAL_TIER_EMPTIED,
                    f"the run would remove all {stored} stored {name} precedent "
                    "chunk(s); a maintenance pass may never empty a tier",
                )
            if intent > floor and intent > fraction * stored:
                # The shared projection collapse guard is structurally blind here: it is
                # a SIZE guard over the FULLY RECONCILED sources, and ``resolved_case``
                # is deliberately outside its scope. This pass therefore carries its own.
                return _refuse(
                    REPAIR_REFUSAL_MASS_EVICTION,
                    f"the run would remove {intent} of {stored} stored {name} "
                    f"precedent chunk(s), above both the floor of {floor} and "
                    f"{fraction:.2f} of the tier; a removal that large is a case-store "
                    "problem, not corpus drift",
                )

        undetermined = sum(int(t["undetermined"]) for t in tiers.values())
        unreached = (len(stale) - len(to_repair)) + (len(evictable) - len(to_evict))

        def _settle() -> dict[str, Any]:
            report["remaining"] = unreached
            # The four classes, and the two intents, also totalled across the tiers:
            # the per-tier breakdown is the one that matters for the guards, but a
            # reader asking "is anything stale at all" should not have to add up.
            for key in (
                "current",
                "stale",
                "undetermined",
                "not_projecting",
                "excluded",
                "withdrawn",
                "absent",
                "would_repair",
                "would_evict",
            ):
                report[key] = sum(int(tier[key]) for tier in tiers.values())
            for tier in tiers.values():
                tier_left = (
                    int(tier["stale"]) - int(tier["would_repair"])
                ) + (int(tier["absent"]) - int(tier["would_evict"]))
                tier["remaining"] = tier_left
                tier["complete"] = bool(
                    not truncated and tier_left == 0 and not tier["undetermined"]
                )
            report["complete"] = bool(
                not truncated and unreached == 0 and undetermined == 0
            )
            # A PARTIAL repair is never a success: a truncated read, an undetermined
            # chunk or an unreached candidate all mean "0 stale remain" is unsupportable.
            report["ok"] = bool(report["complete"])
            return report

        if dry_run:
            # A dry run reports the INTENT, including an intended eviction, so the
            # operator sees what a real run would do before they authorise one.
            for tier in tiers.values():
                tier["repaired"] = 0
                tier["evicted"] = 0
            return _settle()

        if to_evict and on_evict is None:
            # No audit sink, no eviction: the evicted payload is the ONLY reconstruction
            # path, so removing a chunk without first recording it is unrecoverable.
            report["evictions_unrecorded"] = len(to_evict)
            for finding in to_evict:
                tiers[finding.tier]["would_evict"] -= 1
            unreached += len(to_evict)
            to_evict = []

        # ---- the writes ---------------------------------------------------- #
        if to_repair:
            items = [dict(finding.item or {}) for finding in to_repair]
            try:
                await self._embed_and_add(items)
            except EmbeddingSpaceMismatch as exc:
                # INHERITED, never bypassed: ``_embed_items`` validates the whole batch
                # before ``_store.add``, so a degraded provider aborts the run with
                # nothing written rather than persisting hash-space vectors.
                return _refuse(REPAIR_REFUSAL_EMBEDDING_DEGRADED, str(exc))
            except Exception as exc:  # noqa: BLE001
                return _refuse(
                    REPAIR_REFUSAL_CORPUS_UNREADABLE,
                    f"the repaired chunks could not be written ({type(exc).__name__})",
                )
            # ``_embed_items`` sends the WHOLE batch in one ``embed_with_provenance``
            # call, so a repair of any size is one gateway call — while the SPEND is
            # one embedding per chunk. The two numbers answer different questions and
            # are reported separately; conflating them under either name misleads in
            # one direction or the other.
            report["embedding_calls"] = 1 if items else 0
            report["embedded_chunks"] = len(items)
            # VERIFIED BY RE-READ, for the same reason the eviction is: a store's own
            # return value is not evidence. ``_embed_and_add`` answers "how many chunks
            # did I hand to ``add``", not "how many did the store persist", so a partial
            # or silently-failed write would otherwise be reported as
            # ``repaired: N, ok: true, complete: true`` — the projection path already
            # refuses to trust that seam (``_verify_projection``) and this one must not
            # either. ONE more whole-corpus read, never a per-document fan-out (A10).
            try:
                landed_chunks, _readback_truncated = await self._precedent_chunks()
            except Exception as exc:  # noqa: BLE001 — unverifiable, never assumed
                # NOT a refusal. A refusal promises ``mutated == 0``, and the write has
                # already happened by this point — saying "nothing changed" because the
                # verifying read failed would be a stronger claim than the failure
                # supports. Every attempted repair simply goes unverified below.
                logger.warning(
                    "precedent repair could not verify its own write (%s); every "
                    "repaired chunk is reported unverified",
                    exc,
                )
                landed_chunks = []
            landed = {
                str(chunk.doc_id or ""): str(chunk.text or "")
                for chunk in landed_chunks
            }
            for finding in to_repair:
                expected = str((finding.item or {}).get("text") or "")
                if finding.doc_id and landed.get(finding.doc_id) == expected:
                    report["repaired"] += 1
                    tiers[finding.tier]["repaired"] += 1
                    report["repaired_documents"].append(finding.document_id)
                    continue
                # Unproven, never assumed. A chunk the read-back cannot show is
                # reported as still outstanding — which keeps ``complete``/``ok``
                # false — rather than counted as a success nobody verified. A
                # truncated read-back lands here too, and that is the correct
                # answer: "I could not check" is not "it worked".
                report["unverified_repairs"].append(finding.document_id)
                tiers[finding.tier]["would_repair"] -= 1
                unreached += 1

        for finding in to_evict:
            payload = {
                "document_id": finding.document_id,
                "doc_id": finding.doc_id,
                "case_id": finding.case_id,
                "trust_class": finding.tier,
                "text": finding.text,
                "metadata": dict(finding.metadata or {}),
            }
            try:
                await on_evict(payload)  # type: ignore[misc] — None is handled above
            except Exception as exc:  # noqa: BLE001 — no record, no removal
                logger.error(
                    "precedent repair could not record the evicted payload for %s (%s); "
                    "the chunk was left in place",
                    finding.document_id,
                    exc,
                )
                tiers[finding.tier]["would_evict"] -= 1
                report["evictions_unrecorded"] += 1
                unreached += 1
                continue
            await self.delete_document(finding.document_id, force=True)
            if not await self._precedent_is_gone(finding.case_id, finding.document_id):
                # Verified by RE-READ. The delete's return value cannot tell a store
                # outage apart from "no such document", and the Elasticsearch backend
                # short-counts silently on a partial failure.
                report["incomplete_evictions"].append(finding.document_id)
                tiers[finding.tier]["would_evict"] -= 1
                unreached += 1
                continue
            report["evicted"] += 1
            tiers[finding.tier]["evicted"] += 1
            report["evicted_documents"].append(finding.document_id)

        report["mutated"] = int(report["repaired"]) + int(report["evicted"])
        if report["mutated"]:
            # The TENTH invalidation site. A cached per-rule distribution that outlives
            # this write serves counts from before the repair for the whole TTL, and the
            # failure is silent.
            self.invalidate_precedent_distribution()
        return _settle()

    async def rag_stats(self) -> dict[str, Any]:
        """Corpus stats: total chunks, count by source, embedding model + dim, and
        the document count. Never raises."""
        try:
            await self.ensure_seeded()
            stats = await self._store.stats()
            docs = await self._store.list_documents()
            stats["document_count"] = len(docs)
            return stats
        except Exception as exc:  # noqa: BLE001
            logger.warning("RAG rag_stats failed: %s", exc)
            return {
                "total_chunks": 0,
                "by_source": {},
                "embedding_model": "",
                "dim": 0,
                "document_count": 0,
            }

    async def retrieve(self, query: str, top_k: int | None = None) -> list[RagChunk]:
        """Return the top-k most relevant chunks for ``query``. Never raises.

        Hybrid (MemPalace-inspired): the vector search is the FLOOR — survivors that
        clear ``min_score`` (on the raw vector score) are re-ranked by a convex blend
        of vector similarity and a dependency-free BM25 lexical score, which recovers
        exact-token matches (IPs, hashes, rule names) that embed as noise. With
        ``rag.hybrid`` off this is byte-for-byte the prior vector-only behaviour.

        On an embedding-space mismatch (model/dim changed) the store is CLEARED +
        reseeded once, then the query is retried — vectors are never truncated.

        Callers that must distinguish a confirmed zero-hit search from an outage use
        :meth:`retrieve_observed`; this compatibility method deliberately retains the
        original fail-soft list contract.
        """
        return (await self.retrieve_observed(query, top_k=top_k)).chunks

    async def retrieve_observed(
        self, query: str, top_k: int | None = None
    ) -> RagRetrievalObservation:
        """Return chunks plus whether a complete search actually ran.

        A successful search that produces no policy-eligible survivor is measured.
        Disabled RAG, failed seeding, an empty/unavailable corpus, a missing query
        embedding, or any store/search failure is explicitly unmeasured.
        """
        cfg = self._prefs.rag
        if not cfg.enabled:
            return RagRetrievalObservation([], False, "rag_disabled")
        try:
            await self.ensure_seeded()
            # Seeding is intentionally fail-soft and preserves the last known-good
            # corpus. Keep using that corpus to ground the investigation, but never
            # label the resulting count measured when its projection is unverified.
            unavailable_reason = (
                None
                if self._seeded and self._seed_signature == self._source_signature()
                else "seeding_failed"
            )
            store_count = await self._store.count()
            if store_count == 0:
                # SELF-HEAL. An empty corpus with a satisfied seed cache is the dead
                # end this whole class of incident ends in: ``ensure_seeded`` believes
                # it is done, so nothing ever rebuilds and every investigation runs
                # with zero knowledge and zero precedent — indefinitely. Once, clear
                # the cache and rebuild, so a corpus that was lost (or refused during
                # a provider outage) comes back on its own the moment the provider
                # does. Bounded to ONE attempt per retrieval so it can never become a
                # reseed storm, and honest when the retry also yields nothing.
                if self._seeded:
                    logger.error(
                        "RAG corpus is EMPTY while seeding reported complete; "
                        "invalidating the seed cache and rebuilding once"
                    )
                    self._seeded = False
                    self._seed_signature = None
                    await self.ensure_seeded()
                    store_count = await self._store.count()
                    unavailable_reason = (
                        None
                        if self._seeded and self._seed_signature == self._source_signature()
                        else "seeding_failed"
                    )
                if store_count == 0:
                    # We attempted a rebuild and the corpus is STILL empty while an
                    # investigation needs it. That is unambiguously a degradation.
                    self.corpus_known_empty = True
                    self.corpus_degraded = self._any_source_enabled()
                    return RagRetrievalObservation(
                        [], False, unavailable_reason or "corpus_empty"
                    )
            self.corpus_known_empty = False
            self.corpus_degraded = False
            k = top_k or cfg.top_k
            # Over-fetch a candidate pool for hybrid re-ranking; identical to ``k``
            # when hybrid is disabled. Source filtering gets a small bounded cushion
            # so a disabled imported source cannot crowd every useful result, without
            # ever turning one retrieval into an unbounded full-corpus scan.
            pool_k = max(k * cfg.hybrid_overfetch, k) if cfg.hybrid else k
            pool_k = min(store_count, max(pool_k, k * 4))
            batch = await self._gateway.embed_with_provenance(
                [query], self._prefs.model_for("embedding"), surface="rag"
            )
            vectors = batch.vectors
            if not vectors:
                return RagRetrievalObservation([], False, "embedding_unavailable")
            try:
                space = await self._store.embedding_space()
                query_space = (batch.model, len(vectors[0]))
                if space is not None and space != query_space:
                    raise EmbeddingSpaceMismatch(
                        f"query space {query_space} != stored space {space}"
                    )
                results = await self._store.search(vectors[0], pool_k)
            except EmbeddingSpaceMismatch as exc:
                logger.warning("Embedding-space mismatch (%s); clearing + reseeding", exc)
                await self._reseed()
                if await self._store.count() == 0:
                    return RagRetrievalObservation([], False, "corpus_empty_after_reseed")
                results = await self._store.search(vectors[0], pool_k)
            # min_score gates on the RAW vector score (so disabling hybrid, or a
            # too-strict threshold, behaves exactly as before).
            survivors = [
                (c, float(s))
                for c, s in results
                if self._source_enabled(c.source) and float(s) >= cfg.min_score
            ]
            if not survivors:
                return RagRetrievalObservation(
                    [], unavailable_reason is None, unavailable_reason or "completed"
                )
            # The lower-trust tier is filtered BEFORE ranking so a disabled or aged-out
            # chunk cannot consume a candidate slot. No-op when nothing unconfirmed is
            # in the pool, which is every deployment that never enabled the tier.
            # DEFENCE IN DEPTH for exclusion: drop any chunk whose case is on the deny
            # list, whatever the corpus still physically holds. Exclusion is enforced by
            # the producers and by a delete, but a delete that could not complete (or a
            # chunk resurrected before this release) would otherwise keep reaching the
            # model — and one exclusion reason is precisely "this must not appear in
            # retrieved context at all". Pure in-memory filter: no I/O, and a no-op on
            # every deployment with an empty deny list.
            survivors = self._filter_excluded_precedent(survivors)
            survivors = self._filter_unconfirmed(survivors)
            if not survivors:
                return RagRetrievalObservation(
                    [], unavailable_reason is None, unavailable_reason or "completed"
                )
            if cfg.hybrid and len(survivors) > 1:
                ranked = _hybrid_rerank(query, survivors, cfg.vector_weight, cfg.bm25_weight)
            else:
                ranked = survivors
            ranked = self._apply_precedent_policy(ranked, k)
            chunks = [
                RagChunk(
                    text=chunk.text,
                    source=chunk.source,
                    score=float(score),
                    metadata=dict(chunk.metadata),
                )
                for chunk, score in ranked[:k]
            ]
            return RagRetrievalObservation(
                chunks, unavailable_reason is None, unavailable_reason or "completed"
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("RAG retrieve failed for query %r: %s", query, exc)
            return RagRetrievalObservation([], False, "retrieval_failed")

    # ------------------------------------------------------------------ #
    # Retrieval-side precedent policy (the anti-compounding half of the tier).
    # ------------------------------------------------------------------ #
    @staticmethod
    def _is_unconfirmed(chunk: Any) -> bool:
        """Whether a stored chunk is lower-trust precedent.

        ONLY an explicit ``trust_class == "model_unconfirmed"`` counts. Every chunk
        written before this tier existed — including ones with no ``trust_class`` at
        all — keeps its previous treatment exactly, so an existing corpus behaves
        byte-identically (#10)."""
        if getattr(chunk, "source", None) != RESOLVED_CASE_SOURCE:
            return False
        metadata = getattr(chunk, "metadata", None) or {}
        return str(metadata.get("trust_class") or "") == TRUST_MODEL_UNCONFIRMED

    def _filter_unconfirmed(
        self, survivors: list[tuple[Any, float]]
    ) -> list[tuple[Any, float]]:
        """Drop lower-trust precedent that must not reach a prompt.

        Two independent reasons, both enforced HERE rather than only at projection
        time, because ``resolved_case`` is deliberately exempt from the stale sweep —
        a chunk that is already in the vector store stays there:

        * the tier is switched off (so flipping the preference back is immediate and
          complete, even for precedent indexed while it was on); or
        * the case aged out of ``max_age_days`` (unconfirmed precedent is provisional
          and must go quiet on schedule unless a human confirms it).
        """
        unconfirmed = [pair for pair in survivors if self._is_unconfirmed(pair[0])]
        if not unconfirmed:
            return survivors
        if not self._unconfirmed_enabled():
            return [pair for pair in survivors if not self._is_unconfirmed(pair[0])]
        guards = self._unconfirmed_cfg()
        horizon = datetime.now(timezone.utc) - timedelta(days=int(guards.max_age_days))
        kept: list[tuple[Any, float]] = []
        for chunk, score in survivors:
            if self._is_unconfirmed(chunk):
                terminal_at = _parse_iso((chunk.metadata or {}).get("terminal_at"))
                if terminal_at is None or terminal_at < horizon:
                    continue
            kept.append((chunk, score))
        return kept

    def _apply_precedent_policy(
        self, ranked: list[tuple[Any, float]], k: int
    ) -> list[tuple[Any, float]]:
        """Demote, order and cap the lower-trust tier. No-op without one in the pool.

        Three separate protections, in the order they must be applied:

        1. ``rank_penalty`` scales an unconfirmed chunk's final score, so it has to be
           clearly more relevant than static knowledge to earn a slot at all.
        2. The TIER INVARIANT: no unconfirmed precedent may ever be placed above an
           analyst-confirmed precedent. Implemented by reordering only the positions
           that precedent already occupies, so its interleaving with runbook/MITRE
           knowledge is untouched — a real analyst decision simply always comes first.
        3. ``max_context_share`` caps how many of the final ``k`` chunks may be
           unconfirmed (``floor(k * share)``), so a retrieval can never be dominated by
           an echo of the model's own prior output.
        """
        if not any(self._is_unconfirmed(chunk) for chunk, _ in ranked):
            return ranked
        guards = self._unconfirmed_cfg()

        penalised = [
            (chunk, score * float(guards.rank_penalty) if self._is_unconfirmed(chunk) else score)
            for chunk, score in ranked
        ]
        penalised.sort(key=lambda pair: pair[1], reverse=True)

        # Tier invariant — reorder the precedent PAIRS within the slots precedent
        # already holds (each chunk keeps its own score).
        positions = [
            i for i, (chunk, _) in enumerate(penalised)
            if getattr(chunk, "source", None) == RESOLVED_CASE_SOURCE
        ]
        if len(positions) > 1:
            precedent = [penalised[i] for i in positions]
            precedent.sort(key=lambda pair: 1 if self._is_unconfirmed(pair[0]) else 0)
            for slot, pair in zip(positions, precedent):
                penalised[slot] = pair

        allowance = math.floor(max(0, int(k)) * float(guards.max_context_share))
        out: list[tuple[Any, float]] = []
        used = 0
        for chunk, score in penalised:
            if self._is_unconfirmed(chunk):
                if used >= allowance:
                    continue
                used += 1
            out.append((chunk, score))
        return out

    async def _reseed(self) -> None:
        """Migrate the corpus safely after an embedding-space change.

        Replacement embeddings are staged before the existing space is cleared.
        Operator imports are re-embedded alongside the managed corpus, and a complete
        old-space snapshot is restored if the replacement write or read-back fails.
        """
        async with self._seed_lock:
            # Same contract as ``ensure_seeded``: refresh inside the lock, before any
            # producer runs. This path matters most — it is the one that re-embeds
            # precedent straight from the pre-migration snapshot, so an UNKNOWN set here
            # would resurrect every exclusion in one write. Raising leaves the corpus in
            # its current space, which the caller already reports as unmeasured.
            await self._require_exclusions(force=True)
            backup = await self._snapshot_store_chunks()
            outgoing = await self._chunk_counts_by_source()
            cleared = False
            try:
                seeds = await self._enabled_seeds()
                if self._prefs.rag.use_resolved_cases:
                    seeds.extend(await self._resolved_case_items())
                    seeds.extend(await self._unconfirmed_precedent_addition(seeds))
                seeds.extend(self._operator_items_from_snapshot(backup))
                managed = self._managed_items(seeds)
                # Precedent outside the bounded window would otherwise be silently
                # dropped by the space migration. Carry it over, skipping anything
                # the freshly derived window already covers so the replacement never
                # contains two chunks with one doc id (which would collapse on upsert
                # and trip the persisted-count check below).
                staged_doc_ids = {str(item.get("doc_id") or "") for item in managed}
                managed.extend(
                    item
                    for item in self._managed_items(
                        await self._preserved_resolved_case_items(backup)
                    )
                    if str(item.get("doc_id") or "") not in staged_doc_ids
                )
                replacement = await self._embed_items(managed)
                # A vector-space migration is the one path that must physically clear
                # the store, so an empty replacement here is unrecoverable rather than
                # merely wrong. Refuse BEFORE the clear (nothing has been destroyed
                # yet, so this needs no rollback).
                #
                # UNSCOPED on purpose: unlike ``ensure_seeded``, this replacement is a
                # whole-store rebuild — it re-embeds operator imports and carries over
                # preserved precedent — so the whole corpus is the right comparison.
                self._guard_projection_collapse(outgoing, replacement)

                await self._store.clear()
                cleared = True
                if await self._store.count() != 0:
                    raise RuntimeError("RAG vector space could not be cleared for migration")
                if replacement:
                    await self._store.add(replacement)
                if await self._store.count() != len(replacement):
                    raise RuntimeError("RAG vector-space replacement was only partially persisted")
                await self._verify_projection(replacement)
                if self._runbooks is not None:
                    for record in await self._runbooks.list():
                        await self._runbooks.mark_indexed(record.runbook.id, record.revision)
                self._seeded = True
                self._seed_signature = self._source_signature()
                # A vector-space migration rewrites every precedent chunk.
                self.invalidate_precedent_distribution()
                self._record_projection_outcome(
                    outgoing, await self._chunk_counts_by_source()
                )
                await self._persist_projection_health()
            except Exception as exc:
                self._seeded = False
                self._seed_signature = None
                # A migration refused for collapse is the same corpus-destroying
                # outcome as in ensure_seeded, and must leave the same first-class
                # record rather than being flattened into a generic migration error.
                if isinstance(exc, ProjectionCollapsed):
                    logger.error(
                        "RAG vector-space migration REFUSED (%s) — the existing corpus "
                        "was preserved: %s",
                        getattr(exc, "reason_code", REFUSAL_EMPTY_PROJECTION),
                        exc,
                    )
                    await self._record_projection_refusal(
                        outgoing,
                        str(exc),
                        reason_code=getattr(exc, "reason_code", REFUSAL_EMPTY_PROJECTION),
                    )
                if cleared:
                    try:
                        await self._store.clear()
                        if await self._store.count() != 0:
                            raise RuntimeError("replacement vector space did not clear")
                        if backup:
                            await self._store.add(backup)
                        if await self._store.count() != len(backup):
                            raise RuntimeError("rollback vector space was only partially restored")
                    except Exception as restore_exc:  # noqa: BLE001
                        logger.error("RAG vector-space rollback failed: %s", restore_exc)
                        raise RuntimeError(
                            "RAG vector-space migration and rollback both failed"
                        ) from restore_exc
                raise RuntimeError(
                    "RAG vector-space migration failed; prior corpus preserved"
                ) from exc


# --------------------------------------------------------------------------- #
# Hybrid re-ranking (dependency-free BM25 over the vector candidate pool).
# --------------------------------------------------------------------------- #
# Tokens keep '.', '-', '_' so IPs/hashes/domains/rule-names stay whole, but split
# on ':' so an "ip:1.2.3.4" label/value (or host:port) yields a matchable bare value.
_TOKEN_RE = re.compile(r"[a-z0-9][a-z0-9._-]*")


def _tokenize(text: str) -> list[str]:
    return [t for t in _TOKEN_RE.findall(text.lower()) if len(t) >= 2]


def _minmax(values: list[float]) -> list[float]:
    if not values:
        return []
    lo, hi = min(values), max(values)
    if hi - lo < 1e-12:
        return [1.0 for _ in values]  # all equal → don't zero them out
    return [(v - lo) / (hi - lo) for v in values]


def _hybrid_rerank(
    query: str,
    survivors: list[tuple[Any, float]],
    vector_weight: float,
    bm25_weight: float,
    *,
    k1: float = 1.5,
    b: float = 0.75,
) -> list[tuple[Any, float]]:
    """Re-rank a vector candidate pool by ``vw*vector_norm + bw*bm25_norm``.

    BM25 (Okapi) is computed corpus-relative over the candidate pool only — the
    chunk text plus its metadata (so an exact IOC/case-id token in metadata counts).
    Both score families are min-max normalised before blending so the weights mean
    what they say. Returns (chunk, combined_score) sorted descending."""
    q_tokens = set(_tokenize(query))
    docs = [_tokenize(f"{c.text} {c.source} {c.metadata}") for c, _ in survivors]
    n = len(docs)
    avgdl = sum(len(d) for d in docs) / n if n else 0.0
    df: dict[str, int] = {}
    for d in docs:
        for tok in set(d):
            if tok in q_tokens:
                df[tok] = df.get(tok, 0) + 1

    bm25_scores: list[float] = []
    for d in docs:
        dl = len(d)
        score = 0.0
        if dl and q_tokens:
            counts: dict[str, int] = {}
            for tok in d:
                if tok in q_tokens:
                    counts[tok] = counts.get(tok, 0) + 1
            for tok, f in counts.items():
                idf = math.log(1 + (n - df[tok] + 0.5) / (df[tok] + 0.5))
                denom = f + k1 * (1 - b + b * (dl / avgdl if avgdl else 1.0))
                score += idf * (f * (k1 + 1)) / denom if denom else 0.0
        bm25_scores.append(score)

    vec_norm = _minmax([v for _, v in survivors])
    bm25_norm = _minmax(bm25_scores)
    combined = [
        (survivors[i][0], vector_weight * vec_norm[i] + bm25_weight * bm25_norm[i])
        for i in range(n)
    ]
    combined.sort(key=lambda t: t[1], reverse=True)
    return combined


class RagTool(Tool):
    name = "rag_retrieve"
    description = (
        "Retrieve relevant SOC knowledge — runbooks, MITRE ATT&CK techniques and "
        "suppression guidance — for an investigation query. Returns the most "
        "similar knowledge-base snippets to ground the analysis."
    )
    input_schema = {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "what to look up"},
            "top_k": {"type": "integer", "description": "max snippets to return"},
        },
        "required": ["query"],
        "additionalProperties": False,
    }

    def __init__(self, rag: RagService) -> None:
        self._rag = rag

    async def run(self, query: str = "", top_k: int | None = None, **kwargs: Any) -> ToolResult:
        await self._rag.ensure_seeded()
        chunks = await self._rag.retrieve(query, top_k=top_k)
        if chunks:
            sources = ", ".join(sorted({c.source for c in chunks}))
            summary = f"Retrieved {len(chunks)} knowledge snippet(s) ({sources})."
        else:
            summary = "No relevant knowledge found."
        return ToolResult(
            ok=True,
            summary=summary,
            data=[chunk.model_dump() for chunk in chunks],
            query=query,
            meta={"count": len(chunks)},
        )
