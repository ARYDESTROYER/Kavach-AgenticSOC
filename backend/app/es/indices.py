"""Index templates and first-boot index bootstrap (Section 4.3 / 7).

The backend OWNS and creates its three contract indices (cases/audit/usage) plus
two single-doc bookkeeping indices (config/cursor) using the management
credential. The same mapping definitions are exported to ``deploy/mappings`` so a
cold deploy can pre-create them if desired.
"""

from __future__ import annotations

import logging

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


async def bootstrap_indices(es: BaseESClient | None) -> None:
    """Idempotently create templates, write indices+aliases, and the single-doc
    bookkeeping indices. Safe to call on every start.

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
        if not await es.index_template_exists(template_name):
            await es.put_index_template(template_name, index_template_body(base, mapping))
            logger.info("Created index template %s", template_name)
        first_index = f"{base}-000001"
        if not await es.index_exists(first_index) and not await es.index_exists(base):
            await es.create_index(
                first_index, {"aliases": {base: {"is_write_index": True}}}
            )
            logger.info("Created write index %s (alias %s)", first_index, base)

    for single in (CONFIG_INDEX, CURSOR_INDEX):
        if not await es.index_exists(single):
            await es.create_index(single, {"mappings": {"dynamic": True}})
            logger.info("Created bookkeeping index %s", single)
