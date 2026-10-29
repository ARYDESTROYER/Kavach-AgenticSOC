"""Round 14 A4b-1: the audit record fields of identity and settings writers.

SPEC §4.5.3 (record additions), §4.5.4 (A4b-1 writers), §3.5 (sinks), §3.6 (audit
before visible), E15 (the client address is believed from a forwarded header only
through a named trusted proxy, and then only its rightmost entry), and ``object_scoped``
on ``GET /api/auth/me`` (§4.4.5, D16).

Covers, offline (fake Elasticsearch, mock model):

* the request-id middleware (a valid ``X-Request-ID`` is honoured and echoed, anything
  else is replaced by a UUIDv4, and the rows a request writes carry the same id);
* ``audit_client_ip``: a forged leading ``X-Forwarded-For`` entry never becomes
  ``client.ip``, neither through a trusted proxy (the rightmost entry that is not a
  trusted proxy wins, and padding the header never hides it) nor from a direct peer
  (headers ignored); a peer that is not an address records ``None``, never an empty
  string;
* the trusted proxy list (addresses, ranges, host names resolved and refreshed);
* the session reference (an HMAC of the session id, never the token);
* ``changes``: secrets withheld, webhook URLs cut to scheme and host, a
  ``user:password@`` never recorded;
* a sign-in, a failed sign-in, a sign-out, an MFA failure, a session revocation, a
  user created, updated, role-changed and deleted, a custom role created, updated and
  deleted, a settings change (``PUT /api/settings`` and the curated routes) each write
  one row with every applicable new field, to the real audit log with Demo Mode on
  and off;
* audit-first: when the audit row cannot be appended the change answers ``503
  audit_unavailable`` and nothing changes;
* the settings compare-and-swap (a racing unrelated save is no conflict, a racing save
  of the same field retries with a paired failure row);
* the investigation pipeline stamps ``run_id`` and ``actor_type`` on its rows.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import pytest
from fastapi import Depends, FastAPI, Request
from fastapi.testclient import TestClient

from app.api.deps import require_auth
from app.api.routes import router as monolith_router
from app.api.routes_roles import router as roles_router
from app.audit import events
from app.audit.changes import diff_changes, is_secret_key, redact_text, reduce_url
from app.audit.context import (
    REQUEST_ID_HEADER,
    TrustedProxies,
    audit_client_ip,
    audit_context,
    configure_trusted_proxies,
    current_request_id,
    honoured_request_id,
)
from app.audit.prefs_write import audited_prefs_write, section_label, settings_target
from app.audit.write import failure_action
from app.auth.service import AuthService
from app.config import Preferences, Secrets
from app.constants import EntityType, SourceSurface
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.middleware.request_id import RequestIdMiddleware
from app.models import AuditChange
from app.state import AppState
from tests.conftest import make_raw_event, mount_moved_routers

_JWT_SECRET = "a4b1-record-fields-secret"
_PEER_HEADER = "x-test-peer"
_UUID4_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")


# --------------------------------------------------------------------------- #
# Harness
# --------------------------------------------------------------------------- #
class _Request:
    """The parts of a Starlette request ``audit_client_ip`` reads."""

    def __init__(self, peer: str | None, headers: list[tuple[str, str]] | None = None) -> None:
        from starlette.datastructures import Headers

        self.client = type("C", (), {"host": peer})() if peer is not None else None
        raw = [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in (headers or [])]
        self.headers = Headers(raw=raw)


class _PeerShim:
    """Test-only ASGI wrapper: a request may name its socket peer in ``x-test-peer``
    (the TestClient's own peer is the non-address ``testclient``)."""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope, receive, send):  # noqa: ANN001
        if scope.get("type") == "http":
            for key, value in scope.get("headers") or []:
                if key == _PEER_HEADER.encode():
                    scope = dict(scope)
                    scope["client"] = (value.decode(), 40000)
                    break
        await self.app(scope, receive, send)


@pytest.fixture(autouse=True)
def _trusted_proxies():
    """The proxies these tests trust: one address range (no DNS). The process-wide
    list is restored afterwards."""
    from app.audit import context as audit_context_module

    previous = audit_context_module._TRUSTED
    configure_trusted_proxies("172.30.0.0/16")
    yield
    audit_context_module._TRUSTED = previous


@pytest.fixture(autouse=True)
def _clean_mfa_park():
    from app.api.routes import _MFA_PENDING_ENROLL

    _MFA_PENDING_ENROLL.clear()
    yield
    _MFA_PENDING_ENROLL.clear()


def _app(*, rbac: bool = False, object_scope: bool = False) -> tuple[FastAPI, Any]:
    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="",
        anthropic_api_key=None, openai_api_key=None,
        auth_enabled=True, auth_jwt_secret=_JWT_SECRET, auth_seed_admin=True,
    )
    mock = MockProvider()
    overrides = {"anthropic": mock, "openai": mock, "mock": mock}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
        await state.startup(start_poller=False)
        prefs = state.prefs.model_copy(update={"setup_complete": True})
        if rbac or object_scope:
            rbac_cfg = prefs.rbac.model_copy(update={"enabled": True})
            if object_scope:
                rbac_cfg = rbac_cfg.model_copy(update={
                    "object_scoping_enabled": True,
                    "object_scope": {"analyst_tier1": {"cases": ["assignee"]}},
                })
            prefs = prefs.model_copy(update={"rbac": rbac_cfg})
        await state.update_prefs(prefs)
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(monolith_router, dependencies=[Depends(require_auth)])
    api.include_router(roles_router, dependencies=[Depends(require_auth)])
    mount_moved_routers(api, dependencies=[Depends(require_auth)])
    api.add_middleware(RequestIdMiddleware)
    return api, _PeerShim(api)


def _client(**kwargs: Any) -> tuple[TestClient, FastAPI]:
    api, shim = _app(**kwargs)
    return TestClient(shim), api


def _state(api: FastAPI) -> AppState:
    return api.state.tlsoc


def _rows(client: TestClient, api: FastAPI, *, repo: Any = None) -> list[dict[str, Any]]:
    store = repo if repo is not None else _state(api).control_audit
    return client.portal.call(lambda: store.records(limit=1000))


def _by_action(rows: list[dict[str, Any]], action: str) -> list[dict[str, Any]]:
    return [r for r in rows if r.get("action") == action]


def _login(client: TestClient, username: str = "Admin", password: str = "Admin@123",
           **headers: str):
    client.cookies.clear()
    return client.post("/api/auth/login", json={"username": username, "password": password},
                       headers=headers)


def _admin(client: TestClient) -> dict[str, str]:
    response = _login(client)
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['token']}"}


def _fresh(client: TestClient, auth: dict[str, str]) -> None:
    """Step-up re-authentication for the routes gated by ``require_fresh_auth``."""
    response = client.post("/api/auth/reauth", json={"password": "Admin@123"}, headers=auth)
    assert response.status_code == 200, response.text


def _break_strict_appends(monkeypatch: pytest.MonkeyPatch, state: AppState) -> None:
    """Every strict audit append fails (the audit store is down)."""
    repo = state.control_audit

    async def _down(**_kwargs: Any) -> None:
        raise RuntimeError("audit store unreachable")

    monkeypatch.setattr(repo, "record_strict", _down)


# --------------------------------------------------------------------------- #
# Request ids
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("value, honoured", [
    ("abcd1234", True),
    ("req-2026.10.26_ab-CD", True),
    ("a" * 64, True),
    ("short", False),
    ("a" * 65, False),
    ("has space in it", False),
    ("semi;colon-12345", False),
    ("", False),
    (None, False),
])
def test_only_an_id_in_the_grammar_is_honoured(value: Any, honoured: bool) -> None:
    result = honoured_request_id(value)
    assert (result is not None) is honoured
    if honoured:
        assert result == value


def _echo_app() -> FastAPI:
    api = FastAPI()

    @api.get("/echo")
    async def echo(request: Request) -> dict[str, Any]:
        return {"state": request.state.request_id, "bound": current_request_id()}

    @api.get("/own-header")
    async def own_header() -> Any:
        from fastapi.responses import JSONResponse

        return JSONResponse({"ok": True}, headers={REQUEST_ID_HEADER: "route-set-value-1"})

    api.add_middleware(RequestIdMiddleware)
    return api


def test_a_valid_request_id_is_honoured_and_echoed() -> None:
    with TestClient(_echo_app()) as client:
        response = client.get("/echo", headers={REQUEST_ID_HEADER: "trace-0001.ab_cd"})
    assert response.headers[REQUEST_ID_HEADER] == "trace-0001.ab_cd"
    assert response.json() == {"state": "trace-0001.ab_cd", "bound": "trace-0001.ab_cd"}


@pytest.mark.parametrize("sent", [None, "bad id!", "x", "a" * 80, "<script>alert(1)</script>"])
def test_a_missing_or_invalid_request_id_is_replaced_by_a_fresh_uuid(sent: str | None) -> None:
    headers = {REQUEST_ID_HEADER: sent} if sent is not None else {}
    with TestClient(_echo_app()) as client:
        first = client.get("/echo", headers=headers)
        second = client.get("/echo", headers=headers)
    rid = first.headers[REQUEST_ID_HEADER]
    assert _UUID4_RE.match(rid), rid
    assert first.json() == {"state": rid, "bound": rid}
    assert second.headers[REQUEST_ID_HEADER] != rid


def test_two_request_id_headers_are_replaced_and_the_response_carries_one() -> None:
    with TestClient(_echo_app()) as client:
        response = client.get("/echo", headers=[
            (REQUEST_ID_HEADER, "first-id-123"), (REQUEST_ID_HEADER, "second-id-456"),
        ])
    assert _UUID4_RE.match(response.headers[REQUEST_ID_HEADER])
    with TestClient(_echo_app()) as client:
        own = client.get("/own-header", headers={REQUEST_ID_HEADER: "client-id-789"})
    assert own.headers.get_list(REQUEST_ID_HEADER) == ["client-id-789"]


def test_the_request_id_is_unbound_after_the_request() -> None:
    with TestClient(_echo_app()) as client:
        client.get("/echo")
    assert current_request_id() is None


# --------------------------------------------------------------------------- #
# Client address (E15)
# --------------------------------------------------------------------------- #
def test_a_direct_peer_is_recorded_whatever_forwarded_header_it_sends() -> None:
    proxies = TrustedProxies("172.30.0.0/16")
    client = audit_client_ip(_Request("203.0.113.9", [("X-Forwarded-For", "1.1.1.1")]), proxies)
    assert client.ip == "203.0.113.9"
    assert client.ip_source == "peer"
    assert client.peer == "203.0.113.9"
    assert client.forwarded_for == "1.1.1.1"  # kept as untrusted text only


def test_through_a_trusted_proxy_the_rightmost_entry_wins_never_a_forged_leading_one() -> None:
    proxies = TrustedProxies("172.30.0.0/16")
    forged = "6.6.6.6, 7.7.7.7, 198.51.100.24"
    client = audit_client_ip(_Request("172.30.0.4", [("X-Forwarded-For", forged)]), proxies)
    assert client.ip == "198.51.100.24"
    assert client.ip_source == "trusted_proxy"
    assert client.peer == "172.30.0.4"
    assert client.forwarded_for == forged


def test_several_forwarded_header_lines_are_read_as_one_list() -> None:
    proxies = TrustedProxies("172.30.0.4")
    request = _Request("172.30.0.4", [("X-Forwarded-For", "6.6.6.6"), ("X-Forwarded-For", "198.51.100.7")])
    client = audit_client_ip(request, proxies)
    assert client.ip == "198.51.100.7" and client.ip_source == "trusted_proxy"


def test_an_unparsable_rightmost_entry_falls_back_to_the_peer() -> None:
    proxies = TrustedProxies("172.30.0.0/16")
    client = audit_client_ip(_Request("172.30.0.4", [("X-Forwarded-For", "1.2.3.4, unknown")]), proxies)
    assert client.ip == "172.30.0.4" and client.ip_source == "peer"


@pytest.mark.parametrize("peer", ["testclient", "", "unix:/run/app.sock", None])
def test_a_peer_that_is_not_an_address_records_none_never_an_empty_string(peer: str | None) -> None:
    client = audit_client_ip(_Request(peer, [("User-Agent", "curl/8.4")]), TrustedProxies(""))
    assert client.ip is None
    assert client.ip_source == "peer"
    assert client.user_agent == "curl/8.4"
    assert "ip" not in client.model_dump(exclude_none=True)


def test_values_from_the_caller_are_bounded() -> None:
    request = _Request("203.0.113.9", [("User-Agent", "U" * 2000), ("X-Forwarded-For", "9" * 900)])
    client = audit_client_ip(request, TrustedProxies(""))
    assert len(client.user_agent) == 512
    assert len(client.forwarded_for or "") == 256
    assert (client.forwarded_for or "").startswith("...")


class _RewrittenRequest(_Request):
    """A request whose peer the ASGI server already replaced (uvicorn's proxy headers
    put an ``X-Forwarded-For`` entry in ``client`` with port 0)."""

    def __init__(self, host: str, xff: str) -> None:
        super().__init__(host, [("X-Forwarded-For", xff)])
        self.client = type("C", (), {"host": host, "port": 0})()


def test_a_peer_the_server_rewrote_from_a_forged_header_is_undone(monkeypatch) -> None:
    from app.audit import context as module

    monkeypatch.setattr(module, "_SERVER_FORWARDED_ALLOW_IPS", "127.0.0.1")
    # A local caller forged X-Forwarded-For; uvicorn (trusting loopback) moved it into
    # the peer. Not a TRUSTED_PROXIES peer, so the real loopback peer is recorded.
    client = audit_client_ip(_RewrittenRequest("6.6.6.6", "6.6.6.6"), TrustedProxies(""))
    assert client.ip == "127.0.0.1" and client.ip_source == "peer"
    assert client.peer == "127.0.0.1" and client.forwarded_for == "6.6.6.6"
    # Loopback named as a trusted proxy: the forwarded entry is believed, labelled so.
    trusted = audit_client_ip(_RewrittenRequest("198.51.100.3", "198.51.100.3"),
                              TrustedProxies("127.0.0.1"))
    assert trusted.ip == "198.51.100.3" and trusted.ip_source == "trusted_proxy"
    # A server that trusts several hosts (or every host): the real peer is unknown,
    # so no address is recorded rather than the caller's choice.
    monkeypatch.setattr(module, "_SERVER_FORWARDED_ALLOW_IPS", "10.0.0.2,10.0.0.3")
    unknown = audit_client_ip(_RewrittenRequest("6.6.6.6", "6.6.6.6"), TrustedProxies(""))
    assert unknown.ip is None and unknown.peer == "" and unknown.ip_source == "peer"
    monkeypatch.setattr(module, "_SERVER_FORWARDED_ALLOW_IPS", "*")
    assert audit_client_ip(_RewrittenRequest("6.6.6.6", "6.6.6.6"), TrustedProxies("")).ip is None
    # A real peer (non-zero port) is never second-guessed.
    real = _Request("203.0.113.4", [("X-Forwarded-For", "6.6.6.6")])
    real.client = type("C", (), {"host": "203.0.113.4", "port": 51000})()
    assert audit_client_ip(real, TrustedProxies("")).ip == "203.0.113.4"


def test_an_ipv4_mapped_peer_matches_its_ipv4_range() -> None:
    proxies = TrustedProxies("172.30.0.0/16")
    client = audit_client_ip(_Request("::ffff:172.30.1.2", [("X-Forwarded-For", "198.51.100.1")]), proxies)
    assert client.ip == "198.51.100.1" and client.ip_source == "trusted_proxy"


def test_trusted_proxy_names_resolve_refresh_and_ignore_what_does_not_resolve() -> None:
    now = [1000.0]
    answers = {"tlsoc-webui": ["172.18.0.5"], "gone": None}

    def resolver(name: str) -> list[str]:
        value = answers[name]
        if value is None:
            raise OSError("no such host")
        return value

    proxies = TrustedProxies("tlsoc-webui, gone, 10.0.0.0/8, not a host!", resolver=resolver,
                             clock=lambda: now[0])
    assert proxies.names == ("tlsoc-webui", "gone")
    assert len(proxies.networks) == 1
    # Before the first round a name matches nothing (the peer is recorded).
    assert proxies.due() and not proxies.matches("172.18.0.5")
    assert proxies.matches("10.4.5.6")
    proxies.refresh()
    assert proxies.matches("172.18.0.5") and not proxies.due()
    assert proxies.unresolved_names() == ("gone",)
    # The service moved: believed until the next full round, then the new address.
    # The name that does not resolve is retried sooner, alone, on its backoff.
    answers["tlsoc-webui"] = ["172.18.0.9"]
    now[0] += 4
    assert not proxies.due()
    now[0] += 1
    assert proxies.due()
    assert proxies._due_round() == (False, ("gone",))
    proxies.refresh(("gone",))
    assert proxies.matches("172.18.0.5"), "a retry of another name never re-reads this one"
    now[0] = 1299
    assert proxies._due_round() == (False, ("gone",))  # the backoff never exceeds a minute
    proxies.refresh(("gone",))
    now[0] += 2
    assert proxies._due_round() == (True, ("tlsoc-webui", "gone"))
    proxies.refresh()
    assert proxies.matches("172.18.0.9") and not proxies.matches("172.18.0.5")


def test_a_proxy_that_starts_after_the_backend_is_believed_within_seconds() -> None:
    """In the bundled Compose stack the Web UI starts only once the backend is
    healthy, so its name cannot resolve at startup: it is retried on a short backoff
    (5, 10, 30, then every 60 seconds), never only every 5 minutes."""
    from app.audit.context import TRUSTED_PROXY_UNRESOLVED_RETRY_SECONDS

    now = [0.0]
    answers: dict[str, Any] = {"tlsoc-webui": None}
    lookups: list[float] = []

    def resolver(name: str) -> list[str]:
        lookups.append(now[0])
        value = answers[name]
        if value is None:
            raise OSError("no such host")
        return value

    proxies = TrustedProxies("tlsoc-webui", resolver=resolver, clock=lambda: now[0])
    assert TRUSTED_PROXY_UNRESOLVED_RETRY_SECONDS == (5.0, 10.0, 30.0, 60.0)

    def run_due_round() -> None:
        due = proxies._due_round()
        assert due is not None
        full, names = due
        proxies.refresh(None if full else names)

    run_due_round()  # startup: the Web UI does not exist yet
    assert not proxies.matches("172.18.0.5")
    for wait in (5.0, 10.0, 30.0, 60.0, 60.0):
        now[0] += wait - 0.5
        assert not proxies.due()
        now[0] += 0.5
        assert proxies.due()
        run_due_round()
    assert lookups == [0.0, 5.0, 15.0, 45.0, 105.0, 165.0]
    # The Web UI is up: the next retry believes it, and the cadence is back to 5 minutes.
    answers["tlsoc-webui"] = ["172.18.0.5"]
    now[0] += 60.0
    run_due_round()
    assert proxies.matches("172.18.0.5")
    assert proxies.unresolved_names() == () and not proxies.due()
    # The full cadence (every 5 minutes from the startup round) goes on.
    now[0] = 299.0
    assert not proxies.due()
    now[0] = 300.0
    assert proxies._due_round() == (True, ("tlsoc-webui",))
    # A transient failure of a name that resolved before keeps its addresses and the
    # full cadence, so the rounds before they are forgotten still span 15 minutes.
    answers["tlsoc-webui"] = None
    run_due_round()
    assert proxies.matches("172.18.0.5")
    now[0] += 60.0
    assert not proxies.due()


def test_a_request_soon_after_startup_believes_the_proxy_once_it_resolves() -> None:
    """End to end through the middleware: the first lookup fails, a request 5 seconds
    later starts the retry, and the request after it records the forwarded client."""
    now = [100.0]
    answers: dict[str, Any] = {"tlsoc-webui": None}

    def resolver(name: str) -> list[str]:
        value = answers[name]
        if value is None:
            raise OSError("no such host")
        return value

    proxies = TrustedProxies("tlsoc-webui", resolver=resolver, clock=lambda: now[0])
    proxies.refresh()
    assert not proxies.matches("172.18.0.5")
    answers["tlsoc-webui"] = ["172.18.0.5"]
    now[0] += 5.0

    api = FastAPI()

    @api.get("/whoami")
    async def whoami(request: Request) -> dict[str, Any]:
        return audit_client_ip(request, trusted=proxies).model_dump()

    api.add_middleware(RequestIdMiddleware, trusted=proxies)
    with TestClient(_PeerShim(api)) as client:
        headers = {_PEER_HEADER: "172.18.0.5", "X-Forwarded-For": "198.51.100.7"}
        assert proxies.due()
        client.get("/whoami", headers=headers)  # starts the retry in a worker thread
        for _ in range(200):
            if proxies.matches("172.18.0.5"):
                break
            time.sleep(0.01)
        second = client.get("/whoami", headers=headers).json()
    assert second["ip"] == "198.51.100.7" and second["ip_source"] == "trusted_proxy"


async def test_a_background_refresh_runs_off_the_loop_and_only_once_at_a_time() -> None:
    calls: list[str] = []

    def resolver(name: str) -> list[str]:
        calls.append(name)
        return ["172.19.0.2"]

    proxies = TrustedProxies("webui", resolver=resolver)
    assert proxies.refresh_in_background() is True
    assert proxies.refresh_in_background() is False  # one round at a time
    for _ in range(200):
        if proxies.matches("172.19.0.2"):
            break
        await asyncio.sleep(0.01)
    assert proxies.matches("172.19.0.2")
    assert calls == ["webui"]
    assert await proxies.refresh_now() is False  # not due again for 5 minutes


def test_the_default_trusted_proxy_is_the_bundled_web_ui_service() -> None:
    assert Secrets(_env_file=None).trusted_proxies == "tlsoc-webui"


# --------------------------------------------------------------------------- #
# Session reference
# --------------------------------------------------------------------------- #
def test_the_session_reference_is_a_keyed_hash_never_the_session_id() -> None:
    auth = AuthService(enabled=True, jwt_secret="k1", token_hours=12)
    ref = auth.session_ref("sid-abcdef0123456789")
    assert ref is not None and re.fullmatch(r"[0-9a-f]{16}", ref)
    assert ref == auth.session_ref("sid-abcdef0123456789")
    assert ref != auth.session_ref("sid-other")
    assert "abcdef" not in ref
    other_key = AuthService(enabled=True, jwt_secret="k2", token_hours=12)
    assert other_key.session_ref("sid-abcdef0123456789") != ref
    assert auth.session_ref("") is None and auth.session_ref(None) is None
    assert AuthService(enabled=False, jwt_secret="", token_hours=12).session_ref("sid") is None


# --------------------------------------------------------------------------- #
# changes: secrets and URLs (§4.5.3)
# --------------------------------------------------------------------------- #
def test_secret_fields_are_never_recorded() -> None:
    changes = diff_changes(
        {"a": {"password": "old-pass", "api_key": "k-1", "client_secret": "c1", "max_tokens": 10},
         "connector_secrets": {"s1": {"user": "u"}}},
        {"a": {"password": "new-pass", "api_key": "k-2", "client_secret": "c2", "max_tokens": 20},
         "connector_secrets": {"s1": {"user": "v"}}},
    )
    by_field = {c.field: c for c in changes}
    for field in ("a.password", "a.api_key", "a.client_secret", "connector_secrets.s1.user"):
        assert by_field[field].secret is True
        assert by_field[field].before is None and by_field[field].after is None
    assert by_field["a.max_tokens"].secret is False
    assert (by_field["a.max_tokens"].before, by_field["a.max_tokens"].after) == ("10", "20")
    text = json.dumps([c.model_dump() for c in changes])
    for secret in ("old-pass", "new-pass", "k-1", "k-2", "c1", "c2"):
        assert secret not in text


def test_a_number_named_like_a_token_stays_readable_but_a_token_text_does_not() -> None:
    assert not is_secret_key("turn_token_ceiling", 60000)
    assert not is_secret_key("max_tokens", 1500)
    assert is_secret_key("token", "abc")
    assert is_secret_key("shared_secret", "abc")
    assert is_secret_key("sasl_password", "abc")


def test_a_slack_webhook_url_is_cut_to_scheme_and_host_and_marked() -> None:
    changes = diff_changes(
        {"notifications": {"channels": [{"id": "slack-1", "config": {"url": "https://hooks.slack.com/services/T0/B0/OLDSECRET"}}]}},
        {"notifications": {"channels": [{"id": "slack-1", "config": {"url": "https://hooks.slack.com/services/T0/B0/NEWSECRET"}}]}},
    )
    assert [c.field for c in changes] == ["notifications.channels[slack-1].config.url"]
    change = changes[0]
    assert change.before == "https://hooks.slack.com" and change.after == "https://hooks.slack.com"
    assert change.secret is True
    assert "SECRET" not in json.dumps(change.model_dump())


def test_a_source_url_with_credentials_never_reaches_the_record() -> None:
    changes = diff_changes(
        {"sources": [{"id": "es-a", "config": {"url": "https://reader:hunter2@es.example:9200/logs"}}]},
        {"sources": [{"id": "es-a", "config": {"url": "https://reader:hunter3@es.example:9201/logs"}}]},
    )
    assert changes[0].before == "https://es.example:9200"
    assert changes[0].after == "https://es.example:9201"
    assert changes[0].secret is True
    # Any other field keeps its text but loses the credentials of an address in it.
    other = diff_changes({"note": "x"}, {"note": "see https://u:pw@host.example/a and Bearer abcdefghijkl"})
    assert other[0].after == "see https://host.example/a and [REDACTED]"
    assert other[0].secret is True


def test_url_reduction_keeps_what_is_not_a_network_address() -> None:
    assert reduce_url("data:image/png;base64,AAAA") == ("data:image/png;base64,AAAA", False)
    assert reduce_url("https://[2001:db8::1]:8443/x?y=1") == ("https://[2001:db8::1]:8443", True)
    assert reduce_url("https://hooks.example") == ("https://hooks.example", False)
    assert redact_text("plain words") == ("plain words", False)


def test_keyed_lists_compare_item_by_item_and_changes_are_capped() -> None:
    before = {"rules": [{"id": "r1", "enabled": True}, {"id": "r2", "enabled": True}]}
    after = {"rules": [{"id": "r2", "enabled": False}, {"id": "r3", "enabled": True}]}
    fields = {c.field: (c.before, c.after) for c in diff_changes(before, after)}
    assert fields == {
        "rules[r1].enabled": ("true", None),
        "rules[r1].id": ("r1", None),
        "rules[r2].enabled": ("true", "false"),
        "rules[r3].enabled": (None, "true"),
        "rules[r3].id": (None, "r3"),
    }
    many = diff_changes({}, {f"k{i:03d}": i for i in range(80)})
    assert len(many) == 50


def test_the_settings_target_names_the_changed_sections_in_sentence_case() -> None:
    target = settings_target([AuditChange(field="auto_close.false_positive.enabled"),
                              AuditChange(field="rag.top_k")])
    assert target.type == "setting"
    assert target.id == "auto_close,rag"
    assert target.label == "Auto-close policy, RAG"
    assert section_label("case_id_format") == "Case ID format"
    assert settings_target([]).id == "settings"


# --------------------------------------------------------------------------- #
# Sign-in, sign-out, MFA and sessions
# --------------------------------------------------------------------------- #
def _assert_client(row: dict[str, Any], ip: str | None, source: str) -> None:
    client = row.get("client") or {}
    assert client.get("ip") == ip  # a parsed address or None, never an empty string
    assert client.get("ip_source") == source


def _target(row: dict[str, Any]) -> dict[str, Any]:
    """The row's target without an unset revision (identity targets have none)."""
    target = dict(row.get("target") or {})
    if target.get("revision") is None:
        target.pop("revision", None)
    return target


def test_a_sign_in_writes_every_applicable_field() -> None:
    client, api = _client()
    with client:
        response = _login(client, **{_PEER_HEADER: "172.30.0.4",
                                     "X-Forwarded-For": "6.6.6.6, 198.51.100.20",
                                     "User-Agent": "Mozilla/5.0 test",
                                     REQUEST_ID_HEADER: "signin-req-0001"})
        assert response.status_code == 200, response.text
        assert response.headers[REQUEST_ID_HEADER] == "signin-req-0001"
        state = _state(api)
        sid = state.auth.claims_of(response.json()["token"])["sid"]
        rows = _by_action(_rows(client, api), "auth.login")
    assert len(rows) == 1
    row = rows[0]
    assert row["outcome"] == "success"
    assert row["actor"] == "Admin" and row["actor_type"] == "human"
    assert row["action_type"] == "auth" and row["surface"] == "auth"
    assert row["actor_role"] == "super_admin"
    assert row["session_ref"] == state.auth.session_ref(sid)
    assert sid not in json.dumps(row)
    assert row["request_id"] == "signin-req-0001"
    assert row["result_summary"] == "login ok"
    assert _target(row) == {"type": "user", "id": "Admin", "label": "Admin"}
    _assert_client(row, "198.51.100.20", "trusted_proxy")
    assert row["client"]["forwarded_for"] == "6.6.6.6, 198.51.100.20"
    assert row["client"]["user_agent"] == "Mozilla/5.0 test"


def test_a_failed_sign_in_records_the_attempt_and_the_direct_peer() -> None:
    client, api = _client()
    with client:
        response = client.post(
            "/api/auth/login", json={"username": "mallory", "password": "nope-nope"},
            headers={_PEER_HEADER: "203.0.113.50", "X-Forwarded-For": "10.0.0.1"},
        )
        assert response.status_code == 401
        rid = response.headers[REQUEST_ID_HEADER]
        rows = _by_action(_rows(client, api), "auth.login_failed")
    assert len(rows) == 1
    row = rows[0]
    assert row["outcome"] == "failure" and row["actor"] == "mallory"
    assert row["actor_type"] == "human"
    assert "session_ref" not in row and "actor_role" not in row
    assert row["request_id"] == rid
    # A direct caller cannot choose its recorded address.
    _assert_client(row, "203.0.113.50", "peer")
    assert row["client"]["forwarded_for"] == "10.0.0.1"


def test_the_test_client_peer_records_no_address_rather_than_an_empty_one() -> None:
    client, api = _client()
    with client:
        _login(client)
        row = _by_action(_rows(client, api), "auth.login")[0]
    assert row["client"]["peer"] == "testclient"
    _assert_client(row, None, "peer")


def test_sign_out_and_session_revocations_are_recorded() -> None:
    client, api = _client()
    with client:
        auth = _admin(client)
        other = _login(client)  # a second session to revoke
        other_sid = _state(api).auth.claims_of(other.json()["token"])["sid"]
        auth = _admin(client)
        _fresh(client, auth)
        revoked = client.post(f"/api/admin/sessions/{other_sid}/revoke", headers=auth)
        assert revoked.status_code == 200, revoked.text
        logout = client.post("/api/auth/logout", headers=auth)
        assert logout.status_code == 200
        rows = _rows(client, api)
        state = _state(api)
    revoke_rows = _by_action(rows, "session.revoked")
    assert len(revoke_rows) == 1
    revoke = revoke_rows[0]
    assert _target(revoke) == {"type": "user", "id": "Admin", "label": "Admin"}
    assert revoke["tool_input"]["session"] == state.auth.session_ref(other_sid)
    assert revoke["actor_role"] == "super_admin" and revoke["session_ref"]
    logouts = _by_action(rows, "auth.logout")
    assert len(logouts) == 1 and logouts[0]["outcome"] == "success"
    assert logouts[0]["result_summary"].startswith("session_revoke sid=")
    assert _target(logouts[0]) == {"type": "user", "id": "Admin", "label": "Admin"}
    reauth = _by_action(rows, "auth.reauthenticated")
    assert reauth and reauth[0]["surface"] == "session"
    assert _target(reauth[0]) == {"type": "user", "id": "Admin", "label": "Admin"}


def test_a_wrong_password_on_step_up_is_a_failure_row() -> None:
    client, api = _client()
    with client:
        auth = _admin(client)
        response = client.post("/api/auth/reauth", json={"password": "wrong"}, headers=auth)
        assert response.status_code == 401
        rows = _by_action(_rows(client, api), "auth.reauth_failed")
    assert len(rows) == 1 and rows[0]["outcome"] == "failure"


def test_mfa_set_up_failure_and_turning_off_are_recorded() -> None:
    from app.auth import mfa as mfa_mod

    client, api = _client()
    with client:
        auth = _admin(client)
        setup = client.post("/api/auth/mfa/setup", headers=auth)
        assert setup.status_code == 200
        secret = setup.json()["secret"]
        confirm = client.post("/api/auth/mfa/confirm", json={"code": mfa_mod.totp(secret)}, headers=auth)
        assert confirm.status_code == 200, confirm.text
        # A wrong code on the second-factor step of a later sign-in.
        pending = _login(client).json()["pending_token"]
        failed = client.post("/api/auth/mfa/verify", json={"pending_token": pending, "code": "000000"})
        assert failed.status_code == 401
        rows = _rows(client, api)
    enrolled = _by_action(rows, "auth.mfa_enrolled")
    assert len(enrolled) == 1
    assert enrolled[0]["target"]["id"] == "Admin"
    fields = {c["field"]: c for c in enrolled[0]["changes"]}
    assert fields["mfa_enabled"]["after"] == "true"
    assert fields["mfa_secret"]["secret"] is True and fields["mfa_secret"]["after"] is None
    assert secret not in json.dumps(rows)
    assert _by_action(rows, "auth.mfa_failed")[0]["outcome"] == "failure"
    assert _by_action(rows, "auth.mfa_challenged")


def test_a_password_change_is_audited_first_and_never_records_the_password() -> None:
    client, api = _client()
    with client:
        auth = _admin(client)
        created = client.post("/api/users", json={"username": "pat", "password": "pat-pass-123"},
                              headers=auth)
        assert created.status_code == 200, created.text
        token = _login(client, "pat", "pat-pass-123").json()["token"]
        bad = client.post("/api/auth/change-password", headers={"Authorization": f"Bearer {token}"},
                          json={"current_password": "wrong", "new_password": "pat-new-pass-1"})
        assert bad.status_code == 400
        good = client.post("/api/auth/change-password", headers={"Authorization": f"Bearer {token}"},
                           json={"current_password": "pat-pass-123", "new_password": "pat-new-pass-1"})
        assert good.status_code == 200
        rows = _rows(client, api)
    changed = _by_action(rows, "auth.password_changed")
    assert len(changed) == 1 and changed[0]["changes"] == [
        {"field": "password", "before": None, "after": None, "secret": True},
    ]
    assert _by_action(rows, "auth.password_change_failed")[0]["outcome"] == "failure"
    assert "pat-new-pass-1" not in json.dumps(rows) and "pat-pass-123" not in json.dumps(rows)


# --------------------------------------------------------------------------- #
# Users and roles
# --------------------------------------------------------------------------- #
def test_user_create_update_role_change_and_delete_rows() -> None:
    client, api = _client()
    with client:
        auth = _admin(client)
        created = client.post("/api/users", headers=auth, json={
            "username": "vpatel", "password": "vp-pass-1234", "role": "analyst_tier1",
            "display_name": "V Patel", "email": "vp@example.com",
        })
        assert created.status_code == 200, created.text
        assert client.put("/api/users/vpatel", headers=auth, json={"phone": "+1 555"}).status_code == 200
        role = client.put("/api/users/vpatel", headers=auth, json={"role": "analyst_tier2"})
        assert role.status_code == 200, role.text
        assert client.delete("/api/users/vpatel", headers=auth).status_code == 200
        rows = _rows(client, api)
    created_row = _by_action(rows, "user.created")[0]
    assert _target(created_row) == {"type": "user", "id": "vpatel", "label": "V Patel"}
    fields = {c["field"]: c for c in created_row["changes"]}
    assert fields["role"]["after"] == "analyst_tier1"
    assert fields["email"]["after"] == "vp@example.com"
    assert fields["password"] == {"field": "password", "before": None, "after": None, "secret": True}
    assert "vp-pass-1234" not in json.dumps(created_row)
    assert created_row["outcome"] == "success" and created_row["actor"] == "Admin"
    assert created_row["actor_type"] == "human" and created_row["request_id"]

    updated = _by_action(rows, "user.updated")[0]
    assert updated["changes"] == [{"field": "phone", "before": "", "after": "+1 555", "secret": False}]
    role_row = _by_action(rows, "user.role_changed")[0]
    assert role_row["changes"] == [
        {"field": "role", "before": "analyst_tier1", "after": "analyst_tier2", "secret": False},
    ]
    deleted = _by_action(rows, "user.deleted")[0]
    assert deleted["target"]["id"] == "vpatel" and deleted["outcome"] == "success"


def test_custom_role_writes_and_role_assignment_record_grant_by_grant() -> None:
    client, api = _client(rbac=True)
    with client:
        auth = _admin(client)
        _fresh(client, auth)
        made = client.post("/api/roles", headers=auth, json={
            "name": "hunter", "description": "Threat hunters", "grants": {"cases": ["read"]},
        })
        assert made.status_code == 200, made.text
        changed = client.put("/api/roles", headers=auth, json={
            "name": "hunter", "description": "Threat hunters", "grants": {"cases": ["read", "update"]},
        })
        assert changed.status_code == 200, changed.text
        client.post("/api/users", headers=auth, json={"username": "kim", "password": "kim-pass-123"})
        assigned = client.put("/api/users/kim/roles", headers=auth, json={"custom_roles": ["hunter"]})
        assert assigned.status_code == 200, assigned.text
        assert client.delete("/api/roles/hunter", headers=auth).status_code == 200
        rows = _rows(client, api)
    created = _by_action(rows, "role.created")[0]
    assert _target(created) == {"type": "role", "id": "hunter", "label": "hunter"}
    assert {"field": "grants.cases", "before": None, "after": '["read"]', "secret": False} in created["changes"]
    updated = _by_action(rows, "role.updated")[0]
    assert updated["changes"] == [
        {"field": "grants.cases", "before": '["read"]', "after": '["read", "update"]', "secret": False},
    ]
    assignment = _by_action(rows, "user.role_changed")[0]
    assert assignment["target"]["id"] == "kim"
    assert assignment["changes"] == [
        {"field": "custom_roles", "before": "[]", "after": '["hunter"]', "secret": False},
    ]
    assert assignment["surface"] == "rbac" and assignment["actor_role"] == "super_admin"
    assert _by_action(rows, "role.deleted")[0]["target"]["id"] == "hunter"


# --------------------------------------------------------------------------- #
# Settings
# --------------------------------------------------------------------------- #
def test_a_settings_change_records_what_changed_and_never_a_secret_url() -> None:
    client, api = _client()
    with client:
        auth = _admin(client)
        prefs = client.get("/api/settings", headers=auth).json()["prefs"]
        before_top_k = prefs["rag"]["top_k"]
        response = client.put("/api/settings", headers=auth, json={
            "rag": {"top_k": before_top_k + 2},
            "notifications": {"channels": [{
                "id": "slack-ops", "type": "slack", "name": "Ops",
                "config": {"url": "https://hooks.slack.com/services/T000/B000/XXXXSECRET"},
            }]},
            "sources": [{
                "id": "es-a", "source_type": "elasticsearch",
                "config": {"url": "https://reader:hunter2@es.example:9200/logs"},
            }],
        })
        assert response.status_code == 200, response.text
        rows = _by_action(_rows(client, api), "settings.updated")
    assert len(rows) == 1
    row = rows[0]
    assert row["outcome"] == "success" and row["actor_type"] == "human"
    assert row["action_type"] == "status" and row["surface"] == "settings"
    assert row["result_summary"] == "updated settings: notifications, rag, sources"
    fields = {c["field"]: c for c in row["changes"]}
    assert fields["rag.top_k"] == {
        "field": "rag.top_k", "before": str(before_top_k), "after": str(before_top_k + 2), "secret": False,
    }
    assert fields["notifications.channels[slack-ops].config.url"]["after"] == "https://hooks.slack.com"
    assert fields["sources[es-a].config.url"]["after"] == "https://es.example:9200"
    assert row["target"]["type"] == "setting"
    assert set(row["target"]["id"].split(",")) == {"notifications", "rag", "sources"}
    stored = json.dumps(row)
    for leaked in ("XXXXSECRET", "T000/B000", "hunter2", "reader:"):
        assert leaked not in stored


def test_a_settings_save_is_refused_with_503_when_the_audit_cannot_be_written(monkeypatch) -> None:
    client, api = _client()
    with client:
        auth = _admin(client)
        before = client.get("/api/settings", headers=auth).json()["prefs"]["rag"]["top_k"]
        _break_strict_appends(monkeypatch, _state(api))
        response = client.put("/api/settings", headers=auth, json={"rag": {"top_k": before + 1}})
        assert response.status_code == 503
        assert response.json()["detail"]["code"] == "audit_unavailable"
        monkeypatch.undo()
        assert client.get("/api/settings", headers=auth).json()["prefs"]["rag"]["top_k"] == before


def test_account_role_and_org_changes_are_refused_when_the_audit_is_down(monkeypatch) -> None:
    client, api = _client(rbac=True)
    with client:
        auth = _admin(client)
        _fresh(client, auth)
        state = _state(api)
        branding_before = client.get("/api/branding").json()
        _break_strict_appends(monkeypatch, state)
        assert client.post("/api/users", headers=auth,
                           json={"username": "nobody", "password": "nobody-pass1"}).status_code == 503
        assert client.post("/api/roles", headers=auth,
                           json={"name": "ghost", "grants": {"cases": ["read"]}}).status_code == 503
        branding = dict(branding_before, org_name="Changed while down")
        assert client.put("/api/branding", headers=auth, json=branding).status_code == 503
        assert client.put("/api/terminology", headers=auth,
                          json={"terminology": {"case": "Ticket"}}).status_code == 503
        assert client.portal.call(lambda: state.users.get("nobody")) is None
        assert client.portal.call(lambda: state.custom_roles.get("ghost")) is None
        assert state.prefs.branding.org_name == branding_before.get("org_name")
        assert "case" not in state.prefs.customization.terminology


def test_the_curated_settings_routes_write_settings_rows() -> None:
    client, api = _client()
    with client:
        auth = _admin(client)
        branding = client.get("/api/branding").json()
        branding["org_name"] = "Example Org"
        assert client.put("/api/branding", headers=auth, json=branding).status_code == 200
        assert client.put("/api/terminology", headers=auth,
                          json={"terminology": {"case": "Incident"}}).status_code == 200
        rows = _by_action(_rows(client, api), "settings.updated")
    summaries = {r["result_summary"]: r for r in rows}
    branding_row = summaries["updated branding"]
    assert any(c["field"] == "branding.org_name" and c["after"] == "Example Org"
               for c in branding_row["changes"])
    assert branding_row["target"]["id"] == "branding"
    terms = summaries["updated terminology"]
    assert any(c["field"] == "customization.terminology.case" and c["after"] == "Incident"
               for c in terms["changes"])
    assert _target(terms) == {"type": "setting", "id": "customization", "label": "Customization"}


def test_identity_and_settings_rows_go_to_the_real_log_with_demo_mode_on() -> None:
    client, api = _client()
    with client:
        auth = _admin(client)
        state = _state(api)
        client.portal.call(state.enable_demo)
        try:
            response = client.put("/api/settings", headers=auth, json={"rag": {"top_k": 7}})
            assert response.status_code == 200, response.text
            made = client.post("/api/users", headers=auth,
                               json={"username": "demo-era", "password": "demo-era-pass"})
            assert made.status_code == 200, made.text
            _login(client, "nobody", "wrong-pass")
            demo_rows = _rows(client, api, repo=state.demo_audit)
            real_rows = _rows(client, api)
        finally:
            client.portal.call(state.disable_demo)
        after_rows = _rows(client, api)
    for action in ("settings.updated", "user.created", "auth.login_failed"):
        assert _by_action(real_rows, action), action
        assert not _by_action(demo_rows, action), action
        # Real rows outlive Demo Mode (the Demo store is dropped when it ends).
        assert _by_action(after_rows, action), action


def test_a_personal_dashboard_hide_is_audited_and_other_preferences_are_not() -> None:
    client, api = _client()
    with client:
        auth = _admin(client)
        hide = client.put("/api/prefs/user", headers=auth,
                          json={"misc": {"dashboards_hidden": ["builtin:soc-operations"]}})
        assert hide.status_code == 200, hide.text
        same = client.put("/api/prefs/user", headers=auth,
                          json={"misc": {"dashboards_hidden": ["builtin:soc-operations"]}})
        assert same.status_code == 200
        other = client.put("/api/prefs/user", headers=auth, json={"misc": {"density": "compact"}})
        assert other.status_code == 200
        rows = _by_action(_rows(client, api), "user.preferences_updated")
    assert len(rows) == 1
    assert rows[0]["changes"] == [{
        "field": "misc.dashboards_hidden", "before": None,
        "after": '["builtin:soc-operations"]', "secret": False,
    }]
    assert _target(rows[0]) == {"type": "user", "id": "Admin", "label": "Admin"}


# --------------------------------------------------------------------------- #
# The settings compare-and-swap
# --------------------------------------------------------------------------- #
class _FakeRepo:
    def __init__(self) -> None:
        self.rows: list[dict[str, Any]] = []

    async def record_strict(self, **kwargs: Any) -> None:
        self.rows.append(kwargs)


class _PrefsState:
    """``state.prefs`` + ``mutate_prefs`` whose first save meets a racing writer."""

    def __init__(self, race: Any = None) -> None:
        self.prefs = Preferences()
        self.control_audit = _FakeRepo()
        self._race = race
        self.saves = 0

    async def mutate_prefs(self, mutate: Any) -> Preferences:
        if self._race is not None:
            race, self._race = self._race, None
            self.prefs = race(self.prefs)
        new = mutate(self.prefs)
        self.prefs = new
        self.saves += 1
        return new


def _set_top_k(value: int):
    def transform(current: Preferences) -> Preferences:
        return current.model_copy(update={"rag": current.rag.model_copy(update={"top_k": value})})
    return transform


async def test_an_unrelated_racing_save_is_kept_and_is_no_conflict() -> None:
    def race(current: Preferences) -> Preferences:
        return current.model_copy(update={"branding": current.branding.model_copy(update={"org_name": "Other"})})

    state = _PrefsState(race)
    before, after = await audited_prefs_write(
        state, transform=_set_top_k(9), actor="admin", context=None, summary="updated settings: rag",
    )
    assert after.rag.top_k == 9 and after.branding.org_name == "Other"
    assert [r["action"] for r in state.control_audit.rows] == ["settings.updated"]
    assert state.control_audit.rows[0]["changes"][0].field == "rag.top_k"


async def test_a_racing_save_of_the_same_field_fails_the_first_attempt_and_retries() -> None:
    def race(current: Preferences) -> Preferences:
        return _set_top_k(3)(current)

    state = _PrefsState(race)
    _before, after = await audited_prefs_write(
        state, transform=_set_top_k(9), actor="admin", context={"request_id": "req-cas-retry-1"},
        summary="updated settings: rag",
    )
    assert after.rag.top_k == 9
    actions = [(r["action"], r["outcome"]) for r in state.control_audit.rows]
    assert actions == [
        ("settings.updated", "success"),
        ("settings.update_failed", "failure"),
        ("settings.updated", "success"),
    ]
    first, failure, second = state.control_audit.rows
    assert first["request_id"] == failure["request_id"] == second["request_id"] == "req-cas-retry-1"
    assert "another save changed these settings" in failure["result_summary"]
    # The retry records the true "before" (the racing writer's value).
    assert second["changes"][0].before == "3" and second["changes"][0].after == "9"
    # The retry's row says which attempt it is; the first row is as it always was.
    assert first.get("tool_input") is None
    assert second["tool_input"] == {"attempt": 2, "of": 3}


async def test_a_refused_edit_writes_no_row() -> None:
    from fastapi import HTTPException

    def refuse(_current: Preferences) -> Preferences:
        raise HTTPException(status_code=403, detail="Settings are in read-only mode")

    state = _PrefsState()
    with pytest.raises(HTTPException):
        await audited_prefs_write(state, transform=refuse, actor="admin", context=None, summary="x")
    assert state.control_audit.rows == [] and state.saves == 0


# --------------------------------------------------------------------------- #
# GET /api/auth/me object_scoped (D16)
# --------------------------------------------------------------------------- #
def test_auth_me_reports_whether_row_level_scope_applies() -> None:
    client, _api = _client(object_scope=True)
    with client:
        auth = _admin(client)
        assert client.get("/api/auth/me", headers=auth).json()["object_scoped"] is False
        client.post("/api/users", headers=auth,
                    json={"username": "tier1", "password": "tier1-pass", "role": "analyst_tier1"})
        token = _login(client, "tier1", "tier1-pass").json()["token"]
        me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"}).json()
    assert me["object_scoped"] is True


def test_auth_me_is_not_scoped_by_default() -> None:
    client, _api = _client()
    with client:
        auth = _admin(client)
        assert client.get("/api/auth/me", headers=auth).json()["object_scoped"] is False


# --------------------------------------------------------------------------- #
# The audit context helper
# --------------------------------------------------------------------------- #
def test_audit_context_never_raises_and_names_the_request() -> None:
    class Broken:
        @property
        def headers(self):  # noqa: ANN201
            raise RuntimeError("boom")

        client = None
        cookies: dict[str, str] = {}
        app = None
        state = None

    context = audit_context(Broken())
    assert context.client is None and context.session_ref is None and context.actor_role is None
    assert context.record_fields() == {"client": None, "session_ref": None, "actor_role": None,
                                       "request_id": None}


# --------------------------------------------------------------------------- #
# The investigation pipeline (run_id, actor_type)
# --------------------------------------------------------------------------- #
def _cluster(ip: str):
    from app.engine.correlation import cluster_from_events

    base = 1_700_000_000_000
    events = [make_raw_event(id=f"{ip}-{i}", ip=ip, ts_millis=base + i * 1000) for i in range(3)]
    return cluster_from_events(EntityType.IP, ip, events)


def _verdict_json() -> str:
    return json.dumps({
        "action": "final", "reasoning": "scripted",
        "verdict": {
            "verdict": "TRUE_POSITIVE", "confidence": 0.9,
            "evidence": [{"summary": "scripted", "event_ids": ["e0"]}],
            "mitre": ["T1110"], "recommended_action": "block", "reproduce_query": "x",
        },
    })


async def test_each_investigation_stamps_one_run_id_and_the_actor_kind(app_state: AppState, mock_provider) -> None:
    from app.agents.pipeline import INVESTIGATION_RUN_PREFIX, current_investigation_run_id

    for _ in range(2):
        mock_provider.push("router", json.dumps({"bucket": "needs_strong_model", "confidence": 0.9, "reason": "x"}))
        mock_provider.push("investigator", _verdict_json())
    first = await app_state.pipeline.investigate_cluster(_cluster("1.2.3.4"), SourceSurface.INVESTIGATE, app_state.prefs)
    second = await app_state.pipeline.investigate_cluster(_cluster("5.6.7.8"), SourceSurface.INVESTIGATE, app_state.prefs)
    assert current_investigation_run_id() is None
    rows = await app_state.audit.records(limit=1000)
    by_case: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        by_case.setdefault(row.get("case_id") or "", []).append(row)
    run_ids = []
    for case in (first, second):
        # The run engine's attachment and lookup rows (action_type runbook) are not
        # pipeline rows and carry no run id (SPEC §4.5.3).
        attached = [r for r in by_case[case.case_id] if r.get("action") == "run.attached"]
        assert len(attached) == 1 and attached[0].get("run_id") is None
        assert attached[0]["actor"] == "runbook_selector" and attached[0].get("actor_type") == "system"
        case_rows = [r for r in by_case[case.case_id] if r.get("action_type") != "runbook"]
        ids = {r.get("run_id") for r in case_rows}
        assert len(ids) == 1, ids
        run_id = ids.pop()
        assert run_id and run_id.startswith(INVESTIGATION_RUN_PREFIX)
        run_ids.append(run_id)
        kinds = {r["actor"]: r.get("actor_type") for r in case_rows}
        assert kinds.get("router") == "agent"
        assert kinds.get("case_manager") == "system"
    assert run_ids[0] != run_ids[1]


async def test_rows_outside_an_investigation_carry_no_run_id() -> None:
    from app.agents.pipeline import RunStampedAudit

    repo = _FakeRepo()

    class _Inner:
        async def record(self, **kwargs: Any) -> None:
            repo.rows.append(kwargs)

    audit = RunStampedAudit(_Inner())
    await audit.record(action_type="poll", actor="poller")
    await audit.record(action_type="prompt", actor="router", actor_type="service")
    assert repo.rows[0]["actor_type"] == "system" and "run_id" not in repo.rows[0]
    assert repo.rows[1]["actor_type"] == "service"  # a caller's own value is kept


def test_store_bookkeeping_stamps_are_not_recorded_as_changes() -> None:
    changes = diff_changes(
        {"sources": [{"id": "a", "enabled": True, "created_at": "2026-01-01T00:00:00Z",
                      "updated_at": "2026-01-01T00:00:00Z"}]},
        {"sources": [{"id": "a", "enabled": False, "created_at": "2026-01-01T00:00:00Z",
                      "updated_at": "2026-02-01T00:00:00Z"}]},
    )
    assert [c.field for c in changes] == ["sources[a].enabled"]


def test_the_real_app_puts_the_request_id_outermost() -> None:
    from app.main import app

    assert app.user_middleware[0].cls is RequestIdMiddleware


def test_an_audit_log_view_row_carries_the_request_context() -> None:
    client, api = _client()
    with client:
        auth = _admin(client)
        response = client.get("/api/audit", params={"scope": "people"},
                              headers={**auth, REQUEST_ID_HEADER: "view-req-00042",
                                       _PEER_HEADER: "203.0.113.77"})
        assert response.status_code == 200, response.text
        rows = _by_action(_rows(client, api), "audit.viewed")
    assert rows, "the audit log read writes its view row"
    row = rows[0]
    assert row["request_id"] == "view-req-00042"
    assert row["actor_role"] == "super_admin" and row["session_ref"]
    _assert_client(row, "203.0.113.77", "peer")


async def test_a_save_that_keeps_racing_the_same_field_gives_up_with_409() -> None:
    from fastapi import HTTPException

    class _AlwaysRacing(_PrefsState):
        async def mutate_prefs(self, mutate: Any) -> Preferences:
            self.prefs = _set_top_k(self.prefs.rag.top_k + 1)(self.prefs)
            return await super().mutate_prefs(mutate)

    state = _AlwaysRacing()
    with pytest.raises(HTTPException) as caught:
        await audited_prefs_write(state, transform=_set_top_k(42), actor="admin", context=None,
                                  summary="updated settings: rag", attempts=3)
    assert caught.value.status_code == 409
    assert caught.value.detail["code"] == "settings_conflict"
    outcomes = [r["outcome"] for r in state.control_audit.rows]
    assert outcomes == ["success", "failure"] * 3
    attempts = [r.get("tool_input") for r in state.control_audit.rows if r["outcome"] == "success"]
    assert attempts == [None, {"attempt": 2, "of": 3}, {"attempt": 3, "of": 3}]
    assert state.prefs.rag.top_k != 42


async def test_a_retry_keeps_the_callers_inputs_beside_its_attempt_number() -> None:
    state = _PrefsState(lambda current: _set_top_k(3)(current))
    await audited_prefs_write(
        state, transform=_set_top_k(9), actor="admin", context=None, summary="x",
        tool_input={"route": "branding"},
    )
    inputs = [r.get("tool_input") for r in state.control_audit.rows if r["outcome"] == "success"]
    assert inputs == [{"route": "branding"}, {"route": "branding", "attempt": 2, "of": 3}]


async def test_the_swap_compares_raw_values_not_the_recorded_text() -> None:
    """Two stored values that differ only past the 500 characters a change records
    are still a conflict: the row would name the wrong before value."""
    long_a = "a" * 600
    long_b = "a" * 599 + "b"

    def set_org(value: str):
        def transform(current: Preferences) -> Preferences:
            return current.model_copy(update={"branding": current.branding.model_copy(
                update={"footer_text": value})})
        return transform

    def race(current: Preferences) -> Preferences:
        return set_org(long_b)(current)

    state = _PrefsState(race)
    state.prefs = set_org(long_a)(state.prefs)
    _before, after = await audited_prefs_write(
        state, transform=set_org("short"), actor="admin", context=None, summary="updated branding",
    )
    assert after.branding.footer_text == "short"
    assert [r["outcome"] for r in state.control_audit.rows] == ["success", "failure", "success"]


# --------------------------------------------------------------------------- #
# Review fixes (A4b-1 fix stage): secrets inside lists and credential names
# --------------------------------------------------------------------------- #
def test_credential_names_a_channel_or_connector_reads_are_never_recorded() -> None:
    secrets = {
        "routing_key": "R0UTINGKEY-abcdef0123456789", "integration_key": "int-key-0001",
        "hmac_key": "hm-secret-0001", "signing_key": "sg-secret-0001",
        "key": "plain-key-0001", "webhook_signature_key": "wsk-0001", "bot_token": "bt-0001",
    }
    changes = diff_changes(
        {"notifications": {"channels": []}},
        {"notifications": {"channels": [{"id": "pd", "type": "pagerduty", "config": dict(secrets)}]}},
    )
    by_field = {c.field: c for c in changes}
    for name in secrets:
        change = by_field[f"notifications.channels[pd].config.{name}"]
        assert (change.before, change.after, change.secret) == (None, None, True), name
    assert by_field["notifications.channels[pd].type"].after == "pagerduty"
    text = repr([c.model_dump() for c in changes])
    for value in secrets.values():
        assert value not in text
    # A credential name is withheld whatever its value's type; a number named like a
    # limit stays readable.
    assert is_secret_key("routing_key", 12345) and is_secret_key("integration_key", {"a": 1})
    assert not is_secret_key("max_tokens", 1500) and not is_secret_key("top_k", 5)


def test_a_true_or_false_flag_is_never_secret_but_a_password_still_is() -> None:
    changes = diff_changes(
        {"must_change_password": False, "password_hash": "hash-one", "mfa_required": False},
        {"must_change_password": True, "password_hash": "hash-two", "mfa_required": True},
    )
    by_field = {c.field: c.model_dump() for c in changes}
    assert by_field["must_change_password"] == {
        "field": "must_change_password", "before": "false", "after": "true", "secret": False,
    }
    assert by_field["password_hash"] == {
        "field": "password_hash", "before": None, "after": None, "secret": True,
    }
    assert "hash-one" not in repr(by_field) and "hash-two" not in repr(by_field)
    # Under a secret container even a flag stays withheld.
    nested = diff_changes({"connector_secrets": {"s1": {"enabled": False}}},
                          {"connector_secrets": {"s1": {"enabled": True}}})
    assert (nested[0].before, nested[0].after, nested[0].secret) == (None, None, True)


def test_every_item_of_a_list_is_redacted_whatever_the_list_is_called() -> None:
    before = {"sources": [{"id": "s", "config": {"hosts": ["https://es-a:9200"], "headers": [],
                                                 "items": []}}]}
    after = {"sources": [{"id": "s", "config": {
        "hosts": ["https://elastic:hunter2@es-a:9200", "https://es-b:9200"],
        "headers": ["Authorization: Bearer abcdefghijklmnop",
                    "Proxy-Authorization: Basic dXNlcjpwYXNzd29yZA=="],
        "items": [{"user": "svc", "password": "P4ssw0rd!"},
                  {"nested": {"api_key": "k-1234567890"}, "tags": ["x"]}],
    }}]}
    changes = diff_changes(before, after)
    by_field = {c.field: c for c in changes}
    hosts = by_field["sources[s].config.hosts"]
    assert json.loads(hosts.after) == ["https://es-a:9200", "https://es-b:9200"]
    assert hosts.secret is True
    headers = by_field["sources[s].config.headers"]
    assert json.loads(headers.after) == ["Authorization: [REDACTED]",
                                         "Proxy-Authorization: [REDACTED]"]
    assert headers.secret is True
    items = by_field["sources[s].config.items"]
    assert json.loads(items.after) == [
        {"user": "svc", "password": "[REDACTED]"},
        {"nested": {"api_key": "[REDACTED]"}, "tags": ["x"]},
    ]
    assert items.secret is True
    text = repr([c.model_dump() for c in changes])
    for leaked in ("hunter2", "elastic:", "abcdefghijklmnop", "dXNlcjpwYXNzd29yZA", "P4ssw0rd!",
                   "k-1234567890"):
        assert leaked not in text


def test_a_password_holding_an_at_sign_is_removed_whole() -> None:
    other = diff_changes({"note": "x"}, {"note": "see https://user:p@ssword@host.example/x"})
    assert other[0].after == "see https://host.example/x"
    assert other[0].secret is True and "ssword" not in repr(other[0].model_dump())
    url = diff_changes({"s": {"url": "https://a.example"}}, {"s": {"url": "https://u:p@ss@b.example:8443/p"}})
    assert url[0].after == "https://b.example:8443" and "ss@" not in repr(url[0].model_dump())
    # An address without credentials is untouched, and so is an email in plain text.
    assert redact_text("mail admin@example.com or open https://host.example/a@b")[0] == \
        "mail admin@example.com or open https://host.example/a@b"


def test_a_list_going_from_empty_to_keyed_items_is_recorded_by_its_items_only() -> None:
    added = diff_changes({"n": {"channels": []}},
                         {"n": {"channels": [{"id": "a", "type": "slack"}]}})
    assert [(c.field, c.before, c.after) for c in added] == [
        ("n.channels[a].id", None, "a"), ("n.channels[a].type", None, "slack"),
    ]
    removed = diff_changes({"n": {"channels": [{"id": "a", "type": "slack"}]}},
                           {"n": {"channels": []}})
    assert [(c.field, c.before, c.after) for c in removed] == [
        ("n.channels[a].id", "a", None), ("n.channels[a].type", "slack", None),
    ]
    gained = diff_changes({"misc": {}}, {"misc": {"density": "compact"}})
    assert [c.field for c in gained] == ["misc.density"]
    # A list that never held keyed items is still one value.
    plain = diff_changes({"tags": ["a"]}, {"tags": []})
    assert [(c.field, c.before, c.after) for c in plain] == [("tags", '["a"]', "[]")]


def test_a_pagerduty_routing_key_saved_through_settings_never_reaches_the_record() -> None:
    client, api = _client()
    with client:
        auth = _admin(client)
        response = client.put("/api/settings", headers=auth, json={
            "notifications": {"channels": [{
                "id": "pd", "type": "pagerduty", "name": "On call",
                "config": {"routing_key": "R0UTINGKEY-abcdef0123456789",
                           "headers": ["Authorization: Bearer abcdefghijklmnop"]},
            }]},
        })
        assert response.status_code == 200, response.text
        row = _by_action(_rows(client, api), "settings.updated")[-1]
    fields = {c["field"]: c for c in row["changes"]}
    assert fields["notifications.channels[pd].config.routing_key"] == {
        "field": "notifications.channels[pd].config.routing_key", "before": None, "after": None,
        "secret": True,
    }
    # The container is not recorded as "removed" next to the channel that was added.
    assert "notifications.channels" not in fields
    stored = repr(row)
    assert "R0UTINGKEY" not in stored and "abcdefghijklmnop" not in stored


# --------------------------------------------------------------------------- #
# Review fixes: the client address behind several proxies
# --------------------------------------------------------------------------- #
def test_behind_a_trusted_load_balancer_the_client_is_the_first_untrusted_hop() -> None:
    proxies = TrustedProxies("172.30.0.0/16,10.0.0.0/8")

    def ip_for(header: str) -> tuple[str | None, str]:
        client = audit_client_ip(_Request("172.30.0.9", [("X-Forwarded-For", header)]), proxies)
        return client.ip, client.ip_source

    # LB (10.0.0.5) -> bundled proxy (172.30.0.9) -> backend: the LB's own entry is
    # skipped and the address the LB saw is the client.
    assert ip_for("6.6.6.6, 203.0.113.7, 10.0.0.5") == ("203.0.113.7", "trusted_proxy")
    # A forged leading entry inside a trusted range still never wins.
    assert ip_for("10.0.0.7, 203.0.113.7, 10.0.0.5") == ("203.0.113.7", "trusted_proxy")
    # Every hop is a trusted proxy: the furthest one seen is the client.
    assert ip_for("10.0.0.7, 10.0.0.5") == ("10.0.0.7", "trusted_proxy")
    # An entry that cannot be parsed stops the walk: the peer is recorded.
    assert ip_for("203.0.113.7, unknown, 10.0.0.5") == ("172.30.0.9", "peer")
    # Padding never pushes the entry the trusted proxy appended out of the walk: only
    # the last 32 entries are read, and the rightmost untrusted one is the client.
    padded = ", ".join(["1.1.1.1"] * 40 + ["203.0.113.7"])
    assert ip_for(padded) == ("203.0.113.7", "trusted_proxy")
    assert ip_for(", ".join(["10.0.0.1"] * 40 + ["203.0.113.7"])) == ("203.0.113.7", "trusted_proxy")
    assert ip_for(", ".join(["junk"] * 40 + ["203.0.113.7", "10.0.0.5"])) == (
        "203.0.113.7", "trusted_proxy")
    # A window holding only trusted hops with more entries beyond it: what lies left
    # of the window is never read and never becomes the client.
    beyond = ", ".join(["6.6.6.6"] + ["10.0.0.1"] * 32)
    assert ip_for(beyond) == ("172.30.0.9", "peer")
    # Exactly 32 trusted hops (nothing beyond the window): the furthest one is kept.
    assert ip_for(", ".join(["10.0.0.7"] + ["10.0.0.1"] * 31)) == ("10.0.0.7", "trusted_proxy")


def test_a_padded_forwarded_header_keeps_its_tail_so_the_appended_address_survives() -> None:
    proxies = TrustedProxies("172.30.0.9")
    header = ", ".join(["1.1.1.1"] * 80 + ["203.0.113.7"])
    client = audit_client_ip(_Request("172.30.0.9", [("X-Forwarded-For", header)]), proxies)
    assert client.ip == "203.0.113.7" and client.ip_source == "trusted_proxy"
    kept = client.forwarded_for or ""
    assert len(kept) == 256
    assert kept.startswith("...") and kept.endswith(", 203.0.113.7")
    # A short header is kept whole, with no marker.
    short = audit_client_ip(_Request("172.30.0.9", [("X-Forwarded-For", "203.0.113.7")]), proxies)
    assert short.forwarded_for == "203.0.113.7"


def test_a_failed_sign_in_through_the_proxy_records_the_caller_however_it_pads_the_header() -> None:
    client, api = _client()
    with client:
        # nginx appends the caller's real address after whatever the caller sent.
        padded = ", ".join(["1.1.1.1"] * 40 + ["203.0.113.77"])
        response = client.post(
            "/api/auth/login", json={"username": "mallory", "password": "nope-nope"},
            headers={_PEER_HEADER: "172.30.0.9", "X-Forwarded-For": padded},
        )
        assert response.status_code == 401
        rows = _by_action(_rows(client, api), "auth.login_failed")
    assert len(rows) == 1
    _assert_client(rows[0], "203.0.113.77", "trusted_proxy")
    forwarded = rows[0]["client"]["forwarded_for"]
    assert forwarded.startswith("...") and forwarded.endswith("203.0.113.77")


def test_a_proxy_name_keeps_its_addresses_through_a_failed_lookup() -> None:
    from app.audit.context import TRUSTED_PROXY_FAILED_ROUNDS_TO_FORGET

    answers: dict[str, Any] = {"tlsoc-webui": ["172.18.0.5"]}

    def resolver(name: str) -> list[str]:
        value = answers[name]
        if value is None:
            raise OSError("temporary failure in name resolution")
        return value

    proxies = TrustedProxies("tlsoc-webui", resolver=resolver)
    proxies.refresh()
    assert proxies.matches("172.18.0.5")
    answers["tlsoc-webui"] = None
    for _ in range(TRUSTED_PROXY_FAILED_ROUNDS_TO_FORGET - 1):
        proxies.refresh()
        assert proxies.matches("172.18.0.5"), "one failed lookup never drops the proxy"
    # A success in between resets the count.
    answers["tlsoc-webui"] = ["172.18.0.5"]
    proxies.refresh()
    answers["tlsoc-webui"] = []  # an empty answer is a failed lookup too
    for _ in range(TRUSTED_PROXY_FAILED_ROUNDS_TO_FORGET - 1):
        proxies.refresh()
    assert proxies.matches("172.18.0.5")
    proxies.refresh()
    assert not proxies.matches("172.18.0.5"), "forgotten after the failed rounds in a row"
    answers["tlsoc-webui"] = ["172.18.0.6"]
    proxies.refresh()
    assert proxies.matches("172.18.0.6") and not proxies.matches("172.18.0.5")


# --------------------------------------------------------------------------- #
# Review fixes: rows written before sign-in never borrow a cookie in the browser
# --------------------------------------------------------------------------- #
def test_a_failed_sign_in_never_borrows_the_role_or_session_of_a_cookie_in_the_browser() -> None:
    client, api = _client()
    with client:
        ok = _login(client)  # Admin's cookie stays in the client's jar
        assert ok.status_code == 200 and client.cookies.get("tlsoc_token")
        state = _state(api)
        admin_ref = state.auth.session_ref(state.auth.claims_of(ok.json()["token"])["sid"])
        failed = client.post("/api/auth/login",
                             json={"username": "mallory", "password": "wrong-pass-1"})
        assert failed.status_code == 401
        rows = _by_action(_rows(client, api), "auth.login_failed")
    assert len(rows) == 1
    row = rows[0]
    assert row["actor"] == "mallory" and row["outcome"] == "failure"
    assert "actor_role" not in row and "session_ref" not in row
    assert admin_ref not in json.dumps(row)


def test_the_audit_context_of_a_row_before_sign_in_never_reads_the_request_credential() -> None:
    client, api = _client()
    with client:
        token = _admin(client)["Authorization"].split(" ", 1)[1]
        state = _state(api)

        class _WithCookie:
            app = api
            cookies = {"tlsoc_token": token}
            client = type("C", (), {"host": "203.0.113.8"})()

            def __init__(self) -> None:
                from starlette.datastructures import Headers

                self.headers = Headers(raw=[])
                self.state = type("S", (), {})()

        borrowed = audit_context(_WithCookie())
        anonymous = audit_context(_WithCookie(), from_request=False)
    assert borrowed.actor_role == "super_admin" and borrowed.session_ref
    assert anonymous.actor_role is None and anonymous.session_ref is None
    assert anonymous.actor == "" and anonymous.client is not None
    assert anonymous.client.ip == "203.0.113.8"
    assert state is not None


# --------------------------------------------------------------------------- #
# Review fixes: identity rows are best effort WITH a signal
# --------------------------------------------------------------------------- #
def test_a_dropped_identity_row_is_counted_and_never_blocks_sign_in_or_out(monkeypatch) -> None:
    from app.audit import identity

    identity.DROPS.reset()
    client, api = _client()
    with client:
        _break_strict_appends(monkeypatch, _state(api))
        signed_in = _login(client)
        assert signed_in.status_code == 200, signed_in.text
        auth = {"Authorization": f"Bearer {signed_in.json()['token']}"}
        assert client.post("/api/auth/logout", headers=auth).status_code == 200
        failed = client.post("/api/auth/login", json={"username": "x", "password": "wrong-pass"})
        assert failed.status_code == 401
    counts = identity.dropped_by_action()
    assert counts.get("auth.login") == 1
    assert counts.get("session.created") == 1
    assert counts.get("auth.logout") == 1
    assert counts.get("auth.login_failed") == 1
    assert identity.dropped_count() == sum(counts.values())
    identity.DROPS.reset()


def test_refresh_token_reuse_is_recorded_as_the_system_revoking_the_account() -> None:
    from app.stores.sessions import hash_refresh, new_refresh_token, new_sid

    client, api = _client()
    with client:
        state = _state(api)
        sid = new_sid()
        first = new_refresh_token()
        client.portal.call(lambda: state.sessions.create(
            sid=sid, username="Admin", token_version=0, refresh_hash=hash_refresh(first),
            idle_timeout=10_000, absolute_lifetime=100_000,
        ))
        rotated = client.post("/api/auth/refresh", json={"refresh_token": first})
        assert rotated.status_code == 200, rotated.text
        rotated_sid = rotated.json()["sid"]
        reused = client.post("/api/auth/refresh", json={"refresh_token": first})
        assert reused.status_code == 401
        rows = _rows(client, api)
    refreshed = _by_action(rows, "session.refreshed")
    assert len(refreshed) == 1 and refreshed[0]["actor"] == "Admin"
    assert _target(refreshed[0]) == {"type": "user", "id": "Admin", "label": "Admin"}
    revoked = [r for r in _by_action(rows, "session.revoked")
               if (r.get("tool_input") or {}).get("reason") == "refresh_reuse_detected"]
    assert len(revoked) == 1
    row = revoked[0]
    assert row["actor"] == "system" and row["actor_type"] == "system"
    assert _target(row) == {"type": "user", "id": "Admin", "label": "Admin"}
    # The session the reused token belongs to (re-keyed to its rotated sid).
    assert row["tool_input"]["session"] == state.auth.session_ref(rotated_sid)
    assert row["tool_input"]["session"] != state.auth.session_ref(sid)
    assert row["tool_input"]["scope"] == "all"
    assert "actor_role" not in row and "session_ref" not in row


# --------------------------------------------------------------------------- #
# Review fixes: a saved change is never paired with a "not applied" row
# --------------------------------------------------------------------------- #
def test_a_failing_refresh_after_a_saved_update_writes_no_failure_row(monkeypatch) -> None:
    api, shim = _app()
    client = TestClient(shim, raise_server_exceptions=False)
    with client:
        auth = _admin(client)
        made = client.post("/api/users", headers=auth,
                           json={"username": "rhea", "password": "rhea-pass-123"})
        assert made.status_code == 200, made.text
        state = _state(api)

        async def _boom() -> None:
            raise RuntimeError("synced view unavailable")

        monkeypatch.setattr(state, "refresh_users", _boom)
        response = client.put("/api/users/rhea", headers=auth, json={"phone": "+1 555 0100"})
        assert response.status_code == 500  # the refresh error keeps its old behaviour
        monkeypatch.undo()
        stored = client.portal.call(lambda: state.users.get("rhea"))
        rows = _rows(client, api)
    assert stored is not None and stored.phone == "+1 555 0100"
    updated = [r for r in _by_action(rows, "user.updated") if r["target"]["id"] == "rhea"]
    assert len(updated) == 1 and updated[0]["outcome"] == "success"
    assert not [r for r in rows if str(r.get("action") or "").endswith("_failed")]


# --------------------------------------------------------------------------- #
# Review fixes: source and setup writers are audited first
# --------------------------------------------------------------------------- #
def test_source_add_edit_secrets_and_delete_are_audited_without_credentials() -> None:
    client, api = _client()
    with client:
        auth = _admin(client)
        added = client.post("/api/sources", headers=auth, json={
            "id": "mq-1", "source_type": "rabbitmq", "display_name": "Broker",
            "config": {"url": "amqp://guest:hunter2@mq.internal:5672/vhost", "queue": "alerts"},
        })
        assert added.status_code == 200, added.text
        edited = client.post("/api/sources", headers=auth, json={
            "id": "mq-1", "source_type": "rabbitmq", "display_name": "Broker", "enabled": False,
            "config": {"url": "amqp://guest:hunter3@mq.internal:5672/vhost", "queue": "alerts"},
        })
        assert edited.status_code == 200, edited.text
        secrets = client.post("/api/sources/mq-1/secrets", headers=auth,
                              json={"password": "s3cr3t-value", "token": None})
        assert secrets.status_code == 200, secrets.text
        assert secrets.json()["configured_secrets"] == ["password"]
        deleted = client.delete("/api/sources/mq-1", headers=auth)
        assert deleted.status_code == 200, deleted.text
        rows = _rows(client, api)
    created = _by_action(rows, "source.created")
    assert len(created) == 1
    row = created[0]
    assert _target(row) == {"type": "source", "id": "mq-1", "label": "Broker"}
    assert row["surface"] == "sources" and row["actor"] == "Admin" and row["request_id"]
    fields = {c["field"]: c for c in row["changes"]}
    # The manifest marks the broker URL secret: withheld whole, not just reduced.
    assert fields["sources[mq-1].config.url"] == {
        "field": "sources[mq-1].config.url", "before": None, "after": None, "secret": True,
    }
    assert fields["sources[mq-1].config.queue"]["after"] == "alerts"
    updated = _by_action(rows, "source.updated")
    assert len(updated) == 1
    assert {c["field"] for c in updated[0]["changes"]} >= {"sources[mq-1].enabled"}
    secret_rows = _by_action(rows, "source.secrets_updated")
    assert len(secret_rows) == 1
    assert secret_rows[0]["changes"] == [
        {"field": "sources[mq-1].secrets.password", "before": None, "after": None, "secret": True},
        {"field": "sources[mq-1].secrets.token", "before": None, "after": None, "secret": True},
    ]
    assert "password set" in secret_rows[0]["result_summary"]
    assert "token cleared" in secret_rows[0]["result_summary"]
    gone = _by_action(rows, "source.deleted")
    assert len(gone) == 1 and _target(gone[0])["id"] == "mq-1"
    gone_fields = {c["field"]: c for c in gone[0]["changes"]}
    assert gone_fields["sources[mq-1].config.url"] == {
        "field": "sources[mq-1].config.url", "before": None, "after": None, "secret": True,
    }
    stored = json.dumps(rows)
    for leaked in ("hunter2", "hunter3", "guest:", "s3cr3t-value"):
        assert leaked not in stored


def test_a_settings_save_withholds_a_connector_field_its_manifest_marks_secret() -> None:
    client, api = _client()
    with client:
        auth = _admin(client)
        response = client.put("/api/settings", headers=auth, json={"sources": [{
            "id": "mq-s", "source_type": "rabbitmq",
            "config": {"url": "amqp://guest:hunter2@mq.internal:5672/vhost"},
        }]})
        assert response.status_code == 200, response.text
        row = _by_action(_rows(client, api), "settings.updated")[-1]
    fields = {c["field"]: c for c in row["changes"]}
    assert fields["sources[mq-s].config.url"] == {
        "field": "sources[mq-s].config.url", "before": None, "after": None, "secret": True,
    }
    assert "mq.internal" not in json.dumps(row) and "hunter2" not in json.dumps(row)


def test_source_changes_are_refused_with_503_when_the_audit_is_down(monkeypatch) -> None:
    client, api = _client()
    with client:
        auth = _admin(client)
        state = _state(api)
        made = client.post("/api/sources", headers=auth, json={
            "id": "wh-1", "source_type": "webhook", "display_name": "Hook",
        })
        assert made.status_code == 200, made.text
        _break_strict_appends(monkeypatch, state)
        add = client.post("/api/sources", headers=auth, json={
            "id": "wh-2", "source_type": "webhook", "display_name": "Second",
        })
        assert add.status_code == 503 and add.json()["detail"]["code"] == "audit_unavailable"
        secret = client.post("/api/sources/wh-1/secrets", headers=auth, json={"token": "t0ken-1"})
        assert secret.status_code == 503
        delete = client.delete("/api/sources/wh-1", headers=auth)
        assert delete.status_code == 503
        complete = client.post("/api/setup/complete", headers=auth)
        assert complete.status_code == 503
        llm_key = client.post("/api/setup/secrets", headers=auth,
                              json={"anthropic_api_key": "sk-ant-should-not-apply"})
        assert llm_key.status_code == 503
        monkeypatch.undo()
        ids = {s.id for s in state.prefs.sources}
    assert ids >= {"wh-1"} and "wh-2" not in ids
    assert state.secrets.source_secrets("wh-1") == {}
    assert state.secrets.anthropic_api_key != "sk-ant-should-not-apply"


def test_setup_writes_are_audited_with_key_names_only() -> None:
    client, api = _client()
    with client:
        auth = _admin(client)
        keys = client.post("/api/setup/secrets", headers=auth,
                           json={"anthropic_api_key": "sk-ant-abcdefghijklmnop", "openai_api_key": None})
        assert keys.status_code == 200, keys.text
        assert client.post("/api/setup/complete", headers=auth).status_code == 200
        rows = _by_action(_rows(client, api), "settings.updated")
    key_rows = [r for r in rows if _target(r).get("id") == "runtime_keys"]
    assert len(key_rows) == 1
    assert key_rows[0]["changes"] == [
        {"field": "secrets.anthropic_api_key", "before": None, "after": None, "secret": True},
        {"field": "secrets.openai_api_key", "before": None, "after": None, "secret": True},
    ]
    assert key_rows[0]["result_summary"] == \
        "runtime keys: anthropic_api_key set, openai_api_key cleared"
    assert "sk-ant-abcdefghijklmnop" not in json.dumps(rows)
    assert any(r["result_summary"] == "first-run setup completed" for r in rows)


def test_a_broken_audit_store_key_can_still_be_repaired_and_the_repair_is_recorded(monkeypatch) -> None:
    client, api = _client()
    with client:
        auth = _admin(client)
        state = _state(api)
        _break_strict_appends(monkeypatch, state)
        applied: list[dict[str, Any]] = []

        async def _apply(updates: dict[str, Any]) -> None:
            applied.append(dict(updates))
            monkeypatch.undo()  # the repaired connection reaches the audit store again

        monkeypatch.setattr(state, "apply_secrets", _apply)
        repaired = client.post("/api/setup/secrets", headers=auth,
                               json={"es_mgmt_api_key": "bWdtdC1rZXktMTIzNDU2"})
        assert repaired.status_code == 200, repaired.text
        rows = _by_action(_rows(client, api), "settings.updated")
    assert applied == [{"es_mgmt_api_key": "bWdtdC1rZXktMTIzNDU2"}]
    repair = [r for r in rows if (r.get("tool_input") or {}).get("applied_before_audit")]
    assert len(repair) == 1
    assert repair[0]["changes"] == [
        {"field": "secrets.es_mgmt_api_key", "before": None, "after": None, "secret": True},
    ]
    assert repair[0]["request_id"] and repair[0]["actor"] == "Admin"
    assert "bWdtdC1rZXktMTIzNDU2" not in json.dumps(rows)


# --------------------------------------------------------------------------- #
# Review fixes: single sign-on provisioning is audited
# --------------------------------------------------------------------------- #
_SSO_DISCOVERY = {
    "issuer": "https://idp.example.com",
    "authorization_endpoint": "https://idp.example.com/authorize",
    "token_endpoint": "https://idp.example.com/token",
    "userinfo_endpoint": "https://idp.example.com/userinfo",
}


def _sso_client(monkeypatch: pytest.MonkeyPatch, claims: dict[str, Any]) -> tuple[TestClient, FastAPI]:
    from app.auth import oidc
    from app.config import SSOConfig, SSOProvider

    oidc._DISCOVERY_CACHE.clear()

    async def fake_get_json(url: str, *, headers: Any = None) -> dict[str, Any]:
        if "well-known" in url:
            return dict(_SSO_DISCOVERY)
        if url == _SSO_DISCOVERY["userinfo_endpoint"]:
            return dict(claims)
        raise AssertionError(f"unexpected GET {url}")

    async def fake_post_form(url: str, form: Any) -> dict[str, Any]:
        return {"access_token": "at-xyz", "token_type": "Bearer"}

    monkeypatch.setattr(oidc, "_http_get_json", fake_get_json)
    monkeypatch.setattr(oidc, "_http_post_form", fake_post_form)
    api, shim = _app()
    client = TestClient(shim)
    client.__enter__()
    state = _state(api)
    state.secrets.set_sso_client_secret("corp", "client-secret")
    prefs = state.prefs.model_copy(update={"sso": SSOConfig(enabled=True, providers=[SSOProvider(
        id="corp", type="generic", display_name="Corp IdP", client_id="client-123",
        discovery_url="https://idp.example.com/.well-known/openid-configuration",
        allowed_domains=["corp.com"], group_claim="groups",
        group_role_map={"soc-admins": "super_admin"}, auto_create_users=True,
        default_role="analyst_tier1",
    )])})
    client.portal.call(lambda: state.update_prefs(prefs))
    return client, api


def _sso_sign_in(client: TestClient, **headers: str):
    from urllib.parse import parse_qs, urlparse

    client.cookies.clear()
    started = client.get("/api/auth/sso/authorize", params={"provider": "corp"})
    assert started.status_code == 200, started.text
    st = parse_qs(urlparse(started.json()["auth_url"]).query)["state"][0]
    client.cookies.set("tlsoc_oidc_state", st)
    return client.get(f"/api/auth/sso/callback?code=abc&state={st}", follow_redirects=False,
                      headers=headers)


def test_single_sign_on_provisioning_and_a_group_role_change_are_audited(monkeypatch) -> None:
    claims = {"sub": "idp-sub-1", "email": "alice@corp.com", "email_verified": True,
              "groups": []}
    client, api = _sso_client(monkeypatch, claims)
    try:
        first = _sso_sign_in(client)
        assert first.status_code == 302 and first.headers["location"] == "/"
        claims["groups"] = ["soc-admins"]  # the IdP now maps the account to super_admin
        second = _sso_sign_in(client)
        assert second.status_code == 302
        third = _sso_sign_in(client)  # nothing changes: no account row
        assert third.status_code == 302
        rows = _rows(client, api)
    finally:
        client.__exit__(None, None, None)
    created = _by_action(rows, "user.created")
    assert len(created) == 1
    row = created[0]
    assert row["actor"] == "sso:corp" and row["actor_type"] == "system"
    assert _target(row) == {"type": "user", "id": "alice@corp.com", "label": "alice@corp.com"}
    fields = {c["field"]: c["after"] for c in row["changes"]}
    assert fields["role"] == "analyst_tier1" and fields["oauth_provider"] == "corp"
    assert row["tool_input"] == {"method": "sso:corp"} and row["request_id"]
    changed = _by_action(rows, "user.role_changed")
    assert len(changed) == 1
    assert changed[0]["changes"] == [
        {"field": "role", "before": "analyst_tier1", "after": "super_admin", "secret": False},
    ]
    assert changed[0]["actor"] == "sso:corp" and changed[0]["actor_type"] == "system"
    assert len(_by_action(rows, "auth.login")) == 3


def test_a_refused_single_sign_on_link_writes_exactly_one_row_with_its_context(monkeypatch) -> None:
    from app.auth.passwords import hash_password

    claims = {"sub": "attacker-sub", "email": "victim@corp.com", "email_verified": True}
    client, api = _sso_client(monkeypatch, claims)
    try:
        state = _state(api)
        client.portal.call(lambda: state.users.create(
            username="victim@corp.com", password_hash=hash_password("victim-pass-123"),
            role="analyst_tier1", active=True, must_change_password=False,
        ))
        client.portal.call(state.refresh_users)
        refused = _sso_sign_in(client, **{_PEER_HEADER: "203.0.113.66",
                                          REQUEST_ID_HEADER: "sso-refusal-0001"})
        assert refused.status_code == 302
        assert "sso_error=user_not_provisioned" in refused.headers["location"]
        rows = _by_action(_rows(client, api), "auth.login_failed")
    finally:
        client.__exit__(None, None, None)
    assert len(rows) == 1
    row = rows[0]
    assert row["outcome"] == "denied" and row["actor"] == "victim@corp.com"
    assert row["result_summary"] == "sso link refused: corp email matches a local account"
    assert row["request_id"] == "sso-refusal-0001"
    _assert_client(row, "203.0.113.66", "peer")
    assert "actor_role" not in row and "session_ref" not in row


def test_single_sign_on_provisioning_creates_nothing_when_the_audit_is_down(monkeypatch) -> None:
    claims = {"sub": "idp-sub-9", "email": "bob@corp.com", "email_verified": True}
    client, api = _sso_client(monkeypatch, claims)
    try:
        state = _state(api)
        _break_strict_appends(monkeypatch, state)
        response = _sso_sign_in(client)
        assert response.status_code == 302
        assert "sso_error=audit_unavailable" in response.headers["location"]
        assert client.portal.call(lambda: state.users.get("bob@corp.com")) is None
    finally:
        client.__exit__(None, None, None)


# --------------------------------------------------------------------------- #
# Final review fixes: secrets judged on both sides; plural and list names
# --------------------------------------------------------------------------- #
def test_a_secret_replaced_by_a_flag_or_a_number_is_withheld_on_both_sides() -> None:
    for after in (True, 0, None):
        changes = diff_changes({"s": {"config": {"password": "hunter2"}}},
                               {"s": {"config": {"password": after}}})
        assert [c.model_dump() for c in changes] == [
            {"field": "s.config.password", "before": None, "after": None, "secret": True},
        ], after
        assert "hunter2" not in repr(changes)
    # The other direction: a flag replaced by a secret text.
    back = diff_changes({"s": {"config": {"token": False}}},
                        {"s": {"config": {"token": "tok-abcdef123456"}}})
    assert (back[0].before, back[0].after, back[0].secret) == (None, None, True)
    assert "tok-abcdef123456" not in repr(back)
    # Two flags are never secret.
    flags = diff_changes({"must_change_password": False}, {"must_change_password": True})
    assert (flags[0].before, flags[0].after, flags[0].secret) == ("false", "true", False)


@pytest.mark.parametrize("name", [
    "api_keys", "secrets", "passwords", "tokens", "api_tokens", "credentials", "keys",
    "signing_keys", "client_secrets",
])
def test_a_list_of_text_or_a_text_under_a_plural_secret_name_is_withheld(name: str) -> None:
    listed = diff_changes({}, {"s": {"config": {name: ["plainkeyvalue123"]}}})
    assert [c.model_dump() for c in listed] == [
        {"field": f"s.config.{name}", "before": None, "after": None, "secret": True},
    ]
    assert "plainkeyvalue123" not in repr(listed)
    text = diff_changes({"s": {"config": {name: "oldplainvalue1"}}},
                        {"s": {"config": {name: "plainkeyvalue123"}}})
    assert (text[0].before, text[0].after, text[0].secret) == (None, None, True)
    assert "plainkeyvalue123" not in repr(text) and "oldplainvalue1" not in repr(text)
    # Inside an unkeyed list of mappings the item's value is redacted too.
    nested = diff_changes({}, {"s": {"items": [{name: ["plainkeyvalue123"], "kind": "x"}]}})
    assert "plainkeyvalue123" not in repr(nested)


def test_names_that_hold_field_names_or_numbers_stay_readable() -> None:
    changes = diff_changes(
        {"sources": [{"id": "s1", "configured_secrets": ["token"]}],
         "cross_source": {"entity_keys": ["ip"]}, "llm": {"max_tokens": 10, "stop": [1]}},
        {"sources": [{"id": "s1", "configured_secrets": ["password", "token"]}],
         "cross_source": {"entity_keys": ["ip", "host"]}, "llm": {"max_tokens": 20, "stop": [1, 2]}},
    )
    by_field = {c.field: c.model_dump() for c in changes}
    assert by_field["sources[s1].configured_secrets"]["after"] == '["password", "token"]'
    assert by_field["cross_source.entity_keys"]["after"] == '["ip", "host"]'
    assert by_field["llm.max_tokens"]["after"] == "20"
    assert not any(c["secret"] for c in by_field.values())
    # A list of numbers under a token name stays readable (a number never is secret).
    assert not is_secret_key("turn_tokens", [100, 200])
    assert is_secret_key("turn_tokens", ["abc", 200])


# --------------------------------------------------------------------------- #
# Final review fixes: the audit store repair applies only the audit store's keys
# --------------------------------------------------------------------------- #
def _switchable_audit(monkeypatch: pytest.MonkeyPatch, state: AppState) -> dict[str, bool]:
    """The audit store goes down until ``switch["down"]`` turns False."""
    repo = state.control_audit
    real_strict = repo.record_strict
    switch = {"down": True}

    async def _strict(**kwargs: Any) -> Any:
        if switch["down"]:
            raise RuntimeError("audit store unreachable")
        return await real_strict(**kwargs)

    monkeypatch.setattr(repo, "record_strict", _strict)
    return switch


def test_a_repair_during_an_outage_never_carries_other_keys_unaudited(monkeypatch, caplog) -> None:
    import logging

    from app.audit import identity

    client, api = _client()
    with client:
        auth = _admin(client)
        state = _state(api)
        switch = _switchable_audit(monkeypatch, state)
        applied: list[dict[str, Any]] = []

        async def _apply(updates: dict[str, Any]) -> None:
            applied.append(dict(updates))

        monkeypatch.setattr(state, "apply_secrets", _apply)
        dropped_before = identity.dropped_by_action().get("settings.updated", 0)
        with caplog.at_level(logging.ERROR):
            mixed = client.post("/api/setup/secrets", headers=auth, json={
                "anthropic_api_key": "sk-ant-mixedrequest-should-not-apply",
                "es_mgmt_api_key": "ZXMta2V5LTEyMzQ1Ng==",
            })
        assert mixed.status_code == 503, mixed.text
        assert mixed.json()["detail"]["code"] == "audit_unavailable"
        # Only the audit store's own key was applied; the model key was refused.
        assert applied == [{"es_mgmt_api_key": "ZXMta2V5LTEyMzQ1Ng=="}]
        assert identity.dropped_by_action().get("settings.updated", 0) == dropped_before + 1
        errors = [r.getMessage() for r in caplog.records if r.levelno >= logging.ERROR]
        repair_lines = [m for m in errors if "applied_before_audit" in m]
        assert len(repair_lines) == 1
        assert "es_mgmt_api_key" in repair_lines[0] and "anthropic_api_key" not in repair_lines[0]
        for secret in ("ZXMta2V5LTEyMzQ1Ng==", "sk-ant-mixedrequest"):
            assert all(secret not in m for m in errors)

        # The key repairs the connection: the rest of the request is then an ordinary
        # audited change, and every use of the exception is logged whatever happens.
        applied.clear()
        caplog.clear()

        async def _repairing(updates: dict[str, Any]) -> None:
            applied.append(dict(updates))
            if "es_mgmt_api_key" in updates:
                switch["down"] = False

        monkeypatch.setattr(state, "apply_secrets", _repairing)
        with caplog.at_level(logging.ERROR):
            repaired = client.post("/api/setup/secrets", headers=auth, json={
                "anthropic_api_key": "sk-ant-mixedrequest-applies-now",
                "es_mgmt_api_key": "ZXMta2V5LTEyMzQ1Ng==",
            })
        assert repaired.status_code == 200, repaired.text
        assert applied == [{"es_mgmt_api_key": "ZXMta2V5LTEyMzQ1Ng=="},
                           {"anthropic_api_key": "sk-ant-mixedrequest-applies-now"}]
        assert any("applied_before_audit" in r.getMessage() for r in caplog.records
                   if r.levelno >= logging.ERROR)
        rows = [r for r in _by_action(_rows(client, api), "settings.updated")
                if _target(r).get("id") == "runtime_keys"]
    assert len(rows) == 2
    repair = [r for r in rows if (r.get("tool_input") or {}).get("applied_before_audit")]
    ordinary = [r for r in rows if not (r.get("tool_input") or {}).get("applied_before_audit")]
    assert [c["field"] for c in repair[0]["changes"]] == ["secrets.es_mgmt_api_key"]
    assert [c["field"] for c in ordinary[0]["changes"]] == ["secrets.anthropic_api_key"]
    assert repair[0]["request_id"] == ordinary[0]["request_id"]
    assert "sk-ant-mixedrequest" not in json.dumps(rows)

def test_the_read_only_log_key_is_never_applied_without_its_row(monkeypatch) -> None:
    """``es_api_key`` is the read-only log key (non-negotiable #1): it never reaches
    the audit store, so it can never repair an outage and is refused like any other
    key. Beside the management key, only the management key is applied before its row."""
    client, api = _client()
    with client:
        auth = _admin(client)
        state = _state(api)
        _break_strict_appends(monkeypatch, state)
        applied: list[dict[str, Any]] = []

        async def _apply(updates: dict[str, Any]) -> None:
            applied.append(dict(updates))

        monkeypatch.setattr(state, "apply_secrets", _apply)
        alone = client.post("/api/setup/secrets", headers=auth,
                            json={"es_api_key": "cm8ta2V5LTEyMzQ1Ng=="})
        assert alone.status_code == 503, alone.text
        assert alone.json()["detail"]["code"] == "audit_unavailable"
        assert applied == []

        both = client.post("/api/setup/secrets", headers=auth, json={
            "es_api_key": "cm8ta2V5LTEyMzQ1Ng==", "es_mgmt_api_key": "bWdtdC1rZXktMTIzNDU2",
        })
        assert both.status_code == 503, both.text
        assert both.json()["detail"]["message"] == (
            "The audit log could not be written. The audit store key es_mgmt_api_key was "
            "applied to repair it; the other key was not changed: es_api_key."
        )
    assert applied == [{"es_mgmt_api_key": "bWdtdC1rZXktMTIzNDU2"}]


# --------------------------------------------------------------------------- #
# Final review fixes: a failed source secrets save changes no credential
# --------------------------------------------------------------------------- #
def test_a_failed_source_secrets_save_leaves_the_credentials_as_they_were(monkeypatch) -> None:
    from fastapi import HTTPException

    client, api = _client()
    with client:
        auth = _admin(client)
        state = _state(api)
        made = client.post("/api/sources", headers=auth, json={
            "id": "wh-9", "source_type": "webhook", "display_name": "Hook",
        })
        assert made.status_code == 200, made.text
        first = client.post("/api/sources/wh-9/secrets", headers=auth,
                            json={"token": "t0ken-original"})
        assert first.status_code == 200, first.text

        async def _store_down(_transform: Any) -> Any:
            raise HTTPException(status_code=503, detail="config store unavailable")

        monkeypatch.setattr(state, "mutate_prefs", _store_down)
        rotated = client.post("/api/sources/wh-9/secrets", headers=auth,
                              json={"token": "t0ken-rotated", "hmac_secret": "hm-new-0001"})
        assert rotated.status_code == 503, rotated.text
        cleared = client.post("/api/sources/wh-9/secrets", headers=auth, json={"token": None})
        assert cleared.status_code == 503, cleared.text
        # Nothing changed in memory: the failure rows are true.
        assert state.secrets.source_secrets("wh-9") == {"token": "t0ken-original"}
        monkeypatch.undo()
        stored = next(s for s in state.prefs.sources if s.id == "wh-9")
        assert stored.configured_secrets == ["token"]
        # A save that succeeds records the names the secret tier then holds.
        both = client.post("/api/sources/wh-9/secrets", headers=auth,
                           json={"hmac_secret": "hm-new-0002", "token": None})
        assert both.status_code == 200, both.text
        assert both.json()["configured_secrets"] == ["hmac_secret"]
        assert state.secrets.source_secrets("wh-9") == {"hmac_secret": "hm-new-0002"}
        assert next(s for s in state.prefs.sources if s.id == "wh-9").configured_secrets == \
            ["hmac_secret"]
        rows = _rows(client, api)
    failed = _by_action(rows, "source.secrets_update_failed")
    assert len(failed) == 2 and all(r["outcome"] == "failure" for r in failed)
    actions = _by_action(rows, "source.secrets_updated")
    assert len(actions) == 4  # every attempt's action row, paired by request id
    assert {r["request_id"] for r in failed} <= {r["request_id"] for r in actions}
    for leaked in ("t0ken-original", "t0ken-rotated", "hm-new-0001", "hm-new-0002"):
        assert leaked not in json.dumps(rows)


# --------------------------------------------------------------------------- #
# The event table names every action these writers record
# --------------------------------------------------------------------------- #
#: Every structured action the A4b-1 writers record, with the audit log category it
#: must read as (SPEC §4.5.4). Personal preferences are configuration, so they stay
#: out of Access and identity and its "User and role changes" quick view.
_A4B1_ACTIONS: dict[str, str] = {
    "auth.login": "access", "auth.login_failed": "access", "auth.logout": "access",
    "auth.mfa_challenged": "access", "auth.mfa_setup_started": "access",
    "auth.mfa_enrolled": "access", "auth.mfa_failed": "access",
    "auth.mfa_disabled": "access", "auth.password_changed": "access",
    "auth.password_change_failed": "access", "auth.reauthenticated": "access",
    "auth.reauth_failed": "access",
    "session.created": "access", "session.refreshed": "access", "session.revoked": "access",
    "user.created": "access", "user.updated": "access", "user.role_changed": "access",
    "user.deleted": "access", "user.preferences_updated": "config",
    "role.created": "access", "role.updated": "access", "role.deleted": "access",
    "settings.updated": "config",
    "source.created": "config", "source.updated": "config", "source.deleted": "config",
    "source.secrets_updated": "config",
}
#: The actions written audit-first (``audited_write`` / ``audited_prefs_write``): a
#: failed store write records ``failure_action(action)`` beside the action row.
_A4B1_AUDIT_FIRST = (
    "auth.password_changed", "auth.mfa_enrolled", "auth.mfa_disabled",
    "user.created", "user.updated", "user.role_changed", "user.deleted",
    "user.preferences_updated", "role.created", "role.updated", "role.deleted",
    "settings.updated", "source.created", "source.updated", "source.deleted",
    "source.secrets_updated",
)
#: Audit-first actions whose failure row has no exact event table entry yet and whose
#: prefix reads in another category (``user.preferences_update_failed`` reads as
#: Access through ``user``, its action row is Configuration).
_FAILURE_ENTRY_PENDING = frozenset({"user.preferences_updated"})
_A4B1_WRITER_FILES = ("api/routes.py", "api/routes_roles.py", "api/routes_prefs.py")
_A4B1_ACTION_LITERAL_RE = re.compile(
    r'"((?:auth|session|user|role|settings|source)\.[a-z_]+)"'
)


@pytest.mark.parametrize("action, category", sorted(_A4B1_ACTIONS.items()))
def test_every_action_these_writers_record_has_its_own_event_table_entry(
    action: str, category: str,
) -> None:
    """Each action has an exact entry (never only the prefix fallback, which reads
    "Sign-in mfa challenged"), in the right category, with a sentence-case label, and
    a person's row of it shows in People and settings."""
    entry = events.TABLE.action_by_name.get(action)
    assert entry is not None, f"{action} falls back to its prefix label"
    assert entry.category == category, action
    assert entry.label[:1].isupper() and "_" not in entry.label, entry.label
    assert events.classify({"action": action}) == events.EventInfo(category, entry.label)
    assert events.in_people_scope({"action": action, "actor_type": "human"})


@pytest.mark.parametrize("action", _A4B1_AUDIT_FIRST)
def test_the_failure_row_of_an_audit_first_write_reads_as_a_people_event(action: str) -> None:
    """The paired failure row (``<resource>.<verb>_failed``, SPEC §3.6) is a valid
    action that shows in People and settings with a readable name."""
    failed = failure_action(action)
    assert failed.endswith("_failed") and failed.split(".", 1)[0] == action.split(".", 1)[0]
    info = events.classify({"action": failed, "actor_type": "human"})
    assert info.category in {"access", "config"}, (failed, info)
    assert info.label and "_" not in info.label, info.label
    assert events.in_people_scope({"action": failed, "actor_type": "human"})
    # A failure row reads in its action row's category: exactly once the event table
    # names it, and through its prefix until then for every action but the ones whose
    # entry is still to land (the event table is A4a's; see the package's open issues).
    entry = events.TABLE.action_by_name.get(failed)
    if entry is not None:
        assert entry.category == _A4B1_ACTIONS[action], (failed, entry)
    elif action not in _FAILURE_ENTRY_PENDING:
        assert info.category == _A4B1_ACTIONS[action], (failed, info)


def test_the_writers_record_no_action_the_list_does_not_name() -> None:
    """A new identity, settings or source action added to these routes without an
    event table entry (and a line above) fails here rather than reaching the audit log
    under its raw prefix label."""
    root = Path(events.__file__).resolve().parent.parent
    found: set[str] = set()
    for rel in _A4B1_WRITER_FILES:
        found |= set(_A4B1_ACTION_LITERAL_RE.findall((root / rel).read_text(encoding="utf-8")))
    assert found, "the scan found no action literal: the writer files moved"
    assert found <= set(_A4B1_ACTIONS), sorted(found - set(_A4B1_ACTIONS))
    assert set(_A4B1_AUDIT_FIRST) <= found



# --------------------------------------------------------------------------- #
# Fix round 3: an audited account write never reverts a change saved while its row
# was appended, and never reports success for an account that is gone
# --------------------------------------------------------------------------- #
def _new_account(client: TestClient, auth: dict[str, str], username: str = "bob",
                 password: str = "Bob-pass-123") -> dict[str, str]:
    made = client.post("/api/users", headers=auth, json={
        "username": username, "password": password, "role": "analyst_tier1"})
    assert made.status_code == 200, made.text
    signed_in = _login(client, username, password)
    assert signed_in.status_code == 200, signed_in.text
    return {"Authorization": f"Bearer {signed_in.json()['token']}"}


def _after_action_row(monkeypatch: pytest.MonkeyPatch, state: AppState, action: str,
                      effect: Any) -> list[str]:
    """Run ``effect`` (an async callable) right after the ``action`` row is appended,
    the moment an administrator's save lands in production while the store write is
    still to come. Returns the actions appended, in order."""
    repo = state.control_audit
    original = repo.record_strict
    seen: list[str] = []

    async def _append(**kwargs: Any) -> None:
        await original(**kwargs)
        seen.append(str(kwargs.get("action") or ""))
        if kwargs.get("action") == action:
            await effect()

    monkeypatch.setattr(repo, "record_strict", _append)
    return seen


def _stored(client: TestClient, state: AppState, username: str) -> Any:
    return client.portal.call(lambda: state.users.get(username))


def _role_of(user: Any) -> str:
    return str(getattr(user.role, "value", user.role))


def test_turning_two_factor_on_keeps_an_administrators_change_made_meanwhile(monkeypatch) -> None:
    from app.auth import mfa as mfa_mod

    client, api = _client()
    with client:
        auth = _admin(client)
        bob = _new_account(client, auth)
        state = _state(api)
        secret = client.post("/api/auth/mfa/setup", headers=bob).json()["secret"]

        async def _admin_change() -> None:
            await state.users.update("bob", role="responder", active=False)

        _after_action_row(monkeypatch, state, "auth.mfa_enrolled", _admin_change)
        confirmed = client.post("/api/auth/mfa/confirm", json={"code": mfa_mod.totp(secret)},
                                headers=bob)
        assert confirmed.status_code == 200, confirmed.text
        stored = _stored(client, state, "bob")
    assert _role_of(stored) == "responder" and stored.active is False
    assert stored.mfa_enabled is True and stored.mfa_secret


def test_a_login_mandated_enrolment_keeps_an_administrators_change_made_meanwhile(monkeypatch) -> None:
    from app.auth import mfa as mfa_mod

    client, api = _client()
    with client:
        auth = _admin(client)
        _new_account(client, auth)
        assert client.put("/api/users/bob", headers=auth,
                          json={"mfa_required": True}).status_code == 200
        state = _state(api)
        pending = _login(client, "bob", "Bob-pass-123").json()["pending_token"]
        setup = client.post("/api/auth/mfa/enroll-setup", json={"pending_token": pending})
        assert setup.status_code == 200, setup.text

        async def _admin_change() -> None:
            await state.users.update("bob", role="responder", must_change_password=True)

        _after_action_row(monkeypatch, state, "auth.mfa_enrolled", _admin_change)
        confirmed = client.post("/api/auth/mfa/enroll-confirm", json={
            "pending_token": pending, "code": mfa_mod.totp(setup.json()["secret"])})
        assert confirmed.status_code == 200, confirmed.text
        stored = _stored(client, state, "bob")
    assert _role_of(stored) == "responder" and stored.must_change_password is True
    assert stored.mfa_enabled is True


def test_turning_two_factor_off_keeps_an_administrators_change_made_meanwhile(monkeypatch) -> None:
    from app.auth import mfa as mfa_mod

    client, api = _client()
    with client:
        auth = _admin(client)
        bob = _new_account(client, auth)
        state = _state(api)
        secret = client.post("/api/auth/mfa/setup", headers=bob).json()["secret"]
        assert client.post("/api/auth/mfa/confirm", json={"code": mfa_mod.totp(secret)},
                           headers=bob).status_code == 200
        stored = _stored(client, state, "bob")

        async def _admin_change() -> None:
            await state.users.update("bob", role="responder", active=False)

        _after_action_row(monkeypatch, state, "auth.mfa_disabled", _admin_change)
        code = mfa_mod.totp(mfa_mod.deobfuscate_secret(stored.mfa_secret,
                                                       state.secrets.mfa_server_key()),
                            ts=time.time() + 30)
        off = client.post("/api/auth/mfa/disable", json={"code": code}, headers=bob)
        assert off.status_code == 200, off.text
        after = _stored(client, state, "bob")
    assert _role_of(after) == "responder" and after.active is False
    assert after.mfa_enabled is False and after.mfa_secret == "" and after.mfa_recovery_hashes == []
    assert after.mfa_last_step == 0


def test_a_single_sign_on_relink_keeps_an_administrators_change_made_meanwhile(monkeypatch) -> None:
    claims = {"sub": "idp-sub-9", "email": "carol@corp.com", "email_verified": True, "groups": []}
    client, api = _sso_client(monkeypatch, claims)
    try:
        assert _sso_sign_in(client).status_code == 302  # provisioned as analyst_tier1
        state = _state(api)

        async def _admin_change() -> None:
            await state.users.update("carol@corp.com", must_change_password=True,
                                     display_name="Carol (renamed by an admin)")

        _after_action_row(monkeypatch, state, "user.role_changed", _admin_change)
        claims["groups"] = ["soc-admins"]  # the IdP now maps the account to super_admin
        assert _sso_sign_in(client).status_code == 302
        stored = _stored(client, state, "carol@corp.com")
    finally:
        client.__exit__(None, None, None)
    assert _role_of(stored) == "super_admin"
    assert stored.must_change_password is True
    assert stored.display_name == "Carol (renamed by an admin)"
    assert stored.oauth_provider == "corp" and stored.oauth_sub == "idp-sub-9"


def test_a_single_sign_on_relink_of_an_account_deleted_meanwhile_fails_with_its_row(monkeypatch) -> None:
    claims = {"sub": "idp-sub-10", "email": "dave@corp.com", "email_verified": True, "groups": []}
    client, api = _sso_client(monkeypatch, claims)
    try:
        assert _sso_sign_in(client).status_code == 302
        state = _state(api)

        async def _delete() -> None:
            await state.users.delete("dave@corp.com")

        _after_action_row(monkeypatch, state, "user.role_changed", _delete)
        claims["groups"] = ["soc-admins"]
        refused = _sso_sign_in(client)
        rows = _rows(client, api)
        gone = _stored(client, state, "dave@corp.com")
    finally:
        client.__exit__(None, None, None)
    assert refused.status_code == 302 and "sso_error=user_not_provisioned" in refused.headers["location"]
    assert gone is None
    failed = _by_action(rows, "user.role_change_failed")
    assert len(failed) == 1 and "no longer exists" in failed[0]["result_summary"]
    changed = _by_action(rows, "user.role_changed")
    assert changed[-1]["request_id"] == failed[0]["request_id"]


def test_a_profile_save_keeps_a_custom_role_assigned_meanwhile(monkeypatch) -> None:
    client, api = _client(rbac=True)
    with client:
        auth = _admin(client)
        _fresh(client, auth)
        assert client.post("/api/roles", headers=auth, json={
            "name": "hunter", "description": "Threat hunters", "grants": {"cases": ["read"]},
        }).status_code == 200
        bob = _new_account(client, auth)
        state = _state(api)

        async def _assign() -> None:
            user = await state.users.get("bob")
            await state.users.update("bob", prefs={**(user.prefs or {}), "custom_roles": ["hunter"]})

        _after_action_row(monkeypatch, state, "user.updated", _assign)
        saved = client.put("/api/account/me", headers=bob,
                           json={"prefs": {"theme": "dark", "custom_roles": []}})
        assert saved.status_code == 200, saved.text
        stored = _stored(client, state, "bob")
    assert stored.prefs.get("custom_roles") == ["hunter"], "the assignment is never reverted"
    assert stored.prefs.get("theme") == "dark"


def test_a_custom_role_assignment_keeps_a_preference_saved_meanwhile(monkeypatch) -> None:
    client, api = _client(rbac=True)
    with client:
        auth = _admin(client)
        _fresh(client, auth)
        assert client.post("/api/roles", headers=auth, json={
            "name": "hunter", "description": "Threat hunters", "grants": {"cases": ["read"]},
        }).status_code == 200
        _new_account(client, auth)
        auth = _admin(client)
        _fresh(client, auth)
        state = _state(api)

        async def _own_save() -> None:
            user = await state.users.get("bob")
            await state.users.update("bob", prefs={**(user.prefs or {}), "theme": "dark"},
                                     active=False)

        _after_action_row(monkeypatch, state, "user.role_changed", _own_save)
        assigned = client.put("/api/users/bob/roles", headers=auth, json={"custom_roles": ["hunter"]})
        assert assigned.status_code == 200, assigned.text
        stored = _stored(client, state, "bob")
    assert stored.prefs.get("custom_roles") == ["hunter"]
    assert stored.prefs.get("theme") == "dark" and stored.active is False


@pytest.mark.parametrize("route", ["users", "roles", "account", "avatar"])
def test_a_write_to_an_account_deleted_meanwhile_answers_404_with_its_failure_row(
    monkeypatch, route: str,
) -> None:
    client, api = _client(rbac=route == "roles")
    with client:
        auth = _admin(client)
        bob = _new_account(client, auth)
        auth = _admin(client)
        _fresh(client, auth)
        state = _state(api)
        action = "user.role_changed" if route in ("users", "roles") else "user.updated"

        async def _delete() -> None:
            await state.users.delete("bob")

        seen = _after_action_row(monkeypatch, state, action, _delete)
        if route == "users":
            response = client.put("/api/users/bob", headers=auth, json={"role": "responder"})
        elif route == "roles":
            response = client.put("/api/users/bob/roles", headers=auth, json={"role": "responder"})
        elif route == "account":
            client.cookies.clear()  # bob's own request: his token only
            response = client.put("/api/account/me", headers=bob, json={"display_name": "Bob B"})
        else:
            client.cookies.clear()
            response = client.put("/api/me/avatar", headers=bob, json={"avatar": ""})
        rows = _rows(client, api)
    assert response.status_code == 404, response.text
    assert response.json()["detail"] == "user not found"
    failure = failure_action(action)
    assert seen[-2:] == [action, failure]
    action_row = [r for r in _by_action(rows, action) if _target(r).get("id") == "bob"][-1]
    failure_rows = _by_action(rows, failure)
    assert len(failure_rows) == 1
    assert failure_rows[0]["outcome"] == "failure"
    assert failure_rows[0]["request_id"] == action_row["request_id"]
    assert failure_rows[0]["result_summary"] == "user not found"


# --------------------------------------------------------------------------- #
# Final fix: every audit-first write whose target goes away (or is made by another
# request) while its row is appended answers with its failure row, never a success
# for a change it did not make
# --------------------------------------------------------------------------- #
def _single_failure(rows: list[dict[str, Any]], action: str, seen: list[str],
                    summary: str) -> None:
    """The action row is followed by exactly one paired failure row (same request id,
    outcome failure, the refusal as its summary)."""
    failure = failure_action(action)
    assert seen[-2:] == [action, failure], seen
    failure_rows = _by_action(rows, failure)
    assert len(failure_rows) == 1, failure_rows
    assert failure_rows[0]["outcome"] == "failure"
    assert failure_rows[0]["request_id"] == _by_action(rows, action)[-1]["request_id"]
    assert failure_rows[0]["result_summary"] == summary


def _add_broker(client: TestClient, auth: dict[str, str]) -> None:
    made = client.post("/api/sources", headers=auth, json={
        "id": "mq-1", "source_type": "rabbitmq", "display_name": "Broker",
        "config": {"url": "amqp://mq.internal:5672/vhost", "queue": "alerts"}})
    assert made.status_code == 200, made.text


async def _drop_broker(state: AppState) -> None:
    await state.mutate_prefs(lambda p: p.model_copy(update={
        "sources": [s for s in p.sources if s.id != "mq-1"]}))


def test_a_password_change_of_an_account_deleted_meanwhile_answers_404(monkeypatch) -> None:
    client, api = _client()
    with client:
        auth = _admin(client)
        bob = _new_account(client, auth)
        state = _state(api)

        async def _delete() -> None:
            await state.users.delete("bob")

        seen = _after_action_row(monkeypatch, state, "auth.password_changed", _delete)
        client.cookies.clear()  # bob's own request: his token only
        response = client.post("/api/auth/change-password", headers=bob, json={
            "current_password": "Bob-pass-123", "new_password": "Bob-new-pass-1"})
        rows = _rows(client, api)
        stored = _stored(client, state, "bob")
    assert response.status_code == 404, response.text
    assert response.json()["detail"] == "user not found"
    _single_failure(rows, "auth.password_changed", seen, "user not found")
    assert stored is None  # never re-created by the password write


def test_credentials_for_a_source_deleted_meanwhile_answer_404_and_set_nothing(
    monkeypatch,
) -> None:
    client, api = _client()
    with client:
        auth = _admin(client)
        _add_broker(client, auth)
        state = _state(api)

        async def _delete() -> None:
            await _drop_broker(state)

        seen = _after_action_row(monkeypatch, state, "source.secrets_updated", _delete)
        response = client.post("/api/sources/mq-1/secrets", headers=auth,
                               json={"password": "s3cr3t-value"})
        rows = _rows(client, api)
        # No credential is left behind for the deleted source, so a source made again
        # under the same id does not silently inherit one its record does not name.
        orphaned = dict(state.secrets.source_secrets("mq-1"))
        present = any(s.id == "mq-1" for s in state.prefs.sources)
    assert response.status_code == 404, response.text
    assert response.json()["detail"] == "Source not found"
    _single_failure(rows, "source.secrets_updated", seen, "Source not found")
    assert orphaned == {} and present is False
    assert "s3cr3t-value" not in json.dumps(rows)


def test_an_edit_to_a_source_deleted_meanwhile_answers_404_and_never_recreates_it(
    monkeypatch,
) -> None:
    client, api = _client()
    with client:
        auth = _admin(client)
        _add_broker(client, auth)
        state = _state(api)

        async def _delete() -> None:
            await _drop_broker(state)

        seen = _after_action_row(monkeypatch, state, "source.updated", _delete)
        response = client.post("/api/sources", headers=auth, json={
            "id": "mq-1", "source_type": "rabbitmq", "display_name": "Renamed",
            "config": {"url": "amqp://mq.internal:5672/vhost", "queue": "alerts"}})
        rows = _rows(client, api)
        present = any(s.id == "mq-1" for s in state.prefs.sources)
    assert response.status_code == 404, response.text
    assert response.json()["detail"] == "Source not found"
    _single_failure(rows, "source.updated", seen, "Source not found")
    assert len(_by_action(rows, "source.updated")) == 1
    assert present is False


def test_a_source_added_by_another_request_meanwhile_is_not_replaced(monkeypatch) -> None:
    client, api = _client()
    with client:
        auth = _admin(client)
        state = _state(api)

        async def _other_add() -> None:
            from app.config import SourceInstance

            theirs = SourceInstance(id="mq-1", source_type="rabbitmq", display_name="Theirs",
                                    config={"url": "amqp://mq.internal:5672/vhost"})
            await state.mutate_prefs(lambda p: p.model_copy(update={
                "sources": [*p.sources, theirs]}))

        seen = _after_action_row(monkeypatch, state, "source.created", _other_add)
        response = client.post("/api/sources", headers=auth, json={
            "id": "mq-1", "source_type": "rabbitmq", "display_name": "Mine",
            "config": {"url": "amqp://mq.internal:5672/vhost", "queue": "alerts"}})
        rows = _rows(client, api)
        kept = [s.display_name for s in state.prefs.sources if s.id == "mq-1"]
    assert response.status_code == 409, response.text
    assert response.json()["detail"] == "Source 'mq-1' already exists"
    _single_failure(rows, "source.created", seen, "Source 'mq-1' already exists")
    assert kept == ["Theirs"]


def test_an_update_to_a_custom_role_deleted_meanwhile_answers_404_and_never_brings_it_back(
    monkeypatch,
) -> None:
    client, api = _client(rbac=True)
    with client:
        auth = _admin(client)
        _fresh(client, auth)
        made = client.post("/api/roles", headers=auth, json={
            "name": "hunter", "description": "Threat hunters", "grants": {"cases": ["read"]}})
        assert made.status_code == 200, made.text
        state = _state(api)

        async def _delete() -> None:
            await state.custom_roles.delete("hunter")

        seen = _after_action_row(monkeypatch, state, "role.updated", _delete)
        response = client.put("/api/roles", headers=auth, json={
            "name": "hunter", "description": "Threat hunters",
            "grants": {"cases": ["read", "update"]}})
        rows = _rows(client, api)
        stored = client.portal.call(lambda: state.custom_roles.get("hunter"))
    assert response.status_code == 404, response.text
    assert response.json()["detail"] == "custom role 'hunter' not found"
    _single_failure(rows, "role.updated", seen, "custom role 'hunter' not found")
    assert stored is None


def test_a_custom_role_made_by_another_request_meanwhile_is_not_replaced(monkeypatch) -> None:
    from app.models import CustomRole

    client, api = _client(rbac=True)
    with client:
        auth = _admin(client)
        _fresh(client, auth)
        state = _state(api)

        async def _other_create() -> None:
            await state.custom_roles.put(CustomRole(
                name="hunter", description="Theirs", grants={"cases": ["read"]}))

        seen = _after_action_row(monkeypatch, state, "role.created", _other_create)
        response = client.post("/api/roles", headers=auth, json={
            "name": "hunter", "description": "Mine", "grants": {"cases": ["read", "update"]}})
        rows = _rows(client, api)
        stored = client.portal.call(lambda: state.custom_roles.get("hunter"))
    assert response.status_code == 409, response.text
    assert response.json()["detail"] == "custom role 'hunter' already exists"
    _single_failure(rows, "role.created", seen, "custom role 'hunter' already exists")
    assert stored is not None and stored.description == "Theirs"


@pytest.mark.parametrize("made_again", [False, True])
def test_deleting_an_account_deleted_meanwhile_answers_404_with_its_failure_row(
    monkeypatch, made_again: bool,
) -> None:
    client, api = _client()
    with client:
        auth = _admin(client)
        _new_account(client, auth)
        auth = _admin(client)
        state = _state(api)

        async def _delete() -> None:
            await state.users.delete("bob")
            if made_again:
                # Another administrator made a new account under the same name: it is
                # not the account this request was asked to delete.
                await asyncio.sleep(0.002)
                await state.users.create(username="bob", password_hash="x", role="responder")

        seen = _after_action_row(monkeypatch, state, "user.deleted", _delete)
        response = client.delete("/api/users/bob", headers=auth)
        rows = _rows(client, api)
        stored = _stored(client, state, "bob")
    assert response.status_code == 404, response.text
    assert response.json()["detail"] == "user not found"
    _single_failure(rows, "user.deleted", seen, "user not found")
    if made_again:
        assert stored is not None and _role_of(stored) == "responder"
    else:
        assert stored is None


# --------------------------------------------------------------------------- #
# Fix round 3: a mistyped webhook address never reaches the record
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("typed, recorded", [
    ("hooks.slack.com/services/T0AAA/B0BBB/LEAKEDTOKEN123", "hooks.slack.com"),
    ("//hooks.slack.com/services/T0AAA/B0BBB/LEAKEDTOKEN123", "hooks.slack.com"),
    ("https:hooks.slack.com/services/T0AAA/B0BBB/LEAKEDTOKEN123", "hooks.slack.com"),
    ("https:/hooks.slack.com/services/T0AAA/B0BBB/LEAKEDTOKEN123", "hooks.slack.com"),
    ("hooks.slack.com:8443/services/T0AAA?token=LEAKEDTOKEN123", "hooks.slack.com:8443"),
    ("see hooks.slack.com/services/T0AAA/B0BBB/LEAKEDTOKEN123", "[REDACTED]"),
])
def test_a_malformed_webhook_address_keeps_only_its_host(typed: str, recorded: str) -> None:
    changes = diff_changes(
        {}, {"notifications": {"channels": [{"id": "slack-1", "config": {"url": typed}}]}},
    )
    url = [c for c in changes if c.field == "notifications.channels[slack-1].config.url"][0]
    assert url.after == recorded and url.secret is True
    assert "LEAKEDTOKEN123" not in json.dumps([c.model_dump() for c in changes])
    assert "/services/" not in json.dumps([c.model_dump() for c in changes])


def test_a_bare_host_or_data_url_under_a_url_name_is_kept_as_it_is() -> None:
    assert reduce_url("hooks.example") == ("hooks.example", False)
    assert reduce_url("10.0.0.5:9200") == ("10.0.0.5:9200", False)
    assert reduce_url("data:image/png;base64,AAAA") == ("data:image/png;base64,AAAA", False)
    assert reduce_url("[2001:db8::1]:8443/x") == ("[2001:db8::1]:8443", True)
    assert reduce_url("localhost:8080/path?token=abc") == ("localhost:8080", True)
    assert reduce_url("") == ("", False)


def test_a_mistyped_webhook_saved_through_settings_never_records_its_token() -> None:
    client, api = _client()
    with client:
        auth = _admin(client)
        saved = client.put("/api/settings", headers=auth, json={"notifications": {"channels": [{
            "id": "slack-x", "type": "slack",
            "config": {"url": "hooks.slack.com/services/T0AAA/B0BBB/LEAKEDTOKEN123"}}]}})
        assert saved.status_code == 200, saved.text
        rows = _by_action(_rows(client, api), "settings.updated")
    assert rows and "LEAKEDTOKEN123" not in json.dumps(rows)


# --------------------------------------------------------------------------- #
# Fix round 3: an unhandled error still answers with the request id
# --------------------------------------------------------------------------- #
def test_an_unhandled_error_answers_500_with_the_request_id(caplog) -> None:
    import logging

    from app.middleware.request_id import internal_error_response

    api = FastAPI()

    @api.get("/boom")
    async def boom() -> None:
        raise RuntimeError("unexpected")

    api.add_middleware(RequestIdMiddleware)
    api.add_exception_handler(Exception, internal_error_response)
    with TestClient(api, raise_server_exceptions=False) as client:
        with caplog.at_level(logging.ERROR, logger="tlsoc.middleware.request_id"):
            honoured = client.get("/boom", headers={REQUEST_ID_HEADER: "abcdefgh-1234"})
        fresh = client.get("/boom")
    assert honoured.status_code == 500 and honoured.text == "Internal Server Error"
    assert honoured.headers[REQUEST_ID_HEADER] == "abcdefgh-1234"
    assert any("abcdefgh-1234" in r.getMessage() and "RuntimeError" in r.getMessage()
               for r in caplog.records)
    assert _UUID4_RE.fullmatch(fresh.headers[REQUEST_ID_HEADER])


def test_the_real_app_answers_an_unhandled_error_with_the_request_id() -> None:
    from app.main import app as real_app
    from app.middleware.request_id import internal_error_response

    assert real_app.exception_handlers.get(Exception) is internal_error_response


# --------------------------------------------------------------------------- #
# Fix round 3: every identity row of a verified account names the account
# --------------------------------------------------------------------------- #
def test_every_identity_row_of_a_signed_in_account_targets_that_account() -> None:
    from app.auth import mfa as mfa_mod

    client, api = _client()
    with client:
        auth = _admin(client)
        _fresh(client, auth)
        assert client.post("/api/auth/reauth", json={"password": "wrong"},
                           headers=auth).status_code == 401
        bob = _new_account(client, auth)
        secret = client.post("/api/auth/mfa/setup", headers=bob).json()["secret"]
        assert client.post("/api/auth/mfa/confirm", json={"code": mfa_mod.totp(secret)},
                           headers=bob).status_code == 200
        pending = _login(client, "bob", "Bob-pass-123").json()["pending_token"]
        assert client.post("/api/auth/mfa/verify",
                           json={"pending_token": pending, "code": "000000"}).status_code == 401
        pending = _login(client, "bob", "Bob-pass-123").json()["pending_token"]
        verified = client.post("/api/auth/mfa/verify", json={
            "pending_token": pending, "code": mfa_mod.totp(secret, ts=time.time() + 30)})
        assert verified.status_code == 200, verified.text
        bob_token = verified.json()["token"]
        assert client.post("/api/auth/logout",
                           headers={"Authorization": f"Bearer {bob_token}"}).status_code == 200
        _login(client, "nobody", "wrong-pass")
        rows = _rows(client, api)
    for action in ("auth.login", "auth.mfa_challenged", "auth.mfa_failed",
                   "auth.reauthenticated", "auth.reauth_failed", "auth.logout",
                   "session.created"):
        found = _by_action(rows, action)
        assert found, action
        for row in found:
            actor = row["actor"]
            assert _target(row) == {"type": "user", "id": actor, "label": actor}, (action, row)
    # A failed sign-in names a caller-chosen username: never a target.
    for row in _by_action(rows, "auth.login_failed"):
        assert not row.get("target"), row


# --------------------------------------------------------------------------- #
# Fix round 3: every writer's rows go to the real log, Demo Mode on or off
# --------------------------------------------------------------------------- #
def _drive_every_writer(client: TestClient, api: FastAPI) -> None:
    """One request per A4b-1 writer the Demo test did not cover (SPEC §3.5, §4.5.9)."""
    auth = _admin(client)
    _fresh(client, auth)
    steps = [
        client.post("/api/roles", headers=auth, json={
            "name": "hunter", "description": "Threat hunters", "grants": {"cases": ["read"]}}),
        client.post("/api/users", headers=auth,
                    json={"username": "kim", "password": "kim-pass-123"}),
        client.put("/api/users/kim/roles", headers=auth, json={"custom_roles": ["hunter"]}),
        client.put("/api/prefs/user", headers=auth,
                   json={"misc": {"dashboards_hidden": ["builtin:soc-operations"]}}),
        client.post("/api/sources", headers=auth, json={
            "id": "mq-1", "source_type": "rabbitmq", "display_name": "Broker",
            "config": {"url": "amqp://mq.internal:5672/vhost", "queue": "alerts"}}),
        client.post("/api/sources/mq-1/secrets", headers=auth, json={"password": "s3cr3t-value"}),
        client.put("/api/branding", headers=auth, json={"org_name": "Example Org"}),
    ]
    for step in steps:
        assert step.status_code == 200, step.text
    kim = _login(client, "kim", "kim-pass-123")
    assert kim.status_code == 200, kim.text
    kim_auth = {"Authorization": f"Bearer {kim.json()['token']}"}
    changed = client.post("/api/auth/change-password", headers=kim_auth, json={
        "current_password": "kim-pass-123", "new_password": "kim-new-pass-1"})
    assert changed.status_code == 200, changed.text
    kim = _login(client, "kim", "kim-new-pass-1")
    kim_auth = {"Authorization": f"Bearer {kim.json()['token']}"}
    _login(client, "kim", "kim-new-pass-1")  # a second session for revoke-others
    revoked = client.post("/api/sessions/revoke-others", headers=kim_auth, json={})
    assert revoked.status_code == 200, revoked.text


_EVERY_WRITER_ACTIONS = (
    "role.created", "user.created", "user.role_changed", "user.preferences_updated",
    "source.created", "source.secrets_updated", "settings.updated", "auth.password_changed",
    "auth.login", "session.created", "session.revoked",
)


@pytest.mark.parametrize("demo", [True, False], ids=["demo-on", "demo-off"])
def test_every_writer_records_to_the_real_log_with_demo_mode_on_or_off(demo: bool) -> None:
    client, api = _client(rbac=True)
    with client:
        state = _state(api)
        if demo:
            client.portal.call(state.enable_demo)
        try:
            _drive_every_writer(client, api)
            real_rows = _rows(client, api)
            demo_rows = _rows(client, api, repo=state.demo_audit) if demo else []
        finally:
            if demo:
                client.portal.call(state.disable_demo)
    for action in _EVERY_WRITER_ACTIONS:
        assert _by_action(real_rows, action), action
        assert not _by_action(demo_rows, action), action
