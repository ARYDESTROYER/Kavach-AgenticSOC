"""Round 13 close, backend fixer (BF): one label, one figure; one figure, one form.

  1. "Needs human" means the open cases whose VERDICT is Needs human on every surface:
     the Standup report carries that figure (and its delta) beside the legacy status
     count, which the Standup page labels "Awaiting analyst"; chat's shift observation
     names the status count ``awaiting_analyst`` too, and the standup writer's prompt
     says so.
  2. A rate in a tool's step summary reads as the console's tile shows it ("76%",
     never "75.6%"), through the helper the planner's prose uses.
  3. A case's ATT&CK techniques in the prose: every one up to the bound, else the first
     ones and "and K more techniques"; never a silent cut beside a block listing them.
  4. A campaign's "K more" tails name their noun, and the campaign answer states its
     shared entities and its techniques as separate clauses.
  6. A starter's "{x} times" ratio drops a trailing ".0" and rounds half up.
"""

from __future__ import annotations

import re
from contextlib import asynccontextmanager
from datetime import timedelta
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.agents import chat_starter_text as starter_text
from app.agents.chat_tools.cases import ShiftReportTool
from app.agents.standup import SHIFT_STANDUP_SYSTEM, StandupService
from app.constants import CaseStatus, EntityType, SourceSurface, Verdict
from app.engine import demo_chat
from app.engine.shift_report import build_shift_report
from app.models import Case, Entity
from app.utils import now_utc
from tests.test_chat_tools_support import make_ctx
from tests.test_demo_chat_round12 import drive
from tests.test_demo_chat_round13 import _starter


def _case(n: int, *, status: CaseStatus = CaseStatus.OPEN, verdict: Verdict | None = Verdict.NEEDS_HUMAN,
          assignee: str = "", age_minutes: float = 30.0) -> Case:
    return Case(
        case_id=f"case-{n}", cluster_signature=f"sig-{n}", source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value=f"10.0.0.{n}"), risk_score=40.0 + n, status=status,
        verdict=verdict, assignee=assignee, title=f"case {n}",
        created_at=(now_utc() - timedelta(minutes=age_minutes)).isoformat(),
    )


# Two open cases with a Needs human verdict (one of them in the legacy needs_human
# status), one escalated true positive and one case in the needs_human status whose
# verdict is a false positive below the auto-close bar.
_CASES = [
    _case(1),
    _case(2, status=CaseStatus.NEEDS_HUMAN, assignee="alice"),
    _case(3, status=CaseStatus.ESCALATED, verdict=Verdict.TRUE_POSITIVE),
    _case(4, status=CaseStatus.NEEDS_HUMAN, verdict=Verdict.FALSE_POSITIVE, assignee="alice"),
]


class _Repo:
    def __init__(self, cases: list[Case]) -> None:
        self._cases = cases

    async def list(self, *, status: str | None = None, limit: int = 50, offset: int = 0, **_: Any):
        rows = [c for c in self._cases if status is None or c.status.value == status]
        return rows[offset: offset + limit], len(rows)


class _Audit:
    async def record(self, **_: Any) -> None:
        return None


# --------------------------------------------------------------------------- #
# 1. One label, one figure.
# --------------------------------------------------------------------------- #
@pytest.fixture
def standup_client(secrets, mock_provider):
    from app.api import routes_standup
    from app.es.fake import InMemoryESClient
    from app.state import AppState

    overrides = {"anthropic": mock_provider, "openai": mock_provider, "mock": mock_provider}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
        await state.startup(start_poller=False)
        await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
        state._real_standup_service = StandupService(
            state.es, state.gateway, state._real_audit, cases=_Repo(_CASES), shift_handoff=state.shift_handoff,
        )
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(routes_standup.router)
    with TestClient(api) as client:
        yield client


def test_the_standup_report_carries_the_needs_human_verdict_count_chat_shows(standup_client) -> None:
    body = standup_client.get("/api/standup/report").json()
    headline = body["shift"]["headline_counts"]
    # "Needs human" (verdict) and "Awaiting analyst" (the legacy status) are two figures.
    assert headline["needs_human_verdict"] == 2, headline
    assert headline["needs_human"] == 2, headline
    assert headline["open"] == 4 and headline["escalated"] == 1
    assert body["deltas"]["needs_human_verdict"]["current"] == 2, body["deltas"]
    assert body["deltas"]["needs_human"]["current"] == 2


async def test_chat_and_the_standup_report_state_the_same_needs_human_figure(standup_client) -> None:
    report = standup_client.get("/api/standup/report").json()
    service = StandupService(None, None, _Audit(), cases=_Repo(_CASES))
    out = await ShiftReportTool().run(make_ctx(standup=service))
    assert out.ok, out.summary
    tiles = {i["key"]: i for i in out.artifacts[0].data["items"]}
    assert tiles["needs_human_verdict"]["label"] == "Needs human"
    assert tiles["needs_human_verdict"]["value"] == report["shift"]["headline_counts"]["needs_human_verdict"]
    # The status count is never a second "needs human" figure in chat's observation.
    assert "needs_human" not in out.observation["headline"]
    rows = {w["analyst"]: w for w in out.observation["workload"]}
    assert rows["alice"] == {"analyst": "alice", "open": 2, "escalated": 0, "awaiting_analyst": 2}, rows
    assert all("needs_human" not in w for w in out.observation["workload"])


def test_the_standup_model_aggregate_keeps_its_keys_and_names_the_status() -> None:
    # The writer's aggregate is unchanged (its fence has no room for a second count);
    # the prompt says what its needs_human counts, in the console's words.
    report = build_shift_report(_CASES)
    assert "needs_human_verdict" not in report["headline_counts"]
    assert "'needs_human' counts the open cases in the status the console shows as " \
           "'Open · awaiting analyst'" in SHIFT_STANDUP_SYSTEM
    assert "never 'needs human'" in SHIFT_STANDUP_SYSTEM
    assert "—" not in SHIFT_STANDUP_SYSTEM.split("aggregates.\n", 1)[1]


# --------------------------------------------------------------------------- #
# 2. A rate in a step summary reads as the tile does.
# --------------------------------------------------------------------------- #
def test_the_posture_step_summary_states_the_rate_as_the_tile() -> None:
    from app.agents.chat_tools.common import fmt_pct

    # The live shift brief: "FP rate 75.6%" under a "76%" tile.
    assert fmt_pct(75.6) == "76%" and fmt_pct(58.6) == "59%"
    assert fmt_pct(0.756, ratio=True) == demo_chat._pct(0.756, ratio=True) == "76%"


# --------------------------------------------------------------------------- #
# 3. Every technique, or the first ones and "and K more techniques".
# --------------------------------------------------------------------------- #
_TECHNIQUES = [
    {"id": "T1566", "name": "Phishing", "tactic": "initial-access"},
    {"id": "T1078", "name": "Valid Accounts", "tactic": "defense-evasion"},
    {"id": "T1021", "name": "Remote Services", "tactic": "lateral-movement"},
    {"id": "T1048", "name": "Exfiltration Over Alternative Protocol", "tactic": "exfiltration"},
    {"id": "T1110", "name": "Brute Force", "tactic": "credential-access"},
]


def _case_obs(techniques: list[dict[str, Any]]) -> dict[str, Any]:
    return {"case": {"case_id": "case-82", "case_number": "CASE-000082", "title": "Phishing from 198.51.100.7",
                     "status": "open", "verdict": "TRUE_POSITIVE", "risk_score": 80,
                     "entity": {"type": "ip", "value": "198.51.100.7"}},
            "mitre": techniques}


def test_the_case_brief_names_every_technique_up_to_four() -> None:
    four = demo_chat.Result(ordinal=1, tool="get_case", status="ok", summary="", observation=_case_obs(_TECHNIQUES[:4]))
    line = next(t for t in demo_chat._say_get_case(four) if t.startswith("ATT&CK:"))
    assert all(t["id"] in line for t in _TECHNIQUES[:4]), line
    assert "more" not in line, line
    five = demo_chat.Result(ordinal=1, tool="get_case", status="ok", summary="", observation=_case_obs(_TECHNIQUES))
    line = next(t for t in demo_chat._say_get_case(five) if t.startswith("ATT&CK:"))
    assert line.endswith(" and 2 more techniques."), line
    assert [t["id"] for t in _TECHNIQUES if t["id"] in line] == ["T1566", "T1078", "T1021"], line


def _hunt_obs(techniques: list[dict[str, Any]]):
    def run(tool: str, inp: dict[str, Any]) -> dict[str, Any] | None:
        if tool == "search_cases":
            return {"count": 1, "cases": [{"case_id": "case-82", "case_number": "CASE-000082",
                                            "title": "Phishing from 198.51.100.7", "status": "open",
                                            "entity": "ip:198.51.100.7", "risk_score": 80}]}
        if tool == "get_case":
            return _case_obs(techniques)
        return {"count": 0, "cases": [], "hits": [], "total": 0}
    return run


@pytest.mark.parametrize("count", [4, 5])
def test_the_hunt_answer_states_the_source_case_techniques_as_its_block_lists_them(count: int) -> None:
    techniques = _TECHNIQUES[:count]
    _rounds, _header, body = drive("Hunt the source IP behind the newest phishing case", _hunt_obs(techniques))
    line = next(s for s in body.split("\n") if "maps to ATT&CK" in s)
    sentence = line[line.index("The source case maps to ATT&CK"):].split(".")[0]
    named = [t["id"] for t in techniques if t["id"] in sentence]
    more = re.search(r"and (\d+) more techniques$", sentence)
    assert len(named) + (int(more.group(1)) if more else 0) == count, sentence
    if count == 4:
        assert named == ["T1566", "T1078", "T1021", "T1048"] and more is None, sentence


# --------------------------------------------------------------------------- #
# 4. A "K more" tail names its noun.
# --------------------------------------------------------------------------- #
#: A "K more" with no noun after it ("and 6 more (high", "5 more and ATT&CK").
_BARE_MORE = re.compile(r"\d more(?=[);,.]|$| and | \()")

_BIG = {"id": "campaign-big", "status": "open", "severity": "high", "case_count": 9,
        "case_ids": ["demo-1", "demo-2"],
        "entities": ["ip:198.51.100.1", "ip:198.51.100.2", "ip:198.51.100.3", "ip:198.51.100.4", "ip:198.51.100.5"],
        "entity_count": 7, "mitre": ["T1021", "T1048", "T1078", "T1110", "T1566", "T1059"], "mitre_count": 6}


def test_a_large_campaign_says_more_shared_entities_and_more_techniques() -> None:
    result = demo_chat.Result(ordinal=1, tool="list_campaigns", status="ok", summary="1 campaign",
                              observation={"total": 1, "returned": 1, "campaigns": [_BIG]})
    text = demo_chat._say_campaigns(result)
    assert "9 cases sharing IP `198.51.100.1` and 6 more shared entities" in text, text
    assert "ATT&CK T1021, T1048, T1078 and 3 more techniques" in text, text
    assert _BARE_MORE.search(text) is None, text


def test_the_campaign_answer_states_entities_and_techniques_as_two_clauses() -> None:
    def obs(tool: str, inp: dict[str, Any]) -> dict[str, Any]:
        if tool == "list_campaigns":
            return {"case_filter": {"found": True, "case_id": "demo-2", "case_number": "CASE-000002"},
                    "total": 1, "returned": 1, "campaigns": [_BIG]}
        return {"count": 0, "cases": []}

    _rounds, _header, body = drive(_starter("campaign", {"n": 9, "case": "CASE-000002"}), obs)
    lead = body.split("\n\n")[0]
    assert lead.startswith(
        "The campaign that includes `CASE-000002` links **9 cases** through IP `198.51.100.1`, "
        "IP `198.51.100.2` and 5 more shared entities. It maps to ATT&CK T1021, T1048, T1078 and 3 more "
        "techniques."), lead
    assert _BARE_MORE.search(lead) is None, lead


def test_a_small_campaign_names_everything_without_a_tail() -> None:
    small = {**_BIG, "entities": ["user:pnair"], "entity_count": 1, "mitre": ["T1078"], "mitre_count": 1}
    result = demo_chat.Result(ordinal=1, tool="list_campaigns", status="ok", summary="1 campaign",
                              observation={"total": 1, "returned": 1, "campaigns": [small]})
    text = demo_chat._say_campaigns(result)
    assert "sharing user `pnair` (high; ATT&CK T1078)" in text and "more" not in text, text


# --------------------------------------------------------------------------- #
# 6. "15 times", never "15.0 times".
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("ratio, shown", [
    (15.0, "15"), (45 / 3, "15"), (2.43, "2.4"), (2.45, "2.5"), (1.96, "2"), (3.0, "3"),
    (1234.5, "1,234.5"), (2.0000001, "2"),
])
def test_a_starter_ratio_reads_like_the_start_screens_other_figures(ratio: float, shown: str) -> None:
    assert starter_text.format_ratio(ratio) == shown
    reason = starter_text.render_reason("volume_spike", "default", {"x": starter_text.format_ratio(ratio)})
    assert reason == f"{shown} times the usual daily level"
    assert ".0 times" not in reason
