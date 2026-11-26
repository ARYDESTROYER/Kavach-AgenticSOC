"""Round 16 XFDEMO: two seeded-Demo findings of the cross-cutting review.

* ``demo-storyline-from-precedents``: the Demo provider reads a case's storyline only
  from the case's own cluster block of the investigation prompt. A retrieved
  precedent, a memory or a runbook that names another storyline's rule never changes
  a Demo verdict, so a seeded Demo Reinvestigate keeps each case's own storyline.
* ``demo-run-under-hold-off``: in Demo Mode an investigation a person or a job started
  waits ``DEMO_INVESTIGATION_STEP_DELAY_S`` before each model step, so the Console's AI
  working signals show and a person can act on the case while the run goes on. Chat,
  report summaries, runbook help and automatic runs never wait; nothing outside Demo
  Mode changes.

Fully offline (fake ES, mock LLM, the $0 Demo gateway). The suite sets the pause to 0
in ``conftest``; the pacing tests set their own small value."""

from __future__ import annotations

import asyncio
import json
import random
import time
from collections.abc import Iterator
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.agents import pipeline as pipeline_mod
from app.agents.prompts import (
    CLUSTER_CONTEXT_HEADING,
    SAMPLE_EVENTS_HEADING,
    render_cluster,
)
from app.config import Secrets
from app.constants import EntityType, SourceSurface, Verdict
from app.engine import demo_generator as gen
from app.engine.correlation import cluster_from_events
from app.es.fake import InMemoryESClient
from app.llm import providers
from app.llm.providers import DemoMockProvider, MockProvider
from app.models import Case, MemoryEntry, RagChunk
from app.state import AppState
from tests.conftest import make_raw_event, mount_moved_routers

SEED = 1337
SQLI_QRADAR_RULE = gen.NATIVE_STORY_RULE_IDS["qradar"]["sqli_webshell"]
STAGING_RULE = gen.NATIVE_STORY_RULE_IDS["syslog"]["insider_staging"]
BENIGN_RULE = "LP-ES-RISK-0099"


# --------------------------------------------------------------------------- #
# demo-storyline-from-precedents: a real ``render_cluster`` prompt
# --------------------------------------------------------------------------- #
def _cluster(rule: str, ip: str = "198.51.100.30"):
    base = 1_700_000_000_000
    events = [
        make_raw_event(id=f"e{i}", ip=ip, rule=rule, ts_millis=base + i * 1000)
        for i in range(4)
    ]
    return cluster_from_events(EntityType.IP, ip, events)


def _poisoned_prompt(rule: str) -> str:
    """The investigator prompt for a cluster of ``rule``, with every block around the
    cluster naming another storyline: a memory, a runbook, a retrieved runbook chunk,
    and an analyst-confirmed precedent of the SQL injection storyline."""
    precedent = RagChunk(
        source="resolved_case",
        text=(
            "Resolved case demo-00000539-0001 (true positive, escalated). "
            f"Rules: {SQLI_QRADAR_RULE}."
        ),
        metadata={"trust_class": "analyst_confirmed"},
    )
    knowledge = RagChunk(source="runbook", text="Phishing triage for demo_phishing_chain alerts.")
    memory = [MemoryEntry(text="WEB-EXPLOIT alerts from the loan API are always real.")]
    runbook = "Step 1: look for demo_phishing_chain lures and RDP-BRUTEFORCE follow-ups."
    return render_cluster(
        _cluster(rule), None, [precedent, knowledge], runbook=runbook, memory=memory,
    )


def _messages(prompt: str) -> list[dict[str, str]]:
    return [
        {"role": "system", "content": "You are the investigator."},
        {"role": "user", "content": prompt + "\n\nBegin the investigation. Respond with JSON only."},
    ]


def test_the_prompt_holds_both_headings_the_demo_reader_cuts_on() -> None:
    prompt = _poisoned_prompt(STAGING_RULE)
    assert prompt.count(CLUSTER_CONTEXT_HEADING) == 1
    assert prompt.count("\n" + SAMPLE_EVENTS_HEADING + " (") == 1
    # The poison really is in the prompt, above and below the cluster block.
    assert prompt.index("demo_phishing_chain") < prompt.index(CLUSTER_CONTEXT_HEADING)
    assert prompt.rindex(SQLI_QRADAR_RULE) > prompt.index(SAMPLE_EVENTS_HEADING)


@pytest.mark.parametrize(
    ("rule", "expected"),
    [
        (STAGING_RULE, "insider_staging"),
        (BENIGN_RULE, None),
        (SQLI_QRADAR_RULE, "sqli_webshell"),
    ],
)
def test_a_retrieved_storyline_never_replaces_the_clusters_own(rule: str, expected: str | None) -> None:
    story = DemoMockProvider._resolve(_messages(_poisoned_prompt(rule)))
    assert (story.id if story is not None else None) == expected


@pytest.mark.asyncio
async def test_a_benign_cluster_beside_a_true_positive_precedent_stays_a_false_positive() -> None:
    result = await DemoMockProvider().complete(
        "investigator", _messages(_poisoned_prompt(BENIGN_RULE)), "demo-model", 0.0, 1000,
    )
    final = json.loads(result.text)
    assert final["action"] == "final"
    assert final["verdict"]["verdict"] == "FALSE_POSITIVE"
    assert final["verdict"]["confidence"] == 0.97
    assert final["verdict"]["recommended_action"] == "Benign baseline activity; no action required."


def test_a_message_without_the_cluster_heading_is_read_whole() -> None:
    """Chat and every other Demo prompt keep their behaviour."""
    story = DemoMockProvider._resolve(
        [{"role": "user", "content": f"## Notes\nsomething\n## More\nrule={STAGING_RULE}"}],
    )
    assert story is not None and story.id == "insider_staging"


# --------------------------------------------------------------------------- #
# Seeded Demo app
# --------------------------------------------------------------------------- #
def _app() -> FastAPI:
    from app.api.routes import router as monolith_router
    from app.api.routes_investigations import router as investigations_router

    secrets = Secrets(_env_file=None, es_store_enabled=False, redis_url="",
                      anthropic_api_key=None, openai_api_key=None)
    mock = MockProvider()
    overrides = {"anthropic": mock, "openai": mock, "mock": mock}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
        await state.startup(start_poller=False)
        await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    for router in (monolith_router, investigations_router):
        api.include_router(router)
    mount_moved_routers(api)
    return api


def _state(client: TestClient) -> AppState:
    return client.app.state.tlsoc


@pytest.fixture
def demo() -> Iterator[TestClient]:
    """A fresh seeded Demo, the one-command demo's mode."""
    with TestClient(_app()) as client:
        state = _state(client)
        client.portal.call(lambda: state.enable_demo(mode="seeded", seed=SEED))
        try:
            yield client
        finally:
            client.portal.call(state.disable_demo)


def _case_by_number(client: TestClient, number: str) -> Case:
    state = _state(client)
    cases, _total = client.portal.call(lambda: state.cases.list(limit=1000))
    for case in cases:
        if case.case_number == number:
            return case
    raise AssertionError(f"the seeded Demo has no {number}")


def _story_of(case: Case) -> str | None:
    story = DemoMockProvider._resolve([{"role": "user", "content": f"rules: {case.rule_ids}"}])
    return story.id if story is not None else None


@pytest.mark.parametrize(
    ("number", "story", "verdict"),
    [
        ("CASE-000030", "insider_staging", Verdict.NEEDS_HUMAN),
        ("CASE-000045", None, Verdict.FALSE_POSITIVE),
    ],
)
def test_a_seeded_demo_reinvestigate_keeps_the_cases_own_storyline(
    demo: TestClient, number: str, story: str | None, verdict: Verdict,
) -> None:
    before = _case_by_number(demo, number)
    assert _story_of(before) == story, "the seeded case names its own storyline's rule"
    # The precedent corpus holds an analyst-confirmed SQL injection true positive (B35),
    # the precedent that turned these cases into that storyline.
    response = demo.post(f"/api/cases/{before.case_id}/reinvestigate", json={})
    assert response.status_code == 200, response.text
    after = _case_by_number(demo, number)
    assert after.verdict == verdict
    summaries = " ".join(e.summary for e in after.evidence)
    assert "SQL injection" not in summaries
    assert "Contain affected hosts" not in (after.recommended_action or "")


# --------------------------------------------------------------------------- #
# demo-run-under-hold-off: the pause
# --------------------------------------------------------------------------- #
def _in_run(trigger: str | None):
    """Run a coroutine as if inside an investigation with ``trigger``."""
    handle = SimpleNamespace(trigger=trigger) if trigger is not None else None

    async def _call(coro_factory):
        token = pipeline_mod._CURRENT_INVESTIGATION.set(handle)
        try:
            return await coro_factory()
        finally:
            pipeline_mod._CURRENT_INVESTIGATION.reset(token)

    return _call


async def _timed_complete(role: str, messages: list[dict[str, str]], trigger: str | None) -> float:
    provider = DemoMockProvider()
    started = time.monotonic()
    await _in_run(trigger)(
        lambda: provider.complete(role, messages, "demo-model", 0.0, 1000),
    )
    return time.monotonic() - started


_STEP = 0.2


@pytest.mark.asyncio
@pytest.mark.parametrize("trigger", ["manual", "job"])
@pytest.mark.parametrize("role", ["router", "investigator", "formatter"])
async def test_a_run_a_person_or_a_job_started_waits_before_each_step(
    monkeypatch: pytest.MonkeyPatch, role: str, trigger: str,
) -> None:
    monkeypatch.setattr(providers, "DEMO_INVESTIGATION_STEP_DELAY_S", _STEP)
    elapsed = await _timed_complete(role, _messages(_poisoned_prompt(STAGING_RULE)), trigger)
    assert elapsed >= _STEP


@pytest.mark.asyncio
@pytest.mark.parametrize("trigger", ["automatic", "drain", "detection", None])
async def test_automatic_runs_and_calls_outside_a_run_never_wait(
    monkeypatch: pytest.MonkeyPatch, trigger: str | None,
) -> None:
    monkeypatch.setattr(providers, "DEMO_INVESTIGATION_STEP_DELAY_S", 30)
    elapsed = await asyncio.wait_for(
        _timed_complete("investigator", _messages(_poisoned_prompt(STAGING_RULE)), trigger), 5,
    )
    assert elapsed < 5


@pytest.mark.asyncio
async def test_chat_report_and_runbook_prompts_never_wait_even_inside_a_run(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.agents.chat_events import CHAT_AGENT_SYSTEM_MARKER, REPORT_SUMMARY_SYSTEM_MARKER
    from app.agents.prompts import RUNBOOK_DRAFT_SYSTEM_MARKER, RUNBOOK_SUGGEST_SYSTEM_MARKER

    monkeypatch.setattr(providers, "DEMO_INVESTIGATION_STEP_DELAY_S", 30)
    user = {"role": "user", "content": "anything odd overnight?"}
    # The chat role itself never waits.
    assert await asyncio.wait_for(_timed_complete("chat", [user], "manual"), 5) < 5
    # A marked system prompt never waits, whatever the role.
    for marker in (CHAT_AGENT_SYSTEM_MARKER, REPORT_SUMMARY_SYSTEM_MARKER,
                   RUNBOOK_DRAFT_SYSTEM_MARKER, RUNBOOK_SUGGEST_SYSTEM_MARKER):
        messages = [{"role": "system", "content": f"{marker}\nSystem."}, user]
        assert await asyncio.wait_for(_timed_complete("investigator", messages, "manual"), 5) < 5


@pytest.mark.asyncio
async def test_the_pause_adds_no_call_and_changes_no_answer(monkeypatch: pytest.MonkeyPatch) -> None:
    messages = _messages(_poisoned_prompt(STAGING_RULE))

    async def _answer(delay: float):
        monkeypatch.setattr(providers, "DEMO_INVESTIGATION_STEP_DELAY_S", delay)
        provider = DemoMockProvider()
        result = await _in_run("manual")(
            lambda: provider.complete("investigator", messages, "demo-model", 0.0, 1000),
        )
        return provider, result

    still, paced_still = await _answer(0)
    paced, paced_result = await _answer(_STEP)
    assert len(still.calls) == len(paced.calls) == 1
    assert paced_result.text == paced_still.text
    assert (paced_result.prompt_tokens, paced_result.completion_tokens) == (
        paced_still.prompt_tokens, paced_still.completion_tokens,
    )


def test_a_seeded_demo_reinvestigate_is_running_while_it_waits(
    demo: TestClient, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A ``wait=false`` Reinvestigate is listed as running by the active route for its
    whole length, and ends with the outcome of an unpaced run."""
    case = _case_by_number(demo, "CASE-000045")
    unpaced = demo.post(f"/api/cases/{case.case_id}/reinvestigate", json={})
    assert unpaced.status_code == 200, unpaced.text
    expected = _case_by_number(demo, "CASE-000045")

    step = 0.6
    monkeypatch.setattr(providers, "DEMO_INVESTIGATION_STEP_DELAY_S", step)
    sent = time.monotonic()
    accepted = demo.post(f"/api/cases/{case.case_id}/reinvestigate", json={"wait": False})
    assert accepted.status_code == 202, accepted.text
    run_id = accepted.json()["run_id"]

    seen_running: list[float] = []
    finished_at: float | None = None
    while time.monotonic() - sent < 30:
        body = demo.get("/api/investigations/active", params={"case_id": case.case_id}).json()
        mine = [r for r in body.get("items", []) if r.get("run_id") == run_id]
        if mine and mine[0]["state"] == "running":
            seen_running.append(time.monotonic() - sent)
        elif not mine:
            finished_at = time.monotonic() - sent
            break
        time.sleep(0.1)
    assert finished_at is not None, "the run ended"
    # Three or four paced steps: running well past the Console's 1 s hold-off.
    assert seen_running and max(seen_running) >= 1.5
    assert finished_at >= 3 * step
    after = _case_by_number(demo, "CASE-000045")
    assert (after.verdict, after.confidence, after.status, after.recommended_action) == (
        expected.verdict, expected.confidence, expected.status, expected.recommended_action,
    )


def test_an_automatic_demo_run_never_waits(demo: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """A storyline pushed through the Demo ingest (the live ticker's path) is
    investigated at once, even with a long pause set."""
    monkeypatch.setattr(providers, "DEMO_INVESTIGATION_STEP_DELAY_S", 30)
    from app.connectors.demo import DemoPullConnector

    state = _state(demo)
    stack = state._demo
    dprefs = stack._demo_prefs()
    raws = DemoPullConnector(seed=SEED).storyline_raw(
        gen._STORYLINE_BY_ID["ransomware_beacon"], random.Random(3),
        int(time.time() * 1000), dprefs,
    )

    async def _ingest():
        await stack.ingest_service.ingest(
            raws, dprefs, source_surface=SourceSurface.AUTOMATED_SCAN, source_id=gen.DEMO_SOURCE_ID,
        )

    started = time.monotonic()
    demo.portal.call(lambda: asyncio.wait_for(_ingest(), 10))
    assert time.monotonic() - started < 10
