"""Shared test fixtures: an in-process AppState with a fake ES and mock LLM.

This module also installs an **autouse network guard** (see ``_no_outbound_network``)
so the offline suite can never make a real outbound connection. That matters now that
several keyless enrichment providers (Shodan InternetDB / IPinfo / abuse.ch / RDAP)
default ON: a test that constructs a real ``EnrichTool`` against a *public* IP would
otherwise fan out live HTTP/DNS calls that fail-open only after a multi-second timeout
— slow and flaky in CI. The guard blocks any connect/resolve to a non-loopback address
and turns it into an immediate, deterministic error (which the enrichment layer already
fails open on). A test that genuinely needs the network can opt out with
``@pytest.mark.allow_network``.
"""

from __future__ import annotations

import socket

import pytest
import pytest_asyncio

from app.config import Preferences, Secrets
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.state import AppState
from app.utils import iso_now, to_millis, now_utc


# --------------------------------------------------------------------------- #
# Offline network guard — deterministic, fast, opt-out-able.
# --------------------------------------------------------------------------- #
class _BlockedNetworkError(OSError):
    """Raised when the offline test suite attempts a real outbound connection.

    Subclasses :class:`OSError` so it is caught by the same fail-open paths that
    already handle connection refusals/timeouts (httpx, ``socket.gethostbyname``,
    enrichment dispatch), keeping behaviour deterministic without special-casing."""


def _host_of(address: object) -> str | None:
    """Best-effort extract the host string from a ``connect`` / ``create_connection``
    address argument. AF_INET/AF_INET6 use ``(host, port[, ...])``; anything else
    (AF_UNIX path, fd, unknown) returns ``None`` so it is allowed through."""
    if isinstance(address, (tuple, list)) and address:
        host = address[0]
        return host if isinstance(host, str) else None
    return None


def _is_loopback(host: str | None) -> bool:
    """True for loopback / unspecified / in-process addresses we must never block.

    ``None`` (AF_UNIX / unknown) and empty host are treated as local. We do a cheap
    string check first (no DNS) and only fall back to ``ipaddress`` for the rest, so
    the guard itself never triggers a lookup."""
    if host is None or host == "":
        return True
    if host in ("localhost", "127.0.0.1", "::1", "0.0.0.0", "::"):
        return True
    if host.startswith("127."):
        return True
    try:
        import ipaddress

        ip = ipaddress.ip_address(host)
        return ip.is_loopback or ip.is_unspecified
    except ValueError:
        # A hostname (not a literal IP) other than localhost: treat as outbound.
        return False


@pytest.fixture(autouse=True)
def _no_outbound_network(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch):
    """Autouse: block real outbound network for the offline suite.

    Patches the low-level ``socket`` connect + DNS-resolution entry points so any
    attempt to reach a non-loopback host raises :class:`_BlockedNetworkError`
    (an ``OSError``) *immediately* — no multi-second timeout, no real packets. The
    in-process surfaces the suite actually uses stay untouched:

      * FastAPI ``TestClient`` talks to the app over an in-memory ASGI transport
        (no socket);
      * the fake ES client + in-memory cache (``redis_url=""``) are pure-Python;
      * loopback is explicitly allowed.

    Tests that genuinely need the network opt out with ``@pytest.mark.allow_network``.
    Higher-level enrichment tests that already mock the HTTP/DNS layer never reach
    these patches at all, so they are unaffected."""
    if request.node.get_closest_marker("allow_network") is not None:
        return

    real_connect = socket.socket.connect
    real_connect_ex = socket.socket.connect_ex
    real_create_connection = socket.create_connection
    real_getaddrinfo = socket.getaddrinfo
    real_gethostbyname = socket.gethostbyname

    def _guard_host(host: str | None, what: str) -> None:
        if not _is_loopback(host):
            raise _BlockedNetworkError(
                f"Blocked outbound network in offline test ({what} -> {host!r}). "
                "Mock the HTTP/DNS layer, or mark the test @pytest.mark.allow_network."
            )

    def _connect(self, address, *args, **kwargs):
        _guard_host(_host_of(address), "socket.connect")
        return real_connect(self, address, *args, **kwargs)

    def _connect_ex(self, address, *args, **kwargs):
        _guard_host(_host_of(address), "socket.connect_ex")
        return real_connect_ex(self, address, *args, **kwargs)

    def _create_connection(address, *args, **kwargs):
        _guard_host(_host_of(address), "socket.create_connection")
        return real_create_connection(address, *args, **kwargs)

    def _getaddrinfo(host, *args, **kwargs):
        _guard_host(host if isinstance(host, str) else None, "socket.getaddrinfo")
        return real_getaddrinfo(host, *args, **kwargs)

    def _gethostbyname(host, *args, **kwargs):
        _guard_host(host if isinstance(host, str) else None, "socket.gethostbyname")
        return real_gethostbyname(host, *args, **kwargs)

    monkeypatch.setattr(socket.socket, "connect", _connect)
    monkeypatch.setattr(socket.socket, "connect_ex", _connect_ex)
    monkeypatch.setattr(socket, "create_connection", _create_connection)
    monkeypatch.setattr(socket, "getaddrinfo", _getaddrinfo)
    monkeypatch.setattr(socket, "gethostbyname", _gethostbyname)


@pytest.fixture(autouse=True)
def _reset_case_page_cache():
    """Autouse: clear the shared short-TTL case-page cache between tests.

    The cache is already self-invalidating (entries are guarded by store-object
    identity + a fetch-limit key), but clearing it keeps every test hermetic no
    matter how fixtures compose or how fast the suite runs."""
    from app.api import metrics_shared

    metrics_shared.invalidate_case_page_cache()
    yield
    metrics_shared.invalidate_case_page_cache()


def pytest_configure(config: pytest.Config) -> None:
    """Register the ``allow_network`` opt-out marker (``--strict-markers`` is on)."""
    config.addinivalue_line(
        "markers",
        "allow_network: opt this test out of the autouse offline network guard "
        "(it may make real outbound connections).",
    )


@pytest.fixture
def mock_provider() -> MockProvider:
    return MockProvider()


@pytest.fixture
def secrets() -> Secrets:
    # _env_file=None so tests never pick up a developer .env.
    return Secrets(
        _env_file=None,
        es_store_enabled=False,
        redis_url="",  # Cache falls back to in-memory
        anthropic_api_key=None,
        openai_api_key=None,
    )


@pytest_asyncio.fixture
async def app_state(secrets: Secrets, mock_provider: MockProvider):
    es = InMemoryESClient()
    overrides = {"anthropic": mock_provider, "openai": mock_provider, "mock": mock_provider}
    state = AppState.create(secrets=secrets, es=es, provider_overrides=overrides)
    await state.startup(start_poller=False)
    # Make the suite "set up" so poll/settings behave as in production.
    prefs = state.prefs.model_copy(update={"setup_complete": True})
    await state.update_prefs(prefs)
    yield state
    await state.shutdown()


def make_log_event(
    *,
    ip: str = "203.0.113.10",
    user: str = "root",
    host: str = "web01",
    rule: str = "linux_auth",
    severity: float = 7.0,
    ts_millis: int | None = None,
    action: str = "login",
    outcome: str = "failure",
) -> dict:
    """Build an ECS-ish log _source document matching default field mappings."""
    ts = ts_millis if ts_millis is not None else to_millis(now_utc())
    from datetime import datetime, timezone

    iso = datetime.fromtimestamp(ts / 1000.0, tz=timezone.utc).isoformat()
    return {
        "@timestamp": iso,
        "source": {"ip": ip},
        "user": {"name": user},
        "host": {"name": host},
        "event": {"module": rule, "action": action, "outcome": outcome, "severity": severity},
        "rule": {"name": rule},
        "message": f"{rule} {action} {outcome} from {ip} user {user}",
    }


def mount_moved_routers(api, *, dependencies=None) -> None:
    """Mount the feature routers that hold routes carved OUT of the ``routes.py``
    monolith in Round 5 (Coupling-E) so a locally-built test app matches production.

    Paths/methods/auth are byte-identical to the monolith they came from; a test that
    builds its own ``FastAPI`` app and exercises a MOVED route (branding / prefs /
    saved views / terminology / rag / memory / search / audit / notifications) must
    include these so the route resolves exactly as it does under ``app.main.app``.
    Pass ``dependencies`` to mirror the production ``require_auth`` mount when the test
    turns auth on.
    """
    from app.api.routes_notifications import router as notifications_router
    from app.api.routes_prefs import router as prefs_router
    from app.api.routes_rag import router as rag_router
    from app.api.routes_search import router as search_router
    from app.api.routes_runbooks import router as runbooks_router

    kwargs = {"dependencies": dependencies} if dependencies else {}
    for _r in (
        prefs_router,
        rag_router,
        search_router,
        notifications_router,
        runbooks_router,
    ):
        api.include_router(_r, **kwargs)


@pytest.fixture
def client(secrets, mock_provider):
    """A TestClient over the full app with a fake ES + mock LLM (own event loop)."""
    from contextlib import asynccontextmanager

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.api.routes import router

    overrides = {"anthropic": mock_provider, "openai": mock_provider, "mock": mock_provider}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
        await state.startup(start_poller=False)
        await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(router)
    mount_moved_routers(api)
    with TestClient(api) as c:
        yield c


def make_raw_event(
    *,
    id: str = "e1",
    ip: str = "203.0.113.10",
    user: str = "root",
    host: str = "web01",
    rule: str = "linux_auth",
    severity: float = 7.0,
    ts_millis: int | None = None,
):
    from app.models import RawEvent

    ts = ts_millis if ts_millis is not None else to_millis(now_utc())
    src = make_log_event(ip=ip, user=user, host=host, rule=rule, severity=severity, ts_millis=ts)
    return RawEvent(
        id=id, index="all-logs-2026.06.16", source=src, timestamp_millis=ts,
        ip=ip, user=user, host=host, rule=rule, rule_name=rule, severity=severity,
    )


_SEED_COUNTER = {"n": 0}


def seed_logs(es: InMemoryESClient, events: list[dict], index: str = "all-logs-2026.06.16") -> list[str]:
    ids = []
    for ev in events:
        _SEED_COUNTER["n"] += 1
        ids.append(es.add_log(index, ev, doc_id=f"ev{_SEED_COUNTER['n']}"))
    return ids
