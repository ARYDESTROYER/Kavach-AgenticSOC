"""Index templates and first-boot index bootstrap (Section 4.3 / 7).

The backend OWNS and creates its three contract indices (cases/audit/usage) plus
two single-doc bookkeeping indices (config/cursor) using the management
credential. The same mapping definitions are exported to ``deploy/mappings`` so a
cold deploy can pre-create them if desired.

Bootstrap creates what is missing and never remaps, reindexes or rolls an existing
index. The one exception is additive and limited to the audit contract (Round 14,
:func:`extend_audit_mapping`): audit-first writes (SPEC §3.6) cannot succeed while the
live audit index would date-detect a free string, so on a deployment whose audit
template or index predates this build, the stored audit template gains the properties
it lacks and every existing audit index gains the properties it lacks plus
``date_detection: false``. A property that already exists is never changed, whatever
its mapping. This needs an Elasticsearch client that can read a template, read a
mapping and add to one (``get_index_template``, ``get_index_mapping``,
``put_index_mapping``); through a client that cannot, bootstrap changes nothing and
logs a warning naming the operator step (:data:`AUDIT_UPGRADE_STEP`).
"""

from __future__ import annotations

import copy
import logging
from typing import Any

from ..constants import (
    AUDIT_INDEX,
    CASES_INDEX,
    CONFIG_INDEX,
    CURSOR_INDEX,
    USAGE_INDEX,
)
from .base import BaseESClient

logger = logging.getLogger("tlsoc.es.indices")

_COMMON_SETTINGS = {"number_of_shards": 1, "number_of_replicas": 0}

CASES_MAPPING = {
    "properties": {
        "case_id": {"type": "keyword"},
        "cluster_signature": {"type": "keyword"},
        "app_version": {"type": "keyword"},
        "build_sha": {"type": "keyword"},
        "created_at": {"type": "date"},
        "updated_at": {"type": "date"},
        "source_surface": {"type": "keyword"},
        "rule_ids": {"type": "keyword"},
        "entity": {
            "properties": {"type": {"type": "keyword"}, "value": {"type": "keyword"}}
        },
        "member_event_ids": {"type": "keyword"},
        "risk_score": {"type": "float"},
        "verdict": {"type": "keyword"},
        "confidence": {"type": "float"},
        "evidence": {
            "type": "object",
            "properties": {
                "summary": {"type": "text"},
                "event_ids": {"type": "keyword"},
                "query": {"type": "keyword"},
            },
        },
        "mitre": {"type": "keyword"},
        "recommended_action": {"type": "text"},
        "reproduce_query": {"type": "keyword"},
        "status": {"type": "keyword"},
        "decision_by": {"type": "keyword"},
        "objection_window_expires_at": {"type": "date"},
        "title": {"type": "text", "fields": {"keyword": {"type": "keyword", "ignore_above": 512}}},
        "summary": {"type": "text"},
        "risk_breakdown": {"type": "object", "enabled": True},
        "token_cost": {"type": "float"},
        "error": {"type": "text"},
        "history": {"type": "object", "enabled": False},
        "verdict_history": {"type": "object", "enabled": False},
        "origin_surface": {"type": "keyword"},
        "retrieval_history_status": {"type": "keyword"},
        "retrieval_observation_status": {"type": "keyword"},
        # Feature 3: not queryable, no mapping explosion.
        "trigger_reason": {"type": "object", "enabled": False},
    }
}

AUDIT_MAPPING = {
    # Round 14: the audit carries free strings in fields an older index maps
    # dynamically (``changes`` values, ``target`` ids and labels). With Elasticsearch's
    # default date detection, the first such value that looks like a date ("2027-04-20")
    # would map the field as ``date`` and every later row with ordinary text there would
    # be rejected, failing audit-first writes. No audit index created from this template
    # ever date-detects a string; ``ts`` is mapped explicitly.
    "date_detection": False,
    "properties": {
        "ts": {"type": "date"},
        "case_id": {"type": "keyword"},
        "app_version": {"type": "keyword"},
        "build_sha": {"type": "keyword"},
        # B3 coverage observability: ``source_id`` is used as a term-filter in
        # ``AuditLogger.records(source_id=...)`` (the per-source poll history behind
        # GET /api/audit?source_id=). Without this explicit keyword mapping, real
        # Elasticsearch dynamic-maps it to ANALYZED text, so a term query on a hyphenated /
        # dotted / UUID source id silently returns ZERO hits (the in-memory FakeES masks the
        # bug with plain equality). Keyword-map it like the other term-filter fields.
        # NOTE: existing ES deployments must update the tlsoc-agent-audit index template
        # (or roll a fresh write index) for this to take effect on already-created indices.
        "source_id": {"type": "keyword"},
        "surface": {"type": "keyword"},
        "actor": {"type": "keyword"},
        "action_type": {"type": "keyword"},
        "model": {"type": "keyword"},
        "prompt_excerpt": {"type": "text"},
        "query_text": {"type": "text", "fields": {"keyword": {"type": "keyword", "ignore_above": 2048}}},
        "tool_name": {"type": "keyword"},
        "tool_input": {"type": "object", "enabled": False},
        "tool_output_summary": {"type": "text"},
        "result_summary": {"type": "text"},
        # Round 14 (SPEC §4.5.3): the structured fields of new rows. Filters use
        # them, so each is a keyword (``client.ip`` an ``ip``). On an upgraded
        # deployment bootstrap adds each of them that the stored template and the live
        # audit indices lack, where the client can (:func:`extend_audit_mapping`); one
        # that an index already mapped dynamically (text with a ``.keyword``
        # sub-field) is left as it is until the index rolls over, and the read API
        # compiles every exact match for both mappings (``app.audit.query._es_dual``).
        # ``changes`` and the raw client strings are kept in the document only, never
        # indexed.
        "outcome": {"type": "keyword"},
        "actor_type": {"type": "keyword"},
        "action": {"type": "keyword"},
        "actor_role": {"type": "keyword"},
        "client": {
            "properties": {
                "ip": {"type": "ip"},
                "ip_source": {"type": "keyword"},
                "peer": {"type": "keyword", "index": False, "doc_values": False},
                "forwarded_for": {"type": "text", "index": False},
                "user_agent": {"type": "text", "index": False},
            }
        },
        "session_ref": {"type": "keyword"},
        "target": {
            "properties": {
                "type": {"type": "keyword"},
                "id": {"type": "keyword"},
                "label": {"type": "text", "fields": {"keyword": {"type": "keyword", "ignore_above": 256}}},
                "revision": {"type": "long"},
            }
        },
        "changes": {"type": "object", "enabled": False},
        "request_id": {"type": "keyword"},
        "run_id": {"type": "keyword"},
    }
}

USAGE_MAPPING = {
    "properties": {
        "ts": {"type": "date"},
        "surface": {"type": "keyword"},
        "case_id": {"type": "keyword"},
        "app_version": {"type": "keyword"},
        "build_sha": {"type": "keyword"},
        "role": {"type": "keyword"},
        "model": {"type": "keyword"},
        "prompt_tokens": {"type": "long"},
        "completion_tokens": {"type": "long"},
        "total_tokens": {"type": "long"},
        "cost": {"type": "double"},
        "currency": {"type": "keyword"},
        "latency_ms": {"type": "long"},
        "outcome": {"type": "keyword"},
        "cache_read_tokens": {"type": "long"},
        "cache_write_tokens": {"type": "long"},
        "batch": {"type": "boolean"},
        "processing_tier": {"type": "keyword"},
    }
}

# {base index name: mapping} for the three date-rolling contract indices.
CONTRACT_INDICES = {
    CASES_INDEX: CASES_MAPPING,
    AUDIT_INDEX: AUDIT_MAPPING,
    USAGE_INDEX: USAGE_MAPPING,
}


def index_template_body(
    base: str, mapping: dict, *, extra_settings: dict | None = None
) -> dict:
    settings = {**_COMMON_SETTINGS, **(extra_settings or {})}
    return {
        "index_patterns": [f"{base}-*"],
        "template": {"settings": settings, "mappings": mapping},
        "priority": 600,
        "_meta": {"owner": "tlsoc-agentic-triage", "contract": base},
    }


#: The keys a composable index template body may be put back with (a stored template
#: read back can carry read-only bookkeeping keys a put refuses).
_TEMPLATE_PUT_KEYS = frozenset({
    "index_patterns", "template", "composed_of", "priority", "version", "_meta",
    "data_stream", "allow_auto_create", "ignore_missing_component_templates", "deprecated",
})


def missing_properties(
    desired: dict[str, Any], existing: dict[str, Any], *, prefix: str = "",
) -> tuple[dict[str, Any], list[str]]:
    """The part of the ``desired`` mapping properties that ``existing`` lacks (into
    object fields both have), and the dotted names of desired properties that exist
    with another shape and are therefore left as they are.

    Only absent properties are returned, so a mapping update built from the result
    adds fields and never changes one."""
    missing: dict[str, Any] = {}
    kept: list[str] = []
    for name, spec in desired.items():
        dotted = f"{prefix}{name}"
        current = existing.get(name)
        if not isinstance(current, dict):
            missing[name] = copy.deepcopy(spec)
            continue
        wanted_children = spec.get("properties") if isinstance(spec, dict) else None
        if isinstance(wanted_children, dict):
            is_object = current.get("type", "object") == "object" and current.get("enabled", True) is not False
            if not is_object:
                kept.append(dotted)
                continue
            current_children = current.get("properties")
            sub, sub_kept = missing_properties(
                wanted_children, current_children if isinstance(current_children, dict) else {},
                prefix=f"{dotted}.",
            )
            if sub:
                missing[name] = {"properties": sub}
            kept.extend(sub_kept)
            continue
        wanted_type = spec.get("type", "object") if isinstance(spec, dict) else None
        current_type = current.get("type", "object")
        if wanted_type != current_type or (
            wanted_type == "object" and spec.get("enabled", True) != current.get("enabled", True)
        ):
            kept.append(dotted)
    return missing, kept


def _merge_properties(target: dict[str, Any], additions: dict[str, Any]) -> None:
    """Add :func:`missing_properties` output into a stored mapping's properties."""
    for name, spec in additions.items():
        current = target.get(name)
        if isinstance(current, dict) and "properties" in spec:
            children = current.get("properties")
            if not isinstance(children, dict):
                children = current["properties"] = {}
            _merge_properties(children, spec["properties"])
        else:
            target[name] = copy.deepcopy(spec)


async def _refresh_audit_template(es: Any, name: str, mapping: dict[str, Any]) -> None:
    """Add to the stored audit template the properties it lacks and turn its date
    detection off, keeping everything else it holds (lifecycle settings included), so
    the next audit index is created right. Changes only future indices."""
    try:
        stored = await es.get_index_template(name)
    except Exception as exc:  # noqa: BLE001 (bootstrap never fails on this)
        logger.warning("Audit template %s could not be read: %s", name, exc)
        return
    if not isinstance(stored, dict):
        return
    body = {k: copy.deepcopy(v) for k, v in stored.items() if k in _TEMPLATE_PUT_KEYS}
    template = body.setdefault("template", {})
    mappings = template.setdefault("mappings", {}) if isinstance(template, dict) else None
    if not isinstance(mappings, dict):
        logger.warning("Audit template %s has an unexpected shape; left as it is", name)
        return
    properties = mappings.setdefault("properties", {})
    missing, kept = missing_properties(mapping["properties"], properties)
    detect_off = mapping.get("date_detection") is False and mappings.get("date_detection") is not False
    if not missing and not detect_off:
        return
    _merge_properties(properties, missing)
    if detect_off:
        mappings["date_detection"] = False
    try:
        await es.put_index_template(name, body)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Audit template %s could not be updated: %s", name, exc)
        return
    logger.info("Updated index template %s: added %s%s", name, sorted(missing) or "no properties",
                "; date detection off" if detect_off else "")
    if kept:
        logger.info("Audit template %s keeps its own mapping of %s", name, kept)


#: What an operator does by hand on a deployment upgraded from a build before Round 14
#: when bootstrap cannot extend the audit mapping itself. The warning
#: :func:`extend_audit_mapping` logs names it; SPEC §4.5.3 assigns it to the Round 14
#: upgrade notes (``DEPLOY.md``, ``docs/operations/upgrades.md``).
AUDIT_UPGRADE_STEP = (
    "apply deploy/mappings/tlsoc-agent-audit.template.json as the index template "
    "tlsoc-agent-audit-template, then roll the audit write index "
    "(POST tlsoc-agent-audit/_rollover)"
)
_MAPPING_METHODS = ("get_index_template", "get_index_mapping", "put_index_mapping")


async def extend_audit_mapping(es: Any, base: str = AUDIT_INDEX,
                               mapping: dict[str, Any] = AUDIT_MAPPING) -> None:
    """Make an upgraded deployment's audit indices safe for Round 14 rows.

    The stored template gains the properties it lacks (future indices), and every
    existing audit index gains the properties it lacks plus ``date_detection: false``,
    so a date-like free string in a change or a target can never map a field as a
    date and then make every later row with ordinary text there fail (audit-first
    writes would answer 503). Purely additive: a property that already exists is left
    as it is and named in the log (an index that mapped one dynamically keeps that
    mapping until it rolls over, now from the updated template). Never fails the boot.

    Needs a client that can read a template, read a mapping and add to one
    (``get_index_template``, ``get_index_mapping``, ``put_index_mapping``). Through
    another client it changes nothing and logs a warning that names the operator step
    (:data:`AUDIT_UPGRADE_STEP`)."""
    if any(getattr(es, name, None) is None for name in _MAPPING_METHODS):
        logger.warning(
            "Audit mapping not checked: this Elasticsearch client cannot read or extend "
            "index mappings. If this deployment was upgraded from a build before Round 14, "
            "make sure this step has been done: %s. Until it is, a date-like value in an "
            "audit row can make later audit writes fail. A deployment whose audit index "
            "was first created by Round 14 or later needs nothing.", AUDIT_UPGRADE_STEP,
        )
        return
    await _refresh_audit_template(es, f"{base}-template", mapping)
    get_mapping = es.get_index_mapping
    put_mapping = es.put_index_mapping
    try:
        # The write alias (or a legacy concrete index of that name) and every backing
        # index the read pattern covers.
        live = await get_mapping(f"{base},{base}-*")
    except Exception as exc:  # noqa: BLE001
        logger.warning("Audit index mappings could not be read: %s", exc)
        return
    for index_name in sorted(live or {}):
        entry = live[index_name] if isinstance(live[index_name], dict) else {}
        mappings = entry.get("mappings") if isinstance(entry.get("mappings"), dict) else {}
        properties = mappings.get("properties") if isinstance(mappings.get("properties"), dict) else {}
        missing, kept = missing_properties(mapping["properties"], properties)
        update: dict[str, Any] = {}
        if missing:
            update["properties"] = missing
        if mapping.get("date_detection") is False and mappings.get("date_detection") is not False:
            update["date_detection"] = False
        if update:
            try:
                await put_mapping(index_name, update)
            except Exception as exc:  # noqa: BLE001 (never fail the boot)
                logger.warning("Audit index %s mapping could not be extended: %s", index_name, exc)
                continue
            logger.info("Extended audit index %s mapping: added %s%s", index_name,
                        sorted(missing) or "no properties",
                        "; date detection off" if "date_detection" in update else "")
        if kept:
            logger.warning(
                "Audit index %s already maps %s another way; left as it is until the "
                "index rolls over (POST %s/_rollover)", index_name, kept, base,
            )


async def bootstrap_indices(es: BaseESClient | None) -> None:
    """Idempotently create templates, write indices+aliases, and the single-doc
    bookkeeping indices. Safe to call on every start.

    An existing template or index is never replaced, remapped or reindexed; the audit
    contract alone is extended additively (:func:`extend_audit_mapping`) when its
    template or write index existed before this start.

    Guard (Epoch A): this only makes sense for the Elasticsearch OWN-state
    backend. When the suite's state lives in SQL (sqlite/postgres) the caller
    skips this entirely; as a defensive backstop, a ``None`` client (or one that
    does not expose the management surface) is a no-op rather than an error, so a
    non-ES state backend can never crash startup here."""
    if es is None or not hasattr(es, "index_template_exists"):
        logger.debug("bootstrap_indices skipped (no ES management client)")
        return
    for base, mapping in CONTRACT_INDICES.items():
        template_name = f"{base}-template"
        created_template = False
        if not await es.index_template_exists(template_name):
            await es.put_index_template(template_name, index_template_body(base, mapping))
            created_template = True
            logger.info("Created index template %s", template_name)
        first_index = f"{base}-000001"
        created_index = False
        if not await es.index_exists(first_index) and not await es.index_exists(base):
            await es.create_index(
                first_index, {"aliases": {base: {"is_write_index": True}}}
            )
            created_index = True
            logger.info("Created write index %s (alias %s)", first_index, base)
        if base == AUDIT_INDEX and not (created_template and created_index):
            # A template or an index from before this start (an upgrade, or an index
            # created without this template) may lack the Round 14 audit mapping.
            await extend_audit_mapping(es, base, mapping)

    for single in (CONFIG_INDEX, CURSOR_INDEX):
        if not await es.index_exists(single):
            await es.create_index(single, {"mappings": {"dynamic": True}})
            logger.info("Created bookkeeping index %s", single)
