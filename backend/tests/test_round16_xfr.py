"""Round 16 XFR: the replay experiment's spend row follows ``cost:view``.

The replay experiment writes one ``job`` audit row that names real spend
(``replay experiment job=... spend_usd=0.001234 bound_usd=5.000000 ...``,
``engine/replay/job.py`` ``_audit_spend``). ``GET /api/audit``, the audit record read and
the audit log export (CSV and JSON Lines) withhold those two figures from a viewer
without ``cost:view`` (``spend_usd=hidden``, ``bound_usd=hidden``), by the same narrow
rule as the timeout, decision, runbook AI and budget refusal rows
(``api/cost_text.py``). Every other ``job`` row, tool output and any other row that
happens to hold a ``spend_usd=`` is shown as recorded. The replay job's cancel message
(``replay spend bound $... reached``) is kept in the job's own record and is written to
no audit row; a tripped replay proves it.

Display only: the stored rows never change (#2). No model call is added (#6), and
``decide()`` and ``engine/risk.py`` are untouched. Offline: fake Elasticsearch and SQLite,
mock model.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from app.api.cost_text import withhold_row_cost_text
from app.constants import ActionType, JobStatus, UserRole
from app.engine.audit_export import jsonl_line, withheld_cost
from app.models import AuditDoc

from tests.test_audit_export import (  # noqa: F401 (store_state is a fixture)
    _deny_cost_view,
    _exported_summaries,
    _job,
    _params,
    _run,
    _ts,
    _write_rows,
    store_state,
)

AUDITOR = UserRole.AUDITOR.value

#: The replay experiment's spend row as ``_audit_spend`` writes it.
_REPLAY = (
    "replay experiment job=job-xfr fixtures=2 arms=2 repeats=1 cells_run=4 "
    "spend_usd=0.004213 bound_usd=5.000000 outcome=succeeded"
)
_REPLAY_HIDDEN = (
    "replay experiment job=job-xfr fixtures=2 arms=2 repeats=1 cells_run=4 "
    "spend_usd=hidden bound_usd=hidden outcome=succeeded"
)
#: A job lifecycle row and an evidence row that hold the same words: never rewritten.
_TRANSITION = "job=job-xfr kind=replay_experiment transition=succeeded status=succeeded done=2/2"
_EVIDENCE = "replay experiment job=x spend_usd=7 bound_usd=9 amount=$5000"
_FIGURES = ("0.004213", "5.000000")


# --------------------------------------------------------------------------- #
# The rule itself
# --------------------------------------------------------------------------- #
def test_the_replay_spend_row_withholds_its_two_figures_only() -> None:
    assert withhold_row_cost_text("job", _REPLAY) == _REPLAY_HIDDEN
    assert withhold_row_cost_text(ActionType.JOB, _REPLAY) == _REPLAY_HIDDEN
    # Every other job row, and the same words in any other row, stay as recorded.
    assert withhold_row_cost_text("job", _TRANSITION) == _TRANSITION
    assert withhold_row_cost_text("job", "job=a transition=failed cost=3 $9") == (
        "job=a transition=failed cost=3 $9")
    assert withhold_row_cost_text("tool_call", _EVIDENCE) == _EVIDENCE
    assert withhold_row_cost_text("status", _REPLAY) == _REPLAY
    # A value that is not text is returned as it is.
    assert withhold_row_cost_text("job", None) is None


def test_the_export_line_writers_withhold_the_replay_spend_figures() -> None:
    row = {"ts": _ts(1), "actor": "admin", "action_type": "job", "event_id": "job:x:replay-spend",
           "result_summary": _REPLAY, "tool_output_summary": "spend_usd=0.004213"}
    before = json.dumps(row, sort_keys=True)
    out = withheld_cost(row)
    assert out["result_summary"] == _REPLAY_HIDDEN
    # Tool output and every other field are written as stored; the row never changes.
    assert {k: v for k, v in out.items() if k != "result_summary"} == {
        k: v for k, v in row.items() if k != "result_summary"}
    assert json.dumps(row, sort_keys=True) == before
    assert json.loads(jsonl_line(row, show_cost=False))["result_summary"] == _REPLAY_HIDDEN
    assert json.loads(jsonl_line(row))["result_summary"] == _REPLAY


# --------------------------------------------------------------------------- #
# GET /api/audit and the record read
# --------------------------------------------------------------------------- #
def _audit_client(**kwargs: Any):
    from fastapi import Depends

    from app.api.deps import require_auth
    from app.api.routes_audit import router as audit_router
    from tests.test_spend_gates import _client

    client = _client(**kwargs)
    client.app.include_router(audit_router, dependencies=[Depends(require_auth)])
    return client


@pytest.mark.parametrize("cost_view", [True, False])
def test_the_audit_log_follows_cost_view_for_the_replay_spend_row(cost_view: bool) -> None:
    from tests.test_spend_gates import _sign_in_as

    denies = None if cost_view else {"cost": ["view"]}
    with _audit_client(role=AUDITOR, denies=denies) as client:
        _sign_in_as(client, AUDITOR)
        state = client.app.state.tlsoc
        for text in (_REPLAY, _TRANSITION):
            client.portal.call(state.audit.write, AuditDoc(
                actor="admin", action_type=ActionType.JOB, surface="jobs", result_summary=text))
        page = client.get("/api/audit", params={"action_type": "job", "limit": "50"})
        assert page.status_code == 200, page.text
        records = [r for r in page.json()["records"] if "job-xfr" in (r.get("result_summary") or "")]
        assert len(records) == 2
        listed = sorted(r["result_summary"] for r in records)
        opened = []
        for record in records:
            one = client.get(f"/api/audit/records/{record['record_id']}")
            assert one.status_code == 200, one.text
            opened.append(one.json()["result_summary"])
        for texts in (listed, sorted(opened)):
            assert _TRANSITION in texts
            assert (_REPLAY if cost_view else _REPLAY_HIDDEN) in texts
            if not cost_view:
                assert all(figure not in " ".join(texts) for figure in _FIGURES)


# --------------------------------------------------------------------------- #
# The audit log export (CSV and JSON Lines, Elasticsearch and SQLite)
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("fmt", ["csv", "jsonl"])
@pytest.mark.parametrize("cost_view", [True, False])
async def test_the_export_withholds_the_replay_spend_figures_without_cost_view(
    store_state, monkeypatch, fmt, cost_view  # noqa: F811
):
    rows = [
        {"ts": _ts(1), "actor": "admin", "action_type": "job", "surface": "jobs",
         "result_summary": _REPLAY},
        {"ts": _ts(2), "actor": "admin", "action_type": "job", "surface": "jobs",
         "result_summary": _TRANSITION},
        {"ts": _ts(3), "actor": "investigator", "action_type": "tool_call", "tool_name": "es_query",
         "result_summary": _EVIDENCE, "tool_output_summary": "spend_usd=0.5"},
    ]
    await _write_rows(store_state, rows)
    _deny_cost_view(store_state.job_runner, monkeypatch, {"now": not cost_view})
    final = await _run(store_state, _job(_params(format=fmt), count=len(rows)))
    assert final.status == JobStatus.SUCCEEDED, final.failures
    path = await store_state.job_runner.verify_artifact(final.artifact)
    summaries, outputs = _exported_summaries(path.read_bytes(), fmt)
    assert summaries == [_REPLAY if cost_view else _REPLAY_HIDDEN, _TRANSITION, _EVIDENCE]
    assert outputs == [None, None, "spend_usd=0.5"]


# --------------------------------------------------------------------------- #
# A real tripped replay: its spend row is withheld, its cancel message is in no row
# --------------------------------------------------------------------------- #
def _audit_docs(state) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for index, docs in state.es.docs.items():
        if "audit" not in index:
            continue
        for doc in (docs.values() if isinstance(docs, dict) else docs):
            out.append(doc.get("_source", doc) if isinstance(doc, dict) else doc)
    return out


@pytest.mark.asyncio
async def test_a_tripped_replay_writes_its_spend_only_where_the_rule_withholds_it(
    app_state, tmp_path
) -> None:
    from tests.replay_support import capture, quiet, replay_params, run_replay, seed_corpus

    app_state.secrets.jobs_artifact_dir = str(tmp_path)
    await quiet(app_state)
    await seed_corpus(app_state)
    fixture_id = await capture(app_state, ip="203.0.113.61")
    job = await run_replay(app_state, replay_params(
        [fixture_id], arms=[{"arm_id": "a"}], repeats=1, spend_bound_usd=1e-9))
    assert job.status.value == "cancelled"
    # The cancel message names the bound and the accrual in the job's own record.
    assert any(f.reason.startswith("replay spend bound $") for f in job.failures)

    rows = [d for d in _audit_docs(app_state) if job.job_id in (d.get("result_summary") or "")]
    spend = [d for d in rows if d.get("event_id") == f"job:{job.job_id}:replay-spend"]
    assert len(spend) == 1
    assert "spend_usd=0.000000 bound_usd=0.000000" in spend[0]["result_summary"]
    for doc in rows:
        text = doc.get("result_summary") or ""
        # The cancel message is written to no audit row.
        assert "replay spend bound" not in text
        hidden = withheld_cost(doc)["result_summary"]
        # As GET /api/audit and the export show it to a viewer without cost:view.
        assert "spend_usd=0" not in hidden and "bound_usd=0" not in hidden and "$" not in hidden
    assert "spend_usd=hidden bound_usd=hidden" in withheld_cost(spend[0])["result_summary"]


# --------------------------------------------------------------------------- #
# The records: where the What's new switch is, and the AI run signals said once
# --------------------------------------------------------------------------- #
_REPO = Path(__file__).resolve().parents[2]


def _flat(text: str) -> str:
    return " ".join(text.split())


def _round16_changelog() -> str:
    text = (_REPO / "CHANGELOG.md").read_text(encoding="utf-8")
    start = text.index("### Round 16")
    return text[start:text.index("### Round 15", start)]


def test_the_records_name_where_the_whats_new_switch_really_is() -> None:
    """**Show What's new after updates** sits in Settings, Account, Appearance (the
    generator's intro and the Console say so); no record places it in a bare
    "Settings, Appearance"."""
    usage = _flat((_REPO / "docs" / "USAGE.md").read_text(encoding="utf-8"))
    changelog = _flat(_round16_changelog())
    for text in (usage, changelog):
        assert "Settings, Appearance" not in text
    assert ("**Show What's new after updates** in **Settings → Account → Appearance** "
            "turns it off") in usage
    assert "(on the page, or Settings → Account → Appearance;" in usage
    assert ("**Show What's new after updates**, on the page or in **Settings → Account → "
            "Appearance**, turns it off.") in changelog


def test_the_changelog_says_the_ai_run_signals_once() -> None:
    """The release's AI run signals are one Added entry: the queue row, the header chip,
    the trace and the Inbox wording are said there, not again as a separate entry."""
    changelog = _flat(_round16_changelog())
    assert "AI run signals in Case Manager" not in changelog
    assert changelog.count('"AI working" or "AI queued"') == 1
    assert changelog.count('"N AI steps"') == 1
    assert changelog.count('"Needs human review", as the case does') == 1
    added = changelog[changelog.index("#### Added"):changelog.index("#### Changed")]
    # FXB: on a phone the chip shows the ring with the word "AI", never the ring alone.
    assert "shows the ring alone on a phone" not in changelog
    for fact in ("at every queue width", 'On a phone it shows the ring with the word "AI" and no clock',
                 "the same number as the trace's \"N AI steps\"",
                 "The notices name the needs-human verdict \"Needs human review\""):
        assert fact in added, fact
