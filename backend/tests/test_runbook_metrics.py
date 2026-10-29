"""Runbook metrics (Round 14 SPEC §4.10.12, §4.10.15, §4.10.15a, §4.10.18; package A7b).

``GET /api/runbooks/metrics`` reads the run ledger (written on run-level transitions
only) and the case store. Every figure states its population: runs STARTED in the
window per runbook, phase and step; human-handled cases CREATED in the window (open,
or closed by an analyst) for coverage and the cohorts; rules of the window's cases
that no Published runbook but the fallback matches. The cohorts are a comparison,
never a cause. ``partial`` marks lower bounds. It needs ``runbooks:read`` and
``cases:read``, is hidden under row-level scope, and in Demo Mode reads the Demo
stores.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.constants import CaseStatus, DecisionBy
from app.engine.runbook_model import builtin_runbook
from app.models import RunbookMetrics, RunbookRun
from app.stores.runbook_runs import LedgerMonth, RunbookLedgerRow
from tests.test_runbook_library_api import (
    BASE_BUILTIN,
    add_user,
    auth_secrets,
    kv_snapshot,
    login,
    make_app,
    make_case,
    seed_cases,
)

BRUTE = BASE_BUILTIN


def _ago(**delta: float) -> str:
    return (datetime.now(UTC) - timedelta(**delta)).isoformat()


def _row(run_id: str, case_id: str, runbook_id: str, *, started: str, status: str = "active",
         completed: str | None = None, durations: dict[str, int] | None = None,
         skipped: list[str] | None = None, attached_by: str = "rule") -> RunbookLedgerRow:
    return RunbookLedgerRow(
        run_id=run_id, case_id=case_id, runbook_id=runbook_id, version=1, attached_by=attached_by,
        started_at=started, completed_at=completed, status=status, total=11, required_total=10,
        skipped_step_ids=skipped or [], step_durations=durations or {},
    )


def _run(run_id: str, case_id: str, runbook_id: str, actor: str) -> RunbookRun:
    item = builtin_runbook(runbook_id)
    return RunbookRun(run_id=run_id, case_id=case_id, runbook_id=runbook_id, version=item.version,
                      title=item.title, snapshot=item.definition, attached_by="person",
                      attached_at=_ago(hours=2), attached_actor=actor)


def _seed(client: TestClient, state: Any) -> None:
    seed_cases(client, state, [
        # Open and waiting for a person: human-handled, with a completed run.
        make_case("h-0001", hours_ago=3, rule_ids=["acme_rule"], status=CaseStatus.NEEDS_HUMAN),
        # Closed by an analyst after 60 minutes, no run: the "without" cohort.
        make_case("h-0002", hours_ago=3, rule_ids=["sshd"], status=CaseStatus.CLOSED,
                  decision_by=DecisionBy.ANALYST, updated_at=_ago(hours=2)),
        # Closed by an analyst after 30 minutes, with a completed run.
        make_case("h-0003", hours_ago=5, rule_ids=["acme_rule"], status=CaseStatus.CLOSED,
                  decision_by=DecisionBy.ANALYST, updated_at=_ago(hours=4, minutes=30)),
        # Auto-closed by the agent: not human-handled; its rule still counts as seen.
        make_case("a-0001", hours_ago=1, rule_ids=["zzz_rule"], status=CaseStatus.CLOSED,
                  decision_by=DecisionBy.AGENT),
        # Older than the window.
        make_case("o-0001", hours_ago=24 * 45, rule_ids=["old_rule"], status=CaseStatus.OPEN),
    ])

    async def ledger() -> None:
        runs = state.runbook_runs
        await runs.upsert_ledger_row(_row("run-1", "h-0001", BRUTE, started=_ago(hours=2), status="completed",
                                          completed=_ago(hours=1), skipped=["block-source"],
                                          durations={"source-scope": 600, "accounts-tried": 1200}))
        await runs.upsert_ledger_row(_row("run-2", "h-0003", BRUTE, started=_ago(hours=4, minutes=50),
                                          status="completed", completed=_ago(hours=4, minutes=20),
                                          skipped=["block-source"], durations={"source-scope": 300}))
        await runs.upsert_ledger_row(_row("run-3", "a-0001", "generic-incident", started=_ago(minutes=30),
                                          status="abandoned", attached_by="fallback"))
        # Started before the window: counted for coverage only through its case.
        await runs.upsert_ledger_row(_row("run-0", "o-0001", BRUTE, started=_ago(days=40)))
        await runs.mutate("h-0001", lambda current: ([*current, _run("run-1", "h-0001", BRUTE, "asha")], None))

    client.portal.call(ledger)


@pytest.fixture
def box() -> Any:
    holder: dict[str, Any] = {}
    with TestClient(make_app(holder)) as client:
        holder["client"] = client
        _seed(client, holder["state"])
        yield holder


def _metrics(client: TestClient, **params: Any) -> dict[str, Any]:
    response = client.get("/api/runbooks/metrics", params=params)
    assert response.status_code == 200, response.text
    RunbookMetrics.model_validate(response.json())
    return response.json()


def test_runs_per_runbook_and_their_median_time_to_complete(box) -> None:
    body = _metrics(box["client"])
    assert body["window_label"] == "Last 30 days" and body["partial"] is False
    rows = {r["id"]: r for r in body["per_runbook"]}
    assert set(rows) == {BRUTE, "generic-incident"}
    brute = rows[BRUTE]
    assert (brute["started"], brute["completed"], brute["abandoned"]) == (2, 2, 0)
    assert brute["median_minutes_to_complete"] == pytest.approx(45.0, abs=0.2)
    assert brute["title"] == "Brute force and password spray"
    generic = rows["generic-incident"]
    assert (generic["started"], generic["completed"], generic["abandoned"]) == (1, 0, 1)
    assert generic["median_minutes_to_complete"] is None
    assert [r["id"] for r in body["per_runbook"]][0] == BRUTE  # most started first


def test_steps_and_phases(box) -> None:
    body = _metrics(box["client"])
    steps = {(r["runbook_id"], r["step_id"]): r for r in body["per_step"]}
    assert body["per_step"][0]["step_id"] == "block-source"  # the most skipped first
    assert steps[(BRUTE, "block-source")]["skipped"] == 2
    assert steps[(BRUTE, "source-scope")]["median_minutes"] == pytest.approx(7.5)
    assert steps[(BRUTE, "accounts-tried")]["median_minutes"] == pytest.approx(20.0)
    assert steps[(BRUTE, "source-scope")]["title"] == "Is the source internal or external?"
    phases = {(r["runbook_id"], r["phase"]): r["median_minutes"] for r in body["per_phase"]}
    assert phases == {(BRUTE, "triage"): pytest.approx(17.5)}


def test_coverage_counts_human_handled_cases_and_their_runs(box) -> None:
    body = _metrics(box["client"])
    assert body["coverage"] == {"cases_with_run": 2, "human_handled_cases": 3}


def test_rules_with_no_runbook_ignore_the_fallback(box) -> None:
    body = _metrics(box["client"])
    assert body["rules_without_runbook"] == [{"rule": "acme_rule", "cases": 2}, {"rule": "zzz_rule", "cases": 1}]


def test_the_cohorts_are_a_comparison_with_their_sizes(box) -> None:
    cohorts = _metrics(box["client"])["cohorts"]
    assert cohorts["note"] == "comparison, not cause"
    assert cohorts["with_completed_run"]["cases"] == 1
    assert cohorts["with_completed_run"]["mttr_p50_minutes"] == pytest.approx(30.0, abs=0.5)
    assert cohorts["without"]["cases"] == 1
    assert cohorts["without"]["mttr_p50_minutes"] == pytest.approx(60.0, abs=0.5)


def test_recent_runs_name_the_case_and_who_attached_it(box) -> None:
    recent = _metrics(box["client"])["recent_runs"]
    assert [r["run_id"] for r in recent] == ["run-3", "run-1", "run-2"]
    first = {r["run_id"]: r for r in recent}
    assert first["run-1"]["case_number"] == "CASE-000001" and first["run-1"]["attached_actor"] == "asha"
    assert first["run-1"]["duration_minutes"] == pytest.approx(60.0, abs=0.2)
    assert first["run-3"]["status"] == "abandoned" and first["run-3"]["duration_minutes"] is None


def test_the_window_parameter_and_a_bad_window(box) -> None:
    narrow = _metrics(box["client"], window="now-90m")
    assert [r["id"] for r in narrow["per_runbook"]] == ["generic-incident"]
    assert narrow["coverage"]["human_handled_cases"] == 0
    wide = _metrics(box["client"], window="now-60d")
    assert {r["id"]: r["started"] for r in wide["per_runbook"]}[BRUTE] == 3
    bad = box["client"].get("/api/runbooks/metrics", params={"window": "whenever"})
    assert bad.status_code == 400 and bad.json()["detail"]["code"] == "runbook_window_invalid"


def test_a_capped_ledger_month_makes_the_figures_partial(box, monkeypatch) -> None:
    store = box["state"].runbook_runs
    original = store.read_ledger

    async def capped(months: Any) -> list[LedgerMonth]:
        out = await original(months)
        return [LedgerMonth(month=m.month, rows=m.rows, evicted=1) for m in out]

    monkeypatch.setattr(store, "read_ledger", capped)
    assert _metrics(box["client"])["partial"] is True


def test_only_a_capped_month_that_can_hold_the_windows_runs_makes_it_partial(box, monkeypatch) -> None:
    from app.stores.runbook_runs import month_of, retained_months, shift_month

    store = box["state"].runbook_runs
    original = store.read_ledger
    capped_months: set[str] = set()

    async def capped(months: Any) -> list[LedgerMonth]:
        out = await original(months)
        return [LedgerMonth(month=m.month, rows=m.rows, evicted=1 if m.month in capped_months else 0) for m in out]

    monkeypatch.setattr(store, "read_ledger", capped)
    this_month = month_of(None)
    # A month before the window holds none of its runs: the figures stay exact.
    capped_months.add(min(retained_months()))
    assert _metrics(box["client"], window="now-24h")["partial"] is False
    # A capped month inside the window is a lower bound.
    capped_months.add(this_month)
    assert _metrics(box["client"], window="now-24h")["partial"] is True
    # So is a capped month after a past window: a case of the window may have had
    # its run attached then, and coverage counts it.
    capped_months.clear()
    capped_months.add(this_month)
    last_month = shift_month(this_month, -1)
    assert _metrics(box["client"], window=f"{last_month}-01..{last_month}-02")["partial"] is True


def _spy_months(monkeypatch: Any, store: Any) -> list[str]:
    """Every ledger month ``store`` is asked for, in call order."""
    asked: list[str] = []
    original = store.read_ledger

    async def spy(months: Any) -> list[LedgerMonth]:
        wanted = list(months)
        asked.extend(wanted)
        return await original(wanted)

    monkeypatch.setattr(store, "read_ledger", spy)
    return asked


def test_the_metrics_read_only_the_months_the_window_can_hold(box, monkeypatch) -> None:
    from app.stores.runbook_runs import month_of, retained_months

    asked = _spy_months(monkeypatch, box["state"].runbook_runs)
    now = datetime.now(UTC)
    body = _metrics(box["client"], window="now-7d")
    # A run of the window started in it, and a later run on one of its cases started
    # after it: the months from the window's first to now hold every one of them.
    assert set(asked) == {month_of((now - timedelta(days=7)).isoformat()), month_of(now.isoformat())}
    assert len(asked) == len(set(asked))
    # The figures are the same as from a read of every month.
    assert {r["id"]: r["started"] for r in body["per_runbook"]} == {BRUTE: 2, "generic-incident": 1}
    assert body["coverage"] == {"cases_with_run": 2, "human_handled_cases": 3}
    asked.clear()
    _metrics(box["client"], window="all")
    assert sorted(asked) == sorted(retained_months())


def test_a_runbook_detail_reads_the_ledger_once(box, monkeypatch) -> None:
    from app.stores.runbook_runs import retained_months

    asked = _spy_months(monkeypatch, box["state"].runbook_runs)
    detail = box["client"].get(f"/api/runbooks/{BRUTE}").json()
    # Runs of the last 30 days and the open runs per version come from one read of
    # every retained month (an open run may have started in any of them).
    assert sorted(asked) == sorted(retained_months())
    assert detail["summary"]["runs_30d"] == 2 and detail["open_runs_by_version"] == {"1": 1}


def test_one_damaged_runbook_never_hides_the_other_figures(box) -> None:
    """The definition only names steps and phases, so a runbook whose stored document
    cannot be decoded keeps its counts (its steps are shown by id) and every other
    runbook's figures are unchanged."""
    from app.constants import RUNBOOK_LIBRARY_NS
    from app.stores.runbook_library import DOC_FIELD, REV_FIELD, doc_key
    from tests.test_runbook_library_api import create, publish

    client, state = box["client"], box["state"]
    create(client, "team-damaged")
    publish(client, "team-damaged")

    async def damage() -> None:
        await state.runbook_runs.upsert_ledger_row(_row(
            "run-d", "h-0002", "team-damaged", started=_ago(hours=1, minutes=30), status="completed",
            completed=_ago(hours=1), durations={"source-scope": 120}))
        kv = state.runbook_library.kv
        raw = await kv.get_strict(RUNBOOK_LIBRARY_NS, doc_key("team-damaged"))
        broken = {**raw, DOC_FIELD: "{not json", REV_FIELD: int(raw[REV_FIELD]) + 1}
        assert await kv.put_if_strict(RUNBOOK_LIBRARY_NS, doc_key("team-damaged"), broken, int(raw[REV_FIELD]))

    client.portal.call(damage)
    assert client.get("/api/runbooks/team-damaged").status_code == 503
    body = _metrics(client)
    rows = {r["id"]: r for r in body["per_runbook"]}
    assert (rows["team-damaged"]["started"], rows["team-damaged"]["completed"]) == (1, 1)
    assert rows[BRUTE]["started"] == 2 and rows["generic-incident"]["started"] == 1
    steps = {(r["runbook_id"], r["step_id"]): r for r in body["per_step"]}
    assert steps[("team-damaged", "source-scope")]["title"] == "source-scope"
    assert steps[(BRUTE, "source-scope")]["title"] != "source-scope"


def test_metrics_change_nothing_and_call_no_model(box) -> None:
    before = kv_snapshot(box["state"])
    _metrics(box["client"])
    assert kv_snapshot(box["state"]) == before
    assert box["mock"].calls == []


def test_the_library_shows_runs_in_the_last_30_days(box) -> None:
    rows = {r["id"]: r for r in box["client"].get("/api/runbooks").json()["runbooks"]}
    assert rows[BRUTE]["runs_30d"] == 2 and rows["generic-incident"]["runs_30d"] == 1
    assert rows["phishing-suspicious-email"]["runs_30d"] == 0
    detail = box["client"].get(f"/api/runbooks/{BRUTE}").json()
    assert detail["summary"]["runs_30d"] == 2
    # The run started 40 days ago is still active, pinned to version 1.
    assert detail["open_runs_by_version"] == {"1": 1}


def test_row_level_scope_hides_the_metrics(box, monkeypatch) -> None:
    import app.engine.chat_starters as starters

    monkeypatch.setattr(starters, "object_scoped", lambda _state, _role: True)
    response = box["client"].get("/api/runbooks/metrics")
    assert response.status_code == 409 and response.json()["detail"]["code"] == "runbook_scope_unsupported"
    rows = box["client"].get("/api/runbooks").json()["runbooks"]
    assert all(r["runs_30d"] is None for r in rows)


def test_metrics_need_cases_read() -> None:
    holder: dict[str, Any] = {}
    rbac = {"denies": {"auditor": {"cases": ["read"]}}}
    with TestClient(make_app(holder, secrets=auth_secrets(), auth=True, rbac=rbac)) as client:
        add_user(client, "auditor", "auditor")
        add_user(client, "tier1", "analyst_tier1")
        login(client, "auditor", "user-pass-12345")
        assert client.get("/api/runbooks/metrics").status_code == 403
        login(client, "tier1", "user-pass-12345")
        assert client.get("/api/runbooks/metrics").status_code == 200


def test_demo_mode_reads_the_demo_runs_and_cases(box) -> None:
    client, state = box["client"], box["state"]
    client.portal.call(lambda: state.enable_demo(mode="seeded", seed=7, history_days=1))
    try:
        body = _metrics(client)
        # The real ledger's runs never show under the Demo badge.
        assert "run-1" not in {r["run_id"] for r in body["recent_runs"]}
        assert body["coverage"]["cases_with_run"] <= body["coverage"]["human_handled_cases"]
    finally:
        client.portal.call(state.disable_demo)
    assert {r["run_id"] for r in _metrics(client)["recent_runs"]} == {"run-1", "run-2", "run-3"}


def test_the_same_figures_on_the_sql_state_store(tmp_path) -> None:
    """The library, the ledger and the case scan read the same on SQLite (the
    PostgreSQL code path) as on the in-memory Elasticsearch store."""
    from tests.test_runbook_library_api import create, make_secrets, publish

    holder: dict[str, Any] = {}
    secrets = make_secrets(state_backend="sqlite", state_db_url=f"sqlite+aiosqlite:///{tmp_path}/state.db")
    with TestClient(make_app(holder, secrets=secrets)) as client:
        _seed(client, holder["state"])
        body = _metrics(client)
        assert body["coverage"] == {"cases_with_run": 2, "human_handled_cases": 3}
        assert body["rules_without_runbook"] == [{"rule": "acme_rule", "cases": 2}, {"rule": "zzz_rule", "cases": 1}]
        assert {r["id"]: r["started"] for r in body["per_runbook"]} == {BRUTE: 2, "generic-incident": 1}
        create(client, "sql-runbook")
        live = publish(client, "sql-runbook")
        assert live["summary"]["state"] == "published"
        assert "sql-runbook" in {r["id"] for r in client.get("/api/runbooks").json()["runbooks"]}
