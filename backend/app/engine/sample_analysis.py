"""Field-mapping suggestion from a pasted sample record (Wave 5 / F9).

The wizard's "Advanced field mapping" lets an operator paste ONE sample log/alert
record and have the suite SUGGEST which dotted paths map to the entity/scope fields
(source ip / user / host / message / severity / rule / timestamp). This is a pure,
deterministic heuristic — NO LLM, NO network, NO persistence.

CRITICAL (#9): a sample is attacker-influenceable, log-derived UNTRUSTED DATA. We
flatten it to dotted paths, never evaluate/execute anything in it, and the caller
NEVER persists the sample to the config doc — only the operator-confirmed mappings
(plain field-name strings) are ever saved.
"""

from __future__ import annotations

from typing import Any

from ..evidence_fields import DEFAULT_EVIDENCE_FIELDS, record_carries

# Candidate dotted-path substrings for each mapping target, in PREFERENCE order
# (the first present in the flattened sample wins). Substring match is
# case-insensitive on the full dotted path so both ECS (`source.ip`) and SIEM-native
# (`data.srcip`) shapes resolve.
_CANDIDATES: dict[str, tuple[str, ...]] = {
    "source_ip_field": ("source.ip", "src_ip", "srcip", "client.ip", "source.address", "src.ip", "ipaddress"),
    "user_field": ("user.name", "srcuser", "user.id", "username", "account.name", "user", "actor"),
    "host_field": ("host.name", "agent.name", "hostname", "host", "computer", "device.name"),
    "message_field": ("message", "event.original", "log.message", "rule.description", "msg", "summary"),
    "severity_field": ("event.severity", "rule.level", "severity", "level", "priority", "score"),
    "rule_field": ("event.module", "rule.id", "rule.name", "ruleid", "signature_id", "event.code"),
    "rule_name_field": ("rule.name", "rule.description", "signature", "alert.name", "title"),
    "time_field": ("@timestamp", "timestamp", "event.created", "time", "datetime", "eventtime", "_time"),
}

_MAX_FIELDS = 500          # bound the flattened-path list returned to the UI
_MAX_DEPTH = 8             # don't recurse pathologically deep nested records


def flatten_paths(record: Any, prefix: str = "", depth: int = 0) -> list[str]:
    """Return the sorted, deduped list of dotted paths present in a record.

    Recurses dicts (and into the first dict element of a list, so an array of
    objects still surfaces its inner paths) up to a bounded depth/size. Scalars and
    list-of-scalars are leaves. Pure + total (never raises on odd input)."""
    out: list[str] = []
    _collect(record, prefix, depth, out)
    # Dedupe preserving discovery order, then sort for a stable UI.
    seen: set[str] = set()
    uniq = [p for p in out if not (p in seen or seen.add(p))]
    return sorted(uniq)[:_MAX_FIELDS]


def _collect(value: Any, prefix: str, depth: int, out: list[str]) -> None:
    if len(out) >= _MAX_FIELDS or depth > _MAX_DEPTH:
        return
    if isinstance(value, dict):
        for k, v in value.items():
            path = f"{prefix}.{k}" if prefix else str(k)
            if isinstance(v, dict):
                _collect(v, path, depth + 1, out)
            elif isinstance(v, list):
                out.append(path)
                # Surface inner object paths from the first dict element.
                first_dict = next((x for x in v if isinstance(x, dict)), None)
                if first_dict is not None:
                    _collect(first_dict, path, depth + 1, out)
            else:
                out.append(path)
    elif prefix:
        out.append(prefix)


def suggest_mappings(record: Any) -> dict[str, str]:
    """Suggest field-mapping overrides for a sample record (best-effort, may be
    partial). Each target maps to the FIRST flattened path matching its candidate
    substrings (longest/most-specific candidate first within a target). Only targets
    with a confident match are included; the UI lets the operator confirm/edit."""
    paths = flatten_paths(record)
    lowered = {p.lower(): p for p in paths}  # lowercase path -> original path
    suggestions: dict[str, str] = {}
    for target, candidates in _CANDIDATES.items():
        match = _best_path(candidates, lowered)
        if match is not None:
            suggestions[target] = match
    return suggestions


def _best_path(candidates: tuple[str, ...], lowered: dict[str, str]) -> str | None:
    """The original-cased path best matching one of ``candidates``.

    Prefers (1) an exact dotted-path equality, then (2) a suffix match (the path's
    last segment(s) equal the candidate — robust to a vendor prefix like
    ``data.srcip``), then (3) a substring match. Earlier candidates win ties."""
    # Pass 1: exact path equality.
    for cand in candidates:
        if cand in lowered:
            return lowered[cand]
    # Pass 2: suffix match on the dotted path.
    for cand in candidates:
        for low, orig in lowered.items():
            if low == cand or low.endswith("." + cand):
                return orig
    # Pass 3: substring (last resort).
    for cand in candidates:
        for low, orig in lowered.items():
            if cand in low:
                return orig
    return None


def suggest_evidence_fields(record: Any) -> list[str]:
    """Which of the default evidence paths this sample record actually carries.

    Answers the question an operator cannot otherwise answer without querying the
    index by hand: "do MY alerts carry the fields that decide the case?" Returned in
    the default set's own priority order, so the answer doubles as a ready
    ``evidence_fields`` list.

    #9-safe by construction, and more strictly so than ``fields``: every string
    returned is one of OUR OWN constants, matched against the sample. No path, key or
    value from the untrusted record is ever echoed back.
    """
    # A DIRECT lookup per path, not an intersection with ``flatten_paths``: that
    # inventory is sorted then cut at 500, so on a large record it reports a present
    # field as absent purely because its path sorts late — telling an operator their
    # alerts carry none of the deciding fields when they carry all of them. That is
    # the original bug, arriving through the one affordance built to diagnose it.
    return [path for path in DEFAULT_EVIDENCE_FIELDS if record_carries(record, path)]


def analyze_sample(record: Any) -> dict[str, Any]:
    """The /analyze-sample response: suggested mappings + the flattened field paths.

    The sample itself is NEVER returned or persisted — only the derived field-name
    strings (suggested_mappings / suggested_evidence_fields) and the path inventory
    (fields) the UI renders."""
    return {
        "suggested_mappings": suggest_mappings(record),
        "suggested_evidence_fields": suggest_evidence_fields(record),
        "fields": flatten_paths(record),
    }
