"""Public upstream release discovery: validation, cache, failure, API and RBAC seams."""

from __future__ import annotations

import base64
from contextlib import asynccontextmanager
from urllib.parse import parse_qs, unquote, urlsplit

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.api.deps import require_auth
from app.api.routes import router as base_router
from app.api.routes_releases import router as releases_router
from app.config import Preferences, ReleaseUpdateConfig, Secrets
from app.engine.release_discovery import ReleaseDiscoveryService
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.state import AppState

_SHA_STABLE = "a" * 40
_SHA_TESTING = "b" * 40
_SHA_TAG_OBJECT = "c" * 40
_SHA_STABLE_RELEASE = "d" * 40


def _config(**updates) -> ReleaseUpdateConfig:
    return ReleaseUpdateConfig(**updates)


def test_release_update_defaults_are_public_and_channel_specific() -> None:
    config = Preferences().release_updates
    assert config.enabled is True
    assert config.repository_url == "https://github.com/ARYDESTROYER/Kavach-AgenticSOC"
    assert config.stable_branch == "main"
    assert config.testing_branch == "Testing"
    assert config.check_interval_minutes == 360


@pytest.mark.parametrize(
    "raw,expected",
    [
        (
            "https://github.com/ARYDESTROYER/Kavach-AgenticSOC.git/",
            "https://github.com/ARYDESTROYER/Kavach-AgenticSOC",
        ),
        (
            "  https://github.com/owner/repository  ",
            "https://github.com/owner/repository",
        ),
    ],
)
def test_repository_url_is_canonicalised(raw: str, expected: str) -> None:
    assert _config(repository_url=raw).repository_url == expected


@pytest.mark.parametrize(
    "stored",
    [
        "https://github.com/ARYDESTROYER/Agentic-Kibana",
        "https://github.com/arydestroyer/Agentic-Kibana.git/",
        "https://github.com/ARYDESTROYER/agentic-kibana.git",
        "https://github.com/aryDestroyer/AGENTIC-KIBANA/",
    ],
)
def test_a_stored_former_repository_moves_to_the_current_one(stored: str) -> None:
    """GitHub redirects the former API path, and discovery refuses redirects, so a
    stored former name would hide every release (the repository was renamed)."""
    assert _config(repository_url=stored).repository_url == (
        "https://github.com/ARYDESTROYER/Kavach-AgenticSOC"
    )
    prefs = Preferences.model_validate({"release_updates": {"repository_url": stored}})
    assert prefs.release_updates.repository_url == (
        "https://github.com/ARYDESTROYER/Kavach-AgenticSOC"
    )


@pytest.mark.parametrize(
    "kept",
    [
        "https://github.com/example-org/Agentic-Kibana",
        "https://github.com/ARYDESTROYER/Agentic-Kibana-fork",
        "https://github.com/example-org/Kavach-AgenticSOC",
    ],
)
def test_any_other_repository_is_kept(kept: str) -> None:
    assert _config(repository_url=kept).repository_url == kept


@pytest.mark.parametrize(
    "url",
    [
        "http://github.com/owner/repo",
        "https://github.example/owner/repo",
        "https://api.github.com/owner/repo",
        "https://github.com:443/owner/repo",
        "https://user@github.com/owner/repo",
        "https://github.com/owner/repo/extra",
        "https://github.com/owner/repo?ref=main",
        "https://github.com/owner/repo#main",
        "https://github.com:invalid/owner/repo",
        "https://github.com/.hidden/repo",
    ],
)
def test_repository_url_rejects_non_public_or_ambiguous_targets(url: str) -> None:
    with pytest.raises(ValidationError):
        _config(repository_url=url)


@pytest.mark.parametrize(
    "branch",
    ["", "../main", "main..next", "refs//heads/main", "main@{1}", ".hidden", "x.lock", "a" * 129],
)
def test_branch_validation_rejects_ambiguous_git_refs(branch: str) -> None:
    with pytest.raises(ValidationError):
        _config(testing_branch=branch)


def test_branch_validation_allows_bounded_release_paths() -> None:
    assert _config(testing_branch="release/v0.1.1").testing_branch == "release/v0.1.1"


def _fake_github(*, fail_branch: str | None = None, version: str = "v0.1.2"):
    calls: list[str] = []

    async def fetch(url: str) -> dict:
        calls.append(url)
        parsed = urlsplit(url)
        assert parsed.scheme == "https"
        assert parsed.netloc == "api.github.com"
        if "/git/ref/heads/" in parsed.path:
            branch = unquote(parsed.path.rsplit("/", 1)[-1])
            if branch == fail_branch:
                raise RuntimeError("synthetic failure")
            return {
                "object": {"sha": _SHA_STABLE if branch == "main" else _SHA_TESTING}
            }
        if "/git/ref/tags/" in parsed.path:
            return {"object": {"type": "tag", "sha": _SHA_TAG_OBJECT}}
        if "/git/tags/" in parsed.path:
            return {
                "object": {"type": "commit", "sha": _SHA_STABLE_RELEASE}
            }
        assert parsed.path.endswith("/contents/VERSION")
        branch = parse_qs(parsed.query)["ref"][0]
        if branch == fail_branch:
            raise RuntimeError("synthetic failure")
        return {
            "encoding": "base64",
            "content": base64.b64encode((version + "\n").encode("ascii")).decode("ascii"),
        }

    return calls, fetch


@pytest.mark.asyncio
async def test_discovery_returns_both_channels_and_uses_ttl_cache() -> None:
    service = ReleaseDiscoveryService()
    calls, fetch = _fake_github()
    service._fetch_json = fetch  # type: ignore[method-assign]

    first = await service.discover(_config())
    assert first.cache.hit is False
    assert first.cache.stale is False
    assert first.cache.max_age_seconds == 21_600
    assert first.channels["stable"].model_dump() == {
        "channel": "stable",
        "branch": "main",
        "state": "available",
        "version": "0.1.2",
        "commit_sha": _SHA_STABLE,
        "commit_url": (
            "https://github.com/ARYDESTROYER/Kavach-AgenticSOC/commit/" + _SHA_STABLE
        ),
        "release_commit_sha": _SHA_STABLE_RELEASE,
        "release_commit_url": (
            "https://github.com/ARYDESTROYER/Kavach-AgenticSOC/commit/"
            + _SHA_STABLE_RELEASE
        ),
        "source_url": "https://github.com/ARYDESTROYER/Kavach-AgenticSOC/tree/main",
        "checked_at": first.checked_at,
        "stale": False,
        "error_code": None,
        "error_message": None,
    }
    assert first.channels["testing"].branch == "Testing"
    assert first.channels["testing"].commit_sha == _SHA_TESTING
    assert len(calls) == 6

    second = await service.discover(_config())
    assert second.cache.hit is True
    assert len(calls) == 6
    # A manual click cannot hammer GitHub inside the five-minute floor.
    manual = await service.discover(_config(), force=True)
    assert manual.cache.hit is True
    assert len(calls) == 6


@pytest.mark.asyncio
async def test_one_failed_channel_never_hides_the_other() -> None:
    service = ReleaseDiscoveryService()
    _, fetch = _fake_github(fail_branch="main")
    service._fetch_json = fetch  # type: ignore[method-assign]

    result = await service.discover(_config())
    assert result.channels["stable"].state == "unavailable"
    assert result.channels["stable"].error_code == "unexpected_error"
    assert result.channels["stable"].version is None
    assert result.channels["testing"].state == "available"
    assert result.channels["testing"].version == "0.1.2"


@pytest.mark.asyncio
async def test_failed_refresh_keeps_last_verified_metadata_and_marks_it_stale() -> None:
    service = ReleaseDiscoveryService()
    _, fetch = _fake_github()
    service._fetch_json = fetch  # type: ignore[method-assign]
    config = _config()
    first = await service.discover(config)
    assert first.channels["stable"].state == "available"

    async def down(_url: str) -> dict:
        raise RuntimeError("synthetic outage")

    service._fetch_json = down  # type: ignore[method-assign]
    key = service._cache_key(config)
    service._cache[key].fetched_monotonic -= 301
    refreshed = await service.discover(config, force=True)
    assert refreshed.cache.hit is False
    assert refreshed.cache.stale is True
    for channel in ("stable", "testing"):
        status = refreshed.channels[channel]
        assert status.state == "available"
        assert status.stale is True
        assert status.error_code == "unexpected_error"
        assert status.error_message == (
            "Latest GitHub check failed; showing the last verified metadata."
        )


@pytest.mark.asyncio
async def test_disabled_discovery_never_calls_github() -> None:
    service = ReleaseDiscoveryService()

    async def should_not_run(_url: str) -> dict:  # pragma: no cover - assertion path
        raise AssertionError("disabled discovery made a network request")

    service._fetch_json = should_not_run  # type: ignore[method-assign]
    result = await service.discover(_config(enabled=False))
    assert result.enabled is False
    assert result.checked_at is None
    assert result.channels["stable"].state == "disabled"
    assert result.channels["testing"].state == "disabled"


def _release_app(*, auth_enabled: bool = False) -> FastAPI:
    secrets = Secrets(
        _env_file=None,
        es_store_enabled=False,
        redis_url="",
        anthropic_api_key=None,
        openai_api_key=None,
        auth_enabled=auth_enabled,
        auth_jwt_secret="release-discovery-test-secret",
        auth_seed_admin=True,
    )
    mock = MockProvider()
    overrides = {"anthropic": mock, "openai": mock, "mock": mock}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(
            secrets=secrets,
            es=InMemoryESClient(),
            provider_overrides=overrides,
        )
        await state.startup(start_poller=False)
        prefs = state.prefs.model_copy(update={"setup_complete": True})
        if auth_enabled:
            prefs = prefs.model_copy(
                update={"rbac": prefs.rbac.model_copy(update={"enabled": True})}
            )
        await state.update_prefs(prefs)
        _, fetch = _fake_github()
        state.release_discovery._fetch_json = fetch  # type: ignore[method-assign]
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(base_router, dependencies=[Depends(require_auth)])
    api.include_router(releases_router, dependencies=[Depends(require_auth)])
    return api


def test_release_discovery_api_contract_and_manual_check() -> None:
    with TestClient(_release_app()) as client:
        first = client.get("/api/releases/upstream")
        assert first.status_code == 200, first.text
        body = first.json()
        assert set(body) == {"enabled", "repository_url", "checked_at", "cache", "channels"}
        assert set(body["channels"]) == {"stable", "testing"}
        assert body["channels"]["stable"]["state"] == "available"
        manual = client.post("/api/releases/upstream/check")
        assert manual.status_code == 200, manual.text
        assert manual.json()["cache"]["hit"] is True


def test_release_discovery_is_authenticated_when_auth_is_enabled() -> None:
    with TestClient(_release_app(auth_enabled=True)) as client:
        assert client.get("/api/releases/upstream").status_code == 401
        assert client.post("/api/releases/upstream/check").status_code == 401
        login = client.post(
            "/api/auth/login",
            json={"username": "Admin", "password": "Admin@123"},
        )
        assert login.status_code == 200, login.text
        assert client.get("/api/releases/upstream").status_code == 200
        assert client.post("/api/releases/upstream/check").status_code == 200
