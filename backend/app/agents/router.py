"""Router / triage role (Section 6.3 #3, 6.4).

The cheap, fast model classifies a candidate so the expensive investigator only
sees the uncertain or serious bucket. On any failure it returns UNCERTAIN — it is
never acceptable to dismiss a real alert because the router was unavailable.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from ..audit.audit_log import AuditLogger
from ..config import Preferences
from ..constants import ActionType, Role, TriageBucket
from ..llm.gateway import GatewayError, LLMGateway
from ..models import Cluster, EnrichmentResult
from ..utils import extract_json, truncate
from ..evidence_fields import ROUTER_EVIDENCE_MAX_CHARS
from .prompts import ROUTER_SYSTEM, render_cluster

logger = logging.getLogger("tlsoc.agents.router")


@dataclass
class TriageResult:
    bucket: TriageBucket
    confidence: float
    reason: str
    cost: float = 0.0


class Router:
    def __init__(self, gateway: LLMGateway, audit: AuditLogger) -> None:
        self._gateway = gateway
        self._audit = audit

    async def triage(
        self,
        cluster: Cluster,
        enrichment: EnrichmentResult | None,
        prefs: Preferences,
        *,
        surface: str,
        case_id: str | None = None,
    ) -> TriageResult:
        # Per-rule model selection (C3-6b): resolve via the cluster's primary rule;
        # identical to ``prefs.router_model`` when no per-rule override exists.
        model_cfg = prefs.model_for_rule(Role.ROUTER, cluster.primary_rule())
        # Same shared evidence projection as the investigator (one definition, so
        # triage and investigation cannot disagree about what the alert contains),
        # resolved from the operator's config for this cluster's own sources.
        user = render_cluster(
            cluster, enrichment, None, max_events=6,
            evidence_fields=prefs.evidence_fields_for(cluster.contributing_source_ids()),
            # Same evidence FIELDS as the investigator; a tighter per-event ceiling,
            # because cheap triage runs on every cluster.
            evidence_max_chars=min(
                prefs.evidence_budget_for(cluster.contributing_source_ids()),
                ROUTER_EVIDENCE_MAX_CHARS,
            ),
        )
        messages = [
            {"role": "system", "content": ROUTER_SYSTEM},
            {"role": "user", "content": user},
        ]
        await self._audit.record(
            action_type=ActionType.PROMPT, surface=surface, actor=Role.ROUTER.value,
            case_id=case_id, model=model_cfg.model, prompt_excerpt=user,
        )
        try:
            res = await self._gateway.complete(
                Role.ROUTER, messages, model_cfg, surface=surface, case_id=case_id
            )
        except GatewayError as exc:
            failure_class = getattr(exc, "failure_class", "") or ""
            logger.warning(
                "Router unavailable (class=%s): %s; defaulting to UNCERTAIN",
                failure_class or "unclassified", exc,
            )
            detail = f" [{failure_class}]" if failure_class else ""
            return TriageResult(
                TriageBucket.UNCERTAIN, 0.0, f"router unavailable{detail}: {exc}"
            )

        obj = extract_json(res.text) or {}
        bucket = _parse_bucket(obj.get("bucket"))
        confidence = _safe_float(obj.get("confidence"))
        reason = truncate(str(obj.get("reason", "")), 300)
        await self._audit.record(
            action_type=ActionType.DECISION, surface=surface, actor=Role.ROUTER.value,
            case_id=case_id, model=model_cfg.model,
            result_summary=f"bucket={bucket.value} confidence={confidence} reason={reason}",
        )
        return TriageResult(bucket, confidence, reason, res.cost)


def _parse_bucket(value: object) -> TriageBucket:
    try:
        return TriageBucket(str(value))
    except ValueError:
        return TriageBucket.UNCERTAIN


def _safe_float(value: object) -> float:
    try:
        return max(0.0, min(1.0, float(value)))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0.0
