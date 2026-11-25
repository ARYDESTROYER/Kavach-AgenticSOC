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

Round 15 (SPEC D5.7) adds one more additive mapping, on the config index: the
screenshot content field ``case_file_data`` (base64, ``stores.case_files``) is mapped
``binary``, stored but never indexed. A fresh install creates the config index with it
(:data:`CONFIG_MAPPING`); an upgraded one gains it at bootstrap, before the first
screenshot is written (:func:`extend_config_mapping`). If that cannot be done, or the
field was already mapped dynamically as text, writes still work and each screenshot's
base64 is indexed as text (the cost is stated in ``docs/operations/health-backup.md``).

Round 16 (SPEC §3.4) adds two properties to the cases contract, additively in the same
way (:func:`extend_cases_mapping`): ``risk_breakdown.inputs`` is stored and never
indexed (it holds source-controlled rule values, and the cases index date-detects, so a
value such as ``2026-01-01`` would otherwise map a field as a date and fail every later
case save), and ``awaiting_reason`` is mapped explicitly as text with a ``keyword``
sub-field, identical to the dynamic default, so the deferred drain's prefix query works
on new and old indices alike. When bootstrap cannot give the cases mapping the
``inputs`` field, the case store leaves it out of the stored document
(:func:`cases_risk_inputs_storable`), so a case always lands.
"""

from __future__ import annotations

import copy
import logging
import weakref
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
        # Round 16 (SPEC §3.4): the recorded score inputs are stored, never indexed.
        "risk_breakdown": {
            "type": "object",
            "enabled": True,
            "properties": {"inputs": {"type": "object", "enabled": False}},
        },
        "token_cost": {"type": "float"},
        "error": {"type": "text"},
        "history": {"type": "object", "enabled": False},
        "verdict_history": {"type": "object", "enabled": False},
        "origin_surface": {"type": "keyword"},
        "retrieval_history_status": {"type": "keyword"},
        "retrieval_observation_status": {"type": "keyword"},
        # Feature 3: not queryable, no mapping explosion.
        "trigger_reason": {"type": "object", "enabled": False},
        # Round 16 (SPEC §3.4, B11): what the dynamic mapping gives it, stated so a new
        # index matches an old one; the deferred drain asks a prefix of the keyword.
        "awaiting_reason": {
            "type": "text",
            "fields": {"keyword": {"type": "keyword", "ignore_above": 256}},
        },
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


#: Round 15 (SPEC D5.7): the config index mapping of a fresh install. Dynamic as
#: before (every KV namespace maps its own fixed fields), plus the screenshot content
#: field as ``binary`` so its base64 is stored and never indexed.
CASE_FILE_DATA_FIELD = "case_file_data"
CONFIG_MAPPING: dict[str, Any] = {
    "dynamic": True,
    "properties": {CASE_FILE_DATA_FIELD: {"type": "binary"}},
}


async def extend_config_mapping(es: Any, index: str = CONFIG_INDEX) -> str:
    """Give an existing config index the binary ``case_file_data`` mapping before the
    first screenshot is written (Round 15 SPEC D5.7). Purely additive and never fails
    the boot. Returns what happened: ``added``, ``present`` (already binary),
    ``kept_text`` (mapped dynamically by an earlier write: left as it is, writes still
    work), ``unsupported`` (the client cannot read or extend mappings) or ``failed``."""
    get_mapping = getattr(es, "get_index_mapping", None)
    put_mapping = getattr(es, "put_index_mapping", None)
    if get_mapping is None or put_mapping is None:
        logger.info("Config index mapping not checked: this client cannot read index mappings")
        return "unsupported"
    try:
        live = await get_mapping(index)
    except NotImplementedError:
        logger.info("Config index mapping not checked: this client cannot read index mappings")
        return "unsupported"
    except Exception as exc:  # noqa: BLE001 (never fail the boot)
        logger.warning("Config index mapping could not be read: %s", exc)
        return "failed"
    entry = next(iter((live or {}).values()), None) if isinstance(live, dict) else None
    mappings = entry.get("mappings") if isinstance(entry, dict) else None
    properties = mappings.get("properties") if isinstance(mappings, dict) else None
    current = properties.get(CASE_FILE_DATA_FIELD) if isinstance(properties, dict) else None
    if isinstance(current, dict):
        if current.get("type") == "binary":
            return "present"
        logger.warning(
            "Config index %s already maps %s as %s; screenshots still work, and their "
            "content stays indexed until the index is recreated", index,
            CASE_FILE_DATA_FIELD, current.get("type", "object"),
        )
        return "kept_text"
    try:
        await put_mapping(index, {"properties": copy.deepcopy(CONFIG_MAPPING["properties"])})
    except NotImplementedError:
        logger.info("Config index mapping not extended: this client cannot extend index mappings")
        return "unsupported"
    except Exception as exc:  # noqa: BLE001 (never fail the boot)
        logger.warning("Config index %s mapping could not be extended: %s", index, exc)
        return "failed"
    logger.info("Extended config index %s mapping: added %s (binary)", index, CASE_FILE_DATA_FIELD)
    return "added"


#: Per management client: whether this process proved the cases mapping holds
#: ``risk_breakdown.inputs`` as stored and never indexed (:func:`extend_cases_mapping`).
#: A client bootstrap never saw (the in-memory store of Demo Mode and tests, which maps
#: nothing) is absent and reads as storable.
_RISK_INPUTS_STORABLE: "weakref.WeakKeyDictionary[Any, bool]" = weakref.WeakKeyDictionary()

#: The dotted cases properties whose own mapping decides whether ``inputs`` is safe.
_RISK_INPUTS_PATHS = frozenset({"risk_breakdown", "risk_breakdown.inputs"})


def _record_risk_inputs_storable(es: Any, storable: bool) -> None:
    try:
        _RISK_INPUTS_STORABLE[es] = bool(storable)
    except TypeError:  # a client that cannot be weakly referenced: nothing recorded
        pass


def cases_risk_inputs_storable(es: Any) -> bool:
    """Whether a case document written through ``es`` may carry
    ``risk_breakdown.inputs`` (Round 16 SPEC §3.4). ``False`` only when this process's
    bootstrap ran on ``es`` and could not prove the cases mapping stores the field
    without indexing it; the case store then leaves the field out."""
    try:
        return _RISK_INPUTS_STORABLE.get(es, True)
    except TypeError:
        return True


async def _refresh_cases_template(
    es: Any, name: str, mapping: dict[str, Any]
) -> tuple[bool, list[str]]:
    """Add to the stored cases template the properties it lacks (future indices),
    keeping everything else it holds. Returns ``(ok, kept)``: ``ok`` is ``False`` when
    the template could not be read or written; ``kept`` names desired properties the
    template maps another way. ``NotImplementedError`` (a client without the template
    API) propagates to the caller."""
    try:
        stored = await es.get_index_template(name)
    except NotImplementedError:
        raise
    except Exception as exc:  # noqa: BLE001 (bootstrap never fails on this)
        logger.warning("Cases template %s could not be read: %s", name, exc)
        return False, []
    if not isinstance(stored, dict):
        # No template to extend (removed by hand): the next index cannot be proven safe.
        logger.warning("Cases template %s was not found; recorded risk inputs are not stored", name)
        return False, []
    body = {k: copy.deepcopy(v) for k, v in stored.items() if k in _TEMPLATE_PUT_KEYS}
    template = body.setdefault("template", {})
    mappings = template.setdefault("mappings", {}) if isinstance(template, dict) else None
    properties = mappings.setdefault("properties", {}) if isinstance(mappings, dict) else None
    if not isinstance(properties, dict):
        logger.warning("Cases template %s has an unexpected shape; left as it is", name)
        return False, []
    missing, kept = missing_properties(mapping["properties"], properties)
    if missing:
        _merge_properties(properties, missing)
        try:
            await es.put_index_template(name, body)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Cases template %s could not be updated: %s", name, exc)
            return False, kept
        logger.info("Updated index template %s: added %s", name, sorted(missing))
    return True, kept


async def extend_cases_mapping(es: Any, base: str = CASES_INDEX,
                               mapping: dict[str, Any] = CASES_MAPPING) -> str:
    """Give an upgraded deployment's cases template and indices the Round 16 properties
    (SPEC §3.4): ``risk_breakdown.inputs`` stored and never indexed, and an explicit
    ``awaiting_reason``. Purely additive: a property that already exists is left as it
    is and named in the log. Never fails the boot.

    Returns ``added`` (something was added and every template and index now holds
    ``inputs`` safely), ``present`` (nothing was missing), ``kept`` (a template or
    index already maps ``risk_breakdown.inputs`` another way), ``unsupported`` (the
    client cannot read or extend mappings, or cannot read the cases template, as the
    shipped client cannot) or ``failed``. Records whether the case
    store may write ``inputs`` (:func:`cases_risk_inputs_storable`): only ``added`` and
    ``present`` allow it."""
    outcome = await _extend_cases_mapping(es, base, mapping)
    _record_risk_inputs_storable(es, outcome in ("added", "present"))
    return outcome


async def _extend_cases_mapping(es: Any, base: str, mapping: dict[str, Any]) -> str:
    if getattr(es, "get_index_mapping", None) is None or getattr(es, "put_index_mapping", None) is None:
        logger.warning("Cases mapping not checked: this client cannot read or extend index mappings")
        return "unsupported"
    if getattr(es, "get_index_template", None) is None:
        # The shipped client reads and extends index mappings, but cannot read a
        # template, so the next cases index cannot be proven safe either.
        logger.warning(
            "Cases mapping not extended: this Elasticsearch client cannot read the cases "
            "index template, so recorded risk inputs are left out of stored cases. A "
            "deployment whose cases template and first index were created by this build "
            "stores them."
        )
        return "unsupported"
    try:
        template_ok, template_kept = await _refresh_cases_template(es, f"{base}-template", mapping)
        live = await es.get_index_mapping(f"{base},{base}-*")
    except NotImplementedError:
        logger.warning("Cases mapping not checked: this client cannot read or extend index mappings")
        return "unsupported"
    except Exception as exc:  # noqa: BLE001 (never fail the boot)
        logger.warning("Cases index mappings could not be read: %s", exc)
        return "failed"
    failed = not template_ok
    inputs_kept = bool(_RISK_INPUTS_PATHS.intersection(template_kept))
    added = False
    for index_name in sorted(live or {}):
        entry = live[index_name] if isinstance(live[index_name], dict) else {}
        mappings = entry.get("mappings") if isinstance(entry.get("mappings"), dict) else {}
        properties = mappings.get("properties") if isinstance(mappings.get("properties"), dict) else {}
        missing, kept = missing_properties(mapping["properties"], properties)
        if missing:
            try:
                await es.put_index_mapping(index_name, {"properties": missing})
            except NotImplementedError:
                logger.warning("Cases mapping not extended: this client cannot extend index mappings")
                return "unsupported"
            except Exception as exc:  # noqa: BLE001 (never fail the boot)
                logger.warning("Cases index %s mapping could not be extended: %s", index_name, exc)
                failed = True
                continue
            added = True
            logger.info("Extended cases index %s mapping: added %s", index_name, sorted(missing))
        if kept:
            logger.warning(
                "Cases index %s already maps %s another way; left as it is until the "
                "index rolls over", index_name, kept,
            )
            inputs_kept = inputs_kept or bool(_RISK_INPUTS_PATHS.intersection(kept))
    if failed:
        return "failed"
    if inputs_kept:
        return "kept"
    return "added" if added else "present"


async def bootstrap_indices(es: BaseESClient | None) -> None:
    """Idempotently create templates, write indices+aliases, and the single-doc
    bookkeeping indices. Safe to call on every start.

    An existing template or index is never replaced, remapped or reindexed. Three
    contracts are extended additively when their template or index existed before
    this start: audit (:func:`extend_audit_mapping`), config
    (:func:`extend_config_mapping`) and cases (:func:`extend_cases_mapping`).

    Guard (Epoch A): this only makes sense for the Elasticsearch OWN-state
    backend. When the suite's state lives in SQL (sqlite/postgres) the caller
    skips this entirely; as a defensive backstop, a ``None`` client (or one that
    does not expose the management surface) is a no-op rather than an error, so a
    non-ES state backend can never crash startup here."""
    if es is None or not hasattr(es, "index_template_exists"):
        logger.debug("bootstrap_indices skipped (no ES management client)")
        return
    # Until the cases mapping is proven to store ``risk_breakdown.inputs`` safely, the
    # case store leaves it out (Round 16 SPEC §3.4); a bootstrap that fails part way
    # keeps it that way.
    _record_risk_inputs_storable(es, False)
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
        if base == CASES_INDEX:
            if created_template and created_index:
                # Both created from this build's mapping just now.
                _record_risk_inputs_storable(es, True)
            else:
                # A template or an index from before this start may lack the Round 16
                # cases properties; added before the first case with inputs is written.
                await extend_cases_mapping(es, base, mapping)

    for single in (CONFIG_INDEX, CURSOR_INDEX):
        if not await es.index_exists(single):
            # Round 15 (SPEC D5.7): the config index is created with the screenshot
            # content field already mapped binary.
            mapping = CONFIG_MAPPING if single == CONFIG_INDEX else {"dynamic": True}
            await es.create_index(single, {"mappings": copy.deepcopy(mapping)})
            logger.info("Created bookkeeping index %s", single)
        elif single == CONFIG_INDEX:
            await extend_config_mapping(es)
