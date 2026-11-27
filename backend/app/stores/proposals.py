"""Agent-DRAFTED PROPOSAL store — pending recommendations awaiting human approval.

A PROPOSAL is work the agent has DRAFTED but never applied: a suppression rule,
Memory fact, bounded tuning change, or acknowledgement-only automation checkpoint.
It sits ``pending`` until a human explicitly approves or rejects it. Drafting one
NEVER mutates live configuration, Memory, or case state — that is the point of HITL.

Backend-agnostic by construction (cloned verbatim from :mod:`app.stores.memory`):
the whole proposal set is ONE JSON list persisted through the existing
:class:`KVStore` abstraction (``ns="proposals"``, ``key="entries"``) — so it needs
NO new ES index / SQL table / migration. The SQL backend uses ``SqlKVStore`` (the
shared KV table); the ES backend uses the thin :class:`app.stores.memory.EsKVStore`
adapter (a doc in the existing config index).

Reads + ordinary drafting writes are read-modify-write over the single list — fine at
our scale (operator/agent-authored proposals, not log volume). Ordinary workflows never raise:
a load/save failure degrades to an empty list / best-effort write and is logged, so a
proposal glitch can never drop an alert or break the analyst's close action. Evidence
exports opt into the separate strict read seam and propagate uncertainty. Approval
and rejection transitions are stricter: confirmed CAS is required because no side
effect may run before a durable ``pending -> applying`` claim.

A pending proposal DECAYS. This module therefore also owns the pure, deterministic
lifecycle rules that keep a queue honest:

* :func:`evidence_fingerprint` / :func:`evidence_summary` bind a proposal to the exact
  evidence — counts AND provenance — it was drafted from, so a bulk-ratified or
  otherwise unverifiable basis can neither be labelled "analyst-confirmed" nor applied;
* :func:`proposal_is_expired` + :meth:`ProposalStore.sweep_expired` retire lapsed
  review work instead of leaving it rendered as actionable forever.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
from collections.abc import Mapping
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from ..constants import PROPOSALS_KEY, PROPOSALS_NS
from ..models import Proposal
from ..utils import iso_now
from .base import KVStore, kv_mutate, kv_mutate_strict

logger = logging.getLogger("tlsoc.stores.proposals")

_APPROVAL_LEASE_SECONDS = 30

# Bound on one sweep pass so garbage collection can never turn into an unbounded
# rewrite of the whole registry in a single request; the next pass drains the rest.
SWEEP_BATCH_LIMIT = 500

# Bound on one bulk decision request (the API enforces the same number).
BULK_DECISION_LIMIT = 200

# Bound on the operator-authored rejection justification.
MAX_DECISION_REASON_CHARS = 200


# --------------------------------------------------------------------------- #
# EVIDENCE PROVENANCE + FINGERPRINT
#
# A proposal asserts something about evidence that existed when it was drafted.
# Two independent failures made that assertion unsafe to trust blindly:
#
#   * the recommendation can be overtaken (the live threshold moved, the rule was
#     re-scoped) — approving a month-old proposal against today's configuration is
#     not safe by default; and
#   * the EVIDENCE itself can be misdescribed. A bulk backfill of MODEL verdicts
#     through the analyst-feedback path made model output look like analyst ground
#     truth, so a card could print "97 analyst labels / 97 confirmed FP" when the
#     independent-analyst count was zero.
#
# ``app.engine.analyst_outcomes.analyst_confirmed_outcome`` is the upstream fix: a
# bulk ratification is recorded as its own append-only ``precedent_ratification``
# case-history event that is deliberately invisible to it, so the tuner can no longer
# COUNT one as independent evidence. These helpers are the downstream half — they make
# the distinction VISIBLE on the proposal and make an unverifiable claim unapprovable.
#
# Pure, dependency-free and deterministic: no I/O, no clock, no LLM, and nothing here
# ever reads a verdict, a risk score, or the close/escalate policy (#3).
# --------------------------------------------------------------------------- #
EVIDENCE_SCHEMA = "ev1"

#: Genuinely independent analyst outcomes (graded feedback / explicit classification).
PROVENANCE_INDEPENDENT_ANALYST = "independent_analyst"
#: Only bulk/backfilled ratifications of the agent's OWN verdicts stand behind this.
PROVENANCE_BULK_RATIFIED = "bulk_ratified"
#: Both kinds are present; only the independent part may be called analyst-confirmed.
PROVENANCE_MIXED = "mixed"
#: The rule was observed, but nothing analyst-derived labelled it.
PROVENANCE_NO_ANALYST_EVIDENCE = "no_analyst_evidence"
#: No verifiable basis was recorded at draft time (every pre-fix row lands here).
PROVENANCE_UNVERIFIED = "unverified"

#: Payload key carrying the drafter's per-provenance sample breakdown.
PROVENANCE_KEY = "analyst_samples_provenance"

#: The counters that make up the breakdown, in fingerprint order.
PROVENANCE_COUNT_KEYS: tuple[str, ...] = (
    "independent_analyst_outcomes",
    "analyst_feedback_labels",
    "explicit_disposition_labels",
    "bulk_ratified_model_verdicts",
    "unlabelled_cases",
)

#: The payload keys that DEFINE the recommendation and the evidence behind it. A
#: change to any of them is a materially different proposal and must not inherit the
#: previous one's approval.
FINGERPRINT_KEYS: tuple[str, ...] = (
    "action",
    "target",
    "rule_id",
    "feed_key",
    "source_id",
    "feed_id",
    "before",
    "after",
    "analyst_samples",
    "confirmed_false_positives",
    "confirmed_true_positives",
    "observed_cases",
    "unconfirmed_cases",
)

#: Tuning actions that only acknowledge review work. They materialise nothing, so an
#: unverifiable evidence basis is a labelling problem, not an approval hazard.
ACKNOWLEDGEMENT_ACTIONS = frozenset({"review_history", "collect_evidence", "review_finding"})

#: The one tuning action that writes live configuration.
APPLY_ACTION = "apply_change"

_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]+")


def _as_int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def provenance_counts(payload: Mapping[str, Any] | None) -> dict[str, int] | None:
    """The drafter's provenance breakdown, or ``None`` when none was recorded.

    ``None`` is meaningfully different from all-zeroes: it means the drafter never
    stated where its analyst samples came from, which is exactly the pre-fix shape.
    """
    raw = payload.get(PROVENANCE_KEY) if isinstance(payload, Mapping) else None
    if not isinstance(raw, Mapping):
        return None
    return {key: _as_int(raw.get(key)) for key in PROVENANCE_COUNT_KEYS}


def evidence_fingerprint(payload: Mapping[str, Any] | None) -> str:
    """Stable ``ev1:<sha256>`` digest of one proposal's recommendation + evidence.

    Deterministic across processes and restarts (no ``hash()``, no dict ordering, no
    clock). Recomputing it at decision time and comparing it with the value recorded at
    draft time is what turns "this proposal's basis changed" into a refusal instead of
    a silent apply.
    """
    body = payload if isinstance(payload, Mapping) else {}
    parts = [
        f"{key}={json.dumps(body.get(key), sort_keys=True, default=str)}"
        for key in FINGERPRINT_KEYS
    ]
    counts = provenance_counts(body)
    if counts is None:
        parts.append("provenance=absent")
    else:
        parts.append(
            "provenance=" + ",".join(f"{key}:{counts[key]}" for key in PROVENANCE_COUNT_KEYS)
        )
    digest = hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()
    return f"{EVIDENCE_SCHEMA}:{digest}"


def evidence_summary(proposal: Proposal) -> dict[str, Any]:
    """Honest, derived description of what actually stands behind ``proposal``.

    JSON-serialisable and additive: it is BOTH the data the review card renders and
    the gate the approve path consults, so the UI can never print a stronger claim
    than the one the server is willing to act on. Never raises.
    """
    payload = proposal.payload if isinstance(proposal.payload, Mapping) else {}
    action = str(payload.get("action") or "").strip()
    applies_configuration = proposal.kind == "tuning" and action == APPLY_ACTION
    counts = provenance_counts(payload)
    recorded = str(proposal.evidence_fingerprint or "").strip()
    matches = bool(recorded) and recorded == evidence_fingerprint(payload)

    independent = counts["independent_analyst_outcomes"] if counts else 0
    bulk = counts["bulk_ratified_model_verdicts"] if counts else 0
    verified = bool(recorded) and matches and counts is not None

    if not verified:
        provenance = PROVENANCE_UNVERIFIED
    elif independent > 0 and bulk > 0:
        provenance = PROVENANCE_MIXED
    elif independent > 0:
        provenance = PROVENANCE_INDEPENDENT_ANALYST
    elif bulk > 0:
        provenance = PROVENANCE_BULK_RATIFIED
    else:
        provenance = PROVENANCE_NO_ANALYST_EVIDENCE

    # "analyst-confirmed" is a claim about INDEPENDENT human labels. A bulk
    # ratification of the agent's own verdicts is never allowed to earn that word,
    # and neither is an unverifiable count.
    analyst_confirmed = provenance in {
        PROVENANCE_INDEPENDENT_ANALYST, PROVENANCE_MIXED,
    } and independent > 0

    # A proposal that never claimed analyst evidence (a suppression rule, a Memory
    # fact, an acknowledgement) is not suspicious for lacking a basis — say so plainly
    # rather than implying a missing justification it was never supposed to have.
    claims_evidence = counts is not None or "analyst_samples" in payload
    if applies_configuration:
        unverified_label = (
            "This proposal recorded no verifiable evidence basis, so its sample counts "
            "cannot be shown as analyst-confirmed. It must be re-drafted from current "
            "evidence before any threshold change is applied."
        )
    elif claims_evidence:
        unverified_label = (
            "This proposal recorded no verifiable evidence basis, so its sample counts "
            "cannot be shown as analyst-confirmed."
        )
    else:
        unverified_label = "This proposal makes no analyst-evidence claim."

    labels = {
        PROVENANCE_UNVERIFIED: unverified_label,
        PROVENANCE_BULK_RATIFIED: (
            f"{bulk} bulk-ratified model verdicts stand behind this proposal and NO "
            "independent analyst outcomes. Bulk ratification is not analyst ground truth."
        ),
        PROVENANCE_MIXED: (
            f"{independent} independently confirmed analyst outcomes "
            f"({bulk} bulk-ratified model verdicts are excluded from the count)."
        ),
        PROVENANCE_INDEPENDENT_ANALYST: (
            f"{independent} independently confirmed analyst outcomes."
        ),
        PROVENANCE_NO_ANALYST_EVIDENCE: (
            "No independent analyst outcomes labelled this rule in the observed window."
        ),
    }

    blocked_reason: str | None = None
    if applies_configuration:
        if not recorded:
            blocked_reason = "evidence_fingerprint_missing"
        elif not matches:
            blocked_reason = "evidence_fingerprint_mismatch"
        elif counts is None:
            blocked_reason = "evidence_provenance_missing"
        elif not analyst_confirmed:
            blocked_reason = "evidence_not_analyst_confirmed"

    return {
        "schema": EVIDENCE_SCHEMA,
        "provenance": provenance,
        "analyst_confirmed": analyst_confirmed,
        "independent_analyst_outcomes": independent,
        "analyst_feedback_labels": counts["analyst_feedback_labels"] if counts else 0,
        "explicit_disposition_labels": (
            counts["explicit_disposition_labels"] if counts else 0
        ),
        "bulk_ratified_model_verdicts": bulk,
        "unlabelled_cases": counts["unlabelled_cases"] if counts else 0,
        "fingerprint_recorded": bool(recorded),
        "fingerprint_valid": matches,
        "verified": verified,
        "label": labels[provenance],
        "applies_configuration": applies_configuration,
        "approvable": blocked_reason is None,
        "blocked_reason": blocked_reason,
    }


def parse_ts(value: Any) -> datetime | None:
    """Lenient ISO-8601 parse used by expiry. Returns ``None`` when unusable."""
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


#: Kinds whose ``expires_at`` is NOT a review deadline.
#:
#: For a ``suppression`` proposal the field carries the lifetime of the
#: :class:`app.config.SuppressionRule` that approval materialises — the approve path
#: reads it as the rule's ``expires_at`` — so a past value means "materialise a rule
#: that is already lapsed", NOT "this review work is dead". Retiring an operator's
#: review item because the rule it would create has a short life would be a silent
#: behaviour change for an unrelated reason (#10).
EXPIRY_EXEMPT_KINDS = frozenset({"suppression"})


def proposal_is_expired(proposal: Proposal, *, now: datetime | None = None) -> bool:
    """True when this row's own review deadline has lapsed.

    Deliberately fail-open on a missing or unparseable timestamp, and on the kinds in
    :data:`EXPIRY_EXEMPT_KINDS`: an unreadable or differently-meant value is not
    authority to retire an operator's review work, and every row without a real
    deadline behaves exactly as it always has (#10).
    """
    if proposal.kind in EXPIRY_EXEMPT_KINDS:
        return False
    deadline = parse_ts(proposal.expires_at)
    if deadline is None:
        return False
    return deadline <= (now or datetime.now(timezone.utc))


def sanitize_decision_reason(reason: Any) -> str:
    """Bound + flatten an operator-authored rejection reason for durable storage.

    Operator-authored, not log-derived, so this is a durability/readability bound
    rather than a #9 trust boundary: control characters are stripped so the reason
    cannot forge structure inside a single-line audit summary.
    """
    text = _CONTROL_CHARS.sub(" ", str(reason or ""))
    return " ".join(text.split())[:MAX_DECISION_REASON_CHARS].strip()


class ProposalStore:
    """CRUD over the proposal list, persisted as one KV document.

    The KV value is ``{"entries": [<Proposal json>, ...]}``. Ordinary methods are
    fail-soft; :meth:`list_strict` is the evidence/export boundary."""

    def __init__(self, kv: KVStore) -> None:
        self._kv = kv
        # Per-store lock so kv_mutate serialises concurrent read-modify-write over the
        # single proposal doc + a _rev CAS covers the multi-process race — so a concurrent
        # add and set_status can't drop an in-flight proposal or revert an approved one to
        # pending (audit #26).
        self._lock = asyncio.Lock()

    async def _mutate(self, apply: Callable[[list[Proposal]], Any]) -> Any:
        """Run ``apply(entries)`` under kv_mutate (per-store lock + _rev CAS). ``apply``
        mutates the fresh list in place and returns an auxiliary result; the persisted
        attempt's result is returned. Never raises."""
        box: dict[str, Any] = {}

        def mutator(current: dict[str, Any] | None) -> dict[str, Any]:
            raw = current.get("entries", []) if isinstance(current, dict) else []
            entries: list[Proposal] = []
            for item in (raw or []):
                try:
                    entries.append(Proposal.model_validate(item))
                except Exception:  # noqa: BLE001 — skip a corrupt entry, keep the rest
                    continue
            box["result"] = apply(entries)
            return {"entries": [p.model_dump(mode="json") for p in entries]}

        await kv_mutate(self._kv, PROPOSALS_NS, PROPOSALS_KEY, mutator, lock=self._lock)
        return box.get("result")

    async def _mutate_strict(self, apply: Callable[[list[Proposal]], Any]) -> Any:
        """Confirmed CAS mutation for the approval/rejection durability boundary."""
        box: dict[str, Any] = {}

        def mutator(current: dict[str, Any] | None) -> dict[str, Any]:
            entries = self._decode_entries_strict(current)
            box["result"] = apply(entries)
            # Preserve opaque top-level siblings written by a newer compatible
            # deployment. Individual unknown proposal fields fail closed in the
            # strict decoder below, so this older process can never erase them.
            updated = dict(current or {})
            updated["entries"] = [p.model_dump(mode="json") for p in entries]
            return updated

        await kv_mutate_strict(
            self._kv,
            PROPOSALS_NS,
            PROPOSALS_KEY,
            mutator,
            lock=self._lock,
        )
        return box.get("result")

    @staticmethod
    def _decode_entries_strict(current: dict[str, Any] | None) -> list[Proposal]:
        """Decode the complete registry or fail before a strict CAS write.

        Fail-soft reads intentionally skip a damaged proposal so case handling can
        continue. A decision mutation is different: rewriting only the valid rows
        would silently delete an opaque/malformed sibling. Reject the whole write
        instead and leave the persisted document byte-for-byte untouched.
        """
        if current is None:
            return []
        if not isinstance(current, dict):
            raise ValueError("proposal registry is not a JSON object")
        raw = current.get("entries", [])
        if not isinstance(raw, list):
            raise ValueError("proposal registry entries are not a list")
        known_fields = set(Proposal.model_fields)
        entries: list[Proposal] = []
        for item in raw:
            if not isinstance(item, dict) or set(item) - known_fields:
                raise ValueError("proposal registry contains an invalid entry")
            try:
                entries.append(Proposal.model_validate(item))
            except Exception as exc:  # noqa: BLE001 — strict writes fail closed
                raise ValueError("proposal registry contains an invalid entry") from exc
        return entries

    async def _load(self) -> list[Proposal]:
        try:
            doc = await self._kv.get(PROPOSALS_NS, PROPOSALS_KEY)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Loading proposals failed (%s); using empty set", exc)
            return []
        if not doc:
            return []
        raw = doc.get("entries", []) if isinstance(doc, dict) else []
        out: list[Proposal] = []
        for item in raw or []:
            try:
                out.append(Proposal.model_validate(item))
            except Exception:  # noqa: BLE001 — skip a single corrupt entry, keep the rest
                continue
        return out

    async def _load_strict(self) -> list[Proposal]:
        """Load every persisted proposal or raise when completeness is unknown.

        Ordinary proposal workflows intentionally fail soft so a review-queue outage
        cannot stop case handling. Portable export is different: returning ``[]`` on
        a failed read would create a false lifetime-complete claim, so it uses this
        confirmed projection instead.
        """
        getter = getattr(self._kv, "get_strict", None) or self._kv.get
        doc = await getter(PROPOSALS_NS, PROPOSALS_KEY)
        return self._decode_entries_strict(doc)

    # No plain _save — every mutation goes through _mutate (kv_mutate: lock + _rev CAS)
    # so a write can't clobber a concurrent one (audit #26).

    @staticmethod
    def _projected(
        entries: list[Proposal], *, now: datetime | None = None
    ) -> list[Proposal]:
        """Read-time honesty: a lapsed ``pending`` row is presented as ``expired``.

        The durable transition is :meth:`sweep_expired`'s job, but the queue must not
        render a lapsed proposal as actionable work in the window before a sweep runs
        (or when the sweep write itself is unavailable). This is a projection over
        COPIES — it never mutates or persists anything. ``applying`` is deliberately
        untouched: an in-flight decision belongs to its lease, not to the clock.
        """
        moment = now or datetime.now(timezone.utc)
        return [
            p.model_copy(update={"status": "expired"})
            if p.status == "pending" and proposal_is_expired(p, now=moment)
            else p
            for p in entries
        ]

    async def list(self, status: str | None = None) -> list[Proposal]:
        entries = self._projected(await self._load())
        if status == "pending":
            # Keep an in-flight/stale approval visible in the operator queue. The UI
            # distinguishes ``applying`` and the strict claim controls safe recovery.
            # An expired row was already projected out of ``pending`` above.
            entries = [p for p in entries if p.status in {"pending", "applying"}]
        elif status:
            entries = [p for p in entries if p.status == status]
        # Newest first so the review queue surfaces fresh proposals at the top.
        return sorted(entries, key=lambda p: p.created_at, reverse=True)

    async def list_strict(self, status: str | None = None) -> list[Proposal]:
        """Newest-first proposals, raising on unavailable or malformed persistence.

        Deliberately UNPROJECTED: this is the evidence/export seam, where the caller
        must see exactly what is persisted rather than a read-time interpretation.
        """
        entries = await self._load_strict()
        if status:
            entries = [p for p in entries if p.status == status]
        return sorted(entries, key=lambda p: p.created_at, reverse=True)

    async def sweep_expired(
        self, *, now: datetime | None = None, limit: int = SWEEP_BATCH_LIMIT
    ) -> list[Proposal]:
        """Garbage-collect lapsed ``pending`` proposals into a durable ``expired``.

        Proposals accumulate unboundedly whenever approvals are broken or a queue is
        simply never worked, and a stale recommendation is not merely clutter — it is
        a reviewable claim about evidence that no longer exists. Sweeping makes the
        read-time projection durable so the row stops competing for operator attention
        and can never be approved.

        Bounded by ``limit`` per pass and a no-op (NO write at all) when nothing has
        lapsed, so it is cheap to call opportunistically. Uses the strict CAS seam:
        rewriting a registry we could not fully decode would silently drop rows, so a
        damaged registry aborts the sweep instead. Raises on that failure — garbage
        collection is best-effort at the CALLER, never silently partial here.
        """
        moment = now or datetime.now(timezone.utc)
        current = await self._load()
        if not any(
            p.status == "pending" and proposal_is_expired(p, now=moment) for p in current
        ):
            return []

        bound = max(0, int(limit))

        def apply(entries: list[Proposal]) -> list[Proposal]:
            swept: list[Proposal] = []
            for idx, proposal in enumerate(entries):
                if len(swept) >= bound:
                    break
                if proposal.status != "pending" or not proposal_is_expired(
                    proposal, now=moment
                ):
                    continue
                # Nobody decided this — ``decided_by``/``decision_actor`` stay unset so
                # the row never claims a human retired it.
                updated = proposal.model_copy(update={
                    "status": "expired",
                    "applying_token": None,
                    "applying_at": None,
                })
                entries[idx] = updated
                swept.append(updated)
            return swept

        result = await self._mutate_strict(apply)
        return list(result or [])

    async def get(self, proposal_id: str) -> Proposal | None:
        for p in await self._load():
            if p.id == proposal_id:
                return p
        return None

    async def add(self, proposal: Proposal) -> Proposal:
        def apply(entries: list[Proposal]) -> Proposal:
            entries.append(proposal)
            return proposal

        await self._mutate(apply)
        return proposal

    async def add_unique(self, proposal: Proposal, dedupe_key: str) -> tuple[Proposal, bool]:
        """Atomically add ``proposal`` unless its stable payload key already exists.

        The check covers every status, not only pending rows: rejecting or approving
        an exact recommendation is itself a decision and the next scheduler tick must
        not recreate the same work. A materially changed recommendation carries a new
        key and remains eligible for review. Returns ``(row, created)``.
        """
        key = str(dedupe_key or "").strip()
        if not key:
            return await self.add(proposal), True

        def apply(entries: list[Proposal]) -> tuple[Proposal, bool]:
            for existing in entries:
                if str((existing.payload or {}).get("dedupe_key") or "") == key:
                    return existing, False
            payload = dict(proposal.payload or {})
            payload["dedupe_key"] = key
            created = proposal.model_copy(update={"payload": payload})
            entries.append(created)
            return created, True

        result = await self._mutate(apply)
        if isinstance(result, tuple) and len(result) == 2:
            return result
        return proposal, False

    @staticmethod
    def _fixed_decision_actor(proposal: Proposal, by: str) -> str:
        """Return the immutable first actor, including pre-field applying rows."""
        if proposal.decision_actor is not None:
            return proposal.decision_actor
        if proposal.decided_by is not None:
            return proposal.decided_by.strip()
        return (by or "").strip()

    async def set_status(self, proposal_id: str, status: str, by: str) -> Proposal | None:
        """Transition a proposal's status (approve/reject) + record who decided it.

        Returns the updated proposal, or ``None`` if the id is unknown."""
        def apply(entries: list[Proposal]) -> Proposal | None:
            for idx, p in enumerate(entries):
                if p.id != proposal_id:
                    continue
                actor = self._fixed_decision_actor(p, by)
                updated = p.model_copy(update={
                    "status": status,
                    "decided_by": actor or None,
                    "decided_at": iso_now(),
                    "decision_actor": actor,
                })
                entries[idx] = updated
                return updated
            return None

        return await self._mutate(apply)

    @staticmethod
    def _lease_is_stale(proposal: Proposal) -> bool:
        raw = str(proposal.applying_at or "").strip()
        if not raw:
            return True
        try:
            started = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            if started.tzinfo is None:
                started = started.replace(tzinfo=timezone.utc)
        except ValueError:
            return True
        return started <= datetime.now(timezone.utc) - timedelta(seconds=_APPROVAL_LEASE_SECONDS)

    async def _claim_decision(
        self,
        proposal_id: str,
        *,
        by: str,
        token: str,
        action: str,
        reason: str | None = None,
        now: datetime | None = None,
    ) -> tuple[Proposal | None, str]:
        """CAS-claim ``pending -> applying``; stale leases may be resumed safely.

        Returns ``(proposal, outcome)`` where outcome is ``claimed``, ``missing``,
        ``expired`` or ``conflict``. A durable claim always exists before any side
        effect runs. The first claim also fixes the decision actor, intent, reason and
        audit timestamp so a retry is idempotent across both the materialised effect
        and append-only evidence, even when a different operator resumes a stale lease.

        Expiry is asymmetric on purpose. APPROVAL of a lapsed proposal is refused
        before anything is audited or applied — its evidence window closed, so it must
        be re-drafted, not enacted. REJECTION stays available: retiring dead review
        work is exactly how an operator clears the queue, and it changes nothing.
        """
        if action not in {"approve", "reject"}:  # defensive internal contract
            raise ValueError(f"unsupported proposal decision action: {action}")
        moment = now or datetime.now(timezone.utc)
        fixed_reason = sanitize_decision_reason(reason)

        def apply(entries: list[Proposal]) -> tuple[Proposal | None, str]:
            for idx, proposal in enumerate(entries):
                if proposal.id != proposal_id:
                    continue
                if proposal.decision_intent not in {None, action}:
                    return proposal, "conflict"
                lapsed = proposal.status == "expired" or (
                    proposal.status == "pending"
                    and proposal_is_expired(proposal, now=moment)
                )
                if action == "approve" and lapsed:
                    return proposal, "expired"
                claimable = (
                    proposal.status == "pending"
                    or (proposal.status == "applying" and self._lease_is_stale(proposal))
                    or (action == "reject" and proposal.status == "expired")
                )
                if claimable:
                    actor = self._fixed_decision_actor(proposal, by)
                    claimed = proposal.model_copy(update={
                        "status": "applying",
                        "decision_actor": actor,
                        "decision_intent": proposal.decision_intent or action,
                        "decision_audit_at": proposal.decision_audit_at or iso_now(),
                        "decision_reason": proposal.decision_reason or (
                            fixed_reason or None
                        ),
                        "applying_token": token,
                        "applying_at": iso_now(),
                        "approval_error": None,
                        "decided_by": actor or None,
                        "decided_at": None,
                    })
                    entries[idx] = claimed
                    return claimed, "claimed"
                return proposal, "conflict"
            return None, "missing"

        return await self._mutate_strict(apply)

    async def claim_approval(
        self, proposal_id: str, *, by: str, token: str, now: datetime | None = None
    ) -> tuple[Proposal | None, str]:
        """Strictly claim a proposal for approval."""
        return await self._claim_decision(
            proposal_id, by=by, token=token, action="approve", now=now
        )

    async def claim_rejection(
        self,
        proposal_id: str,
        *,
        by: str,
        token: str,
        reason: str | None = None,
        now: datetime | None = None,
    ) -> tuple[Proposal | None, str]:
        """Strictly claim a proposal for rejection, fixing its bounded reason."""
        return await self._claim_decision(
            proposal_id, by=by, token=token, action="reject", reason=reason, now=now
        )

    async def _finalize_decision(
        self, proposal_id: str, *, by: str, token: str, action: str
    ) -> Proposal | None:
        """Strictly finalise the caller's applying lease."""
        status = "approved" if action == "approve" else "rejected"

        def apply(entries: list[Proposal]) -> Proposal | None:
            for idx, proposal in enumerate(entries):
                if proposal.id != proposal_id:
                    continue
                if (
                    proposal.status != "applying"
                    or proposal.applying_token != token
                    or proposal.decision_intent != action
                ):
                    return None
                updated = proposal.model_copy(update={
                    "status": status,
                    "applying_token": None,
                    "applying_at": None,
                    "approval_error": None,
                    "decided_by": self._fixed_decision_actor(proposal, by) or None,
                    "decided_at": iso_now(),
                })
                entries[idx] = updated
                return updated
            return None

        return await self._mutate_strict(apply)

    async def finalize_approval(
        self, proposal_id: str, *, by: str, token: str
    ) -> Proposal | None:
        """Strictly finalise the caller's applying lease as approved."""
        return await self._finalize_decision(
            proposal_id, by=by, token=token, action="approve"
        )

    async def finalize_rejection(
        self, proposal_id: str, *, by: str, token: str
    ) -> Proposal | None:
        """Strictly finalise the caller's applying lease as rejected."""
        return await self._finalize_decision(
            proposal_id, by=by, token=token, action="reject"
        )

    async def release_approval(
        self, proposal_id: str, *, token: str, error: str
    ) -> Proposal | None:
        """Return this caller's failed lease to pending with a visible bounded error."""
        detail = str(error or "Approval failed").strip()[:500]

        def apply(entries: list[Proposal]) -> Proposal | None:
            for idx, proposal in enumerate(entries):
                if proposal.id != proposal_id:
                    continue
                if proposal.status != "applying" or proposal.applying_token != token:
                    return None
                updated = proposal.model_copy(update={
                    "status": "pending",
                    "applying_token": None,
                    "applying_at": None,
                    "approval_error": detail,
                    "decided_by": None,
                    "decided_at": None,
                })
                entries[idx] = updated
                return updated
            return None

        return await self._mutate_strict(apply)

    async def reject_pending(self, proposal_id: str, *, by: str) -> tuple[Proposal | None, str]:
        """Strict pending->rejected transition that cannot race an approval claim."""
        def apply(entries: list[Proposal]) -> tuple[Proposal | None, str]:
            for idx, proposal in enumerate(entries):
                if proposal.id != proposal_id:
                    continue
                if proposal.status != "pending":
                    return proposal, "conflict"
                actor = self._fixed_decision_actor(proposal, by)
                updated = proposal.model_copy(update={
                    "status": "rejected",
                    "approval_error": None,
                    "decided_by": actor or None,
                    "decided_at": iso_now(),
                    "decision_actor": actor,
                })
                entries[idx] = updated
                return updated, "rejected"
            return None, "missing"

        return await self._mutate_strict(apply)
