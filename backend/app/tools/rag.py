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
from typing import TYPE_CHECKING, Any

from ..config import Preferences
from ..constants import CaseStatus, DecisionBy, Verdict
from ..engine.analyst_outcomes import analyst_confirmed_outcome
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
from ..llm.gateway import LLMGateway
from ..models import RagChunk
from ..utils import iso_now
from .base import Tool, ToolResult
from .vectorstore import (
    EmbeddingSpaceMismatch,
    InMemoryVectorStore,
    StoredChunk,
    VectorStore,
)

if TYPE_CHECKING:  # pragma: no cover - typing only
    from ..config import PrecedentWindowConfig, UnconfirmedPrecedentConfig
    from ..engine.runbook_service import RunbookService
    from ..models import Case
    from ..stores.cases import CaseStore

logger = logging.getLogger("tlsoc.tools.rag")

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

# Bounded scan for the precedent projection. The window counts QUALIFYING
# (analyst-confirmed) cases, not raw terminal ones, so an autonomous deployment's
# own unlabelled auto-closes can no longer evict every precedent; the scan cap keeps
# that search bounded when the unlabelled backlog is large.
_RESOLVED_CASE_PAGE_SIZE = 200
_RESOLVED_CASE_SCAN_CAP = 5000

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

# The Elasticsearch vector store reads its corpus through one bounded document scan.
# A corpus AT that ceiling may have been cut short, so every count derived from it is
# reported as a lower bound rather than a confident total.
_CORPUS_SCAN_TRUNCATION_HINT = 10000

# Bound the one-time rule-identity re-tag of pre-existing precedent so a large legacy
# corpus costs a bounded management read per projection rather than an unbounded one.
_RULE_IDENTITY_RECONCILE_CAP = 2000

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
    ) -> None:
        self._gateway = gateway
        self._prefs = prefs
        self._store: VectorStore = store or InMemoryVectorStore()
        self._cases = cases
        self._runbooks = runbooks
        self._seeded = False
        self._seed_signature: tuple[Any, ...] | None = None
        self._seed_lock = asyncio.Lock()
        # Last projection outcome PER SOURCE, so a health surface can show that a
        # re-seed shrank (or collapsed) a corpus instead of that fact living only in
        # a log line. Shape per source:
        #   {source, before, after, delta, shrank, collapsed, source_enabled, at}
        # ``before``/``after`` are stored chunk counts either side of the projection.
        self.last_projection: dict[str, dict[str, Any]] = {}
        # Cached per-rule analyst-confirmed precedent distribution + the monotonic
        # instant it was computed. In-process only and TTL-bounded; every precedent
        # write invalidates it, so a stale count can never outlive a corpus change.
        self._precedent_distribution: PrecedentDistribution | None = None
        self._precedent_distribution_at: float | None = None

    def set_prefs(self, prefs: Preferences) -> None:
        """Point the service at the latest preferences so a live settings change
        (e.g. toggling rag.enabled / use_resolved_cases / min_score) takes effect
        without a full rewire."""
        self._prefs = prefs
        # A precedent-source or window change can change what the distribution counts.
        self.invalidate_precedent_distribution()

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
            self._window_config().model_dump_json(),
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
        return [
            StoredChunk(
                text=s["text"],
                source=s.get("source", "unknown"),
                metadata={
                    **dict(s.get("metadata", {})),
                    "embedding_provider": batch.provider,
                    "embedding_fallback": batch.fallback,
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

    @staticmethod
    def _preserved_resolved_case_items(chunks: list[StoredChunk]) -> list[dict[str, Any]]:
        """Carry EXISTING precedent through a vector-space migration.

        ``_reseed`` physically replaces the vector space, and the precedent it can
        re-derive from the CaseStore is only the bounded window. Re-embedding the
        stored precedent chunks keeps everything older than that window alive; the
        freshly derived window wins on doc-id collision so the canonical text is
        still the shared builder's.
        """
        out: list[dict[str, Any]] = []
        for chunk in chunks:
            if chunk.source != RESOLVED_CASE_SOURCE:
                continue
            doc_id = str(chunk.doc_id or "")
            metadata = dict(chunk.metadata or {})
            case_id = str(metadata.get("case_id") or "")
            document_id = str(metadata.get("document_id") or "")
            if not document_id:
                if doc_id.startswith(f"{RESOLVED_CASE_SOURCE}:"):
                    document_id = doc_id
                elif case_id:
                    document_id = f"{RESOLVED_CASE_SOURCE}:{case_id}"
                else:
                    continue
            metadata["document_id"] = document_id
            out.append(
                {
                    "text": chunk.text,
                    "embedding_text": chunk.text,
                    "source": chunk.source,
                    "metadata": metadata,
                    "doc_id": doc_id or document_id,
                }
            )
        return out

    async def _chunk_counts_by_source(self) -> dict[str, int]:
        """Stored chunk count per source, or ``{}`` when the store cannot be read."""
        try:
            stats = await self._store.stats()
            return {
                str(source): int(count or 0)
                for source, count in dict(stats.get("by_source") or {}).items()
            }
        except Exception as exc:  # noqa: BLE001 — observability must never break seeding
            logger.warning("Reading RAG source counts failed: %s", exc)
            return {}

    def _record_projection_outcome(
        self, outgoing: dict[str, int], incoming: dict[str, int]
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
        for source in sorted(set(outgoing) | set(incoming)):
            before = int(outgoing.get(source, 0))
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
            try:
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
            except Exception as exc:  # noqa: BLE001
                self._seeded = False
                self._seed_signature = None
                logger.warning("RAG seeding failed; store left as-is: %s", exc)

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

        This builder is the SUPERSET of both: outcome, model verdict, entity, rules,
        risk, trigger sentence, top-3 evidence summaries, recommended action and the
        bounded/flattened analyst note. ``note`` is expected to have already passed
        through :func:`_flatten_analyst_note`.
        """
        entity = f"{case.entity.type.value}:{case.entity.value}"
        rules = ", ".join(case.rule_ids) or "n/a"
        verdict = case.verdict.value if case.verdict else "n/a"
        evidence = "; ".join(e.summary for e in case.evidence[:3]) or "n/a"
        reason = (
            case.trigger_reason.sentence
            if case.trigger_reason and case.trigger_reason.sentence
            else ""
        )
        return (
            f"Resolved case {case.case_id}: analyst-confirmed outcome {outcome}; "
            f"model verdict {verdict}; entity {entity}. "
            f"Rules: {rules}. Risk: {round(case.risk_score, 1)}. "
            f"Trigger: {reason or 'n/a'}. "
            f"Evidence: {evidence}. "
            f"Recommended action: {case.recommended_action or 'n/a'}. "
            f"Analyst note: {note or 'n/a'}."
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
        """
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
        """
        entity = f"{case.entity.type.value}:{case.entity.value}"
        rules = ", ".join(case.rule_ids) or "n/a"
        verdict = case.verdict.value if case.verdict else "n/a"
        evidence = "; ".join(e.summary for e in case.evidence[:3]) or "n/a"
        reason = (
            case.trigger_reason.sentence
            if case.trigger_reason and case.trigger_reason.sentence
            else ""
        )
        return (
            f"Prior case {case.case_id}: UNCONFIRMED model outcome {outcome} — closed "
            f"by the agent, NOT reviewed or confirmed by an analyst; "
            f"model verdict {verdict} at confidence {round(float(case.confidence or 0.0), 2)}; "
            f"entity {entity}. "
            f"Rules: {rules}. Risk: {round(case.risk_score, 1)}. "
            f"Trigger: {reason or 'n/a'}. "
            f"Evidence: {evidence}. "
            f"Recommended action: {case.recommended_action or 'n/a'}."
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
        """
        if self._cases is None or not self._unconfirmed_enabled():
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
        seen: set[str] = set()
        scanned = 0
        for status in (CaseStatus.CLOSED.value, CaseStatus.RESOLVED.value):
            offset = 0
            while scanned < _UNCONFIRMED_SCAN_CAP:
                page_size = min(
                    _RESOLVED_CASE_PAGE_SIZE, _UNCONFIRMED_SCAN_CAP - scanned
                )
                page, total = await self._cases.list(
                    status=status, limit=page_size, offset=offset
                )
                if not page:
                    break
                for case in page:
                    if case.case_id in seen:
                        continue
                    seen.add(case.case_id)
                    scanned += 1
                    outcome = self._unconfirmed_candidate(case, now=now)
                    if outcome is not None:
                        candidates.append((case, outcome))
                        counts[self._recurrence_key(case, outcome)] += 1
                offset += len(page)
                if offset >= total:
                    break
            if scanned >= _UNCONFIRMED_SCAN_CAP:
                break
        # Pass 2 — keep only patterns that RECUR. One auto-close is an anecdote; a
        # single hallucinated close must never become quotable precedent.
        minimum = max(1, int(guards.min_recurrence))
        out: list[tuple["Case", dict[str, Any]]] = []
        for case, outcome in candidates:
            recurrence = counts[self._recurrence_key(case, outcome)]
            if recurrence < minimum:
                continue
            out.append(
                (case, self._unconfirmed_case_item(case, outcome=outcome, recurrence=recurrence))
            )
            if len(out) >= cap:
                break
        return out

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

    async def _resolved_case_items(self, limit: int | None = None) -> list[dict[str, Any]]:
        """The ``limit`` QUALIFYING precedents to project (bounded scan).

        The window is counted in analyst-confirmed items, NOT in raw terminal cases.
        Counting raw cases meant a self-running deployment's own unlabelled
        auto-closes — which are newer than every labelled case and unbounded in
        number — consumed every slot, so the precedent corpus eroded to zero exactly
        as the agent succeeded. ``_RESOLVED_CASE_SCAN_CAP`` bounds the raw cases
        examined, so a large unlabelled backlog costs a bounded scan rather than the
        whole corpus.

        **Per-rule stratification** (``prefs.precedent.window.stratify_by_rule``, ON by
        default). A flat newest-N window has the same starvation shape one level up: a
        bulk analyst action on ONE rule produces hundreds of qualifying cases that are
        all newer than every other rule's, so the next projection fills every slot with
        that rule and drops every other rule's precedent to zero — including a rule
        carrying most of the deployment's auto-close volume. That is the precedent
        outage again, this time triggered by an operator doing exactly what the product
        asked of them. Round-robin allocation across rule identities gives every active
        rule an equal floor inside the same bounded window.

        Stratifying means the scan can no longer stop at the first ``limit`` qualifying
        items (that would only ever see the dominant rule), so it runs to the scan cap.
        That is a bounded, paged case-store read that happens on projection only. With
        stratification off, the early exit and the exact previous ordering are restored.
        """
        if self._cases is None:
            return []
        window = self._window_config()
        cap_items = max(1, int(limit if limit is not None else window.size))
        stratify = bool(window.stratify_by_rule)
        collected: list[dict[str, Any]] = []
        seen: set[str] = set()
        scanned = 0
        for status in (CaseStatus.CLOSED.value, CaseStatus.RESOLVED.value):
            offset = 0
            while scanned < _RESOLVED_CASE_SCAN_CAP and (
                stratify or len(collected) < cap_items
            ):
                page_size = min(
                    _RESOLVED_CASE_PAGE_SIZE, _RESOLVED_CASE_SCAN_CAP - scanned
                )
                page, total = await self._cases.list(
                    status=status, limit=page_size, offset=offset
                )
                if not page:
                    break
                for case in page:
                    if case.case_id in seen:
                        continue
                    seen.add(case.case_id)
                    scanned += 1
                    item = self._resolved_case_item(case)
                    if item is not None:
                        collected.append(item)
                        if not stratify and len(collected) >= cap_items:
                            break
                offset += len(page)
                if offset >= total:
                    break
            if scanned >= _RESOLVED_CASE_SCAN_CAP:
                break
            if not stratify and len(collected) >= cap_items:
                break
        if not stratify:
            return collected[:cap_items]
        return stratified_selection(
            collected,
            lambda item: str((item.get("metadata") or {}).get(RULE_IDENTITY_KEY) or ""),
            cap_items,
        )

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
        chunks = await self._store.list_all_chunks()
        truncated = len(chunks) >= _CORPUS_SCAN_TRUNCATION_HINT
        rows = [
            dict(chunk.metadata or {})
            for chunk in chunks
            if chunk.source == RESOLVED_CASE_SOURCE
        ]
        return rows, truncated

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
        :meth:`_resolved_case_text` builder (identical to the incremental path);
        source="resolved_case"; metadata carries case_id / verdict / entity so the
        UI/agent can cite the source case.
        Returns the number of chunks added. Never raises (logs + returns 0)."""
        if self._cases is None:
            return 0
        try:
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
                return RagRetrievalObservation(
                    [], False, unavailable_reason or "corpus_empty"
                )
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
                        self._preserved_resolved_case_items(backup)
                    )
                    if str(item.get("doc_id") or "") not in staged_doc_ids
                )
                replacement = await self._embed_items(managed)

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
            except Exception as exc:
                self._seeded = False
                self._seed_signature = None
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
