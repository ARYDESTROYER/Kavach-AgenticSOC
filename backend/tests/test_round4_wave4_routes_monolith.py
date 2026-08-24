"""Round 4 Wave 4 — the routes.py monolith: acknowledge fix + unified logs +
forwarding-explain + source-health.

All offline (in-memory fake ES, mock LLM, no network):

* BUG #3 fix — POST /cases/{id}/action action=acknowledge moves the case to
  INVESTIGATING (a NON-terminal analyst status), stamps ``acknowledged_at``, and NEVER
  closes it. The analyst layer never calls ``case_manager.decide()`` (#3).
* GET /api/logs — scatter-gather browse across every enabled, browse-capable source,
  merged newest-first with a MANDATORY source_id/source_name provenance column on each
  row; tolerant of one source failing (partial success); secrets never returned.
* GET /api/cases/{id}/forwarding — the plain-English deciding-gate object (read-only).
* GET /api/sources/health — per-source health shape (enabled/kind/cursor/buffer).
"""

from __future__ import annotations

import json
from contextlib import asynccontextmanager

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.routes import router
from app.es.fake import InMemoryESClient
from app.state import AppState
from app.utils import now_utc, to_millis
from tests.conftest import make_log_event

INDEX_A = "all-logs-2026.06.23"
INDEX_B = "extra-logs-2026.06.23"


# --------------------------------------------------------------------------- #
# A client that seeds TWO physical indices so a two-source /api/logs merge is
# observable end-to-end.
# --------------------------------------------------------------------------- #
@pytest.fixture
def client(secrets, mock_provider):
    overrides = {"anthropic": mock_provider, "openai": mock_provider, "mock": mock_provider}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        es = InMemoryESClient()
        base = to_millis(now_utc()) - 600_000
        # Two indices → two distinct pull sources.
        for i in range(5):
            es.add_log(INDEX_A, make_log_event(ip=f"10.0.0.{i}", ts_millis=base + i * 1000),
                       doc_id=f"a{i}")
        for i in range(5):
            es.add_log(INDEX_B, make_log_event(ip=f"10.1.0.{i}", ts_millis=base + i * 1000),
                       doc_id=f"b{i}")
        state = AppState.create(secrets=secrets, es=es, provider_overrides=overrides)
        await state.startup(start_poller=False)
        await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(router)
    with TestClient(api) as c:
        yield c


def _ms_ago(hours: float = 0.0) -> int:
    return to_millis(now_utc()) - int(hours * 3600 * 1000)


def _create_needs_human_case(client, mock_provider, ip: str) -> str:
    """Investigate a fresh IP → a NEEDS_HUMAN (open) case (never auto-closed)."""
    es = client.app.state.tlsoc.es
    es.add_log(INDEX_A, make_log_event(ip=ip, ts_millis=_ms_ago(hours=1)))
    mock_provider.push("router", json.dumps(
        {"bucket": "needs_strong_model", "confidence": 0.9, "reason": "serious"}))
    mock_provider.push("investigator", json.dumps({
        "action": "final", "reasoning": "scripted",
        "verdict": {
            "verdict": "NEEDS_HUMAN", "confidence": 0.2,
            "evidence": [{"summary": "e", "event_ids": []}],
            "mitre": [], "recommended_action": "review",
            "reproduce_query": 'source.ip : "x"',
        },
    }))
    r = client.post("/api/investigate",
                    json={"entity": {"type": "ip", "value": ip}, "source_surface": "investigate"})
    assert r.status_code == 200, r.text
    return r.json()["case_id"]


# --------------------------------------------------------------------------- #
# 1) BUG #3 — acknowledge → INVESTIGATING (non-terminal), NOT closed.
# --------------------------------------------------------------------------- #
def test_acknowledge_moves_to_investigating_not_closed(client, mock_provider):
    cid = _create_needs_human_case(client, mock_provider, "203.0.113.40")
    r = client.post(f"/api/cases/{cid}/action", json={"action": "acknowledge"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "investigating"
    assert body["status"] != "closed"
    # The lifecycle transition was recorded on the append-only status timeline.
    assert body["status_history"][-1]["to_status"] == "investigating"
    # acknowledged_at was stamped (SLA/MTTA anchor).
    assert body["acknowledged_at"] is not None
    # decision_by is the analyst layer (NOT the deterministic agent close-axis).
    assert body["decision_by"] == "analyst"


def test_acknowledge_does_not_call_decide(monkeypatch):
    """The acknowledge action must NEVER route through case_manager.decide() (#3).

    Patch decide() to explode if called, then run the FULL analyst-action code path
    for acknowledge and assert it completes without invoking it."""
    import asyncio

    from app.api import routes as routes_mod
    from app.constants import CaseStatus, EntityType, SourceSurface
    from app.engine import case_manager
    from app.models import Case, Entity

    def _boom(*a, **k):  # pragma: no cover — must never run
        raise AssertionError("decide() must not be called by an analyst action (#3)")

    monkeypatch.setattr(case_manager, "decide", _boom)

    class _Cases:
        def __init__(self, case):
            self._case = case

        async def get(self, cid):
            return self._case if cid == self._case.case_id else None

        async def save(self, case):
            self._case = case

    class _Audit:
        async def record(self, **k):
            return None

    class _Rag:
        async def index_resolved_case(self, *a, **k):
            return None

    case = Case(
        case_id="case-x", cluster_signature="sig-x",
        entity=Entity(type=EntityType.IP, value="9.9.9.9"),
        source_surface=SourceSurface.INVESTIGATE, status=CaseStatus.OPEN,
    )

    class _State:
        def __init__(self):
            self.cases = _Cases(case)
            self.audit = _Audit()
            self.rag = _Rag()
            self.prefs = None
            self.log_source = None
            self.proposals = None
            self.notifications = None

    body = routes_mod.CaseAction(action="acknowledge")
    out = asyncio.get_event_loop().run_until_complete(
        routes_mod._perform_case_action("case-x", body, "alice", _State())
    )
    assert out["status"] == "investigating"
    assert out["status"] != "closed"
    assert out["acknowledged_at"] is not None


def test_acknowledge_not_a_close_action():
    """acknowledge must NOT be treated as a close-axis move — RBAC stays cases:write,
    and its target status is NOT terminal."""
    from app.api import routes as routes_mod
    from app.constants import CaseStatus

    assert "acknowledge" not in routes_mod._CLOSE_ACTIONS
    assert routes_mod._ACTION_STATUS["acknowledge"] == CaseStatus.INVESTIGATING
    assert CaseStatus.INVESTIGATING not in routes_mod._TERMINAL
    # The grant resolver keeps it at cases:write (not cases:close).
    body = routes_mod.CaseAction(action="acknowledge")
    assert routes_mod._grant_for_body(body) == "write"


# --------------------------------------------------------------------------- #
# 2) GET /api/logs — merge across two sources with provenance + partial success.
# --------------------------------------------------------------------------- #
def test_unified_logs_merges_two_sources_with_provenance(client):
    assert client.post("/api/sources", json={
        "id": "elk-a", "source_type": "elasticsearch", "is_primary": True,
        "config": {"data_view_pattern": INDEX_A}}).status_code == 200
    assert client.post("/api/sources", json={
        "id": "elk-b", "source_type": "elasticsearch",
        "config": {"data_view_pattern": INDEX_B}}).status_code == 200

    r = client.get("/api/logs?limit=50")
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["partial"] is False
    # Rows from BOTH sources are present, each with a MANDATORY provenance column.
    seen_sources = {row["source_id"] for row in data["logs"]}
    assert {"elk-a", "elk-b"} <= seen_sources
    for row in data["logs"]:
        assert row["source_id"] in ("elk-a", "elk-b")
        assert row["source_name"]  # non-empty
        # Same _log_row shape → secrets never present (rows are log data only).
        assert "_raw" in row
    # Merge is newest-first by ts.
    ts_list = [row["ts"] for row in data["logs"] if row["ts"]]
    assert ts_list == sorted(ts_list, reverse=True)
    # Per-source status echoes an ok=True entry for each.
    ok_ids = {s["source_id"] for s in data["sources"] if s["ok"]}
    assert {"elk-a", "elk-b"} <= ok_ids


def test_unified_logs_tolerates_one_source_failing(client, monkeypatch):
    """One slow/failing source must degrade to a per-source error entry and NEVER
    block the others — partial success."""
    assert client.post("/api/sources", json={
        "id": "elk-a", "source_type": "elasticsearch", "is_primary": True,
        "config": {"data_view_pattern": INDEX_A}}).status_code == 200
    assert client.post("/api/sources", json={
        "id": "elk-b", "source_type": "elasticsearch",
        "config": {"data_view_pattern": INDEX_B}}).status_code == 200

    # Make source elk-b's search raise (a broken source).
    state = client.app.state.tlsoc
    orig_search = state.es.search_logs

    async def _flaky(index, body):
        if INDEX_B in str(index):
            raise RuntimeError("source elk-b is down")
        return await orig_search(index, body)

    monkeypatch.setattr(state.es, "search_logs", _flaky)

    r = client.get("/api/logs?limit=50")
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["partial"] is True
    # elk-a still returned its rows (partial success).
    good = {row["source_id"] for row in data["logs"]}
    assert "elk-a" in good
    assert "elk-b" not in good
    # elk-b is reported as a failed source (with an error), never silently dropped.
    failed = {s["source_id"] for s in data["sources"] if not s["ok"]}
    assert "elk-b" in failed
    err_entry = next(s for s in data["sources"] if s["source_id"] == "elk-b")
    assert err_entry.get("error")


def test_unified_logs_optional_source_id_scopes_the_fanout(client):
    """The OPTIONAL `source_id` scopes the fan-out to one source. Omitting it must stay
    byte-identical to the pre-existing all-sources behaviour."""
    assert client.post("/api/sources", json={
        "id": "elk-a", "source_type": "elasticsearch", "is_primary": True,
        "config": {"data_view_pattern": INDEX_A}}).status_code == 200
    assert client.post("/api/sources", json={
        "id": "elk-b", "source_type": "elasticsearch",
        "config": {"data_view_pattern": INDEX_B}}).status_code == 200

    before = client.get("/api/logs?limit=50").json()
    assert {s["source_id"] for s in before["sources"]} == {"elk-a", "elk-b"}

    scoped = client.get("/api/logs", params={"limit": 50, "source_id": "elk-b"})
    assert scoped.status_code == 200, scoped.text
    data = scoped.json()
    # Only the requested source is read, reported, and represented in the rows.
    assert {s["source_id"] for s in data["sources"]} == {"elk-b"}
    assert {row["source_id"] for row in data["logs"]} == {"elk-b"}
    assert data["partial"] is False
    # Provenance stays MANDATORY even when scoped to one source.
    assert all(row["source_name"] for row in data["logs"])

    # The unfiltered path is untouched by the scoped call (and an empty value is
    # treated as absent, matching the client's drop-empty query builder).
    after = client.get("/api/logs?limit=50").json()
    assert after == before
    assert client.get("/api/logs", params={"limit": 50, "source_id": ""}).json() == before


def test_unified_logs_rejects_an_unbrowsable_source_id_like_the_sibling(client):
    """An unknown id is a 404 and a known-but-ineligible id is a 501 — the same statuses
    `GET /api/sources/{id}/logs` uses, so the two browse routes never disagree."""
    assert client.post("/api/sources", json={
        "id": "elk-a", "source_type": "elasticsearch", "is_primary": True,
        "config": {"data_view_pattern": INDEX_A}}).status_code == 200
    assert client.post("/api/sources", json={
        "id": "elk-off", "source_type": "elasticsearch", "enabled": False,
        "config": {"data_view_pattern": INDEX_B}}).status_code == 200

    unknown = client.get("/api/logs", params={"source_id": "nope"})
    assert unknown.status_code == 404
    assert unknown.json()["detail"] == "Source not found"
    # Disabled → not an eligible browse target for the fan-out (same 501 as a source
    # whose connector cannot browse at all).
    off = client.get("/api/logs", params={"source_id": "elk-off"})
    assert off.status_code == 501
    assert off.json()["detail"] == "Browsing logs is not supported for this source"
    # The rejection never runs a read: the good source is unaffected.
    assert client.get("/api/logs?limit=5").status_code == 200


def test_unified_logs_reports_per_source_mode_and_bound(client):
    """Each per-source status says whether its rows came from a volatile live-tail ring
    ("buffer", which IGNORES from/to/query) or a real backing search, and the envelope
    declares the cap so the UI can say "most recent N"."""
    assert client.post("/api/sources", json={
        "id": "elk-a", "source_type": "elasticsearch", "is_primary": True,
        "config": {"data_view_pattern": INDEX_A}}).status_code == 200
    assert client.post("/api/sources", json={
        "id": "wh", "source_type": "webhook"}).status_code == 200

    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    assert client.post("/api/ingest/wh", json=[
        {"src_ip": "5.5.5.5", "user": "eve", "severity": "high", "signature": "s",
         "@timestamp": now, "id": f"evt-{i}"} for i in range(3)]).status_code == 200

    data = client.get("/api/logs?limit=50").json()
    modes = {s["source_id"]: s["mode"] for s in data["sources"]}
    assert modes == {"elk-a": "search", "wh": "buffer"}
    assert data["limit"] == 50
    assert data["truncated"] is False

    # A cap smaller than the merged set is reported honestly.
    cut = client.get("/api/logs?limit=2").json()
    assert cut["limit"] == 2 and cut["count"] == 2 and cut["truncated"] is True
    # An over-cap request is clamped to the hard 200 bound and says so.
    assert client.get("/api/logs?limit=9999").json()["limit"] == 200


def test_unified_logs_failed_source_still_reports_its_mode(client, monkeypatch):
    """A failing source keeps an honest `mode` on its status entry, so the UI can still
    explain why a time range did or did not apply to it."""
    assert client.post("/api/sources", json={
        "id": "elk-a", "source_type": "elasticsearch", "is_primary": True,
        "config": {"data_view_pattern": INDEX_A}}).status_code == 200

    state = client.app.state.tlsoc

    async def _boom(index, body):
        raise RuntimeError("source elk-a is down")

    monkeypatch.setattr(state.es, "search_logs", _boom)
    entry = next(s for s in client.get("/api/logs?limit=5").json()["sources"]
                 if s["source_id"] == "elk-a")
    assert entry["ok"] is False and entry["error"] and entry["mode"] == "search"


def test_unified_logs_includes_push_source(client):
    """A push (webhook) source's live-tail buffer participates in the unified merge
    with the same provenance column."""
    assert client.post("/api/sources", json={
        "id": "elk-a", "source_type": "elasticsearch", "is_primary": True,
        "config": {"data_view_pattern": INDEX_A}}).status_code == 200
    assert client.post("/api/sources", json={
        "id": "wh", "source_type": "webhook"}).status_code == 200

    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    alerts = [{"src_ip": "5.5.5.5", "user": "eve", "severity": "high",
               "signature": "ssh_bruteforce", "@timestamp": now, "id": f"evt-{i}"}
              for i in range(3)]
    assert client.post("/api/ingest/wh", json=alerts).status_code == 200

    r = client.get("/api/logs?limit=50")
    assert r.status_code == 200, r.text
    data = r.json()
    seen = {row["source_id"] for row in data["logs"]}
    assert "wh" in seen  # buffer rows merged in
    assert "elk-a" in seen


# --------------------------------------------------------------------------- #
# 3) GET /api/cases/{id}/forwarding — the deciding-gate object.
# --------------------------------------------------------------------------- #
def test_forwarding_returns_gate(client, mock_provider):
    cid = _create_needs_human_case(client, mock_provider, "203.0.113.41")
    r = client.get(f"/api/cases/{cid}/forwarding")
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["case_id"] == cid
    # The gate vocabulary is stable + names the deciding gate.
    from app.engine.forwarding import GATES

    assert data["gate"] in (set(GATES) | {"unknown"})
    assert isinstance(data["forwarded"], bool)
    assert isinstance(data["dropped"], bool)
    assert data["sentence"]  # a plain-English explanation


def test_forwarding_unknown_case_404(client):
    assert client.get("/api/cases/nope/forwarding").status_code == 404


# --------------------------------------------------------------------------- #
# 4) GET /api/sources/health — per-source health shape.
# --------------------------------------------------------------------------- #
def test_sources_health_shape(client):
    assert client.post("/api/sources", json={
        "id": "elk-a", "source_type": "elasticsearch", "is_primary": True,
        "config": {"data_view_pattern": INDEX_A}}).status_code == 200
    assert client.post("/api/sources", json={
        "id": "wh", "source_type": "webhook"}).status_code == 200

    r = client.get("/api/sources/health")
    assert r.status_code == 200, r.text
    rows = {s["source_id"]: s for s in r.json()["sources"]}
    assert {"elk-a", "wh"} <= set(rows)

    pull = rows["elk-a"]
    assert pull["kind"] == "pull"
    assert pull["enabled"] is True
    assert pull["is_primary"] is True
    assert pull["can_browse"] is True
    assert "last_poll_millis" in pull
    assert isinstance(pull["last_poll_millis"], int)

    push = rows["wh"]
    assert push["kind"] == "push"
    assert push["can_browse"] is True
    assert "buffer_depth" in push
    # No secrets in any health row.
    for row in rows.values():
        for k in row:
            assert "secret" not in k
            assert "api_key" not in k
