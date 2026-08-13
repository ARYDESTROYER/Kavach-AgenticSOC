"""Capability-aware own-state storage lifecycle contracts."""

from __future__ import annotations

from contextlib import asynccontextmanager
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.api.deps import require_auth
from app.api.routes_storage import router
from app.config import Preferences, Secrets, StorageLifecycleConfig
from app.constants import AUDIT_INDEX, CASES_INDEX, CONFIG_INDEX, CURSOR_INDEX, USAGE_INDEX
from app.engine.storage_lifecycle import (
    MANAGED_BASES,
    POLICY_NAME,
    apply_elasticsearch_lifecycle,
    elastic_ilm_policy,
    lifecycle_preview,
    lifecycle_status,
)
from app.es.fake import InMemoryESClient
from app.es.client import RealESClient
from app.llm.providers import MockProvider
from app.state import AppState

asyncio = pytest.mark.asyncio


def test_safe_defaults_and_archive_boundary_are_fixed() -> None:
    config = Preferences().storage_lifecycle
    assert config.enabled is True
    assert config.hot_days == 180
    assert config.warm_days == 90
    assert config.archive_from_days == 270
    assert config.archive_target == "aws_glacier"
    assert config.glacier_storage_class == "GLACIER"
    assert config.delete_after_archive is False
    with pytest.raises(ValueError):
        StorageLifecycleConfig(delete_after_archive=True)


def test_elastic_policy_has_hot_rollover_and_warm_transition_but_no_delete() -> None:
    policy = elastic_ilm_policy(StorageLifecycleConfig())
    phases = policy["policy"]["phases"]
    assert phases["hot"]["actions"]["rollover"] == {
        "max_age": "30d",
        "max_primary_shard_size": "50gb",
    }
    assert phases["warm"]["min_age"] == "180d"
    assert phases["warm"]["actions"]["set_priority"] == {"priority": 50}
    assert "cold" not in phases
    assert "delete" not in phases
    assert policy["policy"]["_meta"]["archive_from_days"] == 270


@asyncio
async def test_real_client_capability_probe_checks_exact_privileges_and_tiers() -> None:
    client = object.__new__(RealESClient)
    client._mgmt = SimpleNamespace(  # type: ignore[attr-defined]
        security=SimpleNamespace(
            has_privileges=AsyncMock(
                return_value={
                    "has_all_requested": True,
                    "cluster": {
                        "manage_ilm": True,
                        "manage_index_templates": True,
                        "monitor": True,
                    },
                }
            )
        ),
        ilm=SimpleNamespace(
            get_status=AsyncMock(return_value={"operation_mode": "RUNNING"})
        ),
        nodes=SimpleNamespace(
            info=AsyncMock(return_value={"nodes": {"n1": {"roles": ["data_hot", "data_warm"]}}})
        ),
    )
    result = await client.index_lifecycle_capabilities()
    assert result["supported"] is True
    assert result["can_manage"] is True
    assert result["privileged"] is True
    assert result["index_privileged"] is True
    assert result["ilm_mode"] == "RUNNING"
    assert result["hot_ready"] is True and result["warm_ready"] is True
    client._mgmt.security.has_privileges.assert_awaited_once_with(  # type: ignore[attr-defined]
        cluster=["manage_ilm", "manage_index_templates", "monitor"],
        index=[
            {
                "names": [f"{AUDIT_INDEX}-*", f"{USAGE_INDEX}-*"],
                "privileges": ["manage"],
            }
        ],
    )


@asyncio
async def test_real_client_capability_probe_reports_missing_template_privilege() -> None:
    client = object.__new__(RealESClient)
    client._mgmt = SimpleNamespace(  # type: ignore[attr-defined]
        security=SimpleNamespace(
            has_privileges=AsyncMock(
                return_value={
                    "has_all_requested": False,
                    "cluster": {
                        "manage_ilm": True,
                        "manage_index_templates": False,
                        "monitor": True,
                    },
                    "index": {
                        f"{AUDIT_INDEX}-*": {"manage": True},
                        f"{USAGE_INDEX}-*": {"manage": True},
                    },
                }
            )
        )
    )
    result = await client.index_lifecycle_capabilities()
    assert result["supported"] is False
    assert result["can_manage"] is False
    assert result["privileged"] is False
    assert "manage_index_templates" in result["reason"]


@asyncio
async def test_real_client_capability_probe_requires_managed_index_privilege() -> None:
    client = object.__new__(RealESClient)
    client._mgmt = SimpleNamespace(  # type: ignore[attr-defined]
        security=SimpleNamespace(
            has_privileges=AsyncMock(
                return_value={
                    "has_all_requested": False,
                    "cluster": {
                        "manage_ilm": True,
                        "manage_index_templates": True,
                        "monitor": True,
                    },
                    "index": {
                        f"{AUDIT_INDEX}-*": {"manage": True},
                        f"{USAGE_INDEX}-*": {"manage": False},
                    },
                }
            )
        )
    )
    result = await client.index_lifecycle_capabilities()
    assert result["supported"] is False
    assert result["can_manage"] is False
    assert result["privileged"] is True
    assert result["index_privileged"] is False
    assert f"manage on {USAGE_INDEX}-*" in result["reason"]


@asyncio
async def test_real_client_can_disable_without_cluster_monitor() -> None:
    client = object.__new__(RealESClient)
    client._mgmt = SimpleNamespace(  # type: ignore[attr-defined]
        security=SimpleNamespace(
            has_privileges=AsyncMock(
                return_value={
                    "has_all_requested": False,
                    "cluster": {
                        "manage_ilm": True,
                        "manage_index_templates": True,
                        "monitor": False,
                    },
                    "index": {
                        f"{AUDIT_INDEX}-*": {"manage": True},
                        f"{USAGE_INDEX}-*": {"manage": True},
                    },
                }
            )
        )
    )
    result = await client.index_lifecycle_capabilities()
    assert result["supported"] is False
    assert result["can_manage"] is True
    assert result["index_privileged"] is True
    assert "cluster monitor" in result["reason"]


@asyncio
async def test_real_client_attachment_probe_is_bounded_to_owned_ledger() -> None:
    client = object.__new__(RealESClient)
    client._mgmt = SimpleNamespace(  # type: ignore[attr-defined]
        indices=SimpleNamespace(
            get_index_template=AsyncMock(
                return_value={
                    "index_templates": [
                        {
                            "name": f"{AUDIT_INDEX}-template",
                            "index_template": {
                                "template": {
                                    "settings": {
                                        "index.lifecycle.name": POLICY_NAME,
                                        "index.lifecycle.rollover_alias": AUDIT_INDEX,
                                    }
                                }
                            },
                        }
                    ]
                }
            ),
            get_settings=AsyncMock(
                return_value={
                    f"{AUDIT_INDEX}-000001": {
                        "settings": {
                            "index.lifecycle.name": POLICY_NAME,
                            "index.lifecycle.rollover_alias": AUDIT_INDEX,
                        }
                    }
                }
            ),
        )
    )

    result = await client.get_owned_index_lifecycle_attachment(AUDIT_INDEX, POLICY_NAME)

    assert result["verified"] is True
    assert result["attached"] is True
    assert result["indices_total"] == 1
    client._mgmt.indices.get_index_template.assert_awaited_once_with(  # type: ignore[attr-defined]
        name=f"{AUDIT_INDEX}-template", flat_settings=True
    )
    client._mgmt.indices.get_settings.assert_awaited_once_with(  # type: ignore[attr-defined]
        index=f"{AUDIT_INDEX}-*",
        name=["index.lifecycle.name", "index.lifecycle.rollover_alias"],
        allow_no_indices=True,
        ignore_unavailable=True,
        expand_wildcards="all",
        flat_settings=True,
    )
    with pytest.raises(ValueError):
        await client.get_owned_index_lifecycle_attachment("all-logs", POLICY_NAME)


@asyncio
async def test_apply_manages_only_append_only_audit_and_usage() -> None:
    es = InMemoryESClient()
    result = await apply_elasticsearch_lifecycle(es, StorageLifecycleConfig())
    assert result["applied"] is True
    assert result["state"] == "active"
    assert result["managed_targets"] == list(MANAGED_BASES)
    assert set(es.index_settings) == {f"{AUDIT_INDEX}-*", f"{USAGE_INDEX}-*"}
    assert POLICY_NAME in es.lifecycle_policies
    for base in MANAGED_BASES:
        settings = es.templates[f"{base}-template"]["template"]["settings"]
        assert settings["index.lifecycle.name"] == POLICY_NAME
        assert settings["index.lifecycle.rollover_alias"] == base
    for excluded in (CASES_INDEX, CONFIG_INDEX, CURSOR_INDEX, "all-logs-*"):
        assert excluded not in es.index_settings
        assert f"{excluded}-template" not in es.templates


@asyncio
async def test_blocked_capability_causes_zero_mutations() -> None:
    es = InMemoryESClient()
    es.lifecycle_capabilities = {
        "supported": False,
        "privileged": False,
        "hot_ready": False,
        "warm_ready": False,
        "roles": [],
        "reason": "manage_ilm unavailable",
    }
    before = deepcopy((es.templates, es.lifecycle_policies, es.index_settings))
    result = await apply_elasticsearch_lifecycle(es, StorageLifecycleConfig())
    assert result["applied"] is False
    assert result["state"] == "blocked"
    assert "manage_ilm" in result["reason"]
    assert (es.templates, es.lifecycle_policies, es.index_settings) == before


@asyncio
async def test_disable_detaches_managed_ledgers_without_deleting_data() -> None:
    es = InMemoryESClient()
    es.docs[f"{AUDIT_INDEX}-000001"] = {"a": {"ts": "2026-01-01T00:00:00Z"}}
    es.docs[f"{USAGE_INDEX}-000001"] = {"u": {"ts": "2026-01-01T00:00:00Z"}}
    es.docs[f"{CASES_INDEX}-000001"] = {"c": {"case_id": "c"}}
    await apply_elasticsearch_lifecycle(es, StorageLifecycleConfig())
    result = await apply_elasticsearch_lifecycle(es, StorageLifecycleConfig(enabled=False))
    assert result["state"] == "disabled"
    assert POLICY_NAME not in es.lifecycle_policies
    assert es.index_settings == {}
    assert set(es.docs) == {
        f"{AUDIT_INDEX}-000001",
        f"{USAGE_INDEX}-000001",
        f"{CASES_INDEX}-000001",
    }
    assert "index.lifecycle.name" not in (
        es.templates[f"{AUDIT_INDEX}-template"]["template"]["settings"]
    )
    assert f"{CASES_INDEX}-template" not in es.templates


@asyncio
async def test_disable_remains_available_when_warm_tier_is_degraded() -> None:
    es = InMemoryESClient()
    await apply_elasticsearch_lifecycle(es, StorageLifecycleConfig())
    es.lifecycle_capabilities = {
        "supported": False,
        "can_manage": True,
        "privileged": True,
        "index_privileged": True,
        "hot_ready": True,
        "warm_ready": False,
        "roles": ["data_hot"],
        "ilm_mode": "RUNNING",
        "reason": "The cluster needs both Hot and Warm-capable data roles.",
    }

    result = await apply_elasticsearch_lifecycle(
        es, StorageLifecycleConfig(enabled=False)
    )

    assert result["applied"] is True
    assert result["state"] == "disabled"
    assert POLICY_NAME not in es.lifecycle_policies
    assert es.index_settings == {}
    status = await lifecycle_status(
        state_backend="elasticsearch",
        config=StorageLifecycleConfig(enabled=False),
        es=es,
    )
    assert status["effective_state"] == "disabled"
    assert status["targets"][0]["enforcement"] == "hot_only"


@asyncio
async def test_disable_preview_uses_management_readiness_not_warm_readiness() -> None:
    es = InMemoryESClient()
    es.lifecycle_capabilities = {
        "supported": False,
        "can_manage": True,
        "privileged": True,
        "index_privileged": True,
        "hot_ready": True,
        "warm_ready": False,
        "roles": ["data_hot"],
        "ilm_mode": "RUNNING",
        "reason": "The cluster needs both Hot and Warm-capable data roles.",
    }

    result = await lifecycle_preview(
        state_backend="elasticsearch",
        config=StorageLifecycleConfig(enabled=False),
        es=es,
    )

    assert result["preview"]["can_apply"] is True
    assert {action["action"] for action in result["preview"]["actions"]} == {
        "detach_lifecycle",
        "delete_ilm_policy",
    }


@asyncio
async def test_status_truthfully_distinguishes_backends_and_drift() -> None:
    config = StorageLifecycleConfig()
    es = InMemoryESClient()

    pending = await lifecycle_status(state_backend="elasticsearch", config=config, es=es)
    assert pending["effective_state"] == "not_configured"
    assert pending["targets"][0]["enforcement"] == "not_configured"
    assert pending["targets"][2]["enforcement"] == "hot_only"
    assert pending["targets"][-1]["enforcement"] == "external"

    await apply_elasticsearch_lifecycle(es, config)
    active = await lifecycle_status(state_backend="elasticsearch", config=config, es=es)
    assert active["effective_state"] == "active"
    assert active["targets"][0]["enforcement"] == "managed"

    drifted_config = StorageLifecycleConfig(hot_days=200)
    drifted = await lifecycle_status(
        state_backend="elasticsearch", config=drifted_config, es=es
    )
    assert drifted["effective_state"] == "drifted"

    postgres = await lifecycle_status(state_backend="postgres", config=config, es=None)
    assert postgres["effective_state"] == "advisory"
    assert postgres["targets"][0]["enforcement"] == "advisory"

    sqlite = await lifecycle_status(state_backend="sqlite", config=config, es=None)
    assert sqlite["effective_state"] == "advisory"
    assert sqlite["targets"][0]["enforcement"] == "export_only"

    memory = await lifecycle_status(state_backend="memory", config=config, es=None)
    assert memory["effective_state"] == "unsupported"
    assert memory["targets"][0]["enforcement"] == "unsupported"


@asyncio
async def test_status_detects_partial_existing_index_attachment_drift() -> None:
    es = InMemoryESClient()
    es.docs[f"{AUDIT_INDEX}-000001"] = {}
    es.docs[f"{USAGE_INDEX}-000001"] = {}
    config = StorageLifecycleConfig()
    await apply_elasticsearch_lifecycle(es, config)
    assert (
        await lifecycle_status(state_backend="elasticsearch", config=config, es=es)
    )["effective_state"] == "active"

    es.index_settings.pop(f"{USAGE_INDEX}-*")
    status = await lifecycle_status(
        state_backend="elasticsearch", config=config, es=es
    )

    assert status["effective_state"] == "drifted"
    assert status["targets"][1]["enforcement"] == "drifted"
    assert status["attachments"][AUDIT_INDEX]["attached"] is True
    assert status["attachments"][USAGE_INDEX]["attached"] is False


@asyncio
async def test_preview_is_read_only_and_excludes_unsafe_targets() -> None:
    es = InMemoryESClient()
    before = deepcopy((es.templates, es.lifecycle_policies, es.index_settings, es.docs))
    result = await lifecycle_preview(
        state_backend="elasticsearch", config=StorageLifecycleConfig(), es=es
    )
    assert result["preview"]["mutates"] is False
    assert result["preview"]["can_apply"] is True
    assert {a["target"] for a in result["preview"]["actions"]} == {
        POLICY_NAME,
        AUDIT_INDEX,
        USAGE_INDEX,
    }
    assert "mutable cases" in result["preview"]["excluded"]
    assert (es.templates, es.lifecycle_policies, es.index_settings, es.docs) == before


@pytest.fixture
def lifecycle_client():
    overrides = {
        "anthropic": MockProvider(),
        "openai": MockProvider(),
        "mock": MockProvider(),
    }

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        secrets = Secrets(
            _env_file=None,
            es_store_enabled=False,
            state_backend="elasticsearch",
            redis_url="",
            anthropic_api_key=None,
            openai_api_key=None,
        )
        es = InMemoryESClient()
        # Exercise the Elasticsearch route path with a deterministic fake while the
        # production route still reports ordinary in-memory fallback as unsupported.
        es.storage_lifecycle_backend = "elasticsearch"
        state = AppState.create(
            secrets=secrets,
            es=es,
            provider_overrides=overrides,
        )
        await state.startup(start_poller=False)
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(router, dependencies=[Depends(require_auth)])
    with TestClient(api) as client:
        yield client


def test_storage_routes_save_preview_and_require_durable_apply_job(lifecycle_client: TestClient) -> None:
    initial = lifecycle_client.get("/api/storage/lifecycle")
    assert initial.status_code == 200, initial.text
    assert initial.json()["policy"]["hot_days"] == 180

    candidate = {
        "enabled": True,
        "hot_days": 200,
        "warm_days": 60,
        "archive_target": "aws_glacier",
        "glacier_storage_class": "DEEP_ARCHIVE",
        "delete_after_archive": False,
    }
    preview = lifecycle_client.post("/api/storage/lifecycle/preview", json=candidate)
    assert preview.status_code == 200, preview.text
    assert preview.json()["policy"]["archive_from_days"] == 260
    assert preview.json()["preview"]["mutates"] is False

    saved = lifecycle_client.put("/api/storage/lifecycle", json=candidate)
    assert saved.status_code == 200, saved.text
    assert saved.json()["policy"]["hot_days"] == 200
    assert saved.json()["effective_state"] == "not_configured"

    applied = lifecycle_client.post("/api/storage/lifecycle/apply")
    assert applied.status_code == 410, applied.text
    assert applied.json()["detail"]["code"] == "durable_job_required"

    persisted = lifecycle_client.get("/api/storage/lifecycle").json()
    assert persisted["policy"]["glacier_storage_class"] == "DEEP_ARCHIVE"
    assert persisted["effective_state"] == "not_configured"
