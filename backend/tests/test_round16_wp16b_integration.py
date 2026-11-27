"""Round 16 WP16B: the backend integration items of SPEC §4.6 WP16.

Each test pins one item and fails before its fix:

1. A cases-tier reset drops the cached all-time case population.
2. The chat noise funnel stamps the population's read time at all time.
3. A single sign-on role value must be a built-in role (a custom role name is 422).
4. ``POST /api/investigate`` (the Investigate page) is a manual run of the asker.
5. The whole-document case writers outside the AI run hold the case's write lock:
   the auto-close review save, the precedent ratification saves, the analyst-policy
   close and the candidate rebuild. A person's tag saved meanwhile survives each.
6. The audit context docstring no longer names the removed ``state.client_ip_from``.
7. A background job run held back by the gate's ingest headroom announces it is queued.
8. ``/rationale`` says when it read only the newest audit rows; the ``/forwarding``
   fallback answers the same keys as a reconstructed answer.
9. The cases mapping log for an unreadable template names it and the left-out inputs.
10. ``TraceSpan.kind`` names every kind the trace writes.
11. Cost figures in recorded audit text are hidden from a viewer without ``cost:view``.
12. ``PUT /api/prefs/org`` runs the Preferences validators (B45).
13. The base URL 400 hint names ``host.docker.internal``, as the Models page does.

``decide()`` and ``engine/risk.py`` are untouched (``test_round16_spine_guards.py``); no
model call is added. Offline: fake Elasticsearch, mock model.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from starlette.requests import Request

import app.api.routes as routes_mod
from app.api import metrics_shared
from app.config import AnalystRulePolicy
from app.constants import ActionType, CaseStatus, DecisionBy, EntityType, SourceSurface, Verdict
from app.engine.investigation_gate import InvestigationGate
from app.models import AuditDoc, Case, Cluster, Entity, InvestigateRequest
from app.state import AppState
from app.utils import iso_now

CASE_ID = "case-wp16b"


def _case(case_id: str = CASE_ID, **extra: Any) -> Case:
    fields: dict[str, Any] = {
        "case_id": case_id, "case_number": "CASE-0161", "cluster_signature": "sig-wp16b",
        "source_surface": SourceSurface.AUTOMATED_SCAN,
        "entity": Entity(type=EntityType.IP, value="192.0.2.161"),
        "member_event_ids": ["sig-wp16b-e1"], "rule_ids": ["linux_auth"],
        "status": CaseStatus.OPEN, "risk_score": 30.0,
        "created_at": iso_now(), "updated_at": iso_now(),
    }
    fields.update(extra)
    return Case(**fields)


def _cluster() -> Cluster:
    return Cluster(signature="sig-wp16b", entity=Entity(type=EntityType.IP, value="192.0.2.161"),
                   group_by=EntityType.IP, rule_values=["linux_auth"], risk_score=30.0,
                   member_event_ids=["sig-wp16b-e1", "sig-wp16b-e2"])


def _request(state: AppState, path: str = "/api/test") -> Request:
    api = FastAPI()
    api.state.tlsoc = state
    return Request({"type": "http", "method": "POST", "path": path, "headers": [],
                    "client": ("192.0.2.10", 443), "query_string": b"", "app": api})


async def _tag(state: AppState, case_id: str, tag: str) -> None:
    """A person's tag edit through the real route (it holds the case's write lock)."""
    stored = await state.cases.get(case_id)
    tags = list(stored.tags or []) + [tag]
    await routes_mod.case_tags(case_id, routes_mod.TagsBody(tags=tags, analyst="bob"), state=state)


def _tag_during_read(state: AppState, monkeypatch, case_id: str, *, call: int, tag: str = "person-tag"):
    """Wrap the case store's ``get`` so that its ``call``-th read starts a person's tag
    edit and returns the copy it read after the edit had a chance to run. Without a
    write lock the edit lands before the writer's save, which then erases it."""
    store = state._real_cases  # noqa: SLF001
    real_get = store.get
    seen = {"n": 0}
    tasks: list[asyncio.Task] = []

    async def get(cid, *a, **k):
        value = await real_get(cid, *a, **k)
        if cid == case_id:
            seen["n"] += 1
            if seen["n"] == call:
                tasks.append(asyncio.create_task(_tag(state, case_id, tag)))
                await asyncio.sleep(0.05)
        return value

    monkeypatch.setattr(store, "get", get)
    return tasks


def _tag_during(target: Any, name: str, state: AppState, monkeypatch, case_id: str,
                tag: str = "person-tag") -> list[asyncio.Task]:
    """Wrap the async method ``target.name`` so its first call starts a person's tag
    edit on ``case_id`` and gives it a chance to run before going on."""
    real = getattr(target, name)
    tasks: list[asyncio.Task] = []

    async def wrapped(*a, **k):
        if not tasks:
            tasks.append(asyncio.create_task(_tag(state, case_id, tag)))
            await asyncio.sleep(0.05)
        return await real(*a, **k)

    monkeypatch.setattr(target, name, wrapped)
    return tasks


# --------------------------------------------------------------------------- #
# 1. A cases-tier reset drops the cached all-time population
# --------------------------------------------------------------------------- #
async def test_a_cases_reset_drops_the_cached_all_time_population(app_state) -> None:
    from app.constants import ResetScope
    from app.engine.reset import reset_service

    await app_state.cases.save(_case("case-r1"))
    await app_state.cases.save(_case("case-r2", cluster_signature="sig-r2"))
    before = await metrics_shared.fetch_case_population(app_state.cases, span_hours=None, limit=5000)
    assert len(before.cases) == 2
    await reset_service(app_state, ResetScope.CASES)
    after = await metrics_shared.fetch_case_population(app_state.cases, span_hours=None, limit=5000)
    assert after.cases == [] and after.scope_total == 0


# --------------------------------------------------------------------------- #
# 2. The chat noise funnel says when its all-time cases were read
# --------------------------------------------------------------------------- #
async def test_the_all_time_chat_funnel_carries_the_population_read_time(app_state, monkeypatch) -> None:
    import app.engine.noise_counters as noise_mod
    from app.agents.chat_tools import metrics as metrics_module
    from app.agents.chat_tools.metrics import SocMetricsTool
    from tests.test_chat_tools_support import make_ctx

    await app_state.cases.save(_case())
    population = await metrics_shared.fetch_case_population(
        app_state.cases, span_hours=None, limit=metrics_module._POPULATION_LIMIT)  # noqa: SLF001
    assert population.generated_at
    monkeypatch.setattr(metrics_module, "iso_now", lambda: "2000-01-01T00:00:00+00:00")
    stamps: list[str] = []
    real = noise_mod.build_noise_reduction

    def spy(*a, **k):
        stamps.append(k["generated_at"])
        return real(*a, **k)

    monkeypatch.setattr(noise_mod, "build_noise_reduction", spy)
    out = await SocMetricsTool().run(make_ctx(cases=app_state.cases), kind="noise_funnel", window="all")
    assert out.ok
    assert stamps == [population.generated_at]


# --------------------------------------------------------------------------- #
# 3. Single sign-on roles are built-in roles only
# --------------------------------------------------------------------------- #
def test_a_custom_role_in_an_sso_provider_answers_422_and_a_built_in_one_provisions() -> None:
    from app.auth.oidc import OidcProvider
    from tests.test_round16_security import _app, _provider, _sso_with_a_linked_super_admin
    from tests.test_round16_security import _state as sec_state

    with TestClient(_app(rbac=True)) as c:
        _sso_with_a_linked_super_admin(c)
        made = c.post("/api/roles", json={"name": "night-shift", "grants": {"cases": ["read"]}})
        assert made.status_code == 200, made.text
        state = sec_state(c)
        before = state.prefs.sso.model_dump(mode="json")
        for over in ({"default_role": "night-shift"}, {"group_role_map": {"soc": "night-shift"}}):
            r = c.put("/api/settings", json={"sso": {"enabled": True, "providers": [_provider(**over)]}})
            assert r.status_code == 422, r.text
            assert "must be a built-in role" in r.json()["detail"]
        assert sec_state(c).prefs.sso.model_dump(mode="json") == before
        ok = c.put("/api/settings", json={"sso": {"enabled": True, "providers": [
            _provider(group_role_map={"soc": "analyst_tier2"}, auto_create_users=True)]}})
        assert ok.status_code == 200, ok.text
        provider = sec_state(c).prefs.sso.providers[0]
        role = OidcProvider(provider.model_dump(mode="json")).role_for({"groups": ["soc"]})
        assert role == "analyst_tier2"
        name, refusal = c.portal.call(
            routes_mod._provision_sso_user, state, _request(state), "corp",  # noqa: SLF001
            {"sub": "new-sub", "email": "new@corp.test", "email_verified": True}, role,
        )
        assert refusal is None and name == "new@corp.test"
        stored = c.portal.call(state.users.get, "new@corp.test")
        assert getattr(stored.role, "value", stored.role) == "analyst_tier2"


# --------------------------------------------------------------------------- #
# 4. The Investigate page asks for a manual run
# --------------------------------------------------------------------------- #
async def test_the_investigate_page_run_is_manual_and_names_who_asked(app_state, monkeypatch) -> None:
    seen: dict[str, Any] = {}

    async def fake_cluster(_state, _body, *, query_source=None):
        return _cluster(), "now-24h"

    async def fake_investigate(cluster, surface, prefs, **kwargs):
        seen.update(kwargs)
        return _case()

    monkeypatch.setattr(routes_mod, "_cluster_for_request", fake_cluster)
    monkeypatch.setattr(app_state.pipeline, "investigate_cluster", fake_investigate)
    body = InvestigateRequest(entity=Entity(type=EntityType.IP, value="192.0.2.161"))
    await routes_mod.investigate(body, state=app_state, principal=SimpleNamespace(username="alice"),
                                 request=None)
    assert seen["trigger"] == "manual"
    assert seen["requested_by"] == "alice"


# --------------------------------------------------------------------------- #
# 5. Whole-document case writers hold the case's write lock
# --------------------------------------------------------------------------- #
async def test_an_auto_close_review_keeps_a_tag_saved_while_it_writes(app_state, monkeypatch) -> None:
    from app.api.routes_auto_close_review import ReviewBody, record_auto_close_review
    from tests.test_round15_wp5_auto_close_review import _agent_closed

    await app_state.cases.save(_agent_closed(CASE_ID))
    # Read 1 is the review's check; read 2 is its re-read before the save.
    tasks = _tag_during_read(app_state, monkeypatch, CASE_ID, call=2)
    await record_auto_close_review(CASE_ID, ReviewBody(classification="false_positive"),
                                   _request(app_state), state=app_state)
    await asyncio.gather(*tasks)
    stored = await app_state.cases.get(CASE_ID)
    assert "person-tag" in stored.tags
    assert len(stored.feedback) == 1


async def test_a_precedent_ratification_keeps_a_tag_saved_after_its_candidate_was_read(
        app_state, monkeypatch) -> None:
    from app.api.routes_rag import perform_precedent_candidate

    await app_state.cases.save(_case(status=CaseStatus.CLOSED, verdict=Verdict.FALSE_POSITIVE,
                                     confidence=0.9, decision_by=DecisionBy.AGENT))
    candidate = await app_state.cases.get(CASE_ID)  # the candidate list's copy
    await _tag(app_state, CASE_ID, "person-tag")    # a person acts after the list was read

    async def index(items, **_k):
        return len(items)

    monkeypatch.setattr(app_state.rag_service, "index_precedent_items", index)
    out = await perform_precedent_candidate(candidate, {"metadata": {"outcome": "benign"}},
                                            app_state, actor="ops", batch_id="b1")
    assert out["ratified"] is True
    stored = await app_state.cases.get(CASE_ID)
    assert "person-tag" in stored.tags
    events = [e.get("event") for e in stored.history if isinstance(e, dict)]
    assert "precedent_projection_ack" in events
    assert "person-tag" in candidate.tags  # the caller's copy is what was saved


async def test_a_precedent_ratification_holds_the_case_lock_while_it_writes(app_state, monkeypatch) -> None:
    """Review (WP16B): the re-read alone is not enough. A person's tag saved between the
    ratification's read and its save must wait for the case lock, not be erased."""
    from app.api.routes_rag import perform_precedent_candidate

    await app_state.cases.save(_case(status=CaseStatus.CLOSED, verdict=Verdict.FALSE_POSITIVE,
                                     confidence=0.9, decision_by=DecisionBy.AGENT))
    candidate = await app_state.cases.get(CASE_ID)

    async def index(items, **_k):
        return len(items)

    monkeypatch.setattr(app_state.rag_service, "index_precedent_items", index)
    # Read 1 is the ratification's re-read under the lock: a person tags meanwhile.
    tasks = _tag_during_read(app_state, monkeypatch, CASE_ID, call=1)
    out = await perform_precedent_candidate(candidate, {"metadata": {"outcome": "benign"}},
                                            app_state, actor="ops", batch_id="b2")
    await asyncio.gather(*tasks)
    assert out["ratified"] is True
    stored = await app_state.cases.get(CASE_ID)
    assert "person-tag" in stored.tags
    events = [e.get("event") for e in stored.history if isinstance(e, dict)]
    assert "precedent_projection_ack" in events


def _policy_prefs(app_state):
    prefs = app_state.prefs.model_copy(deep=True)
    prefs.enrichment.enabled = False
    prefs.analyst_rule_policies = [AnalystRulePolicy(rule_id="linux_auth", reason="lab", created_by="ann")]
    return prefs


@pytest.mark.parametrize("entry", ["candidate", "investigate"])
async def test_an_analyst_policy_close_keeps_a_tag_saved_while_it_writes(app_state, monkeypatch, entry) -> None:
    await app_state.cases.save(_case())
    pipeline = app_state.pipeline
    tasks = _tag_during(pipeline, "_allocate_case_number", app_state, monkeypatch, CASE_ID)
    prefs = _policy_prefs(app_state)
    if entry == "candidate":
        case = await pipeline.register_candidate(_cluster(), SourceSurface.AUTOMATED_SCAN, prefs)
    else:
        case = await pipeline.investigate_cluster(_cluster(), SourceSurface.AUTOMATED_SCAN, prefs)
    await asyncio.gather(*tasks)
    assert case.decision_by == DecisionBy.ANALYST_POLICY
    stored = await app_state.cases.get(CASE_ID)
    assert stored.status == CaseStatus.CLOSED and stored.decision_by == DecisionBy.ANALYST_POLICY
    assert "person-tag" in stored.tags


async def test_a_candidate_rebuild_keeps_a_tag_saved_while_it_writes(app_state, monkeypatch) -> None:
    await app_state.cases.save(_case())
    pipeline = app_state.pipeline
    tasks = _tag_during(pipeline, "_allocate_case_number", app_state, monkeypatch, CASE_ID)
    prefs = app_state.prefs.model_copy(deep=True)
    case = await pipeline.register_candidate(_cluster(), SourceSurface.AUTOMATED_SCAN, prefs,
                                             awaiting_reason="below the floor")
    await asyncio.gather(*tasks)
    assert case.case_id == CASE_ID and case.verdict is None
    stored = await app_state.cases.get(CASE_ID)
    assert "person-tag" in stored.tags
    assert "sig-wp16b-e2" in stored.member_event_ids
    assert not app_state.case_lock(CASE_ID).locked()


async def test_a_person_who_took_the_case_meanwhile_wins_over_a_policy_close(app_state, monkeypatch) -> None:
    """The analyst-policy close re-reads the case under the lock: a person's escalation
    made after the first read wins, and the cluster is handled as their case."""
    await app_state.cases.save(_case())
    pipeline = app_state.pipeline
    real = pipeline._latest_stored_case  # noqa: SLF001

    async def latest(case_id, existing):
        stored = await app_state.cases.get(case_id)
        stored.decision_by = DecisionBy.ANALYST
        stored.status = CaseStatus.ESCALATED
        await app_state.cases.save(stored)
        return await real(case_id, existing)

    monkeypatch.setattr(pipeline, "_latest_stored_case", latest)
    case = await pipeline.register_candidate(_cluster(), SourceSurface.AUTOMATED_SCAN, _policy_prefs(app_state))
    assert case.decision_by == DecisionBy.ANALYST and case.status == CaseStatus.ESCALATED
    assert not app_state.case_lock(CASE_ID).locked()


# --------------------------------------------------------------------------- #
# 6. The audit context docstring
# --------------------------------------------------------------------------- #
def test_the_audit_context_docstring_names_no_removed_helper() -> None:
    import app.audit.context as context_mod

    assert "client_ip_from" not in (context_mod.__doc__ or "")
    assert not hasattr(AppState, "client_ip_from")


# --------------------------------------------------------------------------- #
# 7. A background run held back by the ingest headroom is announced queued
# --------------------------------------------------------------------------- #
async def test_the_gate_says_a_background_caller_would_wait_for_the_headroom() -> None:
    gate = InvestigationGate()
    assert gate.would_wait(2, "background") is False
    async with gate.permit(2, "background"):
        assert gate.active == 1
        assert gate.would_wait(2, "background") is True   # the one background slot is taken
        assert gate.would_wait(2, "ingest") is False       # ingest keeps its headroom
        async with gate.permit(2, "ingest"):
            assert gate.would_wait(2, "ingest") is True


class _Bus:
    def __init__(self) -> None:
        self.frames: list[dict[str, Any]] = []

    def publish_many(self, topics, event_type, data, *, audience=None, retain=True):
        self.frames.append(dict(data))
        return str(len(self.frames))

    def publish(self, *_a, **_k):
        return "x"


async def test_a_background_job_run_waiting_for_the_headroom_sends_a_queued_frame(app_state, monkeypatch) -> None:
    import app.agents.pipeline as pipeline_mod
    from app.models import VerdictResult

    bus = _Bus()
    monkeypatch.setattr(app_state.investigation_registry, "_bus_getter", lambda: bus)

    async def verdict(*_a, **_k):
        return VerdictResult(verdict=Verdict.NEEDS_HUMAN, confidence=0.3, recommended_action="look"), 0.0

    monkeypatch.setattr(pipeline_mod, "run_investigation", verdict)
    await app_state.cases.save(_case())
    prefs = app_state.prefs.model_copy(deep=True)
    prefs.enrichment.enabled = False
    prefs.caps.max_concurrent = 2
    gate = app_state.investigation_gate
    async with gate.permit(2, "background"):
        task = asyncio.create_task(app_state.pipeline.investigate_cluster(
            _cluster(), SourceSurface.AUTOMATED_SCAN, prefs, force=True,
            investigation_priority="background", trigger="job",
        ))
        for _ in range(200):
            if app_state.investigation_registry.active():
                break
            await asyncio.sleep(0.01)
        await asyncio.sleep(0.02)
        active = app_state.investigation_registry.active()
        waiting = active[0].state if active else None
        frames_while_waiting = [f["state"] for f in bus.frames]
    await task  # the permit is released: the run starts and ends
    assert waiting == "queued"
    assert frames_while_waiting == ["queued"]
    assert bus.frames[-1]["state"] == "finished"


# --------------------------------------------------------------------------- #
# 8. /rationale row totals and the /forwarding fallback keys
# --------------------------------------------------------------------------- #
async def test_the_rationale_says_when_it_read_only_the_newest_rows(app_state, monkeypatch) -> None:
    await app_state.cases.save(_case())
    for i in range(2):
        await app_state.audit.write(AuditDoc(case_id=CASE_ID, actor="router",
                                             action_type=ActionType.PROMPT, result_summary=f"r{i}"))

    async def count(case_id, *, cap):
        return 750, "eq"

    monkeypatch.setattr(app_state.audit, "count_for_case", count)
    body = await routes_mod.case_rationale(CASE_ID, state=app_state, _=None, request=None)
    assert body["returned"] == 2
    assert body["rows_total"] == 750 and body["rows_total_relation"] == "eq"
    assert body["truncated"] is True


async def test_the_forwarding_fallback_answers_the_reconstructed_keys(app_state, monkeypatch) -> None:
    async def no_cluster(*_a, **_k):
        return None

    monkeypatch.setattr(routes_mod, "_cluster_for_case", no_cluster)
    await app_state.cases.save(_case())
    body = await routes_mod.case_forwarding(CASE_ID, state=app_state, _=None)
    assert body["gate"] == "unknown"
    assert body["routing_total"] is None and body["risk_floor"] is None
    assert body["routing_gate_applied"] is False


# --------------------------------------------------------------------------- #
# 9. The cases mapping log names the template and the left-out inputs
# --------------------------------------------------------------------------- #
async def test_an_unreadable_cases_template_is_named_in_the_log(caplog) -> None:
    import app.es.indices as indices_mod
    from tests.test_factory_storage_primitives import _HTTPError
    from tests.test_round16_wp15b_spine import _shipped_client

    from app.constants import CASES_INDEX

    live = {f"{CASES_INDEX}-000001": {"mappings": {"properties": {}}}}
    client, _mgmt = _shipped_client(template_exists=True, index_exists=True, live=live,
                                    template_error=_HTTPError(403))
    with caplog.at_level(logging.WARNING, logger="tlsoc.es.indices"):
        assert await indices_mod.extend_cases_mapping(client) == "unsupported"
    text = " ".join(r.getMessage() for r in caplog.records)
    assert f"{CASES_INDEX}-template" in text
    assert "recorded risk inputs are left out of stored cases" in text


# --------------------------------------------------------------------------- #
# 10. TraceSpan.kind names every kind
# --------------------------------------------------------------------------- #
def test_the_trace_span_kind_comment_names_every_kind() -> None:
    from app.models import TraceSpan

    source = inspect.getsource(TraceSpan)
    comment = source.split("kind: str", 1)[0].rsplit("step_index", 1)[1]
    for kind in ("invoke_agent", "chat", "execute_tool", "decision", "person", "system"):
        assert kind in comment, kind


# --------------------------------------------------------------------------- #
# 11. Cost figures in audit text follow cost:view
# --------------------------------------------------------------------------- #
_COST_ROWS = (
    AuditDoc(case_id="case-spend-1", actor="pipeline", action_type=ActionType.ERROR,
             result_summary="investigation timed out after 120s; capped to NEEDS_HUMAN (partial cost=0.0213)"),
    AuditDoc(case_id="case-spend-1", actor="analyst", action_type=ActionType.PROMPT,
             result_summary="runbook draft model call tokens=40 cost=0.004000"),
    AuditDoc(case_id="case-spend-1", actor="pipeline", action_type=ActionType.ERROR,
             result_summary=("pipeline error: budget ceiling exceeded: daily spend $1.2345 + est $0.0100 "
                             "would exceed the $10.00 daily ceiling")),
    AuditDoc(case_id="case-spend-1", actor="case_manager", action_type=ActionType.DECISION,
             result_summary="verdict=TRUE_POSITIVE status=needs_human risk=40.0 cost=0.0213 confidence=0.9"),
)


def _cost_texts(client: TestClient) -> list[str]:
    timeline = client.get("/api/cases/case-spend-1/timeline")
    assert timeline.status_code == 200, timeline.text
    texts = []
    for span in timeline.json()["spans"]:
        texts.append(span.get("summary") or "")
        texts.append((span.get("detail") or {}).get("result_summary") or "")
    trace = client.get("/api/cases/case-spend-1/trace")
    assert trace.status_code == 200, trace.text
    texts += [step.get("result_summary") or "" for step in trace.json()["steps"]]
    rationale = client.get("/api/cases/case-spend-1/rationale")
    assert rationale.status_code == 200, rationale.text
    texts.append(rationale.json()["decision_rationale"] or "")
    return texts


def _seed_cost_rows(client: TestClient) -> None:
    state = client.app.state.tlsoc
    for row in _COST_ROWS:
        client.portal.call(state.audit.write, row.model_copy())


def test_cost_figures_in_audit_text_are_hidden_without_cost_view() -> None:
    from tests.test_spend_gates import T1, _client, _sign_in_as

    with _client(denies={"cost": ["view"]}) as client:
        _sign_in_as(client, T1)
        _seed_cost_rows(client)
        joined = " | ".join(_cost_texts(client))
        assert "partial cost=hidden" in joined
        assert "cost=hidden" in joined and "(amount hidden)" in joined
        for figure in ("0.0213", "0.004000", "$1.2345", "$10.00"):
            assert figure not in joined, figure


def test_cost_figures_in_audit_text_stay_with_cost_view() -> None:
    from tests.test_spend_gates import T1, _client, _sign_in_as

    with _client() as client:
        _sign_in_as(client, T1)
        _seed_cost_rows(client)
        joined = " | ".join(_cost_texts(client))
        for figure in ("partial cost=0.0213", "cost=0.004000", "$1.2345", "cost=0.0213"):
            assert figure in joined, figure


def test_the_cost_text_helper_leaves_other_text_alone() -> None:
    from app.api.cost_text import withhold_cost_text, withhold_row_cost_text

    assert withhold_cost_text(None) is None
    assert withhold_cost_text("risk=40 confidence=0.9") == "risk=40 confidence=0.9"
    assert withhold_cost_text("cost=1e-05 and $3") == "cost=hidden and (amount hidden)"
    # Only a spend writer's row is changed; a tool or verdict row is evidence.
    assert withhold_row_cost_text(ActionType.ERROR, "partial cost=0.5") == "partial cost=hidden"
    assert withhold_row_cost_text("tool_call", "awk '{print $1}'") == "awk '{print $1}'"
    assert withhold_row_cost_text(ActionType.VERDICT, "paid $5") == "paid $5"


# Review (WP16B): evidence that holds a ``$`` or ``cost=`` must read as it was recorded.
_EVIDENCE_TOOL_OUTPUT = "process.command_line=awk '{print $1}' /etc/passwd; wire amount=$5000 cost=3"
_EVIDENCE_REASONING = "verdict=TRUE_POSITIVE reasoning=the attacker ran awk '{print $2}' twice"


def _seed_evidence_rows(client: TestClient) -> None:
    state = client.app.state.tlsoc
    for row in (
        AuditDoc(case_id="case-spend-1", actor="investigator", action_type=ActionType.TOOL_CALL,
                 tool_name="es_query", tool_output_summary=_EVIDENCE_TOOL_OUTPUT),
        AuditDoc(case_id="case-spend-1", actor="investigator", action_type=ActionType.VERDICT,
                 result_summary=_EVIDENCE_REASONING),
    ):
        client.portal.call(state.audit.write, row)


def test_tool_output_and_verdict_text_are_never_rewritten_without_cost_view() -> None:
    from tests.test_spend_gates import T1, _client, _sign_in_as

    with _client(denies={"cost": ["view"]}) as client:
        _sign_in_as(client, T1)
        _seed_cost_rows(client)
        _seed_evidence_rows(client)
        timeline = client.get("/api/cases/case-spend-1/timeline").json()["spans"]
        outputs = [(s.get("detail") or {}).get("tool_output_summary") for s in timeline]
        assert _EVIDENCE_TOOL_OUTPUT in outputs
        texts = [s.get("summary") for s in timeline]
        texts += [(s.get("detail") or {}).get("result_summary") for s in timeline]
        assert _EVIDENCE_REASONING in texts
        steps = client.get("/api/cases/case-spend-1/trace").json()["steps"]
        assert _EVIDENCE_TOOL_OUTPUT in [s.get("tool_output_summary") for s in steps]
        assert _EVIDENCE_REASONING in [s.get("result_summary") for s in steps]
        # The spend rows are still withheld.
        joined = " | ".join(str(t) for t in texts if t)
        assert "partial cost=hidden" in joined and "0.0213" not in joined


def _client_with_activity(**kwargs: Any) -> TestClient:
    from fastapi import Depends

    from app.api.deps import require_auth
    from app.api.routes_cases_collab import router as collab_router
    from tests.test_spend_gates import _client

    client = _client(**kwargs)
    client.app.include_router(collab_router, dependencies=[Depends(require_auth)])
    return client


@pytest.mark.parametrize("denied", [True, False])
def test_the_case_activity_feed_follows_cost_view(denied: bool) -> None:
    from tests.test_spend_gates import T1, _sign_in_as

    with _client_with_activity(denies={"cost": ["view"]} if denied else None) as client:
        _sign_in_as(client, T1)
        _seed_cost_rows(client)
        _seed_evidence_rows(client)
        r = client.get("/api/cases/case-spend-1/activity")
        assert r.status_code == 200, r.text
        summaries = [item.get("summary") or "" for item in r.json()["activity"]]
        joined = " | ".join(summaries)
        assert _EVIDENCE_TOOL_OUTPUT in summaries and _EVIDENCE_REASONING in summaries
        if denied:
            assert "partial cost=hidden" in joined and "(amount hidden)" in joined
            for figure in ("0.0213", "0.004000", "$1.2345", "$10.00"):
                assert figure not in joined, figure
        else:
            for figure in ("partial cost=0.0213", "cost=0.004000", "$1.2345"):
                assert figure in joined, figure


@pytest.mark.parametrize("cost_view", [True, False])
async def test_chat_case_rationale_follows_cost_view(app_state, cost_view: bool) -> None:
    from app.agents.chat_tools.cases import GetCaseTool
    from app.agents.chat_tools.registry import catalogue_grant_pairs
    from tests.test_chat_tools_support import RecordingAudit, make_ctx

    await app_state.cases.save(_case(verdict=Verdict.TRUE_POSITIVE, confidence=0.9,
                                     status=CaseStatus.NEEDS_HUMAN))
    rows = [{"case_id": CASE_ID, "ts": iso_now(), "actor": "case_manager",
             "action_type": ActionType.DECISION.value,
             "result_summary": "verdict=TRUE_POSITIVE status=needs_human risk=30.0 cost=0.0213"}]
    grants = catalogue_grant_pairs()
    if not cost_view:
        grants = frozenset(g for g in grants if g != ("cost", "view"))
    ctx = make_ctx(cases=app_state.cases, audit=RecordingAudit(rows), grants=grants)
    out = await GetCaseTool().run(ctx, case_id=CASE_ID, include=["rationale"])
    text = out.observation["rationale"]["decision_rationale"]
    assert ("cost=0.0213" in text) is cost_view
    assert ("cost=hidden" in text) is (not cost_view)


# --------------------------------------------------------------------------- #
# 12. PUT /api/prefs/org runs the Preferences validators
# --------------------------------------------------------------------------- #
def test_the_org_customization_write_never_stores_a_legacy_theme(client) -> None:
    state = client.app.state.tlsoc
    assert state.prefs.branding.default_theme == "dark"
    r = client.put("/api/prefs/org", json={"default_theme": "light", "terminology": {"case": "incident"}})
    assert r.status_code == 200, r.text
    assert r.json()["default_theme"] == "system"
    assert state.prefs.customization.default_theme == "system"
    assert state.prefs.customization.terminology == {"case": "incident"}
    assert state.prefs.branding.default_theme == "light"  # moved into Branding, once


# --------------------------------------------------------------------------- #
# 13. The base URL hint
# --------------------------------------------------------------------------- #
def test_the_base_url_hint_names_the_host_the_backend_container_reaches() -> None:
    from app.api.routes_models import _validate_base_url

    with pytest.raises(HTTPException) as caught:
        _validate_base_url("ftp://models.example")
    assert caught.value.status_code == 400
    assert "http://host.docker.internal:4000/v1" in caught.value.detail
    assert "localhost" not in caught.value.detail
