"""Round 15 WP7: one case's auto-close review state (SPEC D6.12, D8.2).

``GET /api/cases/{case_id}/review`` (``cases:read``) tells the case workspace whether
the case is in the review sample and whether a review can be recorded now, so it can
show the pending band, make Start review the primary action and offer "Review this
auto-close" only where the review endpoint would accept it. Offline: fake
Elasticsearch, mock model, sign-in and role-based access on.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from app.constants import CaseStatus
from app.stores.auto_close_review import ReviewLedger, ReviewLedgerUnavailable
from tests.test_round15_wp5_auto_close_review import (  # noqa: F401  (the fixture)
    _agent_closed,
    _ledger,
    _put,
    _sample,
    env,
)


def _state(c: TestClient, headers: dict[str, str], case_id: str) -> dict:
    response = c.get(f"/api/cases/{case_id}/review", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def test_an_unsampled_agent_close_can_be_reviewed_and_is_not_in_the_sample(env) -> None:
    c, state, h = env
    _put(c, state, _agent_closed("case-st-1"))
    assert _state(c, h["aud"], "case-st-1") == {
        "case_id": "case-st-1", "agent_closed": True, "state": "none", "can_record": True,
        "review_id": None, "sampled_at": None, "expires_at": None,
    }


def test_a_sampled_case_is_pending_with_its_expiry_until_it_is_reviewed(env) -> None:
    c, state, h = env
    _put(c, state, _agent_closed("case-st-2"))
    review_id = _sample(c, state, _agent_closed("case-st-2"))
    body = _state(c, h["t1"], "case-st-2")
    assert body["state"] == "pending" and body["agent_closed"] is True and body["can_record"] is True
    assert body["review_id"] == review_id
    sampled = datetime.fromisoformat(body["sampled_at"])
    assert datetime.fromisoformat(body["expires_at"]) == sampled + timedelta(days=7)

    r = c.post("/api/cases/case-st-2/review", headers=h["t2"], json={"classification": "false_positive"})
    assert r.status_code == 200, r.text
    after = _state(c, h["t1"], "case-st-2")
    assert after["state"] == "completed" and after["can_record"] is False
    assert after["expires_at"] is None and after["review_id"] == review_id


def test_an_expired_sample_reads_expired_and_can_still_be_reviewed(env) -> None:
    c, state, h = env
    old = datetime.now(timezone.utc) - timedelta(days=9)
    _put(c, state, _agent_closed("case-st-3", decided=old))
    _sample(c, state, _agent_closed("case-st-3", decided=old), when=old)
    body = _state(c, h["t1"], "case-st-3")
    assert body["state"] == "expired" and body["can_record"] is True


def test_a_reopened_sampled_case_stays_pending_but_cannot_be_reviewed_until_it_closes(env) -> None:
    """WP5 review note 14: the review endpoint answers 409 for a reopened case, so the
    workspace offers no Start review there."""
    c, state, h = env
    reopened = _agent_closed("case-st-4")
    _sample(c, state, reopened)
    reopened.status = CaseStatus.OPEN
    _put(c, state, reopened)
    body = _state(c, h["t1"], "case-st-4")
    assert body["state"] == "pending" and body["agent_closed"] is False and body["can_record"] is False
    r = c.post("/api/cases/case-st-4/review", headers=h["t2"], json={"classification": "benign"})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "review_not_agent_closed"


def test_a_case_the_agent_did_not_close_is_neither_sampled_nor_reviewable(env) -> None:
    c, state, h = env
    _put(c, state, _agent_closed("case-st-5", first_by="analyst"))
    body = _state(c, h["t1"], "case-st-5")
    assert body == {
        "case_id": "case-st-5", "agent_closed": False, "state": "none", "can_record": False,
        "review_id": None, "sampled_at": None, "expires_at": None,
    }


def test_a_pending_entry_whose_case_holds_its_review_reads_completed_and_is_repaired(env) -> None:
    c, state, h = env
    case = _agent_closed("case-st-6")
    _put(c, state, case)
    review_id = _sample(c, state, case)
    stored = c.portal.call(state.cases.get, "case-st-6")
    stored.history.append({"ts": "2026-11-23T12:00:00+00:00", "event": "auto_close_review",
                           "review_id": review_id, "feedback_ts": "2026-11-23T12:00:00+00:00",
                           "analyst": "t2", "agrees": True, "classification": "benign"})
    _put(c, state, stored)
    assert _ledger(c, state).entry_by_id(review_id).state == "pending"
    body = _state(c, h["t1"], "case-st-6")
    assert body["state"] == "completed" and body["can_record"] is False
    repaired = _ledger(c, state).entry_by_id(review_id)
    assert repaired.state == "completed" and repaired.reviewer == "t2"


def test_an_unknown_case_is_404_and_a_ledger_outage_is_503(env, monkeypatch) -> None:
    c, state, h = env
    r = c.get("/api/cases/no-such-case/review", headers=h["t1"])
    assert r.status_code == 404 and r.json()["detail"]["code"] == "case_not_found"
    _put(c, state, _agent_closed("case-st-7"))

    async def down(self) -> ReviewLedger:  # noqa: ANN001
        raise ReviewLedgerUnavailable("down")

    monkeypatch.setattr(type(state.real_auto_close_review), "load", down)
    r = c.get("/api/cases/case-st-7/review", headers=h["t1"])
    assert r.status_code == 503 and r.json()["detail"]["code"] == "review_ledger_unavailable"


def test_reading_the_state_changes_nothing_on_the_case(env) -> None:
    c, state, h = env
    case = _agent_closed("case-st-8")
    _put(c, state, case)
    _sample(c, state, case)
    before = c.portal.call(state.cases.get, "case-st-8").model_dump(mode="json")
    _state(c, h["admin"], "case-st-8")
    after = c.portal.call(state.cases.get, "case-st-8").model_dump(mode="json")
    assert after == before


def test_the_route_requires_cases_read_explicitly() -> None:
    from app.api import routes_auto_close_review as module

    (route,) = [
        r for r in module.router.routes
        if getattr(r, "path", "") == "/api/cases/{case_id}/review" and "GET" in getattr(r, "methods", set())
    ]
    names = [getattr(d.call, "__qualname__", "") for d in route.dependant.dependencies]
    assert any("require_permission" in name for name in names), names
