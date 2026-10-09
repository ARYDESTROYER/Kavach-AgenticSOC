"""Public JSON projections shared by routes and chat tools.

Moved unchanged from the API layer (chat revamp SPEC §5.3, "route-private helpers move
first"): ``proposal_public`` from ``api/routes.py`` and ``campaign_json`` (with its
``safe_text`` bound) from ``api/routes_campaigns.py``. The routes re-export them under
their historical underscore names, and the chat ``automation_status`` /
``list_campaigns`` tools use the same projections, so a review card and a chat answer
can never disagree about what a proposal or campaign says.

Pure, no I/O. Campaign entity values, MITRE ids and names are source-derived plain data
(#9): bounded here, escaped by the UI, fenced by any caller that shows them to a model.
"""

from __future__ import annotations

from typing import Any

from ..models import Campaign, Proposal
from ..stores.proposals import evidence_summary, proposal_is_expired

__all__ = ["campaign_json", "proposal_public", "safe_text"]


def proposal_public(proposal: Proposal) -> dict[str, Any]:
    """Public projection; lease and immutable recovery identity stay internal.

    Carries the derived ``evidence`` block so a review card renders exactly the claim
    the server is willing to act on: a bulk-ratified or unverifiable basis is never
    presented as analyst-confirmed, and ``evidence.approvable`` tells the UI in advance
    that the approve button would be refused.
    """
    data = proposal.model_dump(
        mode="json", exclude={"applying_token", "decision_actor"}
    )
    data["evidence"] = evidence_summary(proposal)
    data["expired"] = proposal.status == "expired" or proposal_is_expired(proposal)
    return data


def safe_text(value: Any) -> str:
    """Return ``value`` as a plain, length-bounded string for the client (#9): the UI
    renders it escaped and it is never fed back into a prompt. Bounds a runaway,
    source-influenceable string so a hostile upstream can't blow up the response."""
    return str(value)[:2000]


def campaign_json(campaign: Campaign) -> dict[str, Any]:
    """One campaign as a plain, #9-fenced dict.

    Entity ``value``s + MITRE ids + the display name are source-derived — each is
    coerced to a bounded plain string so nothing attacker-influenceable is echoed
    raw. Numeric/id fields pass through; ``case_ids`` are plain ids."""
    return {
        "id": safe_text(campaign.id),
        "name": safe_text(campaign.name),
        "status": str(getattr(campaign.status, "value", campaign.status)),
        "case_ids": [safe_text(cid) for cid in campaign.case_ids],
        "case_count": len(campaign.case_ids),
        "entities": [
            {"entity_type": safe_text(e.entity_type), "value": safe_text(e.value)}
            for e in campaign.entities
        ],
        "mitre": [safe_text(t) for t in campaign.mitre],
        "severity_rollup": safe_text(campaign.severity_rollup) if campaign.severity_rollup else None,
        "first_seen": campaign.first_seen,
        "last_seen": campaign.last_seen,
        "created_at": campaign.created_at,
    }
