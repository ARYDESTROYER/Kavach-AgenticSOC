"""Formatter role (Section 6.4).

Shapes the investigator's findings into the strict verdict JSON schema. It is a
PRESENTATION step, not a decision step: it never changes the investigator's
verdict label or confidence (those drive the deterministic Case Manager). It only
normalises/cleans evidence, MITRE ids, recommended action and reproduce query.
On any failure it preserves the investigator's draft verdict.
"""

from __future__ import annotations

import json
import logging

from ..audit.audit_log import AuditLogger
from ..audit.changes import redact_text
from ..config import ModelConfig, Preferences
from ..constants import ActionType, Role
from ..llm.gateway import BudgetBlocked, GatewayError, LLMGateway
from ..models import VerdictResult
from ..utils import extract_json, truncate
from .common import coerce_verdict
from .prompts import FORMATTER_SYSTEM

logger = logging.getLogger("tlsoc.agents.formatter")


class Formatter:
    def __init__(self, gateway: LLMGateway, audit: AuditLogger) -> None:
        self._gateway = gateway
        self._audit = audit

    async def format(
        self,
        draft: VerdictResult,
        reasoning: str,
        prefs: Preferences,
        *,
        surface: str,
        case_id: str | None = None,
        model_cfg: ModelConfig | None = None,
    ) -> tuple[VerdictResult, float]:
        # Per-rule model selection (C3-6b): the investigator passes the rule-resolved
        # formatter model; absent an override this is exactly ``prefs.formatter_model``.
        model_cfg = model_cfg or prefs.formatter_model
        payload = {
            "reasoning": truncate(reasoning, 4000),
            "draft_verdict": draft.model_dump(mode="json"),
        }
        messages = [
            {"role": "system", "content": FORMATTER_SYSTEM},
            {"role": "user", "content": json.dumps(payload, default=str)},
        ]
        try:
            res = await self._gateway.complete(
                Role.FORMATTER, messages, model_cfg, surface=surface, case_id=case_id
            )
        except GatewayError as exc:
            logger.warning(
                "Formatter unavailable (class=%s): %s; preserving draft verdict",
                getattr(exc, "failure_class", "") or "unclassified", exc,
            )
            # The model call failed: record it, so the audit log's Failed filter finds
            # it (#2). The investigator's draft verdict stands, so the case path goes
            # on. Inside the pipeline the row carries the run id (``RunStampedAudit``).
            await self._audit.record(
                action_type=ActionType.ERROR, surface=surface,
                actor=Role.FORMATTER.value, case_id=case_id, model=model_cfg.model,
                # The AI budget refusing the call is a policy refusal, not a fault.
                outcome="denied" if isinstance(exc, BudgetBlocked) else "failure",
                # A provider error's text can carry an address or a credential.
                result_summary=truncate(redact_text(
                    f"formatter unavailable: {exc}; the investigator's draft verdict was kept"
                )[0], 1000),
            )
            return draft, 0.0

        formatted = coerce_verdict(extract_json(res.text))
        # PRESERVE the investigator's decision; formatter only polishes presentation.
        merged = VerdictResult(
            verdict=draft.verdict,
            confidence=draft.confidence,
            evidence=formatted.evidence or draft.evidence,
            mitre=formatted.mitre or draft.mitre,
            recommended_action=formatted.recommended_action or draft.recommended_action,
            reproduce_query=formatted.reproduce_query or draft.reproduce_query,
        )
        # Audit the formatter step (C3-3) so it appears in the case trace timeline.
        await self._audit.record(
            action_type=ActionType.PROMPT, surface=surface, actor=Role.FORMATTER.value,
            case_id=case_id, model=model_cfg.model, outcome="success",
            prompt_excerpt=json.dumps(payload, default=str),
            result_summary=(
                f"formatted verdict {merged.verdict.value} "
                f"(confidence {merged.confidence})"
            ),
        )
        return merged, res.cost
