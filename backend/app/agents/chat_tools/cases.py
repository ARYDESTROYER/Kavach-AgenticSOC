"""Case tools: ``search_cases``, ``get_case``, ``shift_report``, ``list_campaigns``
and ``explain_decision`` (chat revamp SPEC §5.3).

All five read the demo-switchable case/campaign/standup stores on the context and
write nothing. Case text (titles, entities, rule ids, evidence summaries, status
reasons, campaign names) is log- or model-derived, so it reaches a model only inside
the engine's fence and is flagged ``untrusted_labels`` on artifacts (#9). No
observation ever carries ``member_event_ids``, ``history``, ``verdict_history``,
comments or notification records.

``explain_decision`` calls the pure, deterministic ``case_manager.decide()`` exactly
like ``POST /api/triage/preview-decision``: a what-if over the LIVE execution
policy, never a write, never a model call, never a different policy (#3).
"""

from __future__ import annotations

import logging
import math
from collections import Counter
from typing import Any, ClassVar, Literal

from pydantic import Field, field_validator

from ...constants import OPEN_CASE_STATUSES, TERMINAL_CASE_STATUSES, CaseStatus, Verdict
from ...models import Citation
from .base import Artifact, ChatTool, ChatToolContext, ToolOutcome
from .common import (
    ToolInput,
    case_list_item,
    citation_id,
    case_row,
    case_severity,
    categories,
    column,
    enum_value,
    finite,
    fmt_int,
    iso_or_none,
    kpi,
    none_if_blank,
    opt_text,
    parse_input,
    resolve_window,
    text,
    verdict_semantic,
)

logger = logging.getLogger("tlsoc.agents.chat_tools.cases")

# The shared bounded page the dashboards use (5 s single-flight cache, demo-safe by
# store identity). In-memory filters run over at most this many newest cases.
CASE_SCAN_LIMIT = 5_000
_OBS_CASES = 10
_CASE_LIST_MAX = 25
# A native query in a case rationale is bounded like ``audit_search``'s query_text.
_RATIONALE_QUERY_CHARS = 200
# The audit ``query_text`` of explain_decision's forwarding read (engine text).
_FORWARDING_READ = "forwarding explanation: re-read the case's member events from its log source"

_STATUSES = tuple(s.value for s in CaseStatus)
_VERDICTS = tuple(v.value for v in Verdict)
_ENTITY_KIND = {"ip": "ip", "user": "user", "host": "host", "file_hash": "hash", "domain": "domain"}


async def load_case_page(ctx: ChatToolContext) -> tuple[list[Any], int, bool]:
    """``(cases, store_total, ok)`` from the shared page cache; a store failure is
    reported (``ok=False``), never presented as an empty store."""
    from ...api.metrics_shared import fetch_case_page

    if ctx.cases is None:
        return [], 0, False
    try:
        cases, total = await fetch_case_page(ctx.cases, CASE_SCAN_LIMIT)
        return list(cases), int(total), True
    except Exception as exc:  # noqa: BLE001 — degrade, never raise into the turn
        logger.warning("chat case page load failed: %s", exc)
        return [], 0, False


def _norm_enum(value: Any, allowed: tuple[str, ...], *, upper: bool = False) -> Any:
    value = none_if_blank(value)
    if isinstance(value, str):
        candidate = value.strip().upper() if upper else value.strip().lower()
        candidate = candidate.replace(" ", "_").replace("-", "_")
        if candidate in allowed:
            return candidate
    return value


# --------------------------------------------------------------------------- #
# search_cases
# --------------------------------------------------------------------------- #
class SearchCasesInput(ToolInput):
    text: str | None = Field(default=None, max_length=120)
    status: Literal[_STATUSES] | None = None  # type: ignore[valid-type]
    status_group: Literal["active", "terminal"] | None = None
    verdict: Literal[_VERDICTS] | None = None  # type: ignore[valid-type]
    entity: str | None = Field(default=None, max_length=256)
    severity: Literal["critical", "high", "medium", "low", "info"] | None = None
    priority: Literal["P1", "P2", "P3", "P4"] | None = None
    assignee: str | None = Field(default=None, max_length=128)
    rule: str | None = Field(default=None, max_length=128)
    window_hours: int | None = Field(default=None, ge=1, le=720)
    sort_field: Literal["created_at", "updated_at", "risk_score"] = "created_at"
    sort_order: Literal["desc", "asc"] = "desc"
    limit: int = Field(default=20, ge=1, le=50)

    @field_validator("text", "entity", "assignee", "rule", "window_hours", mode="before")
    @classmethod
    def _blank(cls, value: Any) -> Any:
        return none_if_blank(value)

    @field_validator("status", mode="before")
    @classmethod
    def _status(cls, value: Any) -> Any:
        return _norm_enum(value, _STATUSES)

    @field_validator("status_group", mode="before")
    @classmethod
    def _group(cls, value: Any) -> Any:
        value = _norm_enum(value, ("active", "terminal", "open", "closed"))
        return {"open": "active", "closed": "terminal"}.get(value, value) if isinstance(value, str) else value

    @field_validator("verdict", mode="before")
    @classmethod
    def _verdict(cls, value: Any) -> Any:
        return _norm_enum(value, _VERDICTS, upper=True)

    @field_validator("severity", mode="before")
    @classmethod
    def _severity(cls, value: Any) -> Any:
        return _norm_enum(value, ("critical", "high", "medium", "low", "info"))

    @field_validator("priority", mode="before")
    @classmethod
    def _priority(cls, value: Any) -> Any:
        return _norm_enum(value, ("P1", "P2", "P3", "P4"), upper=True)

    def memory_filters(self) -> bool:
        return any(getattr(self, k) is not None for k in ("text", "verdict", "severity", "priority", "assignee", "rule"))

    def filters(self) -> dict[str, Any]:
        keys = ("text", "status", "status_group", "verdict", "entity", "severity", "priority", "assignee", "rule")
        return {k: getattr(self, k) for k in keys if getattr(self, k) is not None}


def _case_matches(case: Any, args: SearchCasesInput, prefs: Any, window: Any) -> bool:
    status = enum_value(case.status)
    if args.status and status != args.status:
        return False
    if args.status_group == "active" and status not in OPEN_CASE_STATUSES:
        return False
    if args.status_group == "terminal" and status not in TERMINAL_CASE_STATUSES:
        return False
    if args.verdict and enum_value(case.verdict) != args.verdict:
        return False
    if args.entity and str(getattr(case.entity, "value", "")) != args.entity:
        return False
    if args.severity and case_severity(case, prefs) != args.severity:
        return False
    if args.priority:
        from .common import case_priority

        if case_priority(case, prefs) != args.priority:
            return False
    if args.assignee is not None:
        wanted = args.assignee.strip().lower()
        actual = (case.assignee or "").strip().lower()
        if wanted in ("unassigned", "none", "nobody", "(unassigned)"):
            if actual:
                return False
        elif actual != wanted:
            return False
    if args.rule and args.rule.lower() not in {str(r).lower() for r in case.rule_ids or []}:
        return False
    if args.text:
        needle = args.text.lower()
        hay = " ".join(str(v) for v in (
            case.case_id, case.case_number, case.title, getattr(case.entity, "value", ""),
            case.source_name, " ".join(case.tags or []), " ".join(case.rule_ids or []),
        ) if v)
        if needle not in hay.lower():
            return False
    if window is not None:
        created = _created(case)
        # Never-drop (#4): a case without a parseable creation time cannot be placed
        # outside the window, so it stays, exactly as the store push-down keeps it.
        if created is not None and not (window.start <= created <= window.end):
            return False
    return True


def _created(case: Any):
    from datetime import datetime, timezone

    raw = getattr(case, "created_at", None)
    if not isinstance(raw, str) or not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _sort_cases(cases: list[Any], field: str, order: str) -> list[Any]:
    def key(case: Any) -> Any:
        if field == "risk_score":
            return finite(case.risk_score) or 0.0
        return str(getattr(case, field, "") or "")
    return sorted(cases, key=key, reverse=(order == "desc"))


class SearchCasesTool(ChatTool):
    name: ClassVar[str] = "search_cases"
    label: ClassVar[str] = "Searched cases"
    scope: ClassVar[str] = "cases"
    requires: ClassVar[tuple[tuple[str, str], ...]] = (("cases", "read"),)
    data_source: ClassVar[str] = "Case store"
    signature: ClassVar[str] = (
        "search_cases(text?, status?, status_group?=active|terminal, verdict?=TRUE_POSITIVE|FALSE_POSITIVE|"
        "NEEDS_HUMAN, entity?, severity?, priority?=P1..P4, assignee?, rule?, window_hours?, "
        "sort_field?=created_at|updated_at|risk_score, sort_order?, limit?=20) -- find and count cases"
    )
    display_keys: ClassVar[tuple[str, ...]] = (
        "text", "status", "status_group", "verdict", "entity", "severity", "priority",
        "assignee", "rule", "window_hours", "sort_field", "limit",
    )

    async def run(self, ctx: ChatToolContext, **inp: Any) -> ToolOutcome:
        args, error = parse_input(SearchCasesInput, inp)
        if error is not None:
            return error
        if args.status and args.status_group:
            return ToolOutcome.failure("Invalid input: choose status or status_group, not both")
        if ctx.cases is None:
            return ToolOutcome.failure("The case store is not available")
        window = None
        if args.window_hours is not None or ctx.time_range is not None:
            window = resolve_window(ctx, window_hours=args.window_hours)
            if isinstance(window, str):
                return ToolOutcome.failure(window)
        scanned: int | None = None
        if args.memory_filters():
            cases, store_total, ok = await load_case_page(ctx)
            if not ok:
                return ToolOutcome.failure("The case store did not answer")
            matched = _sort_cases(
                [c for c in cases if _case_matches(c, args, ctx.prefs, window)],
                args.sort_field, args.sort_order,
            )
            count = len(matched)
            scanned = len(cases)
            exact = store_total <= scanned
            page = matched[: args.limit]
            breakdown_cases = matched
        else:
            try:
                page, count, exact = await ctx.cases.list_window(
                    created_from=window.iso_from() if window else None,
                    created_to=window.iso_to() if window else None,
                    status=args.status, status_group=args.status_group,
                    entity_value=args.entity, limit=args.limit,
                    sort_field=args.sort_field, sort_order=args.sort_order,
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("search_cases list failed: %s", exc)
                return ToolOutcome.failure("The case store did not answer")
            page = list(page)
            count = int(count)
            breakdown_cases = page if count <= len(page) else None
        prefs = ctx.prefs
        by_verdict = Counter(enum_value(c.verdict) or "none" for c in (breakdown_cases or []))
        by_status = Counter(enum_value(c.status) or "unknown" for c in (breakdown_cases or []))
        observation: dict[str, Any] = {
            "filters": args.filters(),
            "window": window.label if window else "all time",
            "count": count,
            "exact": bool(exact),
            "returned": len(page),
            "cases": [case_row(c, prefs) for c in page[:_OBS_CASES]],
        }
        if scanned is not None:
            observation["scanned"] = scanned
        if breakdown_cases is not None:
            observation["by_verdict"] = dict(by_verdict)
            observation["by_status"] = dict(by_status)
        items = [case_list_item(c, prefs) for c in page[:_CASE_LIST_MAX]]
        artifacts = [Artifact(
            id="a1", kind="case_list", title="Matching cases", title_trusted=True,
            data={"items": items}, provenance="code", untrusted_labels=True,
            basis="exact" if exact else "sample", total=count, truncated=count > len(items),
            window=window.label if window else None,
        )]
        if breakdown_cases:
            if args.verdict:
                pairs, title, dim = list(by_status.items()), "Matching cases by status", "status"
            else:
                pairs, title, dim = list(by_verdict.items()), "Matching cases by verdict", "verdict"
            artifacts.append(Artifact(
                id="a2", kind="categories", title=title, title_trusted=True,
                data=categories(pairs, dimension=dim), provenance="code",
                basis="exact" if exact else "sample", total=count, window=window.label if window else None,
            ))
        open_count = sum(1 for c in (breakdown_cases or page) if enum_value(c.status) in OPEN_CASE_STATUSES)
        risks = [finite(c.risk_score) for c in (breakdown_cases or page) if finite(c.risk_score) is not None]
        artifacts.append(Artifact(
            id=f"a{len(artifacts) + 1}", kind="kpis", title="Key figures", title_trusted=True,
            data={"items": [
                kpi("matched", "Matching cases", count, bound=not exact),
                kpi("open", "Still open", open_count, bound=breakdown_cases is None,
                    context=None if breakdown_cases is not None else "in the returned page"),
                kpi("avg_risk", "Average risk", round(sum(risks) / len(risks), 1) if risks else None, "score"),
            ]},
            provenance="code", basis="exact" if exact else "sample", total=count,
            window=window.label if window else None,
        ))
        summary = f"{fmt_int(count)} {'cases' if count != 1 else 'case'} matched"
        summary += "" if exact else f" (lower bound; {fmt_int(scanned)} newest cases scanned)" if scanned else " (lower bound)"
        if window is not None:
            summary += f" ({window.label})"
        coverage = None
        if scanned is not None and not exact:
            coverage = f"newest {fmt_int(scanned)} cases scanned"
        return ToolOutcome(
            ok=True, summary=summary,
            untrusted_params={k: str(v) for k, v in args.filters().items() if k in ("text", "entity", "assignee", "rule")},
            observation=observation, artifacts=artifacts, rows=count,
            basis="exact" if exact else "sample", coverage=coverage,
        )


# --------------------------------------------------------------------------- #
# get_case
# --------------------------------------------------------------------------- #
GET_CASE_SECTIONS = ("summary", "evidence", "timeline", "decision", "mitre", "rationale", "campaign")


class GetCaseInput(ToolInput):
    case_id: str | None = Field(default=None, max_length=128)
    include: list[Literal[GET_CASE_SECTIONS]] = Field(  # type: ignore[valid-type]
        default_factory=lambda: ["summary", "evidence", "timeline", "decision", "mitre"], max_length=7,
    )

    @field_validator("case_id", mode="before")
    @classmethod
    def _blank(cls, value: Any) -> Any:
        return none_if_blank(value)

    @field_validator("include", mode="before")
    @classmethod
    def _include(cls, value: Any) -> Any:
        if value in (None, "", []):
            return ["summary", "evidence", "timeline", "decision", "mitre"]
        if isinstance(value, str):
            value = [value]
        if isinstance(value, list):
            out = []
            for item in value:
                key = str(item).strip().lower()
                key = {"why": "rationale", "history": "timeline", "attack": "mitre"}.get(key, key)
                if key in GET_CASE_SECTIONS and key not in out:
                    out.append(key)
            return out or ["summary"]
        return value


async def find_case(ctx: ChatToolContext, case_id: str) -> Any:
    """A case by id, or by its display ``case_number`` (case-insensitive)."""
    try:
        case = await ctx.cases.get(case_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("case lookup failed: %s", exc)
        case = None
    if case is not None:
        return case
    wanted = case_id.strip().lower()
    cases, _total, _ok = await load_case_page(ctx)
    return next(
        (c for c in cases if wanted in {str(c.case_id).lower(), str(c.case_number or "").lower()}),
        None,
    )


def _last_decision_reason(case: Any) -> str | None:
    for entry in reversed(list(case.status_history or [])):
        if str(getattr(entry, "by", "")) in ("agent", "system", "analyst_policy"):
            return opt_text(getattr(entry, "reason", ""), 300)
    return None


class GetCaseTool(ChatTool):
    name: ClassVar[str] = "get_case"
    label: ClassVar[str] = "Read a case"
    scope: ClassVar[str] = "cases"
    requires: ClassVar[tuple[tuple[str, str], ...]] = (("cases", "read"),)
    optional_grants: ClassVar[tuple[tuple[str, str], ...]] = (("cost", "view"),)
    data_source: ClassVar[str] = "Case store and audit trail"
    signature: ClassVar[str] = (
        "get_case(case_id?, include?=[summary,evidence,timeline,decision,mitre] (+rationale, campaign)) "
        "-- one case: verdict, risk, evidence summaries, status timeline and the recorded decision"
    )
    display_keys: ClassVar[tuple[str, ...]] = ("case_id", "include")

    def display_params(self, inp: dict[str, Any]) -> dict[str, Any]:
        params = dict(inp) if isinstance(inp, dict) else {}
        if isinstance(params.get("include"), list):
            params["include"] = ",".join(str(i) for i in params["include"][:7])
        return super().display_params(params)

    async def run(self, ctx: ChatToolContext, **inp: Any) -> ToolOutcome:
        args, error = parse_input(GetCaseInput, inp)
        if error is not None:
            return error
        case_id = args.case_id or ctx.case_id
        if not case_id:
            return ToolOutcome.failure("Invalid input: check case_id")
        if ctx.cases is None:
            return ToolOutcome.failure("The case store is not available")
        case = await find_case(ctx, case_id)
        if case is None:
            return ToolOutcome.failure("Case not found", summary="Case not found")
        prefs = ctx.prefs
        include = set(args.include)
        row = case_row(case, prefs)
        observation: dict[str, Any] = {"case": row}
        if "summary" in include:
            row.update({
                "summary": opt_text(case.summary, 600),
                "recommended_action": opt_text(case.recommended_action, 300),
                "disposition": enum_value(case.disposition),
                "updated_at": iso_or_none(case.updated_at),
                "campaign_id": opt_text(case.campaign_id, 128),
                "detection_source": opt_text(case.detection_source, 40),
                "evidence_items": len(case.evidence or []),
                "member_events": len(case.member_event_ids or []),
            })
        if "evidence" in include:
            observation["evidence"] = [
                {"summary": text(e.summary, 300)} for e in list(case.evidence or [])[:5]
            ]
        history = list(case.status_history or [])
        if "timeline" in include:
            observation["timeline"] = [
                {"at": iso_or_none(h.at), "from": h.from_status or None, "to": h.to_status,
                 "by": text(h.by, 60), "reason": opt_text(h.reason, 200)}
                for h in history[-10:]
            ]
        if "decision" in include:
            observation["decision"] = {
                "status": enum_value(case.status),
                "decision_by": enum_value(case.decision_by),
                "objection_window_expires_at": iso_or_none(case.objection_window_expires_at),
                "last_decision_reason": _last_decision_reason(case),
            }
        technique_rows: list[dict[str, Any]] = []
        if "mitre" in include and case.mitre:
            from ...engine import mitre as mitre_corpus

            for tid in case.mitre[:20]:
                meta = mitre_corpus.technique(tid)
                if meta is None:
                    continue
                tactics = meta.get("tactics") or []
                technique_rows.append({
                    "id": meta["id"], "name": str(meta.get("name") or "")[:120],
                    "tactic": str(tactics[0]) if tactics else None,
                })
            observation["mitre"] = technique_rows
        if "rationale" in include and ctx.audit is not None:
            observation["rationale"] = await self._rationale(ctx, case)
        if "campaign" in include and case.campaign_id and ctx.campaigns is not None:
            try:
                campaign = await ctx.campaigns.get(case.campaign_id)
            except Exception:  # noqa: BLE001
                campaign = None
            if campaign is not None:
                observation["campaign"] = {
                    "id": text(campaign.id, 128), "name": opt_text(campaign.name, 120),
                    "status": enum_value(campaign.status), "case_count": len(campaign.case_ids),
                }
        artifacts = self._artifacts(ctx, case, technique_rows, history)
        verdict = enum_value(case.verdict) or "no verdict"
        status = enum_value(case.status) or "unknown"
        summary = (
            f"Case read: status {status}, verdict {verdict}, risk {fmt_int(case.risk_score)}"
            f", {len(case.evidence or [])} evidence items"
        )
        citation = None
        try:
            citation = Citation(
                id=citation_id("C", 1, ctx), kind="case", title=case.title or case.case_id,
                case_id=case.case_id, untrusted=True,
            )
        except Exception:  # noqa: BLE001 — an unusual case id simply is not citable
            citation = None
        return ToolOutcome(
            ok=True, summary=summary, untrusted_params={"case_id": str(case_id)[:128]},
            observation=observation, artifacts=artifacts, rows=1, basis="exact",
            citations=[citation] if citation else [],
        )

    async def _rationale(self, ctx: ChatToolContext, case: Any) -> dict[str, Any]:
        """The "why" of the latest run as a WHITELIST of engine-derived fields.

        ``build_rationale`` also returns audit payloads that must never reach a model
        (SPEC §5.3: ``prompt_excerpt``, ``tool_input`` and ``tool_output_summary``):
        ``tools[].summary`` IS the tool output summary (which can hold raw exception
        text, §5.2) and ``knowledge[].snippet`` comes from the CONTEXT row's
        ``tool_input`` (imported intel and precedent text). Only tool names and call
        counts, the native queries bounded like ``audit_search`` does, knowledge
        source labels, the persona/playbook ids, the deterministic case-manager
        rationale and a bounded reasoning excerpt are projected; the engine fences
        the whole observation."""
        from ...engine.case_rationale import build_rationale

        try:
            rows = await ctx.audit.records_for_case(case.case_id, 500)
            data = build_rationale(case.case_id, case, rows)
        except Exception as exc:  # noqa: BLE001 — explainability degrades, never fails
            logger.info("rationale unavailable for chat: %s", exc)
            return {"available": False}
        calls: Counter[str] = Counter()
        queries: list[str] = []
        for entry in data.get("tools") or []:
            if not isinstance(entry, dict):
                continue
            calls[text(entry.get("tool"), 60) or "tool"] += 1
            query = opt_text(entry.get("query"), _RATIONALE_QUERY_CHARS)
            if query and query not in queries and len(queries) < 3:
                queries.append(query)
        knowledge_sources: Counter[str] = Counter(
            text(k.get("source"), 60) or "unknown"
            for k in (data.get("knowledge") or []) if isinstance(k, dict)
        )
        persona = data.get("persona") if isinstance(data.get("persona"), str) else ""
        playbook = data.get("playbook") if isinstance(data.get("playbook"), dict) else {}
        return {
            "available": True,
            "tool_calls": [{"tool": name, "calls": n} for name, n in sorted(calls.items())][:10],
            "queries": queries,
            "knowledge_sources": dict(knowledge_sources.most_common(5)),
            "reasoning": opt_text(data.get("reasoning"), 600),
            # Engine-authored by case_manager (verdict enum, numbers, policy values).
            "decision_rationale": opt_text(data.get("decision_rationale"), 400),
            "persona": opt_text(persona, 60),
            "playbook": opt_text(playbook.get("id"), 60),
        }

    def _artifacts(self, ctx: ChatToolContext, case: Any, techniques: list[dict[str, Any]], history: list[Any]) -> list[Artifact]:
        artifacts: list[Artifact] = []
        entity_type = enum_value(getattr(case.entity, "type", None)) or ""
        kind = _ENTITY_KIND.get(entity_type)
        facts = [
            {"label": "Case", "value": str(case.case_number or case.case_id)},
            {"label": "Status", "value": enum_value(case.status) or "unknown"},
            {"label": "Verdict", "value": enum_value(case.verdict) or "none"},
            {"label": "Decided by", "value": enum_value(case.decision_by) or "not decided"},
        ]
        if case.rule_ids:
            facts.append({"label": "Rules", "value": ", ".join(str(r) for r in case.rule_ids[:5]), "untrusted": True})
        if case.source_name or case.source_id:
            facts.append({"label": "Source", "value": str(case.source_name or case.source_id), "untrusted": True})
        if case.assignee:
            facts.append({"label": "Assignee", "value": str(case.assignee), "untrusted": True})
        if kind:
            artifacts.append(Artifact(
                id="a1", kind="entity", title="Case entity", title_trusted=True,
                data={
                    "entity": {"kind": kind, "value": str(case.entity.value)},
                    "risk": finite(case.risk_score),
                    "verdict": verdict_semantic(case.verdict),
                    "facts": facts,
                    "related_cases": [
                        {"case_id": str(cid), "title": str(cid)} for cid in list(case.related_case_ids or [])[:5]
                    ],
                    "first_seen": iso_or_none(case.created_at),
                    "last_seen": iso_or_none(case.updated_at),
                },
                provenance="code", untrusted_labels=True,
            ))
        if history:
            artifacts.append(Artifact(
                id=f"a{len(artifacts) + 1}", kind="timeline", title="Status history", title_trusted=True,
                data={"events": [
                    {"at": iso_or_none(h.at), "label": f"{h.from_status or 'created'} -> {h.to_status}",
                     "detail": opt_text(f"by {h.by}: {h.reason}" if h.reason else f"by {h.by}", 500),
                     "kind": "action", "semantic": h.to_status if h.to_status in (
                         "new", "investigating", "escalated", "on_hold", "resolved", "closed") else None}
                    for h in history[-50:] if iso_or_none(h.at)
                ]},
                provenance="code", untrusted_labels=True, total=len(history), truncated=len(history) > 50,
            ))
        items = [
            kpi("risk", "Risk score", case.risk_score, "score", display="gauge"),
            kpi("confidence", "Confidence", (finite(case.confidence) or 0) * 100 if finite(case.confidence) is not None else None, "percent"),
            kpi("evidence", "Evidence items", len(case.evidence or [])),
            kpi("events", "Member events", len(case.member_event_ids or [])),
        ]
        if ctx.has("cost", "view"):
            items.append(kpi("token_cost", "AI cost", finite(case.token_cost), "usd"))
        artifacts.append(Artifact(
            id=f"a{len(artifacts) + 1}", kind="kpis", title="Case figures", title_trusted=True,
            data={"items": items}, provenance="code",
        ))
        if techniques:
            artifacts.append(Artifact(
                id=f"a{len(artifacts) + 1}", kind="mitre", title="ATT&CK techniques", title_trusted=True,
                data={"techniques": techniques}, provenance="code",
            ))
        return artifacts


# --------------------------------------------------------------------------- #
# shift_report
# --------------------------------------------------------------------------- #
class ShiftReportInput(ToolInput):
    window_hours: int | None = Field(default=None, ge=1, le=168)
    attention_limit: int = Field(default=10, ge=1, le=25)

    @field_validator("window_hours", mode="before")
    @classmethod
    def _blank(cls, value: Any) -> Any:
        return none_if_blank(value)


_HEADLINE_LABELS = {
    "open": "Open cases", "escalated": "Escalated", "needs_human": "Needs a human",
    "unassigned": "Unassigned", "sla_breached": "SLA breached",
}


class ShiftReportTool(ChatTool):
    name: ClassVar[str] = "shift_report"
    label: ClassVar[str] = "Built the shift snapshot"
    scope: ClassVar[str] = "cases"
    requires: ClassVar[tuple[tuple[str, str], ...]] = (("cases", "read"),)
    data_source: ClassVar[str] = "Open cases and shift handoff"
    signature: ClassVar[str] = (
        "shift_report(window_hours?, attention_limit?=10) -- deterministic shift snapshot: what needs "
        "attention, SLA aging, workload, changes since the prior window, open action items (you write the prose)"
    )
    display_keys: ClassVar[tuple[str, ...]] = ("window_hours", "attention_limit")

    async def run(self, ctx: ChatToolContext, **inp: Any) -> ToolOutcome:
        args, error = parse_input(ShiftReportInput, inp)
        if error is not None:
            return error
        if ctx.standup is None or not hasattr(ctx.standup, "shift_snapshot"):
            return ToolOutcome.failure("The shift report is not available")
        window = resolve_window(ctx, window_hours=args.window_hours, default_hours=24)
        if isinstance(window, str):
            return ToolOutcome.failure(window)
        if not window.trailing:
            # The snapshot is "the queue now" counted back from now: under a past
            # range it would read outside the selection (§4.8.4) and mislabel it.
            return ToolOutcome.failure(
                "The shift snapshot covers the hours up to now; the selected range ends in the past"
            )
        # Whole hours, never wider than asked, at most a week (the snapshot's bound).
        hours = min(168, max(1, math.floor(window.span_hours + 1e-6)))
        notes = []
        if window.span_hours > 168 + 1e-6:
            notes.append("the shift snapshot covers at most the last 7 days")
        elif abs(window.span_hours - hours) > 1e-6:
            notes.append("the range was narrowed to whole hours")
        try:
            snap = await ctx.standup.shift_snapshot(ctx.prefs, window_hours=hours)
        except Exception as exc:  # noqa: BLE001
            logger.warning("shift snapshot failed: %s", exc)
            return ToolOutcome.failure("The shift report could not be built")
        snap = snap if isinstance(snap, dict) else {}
        headline = snap.get("headline_counts") or {}
        deltas = snap.get("deltas") or {}
        queue = [q for q in (snap.get("attention_queue") or []) if isinstance(q, dict)]
        sla = snap.get("sla_aging") or {}
        workload = [w for w in (snap.get("workload") or []) if isinstance(w, dict)]
        actions = [a for a in (snap.get("action_items") or []) if isinstance(a, dict)]
        limit = args.attention_limit
        observation = {
            "window": f"last {hours}h",
            "headline": {k: headline.get(k) for k in _HEADLINE_LABELS},
            "changes_vs_prior_window": {
                k: {"current": (deltas.get(k) or {}).get("current"), "prior": (deltas.get(k) or {}).get("prior"),
                    "delta": (deltas.get(k) or {}).get("delta")}
                for k in _HEADLINE_LABELS if isinstance(deltas.get(k), dict)
            },
            "attention": [
                {"case_id": text(q.get("case_id"), 128), "title": text(q.get("title"), 160),
                 "status": q.get("status"), "verdict": q.get("verdict"),
                 "risk_score": finite(q.get("risk_score")), "severity": q.get("severity_band"),
                 "age_minutes": finite(q.get("age_minutes")), "assignee": opt_text(q.get("assignee"), 80)}
                for q in queue[:limit]
            ],
            "sla": {
                "enabled": bool(sla.get("enabled")),
                "totals": (sla.get("totals") or {}),
                "breached": [
                    {"case_id": text(b.get("case_id"), 128), "overdue_minutes": finite(b.get("overdue_minutes"))}
                    for b in (sla.get("breached") or [])[:5] if isinstance(b, dict)
                ],
            },
            "workload": [
                {"analyst": text(w.get("analyst"), 80), "open": w.get("open"),
                 "escalated": w.get("escalated"), "needs_human": w.get("needs_human")}
                for w in workload[:10]
            ],
            "open_action_items": [
                {"title": text(a.get("title"), 200), "status": text(a.get("status"), 20),
                 "owner": opt_text(a.get("owner"), 80)}
                for a in actions[:5]
            ],
        }
        items = []
        for key, label in _HEADLINE_LABELS.items():
            delta = deltas.get(key) if isinstance(deltas.get(key), dict) else None
            items.append(kpi(
                key, label, headline.get(key),
                delta=({"value": finite(delta.get("delta")) or 0, "period_label": "vs prior window",
                        "good_direction": "down"} if delta and finite(delta.get("delta")) is not None else None),
            ))
        artifacts = [Artifact(
            id="a1", kind="kpis", title="Shift headline", title_trusted=True,
            data={"items": items}, provenance="code", window=f"last {hours}h",
        )]
        artifacts.append(Artifact(
            id="a2", kind="case_list", title="Needs attention", title_trusted=True,
            data={"items": [
                {"case_id": str(q.get("case_id") or ""), "title": display(q.get("title") or q.get("case_id")),
                 "severity": q.get("severity_band") if q.get("severity_band") in ("critical", "high", "medium", "low", "info") else None,
                 "verdict": verdict_semantic(q.get("verdict")), "status": q.get("status"),
                 "risk": finite(q.get("risk_score"))}
                for q in queue[:min(limit, _CASE_LIST_MAX)] if q.get("case_id")
            ]},
            provenance="code", untrusted_labels=True, total=len(queue), truncated=len(queue) > limit,
        ))
        if workload:
            artifacts.append(Artifact(
                id="a3", kind="categories", title="Open cases by analyst", title_trusted=True,
                data=categories([(w.get("analyst"), w.get("open")) for w in workload], dimension="analyst"),
                provenance="code", untrusted_labels=True,
            ))
        if actions:
            artifacts.append(Artifact(
                id=f"a{len(artifacts) + 1}", kind="table", title="Open action items", title_trusted=True,
                data={"columns": [column("title", "Action", untrusted=True), column("status", "Status"),
                                  column("owner", "Owner", untrusted=True)],
                      "rows": [[a.get("title"), a.get("status"), a.get("owner")] for a in actions[:25]]},
                provenance="code", untrusted_labels=True, total=len(actions), truncated=len(actions) > 25,
            ))
        summary = (
            f"Shift snapshot (last {hours}h): {fmt_int(headline.get('open'))} open, {fmt_int(headline.get('escalated'))} escalated, "
            f"{fmt_int(headline.get('unassigned'))} unassigned, {fmt_int(headline.get('sla_breached'))} past SLA"
        )
        return ToolOutcome(ok=True, summary=summary, observation=observation, artifacts=artifacts,
                           rows=len(queue), basis="exact", coverage="; ".join(notes) or None)


def display(value: Any) -> str:
    from ..blocks import display_text

    return display_text(value, 120)


# --------------------------------------------------------------------------- #
# list_campaigns
# --------------------------------------------------------------------------- #
class ListCampaignsInput(ToolInput):
    status: Literal["open", "monitoring", "resolved"] | None = None
    campaign_id: str | None = Field(default=None, max_length=128)
    limit: int = Field(default=10, ge=1, le=25)

    @field_validator("status", "campaign_id", mode="before")
    @classmethod
    def _blank(cls, value: Any) -> Any:
        value = none_if_blank(value)
        return value.strip().lower() if isinstance(value, str) and value.strip().lower() in ("open", "monitoring", "resolved") else value


class ListCampaignsTool(ChatTool):
    name: ClassVar[str] = "list_campaigns"
    label: ClassVar[str] = "Listed campaigns"
    scope: ClassVar[str] = "cases"
    requires: ClassVar[tuple[tuple[str, str], ...]] = (("cases", "read"),)
    data_source: ClassVar[str] = "Campaign correlation"
    signature: ClassVar[str] = (
        "list_campaigns(status?=open|monitoring|resolved, campaign_id?, limit?=10) -- cross-case "
        "campaigns: related cases grouped by shared entities and ATT&CK techniques"
    )
    display_keys: ClassVar[tuple[str, ...]] = ("status", "campaign_id", "limit")

    async def run(self, ctx: ChatToolContext, **inp: Any) -> ToolOutcome:
        args, error = parse_input(ListCampaignsInput, inp)
        if error is not None:
            return error
        if ctx.campaigns is None:
            return ToolOutcome.failure("Campaign correlation is not available")
        from ...engine.views import campaign_json

        try:
            if args.campaign_id:
                one = await ctx.campaigns.get(args.campaign_id)
                campaigns, total = ([one], 1) if one is not None else ([], 0)
            else:
                campaigns, total = await ctx.campaigns.list(status=args.status, limit=args.limit)
        except Exception as exc:  # noqa: BLE001
            logger.warning("list_campaigns failed: %s", exc)
            return ToolOutcome.failure("The campaign store did not answer")
        rows = [campaign_json(c) for c in campaigns]
        observation = {
            "status_filter": args.status,
            "total": total,
            "returned": len(rows),
            "campaigns": [
                {"id": text(r["id"], 128), "name": opt_text(r["name"], 120), "status": r["status"],
                 "case_count": r["case_count"], "case_ids": [text(c, 128) for c in r["case_ids"][:5]],
                 "entities": [f"{text(e['entity_type'], 20)}:{text(e['value'], 120)}" for e in r["entities"][:5]],
                 "mitre": [text(t, 16) for t in r["mitre"][:5]],
                 "severity": r["severity_rollup"], "first_seen": r["first_seen"], "last_seen": r["last_seen"]}
                for r in rows
            ],
        }
        columns = [
            column("campaign", "Campaign", untrusted=True), column("status", "Status", "status"),
            column("cases", "Cases", "number", align="right"), column("severity", "Severity", "severity"),
            column("first_seen", "First seen", "time"), column("last_seen", "Last seen", "time"),
            column("entities", "Shared entities", untrusted=True), column("mitre", "Techniques", "code"),
        ]
        table_rows = [
            [r["name"] or r["id"], r["status"], r["case_count"],
             r["severity_rollup"] if r["severity_rollup"] in ("critical", "high", "medium", "low", "info") else None,
             r["first_seen"], r["last_seen"],
             ", ".join(f"{e['entity_type']}:{e['value']}" for e in r["entities"][:3]),
             ", ".join(r["mitre"][:3])]
            for r in rows
        ]
        open_count = sum(1 for r in rows if r["status"] == "open")
        artifacts = [
            Artifact(id="a1", kind="table", title="Campaigns", title_trusted=True,
                     data={"columns": columns, "rows": table_rows}, provenance="code",
                     untrusted_labels=True, total=total, truncated=total > len(rows)),
            Artifact(id="a2", kind="kpis", title="Campaign figures", title_trusted=True,
                     data={"items": [
                         kpi("campaigns", "Campaigns", total),
                         kpi("open", "Open (listed)", open_count),
                         kpi("cases", "Cases linked (listed)", sum(r["case_count"] for r in rows)),
                     ]}, provenance="code"),
        ]
        summary = f"{fmt_int(total)} campaigns" + (f" with status {args.status}" if args.status else "")
        summary += f"; {fmt_int(len(rows))} listed"
        return ToolOutcome(ok=True, summary=summary, observation=observation, artifacts=artifacts,
                           rows=len(rows), basis="exact",
                           untrusted_params={"campaign_id": args.campaign_id} if args.campaign_id else {})


# --------------------------------------------------------------------------- #
# explain_decision
# --------------------------------------------------------------------------- #
class ExplainDecisionInput(ToolInput):
    verdict: Literal[_VERDICTS] | None = None  # type: ignore[valid-type]
    confidence: float | None = Field(default=None, ge=0, le=1)
    risk_score: float | None = Field(default=None, ge=0, le=100)
    case_id: str | None = Field(default=None, max_length=128)
    include: list[Literal["forwarding"]] = Field(default_factory=list, max_length=1)

    @field_validator("verdict", mode="before")
    @classmethod
    def _verdict(cls, value: Any) -> Any:
        return _norm_enum(value, _VERDICTS, upper=True)

    @field_validator("confidence", mode="before")
    @classmethod
    def _confidence(cls, value: Any) -> Any:
        value = none_if_blank(value)
        # "85%" or 85 means 0.85: models often speak in percent.
        if isinstance(value, str) and value.strip().endswith("%"):
            try:
                return float(value.strip()[:-1]) / 100
            except ValueError:
                return value
        if isinstance(value, (int, float)) and not isinstance(value, bool) and 1 < value <= 100:
            return float(value) / 100
        return value

    @field_validator("risk_score", "case_id", mode="before")
    @classmethod
    def _blank(cls, value: Any) -> Any:
        return none_if_blank(value)

    @field_validator("include", mode="before")
    @classmethod
    def _include(cls, value: Any) -> Any:
        if value in (None, "", []):
            return []
        if isinstance(value, str):
            value = [value]
        return [v for v in value if str(v).strip().lower() == "forwarding"][:1] if isinstance(value, list) else value


def _policy_rows(policy: Any) -> list[dict[str, Any]]:
    rows = []
    for key, label in (("false_positive", "FALSE_POSITIVE"), ("true_positive", "TRUE_POSITIVE")):
        entry = getattr(policy, key, None)
        rows.append({
            "verdict": label,
            "auto_close_enabled": bool(getattr(entry, "enabled", False)),
            "min_confidence": finite(getattr(entry, "min_confidence", None)),
            "max_risk_score": finite(getattr(entry, "max_risk_score", None)),
            "objection_window_minutes": finite(getattr(entry, "objection_window_minutes", None)),
        })
    rows.append({"verdict": "NEEDS_HUMAN", "auto_close_enabled": False, "min_confidence": None,
                 "max_risk_score": None, "objection_window_minutes": None,
                 "note": "never auto-closes (enforced in code)"})
    return rows


class ExplainDecisionTool(ChatTool):
    name: ClassVar[str] = "explain_decision"
    label: ClassVar[str] = "Explained the decision policy"
    scope: ClassVar[str] = "cases"
    requires: ClassVar[tuple[tuple[str, str], ...]] = (("cases", "read"),)
    optional_grants: ClassVar[tuple[tuple[str, str], ...]] = (("sources", "read"),)
    data_source: ClassVar[str] = "Auto-close policy (deterministic)"
    signature: ClassVar[str] = (
        "explain_decision(verdict?=TRUE_POSITIVE|FALSE_POSITIVE|NEEDS_HUMAN, confidence?=0..1, risk_score?=0..100, "
        "case_id?, include?=[forwarding]) -- what the deterministic close/escalate policy would do, the "
        "policy itself, a case's recorded decision, and optionally why its alert was or was not forwarded"
    )
    display_keys: ClassVar[tuple[str, ...]] = ("verdict", "confidence", "risk_score", "case_id", "include")

    def display_params(self, inp: dict[str, Any]) -> dict[str, Any]:
        params = dict(inp) if isinstance(inp, dict) else {}
        if isinstance(params.get("include"), list):
            params["include"] = ",".join(str(i) for i in params["include"][:2])
        return super().display_params(params)

    async def run(self, ctx: ChatToolContext, **inp: Any) -> ToolOutcome:
        from ...engine.case_manager import decide

        args, error = parse_input(ExplainDecisionInput, inp)
        if error is not None:
            return error
        prefs = ctx.prefs
        policy = prefs.auto_close
        case_id = args.case_id or (ctx.case_id if not args.verdict else None)
        case = None
        if case_id:
            if ctx.cases is None:
                return ToolOutcome.failure("The case store is not available")
            case = await find_case(ctx, case_id)
            if case is None and args.case_id:
                return ToolOutcome.failure("Case not found")
        verdict_name = args.verdict or (enum_value(case.verdict) if case is not None else None)
        confidence = args.confidence if args.confidence is not None else (
            finite(case.confidence) if case is not None else None)
        risk = args.risk_score if args.risk_score is not None else (
            finite(case.risk_score) if case is not None else None)
        observation: dict[str, Any] = {"policy": _policy_rows(policy)}
        what_if = None
        if verdict_name is not None:
            decision = decide(
                Verdict(verdict_name), float(confidence or 0.0), float(risk or 0.0), policy,
                escalation_confidence=prefs.escalation_confidence,
                critical_severity=prefs.critical_severity,
            )
            what_if = {
                "verdict": verdict_name,
                "confidence": round(float(confidence or 0.0), 4),
                "risk_score": round(float(risk or 0.0), 2),
                "status": decision.status.value,
                "decision_by": decision.decision_by.value,
                "auto_closed": decision.status == CaseStatus.CLOSED,
                "escalate": decision.escalate,
                # Engine-authored text (verdict enum + numbers + policy values).
                "rationale": decision.rationale,
            }
            observation["what_if"] = what_if
        if case is not None:
            observation["recorded"] = {
                "case_id": text(case.case_id, 128),
                "status": enum_value(case.status),
                "decision_by": enum_value(case.decision_by),
                "verdict": enum_value(case.verdict),
                "last_decision_reason": _last_decision_reason(case),
            }
        notes: list[str] = []
        if "forwarding" in args.include:
            if case is None:
                notes.append("forwarding needs a case_id")
            elif not ctx.has("sources", "read"):
                notes.append("forwarding needs the sources:read permission")
            elif ctx.cluster_for_case is None:
                notes.append("forwarding is not available here")
            else:
                observation["forwarding"] = await self._forwarding(ctx, case)
        if notes:
            observation["notes"] = notes

        rows = _policy_rows(policy)
        artifacts = [Artifact(
            id="a1", kind="table", title="Auto-close policy", title_trusted=True,
            data={"columns": [
                column("verdict", "Verdict class", "verdict"), column("enabled", "Auto-close"),
                column("min_confidence", "Min confidence", "number", unit="ratio", align="right"),
                column("max_risk_score", "Max risk", "number", unit="score", align="right"),
                column("window", "Objection window", "number", unit="minutes", align="right"),
            ], "rows": [
                [r["verdict"].lower(), "on" if r["auto_close_enabled"] else "off", r["min_confidence"],
                 r["max_risk_score"], r["objection_window_minutes"]]
                for r in rows
            ]},
            provenance="code",
        )]
        if what_if is not None:
            entry = getattr(policy, "false_positive" if verdict_name == "FALSE_POSITIVE" else "true_positive", None) \
                if verdict_name in ("FALSE_POSITIVE", "TRUE_POSITIVE") else None
            items = [
                kpi("confidence", "Confidence", what_if["confidence"] * 100, "percent"),
                kpi("risk", "Risk score", what_if["risk_score"], "score"),
            ]
            if entry is not None:
                items.append(kpi("min_confidence", "Policy min confidence", (finite(entry.min_confidence) or 0) * 100, "percent"))
                items.append(kpi("max_risk", "Policy max risk", finite(entry.max_risk_score), "score"))
            artifacts.append(Artifact(
                id="a2", kind="kpis", title="Decision inputs", title_trusted=True,
                data={"items": items}, provenance="code",
            ))
        if what_if is not None:
            outcome_text = "auto-closed" if what_if["auto_closed"] else "routed to a human"
            summary = (f"{verdict_name} at confidence {what_if['confidence']:.2f} and risk "
                       f"{what_if['risk_score']:.0f} would be {outcome_text}")
            if what_if["escalate"]:
                summary += " (escalated)"
        else:
            summary = "Auto-close policy read"
        forwarding = observation.get("forwarding")
        query = None
        if isinstance(forwarding, dict):
            # The forwarding explanation re-reads the case's source events (a log
            # read): the summary and the audit row's query text both say so.
            query = _FORWARDING_READ
            summary += f"; forwarding gate: {text(forwarding.get('gate'), 40) or 'unknown'} (case events re-read)"
        return ToolOutcome(ok=True, summary=summary, observation=observation, artifacts=artifacts,
                           basis="exact", rows=None, query=query,
                           untrusted_params={"case_id": str(case_id)[:128]} if case_id else {})

    async def _forwarding(self, ctx: ChatToolContext, case: Any) -> dict[str, Any]:
        from ...engine.forwarding import explain_forwarding

        try:
            cluster = await ctx.cluster_for_case(case)
        except Exception as exc:  # noqa: BLE001 — honest "unknown", never an error
            logger.info("forwarding cluster rebuild failed: %s", exc)
            cluster = None
        if cluster is None:
            return {
                "gate": "unknown", "forwarded": False, "dropped": False,
                "sentence": "The originating events for this case are no longer retrievable, "
                            "so the forwarding decision cannot be reconstructed.",
            }
        explanation = explain_forwarding(cluster, ctx.prefs).to_dict()
        return {
            "gate": explanation.get("gate"),
            "forwarded": bool(explanation.get("forwarded")),
            "dropped": bool(explanation.get("dropped")),
            # Engine-authored sentence and notes (gate names, numbers, config terms).
            "sentence": text(explanation.get("sentence"), 400),
            "notes": [text(n, 200) for n in (explanation.get("notes") or [])[:5]],
        }


__all__ = [
    "CASE_SCAN_LIMIT",
    "ExplainDecisionTool",
    "GetCaseTool",
    "ListCampaignsTool",
    "SearchCasesTool",
    "ShiftReportTool",
    "find_case",
    "load_case_page",
]
