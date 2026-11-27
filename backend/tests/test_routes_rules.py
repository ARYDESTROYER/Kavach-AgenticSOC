"""Rules-customization API (Round 5 / G6, RB task) — offline tests.

Locks the ``routes_rules`` config-writer router so it cannot regress:

* CRUD deep-MERGE over the three rule families (detection / correlation /
  case-automation) — a write to ONE rule NEVER wipes a sibling rule OR a sibling
  ``Preferences`` block (#3 deep-merge discipline).
* Immutable version ledger + one-click rollback (append-only history, #2).
* Bug #6 — a case-automation ``conditions.verdict`` that is not a real ``Verdict``
  (``suspicious``/``benign`` are Dispositions) is REJECTED on write + flagged on read.
* The read-only rule PREVIEW never bills the LLM (ZERO ``UsageDoc``, #6), never calls
  ``decide()`` (#3), and is hard-capped over the scoped RO read path (#1).
* RBAC — the whole surface is gated by the unified ``rules`` grant (G6 R9); a non-GET
  route is 401'd with auth ON and no token, and an under-privileged role is 403'd.

Fully network-free (fake ES + mock LLM).
"""

from __future__ import annotations

import json
from contextlib import asynccontextmanager
from typing import Any

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.api.deps import require_auth
from app.api.routes import router as monolith_router
from app.api.routes_rules import router as rules_router
from app.config import Secrets
from app.constants import UserRole
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.state import AppState
from app.utils import now_utc, to_millis
from tests.conftest import make_log_event
from tests._auth_helpers import ready_user

INDEX_A = "all-logs-2026.06.30"


# --------------------------------------------------------------------------- #
# Harness — auth OFF (the default) so we exercise the routes directly. Mounts the
# monolith router too (the preview reuses its /api/sources + _log_row helpers).
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
        es = InMemoryESClient()
        base = to_millis(now_utc()) - 600_000
        for i in range(6):
            es.add_log(INDEX_A, make_log_event(ip=f"10.0.0.{i}", rule="brute_force",
                                               ts_millis=base + i * 1000), doc_id=f"a{i}")
        for i in range(3):
            es.add_log(INDEX_A, make_log_event(ip=f"10.9.0.{i}", rule="benign_login",
                                               ts_millis=base + i * 1000), doc_id=f"b{i}")
        state = AppState.create(secrets=secrets, es=es, provider_overrides=overrides)
        await state.startup(start_poller=False)
        await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
        app.state.tlsoc = state
        holder["state"] = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(monolith_router)
    api.include_router(rules_router)
    with TestClient(api) as client:
        yield holder["state"], client


# --------------------------------------------------------------------------- #
# Detection-rule CRUD — deep-merge (no sibling wiped).
# --------------------------------------------------------------------------- #
def test_detection_crud_deep_merge_preserves_siblings(state_and_client) -> None:
    state, client = state_and_client
    # The catalog is SEEDED with built-in rules on startup — snapshot the seeds so we
    # can prove a rule write never wipes them (the real deep-merge guarantee).
    seeded = {rd.name for rd in state.prefs.rule_catalog}
    assert seeded, "expected a seeded built-in rule catalog"

    # Two NEW rules created independently (names not colliding with seeds).
    r = client.put("/api/rules/detection/rule_a", json={
        "name": "rule_a", "match": {"field": "rule.name", "op": "equals", "value": "a"}})
    assert r.status_code == 200 and r.json()["created"] is True
    r = client.put("/api/rules/detection/rule_b", json={
        "name": "rule_b", "match": {"field": "rule.name", "op": "equals", "value": "b"}})
    assert r.status_code == 200

    # Editing rule_a must NOT drop rule_b OR any seeded sibling (deep-merge on ONE slot).
    r = client.put("/api/rules/detection/rule_a", json={
        "name": "rule_a", "description": "edited",
        "match": {"field": "rule.name", "op": "equals", "value": "a2"}})
    assert r.status_code == 200 and r.json()["created"] is False
    names = {rd.name for rd in state.prefs.rule_catalog}
    assert {"rule_a", "rule_b"} <= names
    assert seeded <= names, "a rule edit must not wipe seeded sibling rules (#3 deep-merge)"
    a = next(rd for rd in state.prefs.rule_catalog if rd.name == "rule_a")
    assert a.description == "edited" and a.match.value == "a2"

    # A sibling Preferences block is untouched by a rule write (deep-merge, #3).
    assert state.prefs.setup_complete is True

    # Enable/disable toggle + delete only my rule (siblings survive).
    assert client.post("/api/rules/detection/rule_a/enabled", json={"enabled": False}).status_code == 200
    assert next(rd for rd in state.prefs.rule_catalog if rd.name == "rule_a").enabled is False
    assert client.delete("/api/rules/detection/rule_b").status_code == 200
    names_after = {rd.name for rd in state.prefs.rule_catalog}
    assert "rule_b" not in names_after and "rule_a" in names_after
    assert seeded <= names_after  # deleting one rule left every seeded sibling intact
    # Deleting an unknown rule is a 404 (honest signal, not a silent no-op).
    assert client.delete("/api/rules/detection/rule_b").status_code == 404


def test_correlation_crud_deep_merge(state_and_client) -> None:
    state, client = state_and_client
    assert client.put("/api/rules/correlation/rule_x", json={
        "n": 3, "window_seconds": 60, "group_by": "ip"}).status_code == 200
    assert client.put("/api/rules/correlation/rule_y", json={
        "n": 10, "window_seconds": 300, "group_by": "user"}).status_code == 200
    # Editing rule_x preserves rule_y (deep-merge on the one map key).
    assert client.put("/api/rules/correlation/rule_x", json={
        "n": 5, "window_seconds": 120, "group_by": "host"}).status_code == 200
    assert set(state.prefs.correlation_rules) == {"rule_x", "rule_y"}
    assert state.prefs.correlation_rules["rule_x"].n == 5
    assert state.prefs.correlation_rules["rule_y"].n == 10
    # Bounds enforced by the model: n>=1, window>=1.
    assert client.put("/api/rules/correlation/bad", json={"n": 0}).status_code == 422
    # Delete → falls back to default_correlation.
    assert client.delete("/api/rules/correlation/rule_x").status_code == 200
    assert "rule_x" not in state.prefs.correlation_rules
    assert client.delete("/api/rules/correlation/rule_x").status_code == 404


# --------------------------------------------------------------------------- #
# Case-automation CRUD — HITL-safe + bug #6 verdict rejection.
# --------------------------------------------------------------------------- #
def test_case_automation_crud_and_deep_merge(state_and_client) -> None:
    state, client = state_and_client
    assert client.put("/api/rules/case-automation/auto1", json={
        "id": "auto1", "action": "tag",
        "conditions": {"verdict": "TRUE_POSITIVE"}, "payload": {"tag": "hot"}}).status_code == 200
    assert client.put("/api/rules/case-automation/auto2", json={
        "id": "auto2", "action": "notify",
        "conditions": {"min_risk": 80}}).status_code == 200
    ids = {r.id for r in state.prefs.threshold_automation.rules}
    assert {"auto1", "auto2"} <= ids
    # Toggle + delete keep siblings.
    assert client.post("/api/rules/case-automation/auto1/enabled", json={"enabled": False}).status_code == 200
    assert next(r for r in state.prefs.threshold_automation.rules if r.id == "auto1").enabled is False
    assert client.delete("/api/rules/case-automation/auto2").status_code == 200
    assert {r.id for r in state.prefs.threshold_automation.rules} == {"auto1"}


def test_bug6_invalid_verdict_rejected_and_flagged(state_and_client) -> None:
    state, client = state_and_client
    # BUG #6: 'suspicious'/'benign' are DISPOSITIONS, not Verdicts — a rule storing one
    # could never fire, so the write is REJECTED (400) regardless of case.
    for bad in ("suspicious", "benign", "SUSPICIOUS", "Benign"):
        r = client.put("/api/rules/case-automation/badrule", json={
            "id": "badrule", "action": "tag", "conditions": {"verdict": bad}})
        assert r.status_code == 400, f"{bad} must be rejected"
        assert "verdict" in r.json()["detail"].lower()

    # H2 REGRESSION GUARD: the verdict check is CASE-INSENSITIVE (it mirrors the engine
    # matcher, which `.upper()`s both sides). BOTH editors emit LOWERCASE verdicts
    # (`constants.ts:132` → true_positive/false_positive/needs_human) and `adapter.ts`
    # passes them verbatim, so the router's own CRUD path MUST accept them. Before the
    # fix, a lowercase `false_positive` 400'd — the exact bug this test now pins shut.
    for good in ("false_positive", "true_positive", "needs_human",   # the UI-emitted case
                 "FALSE_POSITIVE", "TRUE_POSITIVE", "NEEDS_HUMAN"):   # the enum/canonical case
        r = client.put("/api/rules/case-automation/goodrule", json={
            "id": "goodrule", "action": "tag", "conditions": {"verdict": good}})
        assert r.status_code == 200, f"{good} is a REAL verdict and must be accepted: {r.text}"

    # A LEGACY impossible-verdict rule injected directly into prefs is FLAGGED on read
    # so the UI can migrate it (bug #6 migration signal) — but a lowercase REAL verdict is
    # NOT flagged (it is valid, just in the case the UI sends).
    from app.config import CaseAutomationRule
    legacy = CaseAutomationRule(id="legacy", action="tag", conditions={"verdict": "suspicious"})
    lower_ok = CaseAutomationRule(id="lower_ok", action="tag",
                                  conditions={"verdict": "false_positive"})
    cfg = state.prefs.threshold_automation.model_copy(
        update={"rules": [*state.prefs.threshold_automation.rules, legacy, lower_ok]})
    client.portal.call(lambda: state.update_prefs(
        state.prefs.model_copy(update={"threshold_automation": cfg})))
    body = client.get("/api/rules").json()
    flags = {row["id"]: row["invalid_verdict"] for row in body["case_automation"]}
    assert flags["legacy"] is True, "a Disposition stored as a verdict is flagged for migration"
    assert flags["goodrule"] is False
    # The crux of H2: a lowercase REAL verdict must NOT be falsely flagged invalid.
    assert flags["lower_ok"] is False, "a lowercase real verdict is valid, not 'invalid_verdict'"
    # The canonical (enum-case) set is unchanged for display; the lowercase set the editors
    # use is also returned (additive), so the FE need not case-fold.
    assert body["valid_verdicts"] == ["FALSE_POSITIVE", "NEEDS_HUMAN", "TRUE_POSITIVE"]
    assert body["valid_verdicts_lower"] == ["false_positive", "needs_human", "true_positive"]


# --------------------------------------------------------------------------- #
# Version ledger — every edit versions; rollback restores + appends (append-only).
# --------------------------------------------------------------------------- #
def test_version_ledger_and_rollback(state_and_client) -> None:
    state, client = state_and_client
    # v1 create, v2 edit.
    client.put("/api/rules/detection/vr", json={
        "name": "vr", "description": "v1", "match": {"field": "rule.name", "op": "equals", "value": "x"}})
    client.put("/api/rules/detection/vr", json={
        "name": "vr", "description": "v2", "match": {"field": "rule.name", "op": "equals", "value": "y"}})
    versions = client.get("/api/rules/detection/vr/versions").json()["versions"]
    assert [v["action"] for v in versions] == ["update", "create"]  # newest-first
    v1_id = versions[-1]["id"]
    assert versions[-1]["config"]["description"] == "v1"

    # Roll back to v1 → the live rule is restored to v1's WHOLE config.
    r = client.post(f"/api/rules/detection/vr/rollback/{v1_id}")
    assert r.status_code == 200, r.text
    live = next(rd for rd in state.prefs.rule_catalog if rd.name == "vr")
    assert live.description == "v1" and live.match.value == "x"

    # History is APPEND-ONLY: a NEW 'rollback' version now tops the ledger, pointing at
    # the restored id — the prior versions are NEVER mutated/removed (#2).
    versions2 = client.get("/api/rules/detection/vr/versions").json()["versions"]
    assert versions2[0]["action"] == "rollback"
    assert versions2[0]["rolled_back_to"] == v1_id
    assert len(versions2) == len(versions) + 1

    # Rolling back an unknown / mismatched version id is a 404.
    assert client.post("/api/rules/detection/vr/rollback/rv-nope").status_code == 404
    assert client.post(f"/api/rules/correlation/vr/rollback/{v1_id}").status_code == 404


# --------------------------------------------------------------------------- #
# Rule PREVIEW — read-only, hard-capped, ZERO UsageDoc (#6), never decide() (#3).
# --------------------------------------------------------------------------- #
def test_preview_counts_matches_without_billing_or_deciding(state_and_client) -> None:
    state, client = state_and_client
    # Register a browse-capable pull source over the seeded index.
    assert client.post("/api/sources", json={
        "id": "elk-a", "source_type": "elasticsearch", "is_primary": True,
        "config": {"data_view_pattern": INDEX_A}}).status_code == 200

    # Snapshot the usage ledger BEFORE the preview (#6: it must not grow).
    usage_before = client.portal.call(
        lambda: state.usage_store.summary(window_hours=24 * 365))["call_count"]

    # decide() must NEVER be called by a preview (#3) — make it explode if it is.
    import app.engine.case_manager as cm

    def _boom(*a, **k):  # pragma: no cover — must never run
        raise AssertionError("preview must not call decide() (#3)")

    orig_decide = cm.decide
    cm.decide = _boom
    try:
        r = client.post("/api/rules/preview", json={
            "match": [{"field": "rule.name", "op": "equals", "value": "brute_force"}],
            "limit": 200, "bucket_minutes": 60})
        assert r.status_code == 200, r.text
    finally:
        cm.decide = orig_decide

    body = r.json()
    assert body["scanned"] >= 9          # 6 brute_force + 3 benign scanned
    assert body["matched"] == 6          # only the brute_force rows match the predicate
    assert 0.0 < body["match_rate"] <= 1.0
    assert body["predicates"] == 1
    assert isinstance(body["histogram"], list) and body["histogram"]
    assert len(body["sample"]) <= 25
    for row in body["sample"]:
        assert "_raw" not in row          # trimmed projection; log data only (#9)

    # #6: the usage/cost ledger did NOT grow (no LLM call → zero UsageDoc).
    usage_after = client.portal.call(
        lambda: state.usage_store.summary(window_hours=24 * 365))["call_count"]
    assert usage_after == usage_before


def test_preview_empty_predicate_matches_nothing(state_and_client) -> None:
    state, client = state_and_client
    assert client.post("/api/sources", json={
        "id": "elk-a", "source_type": "elasticsearch", "is_primary": True,
        "config": {"data_view_pattern": INDEX_A}}).status_code == 200
    # An EMPTY predicate must match NOTHING (never imply the rule fires on all traffic).
    r = client.post("/api/rules/preview", json={"match": [], "limit": 50})
    assert r.status_code == 200
    body = r.json()
    assert body["scanned"] >= 1 and body["matched"] == 0 and body["match_rate"] == 0.0


def test_preview_evaluates_only_first_predicate_row_matching_deploy(state_and_client) -> None:
    """M3: the save adapter keeps only the FIRST predicate row (``RuleDefinition.match``
    is a single ``RuleMatch``; nested AND/OR is deferred). The preview MUST evaluate the
    SAME first row the deployed rule fires on — ANDing every row would UNDER-count vs. the
    real rule and mis-calibrate the operator. This pins that parity."""
    state, client = state_and_client
    assert client.post("/api/sources", json={
        "id": "elk-a", "source_type": "elasticsearch", "is_primary": True,
        "config": {"data_view_pattern": INDEX_A}}).status_code == 200

    # Row 1 matches the 6 brute_force rows. Row 2 can NEVER be true for those rows — if the
    # preview ANDed all rows it would report 0; the deployed rule (first row only) fires on
    # 6. A correct preview reports 6 (what actually deploys) + says it evaluated only 1 row.
    r = client.post("/api/rules/preview", json={
        "match": [
            {"field": "rule.name", "op": "equals", "value": "brute_force"},   # first (saved) row
            {"field": "rule.name", "op": "equals", "value": "does_not_exist"},  # extra, dropped on save
        ],
        "limit": 200, "bucket_minutes": 60})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["matched"] == 6, "preview must count the FIRST row only (what deploys), not the AND"
    assert body["predicates"] == 2, "both supplied rows are reported"
    assert body["predicates_evaluated"] == 1, "only the first row is evaluated (matches the adapter)"


# --------------------------------------------------------------------------- #
# preview-decision parity — the pure what-if wrapper on routes_triage (F4) matches
# the real decide() and writes ZERO UsageDoc. (The rules editors use it for what-if.)
# --------------------------------------------------------------------------- #
def test_preview_decision_parity_and_no_usage() -> None:
    from app.api.routes_triage import router as triage_router

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        secrets = Secrets(_env_file=None, es_store_enabled=False, redis_url="",
                          anthropic_api_key=None, openai_api_key=None)
        mock = MockProvider()
        overrides = {"anthropic": mock, "openai": mock, "mock": mock}
        state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
        await state.startup(start_poller=False)
        await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
        app.state.tlsoc = state
        app.state._st = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(triage_router)
    with TestClient(api) as client:
        state = client.app.state._st
        from app.engine.case_manager import decide

        before = client.portal.call(
            lambda: state.usage_store.summary(window_hours=24 * 365))["call_count"]

        payload = {"verdict": "FALSE_POSITIVE", "confidence": 0.99, "risk_score": 5.0,
                   "policy": {"false_positive": {"enabled": True, "min_confidence": 0.9,
                                                 "max_risk_score": 20.0,
                                                 "objection_window_minutes": 0}}}
        r = client.post("/api/triage/preview-decision", json=payload)
        assert r.status_code == 200, r.text
        got = r.json()["decision"]

        # Parity: the wrapper's status is EXACTLY what the pure decide() returns for the
        # same inputs (it imports the one true function, never re-implements it, #3).
        from app.config import AutoClosePolicy
        from app.constants import Verdict
        d = decide(Verdict.FALSE_POSITIVE, 0.99, 5.0,
                   AutoClosePolicy.model_validate(payload["policy"]),
                   escalation_confidence=state.prefs.escalation_confidence,
                   critical_severity=state.prefs.critical_severity)
        assert got["status"] == d.status.value
        assert got["auto_closed"] == (d.status.value == "closed")

        # #6: zero UsageDoc — the what-if never bills the LLM.
        after = client.portal.call(
            lambda: state.usage_store.summary(window_hours=24 * 365))["call_count"]
        assert after == before


# --------------------------------------------------------------------------- #
# RBAC — deny-by-default (auth ON, no token) + under-privileged 403.
# --------------------------------------------------------------------------- #
def test_non_get_route_rejected_when_auth_on_without_token() -> None:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        secrets = Secrets(
            _env_file=None, es_store_enabled=False, redis_url="",
            anthropic_api_key=None, openai_api_key=None,
            auth_enabled=True, auth_jwt_secret="r5-rules-secret",
        )
        mock = MockProvider()
        overrides = {"anthropic": mock, "openai": mock, "mock": mock}
        state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
        await state.startup(start_poller=False)
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(rules_router, dependencies=[Depends(require_auth)])
    with TestClient(api) as client:
        # No cookie / bearer → 401 on both a mutation and a read.
        assert client.put("/api/rules/detection/x", json={
            "name": "x", "match": {"field": "f", "op": "exists"}}).status_code == 401
        assert client.get("/api/rules").status_code == 401
        assert client.post("/api/rules/preview", json={"match": []}).status_code == 401


def test_underprivileged_role_is_forbidden_from_managing_rules() -> None:
    """An auditor (read/view only) can READ rules but NOT manage them (403). A
    super_admin can do both. Proves the unified ``rules`` grant is enforced (G6 R9)."""
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=app.state._secrets, es=InMemoryESClient(),
                                provider_overrides=app.state._ov)
        await state.startup(start_poller=False)
        prefs = state.prefs.model_copy(update={"setup_complete": True})
        prefs = prefs.model_copy(update={"rbac": prefs.rbac.model_copy(update={"enabled": True})})
        await state.update_prefs(prefs)
        app.state.tlsoc = state
        yield
        await state.shutdown()

    secrets = Secrets(_env_file=None, es_store_enabled=False, redis_url="",
                      anthropic_api_key=None, openai_api_key=None,
                      auth_enabled=True, auth_jwt_secret="r5-rules-rbac",
                      auth_seed_admin=True)
    mock = MockProvider()
    overrides = {"anthropic": mock, "openai": mock, "mock": mock}
    api = FastAPI(lifespan=lifespan)
    api.state._secrets = secrets
    api.state._ov = overrides
    api.include_router(monolith_router, dependencies=[Depends(require_auth)])
    api.include_router(rules_router, dependencies=[Depends(require_auth)])
    with TestClient(api) as c:
        def _login(u, p):
            c.cookies.clear()
            r = c.post("/api/auth/login", json={"username": u, "password": p})
            assert r.status_code == 200, r.text

        _login("Admin", "Admin@123")
        # Admin (super_admin) can manage.
        assert c.put("/api/rules/detection/adm", json={
            "name": "adm", "match": {"field": "f", "op": "exists"}}).status_code == 200
        # Create an auditor (read/view only).
        assert c.post("/api/users", json={
            "username": "aud", "password": "aud-pass-1",
            "role": UserRole.AUDITOR.value}).status_code == 200
        ready_user(c, "aud", "aud-pass-1")

        _login("aud", "aud-pass-1")
        # Auditor can READ rules (rules:read mirrors settings:read).
        assert c.get("/api/rules").status_code == 200
        # ...but CANNOT manage them (no rules:manage) → 403.
        r = c.put("/api/rules/detection/aud_try", json={
            "name": "aud_try", "match": {"field": "f", "op": "exists"}})
        assert r.status_code == 403, r.text
        assert "rules:manage" in r.json()["detail"]


def test_custom_role_with_only_rules_grant_can_read_ledger_and_rollback() -> None:
    """M2 (bug-#7 class): a CUSTOM role granted ONLY the unified ``rules`` resource —
    NOT ``automation`` and NOT ``settings`` — must be able to use the whole rules-native
    surface the FE now gates on ``rules``: read the catalog, load the version ledger, and
    ROLL BACK. This is exactly the case where the OLD FE (gating on ``automation``/
    ``settings``) diverged from the backend (enforcing ``rules``): the role could not see
    the editor / saw buttons that then 403'd. The backend proves the ``rules`` grant is
    the single coherent one; the FE unification (RULES_PERM → ``rules``) matches it."""
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=app.state._secrets, es=InMemoryESClient(),
                                provider_overrides=app.state._ov)
        await state.startup(start_poller=False)
        # A custom role whose ONLY grants are the unified ``rules`` read+manage. Base
        # ``auditor`` starts read-only across the board and carries NO settings/automation
        # MANAGE — so if the router mistakenly required ``automation``/``settings`` the
        # ledger/rollback would 403, catching an FE↔BE resource drift.
        rbac = state.prefs.rbac.model_copy(update={
            "enabled": True,
            "custom_roles": [{
                "name": "rules_only",
                "inherits": ["auditor"],
                "grants": {"rules": ["read", "manage"]},
            }],
        })
        prefs = state.prefs.model_copy(update={"setup_complete": True, "rbac": rbac})
        await state.update_prefs(prefs)
        app.state.tlsoc = state
        app.state._st = state
        yield
        await state.shutdown()

    secrets = Secrets(_env_file=None, es_store_enabled=False, redis_url="",
                      anthropic_api_key=None, openai_api_key=None,
                      auth_enabled=True, auth_jwt_secret="r5-rules-custom",
                      auth_seed_admin=True)
    mock = MockProvider()
    overrides = {"anthropic": mock, "openai": mock, "mock": mock}
    api = FastAPI(lifespan=lifespan)
    api.state._secrets = secrets
    api.state._ov = overrides
    api.include_router(monolith_router, dependencies=[Depends(require_auth)])
    api.include_router(rules_router, dependencies=[Depends(require_auth)])
    with TestClient(api) as c:
        state = c.app.state._st

        def _login(u, p):
            c.cookies.clear()
            r = c.post("/api/auth/login", json={"username": u, "password": p})
            assert r.status_code == 200, r.text

        _login("Admin", "Admin@123")
        # Seed a versioned detection rule as Admin so there is a ledger to roll back.
        assert c.put("/api/rules/detection/vr", json={
            "name": "vr", "description": "v1",
            "match": {"field": "rule.name", "op": "equals", "value": "x"}}).status_code == 200
        assert c.put("/api/rules/detection/vr", json={
            "name": "vr", "description": "v2",
            "match": {"field": "rule.name", "op": "equals", "value": "y"}}).status_code == 200

        # Create the user and ASSIGN the custom role (persisted in User.prefs.custom_roles,
        # where the RBAC enforcement path reads it).
        assert c.post("/api/users", json={
            "username": "ru", "password": "ru-pass-1",
            "role": UserRole.AUDITOR.value}).status_code == 200
        ready_user(c, "ru", "ru-pass-1")
        c.portal.call(lambda: state.users.update("ru", prefs={"custom_roles": ["rules_only"]}))

        _login("ru", "ru-pass-1")
        # rules:read → the catalog + the version ledger both load.
        assert c.get("/api/rules").status_code == 200
        versions = c.get("/api/rules/detection/vr/versions")
        assert versions.status_code == 200, versions.text
        vlist = versions.json()["versions"]
        v1_id = vlist[-1]["id"]  # oldest = the v1 create
        # rules:manage → rollback (a rules-native endpoint, NOT the Settings buffer) works
        # for this role even though it has NO settings:manage grant. This is the crux: the
        # unified ``rules`` grant is sufficient for the rules-native surface (M2).
        rb = c.post(f"/api/rules/detection/vr/rollback/{v1_id}")
        assert rb.status_code == 200, rb.text
        live = next(rd for rd in state.prefs.rule_catalog if rd.name == "vr")
        assert live.description == "v1"

        # Sanity: the SAME role is still denied a resource it was NOT granted (settings),
        # proving the grant is scoped to ``rules`` and not accidentally broadened.
        denied = c.put("/api/settings", json={"escalation_confidence": 0.5})
        assert denied.status_code == 403, denied.text
