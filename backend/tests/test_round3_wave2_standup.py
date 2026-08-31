"""Round 3 / Wave 2 — Feature 11: useful Standup / shift handoff.

Covers:
  * engine/shift_report.py pure functions (urgency ranking, SLA aging, workload,
    period deltas, priority derivation) — deterministic, no I/O, #3-safe.
  * agents/standup.StandupService — the shift block folds into the SAME compact
    aggregate, leads it, and the LEGACY behaviour (no cases store) is preserved; only
    the compact aggregate (never raw logs / case bodies) reaches the model (#7/#9).
  * api/routes_standup.py — /report, action-item CRUD, acknowledge, acknowledgements,
    end to end over a TestClient.

Self-contained: builds its own in-memory case repository + KV so it runs WITHOUT the
integrator's state wiring, and a TestClient that mounts ONLY the standup router.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.agents.standup import SHIFT_STANDUP_SYSTEM, StandupService
from app.config import PriorityMatrix, SlaPolicy, SlaTarget
from app.constants import CaseStatus, EntityType, SourceSurface, Verdict
from app.engine import shift_report
from app.models import Entity, Case
from app.stores.shift_handoff import ShiftHandoffStore
from app.utils import iso_now, now_utc


# --------------------------------------------------------------------------- #
# Lightweight test doubles
# --------------------------------------------------------------------------- #
class FakeKV:
    """A trivial in-process KVStore for the ShiftHandoffStore."""

    def __init__(self) -> None:
        self._d: dict[tuple[str, str], dict[str, Any]] = {}

    async def get(self, namespace: str, key: str):
        return self._d.get((namespace, key))

    async def put(self, namespace: str, key: str, value: dict[str, Any]) -> None:
        self._d[(namespace, key)] = value


class FakeCaseRepo:
    """An in-memory CaseRepository exposing just ``list(status=..., limit=..., ...)``
    (the only method StandupService._open_cases() calls)."""

    def __init__(self, cases: list[Case]) -> None:
        self._cases = cases

    async def list(self, *, status: str | None = None, limit: int = 50, offset: int = 0,
                   sort_field: str = "created_at", sort_order: str = "desc", **_: Any):
        rows = [c for c in self._cases if status is None or c.status.value == status]
        return rows[offset: offset + limit], len(rows)


class FakeAudit:
    async def record(self, **_: Any) -> None:  # noqa: D401 — no-op test double
        return None


class FakeGateway:
    """A gateway whose ``complete`` echoes the system prompt marker so the test can
    assert WHICH prompt was used, and returns a small cost."""

    def __init__(self) -> None:
        self.last_messages: list[dict[str, Any]] | None = None

    async def complete(self, role, messages, model, surface: str = ""):
        self.last_messages = messages

        class _Res:
            text = "handoff brief"
            cost = 0.001

        return _Res()


def _case(
    *,
    cid: str,
    status: CaseStatus,
    risk: float = 50.0,
    severity_band: str | None = None,
    priority: str | None = None,
    assignee: str = "",
    verdict: Verdict | None = None,
    age_minutes: float = 30.0,
    title: str = "",
    entity_value: str = "10.0.0.1",
) -> Case:
    created = now_utc() - timedelta(minutes=age_minutes)
    return Case(
        case_id=cid,
        cluster_signature=f"sig-{cid}",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value=entity_value),
        risk_score=risk,
        status=status,
        verdict=verdict,
        severity_band=severity_band,
        priority_level=priority,
        assignee=assignee,
        title=title or f"case {cid}",
        created_at=created.isoformat(),
    )


# --------------------------------------------------------------------------- #
# engine/shift_report.py — pure functions
# --------------------------------------------------------------------------- #
def test_urgency_score_ranks_risk_severity_age():
    now = now_utc()
    hot = _case(cid="hot", status=CaseStatus.OPEN, risk=95.0, severity_band="critical", age_minutes=200)
    cold = _case(cid="cold", status=CaseStatus.OPEN, risk=5.0, severity_band="low", age_minutes=1)
    assert shift_report.urgency_score(hot, now=now) > shift_report.urgency_score(cold, now=now)


def test_urgency_unknown_band_does_not_inflate():
    """An unrecognised (possibly attacker-influenced) band contributes NOTHING.

    Pinned as an EQUIVALENCE against a case that carries no band at all, which is the
    honest statement of the property: the junk string is rejected by the
    ``in SEVERITY_BANDS`` membership test and cannot move the score in either direction.

    It is pinned this way rather than against a literal because the severity term is no
    longer always zero. ``Case.severity_band`` is a READ-TIME field that no production
    path persists, so reading the attribute directly used to score EVERY real case at
    0.0 and rank the queue on risk + age alone; the band is now resolved through
    ``priority.band_of_case``. A case with no source-asserted severity still falls back
    to the deterministic risk total, so the two cases below agree exactly."""
    now = now_utc()
    junk = _case(cid="j", status=CaseStatus.OPEN, risk=10.0, severity_band="; DROP TABLE", age_minutes=0)
    no_band = _case(cid="n", status=CaseStatus.OPEN, risk=10.0, severity_band=None, age_minutes=0)
    assert shift_report.urgency_score(junk, now=now) == pytest.approx(
        shift_report.urgency_score(no_band, now=now), abs=1e-9
    )
    # ...and it cannot buy the rank a genuinely CRITICAL case earns.
    critical = _case(cid="c", status=CaseStatus.OPEN, risk=10.0, severity_band="critical", age_minutes=0)
    assert shift_report.urgency_score(junk, now=now) < shift_report.urgency_score(critical, now=now)


def test_attention_queue_only_open_and_ranked():
    now = now_utc()
    cases = [
        _case(cid="a", status=CaseStatus.CLOSED, risk=99.0),     # terminal → excluded
        _case(cid="b", status=CaseStatus.RESOLVED, risk=99.0),   # terminal → excluded
        _case(cid="c", status=CaseStatus.OPEN, risk=20.0, severity_band="low", age_minutes=5),
        _case(cid="d", status=CaseStatus.ESCALATED, risk=80.0, severity_band="high", age_minutes=120),
    ]
    q = shift_report.attention_queue(cases, now=now)
    ids = [r["case_id"] for r in q]
    assert "a" not in ids and "b" not in ids
    assert ids[0] == "d"  # escalated + high risk ranks first
    # Deep-link payload carries the case id + plain entity value (#9 — returned plain).
    assert q[0]["case_id"] == "d"
    assert q[0]["entity"] == "10.0.0.1"


def test_attention_queue_limit():
    now = now_utc()
    cases = [_case(cid=f"c{i}", status=CaseStatus.OPEN, risk=float(i)) for i in range(40)]
    q = shift_report.attention_queue(cases, now=now, limit=10)
    assert len(q) == 10


def test_sla_aging_breached_and_about_to_breach():
    now = now_utc()
    sla = SlaPolicy(enabled=True, targets={"P1": SlaTarget(response_minutes=15, resolve_minutes=240)})
    breached = _case(cid="br", status=CaseStatus.OPEN, priority="P1", age_minutes=60)   # >15
    warn = _case(cid="warn", status=CaseStatus.OPEN, priority="P1", age_minutes=13)      # >=0.75*15
    fresh = _case(cid="fresh", status=CaseStatus.OPEN, priority="P1", age_minutes=1)
    out = shift_report.sla_aging([breached, warn, fresh], sla, now=now)
    assert out["enabled"] is True
    assert out["totals"]["breached"] == 1
    assert out["totals"]["about_to_breach"] == 1
    assert out["breached"][0]["case_id"] == "br"
    assert out["breached"][0]["overdue_minutes"] > 0


def test_sla_aging_disabled_reports_no_breaches():
    now = now_utc()
    c = _case(cid="x", status=CaseStatus.OPEN, priority="P1", age_minutes=9999)
    out = shift_report.sla_aging([c], SlaPolicy(enabled=False), now=now)
    assert out["enabled"] is False
    assert out["totals"]["breached"] == 0
    # still rolls up the open count per priority (advisory display)
    assert out["by_priority"]["P1"]["open"] == 1


def test_analyst_workload_buckets_unassigned():
    cases = [
        _case(cid="1", status=CaseStatus.OPEN, assignee="alice"),
        _case(cid="2", status=CaseStatus.ESCALATED, assignee="alice"),
        _case(cid="3", status=CaseStatus.OPEN, assignee=""),
        _case(cid="4", status=CaseStatus.CLOSED, assignee="bob"),  # terminal → ignored
    ]
    wl = shift_report.analyst_workload(cases)
    by = {r["analyst"]: r for r in wl}
    assert by["alice"]["open"] == 2
    assert by["alice"]["escalated"] == 1
    assert by["(unassigned)"]["open"] == 1
    assert "bob" not in by
    # busiest first
    assert wl[0]["analyst"] == "alice"


def test_period_deltas():
    cur = {"open": 10, "escalated": 3}
    pri = {"open": 7, "escalated": 5, "needs_human": 1}
    d = shift_report.period_deltas(cur, pri)
    assert d["open"] == {"current": 10, "prior": 7, "delta": 3}
    assert d["escalated"]["delta"] == -2
    assert d["needs_human"] == {"current": 0, "prior": 1, "delta": -1}


def test_derive_priority_matrix():
    m = PriorityMatrix(enabled=True)
    assert shift_report.derive_priority("high", "high", m) == "P1"
    assert shift_report.derive_priority("low", "low", m) == "P4"
    # unmapped pair → default; disabled → None
    assert shift_report.derive_priority("weird", "weird", m) == m.default_priority
    assert shift_report.derive_priority("high", "high", PriorityMatrix(enabled=False)) is None


def test_build_shift_report_shape():
    now = now_utc()
    cur = [_case(cid="c", status=CaseStatus.OPEN, age_minutes=10)]
    prior = []
    rep = shift_report.build_shift_report(cur, prior, now=now)
    assert set(rep) >= {"attention_queue", "sla_aging", "workload", "headline_counts", "deltas"}
    assert rep["headline_counts"]["open"] == 1
    assert rep["deltas"]["open"]["delta"] == 1


# --------------------------------------------------------------------------- #
# agents/standup.StandupService — fold + prompt + legacy preservation
# --------------------------------------------------------------------------- #
class _FakeES:
    """Minimal ES double for StandupService: empty log aggregation + case stats."""

    async def search_logs(self, index: str, body: dict[str, Any]) -> dict[str, Any]:
        return {"hits": {"total": {"value": 0}}, "aggregations": {}}

    async def search(self, index: str, body: dict[str, Any]) -> dict[str, Any]:
        return {"hits": {"total": {"value": 0}}, "aggregations": {}}


def _prefs():
    from app.config import Preferences

    return Preferences(sla=SlaPolicy(enabled=True))


@pytest.mark.asyncio
async def test_standup_folds_shift_block_and_uses_shift_prompt():
    cases = FakeCaseRepo([
        _case(cid="urgent", status=CaseStatus.ESCALATED, risk=90.0, severity_band="critical",
              priority="P1", age_minutes=300),
        _case(cid="mild", status=CaseStatus.OPEN, risk=10.0, age_minutes=5),
    ])
    gw = FakeGateway()
    handoff = ShiftHandoffStore(FakeKV())
    await handoff.add_action_item("rotate the leaked key", owner="alice")
    svc = StandupService(_FakeES(), gw, FakeAudit(), cases=cases, shift_handoff=handoff)

    result = await svc.generate(_prefs(), window_hours=24)

    # The shift block is present, top-level AND leading the compact aggregate.
    assert "shift" in result
    agg = result["aggregate"]
    assert list(agg.keys())[0] == "shift"  # LEADS the aggregate
    sq = result["shift"]["attention_queue"]
    assert sq and sq[0]["case_id"] == "urgent"
    # SLA aging + workload + deltas + action items all present.
    assert result["shift"]["sla_aging"]["enabled"] is True
    assert any(r["analyst"] for r in result["shift"]["workload"])
    assert result["shift"]["action_items"][0]["title"] == "rotate the leaked key"

    # The SHIFT prompt was used (leads with "what needs attention").
    assert gw.last_messages is not None
    assert gw.last_messages[0]["content"] == SHIFT_STANDUP_SYSTEM
    # Only the COMPACT, FENCED aggregate goes to the model — never raw logs / bodies (#7/#9).
    user_msg = gw.last_messages[1]["content"]
    assert "<<<" in user_msg or "fence" in user_msg.lower() or "UNTRUSTED" in user_msg.upper()


@pytest.mark.asyncio
async def test_standup_legacy_without_cases_uses_base_prompt():
    """No cases/handoff wired → no shift block → legacy base standup prompt (back-compat)."""
    from app.agents.prompts import STANDUP_SYSTEM

    gw = FakeGateway()
    svc = StandupService(_FakeES(), gw, FakeAudit())  # cases=None, shift_handoff=None
    result = await svc.generate(_prefs(), window_hours=24)
    # No case store → NO shift block folded into the aggregate (legacy byte-identical),
    # top-level shift is an empty dict, and the BASE standup prompt is used.
    assert result["shift"] == {}
    assert "shift" not in result["aggregate"]
    assert gw.last_messages[0]["content"] == STANDUP_SYSTEM


@pytest.mark.asyncio
async def test_standup_never_raises_on_degraded_store():
    class _BoomRepo:
        async def list(self, **_: Any):
            raise RuntimeError("store down")

    gw = FakeGateway()
    svc = StandupService(_FakeES(), gw, FakeAudit(), cases=_BoomRepo())
    result = await svc.generate(_prefs(), window_hours=24)
    # Degraded case store → empty attention queue, never a 500/exception.
    assert result["shift"]["attention_queue"] == []


# --------------------------------------------------------------------------- #
# api/routes_standup.py — end to end
# --------------------------------------------------------------------------- #
@pytest.fixture
def standup_client(secrets, mock_provider):
    """A TestClient mounting ONLY the standup router, over an AppState whose standup
    service is re-wired with a FakeCaseRepo + a real ShiftHandoffStore (mirrors the
    integrator's state wiring shape)."""
    from contextlib import asynccontextmanager

    from app.es.fake import InMemoryESClient
    from app.state import AppState
    from app.api import routes_standup

    overrides = {"anthropic": mock_provider, "openai": mock_provider, "mock": mock_provider}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
        await state.startup(start_poller=False)
        await state.update_prefs(state.prefs.model_copy(
            update={"setup_complete": True, "sla": SlaPolicy(enabled=True)}
        ))
        # Re-wire the standup service with cases + the shift-handoff store (the exact
        # shape the integrator applies in state.py).
        cases = FakeCaseRepo([
            _case(cid="alpha", status=CaseStatus.ESCALATED, risk=88.0, severity_band="high",
                  priority="P1", age_minutes=300, assignee="alice"),
            _case(cid="beta", status=CaseStatus.OPEN, risk=12.0, age_minutes=5),
        ])
        state._real_standup_service = StandupService(
            state.es, state.gateway, state._real_audit,
            cases=cases, shift_handoff=state.shift_handoff,
        )
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(routes_standup.router)
    with TestClient(api) as c:
        yield c


def test_report_endpoint(standup_client):
    r = standup_client.get("/api/standup/report")
    assert r.status_code == 200
    body = r.json()
    assert body["enabled"] is True
    assert body["attention_queue"][0]["case_id"] == "alpha"  # ranked first
    assert body["sla_aging"]["enabled"] is True
    assert any(w["analyst"] == "alice" for w in body["workload"])
    assert "deltas" in body and "window" in body


def test_report_endpoint_disabled(standup_client):
    # Disable standup → {enabled: false} shape, still 200. Mutate prefs on the live
    # state via the running client's async portal.
    state = standup_client.app.state.tlsoc

    async def _disable():
        await state.update_prefs(state.prefs.model_copy(
            update={"standup": state.prefs.standup.model_copy(update={"enabled": False})}
        ))

    standup_client.portal.call(_disable)
    r = standup_client.get("/api/standup/report")
    assert r.status_code == 200
    assert r.json()["enabled"] is False


def test_action_item_crud(standup_client):
    # create
    r = standup_client.post("/api/standup/action-items", json={"title": "patch host web01", "owner": "bob"})
    assert r.status_code == 200
    item = r.json()["item"]
    assert item["title"] == "patch host web01"
    item_id = item["id"]

    # list (open only)
    r = standup_client.get("/api/standup/action-items", params={"open_only": True})
    assert r.status_code == 200
    assert any(i["id"] == item_id for i in r.json()["items"])

    # update
    r = standup_client.put(f"/api/standup/action-items/{item_id}", json={"status": "in_progress"})
    assert r.status_code == 200
    assert r.json()["item"]["status"] == "in_progress"

    # delete
    r = standup_client.delete(f"/api/standup/action-items/{item_id}")
    assert r.status_code == 200 and r.json()["ok"] is True

    # update / delete missing → 404
    assert standup_client.put(f"/api/standup/action-items/{item_id}", json={"status": "done"}).status_code == 404
    assert standup_client.delete(f"/api/standup/action-items/{item_id}").status_code == 404


def test_acknowledge_and_list(standup_client):
    r = standup_client.post("/api/standup/acknowledge", json={"window": "2026-06-30/day", "note": "read it"})
    assert r.status_code == 200
    ack = r.json()["ack"]
    assert ack["window"] == "2026-06-30/day"
    # default user "operator" when auth is off
    assert ack["user"] == "operator"

    r = standup_client.get("/api/standup/acknowledgements", params={"window": "2026-06-30/day"})
    assert r.status_code == 200
    acks = r.json()["acknowledgements"]
    assert acks and acks[0]["window"] == "2026-06-30/day"


def test_acknowledge_default_window(standup_client):
    # No window supplied → the route derives the current YYYY-MM-DD/<shift> window.
    r = standup_client.post("/api/standup/acknowledge", json={})
    assert r.status_code == 200
    assert "/" in r.json()["ack"]["window"]


def test_report_action_items_surface(standup_client):
    # An open action item shows up in the report payload.
    standup_client.post("/api/standup/action-items", json={"title": "block 1.2.3.4"})
    body = standup_client.get("/api/standup/report").json()
    titles = [a["title"] for a in body["action_items"]]
    assert "block 1.2.3.4" in titles
