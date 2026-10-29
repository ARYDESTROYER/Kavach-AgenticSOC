"""Discounted alert inference + portable data-export contracts (offline)."""

from __future__ import annotations

import base64
import json
from contextlib import asynccontextmanager

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.api.routes_export import (
    _MAX_EXPORT_BYTES,
    _decode_cursor,
    _encode_cursor,
    _limit_grouped_rows,
    _plain,
    router as export_router,
)
from app.config import BatchConfig, ModelConfig, Secrets
from app.constants import AUDIT_WRITE_ALIAS, USAGE_READ_PATTERN, UserRole
from app.es.fake import InMemoryESClient
from app.llm.gateway import LLMGateway
from app.llm.providers import (
    PROVIDER_REGISTRY,
    BaseProvider,
    CompletionResult,
    OpenAIProvider,
    ProviderError,
)
from app.rbac.policy import can
from app.state import AppState
from app.stores.usage import UsageStore


class _FakeSecrets:
    anthropic_api_key = None
    openai_api_key = "sk-test"
    embedding_api_key = None

    def embedding_key(self):
        return self.openai_api_key


class _ResultProvider(BaseProvider):
    def __init__(self, tier: str) -> None:
        self.tier = tier

    async def complete(self, role, messages, model, temperature, max_tokens):
        return CompletionResult(
            text="ok", prompt_tokens=100, completion_tokens=20, model=model,
            batch=self.tier == "flex", processing_tier=self.tier,
        )


async def _usage_docs(es: InMemoryESClient) -> list[dict]:
    resp = await es.search(USAGE_READ_PATTERN, {"size": 100, "query": {"match_all": {}}})
    return [hit["_source"] for hit in resp["hits"]["hits"]]


@pytest.mark.asyncio
@pytest.mark.parametrize("surface", ["automated_scan", "investigate"])
async def test_every_live_alert_surface_prefers_openai_flex_and_is_truthfully_metered(
    monkeypatch, surface,
):
    captured: list[dict] = []

    def factory(**kwargs):
        captured.append(dict(kwargs))
        return _ResultProvider("flex" if kwargs.get("service_tier") == "flex" else "standard")

    monkeypatch.setitem(PROVIDER_REGISTRY, "openai", factory)
    es = InMemoryESClient()
    policy = BatchConfig(prefer_discounted_alerts=True, fallback_to_standard=True)
    gateway = LLMGateway(
        _FakeSecrets(), UsageStore(es), discounted_policy=lambda: policy,
    )
    result = await gateway.complete(
        "investigator", [{"role": "user", "content": "alert"}],
        ModelConfig(provider="openai", model="gpt-5.6-luna"),
        surface=surface, case_id=f"case-{surface}",
    )

    assert captured[0]["service_tier"] == "flex"
    assert captured[0]["fallback_to_standard"] is True
    assert result.processing_tier == "flex" and result.batch is True
    docs = await _usage_docs(es)
    assert len(docs) == 1
    assert docs[0]["processing_tier"] == "flex"
    assert docs[0]["batch"] is True
    # 100 input + 20 output tokens at Luna Standard ($0.20/M + $1.20/M),
    # discounted by 0.5 only because the provider confirmed the Flex tier.
    assert docs[0]["cost"] == pytest.approx(0.000022)


@pytest.mark.asyncio
async def test_flex_provider_cache_tracks_live_fallback_policy(monkeypatch):
    captured: list[dict] = []

    def factory(**kwargs):
        captured.append(dict(kwargs))
        return _ResultProvider("flex")

    monkeypatch.setitem(PROVIDER_REGISTRY, "openai", factory)
    policy = BatchConfig(prefer_discounted_alerts=True, fallback_to_standard=True)
    gateway = LLMGateway(
        _FakeSecrets(), UsageStore(InMemoryESClient()), discounted_policy=lambda: policy,
    )
    model = ModelConfig(provider="openai", model="gpt-5-mini")
    await gateway.complete(
        "investigator", [{"role": "user", "content": "one"}], model,
        surface="automated_scan",
    )
    policy.fallback_to_standard = False
    await gateway.complete(
        "investigator", [{"role": "user", "content": "two"}], model,
        surface="automated_scan",
    )

    assert [call["fallback_to_standard"] for call in captured] == [True, False]


@pytest.mark.asyncio
async def test_live_flex_is_independent_of_async_batch_provider_allow_list(monkeypatch):
    captured: list[dict] = []

    def factory(**kwargs):
        captured.append(dict(kwargs))
        return _ResultProvider("flex")

    monkeypatch.setitem(PROVIDER_REGISTRY, "openai", factory)
    policy = BatchConfig(
        providers=["anthropic"],
        prefer_discounted_alerts=True,
        fallback_to_standard=True,
    )
    gateway = LLMGateway(
        _FakeSecrets(), UsageStore(InMemoryESClient()), discounted_policy=lambda: policy,
    )
    await gateway.complete(
        "investigator", [{"role": "user", "content": "alert"}],
        ModelConfig(provider="openai", model="gpt-5-mini"),
        surface="investigate",
    )

    assert captured[0]["service_tier"] == "flex"


@pytest.mark.asyncio
async def test_unsupported_model_and_non_alert_surface_stay_standard(monkeypatch):
    captured: list[dict] = []

    def factory(**kwargs):
        captured.append(dict(kwargs))
        return _ResultProvider("standard")

    monkeypatch.setitem(PROVIDER_REGISTRY, "openai", factory)
    policy = BatchConfig(prefer_discounted_alerts=True)
    gateway = LLMGateway(
        _FakeSecrets(), UsageStore(InMemoryESClient()), discounted_policy=lambda: policy,
    )
    await gateway.complete(
        "router", [{"role": "user", "content": "alert"}],
        ModelConfig(provider="openai", model="gpt-4o"), surface="automated_scan",
    )
    await gateway.complete(
        "chat", [{"role": "user", "content": "question"}],
        ModelConfig(provider="openai", model="gpt-5-mini"), surface="chat",
    )
    assert all("service_tier" not in call for call in captured)


@pytest.mark.asyncio
async def test_flex_unavailable_falls_back_without_discount_stamp():
    class _Response:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "choices": [{"message": {"content": "standard"}}],
                "usage": {"prompt_tokens": 4, "completion_tokens": 2},
                "service_tier": "default",
            }

    class _Client:
        def __init__(self) -> None:
            self.payloads: list[dict] = []

        async def post(self, _url, *, json=None, **_kwargs):  # noqa: A002
            self.payloads.append(dict(json or {}))
            if len(self.payloads) == 1:
                raise ProviderError(
                    "HTTP 400: service_tier flex not supported",
                    retryable=False,
                    status=400,
                )
            return _Response()

        async def aclose(self):
            return None

    provider = OpenAIProvider(
        api_key="sk-test", service_tier="flex", fallback_to_standard=True,
    )
    await provider._client.aclose()  # close the unused real client before injecting
    client = _Client()
    provider._client = client  # type: ignore[assignment]
    result = await provider.complete(
        "router", [{"role": "user", "content": "x"}], "gpt-5-mini", 0.0, 32,
    )
    assert client.payloads[0]["service_tier"] == "flex"
    assert "service_tier" not in client.payloads[1]
    assert result.processing_tier == "standard" and result.batch is False


def test_data_export_permission_is_owner_scoped():
    assert can(UserRole.SUPER_ADMIN, "data_export", "export") is True
    assert can(UserRole.SOC_MANAGER, "data_export", "export") is True
    assert can(UserRole.ANALYST_TIER2, "data_export", "export") is False
    assert can(UserRole.AUDITOR, "data_export", "export") is False


def test_export_sanitizer_omits_credentials_and_redacts_free_text():
    result = _plain({
        "api_key": "do-not-export",
        "nested": {"password_hash": "hash", "prompt_tokens": 42},
        "note": "Authorization Bearer abcdefghijklmnop and sk-abcdefghijklmnop",
    })
    assert "api_key" not in result
    assert "password_hash" not in result["nested"]
    assert result["nested"]["prompt_tokens"] == 42
    assert "abcdefghijklmnop" not in result["note"]
    assert result["note"].count("[REDACTED]") == 2


def test_grouped_export_limit_is_scope_wide_and_keeps_collections_represented():
    result = _limit_grouped_rows(
        {"proposals": [1, 2, 3], "campaigns": [4, 5], "jobs": [6, 7]}, 4,
    )
    assert sum(len(rows) for rows in result.values()) == 4
    assert result == {"proposals": [1, 2], "campaigns": [4], "jobs": [6]}


def test_segment_cursor_is_authenticated_subject_bound_and_monotonic():
    key = b"portable-export-test-key" * 2
    cursor = _encode_cursor(
        scope="knowledge",
        position=3,
        snapshot_total=9,
        exported=3,
        segment=2,
        actor="alice",
        snapshot_id="snapshot_export_12345",
        signing_key=key,
    )
    decoded = _decode_cursor(
        "knowledge", cursor, actor="alice", signing_key=key,
    )
    assert decoded == {
        "snapshot_id": "snapshot_export_12345",
        "position": 3,
        "snapshot_total": 9,
        "exported": 3,
        "segment": 2,
    }

    # The same opaque continuation cannot be replayed by another principal.
    with pytest.raises(HTTPException) as wrong_subject:
        _decode_cursor("knowledge", cursor, actor="bob", signing_key=key)
    assert wrong_subject.value.status_code == 400

    # Altering a signed payload to skip ahead fails before any repository read.
    payload, signature = cursor.split(".", 1)
    raw = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    raw["exported"] = 8
    raw["position"] = 8
    tampered_payload = base64.urlsafe_b64encode(
        json.dumps(raw, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).decode("ascii").rstrip("=")
    with pytest.raises(HTTPException) as tampered:
        _decode_cursor(
            "knowledge",
            f"{tampered_payload}.{signature}",
            actor="alice",
            signing_key=key,
        )
    assert tampered.value.status_code == 400
    assert tampered.value.detail == "invalid export cursor"

    # Even authenticated continuation state is rejected when its position does not
    # agree with the cumulative count; this guards accidental non-monotonic issuance.
    inconsistent = _encode_cursor(
        scope="knowledge",
        position=6,
        snapshot_total=9,
        exported=3,
        segment=2,
        actor="alice",
        snapshot_id="snapshot_export_12345",
        signing_key=key,
    )
    with pytest.raises(HTTPException) as skipped:
        _decode_cursor("knowledge", inconsistent, actor="alice", signing_key=key)
    assert skipped.value.status_code == 400
    assert skipped.value.detail == "invalid export cursor position"


def test_export_endpoint_is_downloadable_canonical_json(mock_provider):
    overrides = {"anthropic": mock_provider, "openai": mock_provider, "mock": mock_provider}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(
            secrets=Secrets(_env_file=None), es=InMemoryESClient(),
            provider_overrides=overrides,
        )
        await state.startup(start_poller=False)
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(export_router)
    with TestClient(api) as client:
        response = client.post(
            "/api/admin/export",
            json={"scopes": ["configuration"], "limit_per_scope": 25},
        )

    assert response.status_code == 200
    assert response.headers["content-disposition"] == (
        'attachment; filename="agentic-soc-export.json"'
    )
    body = response.json()
    assert body["format"] == "agentic-soc-portable-export"
    assert body["selection"] == {"scopes": ["configuration"]}
    assert body["limits"]["items_per_scope"] == 25
    assert body["manifest"]["configuration"] == {
        "count": 1, "total": 1, "truncated": False,
    }
    assert "preferences" in body["data"]["configuration"]
    # Canonical serialization: sorted keys + compact separators.
    assert response.content == json.dumps(
        body, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def _export_runbook_document() -> str:
    return (
        "---\n"
        "id: export_triage\n"
        "title: Export triage\n"
        "summary: Validate a portable export finding.\n"
        "persona: general\n"
        "applies_to_rules: [export_rule]\n"
        "applies_to_techniques: [T1005]\n"
        "applies_to_entities: [host]\n"
        "keywords: [export, archive]\n"
        "---\n"
        "SIGNAL\n"
        "An export marker was observed with Bearer export-secret-12345678.\n\n"
        "EVIDENCE REQUIRED\n"
        "Confirm the actor, scope, timestamp, and destination.\n\n"
        "INVESTIGATION STEPS\n"
        "1. Confirm the export was approved.\n"
        "2. Compare the selected scope with the stated purpose.\n\n"
        "TRUE POSITIVE SIGNALS\n"
        "An unapproved export to an external destination supports a true positive.\n\n"
        "FALSE POSITIVE SIGNALS\n"
        "A documented operator backup supports a false positive.\n\n"
        "NEEDS HUMAN WHEN\n"
        "Ownership or destination evidence is unavailable.\n\n"
        "RECOMMENDED NEXT ACTION\n"
        "Escalate an unapproved export and preserve its audit trail.\n\n"
        "LIMITATIONS\n"
        "Destination telemetry may be incomplete.\n"
    )


def _export_playbook_document() -> str:
    return (
        "---\n"
        "id: export_playbook\n"
        "name: Export review\n"
        "version: 1\n"
        "description: Review an application-state export.\n"
        "rule_ids: [export_rule]\n"
        "priority: 10\n"
        "suggested_tools: [es_query]\n"
        "rag_queries: [portable export approval]\n"
        "---\n"
        "Confirm authorization and never disclose sk-exportsecret123456789.\n"
    )


async def _seed_legacy_procedures(state_or_kv) -> None:
    """The two retired procedure catalogs as a pre-Round-14 deployment left them
    (stored straight into their KV namespaces; nothing writes them any more)."""
    from app.constants import PLAYBOOKS_KEY, PLAYBOOKS_NS, RUNBOOKS_KEY, RUNBOOKS_NS

    def _row(content: str) -> dict:
        return {"content": content, "revision": 2, "created_by": "alice", "updated_by": "alice",
                "created_at": "2026-01-01T00:00:00+00:00", "updated_at": "2026-01-02T00:00:00+00:00"}

    await state_or_kv.put(RUNBOOKS_NS, RUNBOOKS_KEY, {"documents": {
        "export_triage": _row(_export_runbook_document()),
        "legacy_large": _row(
            "x" * 260_100 + " Bearer oversized-export-secret-12345678 END-OF-DOCUMENT"
        ),
    }})
    await state_or_kv.put(PLAYBOOKS_NS, PLAYBOOKS_KEY, {"documents": {
        "export_playbook": _row(_export_playbook_document()),
    }})


def test_intelligence_export_is_complete_sanitized_and_segmentable():
    """Round 14 (SPEC §4.10.18): the runbook library exports every operator runbook
    with every version and its sanitized Markdown source, built-ins as references; the
    two retired catalogs keep exporting their untouched stored documents for one
    release (read through ``stores.legacy_procedures``); the removed bundled groups
    export empty with the manifest note; the manifest schema moves to 2."""
    from app.engine.runbook_model import load_builtin_runbooks
    from app.stores.memory import EsKVStore

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        es = InMemoryESClient()
        # Seeded before startup, as an upgrade finds them: the migration converts them.
        await _seed_legacy_procedures(EsKVStore(es))
        state = AppState.create(secrets=Secrets(_env_file=None), es=es)
        await state.startup(start_poller=False)
        app.state.tlsoc = state
        yield
        await state.shutdown()

    builtins = load_builtin_runbooks()
    api = FastAPI(lifespan=lifespan)
    api.include_router(export_router)
    with TestClient(api) as client:
        legacy = client.post(
            "/api/admin/export",
            json={"scopes": ["knowledge"], "limit_per_scope": 1000},
        )
        assert legacy.status_code == 200
        legacy_body = legacy.json()
        knowledge = legacy_body["data"]["knowledge"]
        manifest = knowledge["catalog_manifests"][0]
        assert manifest["schema_version"] == 2
        assert manifest["legacy"]["operator_runbooks"] == 2
        assert manifest["legacy"]["operator_playbooks"] == 1
        assert manifest["runbook_library"]["bundled"] == len(builtins) >= 1
        assert manifest["runbook_library"]["bundled_content_included"] == 0
        assert manifest["removed"] == {
            "bundled_runbooks": "Removed in Round 14; see bundled_runbook_library",
            "bundled_playbooks": "Removed in Round 14; see bundled_runbook_library",
        }

        # The retired catalogs: untouched stored documents, sanitized, read-only.
        runbook = next(
            row for row in knowledge["operator_runbooks"]
            if row["id"] == "export_triage"
        )
        legacy_large = next(
            row for row in knowledge["operator_runbooks"]
            if row["id"] == "legacy_large"
        )
        playbook = knowledge["operator_playbooks"][0]
        assert playbook["id"] == "export_playbook"
        assert runbook["namespace"] == "runbooks" and playbook["namespace"] == "playbooks"
        assert runbook["read_only"] is True and runbook["revision"] == 2
        assert "export-secret-12345678" not in runbook["content"]
        assert "sk-exportsecret123456789" not in playbook["content"]
        assert "[REDACTED]" in runbook["content"]
        assert "[REDACTED]" in playbook["content"]
        assert len(legacy_large["content"]) > 250_000
        assert legacy_large["content"].endswith("[REDACTED] END-OF-DOCUMENT")
        assert knowledge["bundled_runbooks"] == []
        assert knowledge["bundled_playbooks"] == []

        # The library: the migrated operator runbooks with every version and source.
        library = {row["id"]: row for row in knowledge["operator_runbook_library"]}
        assert manifest["runbook_library"]["operator"] == len(library) >= 2
        assert manifest["runbook_library"]["operator_versions"] == sum(
            len(row["versions"]) for row in library.values()
        )
        migrated_ids = {
            row["migrated_from"]["id"]: row_id
            for row_id, row in library.items() if row.get("migrated_from")
        }
        assert {"export_triage", "export_playbook"} <= set(migrated_ids)
        triage = library[migrated_ids["export_triage"]]
        assert triage["origin"] == "imported" and triage["content_included"] is True
        assert triage["versions"] and all("source" in v and v["title"] for v in triage["versions"])
        assert "definition" not in triage["versions"][0]
        # Built-ins are versioned references, never their content.
        bundled = {row["id"]: row for row in knowledge["bundled_runbook_library"]}
        assert set(bundled) == {b.id for b in builtins}
        assert all(
            item["content_included"] is False and "content" not in item and "source" not in item
            for item in bundled.values()
        )
        assert all(item["version"] >= 1 and item["content_hash"] for item in bundled.values())
        dumped = json.dumps(legacy_body)
        assert "export-secret-12345678" not in dumped
        assert "sk-exportsecret123456789" not in dumped

        parts: list[dict] = []
        cursor = None
        while True:
            response = client.post(
                "/api/admin/export/segment",
                json={"scope": "knowledge", "cursor": cursor, "page_size": 2},
            )
            assert response.status_code == 200
            assert len(response.content) <= _MAX_EXPORT_BYTES
            part = response.json()
            parts.append(part)
            if part["segment"]["complete"]:
                break
            cursor = part["segment"]["next_cursor"]
            assert cursor

    segmented = {
        (row["group"], row["record"].get("id")): row["record"]
        for part in parts
        for row in part["records"]
        if isinstance(row.get("record"), dict)
    }
    segmented_manifests = [
        row["record"]
        for part in parts
        for row in part["records"]
        if row["group"] == "catalog_manifests"
    ]
    assert segmented_manifests == [manifest]
    assert ("operator_runbooks", "export_triage") in segmented
    assert ("operator_runbooks", "legacy_large") in segmented
    assert ("operator_playbooks", "export_playbook") in segmented
    assert ("operator_runbook_library", migrated_ids["export_triage"]) in segmented
    assert ("bundled_runbook_library", builtins[0].id) in segmented
    assert not any(group in ("bundled_runbooks", "bundled_playbooks") for group, _ in segmented)
    assert "export-secret-12345678" not in json.dumps(parts)
    assert "oversized-export-secret-12345678" not in json.dumps(parts)
    assert "sk-exportsecret123456789" not in json.dumps(parts)
    assert parts[-1]["segment"]["complete"] is True
    assert parts[-1]["segment"]["status"] == "complete"
    assert parts[-1]["segment"]["next_cursor"] is None
    assert parts[-1]["segment"]["cumulative_count"] == sum(
        len(part["records"]) for part in parts
    )


def _startup_audit_rows(records: list[dict]) -> list[dict]:
    """The rows startup wrote before the test seeded its own: since Round 14 the
    runbook migration always appends its summary row (decision E16)."""
    startup = [r for r in records if not str(r.get("result_summary", "")).startswith("seed-")]
    assert startup, "the runbook migration summary row is always written at startup"
    assert all(r.get("actor") == "runbook_migration" for r in startup)
    return startup


def test_segmented_export_walks_one_fixed_snapshot_past_the_page_limit():
    """Per-file limits must never become a false lifetime ceiling."""

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        es = InMemoryESClient()
        state = AppState.create(secrets=Secrets(_env_file=None), es=es)
        await state.startup(start_poller=False)
        for index in range(7):
            await es.index_doc(
                AUDIT_WRITE_ALIAS,
                {
                    "ts": f"2026-08-01T00:00:0{index}Z",
                    "action_type": "tool_call",
                    "result_summary": f"seed-{index}",
                },
                doc_id=f"seed-{index}",
            )
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(export_router)
    parts: list[dict] = []
    cursor = None
    with TestClient(api) as client:
        while True:
            response = client.post(
                "/api/admin/export/segment",
                json={"scope": "audit", "cursor": cursor, "page_size": 3},
            )
            assert response.status_code == 200
            part = response.json()
            parts.append(part)
            assert part["consistency"] == {
                "mode": "point_in_time",
                "exact": True,
                "detail": "All segments read the same fixed Elasticsearch point-in-time snapshot.",
            }
            if part["segment"]["complete"]:
                break
            cursor = part["segment"]["next_cursor"]
            assert cursor

    records = [row["record"] for part in parts for row in part["records"]]
    total = 7 + len(_startup_audit_rows(records))
    assert {part["segment"]["snapshot_total"] for part in parts} == {total}
    assert [part["segment"]["count"] for part in parts] == [
        min(3, total - 3 * index) for index in range(len(parts))
    ]
    assert len(parts) == -(-total // 3)
    assert parts[-1]["segment"]["cumulative_count"] == total
    assert parts[-1]["segment"]["status"] == "complete"
    assert parts[-1]["segment"]["next_cursor"] is None
    assert [
        row["record"]["result_summary"]
        for part in parts
        for row in part["records"]
        if str(row["record"].get("result_summary", "")).startswith("seed-")
    ] == [f"seed-{index}" for index in range(7)]


def test_segmented_export_crosses_the_legacy_5000_record_ceiling():
    """Five thousand is a file bound; record 5,001 must remain exportable."""

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        es = InMemoryESClient()
        state = AppState.create(secrets=Secrets(_env_file=None), es=es)
        await state.startup(start_poller=False)
        for index in range(5001):
            marker = f"seed-{index:05d}"
            await es.index_doc(
                AUDIT_WRITE_ALIAS,
                {
                    "ts": f"2026-08-01T00:00:{index % 60:02d}Z",
                    "action_type": "tool_call",
                    "result_summary": marker,
                },
                doc_id=marker,
            )
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(export_router)
    with TestClient(api) as client:
        first = client.post(
            "/api/admin/export/segment",
            json={"scope": "audit", "page_size": 5000},
        )
        assert first.status_code == 200
        first_body = first.json()
        second = client.post(
            "/api/admin/export/segment",
            json={
                "scope": "audit",
                "cursor": first_body["segment"]["next_cursor"],
                "page_size": 5000,
            },
        )

    assert second.status_code == 200
    second_body = second.json()
    records = [row["record"] for body in (first_body, second_body) for row in body["records"]]
    startup = len(_startup_audit_rows(records))
    assert first_body["segment"]["count"] == 5000
    assert first_body["segment"]["complete"] is False
    assert second_body["segment"]["count"] == 1 + startup
    assert second_body["segment"]["cumulative_count"] == 5001 + startup
    assert second_body["segment"]["complete"] is True
    assert second_body["segment"]["next_cursor"] is None
    # Record 5,001 of the seeded rows is still exported (the bound is per file).
    seeds = [r["result_summary"] for r in records if str(r.get("result_summary", "")).startswith("seed-")]
    assert seeds == [f"seed-{index:05d}" for index in range(5001)]


def test_segment_cancel_releases_snapshot_and_resume_fails_honestly():
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        es = InMemoryESClient()
        state = AppState.create(secrets=Secrets(_env_file=None), es=es)
        await state.startup(start_poller=False)
        for index in range(3):
            await es.index_doc(
                AUDIT_WRITE_ALIAS,
                {"ts": f"2026-08-01T00:00:0{index}Z", "result_summary": f"row-{index}"},
                doc_id=f"cancel-{index}",
            )
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(export_router)
    with TestClient(api) as client:
        first = client.post(
            "/api/admin/export/segment",
            json={"scope": "audit", "page_size": 1},
        )
        cursor = first.json()["segment"]["next_cursor"]
        assert cursor
        cancelled = client.post(
            "/api/admin/export/segment/cancel",
            json={"scope": "audit", "cursor": cursor},
        )
        assert cancelled.status_code == 200 and cancelled.json() == {"ok": True}
        resumed = client.post(
            "/api/admin/export/segment",
            json={"scope": "audit", "cursor": cursor, "page_size": 1},
        )

    assert resumed.status_code == 409
    assert "restart this scope" in resumed.json()["detail"]


@pytest.mark.parametrize(
    "scope",
    [
        "automation",
        "knowledge",
    ],
)
def test_segmented_export_never_calls_a_failed_safe_scope_complete(
    scope,
):
    """A swallowed registry outage must become 503, never an empty complete export."""

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=Secrets(_env_file=None), es=InMemoryESClient())
        await state.startup(start_poller=False)

        async def fail_strict_read(*_args, **_kwargs):
            raise RuntimeError("injected export read failure")

        if scope == "automation":
            # The ordinary ES KV getter is intentionally fail-soft. Inject at its
            # strict seam so this test proves export does not call the soft list().
            state.proposals._kv.get_strict = fail_strict_read  # type: ignore[attr-defined]
        else:
            # RAG's regular snapshot wrapper also converts errors to []; export must
            # call the strict, seed-free underlying read instead.
            state.rag_service._store.list_documents = fail_strict_read  # type: ignore[attr-defined]
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(export_router)
    with TestClient(api) as client:
        response = client.post(
            "/api/admin/export/segment",
            json={"scope": scope, "page_size": 1000},
        )

    assert response.status_code == 503
    assert response.json()["detail"] == (
        f"the {scope} export scope is temporarily unavailable"
    )


@pytest.mark.parametrize("seam", ["library", "legacy_runbooks", "legacy_playbooks"])
def test_segmented_knowledge_export_never_drops_a_corrupt_procedure_catalog(seam, monkeypatch):
    """An unreadable runbook library or retired procedure catalog fails the scope
    (503), never an export that silently leaves it out (Round 14 seams)."""
    from app.stores.legacy_procedures import LegacyProcedureReader
    from app.stores.runbook_library import RunbookLibraryStore

    async def fail_catalog_read(*_args, **_kwargs):
        raise ValueError("injected damaged operator catalog")

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=Secrets(_env_file=None), es=InMemoryESClient())
        await state.startup(start_poller=False)
        target = {
            "library": (RunbookLibraryStore, "verified_rows"),
            "legacy_runbooks": (LegacyProcedureReader, "list_runbooks_strict"),
            "legacy_playbooks": (LegacyProcedureReader, "list_playbooks_strict"),
        }[seam]
        monkeypatch.setattr(*target, fail_catalog_read)
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(export_router)
    with TestClient(api) as client:
        response = client.post(
            "/api/admin/export/segment",
            json={"scope": "knowledge", "page_size": 1000},
        )

    assert response.status_code == 503
    assert response.json()["detail"] == (
        "the knowledge export scope is temporarily unavailable"
    )


def test_segmented_export_fails_closed_and_releases_pit_when_audit_is_unavailable():
    holder: dict[str, object] = {}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        es = InMemoryESClient()
        state = AppState.create(secrets=Secrets(_env_file=None), es=es)
        await state.startup(start_poller=False)
        for index in range(2):
            await es.index_doc(
                AUDIT_WRITE_ALIAS,
                {"ts": f"2026-08-01T00:00:0{index}Z", "result_summary": f"row-{index}"},
                doc_id=f"audit-failure-{index}",
            )

        async def fail_audit(*_args, **_kwargs):
            raise RuntimeError("injected audit write failure")

        state.control_audit.record_strict = fail_audit  # type: ignore[method-assign]
        holder["es"] = es
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(export_router)
    with TestClient(api) as client:
        response = client.post(
            "/api/admin/export/segment",
            json={"scope": "audit", "page_size": 1},
        )
        assert response.status_code == 503
        assert response.json()["detail"] == (
            "the export audit trail is unavailable; this segment was not delivered"
        )
        assert getattr(holder["es"], "_state_pits") == {}
