"""Regression coverage for build attribution and honest retrieval-history gaps."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app import __version__
from app.audit.audit_log import AuditLogger
from app.build_identity import build_stamp, current_record_provenance, stamp_new_record
from app.constants import (
    AUDIT_WRITE_ALIAS,
    CASES_WRITE_ALIAS,
    USAGE_WRITE_ALIAS,
    ActionType,
    EntityType,
    SourceSurface,
)
from app.engine.correlation import cluster_from_events
from app.es.fake import InMemoryESClient
from app.es.indices import (
    AUDIT_MAPPING,
    CASES_MAPPING,
    USAGE_MAPPING,
    index_template_body,
)
from app.models import AuditDoc, Case, UsageDoc
from app.stores.cases import CaseStore
from app.stores.usage import UsageStore
from tests.conftest import make_raw_event


def _case_payload(case_id: str = "legacy-case", signature: str = "legacy-signature") -> dict:
    return {
        "case_id": case_id,
        "cluster_signature": signature,
        "source_surface": SourceSurface.INVESTIGATE.value,
        "entity": {"type": EntityType.IP.value, "value": "203.0.113.8"},
        "status": "open",
    }


def _cluster(ip: str):
    events = [make_raw_event(id=f"{ip}-{idx}", ip=ip) for idx in range(2)]
    return cluster_from_events(EntityType.IP, ip, events)


def test_build_identity_is_runtime_normalized(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TLSOC_BUILD_SHA", " abc123 ")
    monkeypatch.setenv("TLSOC_VERSION", "999.0.0")
    assert current_record_provenance() == {
        "app_version": __version__,
        "build_sha": "abc123",
    }

    for value in ("", "unknown", "UNKNOWN", "  Unknown  "):
        monkeypatch.setenv("TLSOC_BUILD_SHA", value)
        assert build_stamp("TLSOC_BUILD_SHA") == "unknown"

    monkeypatch.setenv("TLSOC_BUILD_SHA", "coherent-build")
    partial = UsageDoc(app_version="stale-version", build_sha=None)
    stamped = stamp_new_record(partial)
    assert stamped.app_version == __version__
    assert stamped.build_sha == "coherent-build"


def test_legacy_case_keeps_missing_provenance_and_retrieval_unavailable() -> None:
    case = Case.model_validate(_case_payload())
    assert case.app_version is None
    assert case.build_sha is None
    assert case.knowledge_used == []
    assert case.retrieval_history_status == "unavailable"
    assert case.retrieval_observation_status == "unavailable"

    transitional_null = Case.model_validate({**_case_payload(), "knowledge_used": None})
    assert transitional_null.knowledge_used == []
    assert transitional_null.retrieval_observation_status == "unavailable"

    measured_zero = Case.model_validate({
        **_case_payload("measured", "measured-signature"),
        "knowledge_used": [],
        "retrieval_history_status": "available",
        "retrieval_observation_status": "measured",
    })
    assert measured_zero.knowledge_used == []
    assert measured_zero.retrieval_history_status == "available"
    assert measured_zero.retrieval_observation_status == "measured"


async def test_pipeline_stamps_new_case_but_preserves_legacy_unknowns(
    app_state, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("TLSOC_BUILD_SHA", "build-a")
    new_case = await app_state.pipeline.register_candidate(
        _cluster("198.51.100.10"), SourceSurface.AUTOMATED_SCAN, app_state.prefs
    )
    assert new_case.app_version == __version__
    assert new_case.build_sha == "build-a"
    assert new_case.retrieval_history_status == "available"
    assert new_case.retrieval_observation_status == "not_measured"
    assert new_case.knowledge_used == []

    legacy_cluster = _cluster("198.51.100.11")
    legacy_payload = {
        **_case_payload("legacy-refresh", legacy_cluster.signature),
        "entity": legacy_cluster.entity.model_dump(mode="json"),
        "member_event_ids": list(legacy_cluster.member_event_ids),
    }
    await app_state.es.index_doc(
        CASES_WRITE_ALIAS, legacy_payload, doc_id="legacy-refresh", refresh=True
    )

    monkeypatch.setenv("TLSOC_BUILD_SHA", "build-b")
    refreshed = await app_state.pipeline.register_candidate(
        legacy_cluster, SourceSurface.AUTOMATED_SCAN, app_state.prefs
    )
    assert refreshed.case_id == "legacy-refresh"
    assert refreshed.app_version is None
    assert refreshed.build_sha is None
    assert refreshed.retrieval_history_status == "unavailable"
    assert refreshed.retrieval_observation_status == "unavailable"
    assert refreshed.knowledge_used == []

    stored = await app_state.es.get_doc(CASES_WRITE_ALIAS, "legacy-refresh")
    assert stored is not None
    assert stored["app_version"] is None
    assert stored["build_sha"] is None
    assert stored["knowledge_used"] == []
    assert stored["retrieval_history_status"] == "unavailable"
    assert stored["retrieval_observation_status"] == "unavailable"


async def test_es_audit_and_usage_rows_stamp_first_writer_build(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    es = InMemoryESClient()
    audit = AuditLogger(es)
    usage = UsageStore(es)

    monkeypatch.setenv("TLSOC_BUILD_SHA", "first-build")
    audit_doc = AuditDoc(
        event_id="proposal:one:approve",
        action_type=ActionType.PROPOSAL,
        case_id="case-one",
        result_summary="approved",
    )
    await audit.write_strict(audit_doc)
    usage_doc = UsageDoc(
        idempotency_key="batch:one:result",
        surface="batch",
        role="investigator",
        model="model-a",
        total_tokens=5,
    )
    await usage.write_strict(usage_doc)

    monkeypatch.setenv("TLSOC_BUILD_SHA", "retry-build")
    await audit.write_strict(audit_doc)
    await usage.write_strict(usage_doc)

    audit_row = await es.get_doc(AUDIT_WRITE_ALIAS, "proposal:one:approve")
    usage_row = await es.get_doc(USAGE_WRITE_ALIAS, "batch:one:result")
    assert audit_row is not None and usage_row is not None
    for row in (audit_row, usage_row):
        assert row["app_version"] == __version__
        assert row["build_sha"] == "first-build"

    with pytest.raises(RuntimeError, match="audit event id collision"):
        await audit.write_strict(audit_doc.model_copy(update={"result_summary": "changed"}))


async def test_es_case_insert_fallback_stamps_new_and_preserves_first_writer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    es = InMemoryESClient()
    cases = CaseStore(es)
    direct = Case.model_validate(_case_payload("direct-case", "direct-signature"))

    monkeypatch.setenv("TLSOC_BUILD_SHA", "direct-first-build")
    await cases.save(direct)
    first = await cases.get("direct-case")
    assert first is not None
    assert first.app_version == __version__
    assert first.build_sha == "direct-first-build"

    # Reusing the caller's unchanged, unstamped model must not erase the first row's
    # creation identity or replace it with a later deployment.
    monkeypatch.setenv("TLSOC_BUILD_SHA", "direct-later-build")
    await cases.save(direct.model_copy(update={"status": "closed"}))
    updated = await cases.get("direct-case")
    assert updated is not None
    assert updated.app_version == __version__
    assert updated.build_sha == "direct-first-build"

    # A direct caller cannot replace the immutable creation pair merely by supplying
    # two non-empty values.
    await cases.save(
        updated.model_copy(update={"app_version": "forged", "build_sha": "forged"})
    )
    protected = await cases.get("direct-case")
    assert protected is not None
    assert protected.app_version == __version__
    assert protected.build_sha == "direct-first-build"

    legacy = Case.model_validate(_case_payload("legacy-direct", "legacy-direct-signature"))
    await es.index_doc(
        CASES_WRITE_ALIAS,
        legacy.model_dump(mode="json", exclude={"app_version", "build_sha"}),
        doc_id=legacy.case_id,
        refresh=True,
    )
    await cases.save(legacy.model_copy(update={"status": "closed"}))
    legacy_updated = await cases.get("legacy-direct")
    assert legacy_updated is not None
    assert legacy_updated.app_version is None
    assert legacy_updated.build_sha is None


def test_es_mappings_and_deploy_templates_are_exactly_synchronized() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    contracts = (
        ("cases", "tlsoc-agent-cases", CASES_MAPPING),
        ("audit", "tlsoc-agent-audit", AUDIT_MAPPING),
        ("usage", "tlsoc-agent-usage", USAGE_MAPPING),
    )
    for short_name, base, mapping in contracts:
        properties = mapping["properties"]
        assert properties["app_version"] == {"type": "keyword"}
        assert properties["build_sha"] == {"type": "keyword"}
        if short_name == "cases":
            assert properties["retrieval_history_status"] == {"type": "keyword"}
            assert properties["retrieval_observation_status"] == {"type": "keyword"}

        path = repo_root / "deploy" / "mappings" / f"tlsoc-agent-{short_name}.template.json"
        assert json.loads(path.read_text(encoding="utf-8")) == index_template_body(base, mapping)
