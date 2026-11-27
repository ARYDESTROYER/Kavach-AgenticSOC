"""Round 15 SPEC D2.1 and D2.2: whether the AI agent can call the default models.

``llm.readiness.ai_runtime_status`` is true only when both the router and the
investigator (``Preferences.model_for``) can reach their provider with the credentials
the process holds: a key for OpenAI and Anthropic, a key or a resolvable base URL for an
OpenAI-compatible endpoint, a key and an endpoint for Azure OpenAI, the key pair for
Amazon Bedrock, the token and project for Google Vertex AI, and the mock runtime only in
Demo Mode. The public ``GET /api/setup/status`` carries the boolean only; the
authenticated ``POST /api/setup/secrets`` answer adds the provider family. Offline.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.config import ModelConfig, Preferences, Secrets
from app.llm.readiness import (
    PROVIDER_TOKENS,
    ai_runtime_status,
    provider_token,
    resolved_base_url,
    role_ready,
)

_PROVIDER_FIELDS = (
    "openai_api_key", "anthropic_api_key", "litellm_api_key", "azure_openai_api_key",
    "azure_openai_endpoint", "aws_access_key_id", "aws_secret_access_key",
    "vertex_api_key", "vertex_project", "embedding_api_key",
)


def _secrets(**values: Any) -> Secrets:
    """Secrets with every provider credential unset unless given (no developer .env,
    no environment variable leaks into the answer)."""
    base: dict[str, Any] = {name: None for name in _PROVIDER_FIELDS}
    base.update(values)
    return Secrets(_env_file=None, es_store_enabled=False, redis_url="", **base)


def _prefs(router: ModelConfig | None = None, investigator: ModelConfig | None = None) -> Preferences:
    prefs = Preferences()
    update: dict[str, Any] = {}
    if router is not None:
        update["router_model"] = router
    if investigator is not None:
        update["investigator_model"] = investigator
    return prefs.model_copy(update=update) if update else prefs


def _both(provider: str, model: str = "m", **cfg: Any) -> Preferences:
    model_cfg = ModelConfig(provider=provider, model=model, **cfg)
    return _prefs(model_cfg, model_cfg)


# --------------------------------------------------------------------------- #
# The pure helper, per provider
# --------------------------------------------------------------------------- #
def test_the_fresh_defaults_need_the_openai_key():
    prefs = Preferences()
    assert prefs.investigator_model.provider == "openai"
    assert ai_runtime_status(_secrets(), prefs) == {"ready": False, "provider": "openai"}
    assert ai_runtime_status(_secrets(openai_api_key="sk-test"), prefs) == {
        "ready": True, "provider": "openai",
    }


def test_an_anthropic_key_alone_does_not_make_the_default_models_ready():
    """The reported bug: an Anthropic-only workspace read "Ready for live triage"."""
    status = ai_runtime_status(_secrets(anthropic_api_key="sk-ant"), Preferences())
    assert status == {"ready": False, "provider": "openai"}


def test_anthropic_models_need_the_anthropic_key():
    prefs = _both("anthropic", "claude-x")
    assert not ai_runtime_status(_secrets(openai_api_key="sk-test"), prefs)["ready"]
    assert ai_runtime_status(_secrets(anthropic_api_key="sk-ant"), prefs) == {
        "ready": True, "provider": "anthropic",
    }


@pytest.mark.parametrize("key", ["litellm_api_key", "openai_api_key"])
def test_an_openai_compatible_endpoint_is_ready_with_either_key(key):
    prefs = _both("openai_compatible", "my-model")
    assert ai_runtime_status(_secrets(), prefs) == {"ready": False, "provider": "openai_compatible"}
    assert ai_runtime_status(_secrets(**{key: "k"}), prefs)["ready"] is True


def test_a_keyless_openai_compatible_endpoint_is_ready_from_its_own_base_url():
    prefs = _both("openai_compatible", "my-model", base_url="http://llm.internal:4000/v1")
    assert ai_runtime_status(_secrets(), prefs)["ready"] is True


def test_a_keyless_openai_compatible_endpoint_is_ready_from_the_registry_base_url():
    cfg = ModelConfig(provider="openai_compatible", model="local-llama-3.1-8b")
    assert resolved_base_url(cfg) == "http://localhost:8000/v1"
    assert ai_runtime_status(_secrets(), _prefs(cfg, cfg))["ready"] is True


def test_a_keyless_openai_compatible_endpoint_is_ready_from_a_custom_model():
    prefs = _both("openai_compatible", "team-llm")
    custom = {"team-llm": {"base_url": "http://team-llm:8080/v1", "provider": "openai_compatible"}}
    assert ai_runtime_status(_secrets(), prefs)["ready"] is False
    assert ai_runtime_status(_secrets(), prefs, custom)["ready"] is True
    # An empty or malformed row resolves nothing.
    assert ai_runtime_status(_secrets(), prefs, {"team-llm": {"base_url": "  "}})["ready"] is False
    assert ai_runtime_status(_secrets(), prefs, {"team-llm": "http://x"})["ready"] is False


def test_azure_needs_a_key_and_an_endpoint():
    prefs = _both("azure", "my-deployment")
    assert not role_ready(_secrets(azure_openai_api_key="k"), prefs.investigator_model)
    assert not role_ready(_secrets(azure_openai_endpoint="https://r.openai.azure.com"), prefs.investigator_model)
    assert role_ready(
        _secrets(azure_openai_api_key="k", azure_openai_endpoint="https://r.openai.azure.com"),
        prefs.investigator_model,
    )
    # The OpenAI key stands in for the Azure key, as in the gateway.
    assert role_ready(
        _secrets(openai_api_key="k", azure_openai_endpoint="https://r.openai.azure.com"),
        prefs.investigator_model,
    )
    # The role's own base URL is an endpoint too.
    with_url = ModelConfig(provider="azure", model="d", base_url="https://r.openai.azure.com")
    assert role_ready(_secrets(azure_openai_api_key="k"), with_url)


def test_bedrock_needs_the_access_key_pair():
    cfg = ModelConfig(provider="bedrock", model="anthropic.claude-3-5-sonnet-20241022-v2:0")
    assert not role_ready(_secrets(aws_access_key_id="AKIA"), cfg)
    assert not role_ready(_secrets(aws_secret_access_key="s"), cfg)
    assert role_ready(_secrets(aws_access_key_id="AKIA", aws_secret_access_key="s"), cfg)


def test_vertex_needs_the_token_and_the_project():
    cfg = ModelConfig(provider="vertex", model="gemini-1.5-pro")
    assert not role_ready(_secrets(vertex_api_key="ya29"), cfg)
    assert not role_ready(_secrets(vertex_project="proj"), cfg)
    assert role_ready(_secrets(vertex_api_key="ya29", vertex_project="proj"), cfg)


def test_the_mock_runtime_is_ready_only_in_demo_mode():
    prefs = _both("mock", "mock")
    assert ai_runtime_status(_secrets(openai_api_key="k"), prefs) == {"ready": False, "provider": "mock"}
    assert ai_runtime_status(_secrets(), prefs, demo=True) == {"ready": True, "provider": "mock"}


def test_both_roles_must_be_callable_and_the_answer_names_the_missing_one():
    openai = ModelConfig(provider="openai", model="gpt")
    anthropic = ModelConfig(provider="anthropic", model="claude")
    # Investigator callable, router not: the router's provider is named.
    prefs = _prefs(router=anthropic, investigator=openai)
    assert ai_runtime_status(_secrets(openai_api_key="k"), prefs) == {
        "ready": False, "provider": "anthropic",
    }
    # Investigator not callable: it is named first.
    assert ai_runtime_status(_secrets(anthropic_api_key="k"), prefs) == {
        "ready": False, "provider": "openai",
    }
    assert ai_runtime_status(_secrets(openai_api_key="k", anthropic_api_key="k"), prefs) == {
        "ready": True, "provider": "openai",
    }


def test_blank_credentials_count_as_missing():
    assert not ai_runtime_status(_secrets(openai_api_key="   "), Preferences())["ready"]


def test_the_provider_vocabulary_is_closed():
    assert PROVIDER_TOKENS == (
        "openai", "anthropic", "openai_compatible", "azure", "bedrock", "vertex", "mock",
    )
    odd = ModelConfig.model_construct(provider="something-else", model="x")
    assert provider_token(odd) == "mock"


def test_the_helper_never_returns_a_secret_value():
    secret = "sk-never-shown-0123456789"
    status = ai_runtime_status(_secrets(openai_api_key=secret), Preferences())
    assert secret not in repr(status)


# --------------------------------------------------------------------------- #
# The setup routes
# --------------------------------------------------------------------------- #
def test_the_public_setup_status_carries_the_boolean_only(client):
    body = client.get("/api/setup/status").json()
    assert body["ai_runtime_ready"] is False
    assert "ai_runtime_provider" not in body


def test_the_setup_secrets_answer_carries_readiness_and_the_provider(client):
    saved = client.post("/api/setup/secrets", json={"anthropic_api_key": "sk-ant-test"})
    assert saved.status_code == 200, saved.text
    body = saved.json()
    assert body["configured"]["anthropic_api_key"] is True
    # The default models are OpenAI: an Anthropic key does not make them callable.
    assert body["ai_runtime_ready"] is False
    assert body["ai_runtime_provider"] == "openai"
    assert client.get("/api/setup/status").json()["ai_runtime_ready"] is False

    saved = client.post("/api/setup/secrets", json={"openai_api_key": "sk-openai-test"})
    body = saved.json()
    assert body["ai_runtime_ready"] is True
    assert body["ai_runtime_provider"] == "openai"
    assert client.get("/api/setup/status").json()["ai_runtime_ready"] is True
    assert "sk-openai-test" not in saved.text


def test_a_readiness_failure_never_fails_the_status_read(client, monkeypatch):
    from app.llm import readiness

    async def broken(_state: Any) -> Any:
        raise RuntimeError("boom")

    monkeypatch.setattr(readiness, "ai_runtime_status_for", broken)
    status = client.get("/api/setup/status")
    assert status.status_code == 200
    assert status.json()["ai_runtime_ready"] is False
    saved = client.post("/api/setup/secrets", json={"openai_api_key": "sk-x"})
    assert saved.status_code == 200
    assert saved.json()["ai_runtime_ready"] is False
    assert saved.json()["ai_runtime_provider"] == "mock"
