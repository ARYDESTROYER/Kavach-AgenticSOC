"""es_query — the ONLY path to the log surface (Section 6.5).

Read-only, always. The tool accepts structured, validated parameters (never raw
free-form DSL from the model) and delegates execution to the active
:class:`~app.connectors.base.PullConnector` (Elasticsearch, OpenSearch, …). The
connector compiles the structured query to its native dialect, runs it through
the scoped read-only credential, and returns normalised events plus a
:class:`~app.connectors.base.QueryRendering` (the native query string + language)
for the one-click Discover/deep-link locator (Section 8.1/8.2).

Routing through the connector is what makes the log surface source-agnostic: the
LLM emits the same structured shape regardless of which SIEM backs the deployment.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from ..config import Preferences
from ..connectors.base import PullConnector, SearchResult, StructuredQuery
from ..evidence_fields import project_evidence
from .base import Tool, ToolResult

logger = logging.getLogger("tlsoc.tools.es_query")

_MAX_SIZE = 200
_DEFAULT_SIZE = 50
# Total serialised budget for the returned rows, applied ONLY where the rows are
# handed to a model. The investigator wraps the whole observation in ``fence_block``,
# whose 16,000-char net is a blind byte cut that leaves the model holding invalid
# JSON with only a server-side log line; this sits under that net with headroom for
# the summary and the other observation keys, so rows are dropped WHOLE and counted
# rather than sliced mid-record.
#
# It is NOT the default. Chat renders these rows as an operator's result table and
# computes its top-N facets over them — a budget there would silently shrink a
# 50-row table and, worse, publish facets computed over the remainder as if they
# described the whole result. Chat's own model-visible payload is separately bounded
# (5 sample rows), so it needs no budget here.
DEFAULT_MAX_RESULT_CHARS = 12000

# Slack for everything in the observation that is not the rows or the field list:
# the fixed disclosure prose, the summary counts, the JSON keys and the ok/error
# members the investigator wraps around it.
_OBSERVATION_OVERHEAD = 1200

# Rows are the point of the result; the reserve above is never allowed to squeeze
# them out entirely.
_MIN_ROW_CHARS = 2000


class EsQueryTool(Tool):
    name = "es_query"
    description = (
        "Search the read-only log indices for events matching structured filters "
        "(ip, user, host, rule, minimum severity, free-text 'contains', time range)."
    )
    input_schema = {
        "type": "object",
        "properties": {
            "ip": {"type": "string", "description": "source IP to filter on"},
            "user": {"type": "string"},
            "host": {"type": "string"},
            "rule": {"type": "string", "description": "rule/module value to filter on"},
            "severity_gte": {"type": "number"},
            "contains": {
                "type": "string",
                "description": (
                    "free-text substring. Matched against a FIXED set of fields (rule "
                    "name, message, event.original/action and the configured case-"
                    "evidence paths) — NOT the whole record. The result reports the "
                    "exact fields searched; a zero result means no match in THOSE "
                    "fields, never that the record lacks the data."
                ),
            },
            "ids": {"type": "array", "items": {"type": "string"}},
            "time_from": {"type": "string", "description": "e.g. now-24h or ISO timestamp"},
            "time_to": {"type": "string", "description": "e.g. now or ISO timestamp"},
            "size": {"type": "integer", "description": f"max hits (<= {_MAX_SIZE})"},
        },
        "additionalProperties": False,
    }

    def __init__(
        self,
        source: PullConnector,
        prefs: Preferences,
        *,
        max_result_chars: int | None = None,
    ) -> None:
        """``max_result_chars`` bounds the serialised rows, for callers that hand the
        whole result to a model. Left unset (the default) every returned row is
        included — see :data:`DEFAULT_MAX_RESULT_CHARS`."""
        self._source = source
        self._prefs = prefs
        self._max_result_chars = max_result_chars

    async def run(self, **kwargs: Any) -> ToolResult:
        size = min(int(kwargs.get("size") or _DEFAULT_SIZE), _MAX_SIZE)
        try:
            # ``severity_gte`` may legitimately be 0 — DON'T collapse it with ``or``.
            sev = kwargs.get("severity_gte")
            sev = sev if sev not in (None, "") else None
            query = StructuredQuery(
                ip=_clean(kwargs.get("ip")),
                user=_clean(kwargs.get("user")),
                host=_clean(kwargs.get("host")),
                rule=_clean(kwargs.get("rule")),
                severity_gte=sev,
                contains=_clean(kwargs.get("contains")),
                ids=list(kwargs.get("ids") or []),
                time_from=kwargs.get("time_from", "now-24h"),
                time_to=kwargs.get("time_to", "now"),
                size=size,
                sort_desc=True,
            )
            result = await self._source.search(self._prefs, query)
            return self._format(
                result, contains=query.contains, ids_lookup=bool(query.ids)
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("es_query failed: %s", exc)
            return ToolResult(ok=False, error=str(exc), summary=f"es_query error: {exc}")

    def _format(
        self,
        result: SearchResult,
        *,
        contains: str | None = None,
        ids_lookup: bool = False,
    ) -> ToolResult:
        p = self._prefs
        # The recovery path used to be capped exactly like the prompt's sample-event
        # block: an investigator that NOTICED a missing decision field still could not
        # fetch it, because this projection did not carry it either. Rows now extend
        # the same nine identity keys with the shared evidence projection
        # (``app/evidence_fields.py``) that the prompt seam and the connector's
        # free-text search use, so the three cannot disagree about what exists. The
        # nine original key names are unchanged — ``agents/chat.py`` renders its
        # result table straight off them.
        # Resolved from THIS source's own connector config, not the global prefs:
        # the connector's search already applies its per-source overlay, and a row
        # projection that used a different list would put the two surfaces this
        # module exists to keep in lockstep straight back out of step.
        config = getattr(self._source, "config", None)
        fields = p.evidence_fields_from_config(config)
        # A per-ROW budget larger than the whole-observation budget would let a single
        # operator-maximised row breach the fence_block net that the row budget below
        # exists to stay under, so it is clamped to it.
        r = result.rendering
        searched = list(r.fields_searched) if r else []
        row_budget = self._max_result_chars
        budget = p.evidence_budget_from_config(config)
        if row_budget is not None:
            # The searched-field list is carried TWICE outside `hits` — in the summary
            # prose and in `data["free_text"]` — so budgeting only the rows would let
            # the observation as a whole still breach the fence_block net it is sized
            # to stay under. Reserve what the rest of the payload costs, plus slack
            # for the counts and keys that are only known after the loop.
            row_budget = max(
                _MIN_ROW_CHARS,
                row_budget - (2 * len(", ".join(searched)) + _OBSERVATION_OVERHEAD),
            )
            budget = min(budget, row_budget)
        # Whole rows, bounded in total. The investigator fences this observation with
        # ``fence_block``, whose 16 kB net is a BLIND byte cut that would hand the
        # model syntactically broken JSON with only a server-side warning. Wider rows
        # reach that net at the default size, so the rows are budgeted here instead:
        # every row that survives is complete, and the count that did not is stated.
        rows: list[dict[str, Any]] = []
        used = 0
        for ev in result.events:
            src = ev.source if isinstance(ev.source, dict) else {}
            event_obj = src.get("event")
            row = project_evidence(
                src,
                fields,
                base={
                    "id": ev.id,
                    "@timestamp": src.get(p.time_field) or src.get("@timestamp"),
                    "ip": ev.ip,
                    "user": ev.user,
                    "host": ev.host,
                    "rule": ev.rule,
                    "rule_name": ev.rule_name,
                    "severity": ev.severity,
                    "action": event_obj.get("action") if isinstance(event_obj, dict) else None,
                },
                max_chars=budget,
                # ``action`` below IS ``event.action``, under the wire name this
                # result's table has always used — don't spend the budget on it twice.
                already_carried=("event.action",),
            )
            if row_budget is not None:
                cost = len(json.dumps(row, default=str)) + 2
                if rows and used + cost > row_budget:
                    break
                used += cost
            rows.append(row)
        withheld = len(result.events) - len(rows)
        summary = f"{result.total} event(s) matched; returning {len(rows)}."
        data: dict[str, Any] = {"total": result.total, "hits": rows}
        if withheld > 0:
            data["rows_withheld"] = withheld
            summary += (
                f" {withheld} further returned row(s) were withheld to stay inside the "
                "per-observation size budget. Narrow the query (tighter time range, or "
                "an ip/user/host/rule filter) to bring the tail into range — lowering "
                "'size' returns fewer rows, not different ones."
            )
        if contains:
            # Report what the free text could and could not have matched. Without
            # this an empty result reads as evidence of ABSENCE, and that is exactly
            # how a case came to record "no HTTP context" about an alert that carried
            # a URL. ``meta`` is not shown to the model, so it has to live in
            # ``data``/``summary``.
            # "Applied" means the filter RAN. A connector that matches the whole
            # record reports no field list by design, so conflating the two would
            # have the structured payload deny what the prose in the same result says.
            applied = not ids_lookup
            data["free_text"] = {
                "contains": contains,
                "applied": applied,
                "fields_searched": [] if ids_lookup else searched,
                # Only describe semantics that were actually exercised — claiming a
                # match type for a filter that never ran is its own small lie.
                "matching": (
                    "analysed term match (NOT a substring scan)" if applied
                    else "not applied"
                ),
            }
            if ids_lookup:
                # An id lookup returns the requested documents verbatim. Saying
                # nothing here would let the model read the result as a filtered one.
                summary += (
                    f" Free text {contains!r} was NOT applied: an id lookup returns the "
                    "requested documents verbatim. Read the returned records directly, "
                    "or re-query without 'ids' to filter."
                )
            elif searched:
                summary += (
                    f" Free text {contains!r} was matched against {len(searched)} field(s) "
                    f"only ({', '.join(searched)}), as an ANALYSED TERM match rather than a "
                    "substring scan — so an exact-value field matches only its whole value. "
                    "A low or zero count means no match under those terms in those fields; "
                    "it is NOT evidence that the data is absent from the record. The "
                    "per-event fields above are the record's own values: read them directly."
                )
            else:
                summary += (
                    f" Free text {contains!r} was applied by the source without a reported "
                    "field list; a low or zero count is not evidence that the data is "
                    "absent from the record."
                )
        return ToolResult(
            ok=True,
            summary=summary,
            data=data,
            query=r.query if r else "*",
            meta={
                "language": r.language if r else "kuery",
                "data_view": r.data_view if r else p.data_view_pattern,
                "time_from": r.time_from if r else None,
                "time_to": r.time_to if r else None,
                "fields_searched": searched,
            },
        )


def _clean(value: Any) -> str | None:
    """Treat empty string as 'unset' (parity with the legacy ``not in (None, "")``)."""
    if value in (None, ""):
        return None
    return str(value)
