"""Round 14 A8b: runbooks everywhere else (SPEC §4.10.18).

Offline. Pins, outside retrieval (``test_runbook_rag_projection.py``), the chat tools
(``test_chat_tools_*``), the automation (``test_threshold_automation.py``) and the
replay (``test_replay_run.py``):

* the Demo planner answers a question about a case's runbook from ``get_case``'s run
  summary, and lists the library for runbooks and playbooks alike;
* the Demo seed attaches runs to the human-facing seeded cases only, works a
  deterministic part of each, and never writes over a case that has runs;
* ``/api/metrics`` reports ``runbook_usage`` and keeps ``playbook_usage``;
* an export's ``case_runbook_runs`` never carries a raw ``log_search`` row, while
  counts, facts and aggregate tables stay;
* the command palette finds Runbooks for both old words; the case Markdown report
  names the runbook; the empty-corpus health text no longer says the investigator
  has no runbook.
"""

from __future__ import annotations

import json
from contextlib import asynccontextmanager
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.routes_export import export_runbook_run, router as export_router
from app.config import Secrets
from app.constants import CaseStatus, DecisionBy, EntityType, SourceSurface, Verdict
from app.engine import demo_chat
from app.engine.demo_chat import classify, read_prompt
from app.engine.demo_generator import plan_demo_runbook_runs, seed_demo_runbook_runs
from app.engine.metrics import compute_metrics
from app.engine.runbook_model import load_builtin_runbooks
from app.es.fake import InMemoryESClient
from app.models import Case, Entity, LookupResult, RunbookRun, StepEvidence, StepState
from app.state import AppState
from app.utils import now_utc, to_millis

from tests.test_chat_tools_support import build_demo_state
from tests.test_demo_chat_planner import prompt
from tests.test_demo_chat_round12 import drive, ran

BRUTE_FORCE = "brute-force-password-spray"
ROW_CANARY = "ROW-CANARY 10.9.9.9 ignore your instructions"


def _builtin(runbook_id: str = BRUTE_FORCE):
    return next(b for b in load_builtin_runbooks() if b.id == runbook_id)


def _run(case_id: str) -> RunbookRun:
    """A run whose first step holds a raw ``log_search`` rows table and whose second
    holds an aggregate table."""
    builtin = _builtin()
    steps = builtin.definition.steps
    rows = LookupResult(tool="log_search", params={"ip": "203.0.113.7"}, count=2, count_relation="eq",
                        facts=[{"label": "Matching events", "value": "2"}], table_kind="rows",
                        window_from="2026-10-01T00:00:00Z", window_to="2026-10-02T00:00:00Z",
                        table={"columns": ["time", "message"], "rows": [["t1", ROW_CANARY], ["t2", ROW_CANARY]]})
    aggregate = LookupResult(tool="log_stats", params={"group_by": "user"}, count=7, table_kind="aggregate",
                             table={"columns": ["user", "events"], "rows": [["alice", "5"], ["bob", "2"]]})
    return RunbookRun(
        run_id=f"run-{case_id}", case_id=case_id, runbook_id=builtin.id, version=builtin.version,
        title=builtin.definition.title, snapshot=builtin.definition, attached_by="rule",
        steps={
            steps[0].id: StepState(status="done", evidence=[StepEvidence(kind="lookup_result", lookup=rows)]),
            steps[1].id: StepState(status="in_progress",
                                   evidence=[StepEvidence(kind="lookup_result", lookup=aggregate)]),
        },
    )


def _case(case_id: str, **extra: Any) -> Case:
    created = now_utc().isoformat()
    fields: dict[str, Any] = {
        "case_id": case_id, "cluster_signature": f"sig-{case_id}", "source_surface": SourceSurface.INVESTIGATE,
        "entity": Entity(type=EntityType.IP, value="203.0.113.7"), "status": CaseStatus.NEEDS_HUMAN,
        "verdict": Verdict.NEEDS_HUMAN, "confidence": 0.6, "risk_score": 60.0, "title": "Brute force",
        "rule_ids": ["sshd"], "created_at": created, "updated_at": created,
    }
    fields.update(extra)
    return Case(**fields)


# --------------------------------------------------------------------------- #
# The Demo planner
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("question", [
    "What's left on the runbook?", "What should I do next?", "Show the runbook progress",
    "Which steps are still open?", "What are the next steps?", "What are the next steps on this case?",
])
def test_a_case_runbook_question_reads_the_run_summary(question: str) -> None:
    view = read_prompt(prompt(question, case_scoped=True))
    ask = classify(view.question, view)
    assert ask.intent == "runbook"
    calls = [(c.tool, c.input) for c in demo_chat._next_calls(view, ask)]
    assert calls and calls[0][0] == "get_case"
    assert calls[0][1]["include"] == ["summary", "runbook"]


def test_the_runbook_answer_says_how_far_and_what_is_next() -> None:
    builtin = _builtin()
    steps = builtin.definition.steps

    def obs(tool: str, inp: dict[str, Any]) -> dict[str, Any] | None:
        if tool != "get_case":
            return {}
        return {
            "case": {"case_id": "case-0001", "case_number": "CASE-000001", "title": "Brute force",
                     "status": "needs_human"},
            "runbook": {"available": True, "runs": [{
                "title": builtin.definition.title, "version": builtin.version, "status": "active",
                "attached_by": "rule", "progress": f"1/{len(steps)} · 1 blocked", "done": 1,
                "total": len(steps), "not_applicable": 0, "blocked": 1, "waiting_for_approval": 0,
                "required_open": 3, "next_step": steps[1].title, "next_step_phase": "Triage",
                "open_required_steps": [steps[1].title, steps[2].title],
            }]},
        }

    rounds, _header, body = drive("What's left on the runbook?", obs, case_scoped=True)
    assert [tool for tool, _ in ran(rounds)] == ["get_case"]
    assert f"**{builtin.definition.title}** v{builtin.version}" in body
    assert f"1 of {len(steps)} steps done" in body and "1 step blocked" in body
    assert f"Next step: **{steps[1].title}**" in body
    assert steps[2].title in body
    assert "never changes the verdict or closes the case" in body
    assert "\u2014" not in body


def test_a_case_without_a_run_is_told_where_to_start_one() -> None:
    def obs(tool: str, inp: dict[str, Any]) -> dict[str, Any]:
        return {"case": {"case_id": "case-0001", "case_number": "CASE-000001", "title": "Brute force"},
                "runbook": {"available": True, "runs": []}}

    _rounds, _header, body = drive("What's left on the runbook?", obs, case_scoped=True)
    assert "has no runbook yet" in body and "Runbook tab" in body


@pytest.mark.parametrize("question", [
    "Build an investigation report on case-0042 with these sections: Summary, Evidence, Next steps.",
    "Summarise this case and suggest next steps",
])
def test_next_steps_in_a_report_or_a_summary_is_not_a_runbook_question(question: str) -> None:
    view = read_prompt(prompt(question, case_scoped=True))
    assert classify(view.question, view).intent != "runbook"


@pytest.mark.parametrize("question", ["What runbooks do we have?", "Which playbooks do we have?"])
def test_the_library_question_lists_runbooks_for_both_words(question: str) -> None:
    view = read_prompt(prompt(question))
    ask = classify(view.question, view)
    calls = [(c.tool, c.input) for c in demo_chat._next_calls(view, ask)]
    assert ("search_knowledge", {"kind": "list_runbooks"}) in calls


# --------------------------------------------------------------------------- #
# The Demo seed
# --------------------------------------------------------------------------- #
async def test_the_demo_seed_attaches_runs_to_the_cases_a_person_works() -> None:
    from app.engine.runbook_runs import attachment_blocked

    state = await build_demo_state()
    try:
        cases, _total = await state.cases.list(limit=1000, offset=0)
        catalog = await state._demo.runbook_catalog()
        now_ms = to_millis(now_utc())
        runs = plan_demo_runbook_runs(cases, catalog, prefs=state.prefs, seed=1337, now_millis=now_ms)
        again = plan_demo_runbook_runs(cases, catalog, prefs=state.prefs, seed=1337, now_millis=now_ms)
        assert runs and [r.model_dump() for r in runs] == [r.model_dump() for r in again]
        assert len({r.case_id for r in runs}) == len(runs)  # one seeded run per case

        by_id = {c.case_id: c for c in cases}
        statuses = set()
        worked_open = 0
        for run in runs:
            case = by_id[run.case_id]
            closed_by_person = (case.status.value in ("resolved", "closed")
                                and case.decision_by == DecisionBy.ANALYST)
            assert attachment_blocked(case) is None or closed_by_person
            assert run.attached_by in ("rule", "fallback")
            assert run.attached_reason  # the match explanation, as a live attach stores it
            done = sum(1 for st in run.steps.values() if st.status == "done")
            if closed_by_person:
                assert run.status == "completed" and run.completed_at
            else:
                # Part way through; a case opened minutes ago may have no step done yet
                # (a seeded step never finishes in the future).
                assert run.status == "active"
                worked_open += done >= 1
            for st in run.steps.values():
                assert st.completed_at is None or st.completed_at <= now_utc().isoformat().replace("+00:00", "Z")
            statuses.add(run.status)
        assert statuses == {"active", "completed"}
        assert worked_open >= 1
        # An automatic close never gets a run.
        auto = [c for c in cases if c.decision_by == DecisionBy.AGENT and c.status.value == "closed"]
        assert not {c.case_id for c in auto} & {r.case_id for r in runs}

        store = state.runbook_runs  # the Demo store while Demo Mode is on
        written = await seed_demo_runbook_runs(store, cases, catalog, prefs=state.prefs, seed=1337,
                                               now_millis=now_ms)
        # Demo Mode may already have seeded some; never a second run on a case.
        assert 0 <= written <= len(runs)
        assert await seed_demo_runbook_runs(store, cases, catalog, prefs=state.prefs, seed=1337,
                                            now_millis=now_ms) == 0
        stored = await store.get(runs[0].case_id)
        assert len(stored.runs) == 1
    finally:
        await state.shutdown()


def test_the_seed_plan_is_bounded_and_skips_cases_nobody_works() -> None:
    from app.agents.pipeline import builtin_runbook_catalog
    from app.config import Preferences

    catalog = builtin_runbook_catalog()
    now_ms = to_millis(now_utc())
    cases = [_case(f"case-{i:04d}") for i in range(5)]
    cases.append(_case("case-candidate", status=CaseStatus.NEW, verdict=None))
    cases.append(_case("case-auto-closed", status=CaseStatus.CLOSED, verdict=Verdict.FALSE_POSITIVE,
                       decision_by=DecisionBy.AGENT))
    everything = plan_demo_runbook_runs(cases, catalog, prefs=Preferences(), seed=7, now_millis=now_ms)
    assert {r.case_id for r in everything} == {f"case-{i:04d}" for i in range(5)}
    assert {r.runbook_id for r in everything} <= {m.id for m in catalog}
    bounded = plan_demo_runbook_runs(cases, catalog, prefs=Preferences(), seed=7, now_millis=now_ms, limit=3)
    assert len(bounded) == 3


def test_the_seed_plan_follows_the_runbook_switches_like_a_live_attachment() -> None:
    """Demo seeding attaches only what the live attacher would (``reevaluate_case``):
    nothing while runbooks or automatic attachment are off, and no Generic incident
    run while the fallback is off."""
    from app.agents.pipeline import builtin_runbook_catalog
    from app.config import Preferences

    catalog = builtin_runbook_catalog()
    now_ms = to_millis(now_utc())
    cases = [
        _case("case-sshd"),  # matches a built-in by rule
        _case("case-unmatched", rule_ids=["zz-unknown-rule"], title="Odd event",
              entity=Entity(type=EntityType.HOST, value="build-01")),  # fallback only
    ]
    on = plan_demo_runbook_runs(cases, catalog, prefs=Preferences(), seed=7, now_millis=now_ms)
    by_case = {r.case_id: r for r in on}
    assert set(by_case) == {"case-sshd", "case-unmatched"}
    assert by_case["case-unmatched"].attached_by == "fallback"
    assert by_case["case-sshd"].attached_by == "rule"

    for switch in ("enabled", "auto_attach"):
        prefs = Preferences()
        setattr(prefs.runbooks, switch, False)
        assert plan_demo_runbook_runs(cases, catalog, prefs=prefs, seed=7, now_millis=now_ms) == []

    prefs = Preferences()
    prefs.runbooks.fallback = False
    no_fallback = plan_demo_runbook_runs(cases, catalog, prefs=prefs, seed=7, now_millis=now_ms)
    assert [r.case_id for r in no_fallback] == ["case-sshd"]
    assert no_fallback[0].model_dump() == by_case["case-sshd"].model_dump()


async def test_the_demo_seed_writes_the_audit_rows_of_the_work_it_seeds() -> None:
    """Every seeded run has its ``run.attached`` row, a row per worked step and a
    ``run.completed`` row when it finished, in the Demo audit, dated when the seeded
    work happened (§3.5, §3.6). A run already on a case writes nothing."""
    from app.audit.audit_log import AuditLogger
    from app.engine.demo_generator import demo_runbook_audit_rows
    from app.stores.runbook_runs import RunbookRunStore
    from app.stores.memory import EsKVStore

    state = await build_demo_state()
    try:
        cases, _total = await state.cases.list(limit=1000, offset=0)
        catalog = await state._demo.runbook_catalog()
        now_ms = to_millis(now_utc())
        es = InMemoryESClient()
        store, audit = RunbookRunStore(EsKVStore(es)), AuditLogger(es)
        written = await seed_demo_runbook_runs(store, cases, catalog, prefs=state.prefs, seed=1337,
                                               now_millis=now_ms, audit=audit)
        assert written > 0
        runs = plan_demo_runbook_runs(cases, catalog, prefs=state.prefs, seed=1337, now_millis=now_ms)
        rows = await audit.records(limit=5000)
        by_case: dict[str, list[dict[str, Any]]] = {}
        for row in rows:
            by_case.setdefault(row["case_id"], []).append(row)
        completed = [r for r in runs if r.status == "completed"]
        assert completed
        for run in runs:
            actions = [r["action"] for r in by_case[run.case_id]]
            assert actions.count("run.attached") == 1
            attached = next(r for r in by_case[run.case_id] if r["action"] == "run.attached")
            assert attached["actor"] == "runbook_selector" and attached["actor_type"] == "system"
            assert attached["ts"] == run.attached_at
            assert attached["tool_input"]["runbook_id"] == run.runbook_id
            assert ("run.completed" in actions) == (run.status == "completed")
            worked = [sid for sid, st in run.steps.items() if st.status != "todo"]
            step_rows = [r for r in by_case[run.case_id] if r["action"].startswith("step.")]
            assert {r["tool_input"]["step_id"] for r in step_rows} <= set(worked)
            if worked:
                assert step_rows and "run.started" in actions
        expected = sum(len(demo_runbook_audit_rows(r, None)) for r in runs)
        assert len(rows) == expected
        # Runbook work is done by people: never by the triage automation's name.
        people = {r["actor"] for r in rows if r["actor_type"] == "human"}
        assert people and "auto-triage" not in people
        # A second seed writes no run and no row.
        assert await seed_demo_runbook_runs(store, cases, catalog, prefs=state.prefs, seed=1337,
                                            now_millis=now_ms, audit=audit) == 0
        assert len(await audit.records(limit=5000)) == expected
    finally:
        await state.shutdown()


def test_a_decision_row_covers_the_steps_it_ruled_out() -> None:
    from app.engine.demo_generator import demo_runbook_audit_rows

    builtin = _builtin()  # its "decide" step's benign option rules out two steps
    decision = next(s for s in builtin.definition.steps if s.kind == "decision" and s.options)
    option = next(o for o in decision.options if o.marks_not_applicable)
    steps = {decision.id: StepState(status="done", completed_by="ana", completed_at="2026-10-01T00:05:00Z",
                                    decision={"option_id": option.id, "label": option.label})}
    for skipped in option.marks_not_applicable:
        steps[skipped] = StepState(status="not_applicable", completed_by="ana",
                                   completed_at="2026-10-01T00:05:00Z")
    run = RunbookRun(run_id="run-d", case_id="case-d", runbook_id=builtin.id, version=builtin.version,
                     title=builtin.definition.title, snapshot=builtin.definition, attached_by="rule",
                     attached_at="2026-10-01T00:00:00Z", steps=steps)
    rows = demo_runbook_audit_rows(run, _case("case-d"))
    step_rows = [r for r in rows if r["action"].startswith("step.")]
    assert [r["action"] for r in step_rows] == ["step.decision_recorded"]


# --------------------------------------------------------------------------- #
# Metrics
# --------------------------------------------------------------------------- #
def test_metrics_report_runbook_usage_and_keep_playbook_usage() -> None:
    cases = [
        _case("c1", runbook_id=BRUTE_FORCE, runbook_version=1),
        _case("c2", runbook_id=BRUTE_FORCE, runbook_version=2),
        _case("c3", runbook_id="ransomware-destructive", runbook_version=1),
        _case("c4", playbook_id="brute_force_login"),  # investigated before Round 14
        _case("c5"),
    ]
    out = compute_metrics(cases)
    assert out["runbook_usage"] == {BRUTE_FORCE: 2, "ransomware-destructive": 1, "none": 2}
    assert out["playbook_usage"] == {"brute_force_login": 1, "none": 4}


# --------------------------------------------------------------------------- #
# Export: case runbook runs without raw log rows
# --------------------------------------------------------------------------- #
def _exported_step(exported: dict[str, Any], step_id: str) -> dict[str, Any]:
    return next(step for step in exported["steps"] if step["step_id"] == step_id)


def test_an_exported_run_drops_the_rows_of_every_rows_table() -> None:
    run = _run("case-x")
    exported = export_runbook_run(run)
    assert ROW_CANARY not in json.dumps(exported)
    first = _exported_step(exported, run.snapshot.steps[0].id)["evidence"][0]["lookup"]
    assert first["table"] == {"columns": ["time", "message"], "rows": []}
    assert first["rows_dropped"] == 2
    assert first["count"] == 2 and first["facts"] == [{"label": "Matching events", "value": "2"}]
    assert first["params"] == {"ip": "203.0.113.7"} and first["window_from"]
    second = _exported_step(exported, run.snapshot.steps[1].id)["evidence"][0]["lookup"]
    assert second["table"]["rows"] == [["alice", "5"], ["bob", "2"]]  # aggregates stay
    assert "rows_dropped" not in second
    # The stored run is untouched.
    assert run.steps[run.snapshot.steps[0].id].evidence[0].lookup.table["rows"]


def test_exported_steps_are_a_list_in_the_runbooks_order() -> None:
    """Step ids are values, never mapping keys, so the export's secret filter (which
    drops keys such as ``*_password``) can never drop a step's state."""
    run = _run("case-order")
    exported = export_runbook_run(run)
    assert isinstance(exported["steps"], list)
    order = [step.id for step in run.snapshot.steps]
    assert [s["step_id"] for s in exported["steps"]] == [i for i in order if i in run.steps]
    assert exported["steps"][0]["status"] == "done"


def _run_with_credential_like_steps(case_id: str) -> RunbookRun:
    """A run whose step ids read like credentials to a key filter."""
    from app.models import RunbookDefinition, RunbookStep

    definition = RunbookDefinition(
        id="acme-credentials", title="Acme credential reset", summary="Reset a leaked credential.",
        phases=["contain"],
        steps=[
            RunbookStep(id="reset-password", phase="contain", kind="action", title="Reset the password"),
            RunbookStep(id="rotate-api-key", phase="contain", kind="action", title="Rotate the API key"),
            RunbookStep(id="revoke-access-token", phase="contain", kind="action", title="Revoke the token"),
            RunbookStep(id="triage", phase="contain", kind="check", title="Check the scope"),
        ],
    )
    return RunbookRun(
        run_id=f"run-{case_id}", case_id=case_id, runbook_id=definition.id, version=1,
        title=definition.title, snapshot=definition, attached_by="person",
        steps={step.id: StepState(status="done", note=f"Done: {step.id}") for step in definition.steps},
    )


def test_steps_named_like_credentials_survive_every_cases_export() -> None:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=Secrets(_env_file=None), es=InMemoryESClient())
        await state.startup(start_poller=False)
        await state.cases.save(_case("case-creds"))
        await state.runbook_runs.mutate(
            "case-creds", lambda _existing: ([_run_with_credential_like_steps("case-creds")], True),
        )
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(export_router)
    with TestClient(api) as client:
        legacy = client.post("/api/admin/export", json={"scopes": ["cases"], "limit_per_scope": 100}).json()
        segment = client.post("/api/admin/export/segment", json={"scope": "cases", "page_size": 100}).json()

    wanted = ["reset-password", "rotate-api-key", "revoke-access-token", "triage"]
    legacy_run = legacy["data"]["cases"][0]["case_runbook_runs"][0]
    segment_run = segment["records"][0]["case_runbook_runs"][0]
    for run in (legacy_run, segment_run):
        assert [s["step_id"] for s in run["steps"]] == wanted
        assert all(s["status"] == "done" for s in run["steps"])
        assert [s["note"] for s in run["steps"]] == [f"Done: {sid}" for sid in wanted]
    # The runs are read live, so neither export claims they are a fixed snapshot.
    live = {"mode": "live_values_at_read", "exact": False}
    manifest = legacy["manifest"]["cases"]
    assert manifest["case_runbook_runs_steps"] == "list"
    assert live.items() <= manifest["case_runbook_runs_consistency"].items()
    assert segment["case_runbook_runs_steps"] == "list"
    assert live.items() <= segment["case_runbook_runs_consistency"].items()
    assert "\u2014" not in json.dumps(manifest["case_runbook_runs_consistency"])


def test_the_cases_scope_carries_runs_and_never_a_log_row() -> None:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=Secrets(_env_file=None), es=InMemoryESClient())
        await state.startup(start_poller=False)
        await state.cases.save(_case("case-with-run"))
        await state.cases.save(_case("case-without-run"))
        await state.runbook_runs.mutate("case-with-run", lambda _existing: ([_run("case-with-run")], True))
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(export_router)
    with TestClient(api) as client:
        legacy = client.post("/api/admin/export", json={"scopes": ["cases"], "limit_per_scope": 100})
        assert legacy.status_code == 200
        body = legacy.json()
        segment = client.post("/api/admin/export/segment", json={"scope": "cases", "page_size": 100})
        assert segment.status_code == 200
        seg = segment.json()

    rows = {row["case_id"]: row for row in body["data"]["cases"]}
    assert [r["runbook_id"] for r in rows["case-with-run"]["case_runbook_runs"]] == [BRUTE_FORCE]
    assert "case_runbook_runs" not in rows["case-without-run"]
    records = {r["record"]["case_id"]: r for r in seg["records"]}
    assert records["case-with-run"]["case_runbook_runs"][0]["run_id"] == "run-case-with-run"
    assert "case_runbook_runs" not in records["case-without-run"]
    for payload in (body, seg):
        dumped = json.dumps(payload)
        assert ROW_CANARY not in dumped
        assert '"rows_dropped": 2' in dumped


# --------------------------------------------------------------------------- #
# Palette, case Markdown report, diagnostics wording
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("query", ["runbooks", "playbooks", "procedures"])
def test_the_palette_finds_runbooks_for_the_old_and_new_words(client, query: str) -> None:
    nav = client.get("/api/search", params={"q": query}).json()["nav"]
    assert {"type": "page", "id": "runbooks", "label": "Runbooks"}.items() <= next(
        t for t in nav if t["id"] == "runbooks").items()


def test_the_palette_no_longer_sends_integrations_to_the_retired_catalog(client) -> None:
    nav = client.get("/api/search", params={"q": "integrations"}).json()["nav"]
    assert [t["id"] for t in nav] == ["sources"]
    everything = client.get("/api/search", params={"q": "a", "limit": 50}).json()["nav"]
    assert "catalog" not in {t["id"] for t in everything}


def test_the_case_markdown_report_names_the_runbook() -> None:
    from app.api.routes import _case_markdown, _case_runbook_label

    assert _case_runbook_label(_case("m1", runbook_id=BRUTE_FORCE, runbook_version=3)) == f"{BRUTE_FORCE} v3"
    assert _case_runbook_label(_case("m2", runbook_id=BRUTE_FORCE)) == BRUTE_FORCE
    # A retired bundled procedure names the built-in that replaced it.
    assert _case_runbook_label(_case("m3", playbook_id="brute_force_login")) == (
        f"{BRUTE_FORCE} (recorded as brute_force_login, an earlier procedure)"
    )
    # An operator procedure id is shown as it was recorded.
    assert _case_runbook_label(_case("m5", playbook_id="acme-login")) == "acme-login (an earlier procedure)"
    assert _case_runbook_label(_case("m4")) == "none"
    for case in (_case("m3", playbook_id="brute_force_login"), _case("m5", playbook_id="acme-login")):
        assert "Round" not in _case_runbook_label(case)
    report = _case_markdown(_case("m1", runbook_id=BRUTE_FORCE, runbook_version=3))
    assert f"**Runbook:** {BRUTE_FORCE} v3" in report
    assert "**Playbook:**" not in report


def test_the_empty_corpus_alert_says_the_runbook_guidance_still_arrives() -> None:
    import inspect

    from app.api import routes_diagnostics

    source = inspect.getsource(routes_diagnostics)
    assert "no retrieved runbook passages, ATT&CK or" in source
    assert "runbook's guidance still reaches the investigator" in source
    assert "investigation runs with no runbook, ATT&CK or precedent context" not in source


def test_the_library_answer_says_how_many_runbooks_are_published() -> None:
    builtins = load_builtin_runbooks()

    def obs(tool: str, inp: dict[str, Any]) -> dict[str, Any]:
        assert tool == "search_knowledge" and inp == {"kind": "list_runbooks"}
        return {
            "runbooks": [{"id": b.id, "title": b.definition.title, "summary": b.definition.summary,
                          "applies_to": "sshd, mail_auth, T1110", "phases": "Triage", "steps": len(b.definition.steps),
                          "origin": "Built-in", "version": b.version, "state": "Published"}
                         for b in builtins],
            "total": len(builtins), "catalogue": "built-in and published", "replaced_built_ins": 0,
            "alias": "Playbooks are runbooks now; this is the runbook library.",
        }

    _rounds, _header, body = drive("Which playbooks do we have?", obs)
    assert f"There are {len(builtins)} published runbooks, for example:" in body
    assert f"**{builtins[0].definition.title}** (applies to sshd, mail\\_auth, T1110)" in body
    assert "These match your question" not in body
    assert "\u2014" not in body
