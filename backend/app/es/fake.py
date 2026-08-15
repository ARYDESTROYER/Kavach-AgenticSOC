"""In-memory Elasticsearch fake for tests and key-less local runs.

It implements exactly the query/aggregation shapes the suite emits (see
``querybuilder.py``): bool(filter/must/should/must_not), term/terms/range/ids/
exists/match/match_all, sort, size/from, and the standup aggregations
(terms/cardinality/value_count/date_histogram). It is NOT a general ES emulator;
it is a faithful stand-in for the structures this codebase actually issues.
"""

from __future__ import annotations

import copy
import fnmatch
import re
from typing import Any

from ..constants import AUDIT_INDEX, USAGE_INDEX
from ..utils import coerce_float, dotted_get, new_id, parse_es_timestamp
from .base import BaseESClient


def _to_comparable(value: Any) -> float | None:
    """Best-effort conversion of a field value to a sortable/range-comparable
    number (timestamps become epoch millis)."""
    if value is None:
        return None
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        dt = parse_es_timestamp(value)
        if dt is not None and any(c in value for c in (":", "-", "T")):
            return dt.timestamp() * 1000.0
        return coerce_float(value, None)  # type: ignore[arg-type]
    return None


class InMemoryESClient(BaseESClient):
    storage_lifecycle_backend = "memory"

    def __init__(self) -> None:
        self.docs: dict[str, dict[str, dict[str, Any]]] = {}
        self.alias_to_index: dict[str, str] = {}
        self.templates: dict[str, dict[str, Any]] = {}
        self.lifecycle_policies: dict[str, dict[str, Any]] = {}
        self.index_settings: dict[str, dict[str, Any]] = {}
        self._state_pits: dict[str, list[tuple[str, str, dict[str, Any]]]] = {}
        self.lifecycle_capabilities: dict[str, Any] = {
            "supported": True,
            "can_manage": True,
            "privileged": True,
            "index_privileged": True,
            "hot_ready": True,
            "warm_ready": True,
            "roles": ["data"],
            "ilm_mode": "RUNNING",
            "reason": "In-memory lifecycle capability for deterministic tests.",
        }

    # ----- test helpers -----
    def add_log(self, index: str, source: dict[str, Any], doc_id: str | None = None) -> str:
        """Seed a log-surface document (what upstream would have written)."""
        return self._store(index, source, doc_id)

    def _resolve(self, index: str) -> str:
        return self.alias_to_index.get(index, index)

    def _store(self, index: str, source: dict[str, Any], doc_id: str | None) -> str:
        target = self._resolve(index)
        self.docs.setdefault(target, {})
        did = doc_id or new_id()
        self.docs[target][did] = source
        return did

    def _matching_indices(self, pattern: str) -> list[str]:
        names: list[str] = []
        for part in pattern.split(","):
            part = self.alias_to_index.get(part.strip(), part.strip())
            for name in self.docs:
                if fnmatch.fnmatch(name, part) and name not in names:
                    names.append(name)
        return names

    # ----- BaseESClient -----
    async def ping(self) -> bool:
        return True

    async def search_logs(self, index: str, body: dict[str, Any]) -> dict[str, Any]:
        return self._evaluate(index, body)

    async def open_log_pit(self, index: str, keep_alive: str = "1m") -> str | None:
        # The in-memory store is deterministic for the duration of a synchronous
        # test search.  A token exercises the same search_after/PIT connector path;
        # no independent snapshot object is needed for the offline tests.
        return f"fake-pit:{index}"

    async def close_log_pit(self, pit_id: str) -> None:
        return None

    async def open_state_pit(self, index: str, keep_alive: str = "10m") -> str | None:
        del keep_alive
        pit_id = f"fake-state-pit:{new_id()}"
        # Deep-copy the source payloads: case documents are mutable, so retaining
        # references would not model Elasticsearch PIT snapshot semantics.
        self._state_pits[pit_id] = copy.deepcopy(self._all_hits(index))
        return pit_id

    async def close_state_pit(self, pit_id: str) -> None:
        self._state_pits.pop(pit_id, None)

    async def index_template_exists(self, name: str) -> bool:
        return name in self.templates

    async def put_index_template(self, name: str, body: dict[str, Any]) -> None:
        self.templates[name] = body

    async def index_exists(self, name: str) -> bool:
        return self._resolve(name) in self.docs

    async def create_index(self, name: str, body: dict[str, Any] | None = None) -> None:
        self.docs.setdefault(name, {})
        for alias in (body or {}).get("aliases", {}):
            self.alias_to_index[alias] = name

    async def index_doc(
        self, index: str, doc: dict[str, Any], doc_id: str | None = None, refresh: bool = False
    ) -> str:
        # Production code writes to the contract write *aliases* (e.g.
        # ``tlsoc-agent-usage``) and reads back via the date-rolling pattern
        # ``<base>-*``. In a real cluster the alias points at a backing index
        # such as ``<base>-000001`` (created by bootstrap_indices), so the read
        # pattern resolves it. If the suite writes through such an alias without
        # having bootstrapped, auto-provision the backing index + alias exactly
        # like bootstrap_indices would, so the alias write lands somewhere the
        # ``<base>-*`` read pattern matches.
        if index not in self.alias_to_index and index not in self.docs:
            backing = f"{index}-000001"
            self.docs.setdefault(backing, {})
            self.alias_to_index[index] = backing
        return self._store(index, doc, doc_id)

    async def create_doc_strict(
        self,
        index: str,
        doc_id: str,
        doc: dict[str, Any],
        refresh: bool = False,
    ) -> bool:
        """Atomic event-loop create used by strict ledger regressions."""

        if index not in self.alias_to_index and index not in self.docs:
            backing = f"{index}-000001"
            self.docs.setdefault(backing, {})
            self.alias_to_index[index] = backing
        target = self._resolve(index)
        bucket = self.docs.setdefault(target, {})
        if doc_id in bucket:
            return False
        # Route the mutation through ``index_doc`` so fault-injection fakes which
        # model an unavailable ledger keep exercising the same persistence seam.
        # The bundled implementation contains no await before storing, so the
        # preceding check + this create remain one atomic event-loop turn.
        await self.index_doc(index, doc, doc_id=doc_id, refresh=refresh)
        return True

    async def delete_index(self, name: str) -> None:
        targets = set(self._matching_indices(name))
        target = self._resolve(name)
        if target in self.docs:
            targets.add(target)
        for concrete in targets:
            self.docs.pop(concrete, None)
        for alias, backing in list(self.alias_to_index.items()):
            if backing in targets or alias == name:
                self.alias_to_index.pop(alias, None)

    async def delete_index_strict(self, name: str) -> bool:
        """Strict management-index delete; absence is the only false result."""
        targets = set(self._matching_indices(name))
        target = self._resolve(name)
        if target in self.docs:
            targets.add(target)
        existed = bool(targets or name in self.alias_to_index)
        await self.delete_index(name)
        return existed

    async def delete_doc(self, index: str, doc_id: str, refresh: bool = False) -> bool:
        """Delete a single document by id (used by RAG document management).
        Missing index/id is benign (returns False)."""
        target = self._resolve(index)
        bucket = self.docs.get(target)
        if bucket is not None and doc_id in bucket:
            del bucket[doc_id]
            return True
        return False

    async def delete_doc_strict(
        self, index: str, doc_id: str, refresh: bool = False
    ) -> bool:
        """Strict fake seam matching the real management-only delete contract."""
        return await self.delete_doc(index, doc_id, refresh=refresh)

    async def get_doc(self, index: str, doc_id: str) -> dict[str, Any] | None:
        target = self._resolve(index)
        return self.docs.get(target, {}).get(doc_id)

    async def compare_and_set_doc(
        self,
        index: str,
        doc_id: str,
        doc: dict[str, Any],
        expected_rev: int,
        refresh: bool = False,
    ) -> bool:
        """Atomic event-loop CAS used by offline multi-store concurrency tests."""
        del refresh
        target = self._resolve(index)
        bucket = self.docs.setdefault(target, {})
        current = bucket.get(doc_id)
        try:
            current_rev = int((current or {}).get("_rev", 0) or 0)
        except (TypeError, ValueError):
            current_rev = 0
        if current_rev != int(expected_rev):
            return False
        # No await occurs between the comparison and replacement, so two tasks
        # sharing this fake observe the same all-or-nothing transition.
        bucket[doc_id] = doc
        return True

    async def update_doc(
        self, index: str, doc_id: str, doc: dict[str, Any], refresh: bool = False
    ) -> None:
        target = self._resolve(index)
        self.docs.setdefault(target, {})
        existing = self.docs[target].get(doc_id, {})
        merged = {**existing, **doc}
        self.docs[target][doc_id] = merged

    async def search(self, index: str, body: dict[str, Any]) -> dict[str, Any]:
        return self._evaluate(index, body)

    async def count(self, index: str, body: dict[str, Any]) -> int:
        result = self._evaluate(index, {"query": body.get("query", {"match_all": {}}), "size": 0})
        return int(result["hits"]["total"]["value"])

    async def index_lifecycle_capabilities(self) -> dict[str, Any]:
        return dict(self.lifecycle_capabilities)

    async def put_index_lifecycle_policy(self, name: str, body: dict[str, Any]) -> None:
        self.lifecycle_policies[name] = body

    async def get_index_lifecycle_policy(self, name: str) -> dict[str, Any] | None:
        policy = self.lifecycle_policies.get(name)
        return dict(policy) if policy is not None else None

    async def get_owned_index_lifecycle_attachment(
        self, base: str, policy_name: str
    ) -> dict[str, Any]:
        if base not in {AUDIT_INDEX, USAGE_INDEX}:
            raise ValueError("lifecycle attachment inspection is limited to owned ledgers")
        template = self.templates.get(f"{base}-template") or {}
        template_settings = (
            template.get("template", {}).get("settings", {})
            if isinstance(template, dict)
            else {}
        )
        template_attached = bool(
            template_settings.get("index.lifecycle.name") == policy_name
            and template_settings.get("index.lifecycle.rollover_alias") == base
        )
        matching_indices = [
            name for name in self.docs if fnmatch.fnmatch(name, f"{base}-*")
        ]
        wildcard_settings = self.index_settings.get(f"{base}-*", {})
        attached_count = 0
        for name in matching_indices:
            settings = self.index_settings.get(name, wildcard_settings)
            if (
                settings.get("index.lifecycle.name") == policy_name
                and settings.get("index.lifecycle.rollover_alias") == base
            ):
                attached_count += 1
        all_existing_attached = attached_count == len(matching_indices)
        return {
            "verified": True,
            "template_attached": template_attached,
            "indices_total": len(matching_indices),
            "indices_attached": attached_count,
            "all_existing_indices_attached": all_existing_attached,
            "attached": bool(template_attached and all_existing_attached),
            "reason": (
                "Template and existing indices carry the expected lifecycle settings."
                if template_attached and all_existing_attached
                else "Template or existing-index lifecycle settings are missing or drifted."
            ),
        }

    async def index_lifecycle_policy_exists(self, name: str) -> bool:
        return await self.get_index_lifecycle_policy(name) is not None

    async def delete_index_lifecycle_policy(self, name: str) -> None:
        self.lifecycle_policies.pop(name, None)

    async def put_index_settings(self, index: str, settings: dict[str, Any]) -> None:
        self.index_settings[index] = dict(settings)

    async def remove_index_lifecycle(self, index: str) -> None:
        self.index_settings.pop(index, None)

    async def close(self) -> None:
        return None

    # ----- query engine -----
    def _all_hits(self, pattern: str) -> list[tuple[str, str, dict[str, Any]]]:
        hits: list[tuple[str, str, dict[str, Any]]] = []
        for name in self._matching_indices(pattern):
            for did, src in self.docs[name].items():
                hits.append((name, did, src))
        return hits

    def _evaluate(self, pattern: str, body: dict[str, Any]) -> dict[str, Any]:
        query = body.get("query", {"match_all": {}})
        pit = body.get("pit") or {}
        pit_id = pit.get("id") if isinstance(pit, dict) else None
        if pit_id and str(pit_id).startswith("fake-state-pit:"):
            if str(pit_id) not in self._state_pits:
                raise RuntimeError("point-in-time snapshot was not found or has expired")
            candidates = self._state_pits[str(pit_id)]
        else:
            candidates = self._all_hits(pattern)
        matched = [
            (idx, did, src)
            for (idx, did, src) in candidates
            if _matches(query, did, src, idx)
        ]

        # Sorting
        sort = body.get("sort")
        if sort:
            for clause in reversed(_normalise_sort(sort)):
                field, order = clause
                reverse = order == "desc"
                matched.sort(
                    key=lambda t, f=field: _sort_key(t[1], t[2], f),
                    reverse=reverse,
                )

        total = len(matched)
        normalised_sort = _normalise_sort(sort)
        search_after = body.get("search_after")
        if search_after is not None and normalised_sort:
            matched = [
                row
                for row in matched
                if _is_after(
                    _sort_values(row[1], row[2], normalised_sort),
                    list(search_after),
                    normalised_sort,
                )
            ]
        frm = int(body.get("from", 0) or 0)
        size = int(body.get("size", 10))
        window = matched[frm: frm + size] if size > 0 else []
        hits = [
            {
                "_index": idx,
                "_id": did,
                "_score": None,
                "_source": src,
                "sort": _sort_values(did, src, _normalise_sort(sort)) if sort else None,
            }
            for (idx, did, src) in window
        ]
        result: dict[str, Any] = {
            "hits": {"total": {"value": total, "relation": "eq"}, "hits": hits},
        }
        aggs = body.get("aggs") or body.get("aggregations")
        if aggs:
            result["aggregations"] = _aggregate(aggs, [src for (_i, _d, src) in matched])
        return result


# --------------------------------------------------------------------------- #
# Query matching
# --------------------------------------------------------------------------- #
def _matches(
    query: dict[str, Any], doc_id: str, src: dict[str, Any], index: str = ""
) -> bool:
    if not query or "match_all" in query:
        return True
    if "bool" in query:
        return _matches_bool(query["bool"], doc_id, src, index)
    if "term" in query:
        (field, value), = query["term"].items()
        return _term_match(src, field, value, index=index)
    if "terms" in query:
        (field, values), = query["terms"].items()
        actual = index if field == "_index" else dotted_get(src, field)
        actual_list = actual if isinstance(actual, list) else [actual]
        return any(str(a) in {str(v) for v in values} for a in actual_list)
    if "range" in query:
        (field, bounds), = query["range"].items()
        return _range_match(src, field, bounds)
    if "ids" in query:
        return doc_id in {str(v) for v in query["ids"].get("values", [])}
    if "exists" in query:
        return dotted_get(src, query["exists"]["field"]) is not None
    if "match" in query:
        (field, value), = query["match"].items()
        actual = dotted_get(src, field)
        return actual is not None and str(value).lower() in str(actual).lower()
    if "multi_match" in query:
        mm = query["multi_match"]
        needle = str(mm.get("query", "")).lower()
        return any(
            needle in str(dotted_get(src, f)).lower()
            for f in mm.get("fields", [])
            if dotted_get(src, f) is not None
        )
    if "query_string" in query:
        # Minimal offline support for the operator-authored per-feed query (Wave 6):
        # space/AND-separated ``field:value`` clauses (ALL must match). Enough to
        # exercise a feed-scoping filter without a real Lucene parser. A clause with
        # no ``:`` is treated as a free-text substring over the ``message`` field.
        qs = str(query["query_string"].get("query", "")).strip()
        if not qs:
            return True
        clauses = [c for c in re.split(r"\s+(?:and|AND)\s+|\s+", qs) if c]
        for clause in clauses:
            if ":" in clause:
                field, _, value = clause.partition(":")
                if not _term_match(src, field.strip(), value.strip(), index=index):
                    return False
            else:
                msg = dotted_get(src, "message")
                if msg is None or clause.lower() not in str(msg).lower():
                    return False
        return True
    return False


def _matches_bool(
    b: dict[str, Any], doc_id: str, src: dict[str, Any], index: str = ""
) -> bool:
    for clause in b.get("filter", []) + b.get("must", []):
        if not _matches(clause, doc_id, src, index):
            return False
    for clause in b.get("must_not", []):
        if _matches(clause, doc_id, src, index):
            return False
    should = b.get("should", [])
    if should:
        has_hard = bool(b.get("filter") or b.get("must"))
        min_should = int(b.get("minimum_should_match", 0 if has_hard else 1))
        hits = sum(1 for c in should if _matches(c, doc_id, src, index))
        if hits < min_should:
            return False
    return True


def _term_match(
    src: dict[str, Any], field: str, value: Any, *, index: str = ""
) -> bool:
    actual = index if field == "_index" else dotted_get(src, field)
    if actual is None:
        return False
    if isinstance(actual, list):
        return str(value) in {str(a) for a in actual}
    return str(actual) == str(value)


def _range_match(src: dict[str, Any], field: str, bounds: dict[str, Any]) -> bool:
    actual = _to_comparable(dotted_get(src, field))
    if actual is None:
        return False
    for op in ("gte", "gt", "lte", "lt"):
        if op in bounds:
            bound = _to_comparable(bounds[op])
            if bound is None:
                continue
            if op == "gte" and not actual >= bound:
                return False
            if op == "gt" and not actual > bound:
                return False
            if op == "lte" and not actual <= bound:
                return False
            if op == "lt" and not actual < bound:
                return False
    return True


# --------------------------------------------------------------------------- #
# Sorting
# --------------------------------------------------------------------------- #
def _normalise_sort(sort: Any) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for item in sort or []:
        if isinstance(item, str):
            out.append((item, "asc"))
        elif isinstance(item, dict):
            for field, spec in item.items():
                order = spec.get("order", "asc") if isinstance(spec, dict) else str(spec)
                out.append((field, order))
    return out


def _sort_key(doc_id: str, src: dict[str, Any], field: str) -> Any:
    if field in ("_id", "_doc", "_shard_doc"):
        return doc_id
    val = _to_comparable(dotted_get(src, field))
    return val if val is not None else float("-inf")


def _sort_values(doc_id: str, src: dict[str, Any], sort: list[tuple[str, str]]) -> list[Any]:
    return [_sort_key(doc_id, src, f) for (f, _o) in sort]


def _is_after(
    values: list[Any], marker: list[Any], sort: list[tuple[str, str]]
) -> bool:
    """Lexicographic ``search_after`` comparison for the emitted fake sort values."""
    if len(values) != len(marker):
        return False
    for value, prior, (_field, order) in zip(values, marker, sort):
        if value == prior:
            continue
        try:
            return value > prior if order == "asc" else value < prior
        except TypeError:
            left, right = str(value), str(prior)
            return left > right if order == "asc" else left < right
    return False


# --------------------------------------------------------------------------- #
# Aggregations
# --------------------------------------------------------------------------- #
def _aggregate(aggs: dict[str, Any], sources: list[dict[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for name, body in aggs.items():
        if "terms" in body:
            field = body["terms"]["field"]
            size = int(body["terms"].get("size", 10))
            counts: dict[str, int] = {}
            for src in sources:
                val = dotted_get(src, field)
                if val is None:
                    continue
                for v in (val if isinstance(val, list) else [val]):
                    counts[str(v)] = counts.get(str(v), 0) + 1
            buckets = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:size]
            out[name] = {"buckets": [{"key": k, "doc_count": c} for k, c in buckets]}
        elif "cardinality" in body:
            field = body["cardinality"]["field"]
            distinct = {
                str(v)
                for src in sources
                for v in ([dotted_get(src, field)] if not isinstance(dotted_get(src, field), list)
                          else dotted_get(src, field))
                if v is not None
            }
            out[name] = {"value": len(distinct)}
        elif "value_count" in body:
            field = body["value_count"]["field"]
            out[name] = {"value": sum(1 for src in sources if dotted_get(src, field) is not None)}
        elif "date_histogram" in body:
            dh = body["date_histogram"]
            field = dh["field"]
            interval_ms = _interval_to_ms(dh.get("fixed_interval", dh.get("calendar_interval", "1h")))
            buckets_map: dict[int, int] = {}
            for src in sources:
                ts = _to_comparable(dotted_get(src, field))
                if ts is None:
                    continue
                bucket = int(ts // interval_ms) * interval_ms
                buckets_map[bucket] = buckets_map.get(bucket, 0) + 1
            out[name] = {
                "buckets": [
                    {"key": k, "doc_count": c} for k, c in sorted(buckets_map.items())
                ]
            }
    return out


def _interval_to_ms(interval: str) -> int:
    units = {"s": 1000, "m": 60_000, "h": 3_600_000, "d": 86_400_000}
    try:
        return int(interval[:-1]) * units.get(interval[-1], 3_600_000)
    except (ValueError, IndexError):
        return 3_600_000
