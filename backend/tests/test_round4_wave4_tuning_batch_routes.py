"""Round 4 / Wave 4 — tuning + batch feature routers (offline, fake ES + mock LLM).

Locks the two Wave-4 read/write routers so they cannot regress:

* ``routes_tuning`` — recommendations (per-rule noise + proposed change, DRY-RUN),
  config get/put, per-rule apply (audits an ``ActionType.TUNING`` record + moves the
  live threshold), rollback, and the SAFE rail: a shadow-blocked raise (would hide a
  confirmed TP) is routed to the HITL Proposal queue — NEVER auto-applied.
* ``routes_batch`` — read-only list / get of durable batch jobs (secret-free, bounded).

Also proves the deny-by-default authZ rail: a non-GET route on the tuning router is
401'd when auth is ON and no token is presented.

NON-NEGOTIABLES exercised: #2 (apply/rollback write an append-only ``ActionType.TUNING``
audit row), #3 (a DROP/shadow-blocked change never auto-applies — it becomes a
Proposal; nothing calls ``decide()``), #9 (bodies are plain data). Fully network-free.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.api.deps import require_auth
from app.api.routes_batch import router as batch_router
from app.api.routes_tuning import router as tuning_router
from app.config import Secrets, ThresholdTuningConfig
from app.constants import (
    ActionType,
    BatchJobState,
    CaseStatus,
    Disposition,
    EntityType,
    SourceSurface,
    Verdict,
)
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.models import BatchJob, Case, Entity, FeedbackEntry, TriggerReason
from app.state import AppState

_ENT = Entity(type=EntityType.IP, value="203.0.113.9")
_TUNE_CFG = ThresholdTuningConfig(
    enabled=True, min_samples=3, fp_rate_target=0.3, max_n_step=1, shadow_eval=True,
    auto_apply_confirmed=True,
)


def _fp_case(i: int, rule: str = "noisy_rule") -> Case:
    return Case(
        case_id=f"fp-{rule}-{i:04d}", cluster_signature=f"sig-fp-{rule}-{i}",
        source_surface=SourceSurface.AUTOMATED_SCAN, entity=_ENT, rule_ids=[rule],
        verdict=Verdict.FALSE_POSITIVE, disposition=Disposition.FALSE_POSITIVE,
        status=CaseStatus.CLOSED,
        feedback=[FeedbackEntry(analyst="analyst", actual_outcome="false_positive")],
    )


def _tp_case(rule: str = "noisy_rule", observed: int = 2) -> Case:
    """A confirmed TRUE_POSITIVE whose observed member count is below the raised n, so
    shadow-eval would hide it → the raise must NOT auto-apply (routes to a Proposal)."""
    return Case(
        case_id=f"tp-{rule}", cluster_signature=f"sig-tp-{rule}",
        source_surface=SourceSurface.AUTOMATED_SCAN, entity=_ENT, rule_ids=[rule],
        verdict=Verdict.TRUE_POSITIVE, disposition=Disposition.TRUE_POSITIVE,
        status=CaseStatus.CLOSED, member_event_ids=[f"e{n}" for n in range(observed)],
        trigger_reason=TriggerReason(observed_count=observed),
        feedback=[FeedbackEntry(analyst="analyst", actual_outcome="true_positive")],
    )


async def _seed_noisy(state: AppState, *, rule: str = "noisy_rule", n_fp: int = 5) -> None:
    for i in range(n_fp):
        await state.cases.save(_fp_case(i, rule))


# --------------------------------------------------------------------------- #
# Harness — auth OFF (the default) so we exercise the routes directly.
# --------------------------------------------------------------------------- #
@pytest.fixture
def state_and_client():
    holder: dict[str, Any] = {}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        secrets = Secrets(
            _env_file=None, es_store_enabled=False, redis_url="",
            anthropic_api_key=None, openai_api_key=None,
        )
        mock = MockProvider()
        overrides = {"anthropic": mock, "openai": mock, "mock": mock}
        state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
        await state.startup(start_poller=False)
        prefs = state.prefs.model_copy(update={"setup_complete": True, "threshold_tuning": _TUNE_CFG})
        await state.update_prefs(prefs)
        app.state.tlsoc = state
        holder["state"] = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(tuning_router, dependencies=[Depends(require_auth)])
    api.include_router(batch_router, dependencies=[Depends(require_auth)])
    with TestClient(api) as client:
        yield holder["state"], client


# --------------------------------------------------------------------------- #
# routes_tuning — recommendations (DRY-RUN)
# --------------------------------------------------------------------------- #
def test_recommendations_report_noise_and_proposed_change(state_and_client) -> None:
    state, client = state_and_client
    # Seed the noisy rule via the TestClient's own loop portal.
    _run(client, _seed_noisy(state))

    r = client.get("/api/tuning/recommendations")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["enabled"] is True
    assert body["window_cases"] >= 5
    # The noisy rule shows in rule_noise, over target.
    noise = {row["rule_id"]: row for row in body["rule_noise"]}
    assert "noisy_rule" in noise
    assert noise["noisy_rule"]["over_target"] is True
    # And a bounded correlation_n raise is proposed for it (DRY-RUN — nothing applied).
    recos = {p["rule_id"]: p for p in body["recommendations"]}
    assert "noisy_rule" in recos
    assert recos["noisy_rule"]["kind"] == "correlation_n"
    assert recos["noisy_rule"]["after"] == recos["noisy_rule"]["before"] + 1
    assert recos["noisy_rule"]["auto_apply"] is True
    # The ledger is empty (a dry-run wrote nothing).
    assert body["applied"] == []
    assert body["history_status"] == "available"
    assert body["history_count"] == 0


def test_recommendations_and_manual_apply_share_current_window_guard(
    state_and_client,
) -> None:
    """A manual first apply must disappear from both preview and repeat apply.

    The scheduler already held this once-per-window rail; the API must not advertise
    or process a second bump over the same unchanged analyst evidence.
    """
    state, client = state_and_client
    _run(client, _seed_noisy(state))

    first = client.post("/api/tuning/noisy_rule/apply")
    assert first.status_code == 200, first.text
    assert len(first.json()["applied"]) == 1

    preview = client.get("/api/tuning/recommendations")
    assert preview.status_code == 200, preview.text
    assert not any(
        row["rule_id"] == "noisy_rule"
        for row in preview.json()["recommendations"]
    )
    repeated = client.post("/api/tuning/noisy_rule/apply")
    assert repeated.status_code == 404


def test_tuning_history_outage_is_503_not_false_empty(
    state_and_client, monkeypatch,
) -> None:
    state, client = state_and_client
    _run(client, _seed_noisy(state))

    async def unavailable(*_args, **_kwargs):
        raise RuntimeError("ledger unavailable")

    monkeypatch.setattr(state.tuning_store, "list_strict", unavailable)
    preview = client.get("/api/tuning/recommendations")
    assert preview.status_code == 503
    assert "Tuning history is temporarily unavailable" in preview.json()["detail"]

    applied = client.post("/api/tuning/noisy_rule/apply")
    assert applied.status_code == 503
    assert "manual apply were not computed" in applied.json()["detail"]


# --------------------------------------------------------------------------- #
# routes_tuning — config get/put
# --------------------------------------------------------------------------- #
def test_config_get_and_put_roundtrip(state_and_client) -> None:
    state, client = state_and_client
    r0 = client.get("/api/tuning/config")
    assert r0.status_code == 200
    assert r0.json()["config"]["enabled"] is True

    r1 = client.put("/api/tuning/config", json={
        "enabled": False, "min_samples": 10, "fp_rate_target": 0.25,
        "max_n_step": 2, "cadence": "weekly", "shadow_eval": False,
    })
    assert r1.status_code == 200, r1.text
    cfg = r1.json()["config"]
    assert cfg["enabled"] is False and cfg["min_samples"] == 10 and cfg["cadence"] == "weekly"
    # Persisted onto live prefs.
    assert state.prefs.threshold_tuning.enabled is False
    assert state.prefs.threshold_tuning.max_n_step == 2


def test_config_rejects_auto_apply_without_shadow_evaluation(state_and_client) -> None:
    _state, client = state_and_client
    response = client.put("/api/tuning/config", json={
        "enabled": True,
        "shadow_eval": False,
        "auto_apply_confirmed": True,
    })
    assert response.status_code == 422
    assert "auto_apply_confirmed requires shadow_eval" in response.text


# --------------------------------------------------------------------------- #
# routes_tuning — apply auto-applies + audits an ActionType.TUNING record
# --------------------------------------------------------------------------- #
def test_apply_auto_applies_and_audits_tuning(state_and_client) -> None:
    state, client = state_and_client
    _run(client, _seed_noisy(state))
    before_n = state.prefs.correlation_for("noisy_rule").n

    r = client.post("/api/tuning/noisy_rule/apply")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True and body["rule_id"] == "noisy_rule"
    assert len(body["applied"]) == 1
    assert body["queued_proposals"] == []
    rec = body["applied"][0]
    assert rec["target"] == "correlation_n" and rec["after"] == before_n + 1

    # The live threshold moved (the tuner is a config-writer only).
    assert state.prefs.correlation_for("noisy_rule").n == before_n + 1
    # A TUNING record is in the ledger.
    ledger = _run(client, state.tuning_store.list())
    assert any(e.target == "correlation_n" and not e.rolled_back for e in ledger)
    # #2 — an ActionType.TUNING audit row was written.
    rows = _run(client, state._real_audit.records(action_type=ActionType.TUNING.value))
    assert rows, "an ActionType.TUNING audit row must be written on apply"
    assert any("tuning_apply" in (r.get("result_summary") or "") for r in rows)


def test_apply_ledger_outage_compensates_and_reports_503(
    state_and_client, monkeypatch,
) -> None:
    state, client = state_and_client
    _run(client, _seed_noisy(state))
    before_n = state.prefs.correlation_for("noisy_rule").n
    async def unavailable(_records):  # noqa: ANN001
        raise RuntimeError("ledger unavailable")

    monkeypatch.setattr(state.tuning_store, "add_many_strict", unavailable)
    response = client.post("/api/tuning/noisy_rule/apply")

    assert response.status_code == 503
    assert "no success was reported" in response.json()["detail"]
    assert state.prefs.correlation_for("noisy_rule").n == before_n
    assert _run(client, state.tuning_store.list_strict(active_only=True)) == []


# --------------------------------------------------------------------------- #
# routes_tuning — a shadow-blocked change goes to Proposals, NOT auto-applied (#3)
# --------------------------------------------------------------------------- #
def test_shadow_blocked_change_becomes_a_proposal_not_auto_applied(state_and_client) -> None:
    state, client = state_and_client
    _run(client, _seed_noisy(state))
    # Add a confirmed TP the raise would hide → shadow-eval forces review.
    _run(client, state.cases.save(_tp_case(observed=2)))
    before_n = state.prefs.correlation_for("noisy_rule").n

    r = client.post("/api/tuning/noisy_rule/apply")
    assert r.status_code == 200, r.text
    body = r.json()
    # NOTHING auto-applied; the change was queued to the HITL Proposal queue.
    assert body["applied"] == []
    assert "noisy_rule" in body["shadow_blocked"]
    assert len(body["queued_proposals"]) == 1
    # The live threshold is UNCHANGED (never auto-applied a DROP/shadow-blocked raise).
    assert state.prefs.correlation_for("noisy_rule").n == before_n
    # The proposal is visible in the store as pending (linked via /api/proposals).
    proposals = _run(client, state.proposals.list(status="pending"))
    assert any(p.payload.get("tuning") for p in proposals)


# --------------------------------------------------------------------------- #
# routes_tuning — apply then rollback restores the threshold
# --------------------------------------------------------------------------- #
def test_rollback_restores_prior_threshold(state_and_client) -> None:
    state, client = state_and_client
    _run(client, _seed_noisy(state))
    before_n = state.prefs.correlation_for("noisy_rule").n
    assert client.post("/api/tuning/noisy_rule/apply").status_code == 200
    assert state.prefs.correlation_for("noisy_rule").n == before_n + 1

    r = client.post("/api/tuning/noisy_rule/rollback")
    assert r.status_code == 200, r.text
    assert r.json()["ok"] is True
    # Restored.
    assert state.prefs.correlation_for("noisy_rule").n == before_n
    # A second rollback finds no active record → 404.
    assert client.post("/api/tuning/noisy_rule/rollback").status_code == 404


def test_rollback_ledger_outage_is_503_not_a_false_404(
    state_and_client, monkeypatch,
) -> None:
    state, client = state_and_client
    _run(client, _seed_noisy(state))
    assert client.post("/api/tuning/noisy_rule/apply").status_code == 200

    async def unavailable(*_args, **_kwargs):
        raise RuntimeError("ledger unavailable")

    monkeypatch.setattr(state.tuning_store, "list_strict", unavailable)
    response = client.post("/api/tuning/noisy_rule/rollback")
    assert response.status_code == 503
    assert response.json()["detail"] == "Tuning rollback ledger is temporarily unavailable"


def test_apply_unknown_rule_is_404(state_and_client) -> None:
    state, client = state_and_client
    assert client.post("/api/tuning/does_not_exist/apply").status_code == 404


# --------------------------------------------------------------------------- #
# routes_batch — read-only list / get
# --------------------------------------------------------------------------- #
def test_batch_jobs_list_and_get(state_and_client) -> None:
    state, client = state_and_client
    job = BatchJob(
        provider="anthropic", provider_batch_id="msgbatch_abc",
        state=BatchJobState.SUBMITTED, model="claude-3-5-haiku",
        custom_ids={"c1": {"retrieved": True}, "c2": {"retrieved": False}},
        submitted_at="2026-07-01T00:00:00+00:00",
    )
    _run(client, state.batch_job_store.save(job))

    r = client.get("/api/batch/jobs")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["count"] == 1
    row = body["jobs"][0]
    assert row["id"] == job.id and row["provider"] == "anthropic"
    assert row["requests"] == 2 and row["retrieved"] == 1
    assert row["state"] == "submitted"

    one = client.get(f"/api/batch/jobs/{job.id}")
    assert one.status_code == 200
    assert one.json()["job"]["id"] == job.id
    # Unknown → 404.
    assert client.get("/api/batch/jobs/nope").status_code == 404


def test_batch_jobs_preserve_terminal_aggregate_counts_after_compaction(
    state_and_client,
) -> None:
    state, client = state_and_client
    job = BatchJob(
        provider="openai",
        provider_batch_id="batch_terminal",
        state=BatchJobState.RETRIEVED,
        model="gpt-test",
        custom_ids={
            "c1": {"retrieved": True, "result_state": "succeeded"},
            "c2": {"retrieved": True, "result_state": "errored"},
        },
        submitted_at="2026-07-02T00:00:00+00:00",
    )
    stored = _run(client, state.batch_job_store.save(job))
    assert stored.terminal_compacted is True
    assert stored.custom_ids == {}

    response = client.get("/api/batch/jobs")
    assert response.status_code == 200, response.text
    row = response.json()["jobs"][0]
    assert row["requests"] == 2
    assert row["retrieved"] == 2


def test_batch_registry_outage_is_503_not_empty_or_not_found(
    state_and_client, monkeypatch,
) -> None:
    state, client = state_and_client

    async def unavailable(*_args, **_kwargs):
        raise RuntimeError("store offline")

    monkeypatch.setattr(state.batch_job_store, "list_strict", unavailable)
    listed = client.get("/api/batch/jobs")
    assert listed.status_code == 503
    assert listed.json()["detail"] == "batch job registry unavailable"

    monkeypatch.setattr(state.batch_job_store, "get_strict", unavailable)
    detail = client.get("/api/batch/jobs/job-1")
    assert detail.status_code == 503
    assert detail.json()["detail"] == "batch job registry unavailable"


# --------------------------------------------------------------------------- #
# deny-by-default authZ — a non-GET tuning route is 401'd with auth ON, no token.
# --------------------------------------------------------------------------- #
def test_non_get_route_rejected_when_auth_on_without_token() -> None:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        secrets = Secrets(
            _env_file=None, es_store_enabled=False, redis_url="",
            anthropic_api_key=None, openai_api_key=None,
            auth_enabled=True, auth_jwt_secret="w4-tuning-secret",
        )
        mock = MockProvider()
        overrides = {"anthropic": mock, "openai": mock, "mock": mock}
        state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
        await state.startup(start_poller=False)
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(tuning_router, dependencies=[Depends(require_auth)])
    api.include_router(batch_router, dependencies=[Depends(require_auth)])
    with TestClient(api) as client:
        # No cookie / bearer → 401 on a state-changer AND a read.
        assert client.put("/api/tuning/config", json={"enabled": True}).status_code == 401
        assert client.post("/api/tuning/r/apply").status_code == 401
        assert client.get("/api/batch/jobs").status_code == 401


# --------------------------------------------------------------------------- #
# Both routers pass the route-auth-coverage discipline once mounted in the real app.
# (The full CI test walks app.main.app; here we assert the local invariants directly.)
# --------------------------------------------------------------------------- #
def test_every_non_get_route_carries_an_authz_gate() -> None:
    from fastapi.routing import APIRoute

    _AUTHZ = {
        "require_permission.<locals>._dep", "require_role.<locals>._dep",
        "require_fresh_auth.<locals>._dep", "require_admin",
    }

    def _calls(dependant) -> set:
        out = set()
        for dep in dependant.dependencies:
            if dep.call is not None:
                out.add(dep.call)
            out |= _calls(dep)
        return out

    for r in (*tuning_router.routes, *batch_router.routes):
        if not isinstance(r, APIRoute):
            continue
        if "GET" in r.methods and r.methods <= {"GET", "HEAD"}:
            continue  # reads need only require_auth (mounted by the integrator)
        gated = any(
            getattr(c, "__module__", "") == "app.api.deps"
            and getattr(c, "__qualname__", "") in _AUTHZ
            for c in _calls(r.dependant)
        )
        assert gated, f"non-GET route lacks an authZ gate: {sorted(r.methods)} {r.path}"


# --------------------------------------------------------------------------- #
# Helpers — run a coroutine on the TestClient's own loop (via its portal).
# --------------------------------------------------------------------------- #
def _run(client: TestClient, coro):
    return client.portal.call(lambda: coro)  # type: ignore[attr-defined]


def test_recommendations_explain_an_inert_correlation_n_rule(state_and_client) -> None:
    """A rule over target with no correlation_n recommendation must say WHY.

    Silence is what made the reported defect invisible: the tuner kept "applying"
    correlation_n raises that an alerts-role feed discards on every poll, so the FP
    rate never moved and the same rules were re-drafted forever. The dry-run must
    surface the structural reason instead of just omitting the recommendation.
    """
    from app.config import CorrelationMode, CorrelationRule

    state, client = state_and_client
    _run(client, _seed_noisy(state))

    # Configure the noisy rule as EVERY — mode=EVERY never consults n, so a raise is
    # dead configuration exactly as the alerts-role override makes it.
    state.prefs.correlation_rules["noisy_rule"] = CorrelationRule(
        mode=CorrelationMode.EVERY, n=1
    )

    body = client.get("/api/tuning/recommendations").json()
    noise = {row["rule_id"]: row for row in body["rule_noise"]}
    row = noise["noisy_rule"]
    assert row["over_target"] is True
    assert row["correlation_n_inert"] is True
    assert row["correlation_n_inert_reason"] == "correlation_mode_every"
    assert "never consults n" in row["correlation_n_inert_detail"]

    # ...and no correlation_n recommendation is offered for it.
    recos = {p["rule_id"]: p for p in body["recommendations"]}
    assert recos.get("noisy_rule", {}).get("kind") != "correlation_n"


def test_recommendations_do_not_flag_a_tunable_rule_as_inert(state_and_client) -> None:
    """The ordinary path is unchanged: a normal rule is never reported inert."""
    state, client = state_and_client
    _run(client, _seed_noisy(state))

    body = client.get("/api/tuning/recommendations").json()
    noise = {row["rule_id"]: row for row in body["rule_noise"]}
    assert noise["noisy_rule"]["correlation_n_inert"] is False
    assert noise["noisy_rule"]["correlation_n_inert_reason"] == ""
    recos = {p["rule_id"]: p for p in body["recommendations"]}
    assert recos["noisy_rule"]["kind"] == "correlation_n"
