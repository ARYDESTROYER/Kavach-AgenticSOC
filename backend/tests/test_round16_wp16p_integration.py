"""Round 16 WP16P: the post-integration fixes on the backend (SPEC 4.6 WP16).

1. ``GET /api/audit`` and ``GET /api/audit/records/{id}`` follow ``cost:view`` for the
   spend figure a timeout, budget refusal, case manager or runbook AI row put into its
   ``result_summary`` (``api.cost_text``), as the case trace does.
2. A budget refusal's reason kept in ``Case.error`` (the fail-to-human path) reads
   ``(amount hidden)`` on every case read for a viewer without ``cost:view``.
3. A precedent candidate whose case was deleted after the candidate list was read is
   never saved back from the candidate copy, and nothing is projected for it.

``decide()`` and ``engine/risk.py`` are untouched (``test_round16_spine_guards.py``); no
model call is added. Offline: fake Elasticsearch, mock model.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import Depends
from fastapi.testclient import TestClient

from app.constants import (
    ActionType,
    CaseStatus,
    DecisionBy,
    EntityType,
    SourceSurface,
    UserRole,
    Verdict,
)
from app.models import AuditDoc, Case, Entity
from app.utils import iso_now

AUDITOR = UserRole.AUDITOR.value
_REFUSAL = ("pipeline error: budget ceiling exceeded: daily spend $1.2345 + est $0.0100 "
            "would exceed the $10.00 daily ceiling")
_SPEND_ROWS = (
    AuditDoc(case_id="case-wp16p", actor="pipeline", action_type=ActionType.ERROR,
             result_summary="investigation timed out after 120s; capped to NEEDS_HUMAN (partial cost=0.0213)"),
    AuditDoc(case_id="case-wp16p", actor="pipeline", action_type=ActionType.ERROR, result_summary=_REFUSAL),
    AuditDoc(case_id="case-wp16p", actor="case_manager", action_type=ActionType.DECISION,
             result_summary="verdict=TRUE_POSITIVE status=needs_human risk=40.0 cost=0.0213 confidence=0.9"),
)
_EVIDENCE = AuditDoc(case_id="case-wp16p", actor="investigator", action_type=ActionType.TOOL_CALL,
                     tool_name="es_query", result_summary="wire amount=$5000 cost=3")
_FIGURES = ("0.0213", "$1.2345", "$10.00")


# --------------------------------------------------------------------------- #
# 1. The audit log follows cost:view
# --------------------------------------------------------------------------- #
def _audit_client(**kwargs: Any) -> TestClient:
    from app.api.deps import require_auth
    from app.api.routes_audit import router as audit_router
    from tests.test_spend_gates import _client

    client = _client(**kwargs)
    client.app.include_router(audit_router, dependencies=[Depends(require_auth)])
    return client


def _seed_audit(client: TestClient) -> None:
    state = client.app.state.tlsoc
    for row in (*_SPEND_ROWS, _EVIDENCE):
        client.portal.call(state.audit.write, row.model_copy())


def _audit_texts(client: TestClient) -> tuple[list[str], list[str]]:
    page = client.get("/api/audit", params={"case_id": "case-wp16p", "limit": "50"})
    assert page.status_code == 200, page.text
    records = page.json()["records"]
    listed = [r.get("result_summary") or "" for r in records]
    opened = []
    for record in records:
        one = client.get(f"/api/audit/records/{record['record_id']}")
        assert one.status_code == 200, one.text
        opened.append(one.json().get("result_summary") or "")
    return listed, opened


@pytest.mark.parametrize("cost_view", [True, False])
def test_the_audit_log_follows_cost_view_for_spend_text(cost_view: bool) -> None:
    from tests.test_spend_gates import _sign_in_as

    denies = None if cost_view else {"cost": ["view"]}
    with _audit_client(role=AUDITOR, denies=denies) as client:
        _sign_in_as(client, AUDITOR)
        _seed_audit(client)
        listed, opened = _audit_texts(client)
        for texts in (listed, opened):
            joined = " | ".join(texts)
            assert len(texts) >= 4
            # Evidence is never rewritten, whatever the grant.
            assert "wire amount=$5000 cost=3" in texts
            if cost_view:
                for figure in ("partial cost=0.0213", "$1.2345", "$10.00", "cost=0.0213"):
                    assert figure in joined, figure
            else:
                assert "partial cost=hidden" in joined and "(amount hidden)" in joined
                spend = [t for t in texts if t != "wire amount=$5000 cost=3"]
                for figure in _FIGURES:
                    assert all(figure not in t for t in spend), figure


# --------------------------------------------------------------------------- #
# 2. A budget refusal kept in Case.error follows cost:view on case reads
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("cost_view", [True, False])
def test_a_budget_refusal_in_case_error_follows_cost_view(cost_view: bool) -> None:
    from tests.test_spend_gates import CASE_ID, T1, _case_spend_reads, _client, _sign_in_as

    with _client(denies=None if cost_view else {"cost": ["view"]}) as client:
        _sign_in_as(client, T1)
        state = client.app.state.tlsoc
        stored = client.portal.call(state.cases.get, CASE_ID)
        client.portal.call(state.cases.save, stored.model_copy(update={"error": _REFUSAL}))
        reads = _case_spend_reads(client)
        for name, case in reads.items():
            error = case.get("error") or ""
            assert "budget ceiling exceeded" in error, name
            if cost_view:
                assert error == _REFUSAL, name
            else:
                assert "(amount hidden)" in error, name
                for figure in ("$1.2345", "$0.0100", "$10.00"):
                    assert figure not in error, (name, figure)
        # The stored case keeps the recorded reason (display only).
        assert client.portal.call(state.cases.get, CASE_ID).error == _REFUSAL


# --------------------------------------------------------------------------- #
# 3. A deleted case is never brought back by a precedent candidate
# --------------------------------------------------------------------------- #
def _closed_case() -> Case:
    return Case(
        case_id="case-wp16p", case_number="CASE-0162", cluster_signature="sig-wp16p",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="192.0.2.162"),
        member_event_ids=["sig-wp16p-e1"], rule_ids=["linux_auth"],
        status=CaseStatus.CLOSED, verdict=Verdict.FALSE_POSITIVE, confidence=0.9,
        decision_by=DecisionBy.AGENT, risk_score=30.0, created_at=iso_now(), updated_at=iso_now(),
    )


async def test_a_precedent_candidate_never_saves_back_a_deleted_case(app_state, monkeypatch) -> None:
    from app.api.routes_rag import perform_precedent_candidate

    await app_state.cases.save(_closed_case())
    candidate = await app_state.cases.get("case-wp16p")  # the candidate list's copy
    store = app_state._real_cases
    real_get = store.get
    saves: list[str] = []
    projected: list[Any] = []

    async def deleted_get(case_id, *a, **k):
        if case_id == "case-wp16p":
            return None  # deleted after the candidate list was read
        return await real_get(case_id, *a, **k)

    async def save(case, *a, **k):
        saves.append(case.case_id)

    async def index(items, **_k):
        projected.extend(items)
        return len(items)

    monkeypatch.setattr(store, "get", deleted_get)
    monkeypatch.setattr(store, "save", save)
    monkeypatch.setattr(app_state.rag_service, "index_precedent_items", index)
    try:
        await perform_precedent_candidate(candidate, {"metadata": {"outcome": "benign"}},
                                          app_state, actor="ops", batch_id="b-gone")
    except LookupError as exc:
        # The candidate fails, so the batch and the job count it as not ratified.
        assert "deleted" in str(exc)
    else:
        pytest.fail("a deleted case was ratified")
    assert saves == []
    assert projected == []
