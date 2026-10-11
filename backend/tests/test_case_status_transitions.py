"""Case status taxonomy + lifecycle transitions (F8).

Covers the new analyst lifecycle actions on POST /cases/{id}/action (hold/resume/
resolve/set_disposition/escalate/deescalate/set_status), the transition guard
(illegal moves rejected; reopen allowed out of a terminal status), the appended
status_history, and that stored OLD-enum cases (open/needs_human/closed) load.
"""

from __future__ import annotations

import json

from app.constants import CaseStatus, Disposition, EntityType, SourceSurface
from app.models import Case, Entity
from app.utils import now_utc, to_millis
from tests.conftest import make_log_event


def _seed(client, **kw) -> str:
    es = client.app.state.tlsoc.es
    return es.add_log("all-logs-2026.06.16", make_log_event(**kw))


def _ms_ago(hours: float = 0.0) -> int:
    return to_millis(now_utc()) - int(hours * 3600 * 1000)


def _create_case(client, mock_provider, ip: str) -> str:
    _seed(client, ip=ip, ts_millis=_ms_ago(hours=1))
    mock_provider.push("router", json.dumps(
        {"bucket": "needs_strong_model", "confidence": 0.9, "reason": "serious"}))
    mock_provider.push("investigator", json.dumps({
        "action": "final", "reasoning": "scripted",
        "verdict": {
            "verdict": "NEEDS_HUMAN", "confidence": 0.2,
            "evidence": [{"summary": "e", "event_ids": []}],
            "mitre": [], "recommended_action": "review", "reproduce_query": 'source.ip : "x"',
        },
    }))
    r = client.post("/api/investigate",
                    json={"entity": {"type": "ip", "value": ip}, "source_surface": "investigate"})
    assert r.status_code == 200, r.text
    return r.json()["case_id"]


def _action(client, case_id, **body):
    return client.post(f"/api/cases/{case_id}/action", json=body)


# --- lifecycle actions ---------------------------------------------------------
def test_hold_resume_resolve_cycle(client, mock_provider):
    cid = _create_case(client, mock_provider, "203.0.113.10")
    r = _action(client, cid, action="hold", reason="awaiting vendor")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "on_hold"
    assert body["status_reason"] == "awaiting vendor"
    assert body["status_history"][-1]["to_status"] == "on_hold"

    r = _action(client, cid, action="resume")
    assert r.json()["status"] == "open"

    r = _action(client, cid, action="resolve", reason="confirmed benign activity")
    assert r.json()["status"] == "resolved"


def test_set_disposition(client, mock_provider):
    cid = _create_case(client, mock_provider, "203.0.113.11")
    r = _action(client, cid, action="set_disposition", disposition="benign", reason="known scanner")
    assert r.status_code == 200, r.text
    assert r.json()["disposition"] == "benign"
    # set_disposition does not move the lifecycle status by itself.


def test_set_disposition_rejects_unknown(client, mock_provider):
    cid = _create_case(client, mock_provider, "203.0.113.12")
    r = _action(client, cid, action="set_disposition", disposition="nonsense")
    assert r.status_code == 400


def test_escalate_then_deescalate(client, mock_provider):
    cid = _create_case(client, mock_provider, "203.0.113.13")
    # The legacy `level` input remains wire-compatible, but current operator
    # surfaces render the resulting lifecycle state simply as Escalated.
    r = _action(client, cid, action="escalate", level=3, reason="requires analyst action")
    assert r.json()["status"] == "escalated"
    assert r.json()["escalation_level"] == 3
    r = _action(client, cid, action="deescalate")
    assert r.json()["status"] == "open"
    assert r.json()["escalation_level"] == 0


def test_set_status_arbitrary_legal(client, mock_provider):
    cid = _create_case(client, mock_provider, "203.0.113.14")
    r = _action(client, cid, action="set_status", status="investigating")
    assert r.json()["status"] == "investigating"


def test_set_status_unknown_rejected(client, mock_provider):
    cid = _create_case(client, mock_provider, "203.0.113.15")
    r = _action(client, cid, action="set_status", status="bogus")
    assert r.status_code == 400


def test_set_status_cannot_close(client, mock_provider):
    cid = _create_case(client, mock_provider, "203.0.113.16")
    r = _action(client, cid, action="set_status", status="closed")
    assert r.status_code == 400  # must use close action


# --- transition guard ----------------------------------------------------------
def test_closed_cannot_move_without_reopen(client, mock_provider):
    cid = _create_case(client, mock_provider, "203.0.113.17")
    assert _action(client, cid, action="close").json()["status"] == "closed"
    # A forward move out of terminal CLOSED is rejected unless via reopen.
    r = _action(client, cid, action="hold")
    assert r.status_code == 400
    # Reopen is explicitly allowed.
    assert _action(client, cid, action="reopen").json()["status"] == "open"


def test_resolved_case_takes_its_final_close(client, mock_provider):
    """RESOLVED is "worked to completion, pending final close", so the dedicated close
    verb finishes it, records the declared outcome and appends resolved → closed."""
    cid = _create_case(client, mock_provider, "203.0.113.30")
    r = _action(client, cid, action="resolve", disposition="false_positive",
                disposition_declared=True, reason="benign scanner")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "resolved"

    r = _action(client, cid, action="close", disposition="benign",
                disposition_declared=True, note="final close")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "closed"
    assert body["disposition"] == "benign"
    last = body["status_history"][-1]
    assert (last["from_status"], last["to_status"]) == ("resolved", "closed")
    assert body["history"][-1]["action"] == "close"
    assert body["history"][-1]["classified_disposition"] == "benign"
    assert body["decision_by"] == "analyst"

    # Already closed: a repeat close stays a same-status no-op (no new transition).
    r = _action(client, cid, action="close")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "closed"
    assert len(r.json()["status_history"]) == len(body["status_history"])


def test_resolved_case_confirm_fp_closes_it(client, mock_provider):
    cid = _create_case(client, mock_provider, "203.0.113.31")
    assert _action(client, cid, action="resolve").json()["status"] == "resolved"
    r = _action(client, cid, action="confirm_fp")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "closed"
    assert r.json()["disposition"] == "false_positive"


def test_resolved_case_other_moves_still_need_reopen(client, mock_provider):
    """Only close/confirm_fp may leave RESOLVED forward; every other move out of a
    terminal status still needs an explicit reopen, and set_status never closes."""
    cid = _create_case(client, mock_provider, "203.0.113.32")
    assert _action(client, cid, action="resolve").json()["status"] == "resolved"
    for body in (
        {"action": "set_status", "status": "open"},
        {"action": "set_status", "status": "closed"},
        {"action": "hold"},
        {"action": "escalate"},
        {"action": "acknowledge"},
        {"action": "resume"},
    ):
        r = _action(client, cid, **body)
        assert r.status_code == 400, (body, r.text)
    assert client.get(f"/api/cases/{cid}").json()["status"] == "resolved"
    # Recording the outcome never moves the status, so it stays legal here.
    r = _action(client, cid, action="set_disposition", disposition="benign")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "resolved"
    assert _action(client, cid, action="reopen").json()["status"] == "open"


def test_closed_case_cannot_go_back_to_resolved(client, mock_provider):
    cid = _create_case(client, mock_provider, "203.0.113.33")
    assert _action(client, cid, action="close").json()["status"] == "closed"
    r = _action(client, cid, action="resolve", disposition="benign", disposition_declared=True)
    assert r.status_code == 400
    assert "reopen the case first" in r.json()["detail"]
    assert client.get(f"/api/cases/{cid}").json()["status"] == "closed"


def test_bulk_close_finishes_resolved_cases(client, mock_provider):
    """The bulk path shares the single-case guard, so a resolved row in the All scope
    closes instead of failing with an illegal-transition error."""
    resolved = _create_case(client, mock_provider, "203.0.113.34")
    working = _create_case(client, mock_provider, "203.0.113.35")
    assert _action(client, resolved, action="resolve").json()["status"] == "resolved"
    r = client.post("/api/cases/bulk", json={
        "ids": [resolved, working], "action": "close",
        "disposition": "true_positive", "disposition_declared": True,
    })
    assert r.status_code == 200, r.text
    assert all(row["ok"] for row in r.json()["results"]), r.json()
    for cid in (resolved, working):
        got = client.get(f"/api/cases/{cid}").json()
        assert got["status"] == "closed"
        assert got["disposition"] == "true_positive"


def test_confirm_fp_sets_disposition(client, mock_provider):
    cid = _create_case(client, mock_provider, "203.0.113.18")
    r = _action(client, cid, action="confirm_fp")
    assert r.json()["status"] == "closed"
    assert r.json()["disposition"] == "false_positive"


# --- back-compat: stored OLD-enum cases load -----------------------------------
def test_legacy_enum_values_load():
    for legacy in ("open", "needs_human", "closed"):
        c = Case(
            case_id=f"c-{legacy}", cluster_signature="sig",
            source_surface=SourceSurface.AUTOMATED_SCAN,
            entity=Entity(type=EntityType.IP, value="1.2.3.4"),
            status=CaseStatus(legacy),
        )
        # New fields default cleanly on an old-shaped doc.
        assert c.disposition is None
        assert c.status_reason == ""
        assert c.escalation_level == 0
        assert c.status_history == []
        assert c.case_number == ""


def test_case_number_generated_when_format_enabled(client, mock_provider):
    # Enable the F7 nomenclature, then create a case and assert it carries a
    # rendered case_number (case_id stays the immutable internal id).
    r = client.put("/api/settings", json={
        "case_id_format": {"enabled": True, "template": "CASE-{seq:06d}", "prefix": "CASE", "seq_start": 1},
    })
    assert r.status_code == 200, r.text
    cid = _create_case(client, mock_provider, "203.0.113.30")
    case = client.get(f"/api/cases/{cid}").json()
    assert case["case_id"].startswith("case-")          # immutable internal id unchanged
    assert case["case_number"].startswith("CASE-")       # rendered display id present
    assert len(case["case_number"]) == len("CASE-000001")


def test_case_number_empty_when_format_disabled(client, mock_provider):
    # Default (disabled) → case_number stays "" and the UI falls back to case_id.
    cid = _create_case(client, mock_provider, "203.0.113.31")
    case = client.get(f"/api/cases/{cid}").json()
    assert case["case_number"] == ""


def test_legacy_case_dict_without_new_fields_validates():
    # Simulate a stored doc predating F8 (no disposition / status_history / case_number).
    raw = {
        "case_id": "c-old", "cluster_signature": "sig",
        "source_surface": "automated_scan",
        "entity": {"type": "ip", "value": "1.2.3.4"},
        "status": "needs_human",
    }
    c = Case.model_validate(raw)
    assert c.status == CaseStatus.NEEDS_HUMAN
    assert c.disposition is None
    assert c.case_number == ""


def test_escalation_wire_fields_are_marked_compatibility_only(client):
    """Generated API docs must not present the retained wire integers as tiers."""
    schemas = client.app.openapi()["components"]["schemas"]

    case_flag = schemas["Case"]["properties"]["escalation_level"]
    assert case_flag["title"] == "Escalated compatibility flag"
    assert case_flag["deprecated"] is True
    assert "numbered tiers" in case_flag["description"]

    for action_schema in ("CaseAction", "BulkCaseAction"):
        legacy_input = schemas[action_schema]["properties"]["level"]
        assert legacy_input["title"] == "Legacy escalation compatibility value"
        assert legacy_input["deprecated"] is True
        assert "single Escalated state" in legacy_input["description"]
