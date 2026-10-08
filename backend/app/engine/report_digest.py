"""Deterministic report digest for the AI summary (chat revamp SPEC §9.4, #7).

The ONE input of a report summary model call is this digest, never the report's
blocks themselves: per item its kind, title, provenance, basis, total and truncation;
KPI values; the top categories; per series min / max / last / trend; for tables the
column names, the row count and at most five sample rows restricted to IDENTITY keys
(never free-text columns such as a raw message); for case lists at most ten case ids
plus verdict and severity counts; Markdown clipped to 1 000 characters; query blocks
omitted; the analyst's notes labelled as untrusted.

Why a digest: a report can hold 40 items of up to 200 table rows each. Sending that to
a model would be raw evidence (#7) and unbounded cost. The digest is aggregate-only,
bounded (≤ :data:`REPORT_DIGEST_MAX_CHARS` serialised) and byte-identical for the same
report, so a dry-run estimate and the real call see exactly the same prompt and Demo
Mode stays deterministic.

Trust: everything in the digest is UNTRUSTED data (titles and notes are user text,
labels are log- or case-derived). The caller sends it through
``prompts.build_report_summary_messages`` which wraps it in
``fence_block(source="report")``. The serialised text here is already ASCII
(``ensure_ascii``: an invisible character becomes a visible ``\\uXXXX`` escape) and
marker-neutralised, so that fence is idempotent and the length bound holds after it.

Shrinking is structural, never a character cut through the JSON: each level keeps
fewer categories, sample rows, series and characters; past the last level whole items
are dropped from the end and counted in ``omitted.items``. The result is always valid
JSON.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Iterable

from ..agents.blocks import is_expired_block
from ..agents.prompts import build_report_summary_messages, neutralise_markers
from ..models import Report, ReportItem

REPORT_DIGEST_MAX_CHARS = 12_000

# Table columns a digest may sample (SPEC §9.4 "identity keys"): entity, time and
# classification fields plus the canonical keys of aggregated table views. Free-text
# columns (``message``, ``detail``, raw ``code``) never reach the model.
IDENTITY_KEYS: frozenset[str] = frozenset({
    "ts", "time", "timestamp", "at", "source", "source_id", "source_name", "ip", "src_ip",
    "dst_ip", "source.ip", "destination.ip", "user", "user.name", "host", "host.name",
    "rule", "rule_name", "rule.name", "severity", "action", "label", "stage", "case_id",
    "verdict", "status", "technique", "tactic", "kind", "x", "y", "value", "count",
})
IDENTITY_COLUMN_TYPES: frozenset[str] = frozenset({
    "entity", "case", "severity", "verdict", "status", "mitre", "risk", "time", "number",
})
MAX_SAMPLE_COLUMNS = 9


@dataclass(frozen=True)
class _Level:
    """One shrink level: every bound the digest applies at once."""

    categories: int
    sample_rows: int
    markdown: int
    note: int
    series: int
    case_ids: int
    techniques: int
    labels: int
    facts: int
    cell: int


_LEVELS: tuple[_Level, ...] = (
    _Level(categories=10, sample_rows=5, markdown=1_000, note=500, series=8, case_ids=10,
           techniques=20, labels=5, facts=6, cell=120),
    _Level(categories=5, sample_rows=3, markdown=500, note=300, series=4, case_ids=5,
           techniques=10, labels=3, facts=4, cell=80),
    _Level(categories=3, sample_rows=1, markdown=250, note=200, series=2, case_ids=3,
           techniques=5, labels=2, facts=2, cell=60),
    _Level(categories=0, sample_rows=0, markdown=120, note=120, series=1, case_ids=0,
           techniques=0, labels=0, facts=0, cell=40),
)


# --------------------------------------------------------------------------- #
# Small deterministic helpers.
# --------------------------------------------------------------------------- #
def _clip(value: Any, limit: int) -> str:
    """Plain truncation with an ellipsis. Stored block text was already display-
    sanitised at validation, and the serialiser escapes anything non-ASCII, so no
    character class is stripped here (§7.6: prompt text keeps evidence visible)."""
    text = value if isinstance(value, str) else ("" if value is None else str(value))
    text = " ".join(text.split()) if "\n" not in text else text.strip()
    if limit <= 0:
        return ""
    return text if len(text) <= limit else text[: max(0, limit - 1)].rstrip() + "…"


def _num(value: Any) -> int | float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, float) and (value != value or value in (float("inf"), float("-inf"))):
        return None
    return round(value, 4) if isinstance(value, float) else value


def _measured(value: Any) -> int | float | str:
    """A number, or the explicit words "not measured" (G3: null is never zero)."""
    number = _num(value)
    return "not measured" if number is None else number


def _drop_empty(entry: dict[str, Any]) -> dict[str, Any]:
    """Drop absent/empty/false entries to keep the digest compact. Compared by type,
    because ``0 == False`` and a measured zero must survive."""
    def _empty(value: Any) -> bool:
        return value is None or value is False or (
            isinstance(value, (str, list, dict)) and len(value) == 0
        )
    return {k: v for k, v in entry.items() if not _empty(v)}


def _tally(values: Iterable[Any]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for value in values:
        if isinstance(value, str) and value:
            counts[value] = counts.get(value, 0) + 1
    return dict(sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])))


def _trend(values: list[int | float]) -> str:
    """``up`` / ``down`` / ``flat`` from the first to the last measured point, with a
    5 %-of-range dead band so noise does not read as a trend."""
    if len(values) < 2:
        return "n/a"
    first, last = values[0], values[-1]
    span = max(values) - min(values)
    if span == 0 or abs(last - first) <= 0.05 * span:
        return "flat"
    return "up" if last > first else "down"


# --------------------------------------------------------------------------- #
# Per-block digests.
# --------------------------------------------------------------------------- #
def _base(block: dict[str, Any]) -> dict[str, Any]:
    btype = block.get("type")
    entry: dict[str, Any] = {
        "type": btype,
        "view": block.get("kind") if btype == "chart" else None,
        "title": _clip(block.get("title"), 120),
        "provenance": block.get("provenance"),
        # The engine-written caption carries the sample basis, window and truncation
        # phrase ("newest 200 of 1,284 · last 24h"): the model must respect it.
        "basis": _clip(block.get("caption"), 200),
        "total": _num(block.get("total")),
        "truncated": block.get("truncated") is True,
    }
    return entry


def _kpis(block: dict[str, Any], lv: _Level) -> dict[str, Any]:
    items = []
    for item in (block.get("items") or [])[:6]:
        if not isinstance(item, dict):
            continue
        delta = item.get("delta") if isinstance(item.get("delta"), dict) else None
        items.append(_drop_empty({
            "label": _clip(item.get("label"), 60),
            "value": _measured(item.get("value")),
            "unit": item.get("unit"),
            "bound": item.get("bound"),
            "context": _clip(item.get("context"), 60),
            "change": _num(delta.get("value")) if delta else None,
            "change_period": _clip(delta.get("period_label"), 40) if delta else None,
        }))
    return {"kpis": items}


def _chart(block: dict[str, Any], lv: _Level) -> dict[str, Any]:
    x = block.get("x") if isinstance(block.get("x"), dict) else {}
    labels = [lbl for lbl in (x.get("values") or [])]
    series = [s for s in (block.get("series") or []) if isinstance(s, dict)]
    out: dict[str, Any] = {"unit": block.get("unit"), "points": len(labels)}
    if x.get("kind") == "time" or block.get("kind") in ("line", "area", "sparkline"):
        stats = []
        for s in series[: lv.series]:
            values = [v for v in (_num(v) for v in (s.get("values") or [])) if v is not None]
            stats.append(_drop_empty({
                "series": _clip(s.get("label"), 60),
                "min": min(values) if values else "not measured",
                "max": max(values) if values else "not measured",
                "last": values[-1] if values else "not measured",
                "trend": _trend(values),
            }))
        out["from"] = _clip(labels[0], 40) if labels else None
        out["to"] = _clip(labels[-1], 40) if labels else None
        out["series"] = stats
        if len(series) > lv.series:
            out["series_omitted"] = len(series) - lv.series
        return out
    # Categories: one value per label (the sum across series for a stacked chart),
    # ranked by size, ties by label, top N.
    totals: list[tuple[str, int | float]] = []
    for i, label in enumerate(labels):
        value: int | float = 0
        measured = False
        for s in series:
            values = s.get("values") or []
            number = _num(values[i]) if i < len(values) else None
            if number is not None:
                value += number
                measured = True
        if measured:
            totals.append((_clip(label, 60), round(value, 4) if isinstance(value, float) else value))
    totals.sort(key=lambda kv: (-kv[1], kv[0]))
    out["categories"] = [{"label": k, "value": v} for k, v in totals[: lv.categories]]
    out["categories_total"] = len(totals)
    if len(series) > 1:
        out["series"] = [_clip(s.get("label"), 60) for s in series[: lv.series]]
    return out


def _heatmap(block: dict[str, Any], lv: _Level) -> dict[str, Any]:
    x = (block.get("x") or {}).get("values") or []
    y = (block.get("y") or {}).get("values") or []
    best: tuple[int | float, str, str] | None = None
    total: int | float = 0
    for r, row in enumerate(block.get("cells") or []):
        for c, cell in enumerate(row or []):
            number = _num(cell)
            if number is None:
                continue
            total += number
            if best is None or number > best[0]:
                best = (number, _clip(y[r] if r < len(y) else "", 60), _clip(x[c] if c < len(x) else "", 60))
    out: dict[str, Any] = {"unit": block.get("unit"), "x_count": len(x), "y_count": len(y),
                           "sum": round(total, 4) if isinstance(total, float) else total}
    if best is not None:
        out["max_cell"] = {"y": best[1], "x": best[2], "value": best[0]}
    return out


def _sample_columns(block: dict[str, Any]) -> list[tuple[int, str]]:
    picked: list[tuple[int, str]] = []
    for i, col in enumerate(block.get("columns") or []):
        if not isinstance(col, dict):
            continue
        key = str(col.get("key") or "")
        if key.lower() in IDENTITY_KEYS or col.get("type") in IDENTITY_COLUMN_TYPES:
            picked.append((i, key))
        if len(picked) >= MAX_SAMPLE_COLUMNS:
            break
    return picked


def _table(block: dict[str, Any], lv: _Level) -> dict[str, Any]:
    columns = [c for c in (block.get("columns") or []) if isinstance(c, dict)]
    rows = [r for r in (block.get("rows") or []) if isinstance(r, list)]
    out: dict[str, Any] = {
        "columns": [_clip(c.get("label") or c.get("key"), 60) for c in columns],
        "rows": len(rows),
    }
    picked = _sample_columns(block)
    if picked and lv.sample_rows > 0:
        samples = []
        for row in rows[: lv.sample_rows]:
            sample: dict[str, Any] = {}
            for index, key in picked:
                cell = row[index] if index < len(row) else None
                sample[key] = _num(cell) if isinstance(cell, (int, float)) and not isinstance(cell, bool) \
                    else (_clip(cell, lv.cell) if isinstance(cell, str) else None)
            samples.append(sample)
        out["sample_rows"] = samples
        out["sample_keys_only"] = True
    return out


def _case_list(block: dict[str, Any], lv: _Level) -> dict[str, Any]:
    items = [i for i in (block.get("items") or []) if isinstance(i, dict)]
    return _drop_empty({
        "cases": len(items),
        "case_ids": [_clip(i.get("case_id"), 64) for i in items[: lv.case_ids]],
        "verdicts": _tally(i.get("verdict") for i in items),
        "severities": _tally(i.get("severity") for i in items),
        "statuses": _tally(i.get("status") for i in items),
    })


def _timeline(block: dict[str, Any], lv: _Level) -> dict[str, Any]:
    events = [e for e in (block.get("events") or []) if isinstance(e, dict)]
    return _drop_empty({
        "events": len(events),
        "first": _clip(events[0].get("at"), 40) if events else None,
        "last": _clip(events[-1].get("at"), 40) if events else None,
        "kinds": _tally(e.get("kind") for e in events),
        "labels": [_clip(e.get("label"), 80) for e in events[: lv.labels]],
    })


def _entity(block: dict[str, Any], lv: _Level) -> dict[str, Any]:
    entity = block.get("entity") if isinstance(block.get("entity"), dict) else {}
    facts = [f for f in (block.get("facts") or []) if isinstance(f, dict)]
    counts = [c for c in (block.get("counts") or []) if isinstance(c, dict)]
    return _drop_empty({
        "entity": _drop_empty({"kind": entity.get("kind"), "value": _clip(entity.get("value"), 160)}),
        "risk": _num(block.get("risk")),
        "verdict": block.get("verdict"),
        "facts": [{"label": _clip(f.get("label"), 60), "value": _clip(f.get("value"), lv.cell)}
                  for f in facts[: lv.facts]],
        "counts": [{"label": _clip(c.get("label"), 60), "value": _measured(c.get("value"))} for c in counts],
        "reputation": _tally(r.get("verdict") for r in (block.get("reputation") or []) if isinstance(r, dict)),
        "related_cases": [_clip(r.get("case_id"), 64) for r in (block.get("related_cases") or [])
                          if isinstance(r, dict)][: lv.case_ids],
    })


def _mitre(block: dict[str, Any], lv: _Level) -> dict[str, Any]:
    techniques = [t for t in (block.get("techniques") or []) if isinstance(t, dict)]
    return _drop_empty({
        "techniques_total": len(techniques),
        "techniques": [_drop_empty({"id": t.get("id"), "tactic": _clip(t.get("tactic"), 40),
                                    "count": _num(t.get("count"))}) for t in techniques[: lv.techniques]],
        "tactics": _tally(t.get("tactic") for t in techniques),
    })


def _markdown(block: dict[str, Any], lv: _Level) -> dict[str, Any]:
    return {"text": _clip(block.get("text"), lv.markdown)}


def _callout(block: dict[str, Any], lv: _Level) -> dict[str, Any]:
    if is_expired_block(block):
        return {"expired": True}
    return {"tone": block.get("tone"), "text": _clip(block.get("text"), min(600, lv.markdown))}


def _citations(block: dict[str, Any], lv: _Level) -> dict[str, Any]:
    items = [i for i in (block.get("items") or []) if isinstance(i, dict)]
    return _drop_empty({"citations": len(items),
                        "titles": [_clip(i.get("label"), 80) for i in items[: lv.labels]]})


def _guide(block: dict[str, Any], lv: _Level) -> dict[str, Any]:
    return {"steps": len(block.get("steps") or []), "links": len(block.get("links") or [])}


_DIGESTERS = {
    "kpi_group": _kpis, "chart": _chart, "heatmap": _heatmap, "table": _table,
    "case_list": _case_list, "timeline": _timeline, "entity": _entity, "mitre": _mitre,
    "markdown": _markdown, "callout": _callout, "citations": _citations, "guide": _guide,
}


def _block_digest(block: Any, lv: _Level, omitted: dict[str, int]) -> dict[str, Any] | None:
    """One block's digest, or None for a query block (omitted: a native query is
    log-shaped text, and the summary has no use for it) or an unreadable entry."""
    if not isinstance(block, dict):
        return None
    btype = block.get("type")
    if btype == "query":
        omitted["query_blocks"] = omitted.get("query_blocks", 0) + 1
        return None
    if btype == "report":
        sections = []
        for section in block.get("sections") or []:
            if not isinstance(section, dict):
                continue
            leaves = [d for d in (_block_digest(b, lv, omitted) for b in section.get("blocks") or []) if d]
            sections.append(_drop_empty({"heading": _clip(section.get("heading"), 120), "blocks": leaves}))
        return _drop_empty({**_base(block), "sections": sections})
    digester = _DIGESTERS.get(str(btype))
    if digester is None:
        return None
    return _drop_empty({**_base(block), **digester(block, lv)})


def _item_digest(n: int, item: ReportItem, lv: _Level, omitted: dict[str, int]) -> dict[str, Any]:
    block = item.block if isinstance(item.block, dict) else {}
    if item.kind == "section":
        title = block.get("title")
        raw_blocks = block.get("blocks") or []
    else:
        title = block.get("title")
        raw_blocks = [block]
    blocks = [d for d in (_block_digest(b, lv, omitted) for b in raw_blocks) if d]
    scope = item.scope
    return _drop_empty({
        "n": n,
        "kind": item.kind,
        "title": _clip(title, 120),
        "window": _clip(scope.window, 80),
        "sources": [_clip(s, 60) for s in scope.sources[:5]],
        "demo_data": scope.demo,
        "section_truncated": block.get("truncated") is True if item.kind == "section" else None,
        # User-authored and UNTRUSTED (it rides inside the report fence like the rest).
        "analyst_note_untrusted": _clip(item.note, lv.note) if item.note else None,
        "blocks": blocks,
    })


def build_digest(report: Report, *, level: int = 0, max_items: int | None = None) -> dict[str, Any]:
    """The digest structure at one shrink ``level`` (0 = richest), keeping the first
    ``max_items`` items. Pure and deterministic."""
    lv = _LEVELS[max(0, min(level, len(_LEVELS) - 1))]
    items = list(report.items)
    kept = items if max_items is None else items[: max(0, max_items)]
    omitted: dict[str, int] = {}
    digest_items = [_item_digest(n, item, lv, omitted) for n, item in enumerate(kept, start=1)]
    if len(kept) < len(items):
        omitted["items"] = len(items) - len(kept)
    return _drop_empty({
        "report": _drop_empty({
            "title": _clip(report.title, 120),
            "template": report.template,
            "items": len(items),
            "content_version": report.version,
        }),
        "items": digest_items,
        "omitted": omitted,
    })


def serialise_digest(digest: dict[str, Any]) -> str:
    """ASCII JSON with every forged fence marker neutralised: the exact text that
    ``fence_block`` will wrap (and leave unchanged)."""
    return neutralise_markers(json.dumps(digest, ensure_ascii=True, separators=(",", ":")))


def report_digest(report: Report, *, max_chars: int = REPORT_DIGEST_MAX_CHARS) -> str:
    """The bounded, deterministic digest text of ``report`` (≤ ``max_chars``).

    Tries each shrink level with every item, then drops trailing items at the
    smallest level until it fits. Always returns valid JSON."""
    for level in range(len(_LEVELS)):
        text = serialise_digest(build_digest(report, level=level))
        if len(text) <= max_chars:
            return text
    last = len(_LEVELS) - 1
    for keep in range(len(report.items) - 1, -1, -1):
        text = serialise_digest(build_digest(report, level=last, max_items=keep))
        if len(text) <= max_chars:
            return text
    # Unreachable in practice (a zero-item digest is a few hundred bytes); keep the
    # contract anyway with the smallest valid JSON that still says what happened.
    return serialise_digest({"report": {"items": len(report.items)}, "omitted": {"items": len(report.items)}})


def report_summary_messages(report: Report) -> list[dict[str, str]]:
    """The ONE prompt of a report summary: the fixed ``REPORT_SUMMARY_SYSTEM`` plus
    this report's digest fenced as ``source=report`` (prompts.py)."""
    return build_report_summary_messages(report_digest(report), template=report.template)


__all__ = [
    "IDENTITY_COLUMN_TYPES",
    "IDENTITY_KEYS",
    "REPORT_DIGEST_MAX_CHARS",
    "build_digest",
    "report_digest",
    "report_summary_messages",
    "serialise_digest",
]
