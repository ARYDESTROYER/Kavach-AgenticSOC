"""The audit rows the base API router writes say who acted and how it ended.

Round 14 SPEC §4.5.3: ``outcome`` and ``actor_type`` are written by every writer of a
new row, so the audit log's Outcome column, its Failed filter and its People and
settings and Agent activity scopes work for the rows ``app/api/routes.py`` writes.
These tests drive the real routes through the HTTP surface and read the stored rows
back; two of the rows branch on what happened (a Demo incident that was refused, a
bulk rejection that only partly went through). A last test pins every plain
``record`` call in the router to the two fields, so a dropped keyword cannot slip by.

The proposal decision rows (``record_strict`` keyed by ``event_id``) are the one
deliberate exception: a retried decision must reproduce its first row exactly, and a
first row written before Round 14 has neither field.
"""

from __future__ import annotations

import ast
import json
from datetime import timedelta
from pathlib import Path
from typing import Any

from app.audit.query import AuditFilters, build_predicate, matches
from app.constants import ActionType, CaseStatus, EntityType, SourceSurface, Verdict
from app.models import Case, Entity, Proposal
from app.utils import now_utc, to_millis
from tests.conftest import make_log_event

_PEOPLE = build_predicate(AuditFilters(scope="people"))
_AGENT = build_predicate(AuditFilters(scope="agent"))
_FAILED = build_predicate(AuditFilters(outcome="failure"))


def _state(client) -> Any:
    return client.app.state.tlsoc


def _rows(client, logger: Any) -> list[dict[str, Any]]:
    """Every row of one audit store, newest first."""
    return client.portal.call(lambda: logger.records(limit=1000))


def _row(client, logger: Any, summary_start: str) -> dict[str, Any]:
    found = [r for r in _rows(client, logger) if str(r.get("result_summary") or "").startswith(summary_start)]
    assert len(found) == 1, (summary_start, found)
    return found[0]


def _kind(row: dict[str, Any]) -> tuple[str | None, str | None]:
    return row.get("actor_type"), row.get("outcome")


def _save_case(client, case_id: str) -> Case:
    case = Case(
        case_id=case_id, cluster_signature=f"sig:{case_id}",
        source_surface=SourceSurface.INVESTIGATE,
        entity=Entity(type=EntityType.IP, value="203.0.113.7"),
        rule_ids=["linux_auth"], risk_score=60.0,
        verdict=Verdict.NEEDS_HUMAN, confidence=0.4, status=CaseStatus.NEEDS_HUMAN,
    )
    client.portal.call(_state(client).cases.save, case)
    return case


# --------------------------------------------------------------------------- #
# Rows that branch on what happened
# --------------------------------------------------------------------------- #
def test_a_refused_demo_incident_is_a_failure_and_the_demo_switches_are_successes(client) -> None:
    enabled = client.post("/api/demo/enable", json={"mode": "seeded", "seed": 1337, "history_days": 2})
    assert enabled.status_code == 200, enabled.text
    first = client.post("/api/demo/incident", json={})
    assert first.status_code == 200 and first.json()["triggered"] is True, first.text
    # Inside the cooldown nothing is triggered: the row is a failure.
    second = client.post("/api/demo/incident", json={})
    assert second.status_code == 200 and second.json()["triggered"] is False, second.text
    assert client.post("/api/demo/reset").status_code == 200
    assert client.post("/api/demo/disable").status_code == 200

    real = _state(client).real_audit
    incidents = [r for r in _rows(client, real)
                 if str(r.get("result_summary") or "").startswith("demo incident trigger")]
    by_trigger = {r["result_summary"].split()[3]: r for r in incidents}
    assert _kind(by_trigger["triggered=True"]) == ("human", "success")
    assert _kind(by_trigger["triggered=False"]) == ("human", "failure")
    assert matches(_FAILED, by_trigger["triggered=False"])
    assert not matches(_FAILED, by_trigger["triggered=True"])
    for start in ("demo enabled mode=seeded", "demo reset run_id=", "demo disabled run_id="):
        assert _kind(_row(client, real, start)) == ("human", "success"), start
    # A person's Demo switches are People and settings rows.
    assert all(matches(_PEOPLE, r) for r in incidents)


def test_a_bulk_rejection_is_a_success_a_partial_or_a_failure_by_what_was_rejected(client) -> None:
    state = _state(client)
    pending = [Proposal(kind="automation_ack", payload={"n": i}) for i in range(3)]
    for proposal in pending:
        client.portal.call(state.proposals.add, proposal)

    cases = (
        ("every id rejected", [pending[0].id], "success"),
        ("one missing", [pending[1].id, "prop-does-not-exist"], "partial"),
        ("all missing", ["prop-missing-a", "prop-missing-b"], "failure"),
    )
    for reason, ids, _outcome in cases:
        response = client.post("/api/proposals/bulk-reject", json={"ids": ids, "reason": reason})
        assert response.status_code == 200, response.text

    for reason, _ids, outcome in cases:
        row = next(
            r for r in _rows(client, state.audit)
            if str(r.get("result_summary") or "").startswith("bulk reject requested=")
            and str(r["result_summary"]).endswith(f"reason={reason}")
        )
        assert _kind(row) == ("human", outcome), reason
        assert matches(_PEOPLE, row)
        assert matches(_FAILED, row) is (outcome == "failure")


# --------------------------------------------------------------------------- #
# A person's case work
# --------------------------------------------------------------------------- #
def test_a_persons_case_work_rows_are_human_successes_in_people_and_settings(client) -> None:
    state = _state(client)
    case_id = _save_case(client, "case-route-rows").case_id
    calls = (
        ("comment", {"author": "alice", "body": "Looked at the source host."}, "comment added"),
        ("tags", {"tags": ["triaged"], "analyst": "alice"}, "tags set ("),
        ("assign", {"assignee": "bob", "analyst": "alice"}, "assigned to bob"),
        ("feedback", {"analyst": "alice", "assessment": "agree", "accuracy": 0.9}, "assessment=agree"),
        ("action", {"action": "acknowledge", "analyst": "alice"}, "action=acknowledge"),
    )
    for path, body, _start in calls:
        response = client.post(f"/api/cases/{case_id}/{path}", json=body)
        assert response.status_code == 200, (path, response.text)
    rows = [r for r in _rows(client, state.audit) if r.get("case_id") == case_id]
    for path, _body, start in calls:
        row = next((r for r in rows if str(r.get("result_summary") or "").startswith(start)), None)
        assert row is not None, (path, [r.get("result_summary") for r in rows])
        assert _kind(row) == ("human", "success"), path
        assert matches(_PEOPLE, row), path


def test_a_threat_context_import_and_a_conversation_rename_and_delete_are_human_rows(client) -> None:
    state = _state(client)
    imported = client.post("/api/threat-context/import", json={
        "title": "Phishing kit notes", "content": "The kit stages payloads on a lookalike domain.",
    })
    assert imported.status_code == 200, imported.text
    row = _row(client, state.audit, "imported threat_context document")
    assert _kind(row) == ("human", "success")
    assert matches(_PEOPLE, row)

    saved = client.portal.call(lambda: state.chat_conversations.append_exchange(
        None, conversation_id=None, user_content="What changed today?",
        assistant_content="Nothing new.", response={"answer": "Nothing new.", "cost": 0.0},
        model="mock-chat", source_id="primary",
    ))
    assert saved is not None
    renamed = client.patch(f"/api/chat/conversations/{saved.id}", json={"title": "Daily check"})
    assert renamed.status_code == 200, renamed.text
    deleted = client.delete(f"/api/chat/conversations/{saved.id}")
    assert deleted.status_code == 200, deleted.text
    for start in ("conversation renamed", "conversation deleted"):
        row = _row(client, state.audit, start)
        assert _kind(row) == ("human", "success"), start
        assert matches(_PEOPLE, row), start


def test_the_proposal_expiry_sweep_is_a_system_success(client) -> None:
    state = _state(client)
    stale = Proposal(kind="automation_ack", payload={},
                     expires_at=(now_utc() - timedelta(days=1)).isoformat())
    client.portal.call(state.proposals.add, stale)
    assert client.get("/api/proposals").status_code == 200
    row = _row(client, state.audit, "expired 1 pending proposals past expires_at")
    assert _kind(row) == ("system", "success")


# --------------------------------------------------------------------------- #
# The agent's own rows
# --------------------------------------------------------------------------- #
def _verdict(verdict: str, confidence: float) -> str:
    return json.dumps({
        "action": "final", "reasoning": "scripted",
        "verdict": {
            "verdict": verdict, "confidence": confidence,
            "evidence": [{"summary": "scripted evidence", "event_ids": []}],
            "mitre": ["T1110"], "recommended_action": "block the source",
            "reproduce_query": 'source.ip : "x"',
        },
    })


def _route(mock_provider) -> None:
    mock_provider.push("router", json.dumps({"bucket": "needs_strong_model", "confidence": 0.9, "reason": "serious"}))


def test_a_manual_reinvestigation_row_is_an_agent_success_in_agent_activity(client, mock_provider) -> None:
    state = _state(client)
    ip = "192.0.2.77"
    now = to_millis(now_utc())
    for hours in (1, 2):
        state.es.add_log("all-logs-2026.06.16", make_log_event(ip=ip, ts_millis=now - hours * 3_600_000))
    _route(mock_provider)
    mock_provider.push("investigator", _verdict("NEEDS_HUMAN", 0.2))
    created = client.post("/api/investigate", json={"entity": {"type": "ip", "value": ip},
                                                     "source_surface": "investigate"})
    assert created.status_code == 200, created.text
    case_id = created.json()["case_id"]

    _route(mock_provider)
    mock_provider.push("investigator", _verdict("TRUE_POSITIVE", 0.9))
    rerun = client.post(f"/api/cases/{case_id}/reinvestigate", json={"analyst": "alice"})
    assert rerun.status_code == 200, rerun.text
    row = next(r for r in _rows(client, state.audit)
               if r.get("case_id") == case_id and r.get("actor") == "reinvestigate")
    assert row["action_type"] == ActionType.DECISION.value
    # The pipeline's own actor token: the row stays in Agent activity, as before.
    assert _kind(row) == ("agent", "success")
    assert matches(_AGENT, row) and not matches(_PEOPLE, row)


# --------------------------------------------------------------------------- #
# Every plain row the router writes carries both fields
# --------------------------------------------------------------------------- #
def test_every_plain_audit_row_in_the_router_names_its_actor_type_and_outcome() -> None:
    """A plain ``record`` call (or an un-keyed ``record_strict``) in ``routes.py``
    passes ``actor_type`` and ``outcome``. A ``record_strict`` keyed by ``event_id``
    is exempt: its retry reproduces its first row byte for byte (see the module)."""
    source = Path(__file__).resolve().parents[1] / "app" / "api" / "routes.py"
    tree = ast.parse(source.read_text(encoding="utf-8"))
    missing: list[str] = []
    checked = 0
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)):
            continue
        if node.func.attr not in ("record", "record_strict"):
            continue
        target = ast.unparse(node.func.value)
        if "audit" not in target:
            continue
        names = {kw.arg for kw in node.keywords if kw.arg}
        if node.func.attr == "record_strict" and "event_id" in names:
            continue
        checked += 1
        absent = sorted({"actor_type", "outcome"} - names)
        if absent:
            missing.append(f"routes.py:{node.lineno} {target}.{node.func.attr} lacks {', '.join(absent)}")
    assert checked >= 18, checked
    assert missing == [], "\n".join(missing)
