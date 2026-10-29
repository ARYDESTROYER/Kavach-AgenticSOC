"""``POST /api/cases/{case_id}/run-playbook`` is retired (Round 14 SPEC §4.10.16).

A manual procedure run used to force retired procedure text into a re-investigation.
It now answers ``410 runbooks_moved`` for one release, changes nothing and calls no
model; a person starts a runbook on the case with ``POST
/api/cases/{case_id}/runbooks`` instead. Runbook selection stays deterministic and
never feeds ``decide()`` (#3).
"""

from __future__ import annotations

import inspect

import pytest

from app.api import routes as routes_mod
from app.constants import CaseStatus, EntityType, SourceSurface
from app.engine import runbook_runs as R
from app.engine.runbook_match import match
from app.models import Case, Entity, LookupResult

MOVED = {"code": "runbooks_moved", "detail": "Playbooks are now runbooks.", "see": "/api/runbooks"}


@pytest.fixture(autouse=True)
def _no_lookups(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_execute(state, case, template, *, ran_by, now=None, events=None, load_events=True):
        return LookupResult(tool=template.tool, status="empty", count=0, ran_at="2026-10-28T10:00:00Z",
                            ran_by=ran_by)

    monkeypatch.setattr(R, "execute_lookup", fake_execute)


def _case(case_id: str = "case-run") -> Case:
    return Case(case_id=case_id, cluster_signature=case_id, source_surface=SourceSurface.INVESTIGATE,
                rule_ids=["mail_auth"], entity=Entity(type=EntityType.IP, value="198.51.100.9"),
                status=CaseStatus.NEEDS_HUMAN)


def test_run_playbook_answers_410_and_changes_nothing(client, mock_provider) -> None:
    state = client.app.state.tlsoc
    case = _case()
    client.portal.call(state.cases.save, case)
    before = client.portal.call(state.cases.get, case.case_id).model_dump(mode="json")
    r = client.post(f"/api/cases/{case.case_id}/run-playbook", json={"playbook_id": "brute_force_login"})
    assert r.status_code == 410
    assert r.json() == MOVED
    assert r.headers["Deprecation"] == "true"
    # No body, an unknown case and an unknown procedure all answer the same way.
    assert client.post("/api/cases/nope/run-playbook").status_code == 410
    after = client.portal.call(state.cases.get, case.case_id).model_dump(mode="json")
    assert after == before
    assert mock_provider.calls == []
    assert (client.portal.call(state.runbook_runs.get, case.case_id)).runs == ()


def test_run_playbook_is_gated_on_runbooks_run() -> None:
    dependency = inspect.signature(routes_mod.case_run_playbook).parameters["_"].default.dependency
    names = dependency.__code__.co_freevars
    values = dict(zip(names, (cell.cell_contents for cell in dependency.__closure__)))
    assert (values["resource"], values["action"]) == ("runbooks", "run")


def test_runbook_selection_is_deterministic() -> None:
    from app.engine.runbook_model import load_builtin_runbooks
    from app.engine.runbook_match import MatchableRunbook, matchable_catalog

    builtins = [MatchableRunbook(id=b.id, version=b.version, definition=b.definition, origin="builtin")
                for b in load_builtin_runbooks()]
    entries = matchable_catalog(builtins, [], replaced_builtin_ids=set())
    facts = R.case_facts(_case(), None)
    first = match(facts, entries, fallback=True)
    for _ in range(5):
        again = match(facts, entries, fallback=True)
        assert again.winner.id == first.winner.id == "brute-force-password-spray"
        assert again.explanation == first.explanation
