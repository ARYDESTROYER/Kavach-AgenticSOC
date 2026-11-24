"""Round 15 WP3: Team activity (SPEC D3.1 to D3.12, §3.6).

Offline: fake Elasticsearch, SQLite, mock model.

* the pure fold over hand-built audit rows: new and legacy shapes, mixed-case actors,
  environment, Demo, deleted and Not attributed people, bulk counts, the runbook step
  rule, reviews (N of M, a rate only from 30), sign-ins, failed and agent rows left out;
* windows: whole calendar days in the operator zone, at most 92 days;
* the median time to acknowledge by the metrics MTTA rule, attributed to whoever made
  the first human acknowledgement, and omitted past the case bound;
* the ``search_page`` ``count`` option on the three audit stores and the honesty flags
  (an offset-paged Elasticsearch read at its limit, the bounded third-party scan);
* the routes: the ``team:view`` gate, the role floor while role-based access is off, the
  operator switch, sign-in off, the 60 second cache, the view rows, a person's events
  (every spelling, newest first, signed cursor, structured detail only), Demo Mode;
* the Demo seed's audit rows and the static guards.
"""

from __future__ import annotations

import ast
import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.api import routes_team
from app.api.deps import require_auth
from app.api.routes import router as monolith_router
from app.api.routes_team import router as team_router
from app.audit.audit_log import AuditLogger
from app.audit.query import TRUE, In, all_of
from app.config import Secrets
from app.constants import (
    AUDIT_WRITE_ALIAS,
    CaseStatus,
    DecisionBy,
    Disposition,
    EntityType,
    SourceSurface,
    Verdict,
)
from app.engine import team_activity as ta
from app.es.fake import InMemoryESClient
from app.es.indices import bootstrap_indices
from app.llm.providers import MockProvider
from app.middleware.request_id import RequestIdMiddleware
from app.models import Case, Entity, StatusHistoryEntry
from app.state import AppState
from app.stores.base import AuditRepository
from app.stores.sql.engine import build_async_engine, create_all
from app.stores.sql.repositories import SqlAuditRepository
from tests.conftest import mount_moved_routers

BACKEND = Path(__file__).resolve().parents[1]
APP = BACKEND / "app"
NOW = datetime(2026, 11, 20, 15, 0, tzinfo=timezone.utc)
_JWT_SECRET = "round15-wp3-team-activity-secret"


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


def _lifecycle(actor: str, verb: str, frm: str, to: str, disposition: str = "none", *,
               ts: datetime, case_id: str = "case-1", number: str = "CASE-0001",
               structured: bool = True, run_id: str | None = None, reason: str = "",
               changes: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    row: dict[str, Any] = {
        "ts": _iso(ts), "action_type": "status", "surface": "case", "actor": actor,
        "actor_type": "human", "outcome": "success", "case_id": case_id,
        "result_summary": f"action={verb} status {frm}\u2192{to} disposition={disposition}"
                          + (f" reason={reason}" if reason else ""),
    }
    if structured:
        from app.constants import CASE_LIFECYCLE_AUDIT_ACTIONS

        row["action"] = CASE_LIFECYCLE_AUDIT_ACTIONS[verb]
        row["target"] = {"type": "case", "id": case_id, "label": number}
        row["changes"] = changes if changes is not None else (
            [{"field": "status", "before": frm, "after": to}] if frm != to else []
        )
    if run_id:
        row["run_id"] = run_id
    return row


def _window(token: str = "today", tz: str = "UTC") -> Any:
    return ta.resolve_team_window(token, tz=tz, now=NOW)


def _fold(rows: list[dict[str, Any]], token: str = "today") -> ta.TeamActivityFold:
    fold = ta.TeamActivityFold(_window(token))
    for row in rows:
        fold.add_row(row)
    return fold


def _person(result: dict[str, Any], key: str) -> dict[str, Any]:
    return next(p for p in result["people"] if p["key"] == key)


# --------------------------------------------------------------------------- #
# The fold: what each row counts as
# --------------------------------------------------------------------------- #
def test_lifecycle_rows_count_by_verb_and_status_in_both_shapes() -> None:
    t = NOW - timedelta(hours=1)
    rows = [
        _lifecycle("alice", "acknowledge", "open", "investigating", ts=t),
        _lifecycle("alice", "close", "investigating", "closed", "false_positive", ts=t,
                   changes=[{"field": "status", "before": "investigating", "after": "closed"},
                            {"field": "disposition", "before": None, "after": "false_positive"}]),
        # Legacy rows: the verb and status from the summary's fixed leading tokens.
        _lifecycle("alice", "close", "open", "closed", "benign", ts=t, structured=False, case_id="case-2"),
        _lifecycle("alice", "reopen", "closed", "investigating", ts=t, structured=False),
        _lifecycle("alice", "escalate", "investigating", "escalated", ts=t),
        _lifecycle("alice", "confirm_fp", "open", "closed", "false_positive", ts=t, case_id="case-3"),
        _lifecycle("alice", "set_status", "resolved", "closed", "duplicate", ts=t, case_id="case-4"),
        # Not counted: resolve, hold, a disposition change.
        _lifecycle("alice", "resolve", "investigating", "resolved", ts=t),
        _lifecycle("alice", "hold", "investigating", "on_hold", ts=t, structured=False),
        _lifecycle("alice", "set_disposition", "closed", "closed", "benign", ts=t),
    ]
    result = _fold(rows).result([])
    alice = _person(result, "alice")
    assert alice["counts"]["acknowledged"] == 1
    assert alice["counts"]["closed"] == 4
    assert alice["counts"]["reopened"] == 1
    assert alice["counts"]["escalated"] == 1
    assert alice["closed_by"] == {"true_positive": 0, "false_positive": 2, "benign": 1, "duplicate": 1, "other": 0}
    assert alice["kind"] == "deleted"  # seen in rows only


def test_people_are_one_key_whatever_the_case_of_the_actor() -> None:
    t = NOW - timedelta(minutes=30)
    rows = [
        _lifecycle("Admin", "acknowledge", "open", "investigating", ts=t),
        _lifecycle("admin", "acknowledge", "open", "investigating", ts=t, case_id="c2"),
        _lifecycle(" ADMIN ", "acknowledge", "open", "investigating", ts=t, case_id="c3"),
    ]
    fold = _fold(rows)
    assert fold.people_keys() == {"admin"}
    assert set(fold.spellings("admin")) == {"Admin", "admin", " ADMIN "}
    assert _person(fold.result([]), "admin")["counts"]["acknowledged"] == 3


def test_unattributed_actors_are_grouped_and_listed_last() -> None:
    t = NOW - timedelta(minutes=30)
    rows = [
        _lifecycle(name, "acknowledge", "open", "investigating", ts=t, case_id=f"c-{i}")
        for i, name in enumerate(("analyst", "default", "", "Analyst", "zed"))
    ]
    result = _fold(rows).result([])
    assert [p["key"] for p in result["people"]] == ["zed", ""]
    unattributed = result["people"][-1]
    assert unattributed["kind"] == "unattributed" and unattributed["display_name"] == "Not attributed"
    assert unattributed["counts"]["acknowledged"] == 4
    # Not attributed is not a person: it is not counted as active.
    assert result["team"]["people_active"] == 1
    assert result["team"]["counts"]["acknowledged"] == 5


def test_roster_kinds_zeros_and_name_order() -> None:
    class U:
        def __init__(self, username: str, display: str = "", role: str = "analyst_tier1", active: bool = True):
            self.username, self.display_name, self.role, self.active = username, display, role, active

    roster = ta.build_roster(
        [U("bob", "Bob Brown"), U("carol", role="soc_manager"), U("gone", active=False)],
        environment=[("Admin", "super_admin"), ("bob", "analyst_tier1")],
        demo=["asha.iyer"],
    )
    kinds = {e.key: e.kind for e in roster}
    assert kinds == {"bob": "account", "carol": "account", "gone": "account", "admin": "environment",
                     "asha.iyer": "demo"}
    t = NOW - timedelta(minutes=5)
    result = _fold([_lifecycle("carol", "acknowledge", "open", "investigating", ts=t)]).result(roster)
    names = [p["username"] for p in result["people"]]
    # Ordered by name (display name first), never by a count; an inactive account with
    # no rows is left out; everyone listed has zeros when they did nothing.
    assert names == ["Admin", "asha.iyer", "bob", "carol"]
    assert _person(result, "bob")["counts"]["acknowledged"] == 0
    assert _person(result, "bob")["display_name"] == "Bob Brown"
    assert _person(result, "admin")["kind"] == "environment"


def test_bulk_rows_are_counted_and_marked() -> None:
    t = NOW - timedelta(minutes=5)
    rows = [
        _lifecycle("bo", "close", "open", "closed", "false_positive", ts=t, case_id=f"c{i}", run_id="bulk-job-1")
        for i in range(3)
    ] + [_lifecycle("bo", "close", "open", "closed", "false_positive", ts=t, case_id="c9", run_id="inv-x")]
    bo = _person(_fold(rows).result([]), "bo")
    assert bo["counts"]["closed"] == 4 and bo["bulk"]["closed"] == 3


def test_only_successful_rows_a_person_made_count() -> None:
    t = NOW - timedelta(minutes=5)
    agent = _lifecycle("investigator", "close", "open", "closed", ts=t)
    agent.pop("actor_type")
    failed = _lifecycle("dee", "close", "open", "closed", ts=t)
    failed["outcome"] = "failure"
    system = _lifecycle("dee", "close", "open", "closed", ts=t)
    system["actor_type"] = "system"
    fold = _fold([agent, failed, system])
    assert fold.people_keys() == set()
    assert fold.scanned == 3


def test_collaboration_thread_screenshot_and_sign_in_rows() -> None:
    t = NOW - timedelta(minutes=5)
    rows = [
        {"ts": _iso(t), "action_type": "collab", "surface": "case", "actor": "eve", "case_id": "c1",
         "result_summary": "comment added"},
        {"ts": _iso(t), "action_type": "collab", "surface": "case", "actor": "eve", "case_id": "c1",
         "result_summary": "assigned to eve"},
        {"ts": _iso(t), "action_type": "collab", "surface": "case", "actor": "eve", "case_id": "c1",
         "result_summary": "tags set (2)"},
        # A new-shape assignment that changed nothing is not counted; one that did is.
        {"ts": _iso(t), "action_type": "collab", "surface": "case", "actor": "eve", "case_id": "c1",
         "action": "case.assigned", "actor_type": "human", "outcome": "success",
         "result_summary": "assigned to eve"},
        {"ts": _iso(t), "action_type": "collab", "surface": "case", "actor": "eve", "case_id": "c2",
         "action": "case.assigned", "actor_type": "human", "outcome": "success",
         "changes": [{"field": "assignee", "before": None, "after": "eve"}], "result_summary": "assigned to eve"},
        {"ts": _iso(t), "action_type": "thread_post", "surface": "case", "actor": "eve", "case_id": "c1",
         "actor_type": "human", "outcome": "success", "result_summary": "thread post (human) mentions=1"},
        {"ts": _iso(t), "action_type": "thread_post", "surface": "case", "actor": "eve", "case_id": "c1",
         "actor_type": "human", "outcome": "success", "result_summary": "thread edit msg=m1"},
        {"ts": _iso(t), "action_type": "thread_post", "surface": "case", "actor": "copilot", "case_id": "c1",
         "actor_type": "agent", "outcome": "success", "result_summary": "thread post (ai)"},
        {"ts": _iso(t), "action_type": "collab", "surface": "case", "actor": "eve", "case_id": "c1",
         "action": "case.file_attached", "actor_type": "human", "outcome": "success",
         "result_summary": "file_attached file_id=f1"},
        {"ts": _iso(t), "action_type": "auth", "surface": "auth", "actor": "Eve", "action": "auth.login",
         "actor_type": "human", "outcome": "success"},
        {"ts": _iso(t), "action_type": "auth", "surface": "auth", "actor": "eve", "action": "auth.login_failed",
         "actor_type": "human", "outcome": "failure"},
    ]
    eve = _person(_fold(rows).result([]), "eve")
    assert eve["counts"]["commented"] == 2
    assert eve["counts"]["assigned"] == 2
    assert eve["counts"]["screenshot_added"] == 1
    assert eve["counts"]["signed_in"] == 1


def _legacy_and_new_rows() -> list[dict[str, Any]]:
    """Rows of every shape the audit log holds for the same kinds of work: before Round
    14 (no actor kind, no outcome, no action), Round 14 (actor kind and outcome) and
    Round 15 (a structured action and changes)."""
    def at(minutes: int) -> str:
        return _iso(NOW - timedelta(minutes=minutes))

    return [
        # Before Round 14.
        {"ts": at(50), "action_type": "status", "surface": "case", "actor": "analyst", "case_id": "a",
         "result_summary": "action=acknowledge status new\u2192investigating disposition=none"},
        {"ts": at(49), "action_type": "status", "surface": "case", "actor": "Bob", "case_id": "a",
         "result_summary": "action=close status investigating\u2192closed disposition=false_positive reason=x"},
        {"ts": at(48), "action_type": "collab", "surface": "case", "actor": "bob", "case_id": "a",
         "result_summary": "comment added"},
        {"ts": at(47), "action_type": "collab", "surface": "case", "actor": "bob", "case_id": "a",
         "result_summary": "assigned to bob"},
        # A message posted with sign-in off names nobody: a person's work, Not attributed.
        {"ts": at(46), "action_type": "thread_post", "surface": "case", "actor": "", "case_id": "a",
         "result_summary": "thread post (human)"},
        # A message labelled as the AI's names its type as the actor: never a person.
        {"ts": at(45), "action_type": "thread_post", "surface": "case", "actor": "ai", "case_id": "a",
         "result_summary": "thread post (ai)"},
        {"ts": at(44), "action_type": "thread_post", "surface": "case", "actor": "bob", "case_id": "a",
         "result_summary": "thread edit msg=1"},
        # An agent row and a settings row with the case surface missing are never read.
        {"ts": at(43), "action_type": "status", "surface": "settings", "actor": "bob",
         "result_summary": "action=close status open\u2192closed disposition=none"},
        # Round 14.
        {"ts": at(40), "action_type": "status", "surface": "case", "actor": "BOB", "actor_type": "human",
         "outcome": "success", "case_id": "b",
         "result_summary": "action=reopen status closed\u2192open disposition=false_positive"},
        {"ts": at(39), "action_type": "thread_post", "surface": "case", "actor": "bob", "actor_type": "human",
         "outcome": "success", "case_id": "b", "result_summary": "thread post (ai)"},
        # Round 15.
        {"ts": at(30), "action_type": "status", "surface": "case", "actor": "bob", "actor_type": "human",
         "outcome": "success", "case_id": "c", "action": "case.closed",
         "changes": [{"field": "status", "before": "open", "after": "closed"},
                     {"field": "disposition", "before": None, "after": "true_positive"}],
         "result_summary": "action=close status open\u2192closed disposition=true_positive"},
        {"ts": at(20), "action_type": "auth", "surface": "auth", "actor": "bob", "actor_type": "human",
         "outcome": "success", "action": "auth.login", "result_summary": "signed in"},
    ]


_EXPECTED_MIXED = {
    "bob": {"closed": 2, "reopened": 1, "commented": 1, "assigned": 1, "signed_in": 1},
    "": {"acknowledged": 1, "commented": 1},
}


def _nonzero(result: dict[str, Any]) -> dict[str, dict[str, int]]:
    return {p["key"]: {k: v for k, v in p["counts"].items() if v} for p in result["people"]}


def test_thread_posts_count_only_as_a_person_s_message() -> None:
    """A thread message counts as a comment only when the server recorded it as a
    person's (``thread post (human)``): an older row that names "ai" as its actor is not
    a person called ai, and a post labelled as the AI's is not a person's comment. A
    message posted with sign-in off before Round 14 names nobody and is Not attributed."""
    result = _fold(_legacy_and_new_rows()).result([])
    assert _nonzero(result) == _EXPECTED_MIXED
    assert "ai" not in {p["key"] for p in result["people"]}
    assert result["people"][-1]["kind"] == "unattributed"


def test_the_fold_reads_the_same_rows_on_every_audit_store() -> None:
    """The read predicate selects, and the fold counts, the same rows of every shape on
    Elasticsearch, SQL and a third-party store's bounded scan."""
    rows = _legacy_and_new_rows()
    window = _window("today")

    async def through(repo: Any) -> dict[str, dict[str, int]]:
        fold = ta.TeamActivityFold(window)
        _read, reason = await routes_team._stream(  # noqa: SLF001
            repo, ta.counted_predicate(window), fold.add_row, 1000,
        )
        assert reason is None
        return _nonzero(fold.result([]))

    class Third(AuditRepository):
        async def write(self, doc: Any) -> None:  # pragma: no cover
            pass

        async def record(self, **kw: Any) -> None:  # pragma: no cover
            pass

        async def records_for_case(self, case_id: str, limit: int = 500) -> list[dict[str, Any]]:
            return []

        async def records(self, *, limit: int = 100, **kw: Any) -> list[dict[str, Any]]:
            return list(reversed(rows))[:limit]

    async def run() -> None:
        assert await through(await _es_repo(rows)) == _EXPECTED_MIXED
        sql, engine = await _sql_repo(rows)
        try:
            assert await through(sql) == _EXPECTED_MIXED
        finally:
            await engine.dispose()
        assert await through(Third()) == _EXPECTED_MIXED

    asyncio.run(run())


def test_runbook_steps_count_each_step_marked_done() -> None:
    t = NOW - timedelta(minutes=5)
    rows = [
        {"ts": _iso(t), "action_type": "runbook", "surface": "runbook", "actor": "fay", "action": action,
         "actor_type": "human", "outcome": "success", "case_id": "c1", "changes": changes}
        for action, changes in (
            ("step.updated", [{"field": "steps.s1.status", "before": "todo", "after": "done"}]),
            ("step.decision_recorded", [{"field": "steps.s2.status", "before": "todo", "after": "done"},
                                        {"field": "steps.s3.status", "before": "todo", "after": "not_applicable"}]),
            ("step.action_recorded", [{"field": "steps.s4.status", "before": "in_progress", "after": "done"},
                                      {"field": "steps.s5.status", "before": "todo", "after": "done"}]),
            ("step.approved", [{"field": "steps.s6.status", "before": "awaiting_approval", "after": "done"}]),
            # Not completions: a note, a reopened step, another action.
            ("step.updated", [{"field": "steps.s1.note", "before": None, "after": "done"}]),
            ("step.updated", [{"field": "steps.s1.status", "before": "done", "after": "todo"}]),
            ("step.evidence_collected", [{"field": "steps.s7.status", "before": "todo", "after": "done"}]),
        )
    ]
    assert _person(_fold(rows).result([]), "fay")["counts"]["runbook_step_done"] == 5


def test_an_owner_set_by_a_lifecycle_action_counts_as_assigned() -> None:
    """The Escalate dialog's owner field sets the owner in the same action: the
    lifecycle row records it as an ``assignee`` change, and it is an assignment the
    person made, counted beside the escalation (and in bulk when a bulk action wrote
    it). Only a row that changed the owner counts."""
    t = NOW - timedelta(minutes=30)
    owner = {"field": "assignee", "before": "alice", "after": "bob"}
    moved = {"field": "status", "before": "investigating", "after": "escalated"}
    rows = [
        _lifecycle("tam", "escalate", "investigating", "escalated", ts=t, case_id="e1", changes=[moved, owner]),
        _lifecycle("tam", "escalate", "investigating", "escalated", ts=t, case_id="e2", changes=[moved],
                   run_id="bulk-0000000000000001"),
        _lifecycle("tam", "escalate", "investigating", "escalated", ts=t, case_id="e3", changes=[moved, owner],
                   run_id="bulk-0000000000000001"),
        # An owner set while putting a case on hold (through the API) is an assignment too.
        _lifecycle("tam", "hold", "investigating", "on_hold", ts=t, case_id="e4",
                   changes=[{"field": "status", "before": "investigating", "after": "on_hold"},
                            {"field": "assignee", "before": None, "after": "bob"}]),
    ]
    assert [e.kind for e in ta.events_of_row(rows[0])] == ["escalated", "assigned"]
    tam = _person(_fold(rows).result([]), "tam")
    assert tam["counts"]["escalated"] == 3 and tam["counts"]["assigned"] == 3
    assert tam["bulk"]["escalated"] == 2 and tam["bulk"]["assigned"] == 1
    assert sorted(e["kind"] for e in ta.person_events(rows, _window(), "tam")) == [
        "assigned", "assigned", "assigned", "escalated", "escalated", "escalated",
    ]
    # The rows are read: every lifecycle action is in the case-work read.
    assert {"case.escalated", "case.held", "case.resumed", "case.deescalated"} <= set(ta.WORK_ACTIONS)


def _review(actor: str, agrees: Any, *, ts: datetime, case_id: str, elapsed: int | None = 60_000,
            via_changes: bool = False) -> dict[str, Any]:
    row: dict[str, Any] = {
        "ts": _iso(ts), "action_type": "feedback", "surface": "case", "actor": actor,
        "action": "case.review_recorded", "actor_type": "human", "outcome": "success", "case_id": case_id,
        "result_summary": "review_recorded review_id=acr-1 sampled=true",
    }
    if via_changes:
        row["changes"] = [{"field": "review.agrees", "before": None, "after": str(agrees).lower()},
                          {"field": "review.elapsed_ms", "before": None, "after": str(elapsed)}]
    else:
        row["tool_input"] = {"agrees": agrees, "elapsed_ms": elapsed}
    return row


def test_reviews_say_n_of_m_and_a_rate_only_from_thirty() -> None:
    t = NOW - timedelta(minutes=20)
    rows = [_review("gus", True, ts=t, case_id="c1"), _review("gus", False, ts=t, case_id="c2"),
            _review("gus", None, ts=t, case_id="c3"),
            _review("gus", True, ts=t, case_id="c4", via_changes=True, elapsed=30_000)]
    reviews = _person(_fold(rows).result([]), "gus")["reviews"]
    assert (reviews["completed"], reviews["agreed"], reviews["disagreed"], reviews["unsure"]) == (4, 2, 1, 1)
    assert reviews["answered"] == 3 and reviews["agreement_rate"] is None
    assert reviews["time_spent_median_ms"] == 60_000
    many = [_review("hal", i % 3 != 0, ts=t, case_id=f"c{i}") for i in range(30)]
    rated = _person(_fold(many).result([]), "hal")["reviews"]
    assert rated["answered"] == 30 and rated["agreement_rate"] == pytest.approx(20 / 30, abs=1e-4)
    # One short of the bar (D3.8, "only when M is at least 30"): the counts, no rate.
    assert ta.REVIEW_RATE_MIN == 30
    short = _person(_fold(many[:29]).result([]), "hal")["reviews"]
    assert short["answered"] == 29 and short["agreed"] == 19 and short["agreement_rate"] is None


def test_a_person_s_reviews_count_once_per_case() -> None:
    """An agent-closed case that was not sampled may be reviewed again, and each answer
    replaces the person's earlier one. Repeating a review must not add up: 35 reviews of
    one case are one review, so they never reach the 30-review bar for a rate, and the
    latest answer and its time spent are the ones counted. Someone else's review of the
    same case is their own review."""
    start = NOW - timedelta(hours=2)
    rows = [_review("Gus", True, ts=start + timedelta(minutes=i), case_id="c1", elapsed=1_000)
            for i in range(34)]
    rows.append(_review("gus", False, ts=start + timedelta(minutes=40), case_id="c1", elapsed=90_000))
    rows.append(_review("hal", True, ts=start + timedelta(minutes=41), case_id="c1"))
    for order in (rows, list(reversed(rows))):  # any read order
        fold = _fold(order)
        result = fold.result([])
        gus = _person(result, "gus")
        assert gus["counts"]["reviewed"] == 1
        assert gus["reviews"] == {
            "completed": 1, "agreed": 0, "disagreed": 1, "unsure": 0, "answered": 1,
            "agreement_rate": None, "time_spent_median_ms": 90_000.0, "time_to_review_median_seconds": None,
        }
        assert sum(day["counts"]["reviewed"] for day in gus["daily"]) == 1
        assert _person(result, "hal")["counts"]["reviewed"] == 1
        assert result["team"]["counts"]["reviewed"] == 2
        assert result["team"]["reviews"]["completed"] == 2 and result["team"]["reviews"]["agreement_rate"] is None
        assert sum(day["counts"]["reviewed"] for day in result["team"]["daily"]) == 2
        assert fold.reviewed_case_ids() == ["c1"]
        # Both spellings of the name still reach the person's events.
        assert set(fold.spellings("gus")) == {"Gus", "gus"}
    # The person's events list every review and say which ones were replaced.
    events = ta.person_events(rows, _window(), "gus")
    assert len(events) == 35 and all(e["kind"] == "reviewed" for e in events)
    assert events[0]["detail"] == "Disagreed with the AI"
    assert all(e["detail"] == "Agreed with the AI · Replaced by a later review of this case" for e in events[1:])
    # Reviews of distinct cases each count, up to the rate.
    many = [_review("ivy", True, ts=start, case_id=f"d{i}") for i in range(30)]
    many += [_review("ivy", True, ts=start + timedelta(minutes=1), case_id=f"d{i}") for i in range(30)]
    rated = _person(_fold(many).result([]), "ivy")["reviews"]
    assert rated["completed"] == 30 and rated["agreement_rate"] == 1.0


def test_an_applied_audit_first_review_and_a_repeat_count_once() -> None:
    """The one-per-case rule also covers reviews held for their failure-row pairing."""
    t = NOW - timedelta(minutes=30)
    rows = [_attempt(_REVIEWED, "Ola", ts=t, request_id="req-000000e1"),
            _attempt(_REVIEWED, "Ola", ts=t + timedelta(minutes=5), request_id="req-000000e2"),
            _attempt(_REVIEW_FAILED, "Ola", ts=t + timedelta(minutes=5, milliseconds=20), request_id="req-000000e2"),
            _review("Ola", False, ts=t + timedelta(minutes=9), case_id="c1")]
    ola = _person(_fold(rows).result([]), "ola")
    assert ola["counts"]["reviewed"] == 1 and ola["reviews"]["disagreed"] == 1
    assert [e["detail"] for e in ta.person_events(rows, _window(), "ola")] == [
        "Disagreed with the AI", "Agreed with the AI · Replaced by a later review of this case",
    ]


def test_time_to_review_is_sampled_to_completed() -> None:
    window = _window("today")
    fold = ta.TeamActivityFold(window)
    reviewed_at = NOW - timedelta(hours=1)
    fold.add_row(_review("ivy", True, ts=reviewed_at, case_id="c1"))
    fold.add_review_requests([
        {"ts": _iso(reviewed_at - timedelta(minutes=90)), "action": "case.review_requested", "case_id": "c1"},
        {"ts": _iso(reviewed_at - timedelta(days=3)), "action": "case.review_requested", "case_id": "c1"},
        {"ts": _iso(reviewed_at + timedelta(minutes=5)), "action": "case.review_requested", "case_id": "c1"},
    ])
    reviews = _person(fold.result([]), "ivy")["reviews"]
    assert reviews["time_to_review_median_seconds"] == 90 * 60


# --------------------------------------------------------------------------- #
# Audit-first writers: an action row whose write then failed counts nothing
# --------------------------------------------------------------------------- #
def _attempt(action: str, actor: str, *, ts: datetime, request_id: str | None, case_id: str = "c1",
             session: str | None = None, outcome: str | None = None) -> dict[str, Any]:
    """A screenshot or review row as the audit-first writers append it: the action row
    (``outcome`` success), or its failure row (``..._failed``, outcome failure) with the
    same request id."""
    failed = action.endswith("_failed")
    row: dict[str, Any] = {
        "ts": _iso(ts), "action_type": "feedback" if "review" in action else "collab", "surface": "case",
        "actor": actor, "action": action, "actor_type": "human",
        "outcome": outcome or ("failure" if failed else "success"), "case_id": case_id,
        "target": {"type": "case", "id": case_id, "label": "CASE-0007"},
        "result_summary": f"{action.split('.', 1)[1]} code=x",
    }
    if "review" in action:
        row["tool_input"] = {"agrees": True, "elapsed_ms": 30_000}
    if request_id is not None:
        row["request_id"] = request_id
    if session is not None:
        row["session_ref"] = session
    return row


_ATTACH, _ATTACH_FAILED = "case.file_attached", "case.file_attach_failed"
_REVIEWED, _REVIEW_FAILED = "case.review_recorded", "case.review_record_failed"


@pytest.mark.parametrize("action,failed,kind", [
    (_ATTACH, _ATTACH_FAILED, "screenshot_added"),
    (_REVIEWED, _REVIEW_FAILED, "reviewed"),
])
def test_an_audit_first_row_followed_by_its_failure_row_is_not_counted(
    action: str, failed: str, kind: str,
) -> None:
    """Uploads and reviews append their row before the store write and, when the write
    fails, a failure row with the same request id (SPEC D5.10, D6.6, D7.6). The pair is
    one attempt that was not applied, as the Audit log's inspector reads it, so neither
    the counts, the reviews nor the person's events show it."""
    t = NOW - timedelta(minutes=10)
    pair = [_attempt(action, "Ola", ts=t, request_id="req-00000001"),
            _attempt(failed, "Ola", ts=t + timedelta(milliseconds=40), request_id="req-00000001")]
    for rows in (pair, list(reversed(pair))):  # the fold is order-agnostic
        fold = _fold(rows)
        result = fold.result([])
        assert result["team"]["counts"][kind] == 0
        assert result["team"]["reviews"]["completed"] == result["team"]["reviews"]["agreed"] == 0
        assert fold.people_keys() == set() and fold.reviewed_case_ids() == []
        assert ta.person_events(rows, _window(), "ola") == []
    # The same rows with different request ids, or a lone action row, still count.
    apart = [_attempt(action, "Ola", ts=t, request_id="req-00000001"),
             _attempt(failed, "Ola", ts=t + timedelta(milliseconds=40), request_id="req-00000002")]
    for rows in (apart, pair[:1]):
        ola = _person(_fold(rows).result([]), "ola")
        assert ola["counts"][kind] == 1
        assert [e["kind"] for e in ta.person_events(rows, _window(), "ola")] == [kind]
    if kind == "reviewed":
        assert _person(_fold(pair[:1]).result([]), "ola")["reviews"]["agreed"] == 1


def test_only_the_attempt_its_failure_row_follows_is_not_counted() -> None:
    """The inspector's rule: an action row is not applied when the next row of the same
    request, actor and case (and session, when both name one) is its failure row."""
    t = NOW - timedelta(minutes=10)

    def at(ms: int) -> datetime:
        return t + timedelta(milliseconds=ms)

    def count(rows: list[dict[str, Any]]) -> int:
        return _fold(rows).result([])["team"]["counts"]["screenshot_added"]

    rid = "req-00000009"
    # A retried save inside one request: action, failure, action. The second applied.
    assert count([_attempt(_ATTACH, "pia", ts=at(0), request_id=rid),
                  _attempt(_ATTACH_FAILED, "pia", ts=at(5), request_id=rid),
                  _attempt(_ATTACH, "pia", ts=at(9), request_id=rid)]) == 1
    # A failure row of another person, another case or another named session pairs with
    # nothing here.
    assert count([_attempt(_ATTACH, "pia", ts=at(0), request_id=rid),
                  _attempt(_ATTACH_FAILED, "quin", ts=at(5), request_id=rid)]) == 1
    assert count([_attempt(_ATTACH, "pia", ts=at(0), request_id=rid),
                  _attempt(_ATTACH_FAILED, "pia", ts=at(5), request_id=rid, case_id="c2")]) == 1
    assert count([_attempt(_ATTACH, "pia", ts=at(0), request_id=rid, session="s-1"),
                  _attempt(_ATTACH_FAILED, "pia", ts=at(5), request_id=rid, session="s-2")]) == 1
    assert count([_attempt(_ATTACH, "pia", ts=at(0), request_id=rid, session="s-1"),
                  _attempt(_ATTACH_FAILED, "pia", ts=at(5), request_id=rid)]) == 0
    # A failure row before the action row, or a row with no request id, pairs with nothing.
    assert count([_attempt(_ATTACH_FAILED, "pia", ts=at(0), request_id=rid),
                  _attempt(_ATTACH, "pia", ts=at(5), request_id=rid)]) == 1
    assert count([_attempt(_ATTACH, "pia", ts=at(0), request_id=None),
                  _attempt(_ATTACH_FAILED, "pia", ts=at(5), request_id=None)]) == 1
    # Two rows stored at the same instant: a failure row never comes before its action row.
    assert count([_attempt(_ATTACH_FAILED, "pia", ts=at(0), request_id=rid),
                  _attempt(_ATTACH, "pia", ts=at(0), request_id=rid)]) == 0
    # A write cancelled at shutdown (outcome unknown) is not counted either: the
    # inspector shows its action row as not applied, and the page never counts work it
    # cannot confirm.
    assert count([_attempt(_ATTACH, "pia", ts=at(0), request_id=rid),
                  _attempt(_ATTACH_FAILED, "pia", ts=at(5), request_id=rid, outcome="unknown")]) == 0


_STEP_PAIRS = [
    ("step.updated", "step.update_failed"),
    ("step.decision_recorded", "step.decision_record_failed"),
    ("step.action_recorded", "step.action_record_failed"),
    ("step.approved", "step.approve_failed"),
]


def _step_row(action: str, actor: str, *, ts: datetime, request_id: str, case_id: str = "c1",
              step: str = "s1") -> dict[str, Any]:
    """A runbook step row as ``runbook_runs._audited_runs_write`` appends it: the action
    row with the step's status change, or its failure row (no changes) with the same
    request id, target and session."""
    failed = action.endswith("_failed")
    row: dict[str, Any] = {
        "ts": _iso(ts), "action_type": "runbook", "surface": "runbook", "actor": actor, "action": action,
        "actor_type": "human", "outcome": "failure" if failed else "success", "case_id": case_id,
        "target": {"type": "case", "id": case_id, "label": "CASE-0007"}, "request_id": request_id,
        "session_ref": "s-1",
    }
    if failed:
        row["result_summary"] = "no_change: Another change got there first; nothing was changed."
    else:
        row["changes"] = [{"field": f"steps.{step}.status", "before": "todo", "after": "done"}]
    return row


@pytest.mark.parametrize("action,failed", _STEP_PAIRS)
def test_a_runbook_step_whose_write_failed_is_not_counted(action: str, failed: str) -> None:
    """Runbook step changes are audit-first too: two people marking the same step done
    at once both append their row, and the loser's compare-and-set write fails
    (``_NoLongerApplies``) with its failure row. That step was not completed by them."""
    assert ta.NOT_APPLIED_ACTIONS[failed] == action
    t = NOW - timedelta(minutes=10)

    def at(ms: int) -> datetime:
        return t + timedelta(milliseconds=ms)

    def done(rows: list[dict[str, Any]]) -> int:
        return _fold(rows).result([])["team"]["counts"]["runbook_step_done"]

    pair = [_step_row(action, "Uma", ts=at(0), request_id="req-000000s1"),
            _step_row(failed, "Uma", ts=at(30), request_id="req-000000s1")]
    for rows in (pair, list(reversed(pair))):
        assert done(rows) == 0
        assert ta.person_events(rows, _window(), "uma") == []
    # The winner of the race (another request) still counts; so does a lone row.
    winner = _step_row(action, "Vic", ts=at(1), request_id="req-000000s2")
    assert done([*pair, winner]) == 1
    assert _nonzero(_fold([*pair, winner]).result([])) == {"vic": {"runbook_step_done": 1}}
    assert done(pair[:1]) == 1
    assert [e["kind"] for e in ta.person_events(pair[:1], _window(), "uma")] == ["runbook_step_done"]
    # A retried write inside one request: action, failure, action. The second applied.
    assert done([*pair, _step_row(action, "Uma", ts=at(60), request_id="req-000000s1")]) == 1
    # A failure row of another request or another case cancels nothing.
    assert done([pair[0], _step_row(failed, "Uma", ts=at(30), request_id="req-000000s3")]) == 1
    assert done([pair[0], _step_row(failed, "Uma", ts=at(30), request_id="req-000000s1", case_id="c2")]) == 1


def test_the_step_writer_s_rows_pair_through_the_audit_store() -> None:
    """The rows ``audited_write`` itself appends for a runbook step whose store write
    failed (the action row, then ``step.update_failed``) are read back from the audit
    store and count nothing; an applied write of the same kind counts."""
    from app.audit.write import audited_write
    from app.constants import ActionType
    from app.models import AuditChange, AuditTarget

    window = _window("today")
    when = NOW - timedelta(minutes=15)

    async def run() -> dict[str, dict[str, int]]:
        repo = await _es_repo([])

        async def write_step(request_id: str, write: Any) -> None:
            await audited_write(
                None, sink=repo, action="step.updated",
                target=AuditTarget(type="case", id="c-step", label="CASE-0042"), expected_revision=3,
                changes=[AuditChange(field="steps.s1.status", before="todo", after="done")],
                write=write, action_type=ActionType.RUNBOOK, actor="Wes", actor_type="human",
                surface="runbook", context={"request_id": request_id, "session_ref": "0123456789abcdef"}, case_id="c-step",
                result_summary="Runbook step Contain marked done.",
            )

        async def lost() -> None:
            raise RuntimeError("Another change got there first; nothing was changed.")

        async def applied() -> str:
            return "ok"

        with pytest.raises(RuntimeError):
            await write_step("req-0000aa01", lost)
        await write_step("req-0000aa02", applied)
        rows, _pages = await _all(repo)
        assert [r["action"] for r in rows] == ["step.updated", "step.update_failed", "step.updated"]
        # The store stamps the time it appended; date them inside the fixed window.
        fold = ta.TeamActivityFold(window)
        for offset, row in enumerate(rows):
            fold.add_row({**row, "ts": _iso(when + timedelta(milliseconds=offset))})
        return _nonzero(fold.result([]))

    assert asyncio.run(run()) == {"wes": {"runbook_step_done": 1}}


def test_a_failure_row_just_after_the_window_still_pairs_on_every_audit_store() -> None:
    """The failure row follows its action row by milliseconds, so it can land after the
    window's end: the read takes the two writers' rows a little past the end, on
    Elasticsearch, SQL and a third-party store's bounded scan alike."""
    window = _window("yesterday")
    end = window.end
    rows = [
        _attempt(_ATTACH, "ray", ts=end - timedelta(milliseconds=5), request_id="req-0000000a"),
        _attempt(_ATTACH_FAILED, "ray", ts=end + timedelta(milliseconds=30), request_id="req-0000000a"),
        _attempt(_REVIEWED, "ray", ts=end - timedelta(milliseconds=4), request_id="req-0000000b"),
        _attempt(_REVIEW_FAILED, "ray", ts=end + timedelta(seconds=20), request_id="req-0000000b"),
        # Applied, inside the window: counted.
        _attempt(_ATTACH, "ray", ts=end - timedelta(hours=1), request_id="req-0000000c"),
        # Applied, after the window: read for the pairing, never counted.
        _attempt(_ATTACH, "ray", ts=end + timedelta(seconds=1), request_id="req-0000000d"),
    ]

    async def through(repo: Any) -> tuple[dict[str, int], list[str]]:
        fold = ta.TeamActivityFold(window)
        _read, reason = await routes_team._stream(  # noqa: SLF001
            repo, ta.counted_predicate(window), fold.add_row, 1000,
        )
        assert reason is None
        seen: list[dict[str, Any]] = []
        await routes_team._stream(  # noqa: SLF001
            repo, all_of(ta.counted_predicate(window), In("actor", ("ray",))), seen.append, 1000,
        )
        return _nonzero(fold.result([])), [e["kind"] for e in ta.person_events(seen, window, "ray")]

    expected = ({"ray": {"screenshot_added": 1}}, ["screenshot_added"])

    class Third(AuditRepository):
        async def write(self, doc: Any) -> None:  # pragma: no cover
            pass

        async def record(self, **kw: Any) -> None:  # pragma: no cover
            pass

        async def records_for_case(self, case_id: str, limit: int = 500) -> list[dict[str, Any]]:
            return []

        async def records(self, *, limit: int = 100, **kw: Any) -> list[dict[str, Any]]:
            return sorted(rows, key=lambda r: r["ts"], reverse=True)[:limit]

    async def run() -> None:
        assert await through(await _es_repo(rows)) == expected
        sql, engine = await _sql_repo(rows)
        try:
            assert await through(sql) == expected
        finally:
            await engine.dispose()
        assert await through(Third()) == expected

    asyncio.run(run())


def test_days_are_operator_zone_calendar_days_and_zero_filled() -> None:
    window = ta.resolve_team_window("now-7d", tz="Asia/Kolkata", now=NOW)
    days = ta.day_list(window)
    assert len(days) == 7 and days[-1] == "2026-11-20"
    fold = ta.TeamActivityFold(window)
    # 20:00 UTC on the 19th is 01:30 on the 20th in Kolkata.
    fold.add_row(_lifecycle("jo", "acknowledge", "open", "investigating",
                            ts=datetime(2026, 11, 19, 20, 0, tzinfo=timezone.utc)))
    result = fold.result([])
    jo = _person(result, "jo")
    assert jo["daily"] == [{"date": "2026-11-20", "counts": {**{k: 0 for k in ta.ALL_KINDS}, "acknowledged": 1}}]
    assert [d["date"] for d in result["team"]["daily"]] == days
    assert result["team"]["daily"][-1]["counts"]["acknowledged"] == 1
    assert result["timezone"] == "Asia/Kolkata"


def test_rows_outside_the_window_are_not_counted() -> None:
    fold = _fold([
        _lifecycle("kim", "acknowledge", "open", "investigating", ts=NOW - timedelta(days=1)),
        _lifecycle("kim", "acknowledge", "open", "investigating", ts=NOW + timedelta(hours=1)),
    ])
    assert fold.people_keys() == set()


@pytest.mark.parametrize("token,code", [
    ("all", "team_window_too_long"),
    ("now-93d", "team_window_too_long"),
    ("2026-01-01..2026-06-01", "team_window_too_long"),
    ("nonsense", "team_invalid_window"),
    ("x" * 80, "team_invalid_window"),
])
def test_windows_the_page_refuses(token: str, code: str) -> None:
    with pytest.raises(ta.TeamWindowError) as raised:
        ta.resolve_team_window(token, tz="UTC", now=NOW)
    assert raised.value.code == code


def test_windows_the_page_reads_are_whole_days() -> None:
    assert ta.day_list(_window("today")) == ["2026-11-20"]
    assert ta.day_list(_window("yesterday")) == ["2026-11-19"]
    thirty = _window("now-30d")
    assert len(ta.day_list(thirty)) == 30 and thirty.start == datetime(2026, 10, 22, tzinfo=timezone.utc)
    assert len(ta.day_list(_window("now-92d"))) == 92
    assert ta.day_list(_window("2026-11-01..2026-11-03")) == ["2026-11-01", "2026-11-02", "2026-11-03"]
    assert ta.day_list(ta.resolve_team_window("", tz="UTC", now=NOW)) == ["2026-11-20"]


def test_event_detail_comes_from_structured_fields_only() -> None:
    t = NOW - timedelta(minutes=5)
    row = _lifecycle(
        "lee", "close", "investigating", "closed", "true_positive", ts=t, reason="SENTINEL-REASON",
        changes=[{"field": "status", "before": "investigating", "after": "closed"},
                 {"field": "disposition", "before": None, "after": "true_positive"},
                 {"field": "actions_taken", "before": None, "after": '["isolated_host", "bogus"]'}],
        run_id="bulk-7",
    )
    row["client"] = {"ip": "203.0.113.9", "user_agent": "SENTINEL-UA"}
    row["session_ref"] = "abcdef0123456789"
    legacy = _lifecycle("lee", "close", "open", "closed", "benign", ts=t - timedelta(minutes=1),
                        structured=False, reason="SENTINEL-2")
    events = ta.person_events([row, legacy], _window(), "lee")
    # The legacy row's disposition is only in its summary, so its detail stays empty.
    assert [e["detail"] for e in events] == ["True positive \u00b7 Isolated a host \u00b7 In a bulk action", ""]
    text = repr(events)
    for sentinel in ("SENTINEL", "203.0.113.9", "abcdef0123456789"):
        assert sentinel not in text
    assert {e["case_number"] for e in events} == {"CASE-0001", None}
    assert all(e["label"] == "Closed a case" for e in events)


def test_person_events_are_newest_first_and_only_counted_kinds() -> None:
    rows = [
        _lifecycle("may", "acknowledge", "open", "investigating", ts=NOW - timedelta(hours=3)),
        _lifecycle("may", "close", "investigating", "closed", ts=NOW - timedelta(hours=1)),
        _lifecycle("may", "resolve", "investigating", "resolved", ts=NOW - timedelta(hours=2)),
        {"ts": _iso(NOW - timedelta(hours=2)), "action_type": "auth", "surface": "auth", "actor": "may",
         "action": "auth.login", "actor_type": "human", "outcome": "success",
         "client": {"ip": "198.51.100.1"}},
        _lifecycle("other", "close", "investigating", "closed", ts=NOW - timedelta(hours=1)),
    ]
    events = ta.person_events(rows, _window(), "may")
    assert [e["kind"] for e in events] == ["closed", "signed_in", "acknowledged"]
    assert events[1]["case_id"] is None and "198.51.100.1" not in repr(events)


# --------------------------------------------------------------------------- #
# The median time to acknowledge (the metrics MTTA rule)
# --------------------------------------------------------------------------- #
def _case(cid: str, *, created: datetime, acknowledged: datetime | None = None, history: list[dict] | None = None,
          trail: list[StatusHistoryEntry] | None = None, detected: datetime | None = None) -> Case:
    return Case(
        case_id=cid, cluster_signature=f"sig-{cid}", source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="198.51.100.7"), verdict=Verdict.TRUE_POSITIVE,
        confidence=0.9, risk_score=40.0, status=CaseStatus.INVESTIGATING,
        created_at=_iso(created), updated_at=_iso(created), acknowledged_at=acknowledged,
        detected_at=detected, history=history or [], status_history=trail or [],
    )


def test_time_to_acknowledge_follows_the_metrics_rule_and_the_acknowledger() -> None:
    window = _window("today")
    opened = NOW - timedelta(hours=5)
    # 1. acknowledged_at and the Acknowledge history entry name the person.
    one = _case("c1", created=opened, acknowledged=opened + timedelta(minutes=10),
                history=[{"ts": _iso(opened + timedelta(minutes=10)), "event": "analyst_action",
                          "action": "acknowledge", "analyst": "Nia"}])
    # 2. No acknowledged_at: the first human move into Investigating.
    two = _case("c2", created=opened, trail=[
        StatusHistoryEntry(from_status="new", to_status="escalated", by="system", at=_iso(opened)),
        StatusHistoryEntry(from_status="escalated", to_status="on_hold", by="nia", at=_iso(opened + timedelta(minutes=20))),
    ])
    # 3. Detected before it was created: the detection instant is the start (metrics).
    three = _case("c3", created=opened, detected=opened - timedelta(minutes=30),
                  acknowledged=opened + timedelta(minutes=30))
    # 4. First acknowledged yesterday: not this window's.
    four = _case("c4", created=opened - timedelta(days=2), acknowledged=opened - timedelta(days=1))
    assert ta.acknowledgement_seconds(one, window) == ("nia", 600.0)
    assert ta.acknowledgement_seconds(two, window) == ("nia", 1200.0)
    assert ta.acknowledgement_seconds(three, window) == ("", 3600.0)
    assert ta.acknowledgement_seconds(four, window) is None

    fold = ta.TeamActivityFold(window)
    for cid in ("c1", "c2", "c3", "c4"):
        fold.add_row(_lifecycle("nia", "acknowledge", "open", "investigating",
                                ts=opened + timedelta(minutes=10), case_id=cid))
    fold.add_acknowledged_cases({c.case_id: c for c in (one, two, three, four)})
    result = fold.result([])
    nia = _person(result, "nia")
    # c3 names nobody, so it is credited to whoever made its Acknowledge row.
    assert nia["ack_samples"] == 3 and nia["median_ack_seconds"] == 1200.0
    assert result["team"]["median_ack_seconds"] == 1200.0 and result["team"]["ack_status"] == "measured"
    omitted = fold.result([], ack_status="too_many_cases")
    assert omitted["team"]["median_ack_seconds"] is None and _person(omitted, "nia")["median_ack_seconds"] is None


def test_a_case_escalated_or_put_on_hold_without_an_acknowledge_is_measured() -> None:
    """The metrics MTTA rule takes a first human move into Escalated or On hold as the
    acknowledgement when the case was never acknowledged. Such a case is a candidate
    here too, so the team median matches the Metrics page instead of leaving those cases
    out. A move made by the agent, a move into another status and a row that changed no
    status are not candidates."""
    from app.engine import metrics

    opened = NOW - timedelta(hours=3)
    up = _case("m1", created=opened, trail=[
        StatusHistoryEntry(from_status="open", to_status="escalated", by="xia", at=_iso(opened + timedelta(minutes=10))),
    ])
    held = _case("m2", created=opened, trail=[
        StatusHistoryEntry(from_status="open", to_status="on_hold", by="xia", at=_iso(opened + timedelta(minutes=30))),
    ])
    set_to = _case("m3", created=opened, trail=[
        StatusHistoryEntry(from_status="open", to_status="investigating", by="yan",
                           at=_iso(opened + timedelta(minutes=50))),
    ])
    rows = [
        _lifecycle("xia", "escalate", "open", "escalated", ts=opened + timedelta(minutes=10), case_id="m1"),
        _lifecycle("xia", "hold", "open", "on_hold", ts=opened + timedelta(minutes=30), case_id="m2"),
        _lifecycle("yan", "set_status", "open", "investigating", ts=opened + timedelta(minutes=50), case_id="m3"),
        # A legacy hold row (no structured action) reads the same.
        _lifecycle("xia", "hold", "open", "on_hold", ts=opened + timedelta(minutes=30), case_id="m2",
                   structured=False),
        # Not candidates: an agent's move, a move to Open, a row that moved nothing.
        {**_lifecycle("agent", "escalate", "open", "escalated", ts=opened, case_id="m4"), "actor_type": "agent"},
        _lifecycle("xia", "resume", "on_hold", "open", ts=opened + timedelta(minutes=40), case_id="m5"),
        _lifecycle("xia", "escalate", "escalated", "escalated", ts=opened + timedelta(minutes=45), case_id="m6"),
    ]
    assert [ta.ack_move_of_row(r) for r in rows[4:]] == [None, None, None]
    fold = _fold(rows)
    assert fold.acknowledged_case_ids() == ["m1", "m2", "m3"]
    fold.add_acknowledged_cases({c.case_id: c for c in (up, held, set_to)})
    result = fold.result([])
    xia, yan = _person(result, "xia"), _person(result, "yan")
    assert (xia["ack_samples"], xia["median_ack_seconds"]) == (2, 1200.0)
    assert (yan["ack_samples"], yan["median_ack_seconds"]) == (1, 3000.0)
    # Counts are unchanged: an escalation is counted as one, a hold as nothing.
    assert xia["counts"]["escalated"] == 2 and xia["counts"]["acknowledged"] == 0
    assert result["team"]["ack_samples"] == 3 and result["team"]["median_ack_seconds"] == 1800.0
    # The same cases and the same median as the Metrics page's MTTA.
    mtta = metrics.lifecycle_intervals([up, held, set_to])["mtta_minutes"]
    assert mtta["count"] == 3 and mtta["p50"] * 60 == result["team"]["median_ack_seconds"]


# --------------------------------------------------------------------------- #
# search_page count option and the honesty flags (all three stores)
# --------------------------------------------------------------------------- #
def _rows(n: int) -> list[dict[str, Any]]:
    return [
        _lifecycle("ola", "acknowledge", "open", "investigating", ts=NOW - timedelta(minutes=n - i),
                   case_id=f"c-{i}")
        for i in range(n)
    ]


async def _es_repo(rows: list[dict[str, Any]], es: InMemoryESClient | None = None) -> AuditLogger:
    es = es or InMemoryESClient()
    await bootstrap_indices(es)
    for row in rows:
        await es.index_doc(AUDIT_WRITE_ALIAS, dict(row))
    return AuditLogger(es)


async def _sql_repo(rows: list[dict[str, Any]]) -> tuple[SqlAuditRepository, Any]:
    from app.stores.sql.models import AuditRow

    engine = build_async_engine("sqlite+aiosqlite:///:memory:")
    await create_all(engine)
    repo = SqlAuditRepository(engine)
    async with repo._sm() as session:  # noqa: SLF001 (raw rows, as a store holds them)
        for row in rows:
            session.add(AuditRow(ts=row["ts"], case_id=row.get("case_id"), action_type=row["action_type"], doc=row))
        await session.commit()
    return repo, engine


async def _all(repo: Any, **kwargs: Any) -> tuple[list[dict[str, Any]], list[Any]]:
    docs: list[dict[str, Any]] = []
    pages: list[Any] = []
    cursor = None
    for _ in range(20):
        page = await repo.search_page(TRUE, order="asc", limit=4, cursor=cursor, **kwargs)
        pages.append(page)
        docs.extend(h.doc for h in page.hits)
        if page.exhausted or not page.hits:
            break
        cursor = page.hits[-1].position
    return docs, pages


def test_search_page_without_a_count_pages_every_row_on_es_and_sql() -> None:
    async def run() -> None:
        rows = _rows(10)
        es = await _es_repo(rows)
        counted, counted_pages = await _all(es)
        uncounted, pages = await _all(es, count=False)
        assert [d["case_id"] for d in uncounted] == [d["case_id"] for d in counted] == [r["case_id"] for r in rows]
        assert counted_pages[0].total == 10 and counted_pages[0].relation == "eq"
        assert all(p.relation == "gte" and p.total == len(p.hits) for p in pages)
        sql, engine = await _sql_repo(rows)
        try:
            from sqlalchemy import event

            statements: list[str] = []
            event.listen(engine.sync_engine, "before_cursor_execute",
                         lambda *a: statements.append(str(a[2]).lower()))
            sql_rows, sql_pages = await _all(sql, count=False)
            assert [d["case_id"] for d in sql_rows] == [r["case_id"] for r in rows]
            assert all(p.relation == "gte" for p in sql_pages)
            assert not [s for s in statements if "count(" in s]
            statements.clear()
            await sql.search_page(TRUE, limit=4)
            assert [s for s in statements if "count(" in s]
        finally:
            await engine.dispose()

    asyncio.run(run())


def test_an_offset_read_at_its_limit_and_a_filled_scan_are_truncated(monkeypatch) -> None:
    import app.audit.audit_log as audit_log
    import app.stores.base as base

    class NoPit(InMemoryESClient):
        async def open_state_pit(self, index: str, keep_alive: str = "10m") -> str | None:
            raise RuntimeError("point-in-time is not supported here")

    async def run() -> None:
        monkeypatch.setattr(audit_log, "AUDIT_TRACK_TOTAL", 6)
        es = await _es_repo(_rows(10), NoPit())
        _docs, pages = await _all(es, count=False)
        assert sum(len(p.hits) for p in pages) == 6 and pages[-1].truncated
        whole = await _es_repo(_rows(3), NoPit())
        _docs, pages = await _all(whole, count=False)
        assert not any(p.truncated for p in pages)

        class Third(AuditRepository):
            def __init__(self, rows: list[dict[str, Any]]) -> None:
                self.rows = rows

            async def write(self, doc: Any) -> None:  # pragma: no cover
                pass

            async def record(self, **kw: Any) -> None:  # pragma: no cover
                pass

            async def records_for_case(self, case_id: str, limit: int = 500) -> list[dict[str, Any]]:
                return []

            async def records(self, *, limit: int = 100, **kw: Any) -> list[dict[str, Any]]:
                return list(reversed(self.rows))[:limit]

        monkeypatch.setattr(base, "AUDIT_FALLBACK_SCAN", 5)
        page = await Third(_rows(9)).search_page(TRUE, order="asc", limit=100, count=False)
        assert page.truncated and len(page.hits) == 5
        page = await Third(_rows(3)).search_page(TRUE, order="asc", limit=100)
        assert not page.truncated

    asyncio.run(run())


def test_the_stream_marks_the_row_limit_and_closes_its_snapshot() -> None:
    async def run() -> None:
        es = await _es_repo(_rows(12))
        closed: list[Any] = []
        original = es.close_search_cursor

        async def spy(cursor: Any) -> None:
            closed.append(cursor)
            await original(cursor)

        es.close_search_cursor = spy  # type: ignore[method-assign]
        seen: list[dict[str, Any]] = []
        read, reason = await routes_team._stream(es, TRUE, seen.append, 12)  # noqa: SLF001
        assert (read, reason) == (12, None) and closed
        seen.clear()
        read, reason = await routes_team._stream(es, TRUE, seen.append, 5)  # noqa: SLF001
        assert (read, reason) == (5, "row_limit") and len(seen) == 5

        class Old:
            """A store whose search_page predates the count option."""

            def __init__(self, inner: Any) -> None:
                self.inner = inner

            async def search_page(self, predicate, *, order="desc", limit=50, cursor=None, track_total=10_000):
                return await self.inner.search_page(predicate, order=order, limit=limit, cursor=cursor)

            async def close_search_cursor(self, cursor: Any) -> None:
                await self.inner.close_search_cursor(cursor)

        read, reason = await routes_team._stream(Old(es), TRUE, seen.append, 1000)  # noqa: SLF001
        assert (read, reason) == (12, None)

    asyncio.run(run())


# --------------------------------------------------------------------------- #
# The routes
# --------------------------------------------------------------------------- #
def _app(*, auth: bool = True, rbac: bool = False, work_routers: bool = False) -> TestClient:
    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="",
        anthropic_api_key=None, openai_api_key=None,
        auth_enabled=auth, auth_jwt_secret=_JWT_SECRET, auth_seed_admin=True,
    )
    mock = MockProvider()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(),
                                provider_overrides={"anthropic": mock, "openai": mock, "mock": mock})
        await state.startup(start_poller=False)
        prefs = state.prefs.model_copy(deep=True)
        prefs.setup_complete = True
        prefs.rbac.enabled = rbac
        await state.update_prefs(prefs)
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    deps = [Depends(require_auth)] if auth else []
    api.include_router(monolith_router, dependencies=deps)
    api.include_router(team_router, dependencies=deps)
    if work_routers:
        from app.api.routes_auto_close_review import router as review_router
        from app.api.routes_case_files import router as files_router
        from app.api.routes_case_runbooks import router as runbooks_router

        api.include_router(files_router, dependencies=deps)
        api.include_router(review_router, dependencies=deps)
        api.include_router(runbooks_router, dependencies=deps)
    mount_moved_routers(api, dependencies=deps)
    api.add_middleware(RequestIdMiddleware)
    return TestClient(api)


def _state(client: TestClient) -> AppState:
    return client.app.state.tlsoc


def _login(client: TestClient, username: str = "Admin", password: str = "Admin@123") -> dict[str, str]:
    response = client.post("/api/auth/login", json={"username": username, "password": password})
    assert response.status_code == 200, response.text
    client.cookies.clear()
    return {"Authorization": f"Bearer {response.json()['token']}"}


def _user(client: TestClient, admin: dict[str, str], username: str, role: str) -> dict[str, str]:
    created = client.post("/api/users", json={"username": username, "password": "team-activity-pass-1",
                                              "role": role}, headers=admin)
    assert created.status_code == 200, created.text
    client.cookies.clear()
    return _login(client, username, "team-activity-pass-1")


def _write(client: TestClient, rows: list[dict[str, Any]], store: str = "control") -> None:
    state = _state(client)

    async def go() -> None:
        repo = state.control_audit if store == "control" else state.demo_audit
        for row in rows:
            await repo.write(__import__("app.models", fromlist=["AuditDoc"]).AuditDoc.model_validate(row))

    client.portal.call(go)


#: Longer than any offset a route test asks of :func:`_recent`.
_RECENT_SPAN = timedelta(hours=3)


def _recent(minutes: int = 5) -> datetime:
    """``minutes`` before now, kept inside today (UTC, the default operator zone): most
    route tests read the window ``today``. In the first hours after midnight the offsets
    are scaled into the part of the day that has passed, in the same order, so a row is
    never dated yesterday."""
    now = datetime.now(timezone.utc)
    offset = timedelta(minutes=minutes)
    elapsed = now - now.replace(hour=0, minute=0, second=0, microsecond=0)
    if elapsed <= _RECENT_SPAN:
        offset = elapsed * (offset / _RECENT_SPAN)
    return now - offset


def test_a_super_admin_reads_the_team_and_actions_are_counted() -> None:
    with _app() as client:
        admin = _login(client)
        state = _state(client)
        case = _case("case-wp3-1", created=_recent(30))
        case.status = CaseStatus.OPEN
        client.portal.call(state.cases.save, case)
        for action in ("acknowledge", "close"):
            body = {"action": action}
            if action == "close":
                body["disposition"] = "false_positive"
            response = client.post("/api/cases/case-wp3-1/action", json=body, headers=admin)
            assert response.status_code == 200, response.text
        response = client.get("/api/team/activity", params={"window": "today"}, headers=admin)
        assert response.status_code == 200, response.text
        body = response.json()
        me = next(p for p in body["people"] if p["key"] == "admin")
        assert me["counts"]["acknowledged"] == 1 and me["counts"]["closed"] == 1
        assert me["counts"]["signed_in"] >= 1
        assert me["closed_by"]["false_positive"] == 1
        assert me["kind"] in {"account", "environment"}
        assert me["median_ack_seconds"] is not None and me["ack_samples"] == 1
        assert body["exact"] is True and body["auth_enabled"] is True and body["rbac_enabled"] is False
        assert body["team"]["people_active"] >= 1 and body["days"]
        people = client.get("/api/team/people", headers=admin)
        assert people.status_code == 200 and any(p["username"] == "Admin" for p in people.json()["people"])
        # Never an IP address, a user agent or a session on this page.
        text = response.text
        assert "testclient" not in text and "session_ref" not in text and "user_agent" not in text


def _agent_closed_case(cid: str) -> Case:
    """A case the AI agent closed automatically on its first decision (reviewable)."""
    at = _iso(_recent(60))
    return Case(
        case_id=cid, case_number=cid.upper(), cluster_signature=f"sig-{cid}",
        source_surface=SourceSurface.AUTOMATED_SCAN, entity=Entity(type=EntityType.IP, value="198.51.100.9"),
        verdict=Verdict.FALSE_POSITIVE, confidence=0.93, risk_score=12.0, status=CaseStatus.CLOSED,
        decision_by=DecisionBy.AGENT, disposition=Disposition.FALSE_POSITIVE, created_at=at, updated_at=at,
        status_history=[StatusHistoryEntry(from_status="new", to_status="closed", by="agent", at=at)],
        history=[{"ts": at, "event": "decision", "status": "closed", "decision_by": "agent",
                  "escalate": False, "rationale": "FALSE_POSITIVE auto-closed"}],
    )


def test_a_screenshot_or_review_whose_save_failed_is_not_counted(monkeypatch) -> None:
    """End to end: an upload whose store write failed after its audit row (a duplicate
    that landed meanwhile), and a review whose case save failed, answer an error and
    leave nothing on the case. Their pair of audit rows (the action row, then its failure
    row with the same request id) counts nothing; the attempts that were saved count."""
    import base64
    import struct
    import zlib

    from app.api import routes_case_files as rcf
    from app.stores import case_files as cf

    def png(seed: int) -> bytes:
        def chunk(ctype: bytes, body: bytes) -> bytes:
            return (struct.pack(">I", len(body)) + ctype + body
                    + struct.pack(">I", zlib.crc32(ctype + body) & 0xFFFFFFFF))

        rows = b"".join(b"\x00" + bytes((seed + x) % 256 for x in range(12)) for _ in range(3))
        return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 4, 3, 8, 2, 0, 0, 0))
                + chunk(b"IDAT", zlib.compress(rows, 0)) + chunk(b"IEND", b""))

    def upload(seed: int) -> Any:
        return client.post("/api/cases/case-wp3-files/files", headers=admin, json={
            "data_base64": base64.b64encode(png(seed)).decode(), "content_type": "image/png",
        })

    rcf._RUNTIMES.clear()  # noqa: SLF001 (a fresh upload rate bound)
    with _app(work_routers=True) as client:
        admin = _login(client)
        state = _state(client)
        client.portal.call(state.cases.save, _case("case-wp3-files", created=_recent(30)))
        for cid in ("case-wp3-rv1", "case-wp3-rv2"):
            client.portal.call(state.cases.save, _agent_closed_case(cid))
        assert upload(1).status_code == 201
        store = state.case_files
        applied = store._append  # noqa: SLF001

        async def raced(*_a: Any, **_k: Any) -> None:
            raise cf.CaseFilesConflict("The same screenshot was added to this case meanwhile.",
                                       code="case_files_duplicate")

        monkeypatch.setattr(store, "_append", raced)
        refused = upload(2)
        assert refused.status_code == 409 and refused.json()["detail"]["code"] == "case_files_duplicate"
        monkeypatch.setattr(store, "_append", applied)
        live = client.portal.call(store.index, "case-wp3-files").live
        assert len(live) == 1

        cases = state.cases
        saved = cases.save
        recorded = client.post("/api/cases/case-wp3-rv1/review", headers=admin,
                               json={"classification": "false_positive", "elapsed_ms": 20_000})
        assert recorded.status_code == 200, recorded.text

        async def down(*_a: Any, **_k: Any) -> None:
            raise RuntimeError("case store down")

        monkeypatch.setattr(cases, "save", down)
        failed = client.post("/api/cases/case-wp3-rv2/review", headers=admin,
                             json={"classification": "true_positive"})
        assert failed.status_code == 503 and failed.json()["detail"]["code"] == "case_store_unavailable"
        monkeypatch.setattr(cases, "save", saved)
        assert client.portal.call(cases.get, "case-wp3-rv2").feedback == []

        rows = client.portal.call(lambda: state.control_audit.records(limit=1000))
        actions = [r.get("action") for r in rows]
        assert actions.count("case.file_attached") == 2 and actions.count("case.file_attach_failed") == 1
        assert actions.count("case.review_recorded") == 2 and actions.count("case.review_record_failed") == 1

        response = client.get("/api/team/activity", params={"window": "today"}, headers=admin)
        assert response.status_code == 200, response.text
        me = next(p for p in response.json()["people"] if p["key"] == "admin")
        assert me["counts"]["screenshot_added"] == 1
        assert me["counts"]["reviewed"] == 1
        assert (me["reviews"]["completed"], me["reviews"]["agreed"], me["reviews"]["disagreed"]) == (1, 1, 0)
        events = client.get("/api/team/people/admin/events", params={"window": "today"}, headers=admin)
        assert events.status_code == 200, events.text
        kinds = [e["kind"] for e in events.json()["events"]]
        assert kinds.count("screenshot_added") == 1 and kinds.count("reviewed") == 1
        assert [e["case_id"] for e in events.json()["events"] if e["kind"] == "reviewed"] == ["case-wp3-rv1"]
    rcf._RUNTIMES.clear()  # noqa: SLF001


def test_a_runbook_step_that_lost_a_race_is_not_counted(monkeypatch) -> None:
    """End to end: two people mark the same runbook step done at once. Both pre-checks
    pass, and the loser's compare-and-set write finds the step already changed, so its
    action row (``step.updated``) is followed by its failure row (``step.update_failed``)
    with the same request id. That attempt counts nothing on Team activity or in the
    person's events; the step the same person did complete counts."""
    from app.engine import runbook_runs
    from app.models import LookupResult

    async def no_source_read(_state: Any, _case: Any, template: Any, **_kw: Any) -> LookupResult:
        return LookupResult(tool=template.tool, status="empty", count=0, ran_at=_iso(_recent(1)),
                            ran_by="system", facts=[])

    monkeypatch.setattr(runbook_runs, "execute_lookup", no_source_read)
    with _app(work_routers=True) as client:
        admin = _login(client)
        state = _state(client)
        client.portal.call(state.cases.save, _case("case-wp3-steps", created=_recent(30)))
        attached = client.post("/api/cases/case-wp3-steps/runbooks", headers=admin,
                               json={"runbook_id": "generic-incident"})
        assert attached.status_code == 201, attached.text
        # The on-attach lookups write to the runs too; let them settle before the race.
        client.portal.call(runbook_runs.wait_for_background_lookups, 10)
        base = f"/api/cases/case-wp3-steps/runbooks/{attached.json()['run']['run_id']}/steps"
        runs = state.runbook_runs
        original = runs.mutate
        raced = {"done": False}

        async def other_writer_first(case_id: str, change: Any, **kw: Any) -> Any:
            # Another process stores the same step change just before this one writes.
            if not raced["done"]:
                raced["done"] = True
                await original(case_id, change, **kw)
            return await original(case_id, change, **kw)

        monkeypatch.setattr(runs, "mutate", other_writer_first)
        lost = client.patch(f"{base}/incident-lead", headers=admin, json={"expected_revision": 0, "status": "done"})
        assert lost.status_code == 409 and lost.json()["detail"]["code"] == "runbook_conflict", lost.text
        monkeypatch.setattr(runs, "mutate", original)
        done = client.patch(f"{base}/what-happened", headers=admin,
                            json={"expected_revision": 0, "status": "done", "note": "Seen on one host."})
        assert done.status_code == 200, done.text

        rows = client.portal.call(lambda: state.control_audit.records(limit=1000))
        steps = [r for r in rows if r.get("action") in ("step.updated", "step.update_failed")]
        assert sorted(r["action"] for r in steps) == ["step.update_failed", "step.updated", "step.updated"]
        failed = next(r for r in steps if r["action"] == "step.update_failed")
        assert sum(1 for r in steps if r.get("request_id") == failed.get("request_id")) == 2

        response = client.get("/api/team/activity", params={"window": "today"}, headers=admin)
        assert response.status_code == 200, response.text
        me = next(p for p in response.json()["people"] if p["key"] == "admin")
        assert me["counts"]["runbook_step_done"] == 1
        events = client.get("/api/team/people/admin/events", params={"window": "today"}, headers=admin)
        assert events.status_code == 200, events.text
        assert [e["kind"] for e in events.json()["events"]].count("runbook_step_done") == 1


def test_repeated_reviews_of_one_unsampled_case_count_as_one() -> None:
    """Through the routes: 35 reviews of one agent-closed case that was not sampled are
    35 recorded grades and one review on Team activity, with no agreement rate."""
    with _app(rbac=True, work_routers=True) as client:
        admin = _login(client)
        analyst = _user(client, admin, "t1-repeat", "analyst_tier1")
        state = _state(client)
        client.portal.call(state.cases.save, _agent_closed_case("case-wp3-rep"))
        for _ in range(35):
            recorded = client.post("/api/cases/case-wp3-rep/review", headers=analyst,
                                   json={"classification": "false_positive", "elapsed_ms": 1_000})
            assert recorded.status_code == 200, recorded.text
        response = client.get("/api/team/activity", params={"window": "today"}, headers=admin)
        assert response.status_code == 200, response.text
        person = next(p for p in response.json()["people"] if p["key"] == "t1-repeat")
        assert person["counts"]["reviewed"] == 1
        assert (person["reviews"]["completed"], person["reviews"]["agreed"]) == (1, 1)
        assert person["reviews"]["agreement_rate"] is None
        assert response.json()["team"]["reviews"]["completed"] == 1
        events = client.get("/api/team/people/t1-repeat/events", params={"window": "today", "limit": 200},
                            headers=admin).json()["events"]
        reviewed = [e for e in events if e["kind"] == "reviewed"]
        assert len(reviewed) == 35
        assert sum("Replaced by a later review" in e["detail"] for e in reviewed) == 34


def test_the_role_floor_while_rbac_is_off() -> None:
    with _app(rbac=False) as client:
        admin = _login(client)
        analyst = _user(client, admin, "tier1-wp3", "analyst_tier1")
        refused = client.get("/api/team/activity", headers=analyst)
        assert refused.status_code == 403
        assert refused.json()["detail"]["code"] == "team_activity_role_required"
        rows = client.portal.call(lambda: _state(client).control_audit.records(action_type="access_denied"))
        assert any(r.get("actor") == "tier1-wp3" for r in rows)
        for path in ("/api/team/people", "/api/team/people/admin/events"):
            assert client.get(path, headers=analyst).status_code == 403
        for role in ("soc_manager", "auditor"):
            headers = _user(client, admin, f"{role}-wp3", role)
            assert client.get("/api/team/activity", headers=headers).status_code == 200


_FLOOR_DOCS = (
    "docs/analyst/team-activity.md",
    "docs/reference/permissions.md",
    "docs/reference/configuration.md",
    "docs/operations/upgrades.md",
)


def test_the_rbac_off_floor_limits_this_page_only_and_the_docs_say_so() -> None:
    """While role-based access is off every account holds every grant, users:manage
    among them, so the stored-role floor (SPEC D3.3) is a limit on this page, not an
    access control: an analyst can change its own role (an audited row) and open the
    page. It cannot make itself Super admin. Every page that describes the floor says
    this, so an operator does not read it as keeping per-person work private."""
    with _app(rbac=False) as client:
        admin = _login(client)
        analyst = _user(client, admin, "tier1-floor", "analyst_tier1")
        assert client.get("/api/team/activity", headers=analyst).status_code == 403
        promoted = client.put("/api/users/tier1-floor", json={"role": "super_admin"}, headers=analyst)
        assert promoted.status_code == 403 and promoted.json()["detail"]["code"] == "super_admin_only"
        moved = client.put("/api/users/tier1-floor", json={"role": "auditor"}, headers=analyst)
        assert moved.status_code == 200, moved.text
        rows = client.portal.call(lambda: _state(client).control_audit.records(limit=1000))
        assert any(r.get("action") == "user.role_changed" and r.get("actor") == "tier1-floor" for r in rows)
        assert client.get("/api/team/activity", headers=analyst).status_code == 200
    root = Path(__file__).resolve().parents[2]
    for doc in _FLOOR_DOCS:
        text = " ".join((root / doc).read_text(encoding="utf-8").split())
        assert "per-person work private" in text, doc
        assert "change its own role" in text, doc


def test_with_rbac_on_the_team_view_grant_decides() -> None:
    with _app(rbac=True) as client:
        admin = _login(client)
        analyst = _user(client, admin, "tier2-wp3", "analyst_tier2")
        refused = client.get("/api/team/activity", headers=analyst)
        assert refused.status_code == 403 and "team:view" in refused.text
        manager = _user(client, admin, "manager-wp3", "soc_manager")
        assert client.get("/api/team/activity", headers=manager).status_code == 200
        auditor = _user(client, admin, "auditor-wp3", "auditor")
        assert client.get("/api/team/activity", headers=auditor).status_code == 200


def test_with_rbac_on_a_role_outside_the_floor_reads_the_team_once_granted() -> None:
    """D3.2, D3.3: the stored-role floor applies only while role-based access is off.
    With it on, ``team:view`` is an ordinary grant: a team lead's role (here a Tier 2
    analyst) given it through a role override opens every team route."""
    with _app(rbac=True) as client:
        admin = _login(client)
        state = _state(client)
        lead = _user(client, admin, "lead-wp3", "analyst_tier2")
        assert client.get("/api/team/activity", headers=lead).status_code == 403
        prefs = state.prefs.model_copy(deep=True)
        prefs.rbac.roles = {**prefs.rbac.roles, "analyst_tier2": {"team": ["view"]}}
        client.portal.call(state.update_prefs, prefs)
        for path in ("/api/team/activity", "/api/team/people", "/api/team/people/admin/events"):
            response = client.get(path, headers=lead)
            assert response.status_code == 200, (path, response.text)
        assert client.get("/api/team/activity", headers=lead).json()["rbac_enabled"] is True


def test_the_switch_and_the_window_bounds() -> None:
    with _app() as client:
        admin = _login(client)
        too_long = client.get("/api/team/activity", params={"window": "now-120d"}, headers=admin)
        assert too_long.status_code == 422 and too_long.json()["detail"]["code"] == "team_window_too_long"
        bad = client.get("/api/team/activity", params={"window": "soon"}, headers=admin)
        assert bad.status_code == 422 and bad.json()["detail"]["code"] == "team_invalid_window"
        state = _state(client)
        prefs = state.prefs.model_copy(deep=True)
        prefs.team_activity.enabled = False
        client.portal.call(state.update_prefs, prefs)
        for path in ("/api/team/activity", "/api/team/people", "/api/team/people/admin/events"):
            off = client.get(path, headers=admin)
            assert off.status_code == 409 and off.json()["detail"]["code"] == "team_activity_off"


def test_a_person_s_events_page_holds_at_most_two_hundred() -> None:
    """D3.10: at most 200 events a page; a larger limit is refused, not served."""
    assert routes_team.EVENTS_PAGE_MAX == 200
    with _app() as client:
        admin = _login(client)
        _write(client, [
            _lifecycle("max", "acknowledge", "open", "investigating", ts=_recent(30), case_id=f"m-{i}")
            for i in range(201)
        ])
        too_many = client.get("/api/team/people/max/events", params={"window": "today", "limit": 201},
                              headers=admin)
        assert too_many.status_code == 422, too_many.text[:200]
        page = client.get("/api/team/people/max/events", params={"window": "today", "limit": 200}, headers=admin)
        assert page.status_code == 200, page.text
        assert len(page.json()["events"]) == 200 and page.json()["next_cursor"]


def test_a_cached_answer_expires_after_sixty_seconds() -> None:
    """D3.6: an answer is reused for 60 seconds per viewer and window, then computed
    again. The "today" window starts at the same instant all day, so an answer that
    never expired would freeze the day's counts at the first read."""
    now = [0.0]
    computed: list[float] = []
    cache = routes_team._AnswerCache(clock=lambda: now[0])  # noqa: SLF001

    async def compute() -> int:
        computed.append(now[0])
        return len(computed)

    async def run() -> list[int]:
        seen = [await cache.get(("viewer", "today"), compute)]
        now[0] = 59.999
        seen.append(await cache.get(("viewer", "today"), compute))
        seen.append(await cache.get(("other-viewer", "today"), compute))
        now[0] = 60.0
        seen.append(await cache.get(("viewer", "today"), compute))
        return seen

    assert asyncio.run(run()) == [1, 1, 2, 3]
    assert computed == [0.0, 59.999, 60.0]


def test_sign_in_off_answers_an_empty_page() -> None:
    with _app(auth=False) as client:
        response = client.get("/api/team/activity")
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["auth_enabled"] is False and body["people"] == []
        assert client.get("/api/team/people").json()["people"] == []
        assert client.get("/api/team/people/analyst/events").status_code == 404


def test_answers_are_cached_per_viewer_and_window_for_a_minute(monkeypatch) -> None:
    calls: list[str] = []
    original = routes_team._compute_activity  # noqa: SLF001

    async def counting(state: Any, window: Any) -> Any:
        calls.append(window.token)
        return await original(state, window)

    monkeypatch.setattr(routes_team, "_compute_activity", counting)
    with _app() as client:
        admin = _login(client)
        for _ in range(3):
            assert client.get("/api/team/activity", params={"window": "today"}, headers=admin).status_code == 200
        assert calls == ["today"]
        assert client.get("/api/team/activity", params={"window": "now-7d"}, headers=admin).status_code == 200
        assert calls == ["today", "now-7d"]
        manager = _user(client, admin, "cache-manager", "soc_manager")
        assert client.get("/api/team/activity", params={"window": "today"}, headers=manager).status_code == 200
        assert calls == ["today", "now-7d", "today"]


def test_reads_write_one_coalesced_team_viewed_row() -> None:
    from app.audit import views

    with _app() as client:
        admin = _login(client)
        views.TEAM_RECORDER._seen.clear()  # noqa: SLF001
        for _ in range(3):
            client.get("/api/team/activity", headers=admin)
            client.get("/api/team/people", headers=admin)
        rows = client.portal.call(lambda: _state(client).control_audit.records(action_type="audit_view"))
        viewed = [r for r in rows if r.get("action") == "team.viewed"]
        assert len(viewed) == 1 and viewed[0]["actor"] == "Admin" and viewed[0]["surface"] == "team"


def test_a_person_s_events_match_every_spelling_newest_first_with_a_signed_cursor() -> None:
    with _app() as client:
        admin = _login(client)
        rows = [
            _lifecycle(name, "acknowledge", "open", "investigating", ts=_recent(60 - i), case_id=f"c-{i}",
                       reason="SENTINEL")
            for i, name in enumerate(["Pat", "pat", "PAT", "pat", "Pat"])
        ]
        _write(client, rows)
        first = client.get("/api/team/people/pat/events", params={"window": "today", "limit": 2}, headers=admin)
        assert first.status_code == 200, first.text
        body = first.json()
        assert body["total"] == 5 and len(body["events"]) == 2 and body["next_cursor"]
        assert [e["case_id"] for e in body["events"]] == ["c-4", "c-3"]
        assert "SENTINEL" not in first.text
        seen = [e["case_id"] for e in body["events"]]
        cursor = body["next_cursor"]
        while cursor:
            page = client.get("/api/team/people/PAT/events",
                              params={"window": "today", "limit": 2, "cursor": cursor}, headers=admin).json()
            seen += [e["case_id"] for e in page["events"]]
            cursor = page["next_cursor"]
        assert seen == ["c-4", "c-3", "c-2", "c-1", "c-0"]
        tampered = client.get("/api/team/people/pat/events",
                              params={"window": "today", "cursor": body["next_cursor"][:-3] + "abc"}, headers=admin)
        assert tampered.status_code == 409
        other_window = client.get("/api/team/people/pat/events",
                                  params={"window": "now-7d", "cursor": body["next_cursor"]}, headers=admin)
        assert other_window.status_code == 409
        for name in ("analyst", "default", "nobody-here"):
            assert client.get(f"/api/team/people/{name}/events", headers=admin).status_code == 404


def test_a_person_s_events_list_what_the_cached_counts_counted() -> None:
    with _app() as client:
        admin = _login(client)
        _write(client, [_lifecycle("sam", "acknowledge", "open", "investigating", ts=_recent(30), case_id="s-1")])
        counted = client.get("/api/team/activity", headers=admin).json()
        sam = next(p for p in counted["people"] if p["key"] == "sam")
        assert sam["counts"]["acknowledged"] == 1
        # A row written after the counts were read (and cached) is not in the sheet yet.
        _write(client, [_lifecycle("sam", "acknowledge", "open", "investigating", ts=_recent(0), case_id="s-2")])
        events = client.get("/api/team/people/sam/events", headers=admin).json()
        assert events["total"] == 1 and [e["case_id"] for e in events["events"]] == ["s-1"]


def test_a_later_events_page_never_ages_the_cached_counts() -> None:
    """"Load more" reads the window its cursor fixed, which ends where the first page
    stopped. After the cached answer expires, that page must not fold the fixed window
    into the page's cache slot: the next read of the page would then show counts that
    stop at the old instant for a minute."""
    with _app() as client:
        admin = _login(client)
        state = _state(client)
        _write(client, [
            _lifecycle("lee", "acknowledge", "open", "investigating", ts=_recent(30 - i), case_id=f"l-{i}")
            for i in range(3)
        ])
        first = client.get("/api/team/people/lee/events", params={"window": "today", "limit": 1}, headers=admin)
        assert first.status_code == 200 and first.json()["next_cursor"]
        routes_team.answer_cache(state).clear()  # the minute is over
        _write(client, [_lifecycle("lee", "acknowledge", "open", "investigating", ts=_recent(0), case_id="l-new")])
        more = client.get("/api/team/people/lee/events",
                          params={"window": "today", "limit": 1, "cursor": first.json()["next_cursor"]}, headers=admin)
        assert more.status_code == 200, more.text
        # The later page still lists the fixed window: three events, the new one not among them.
        assert more.json()["total"] == 3 and more.json()["events"][0]["case_id"] == "l-1"
        counted = client.get("/api/team/activity", params={"window": "today"}, headers=admin).json()
        lee = next(p for p in counted["people"] if p["key"] == "lee")
        assert lee["counts"]["acknowledged"] == 4


def test_the_off_answer_names_where_the_switch_is() -> None:
    with _app() as client:
        admin = _login(client)
        state = _state(client)
        prefs = state.prefs.model_copy(deep=True)
        prefs.team_activity.enabled = False
        client.portal.call(state.update_prefs, prefs)
        message = client.get("/api/team/activity", headers=admin).json()["detail"]["message"]
        assert "Settings, Security & access, Single sign-on & policy, Team activity" in message


def test_the_person_view_row_names_the_person_on_one_plain_line() -> None:
    from app.audit import views

    with _app() as client:
        admin = _login(client)
        views.TEAM_RECORDER._seen.clear()  # noqa: SLF001
        name = "eve\u202ex"
        _write(client, [_lifecycle(name, "acknowledge", "open", "investigating", ts=_recent(5), case_id="e-1")])
        response = client.get(f"/api/team/people/{name}/events", headers=admin)
        assert response.status_code == 200, response.text
        rows = client.portal.call(lambda: _state(client).control_audit.records(action_type="audit_view"))
        person = [r for r in rows if r.get("action") == "team.viewed" and (r.get("tool_input") or {}).get("view") == "person"]
        assert len(person) == 1
        summary = person[0]["result_summary"]
        assert "\u202e" not in summary and summary == "Viewed the Team activity of eve\ufffdx."


def test_a_partial_read_says_so(monkeypatch) -> None:
    """A read that stopped at its row limit holds the oldest part of the window only:
    the counts are lower bounds, but a median or a rate of that part is not, so the time
    to acknowledge reads ``partial`` and is omitted rather than taken from the part."""
    monkeypatch.setattr(ta, "MAX_SCANNED_ROWS", 3)
    with _app() as client:
        admin = _login(client)
        state = _state(client)
        created = _recent(120)
        acked = [_recent(119) if i < 3 else _recent(20) for i in range(6)]
        for i in range(6):
            client.portal.call(state.cases.save, _case(
                f"q-{i}", created=created, acknowledged=acked[i],
                history=[{"ts": _iso(acked[i]), "event": "analyst_action", "action": "acknowledge",
                          "analyst": "quin"}],
            ))
        _write(client, [
            _lifecycle("quin", "acknowledge", "open", "investigating", ts=acked[i], case_id=f"q-{i}")
            for i in range(6)
        ])
        body = client.get("/api/team/activity", headers=admin).json()
        assert body["exact"] is False and body["partial_reason"] == "row_limit" and body["scanned_rows"] == 3
        team, quin = body["team"], _person(body, "quin")
        assert team["counts"]["acknowledged"] == 3  # at least these
        assert team["ack_status"] == "partial"
        assert team["median_ack_seconds"] is None and team["ack_samples"] == 0
        assert quin["median_ack_seconds"] is None and quin["ack_samples"] == 0


def test_a_partial_fold_omits_every_median_and_rate() -> None:
    """The pure fold: with a partial reason the counts stand and every median and rate
    is omitted, whatever the caller passed as the acknowledgement status (an unavailable
    or too-many-cases status keeps its own reason)."""
    t = NOW - timedelta(hours=1)
    rows = [_review("zed", True, ts=t, case_id=f"z{i}", elapsed=40_000) for i in range(30)]
    fold = _fold(rows)
    fold.add_review_requests([{"ts": _iso(t - timedelta(minutes=5)), "action": "case.review_requested",
                               "case_id": f"z{i}"} for i in range(30)])
    exact = fold.result([])
    assert exact["team"]["reviews"]["agreement_rate"] == 1.0
    assert exact["team"]["reviews"]["time_spent_median_ms"] == 40_000.0
    assert exact["team"]["reviews"]["time_to_review_median_seconds"] == 300.0
    partial = fold.result([], partial_reason="store_limit")
    for reviews in (partial["team"]["reviews"], _person(partial, "zed")["reviews"]):
        assert (reviews["completed"], reviews["agreed"], reviews["answered"]) == (30, 30, 30)
        assert reviews["agreement_rate"] is None
        assert reviews["time_spent_median_ms"] is None and reviews["time_to_review_median_seconds"] is None
    assert partial["team"]["ack_status"] == "partial" and partial["exact"] is False
    assert fold.result([], partial_reason="row_limit", ack_status="unavailable")["team"]["ack_status"] == "unavailable"


def test_the_case_bound_omits_the_median(monkeypatch) -> None:
    monkeypatch.setattr(ta, "ACK_CASES_LIMIT", 1)
    with _app() as client:
        admin = _login(client)
        _write(client, [
            _lifecycle("rae", "acknowledge", "open", "investigating", ts=_recent(10 - i), case_id=f"r-{i}")
            for i in range(2)
        ])
        team = client.get("/api/team/activity", headers=admin).json()["team"]
        assert team["ack_status"] == "too_many_cases" and team["median_ack_seconds"] is None


def test_demo_mode_reads_case_work_from_the_demo_audit_and_sign_ins_from_control() -> None:
    with _app() as client:
        admin = _login(client)
        state = _state(client)
        real_work = _lifecycle("realperson", "acknowledge", "open", "investigating", ts=_recent(20), case_id="real-1")
        _write(client, [real_work])
        client.portal.call(lambda: state.enable_demo(mode="seeded", seed=1337, history_days=3))
        try:
            response = client.get("/api/team/activity", params={"window": "now-7d"}, headers=admin)
            assert response.status_code == 200, response.text
            body = response.json()
            assert body["demo"] is True
            keys = {p["key"]: p for p in body["people"]}
            # Real case work stays out of the Demo page; the real sign-in counts.
            assert "realperson" not in keys
            assert keys["admin"]["counts"]["signed_in"] >= 1
            demo_people = [p for p in body["people"] if p["kind"] == "demo"]
            assert {p["username"] for p in demo_people} >= {"asha.iyer", "farhan.qureshi", "meera.pillai"}
            worked = sum(p["counts"]["acknowledged"] + p["counts"]["closed"] for p in demo_people)
            assert worked > 0
        finally:
            client.portal.call(state.disable_demo)


# --------------------------------------------------------------------------- #
# The Demo seed's rows
# --------------------------------------------------------------------------- #
def test_the_demo_rows_match_the_seeded_cases() -> None:
    from app.engine import demo_generator as gen
    from app.utils import to_millis

    now = datetime.now(timezone.utc)
    now_ms = to_millis(now)
    org = gen.build_org(1337)
    cases = gen.generate_historical_cases(1337, org, history_days=14, run_id="r", now_millis=now_ms)
    rows = gen.demo_team_activity_audit_rows(cases, now_millis=now_ms)
    assert rows
    team = {a.lower() for a in gen.DEMO_SOC_ANALYSTS}
    assert all(r["actor"].lower() in team and r["actor_type"] == "human" and r["outcome"] == "success" for r in rows)
    assert all(datetime.fromisoformat(r["ts"].replace("Z", "+00:00")) <= now for r in rows)
    instants = [datetime.fromisoformat(r["ts"].replace("Z", "+00:00")) for r in rows]
    assert instants == sorted(instants)
    # Every human status move the cases credit to the team has its row, at its time.
    moves = {
        (c.case_id, e.to_status, e.by)
        for c in cases for e in c.status_history if e.by in gen.DEMO_SOC_ANALYSTS
    }
    written = {
        (r["case_id"], next(ch.after for ch in r["changes"] if ch.field == "status"), r["actor"])
        for r in rows if r["action_type"].value == "status"
    }
    assert moves == written
    fold = ta.TeamActivityFold(ta.resolve_team_window("now-30d", tz="UTC", now=now))
    for row in rows:
        doc = dict(row)
        doc["action_type"] = row["action_type"].value
        doc["target"] = row["target"].model_dump()
        doc["changes"] = [c.model_dump() for c in row.get("changes") or []]
        fold.add_row(doc)
    result = fold.result([])
    closed = sum(p["counts"]["closed"] for p in result["people"])
    assert closed == sum(1 for c in cases for e in c.status_history
                         if e.by in gen.DEMO_SOC_ANALYSTS and e.to_status == "closed")
    acknowledged = sum(p["counts"]["acknowledged"] for p in result["people"])
    assert acknowledged == sum(1 for c in cases if c.acknowledged_at is not None)


# --------------------------------------------------------------------------- #
# Static guards (SPEC §3.6)
# --------------------------------------------------------------------------- #
def _imports(path: Path) -> list[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    names: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            names.append(("." * node.level) + (node.module or ""))
            names.extend(f"{node.module or ''}.{a.name}" for a in node.names)
        elif isinstance(node, ast.Import):
            names.extend(a.name for a in node.names)
    return names


def test_team_counts_never_reach_a_model_surface() -> None:
    banned = [*(APP / "agents").rglob("*.py"), *(APP / "tools").rglob("*.py"),
              APP / "engine" / "report_digest.py", APP / "engine" / "chat_starters.py"]
    for path in banned:
        for name in _imports(path):
            assert "team_activity" not in name, f"{path.relative_to(BACKEND)} imports {name}"
        assert "routes_team" not in path.read_text(encoding="utf-8")


def test_the_team_fold_never_imports_the_decision_core() -> None:
    for path in (APP / "engine" / "team_activity.py", APP / "api" / "routes_team.py"):
        for line in path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if stripped.startswith(("import ", "from ")):
                assert "case_manager" not in stripped, f"{path.name}: {line!r}"


def test_every_kind_has_a_label_and_the_chart_has_seven() -> None:
    assert set(ta.KIND_LABELS) == set(ta.ALL_KINDS)
    assert len(ta.CHART_KINDS) == 7
    for label in (*ta.KIND_LABELS.values(), *ta.DISPOSITION_LABELS.values()):
        assert "\u2014" not in label and "\u2013" not in label and label[0].isupper()
    assert all_of(ta.work_predicate()) == ta.work_predicate()
