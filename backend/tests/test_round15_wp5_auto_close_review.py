"""Round 15 WP5: the auto-close review (SPEC D6.1 to D6.13, §3.6).

Offline: fake Elasticsearch, mock model.

* the sampler: a deterministic score, the rate, the daily and per-rule caps in the
  operator zone, once per case, only a terminal case whose first decision record is an
  agent close (never an analyst-policy close), audit first, fail-soft;
* the ledger: the opaque six-field document, the ring and its eviction order, the
  90-day counts, expiry computed on read, strict compare-and-set;
* the pipeline hook: after every other post-decision hook, None in the replay stack,
  the real and Demo samplers wired;
* ``POST /api/cases/{id}/review``: the 409s, audit first, the no-touch rule, the grade
  and (only for a sampled case) the history marker, the ledger completion and its
  repair, the disagreement Inbox for people who can close cases;
* the summary, the metrics module (Wilson only from 30 reviews, the statement, missed
  threats, eligible closes by first decision day) and ``GET /api/cases?review=``;
* ``eligible_audience``, reset, export, Demo seeding and Demo sinks;
* the static guards of §3.6.
"""

from __future__ import annotations

import ast
import json
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.api.deps import require_auth
from app.api.routes import router as monolith_router
from app.api.routes_auto_close_review import router as review_router
from app.config import AutoCloseReviewConfig, Preferences, Secrets
from app.constants import (
    AUTO_CLOSE_REVIEW_NS,
    CaseStatus,
    DecisionBy,
    Disposition,
    EntityType,
    SourceSurface,
    Verdict,
)
from app.engine import auto_close_review as acr
from app.engine.review_origin import is_review_grade
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.models import Case, Entity, StatusHistoryEntry
from app.state import AppState
from app.stores.auto_close_review import (
    LEDGER_KEY,
    LEDGER_MAX_ENTRIES,
    AutoCloseReviewStore,
    ReviewEntry,
    ReviewLedger,
    ReviewLedgerUnavailable,
)
from tests.conftest import mount_moved_routers

APP = Path(__file__).resolve().parents[1] / "app"
NOW = datetime(2026, 11, 23, 12, 0, tzinfo=timezone.utc)


def _agent_closed(
    cid: str, *, rule: str = "rule-a", verdict: Verdict = Verdict.FALSE_POSITIVE,
    decided: datetime = NOW, number: str = "", first_status: str = "closed",
    first_by: str = "agent",
) -> Case:
    iso = decided.isoformat()
    return Case(
        case_id=cid, case_number=number or cid.upper(), cluster_signature=f"sig-{cid}",
        source_surface=SourceSurface.AUTOMATED_SCAN, rule_ids=[rule],
        entity=Entity(type=EntityType.IP, value="198.51.100.7"), verdict=verdict,
        confidence=0.93, risk_score=12.0, status=CaseStatus.CLOSED,
        decision_by=DecisionBy.AGENT, disposition=Disposition.FALSE_POSITIVE,
        created_at=iso, updated_at=iso,
        status_history=[StatusHistoryEntry(from_status="new", to_status="closed", by="agent", at=iso)],
        history=[{"ts": iso, "event": "decision", "status": first_status, "decision_by": first_by,
                  "escalate": False, "rationale": "FALSE_POSITIVE auto-closed"}],
    )


def _cfg(**kw: Any) -> AutoCloseReviewConfig:
    base = {"enabled": True, "sample_rate": 0.5, "daily_cap": 10, "per_rule_daily_cap": 3, "expiry_days": 7}
    base.update(kw)
    return AutoCloseReviewConfig(**base)


def _prefs(**kw: Any) -> Preferences:
    return Preferences(auto_close_review=_cfg(**kw))


def _low_ids(n: int, rate: float = 0.5, prefix: str = "case-") -> list[str]:
    """Case ids whose deterministic score is below ``rate``."""
    out: list[str] = []
    i = 0
    while len(out) < n:
        cid = f"{prefix}{i:05d}"
        if acr.review_score(cid) < rate:
            out.append(cid)
        i += 1
    return out


def _high_id(rate: float = 0.5) -> str:
    i = 0
    while acr.review_score(f"case-hi-{i}") < rate:
        i += 1
    return f"case-hi-{i}"


class _KV:
    """A strict in-memory KV with compare-and-set on ``_rev``."""

    def __init__(self) -> None:
        self.docs: dict[tuple[str, str], dict[str, Any]] = {}
        self.fail_put = False
        self.fail_get = False

    async def get_strict(self, ns: str, key: str) -> dict[str, Any] | None:
        if self.fail_get:
            raise RuntimeError("down")
        value = self.docs.get((ns, key))
        return json.loads(json.dumps(value)) if value is not None else None

    async def get(self, ns: str, key: str) -> dict[str, Any] | None:
        return await self.get_strict(ns, key)

    async def put_if_strict(self, ns: str, key: str, value: dict[str, Any], expected_rev: int) -> bool:
        if self.fail_put:
            raise RuntimeError("down")
        current = self.docs.get((ns, key))
        rev = int((current or {}).get("_rev", 0) or 0)
        if rev != expected_rev:
            return False
        self.docs[(ns, key)] = json.loads(json.dumps(value))
        return True


class _Audit:
    def __init__(self, *, fail: bool = False) -> None:
        self.rows: list[dict[str, Any]] = []
        self.fail = fail

    async def record_strict(self, **kw: Any) -> None:
        if self.fail:
            raise RuntimeError("audit down")
        self.rows.append(kw)

    async def record(self, **kw: Any) -> None:
        self.rows.append(kw)


class _Bus:
    def __init__(self) -> None:
        self.frames: list[tuple[str, str, dict[str, Any]]] = []

    def publish(self, topic: str, event: str, payload: dict[str, Any], **_kw: Any) -> str:
        self.frames.append((topic, event, payload))
        return "1"


def _sampler(store: AutoCloseReviewStore, audit: _Audit, bus: _Bus | None = None, now: datetime = NOW):
    return acr.ReviewSampler(store=lambda: store, audit=lambda: audit,
                             bus=(lambda: bus) if bus else None, clock=lambda: now)


# --------------------------------------------------------------------------- #
# D6.3: the score and the selection rule
# --------------------------------------------------------------------------- #
def test_the_score_is_sha256_of_the_salted_case_id_over_two_to_the_64() -> None:
    import hashlib

    digest = hashlib.sha256(b"auto-close-review:v1:case-abc").digest()
    assert acr.review_score("case-abc") == int.from_bytes(digest[:8], "big") / 2**64
    assert acr.review_score("case-abc") == acr.review_score("case-abc")
    assert 0.0 <= acr.review_score("case-xyz") < 1.0
    assert acr.SCORE_SALT == "auto-close-review:v1:"


def test_selection_follows_rate_caps_and_once_per_case() -> None:
    ledger = ReviewLedger()
    low = _low_ids(6)
    config = _cfg(daily_cap=4, per_rule_daily_cap=2)
    first = acr.select_for_review(ledger, _agent_closed(low[0]), config, now=NOW, tz="UTC")
    assert first.selected and first.reason == "selected" and first.day == "2026-11-23"
    assert acr.select_for_review(ledger, _agent_closed(_high_id()), config, now=NOW, tz="UTC").reason == "above_rate"
    for cid in low[:2]:
        ledger.add(acr.new_entry(_agent_closed(cid), acr.select_for_review(
            ledger, _agent_closed(cid), config, now=NOW, tz="UTC"), NOW), now=NOW, expiry_days=7)
    # Once per case.
    assert acr.select_for_review(ledger, _agent_closed(low[0]), config, now=NOW, tz="UTC").reason == "already_sampled"
    # The rule's cap (2 of rule-a today).
    assert acr.select_for_review(ledger, _agent_closed(low[2]), config, now=NOW, tz="UTC").reason == "rule_cap"
    # Another rule is still open, until the day's cap.
    for cid in low[2:4]:
        case = _agent_closed(cid, rule="rule-b")
        ledger.add(acr.new_entry(case, acr.select_for_review(ledger, case, config, now=NOW, tz="UTC"), NOW),
                   now=NOW, expiry_days=7)
    blocked = acr.select_for_review(ledger, _agent_closed(low[4], rule="rule-c"), config, now=NOW, tz="UTC")
    assert blocked.reason == "daily_cap" and blocked.day_count == 4
    # The next operator day starts fresh.
    tomorrow = NOW + timedelta(days=1)
    assert acr.select_for_review(ledger, _agent_closed(low[4], rule="rule-c"), config, now=tomorrow, tz="UTC").selected


def test_the_day_is_the_operator_zone_day() -> None:
    late = datetime(2026, 11, 23, 22, 30, tzinfo=timezone.utc)
    assert acr.operator_day(late, "UTC") == "2026-11-23"
    assert acr.operator_day(late, "Asia/Kolkata") == "2026-11-24"
    assert acr.operator_day(late, "not/a-zone") == "2026-11-23"
    assert acr.operator_zone(SimpleNamespace(sla=SimpleNamespace(timezone="Asia/Kolkata"))) == "Asia/Kolkata"


def test_only_an_agent_close_on_its_first_decision_is_eligible() -> None:
    cid = _low_ids(1)[0]
    assert acr.sample_eligible(_agent_closed(cid))
    open_case = _agent_closed(cid)
    open_case.status = CaseStatus.OPEN
    assert not acr.sample_eligible(open_case)
    analyst = _agent_closed(cid)
    analyst.decision_by = DecisionBy.ANALYST
    assert not acr.sample_eligible(analyst)
    # The first decision routed it to a person; a later re-close by the agent is not
    # "the agent closed it" for the review.
    routed_first = _agent_closed(cid, first_status="needs_human", first_by="system")
    assert not acr.sample_eligible(routed_first)
    undecided = _agent_closed(cid)
    undecided.history = []
    assert not acr.sample_eligible(undecided)
    policy = _agent_closed(cid)
    policy.decision_by = DecisionBy.ANALYST_POLICY
    policy.analyst_policy = {"rule_id": "rule-a", "action": "close_false_positive"}
    assert not acr.sample_eligible(policy)
    config = _cfg()
    assert acr.select_for_review(ReviewLedger(), routed_first, config, now=NOW, tz="UTC").reason == "not_eligible"
    assert acr.select_for_review(ReviewLedger(), _agent_closed(cid), _cfg(enabled=False), now=NOW, tz="UTC").reason == "disabled"
    assert acr.select_for_review(ReviewLedger(), _agent_closed(cid), _cfg(daily_cap=0), now=NOW, tz="UTC").reason == "disabled"


def test_classification_maps_to_outcome_and_agreement() -> None:
    assert acr.CLASSIFICATION_OUTCOME == {
        "true_positive": "true_positive", "false_positive": "false_positive",
        "benign": "false_positive", "unsure": "unknown",
    }
    assert acr.classification_agrees("false_positive", "FALSE_POSITIVE") is True
    assert acr.classification_agrees("benign", "FALSE_POSITIVE") is True
    assert acr.classification_agrees("true_positive", "FALSE_POSITIVE") is False
    assert acr.classification_agrees("true_positive", "TRUE_POSITIVE") is True
    assert acr.classification_agrees("unsure", "FALSE_POSITIVE") is None


# --------------------------------------------------------------------------- #
# D6.4: the ledger
# --------------------------------------------------------------------------- #
async def test_the_ledger_is_one_opaque_document_of_four_fields() -> None:
    kv = _KV()
    store = AutoCloseReviewStore(kv)
    case = _agent_closed(_low_ids(1)[0], rule="weird rule.with:dots")
    decision = acr.select_for_review(ReviewLedger(), case, _cfg(), now=NOW, tz="UTC")

    def add(ledger: ReviewLedger) -> ReviewLedger:
        ledger.add(acr.new_entry(case, decision, NOW), now=NOW, expiry_days=7)
        return ledger

    await store.update(add)
    doc = kv.docs[(AUTO_CLOSE_REVIEW_NS, LEDGER_KEY)]
    assert set(doc) == {"acr_store", "acr_schema", "acr_json", "_rev"}
    assert doc["acr_store"] == "auto_close_review" and doc["_rev"] == 1
    payload = json.loads(doc["acr_json"])
    assert payload["days"]["2026-11-23"] == {"n": 1, "rules": {"weird rule.with:dots": 1}}
    (entry,) = payload["entries"]
    assert set(entry) == {
        "review_id", "case_id", "case_number", "rule", "sampled_at", "day", "score", "state",
        "reviewer", "completed_at", "classification", "agrees", "ai_verdict", "elapsed_ms",
    }
    assert entry["state"] == "pending" and entry["ai_verdict"] == "FALSE_POSITIVE"
    loaded = await store.load()
    assert loaded.rev == 1 and loaded.entries[0].case_id == case.case_id


async def test_a_malformed_or_unreadable_ledger_is_unavailable_not_empty() -> None:
    kv = _KV()
    kv.docs[(AUTO_CLOSE_REVIEW_NS, LEDGER_KEY)] = {"acr_json": "{not json", "_rev": 3}
    with pytest.raises(ReviewLedgerUnavailable):
        await AutoCloseReviewStore(kv).load()
    kv.fail_get = True
    with pytest.raises(ReviewLedgerUnavailable):
        await AutoCloseReviewStore(kv).load()


def test_eviction_drops_settled_entries_first_then_the_oldest_pending() -> None:
    ledger = ReviewLedger()
    old = NOW - timedelta(days=20)
    for i in range(LEDGER_MAX_ENTRIES):
        entry = ReviewEntry(review_id=f"r{i}", case_id=f"c{i}", sampled_at=NOW.isoformat(), day="2026-11-23")
        if i in (5, 9):
            entry.state = "completed"
        if i == 7:
            entry.sampled_at = old.isoformat()  # expired on read
        ledger.entries.append(entry)
    ledger.add(ReviewEntry(review_id="new1", case_id="cn1", sampled_at=NOW.isoformat(), day="2026-11-23"),
               now=NOW, expiry_days=7)
    ids = {e.review_id for e in ledger.entries}
    # The oldest settled entry (completed or expired) goes first.
    assert len(ledger.entries) == LEDGER_MAX_ENTRIES and "r5" not in ids and "r7" in ids and "new1" in ids
    for n in range(3):
        ledger.add(ReviewEntry(review_id=f"more{n}", case_id=f"cm{n}", sampled_at=NOW.isoformat(),
                               day="2026-11-23"), now=NOW, expiry_days=7)
    ids = {e.review_id for e in ledger.entries}
    # Then the expired and the other completed one, then the oldest pending.
    assert "r7" not in ids and "r9" not in ids and "r0" not in ids and "r1" in ids


def test_day_counts_are_kept_for_ninety_days_and_expiry_is_computed() -> None:
    ledger = ReviewLedger(days={"2026-07-01": {"n": 4, "rules": {"a": 4}}, "2026-11-20": {"n": 1, "rules": {}}})
    ledger.evict(now=NOW, expiry_days=7)
    assert set(ledger.days) == {"2026-11-20"}
    entry = ReviewEntry(review_id="r", case_id="c", sampled_at=(NOW - timedelta(days=8)).isoformat())
    assert entry.state_at(NOW, 7) == "expired" and entry.state_at(NOW, 9) == "pending"
    entry.state = "completed"
    assert entry.state_at(NOW, 1) == "completed"


async def test_compare_and_set_retries_then_reports() -> None:
    kv = _KV()
    store = AutoCloseReviewStore(kv)
    calls = {"n": 0}

    def change(ledger: ReviewLedger) -> ReviewLedger:
        calls["n"] += 1
        if calls["n"] == 1:
            # Another writer saves first.
            kv.docs[(AUTO_CLOSE_REVIEW_NS, LEDGER_KEY)] = {**ReviewLedger().to_doc(), "_rev": 1}
        return ledger

    saved = await store.update(change)
    assert calls["n"] == 2 and saved is not None and saved.rev == 2
    kv.fail_put = True
    with pytest.raises(ReviewLedgerUnavailable):
        await store.update(lambda ledger: ledger)
    assert await store.update(lambda ledger: None) is None


# --------------------------------------------------------------------------- #
# The sampler hook
# --------------------------------------------------------------------------- #
async def test_the_sampler_writes_the_audit_row_first_then_the_ledger_and_a_frame() -> None:
    store, audit, bus = AutoCloseReviewStore(_KV()), _Audit(), _Bus()
    case = _agent_closed(_low_ids(1)[0], number="CASE-0007")
    assert await _sampler(store, audit, bus)(case, _prefs()) is True
    (row,) = audit.rows
    assert row["action"] == "case.review_requested" and row["actor"] == "system"
    assert row["actor_type"] == "system" and row["outcome"] == "success"
    assert row["target"].label == "CASE-0007"
    assert row["tool_input"]["rule"] == "rule-a" and row["tool_input"]["daily_cap"] == 10
    assert "rule-a" not in row["result_summary"]  # ids and codes only
    ledger = await store.load()
    assert ledger.entries[0].case_id == case.case_id and ledger.entries[0].review_id == row["tool_input"]["review_id"]
    assert [(t, e) for t, e, _p in bus.frames] == [(f"cases:{case.case_id}", "case.review"), ("cases", "case.review")]
    # Once per case.
    assert await _sampler(store, audit, bus)(case, _prefs()) is False
    assert len(audit.rows) == 1


async def test_the_sampler_is_fail_soft_and_never_touches_the_case() -> None:
    case = _agent_closed(_low_ids(1)[0])
    before = case.model_dump(mode="json")
    # Audit down: nothing is sampled.
    store = AutoCloseReviewStore(_KV())
    assert await _sampler(store, _Audit(fail=True))(case, _prefs()) is False
    assert (await store.load()).entries == []
    # Ledger down after the row: a failure row, no sample, no raise.
    kv = _KV()
    store = AutoCloseReviewStore(kv)
    audit = _Audit()
    kv.fail_put = True
    assert await _sampler(store, audit)(case, _prefs()) is False
    assert [r["action"] for r in audit.rows] == ["case.review_requested", "case.review_request_failed"]
    assert audit.rows[1]["outcome"] == "failure"
    assert case.model_dump(mode="json") == before
    # Disabled, above the rate, or not an agent close: nothing is read or written.
    quiet = _Audit()
    assert await _sampler(AutoCloseReviewStore(_KV()), quiet)(case, _prefs(enabled=False)) is False
    assert await _sampler(AutoCloseReviewStore(_KV()), quiet)(_agent_closed(_high_id()), _prefs()) is False
    assert quiet.rows == []


async def test_the_pipeline_samples_after_every_other_post_decision_hook(
    app_state: AppState, mock_provider: MockProvider, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.agents import pipeline as pipeline_mod
    from tests.test_pipeline import _cluster

    order: list[str] = []
    pipe = app_state.pipeline
    for name in ("_maybe_attach_runbook", "_maybe_automate", "_maybe_index_resolved"):
        original = getattr(pipe, name)

        async def wrapped(*args: Any, _name: str = name, _orig: Any = original, **kw: Any) -> Any:
            order.append(_name)
            return await _orig(*args, **kw)

        monkeypatch.setattr(pipe, name, wrapped)
    notify = pipe._maybe_notify
    monkeypatch.setattr(pipe, "_maybe_notify", lambda case: (order.append("_maybe_notify"), notify(case))[1])
    sampler = pipe.review_sampler
    assert isinstance(sampler, acr.ReviewSampler)

    async def recording(case: Any, prefs: Any) -> bool:
        order.append("review_sampler")
        return await sampler(case, prefs)

    pipe.review_sampler = recording
    monkeypatch.setattr(acr, "review_score", lambda _cid: 0.0)
    p = app_state.prefs.model_copy(deep=True)
    p.auto_close.false_positive.enabled = True
    p.auto_close.false_positive.min_confidence = 0.5
    p.auto_close.false_positive.max_risk_score = 100.0
    await app_state.update_prefs(p)
    mock_provider.push("router", json.dumps({"bucket": "obviously_benign", "confidence": 0.95, "reason": "noise"}))
    case = await pipe.investigate_cluster(_cluster("9.9.9.8"), SourceSurface.AUTOMATED_SCAN, app_state.prefs)
    assert case.status == CaseStatus.CLOSED and case.decision_by == DecisionBy.AGENT
    assert order[-1] == "review_sampler" and order.index("review_sampler") > order.index("_maybe_notify")
    ledger = await app_state.real_auto_close_review.load()
    assert [e.case_id for e in ledger.entries] == [case.case_id]
    rows = await app_state.control_audit.records(limit=500)
    assert any(r.get("action") == "case.review_requested" and r.get("case_id") == case.case_id for r in rows)
    stored = await app_state.cases.get(case.case_id)
    assert stored.status == CaseStatus.CLOSED and stored.decision_by == DecisionBy.AGENT
    assert not any(h.get("event") == "auto_close_review" for h in stored.history)
    assert pipeline_mod.InvestigationPipeline._maybe_sample_review is not None


async def test_an_escalated_case_is_never_handed_to_the_sampler(app_state: AppState) -> None:
    calls: list[str] = []

    async def sampler(case: Any, _prefs: Any) -> None:
        calls.append(case.case_id)

    pipe = app_state.pipeline
    pipe.review_sampler = sampler
    routed = _agent_closed("case-routed")
    routed.status = CaseStatus.ESCALATED
    routed.decision_by = DecisionBy.SYSTEM
    await pipe._maybe_sample_review(routed, app_state.prefs)
    await pipe._maybe_sample_review(_agent_closed("case-closed"), app_state.prefs)
    assert calls == ["case-closed"]

    async def broken(*_a: Any) -> None:
        raise RuntimeError("boom")

    pipe.review_sampler = broken
    await pipe._maybe_sample_review(_agent_closed("case-x"), app_state.prefs)  # never raises


def test_the_replay_stack_pipeline_has_no_sampler() -> None:
    from app.agents.pipeline import InvestigationPipeline

    src = (APP / "engine" / "replay" / "stack.py").read_text(encoding="utf-8")
    assert "review_sampler" not in src
    import inspect

    assert inspect.signature(InvestigationPipeline.__init__).parameters["review_sampler"].default is None


async def test_state_wires_the_real_and_the_demo_samplers(app_state: AppState) -> None:
    assert isinstance(app_state._real_pipeline.review_sampler, acr.ReviewSampler)
    assert app_state.auto_close_review is app_state.real_auto_close_review
    await app_state.enable_demo(mode="seeded")
    try:
        demo = app_state._demo
        assert app_state.pipeline is demo.pipeline
        assert isinstance(demo.pipeline.review_sampler, acr.ReviewSampler)
        assert app_state.auto_close_review is demo.auto_close_review
        assert app_state.auto_close_review is not app_state.real_auto_close_review
    finally:
        await app_state.disable_demo()


# --------------------------------------------------------------------------- #
# eligible_audience
# --------------------------------------------------------------------------- #
async def test_eligible_audience_is_parameterised_and_the_batch_wrapper_stays() -> None:
    from app.engine import batch_inbox
    from app.models import User

    users = [
        User(username="boss", password_hash="h", role="soc_manager", active=True),
        User(username="tier1", password_hash="h", role="analyst_tier1", active=True),
        User(username="tier2", password_hash="h", role="analyst_tier2", active=True),
        User(username="gone", password_hash="h", role="analyst_tier2", active=False),
    ]
    docs = {
        ("users", "entries"): {"entries": [u.model_dump(mode="json") for u in users]},
    }

    class KV:
        async def get_strict(self, ns: str, key: str) -> Any:
            from app.constants import USERS_KEY, USERS_NS

            if (ns, key) == (USERS_NS, USERS_KEY):
                return docs[("users", "entries")]
            return None

    prefs = Preferences()
    prefs.rbac.enabled = True
    state = SimpleNamespace(
        auth=SimpleNamespace(is_enabled=True), kv=KV(), prefs=prefs,
        secrets=SimpleNamespace(auth_admin_username="Admin"),
    )
    close = [a.username for a in await batch_inbox.eligible_audience(state, "cases", "close")]
    assert close == ["Admin", "boss", "tier2"]
    batch = [a.username for a in await batch_inbox.eligible_batch_audience(state)]
    assert batch == [a.username for a in await batch_inbox.eligible_audience(state, "models", "read")]
    state.prefs.rbac.enabled = False
    assert [a.username for a in await batch_inbox.eligible_audience(state, "cases", "close")] == [
        "Admin", "boss", "tier1", "tier2",
    ]
    state.auth = SimpleNamespace(is_enabled=False)
    assert [a.username for a in await batch_inbox.eligible_audience(state, "cases", "close")] == ["default"]


# --------------------------------------------------------------------------- #
# The routes (sign-in on, RBAC on)
# --------------------------------------------------------------------------- #
_JWT = "round15-wp5-review-secret"


def _client() -> TestClient:
    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="", anthropic_api_key=None,
        openai_api_key=None, auth_enabled=True, auth_jwt_secret=_JWT, auth_seed_admin=True,
    )
    mock = MockProvider()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(),
                                provider_overrides={"anthropic": mock, "openai": mock, "mock": mock})
        await state.startup(start_poller=False)
        prefs = state.prefs.model_copy(deep=True)
        prefs.setup_complete = True
        prefs.rbac.enabled = True
        await state.update_prefs(prefs)
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(monolith_router, dependencies=[Depends(require_auth)])
    api.include_router(review_router, dependencies=[Depends(require_auth)])
    mount_moved_routers(api, dependencies=[Depends(require_auth)])
    return TestClient(api)


def _login(c: TestClient, user: str, password: str) -> dict[str, str]:
    response = c.post("/api/auth/login", json={"username": user, "password": password})
    assert response.status_code == 200, response.text
    # Each request names its caller by its bearer token only, never the last cookie.
    c.cookies.clear()
    return {"Authorization": f"Bearer {response.json()['token']}"}


@pytest.fixture
def env():
    c = _client()
    with c:
        admin = _login(c, "Admin", "Admin@123")
        for name, role in (("t1", "analyst_tier1"), ("t2", "analyst_tier2"), ("boss", "soc_manager"),
                           ("aud", "auditor")):
            r = c.post("/api/users", json={"username": name, "password": f"{name}-password-1", "role": role},
                       headers=admin)
            assert r.status_code in (200, 201), r.text
        heads = {"admin": admin}
        for name in ("t1", "t2", "boss", "aud"):
            heads[name] = _login(c, name, f"{name}-password-1")
        yield c, c.app.state.tlsoc, heads


def _put(c: TestClient, state: AppState, case: Case) -> None:
    c.portal.call(state.cases.save, case)


def _sample(c: TestClient, state: AppState, case: Case, *, when: datetime | None = None) -> str:
    """Put ``case`` in the real ledger as the sampler would (pending)."""
    decision = acr.select_for_review(ReviewLedger(), case, _cfg(sample_rate=1.0), now=when or NOW, tz="UTC",
                                     score=0.0)
    entry = acr.new_entry(case, decision, when or datetime.now(timezone.utc))

    def add(ledger: ReviewLedger) -> ReviewLedger:
        ledger.add(entry, now=datetime.now(timezone.utc), expiry_days=7)
        return ledger

    c.portal.call(state.real_auto_close_review.update, add)
    return entry.review_id


def _ledger(c: TestClient, state: AppState) -> ReviewLedger:
    return c.portal.call(state.real_auto_close_review.load)


def test_a_sampled_review_records_a_marked_grade_and_never_touches_the_decision(env) -> None:
    c, state, h = env
    case = _agent_closed("case-rv-1", number="CASE-0101")
    _put(c, state, case)
    review_id = _sample(c, state, case)
    r = c.post("/api/cases/case-rv-1/review", headers=h["t2"], json={
        "classification": "benign", "note": "Looks like the weekly scanner.", "accuracy": 0.8,
        "elapsed_ms": 42_000,
    })
    assert r.status_code == 200, r.text
    assert r.json() == {"agrees": True, "can_reopen": True, "sampled": True, "review_id": review_id}
    stored: Case = c.portal.call(state.cases.get, "case-rv-1")
    assert stored.status == CaseStatus.CLOSED and stored.decision_by == DecisionBy.AGENT
    assert stored.disposition == Disposition.FALSE_POSITIVE
    (grade,) = stored.feedback
    assert grade.analyst == "t2" and grade.actual_outcome == "false_positive" and grade.assessment == "agree"
    assert grade.origin == "auto_close_review" and grade.review_id == review_id
    assert grade.comment == "Looks like the weekly scanner." and grade.accuracy == 0.8
    assert grade.reasoning_quality == 0.0 and grade.ai_verdict == "FALSE_POSITIVE"
    (event,) = [e for e in stored.history if e.get("event") == "auto_close_review"]
    assert event["review_id"] == review_id and event["feedback_ts"] == grade.ts and event["analyst"] == "t2"
    assert event["agrees"] is True
    assert is_review_grade(stored, grade)
    # Rollback-safe: without the entry marker the history event still names it.
    plain = grade.model_copy(update={"origin": "", "review_id": ""})
    assert is_review_grade(stored, plain)
    entry = _ledger(c, state).entry_by_id(review_id)
    assert entry.state == "completed" and entry.reviewer == "t2" and entry.classification == "benign"
    assert entry.agrees is True and entry.elapsed_ms == 42_000
    rows = c.portal.call(lambda: state.audit.records_for_case("case-rv-1"))
    (row,) = [x for x in rows if x.get("action") == "case.review_recorded"]
    assert row["actor"] == "t2" and row["actor_type"] == "human" and row["outcome"] == "success"
    assert row["target"]["label"] == "CASE-0101"
    assert "scanner" not in row["result_summary"] and review_id in row["result_summary"]
    changes = {x["field"]: x["after"] for x in row["changes"]}
    assert changes["review.classification"] == "benign" and changes["review.agrees"] == "true"
    # A second review of a completed entry.
    again = c.post("/api/cases/case-rv-1/review", headers=h["t2"], json={"classification": "benign"})
    assert again.status_code == 409 and again.json()["detail"]["code"] == "review_already_recorded"


def test_an_unsampled_review_is_an_ordinary_grade(env) -> None:
    c, state, h = env
    _put(c, state, _agent_closed("case-rv-2"))
    r = c.post("/api/cases/case-rv-2/review", headers=h["t2"], json={"classification": "false_positive"})
    assert r.status_code == 200 and r.json()["sampled"] is False and r.json()["review_id"] is None
    stored: Case = c.portal.call(state.cases.get, "case-rv-2")
    (grade,) = stored.feedback
    assert grade.origin == "" and grade.review_id == ""
    assert not [e for e in stored.history if e.get("event") == "auto_close_review"]
    assert not is_review_grade(stored, grade)
    # An ordinary grade may be followed by another one.
    assert c.post("/api/cases/case-rv-2/review", headers=h["t2"], json={"classification": "unsure"}).status_code == 200


def test_only_an_agent_closed_terminal_case_can_be_reviewed(env) -> None:
    c, state, h = env
    open_case = _agent_closed("case-rv-open")
    open_case.status = CaseStatus.OPEN
    analyst = _agent_closed("case-rv-human", first_status="needs_human", first_by="system")
    analyst.decision_by = DecisionBy.ANALYST
    for case in (open_case, analyst):
        _put(c, state, case)
        r = c.post(f"/api/cases/{case.case_id}/review", headers=h["t2"], json={"classification": "benign"})
        assert r.status_code == 409 and r.json()["detail"]["code"] == "review_not_agent_closed"
    missing = c.post("/api/cases/nope/review", headers=h["t2"], json={"classification": "benign"})
    assert missing.status_code == 404
    # A reopened agent close keeps its first decision record but is no longer terminal.
    reopened = _agent_closed("case-rv-reopened")
    reopened.status = CaseStatus.OPEN
    reopened.decision_by = DecisionBy.ANALYST
    _put(c, state, reopened)
    r = c.post("/api/cases/case-rv-reopened/review", headers=h["t2"], json={"classification": "benign"})
    assert r.status_code == 409


@pytest.mark.parametrize("body", [
    {"classification": "maybe"},
    {"classification": "benign", "accuracy": 0},
    {"classification": "benign", "accuracy": 1.5},
    {"classification": "benign", "elapsed_ms": -1},
    {"classification": "benign", "elapsed_ms": 86_400_001},
    {"classification": "benign", "note": "x" * 1001},
    {"classification": "benign", "status": "open"},
])
def test_the_review_body_is_validated(env, body) -> None:
    c, state, h = env
    _put(c, state, _agent_closed("case-rv-val"))
    assert c.post("/api/cases/case-rv-val/review", headers=h["t2"], json=body).status_code == 422


def test_the_review_needs_cases_write(env) -> None:
    c, state, h = env
    _put(c, state, _agent_closed("case-rv-aud"))
    r = c.post("/api/cases/case-rv-aud/review", headers=h["aud"], json={"classification": "benign"})
    assert r.status_code == 403
    assert c.get("/api/auto-close-review/summary", headers=h["aud"]).status_code == 200
    assert c.get("/api/metrics/auto-close-review", headers=h["aud"]).status_code == 200


def test_the_audit_row_comes_first_and_nothing_changes_without_it(env, monkeypatch) -> None:
    c, state, h = env
    case = _agent_closed("case-rv-audit")
    _put(c, state, case)
    review_id = _sample(c, state, case)
    audit = state.audit

    async def refuse(**_kw: Any) -> None:
        raise RuntimeError("audit store down")

    monkeypatch.setattr(audit, "record_strict", refuse)
    r = c.post("/api/cases/case-rv-audit/review", headers=h["t2"], json={"classification": "benign"})
    assert r.status_code == 503 and r.json()["detail"]["code"] == "audit_unavailable"
    stored: Case = c.portal.call(state.cases.get, "case-rv-audit")
    assert stored.feedback == [] and _ledger(c, state).entry_by_id(review_id).state == "pending"
    rows = c.portal.call(lambda: state.audit.records_for_case("case-rv-audit"))
    assert [x["action"] for x in rows if x.get("action", "").startswith("case.review")] == ["case.review_record_failed"]


def test_a_failed_ledger_write_is_repaired_from_the_case_history(env, monkeypatch) -> None:
    c, state, h = env
    case = _agent_closed("case-rv-repair")
    _put(c, state, case)
    review_id = _sample(c, state, case)
    store = state.real_auto_close_review
    original = store.update
    calls = {"n": 0}

    async def failing(change: Any, **kw: Any) -> Any:
        calls["n"] += 1
        raise ReviewLedgerUnavailable("down")

    monkeypatch.setattr(store, "update", failing)
    r = c.post("/api/cases/case-rv-repair/review", headers=h["t1"], json={"classification": "false_positive"})
    assert r.status_code == 200 and calls["n"] == 2  # retried once; the review stands
    monkeypatch.setattr(store, "update", original)
    assert _ledger(c, state).entry_by_id(review_id).state == "pending"
    # A later read (the summary) repairs it from the history event.
    summary = c.get("/api/auto-close-review/summary", headers=h["t1"]).json()
    assert summary["pending"] == 0
    entry = _ledger(c, state).entry_by_id(review_id)
    assert entry.state == "completed" and entry.reviewer == "t1" and entry.classification == "false_positive"
    # And the review cannot be recorded twice.
    again = c.post("/api/cases/case-rv-repair/review", headers=h["t1"], json={"classification": "benign"})
    assert again.status_code == 409


def test_a_disagreement_from_someone_who_cannot_reopen_reaches_who_can(env) -> None:
    c, state, h = env
    case = _agent_closed("case-rv-dis", number="CASE-0202")
    _put(c, state, case)
    _sample(c, state, case)
    # boss mutes Assignment in the Inbox: the category preference is honoured.
    c.portal.call(lambda: state.notif_prefs.patch("boss", categories={"assignment": {"enabled": False}}))
    r = c.post("/api/cases/case-rv-dis/review", headers=h["t1"], json={
        "classification": "true_positive", "note": "secret-note-sentinel"})
    assert r.status_code == 200 and r.json() == {
        "agrees": False, "can_reopen": False, "sampled": True, "review_id": r.json()["review_id"]}
    inbox = state.inbox
    for user, expected in (("t2", 1), ("Admin", 1), ("boss", 0), ("t1", 0), ("aud", 0)):
        items = [n for n in c.portal.call(inbox.list_for_user, user)[0] if n.category == "assignment"]
        assert len(items) == expected, user
        for item in items:
            assert item.case_id == "case-rv-dis" and "CASE-0202" in item.title
            assert "secret-note-sentinel" not in item.title + item.body
    # A disagreement by someone who can reopen notifies nobody.
    other = _agent_closed("case-rv-dis2")
    _put(c, state, other)
    r = c.post("/api/cases/case-rv-dis2/review", headers=h["t2"], json={"classification": "true_positive"})
    assert r.json()["can_reopen"] is True
    assert len([n for n in c.portal.call(inbox.list_for_user, "Admin")[0] if n.category == "assignment"]) == 1


def test_a_repeated_disagreement_on_an_unsampled_case_notifies_once(env) -> None:
    """An agent-closed case that was not sampled takes any number of reviews (each an
    ordinary grade, D6.6), so a person who cannot close cases could re-review one case to
    fill the Inbox of everyone who can and push their real items out of its ring. Every
    review is still recorded, but the closers hear about one person's disagreement with
    a case once; another person's first disagreement still reaches them."""
    c, state, h = env
    _put(c, state, _agent_closed("case-rv-flood", number="CASE-0404"))
    inbox = state.inbox

    def items(user: str) -> list[Any]:
        return [n for n in c.portal.call(inbox.list_for_user, user)[0]
                if n.category == "assignment" and n.case_id == "case-rv-flood"]

    for classification in ("true_positive", "true_positive", "unsure", "true_positive"):
        r = c.post("/api/cases/case-rv-flood/review", headers=h["t1"], json={"classification": classification})
        assert r.status_code == 200, r.text
        assert r.json()["sampled"] is False
    assert len(items("t2")) == 1 and len(items("Admin")) == 1 and len(items("boss")) == 1
    stored: Case = c.portal.call(state.cases.get, "case-rv-flood")
    assert len(stored.feedback) == 4  # every review is recorded
    rows = c.portal.call(lambda: state.audit.records_for_case("case-rv-flood"))
    assert len([x for x in rows if x.get("action") == "case.review_recorded"]) == 4
    assert len([x for x in rows if x.get("action_type") == "inapp_notify"]) == 3
    # An agreement first, then a disagreement by someone else, is their first one.
    made = c.post("/api/users", headers=h["admin"],
                  json={"username": "t1b", "password": "t1b-password-1", "role": "analyst_tier1"})
    assert made.status_code in (200, 201), made.text
    t1b = _login(c, "t1b", "t1b-password-1")
    assert c.post("/api/cases/case-rv-flood/review", headers=t1b,
                  json={"classification": "false_positive"}).json()["agrees"] is True
    assert len(items("t2")) == 1
    assert c.post("/api/cases/case-rv-flood/review", headers=t1b,
                  json={"classification": "true_positive"}).json()["agrees"] is False
    assert len(items("t2")) == 2 and len(items("Admin")) == 2


def test_the_summary_counts_pending_open_disagreements_and_today(env) -> None:
    c, state, h = env
    now = datetime.now(timezone.utc)
    cases = [_agent_closed(f"case-sm-{i}") for i in range(4)]
    for case in cases:
        _put(c, state, case)
        _sample(c, state, case, when=now)
    stale = _agent_closed("case-sm-old")
    _put(c, state, stale)
    _sample(c, state, stale, when=now - timedelta(days=9))
    c.post("/api/cases/case-sm-0/review", headers=h["t2"], json={"classification": "true_positive"})
    c.post("/api/cases/case-sm-1/review", headers=h["t2"], json={"classification": "true_positive"})
    c.post("/api/cases/case-sm-1/action", headers=h["t2"], json={"action": "reopen", "review_via": "auto_close_review"})
    reopened = c.portal.call(state.cases.get, "case-sm-1")
    assert reopened.status == CaseStatus.OPEN
    body = c.get("/api/auto-close-review/summary", headers=h["t1"]).json()
    # Two still pending (the nine-day-old one has expired), one disagreement whose case
    # is still closed (the other was reopened), four sampled today.
    assert body == {"enabled": True, "pending": 2, "disagreed_open": 1, "sampled_today": 4, "daily_cap": 10}


def test_the_cases_list_review_scope(env) -> None:
    c, state, h = env
    now = datetime.now(timezone.utc)
    for i, rule in enumerate(("r-1", "r-2", "r-1")):
        case = _agent_closed(f"case-q-{i}", rule=rule)
        _put(c, state, case)
        _sample(c, state, case, when=now - timedelta(minutes=10 - i))
    old = _agent_closed("case-q-old")
    _put(c, state, old)
    _sample(c, state, old, when=now - timedelta(days=10))
    _put(c, state, _agent_closed("case-q-unsampled"))
    c.post("/api/cases/case-q-0/review", headers=h["t2"], json={"classification": "true_positive"})
    c.post("/api/cases/case-q-1/review", headers=h["t2"], json={"classification": "benign"})

    def ids(**params: Any) -> tuple[list[str], dict[str, Any]]:
        r = c.get("/api/cases", headers=h["t1"], params=params)
        assert r.status_code == 200, r.text
        body = r.json()
        return [x["case_id"] for x in body["cases"]], body

    pending, body = ids(review="pending")
    assert pending == ["case-q-2"] and body["total"] == 1 and body["review_applied"] == "pending"
    completed, body = ids(review="completed", sort_field="created_at", sort_order="asc")
    assert sorted(completed) == ["case-q-0", "case-q-1"] and body["total"] == 2
    assert ids(review="disagreed")[0] == ["case-q-0"]
    assert ids(review="expired")[0] == ["case-q-old"]
    # The other queue filters apply on top, and the total stays exact.
    filtered, body = ids(review="completed", rule="r-2")
    assert filtered == ["case-q-1"] and body["total"] == 1 and body["rule_applied"] == "r-2"
    paged, body = ids(review="completed", limit=1, offset=1)
    assert len(paged) == 1 and body["total"] == 2
    assert ids(review="completed", status="open")[0] == []
    bad = c.get("/api/cases", headers=h["t1"], params={"review": "everything"})
    assert bad.status_code == 400
    # A request without ``review`` is unchanged.
    plain = c.get("/api/cases", headers=h["t1"]).json()
    assert "review_applied" not in plain and plain["total"] == 5


def test_the_metrics_module(env, monkeypatch) -> None:
    c, state, h = env
    now = datetime.now(timezone.utc)
    for i in range(3):
        case = _agent_closed(f"case-m-{i}", rule="rule-m", decided=now - timedelta(hours=2),
                             number=f"CASE-{i:04d}")
        _put(c, state, case)
        _sample(c, state, case, when=now - timedelta(hours=1))
    _put(c, state, _agent_closed("case-m-unsampled", decided=now - timedelta(hours=3)))
    c.post("/api/cases/case-m-0/review", headers=h["t2"], json={"classification": "true_positive",
                                                               "elapsed_ms": 30_000})
    c.post("/api/cases/case-m-1/review", headers=h["t2"], json={"classification": "benign", "elapsed_ms": 90_000})
    r = c.get("/api/metrics/auto-close-review", headers=h["t1"], params={"window": "now-7d"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["sampled"], body["reviewed"], body["pending"], body["expired"]) == (3, 2, 1, 0)
    assert body["agreement"]["status"] == "insufficient" and body["agreement"]["rate"] is None
    assert body["agreement"]["interval"] is None and body["agreement"]["reviews"] == 2
    assert body["statement"] == (
        "Agreement describes the sampled cases only, unweighted. It is not an estimate of auto-close precision."
    )
    assert body["missed_threats"]["count"] == 1 and body["missed_threats"]["cases"][0]["case_id"] == "case-m-0"
    assert body["by_rule"] == [{"rule": "rule-m", "sampled": 3, "reviewed": 2, "agreed": 1, "disagreed": 1}]
    assert body["time_spent_ms"] == {"median": 60_000.0, "reviews": 2}
    assert body["eligible"]["count"] == 4 and body["eligible"]["complete"] is True
    assert len(body["by_day"]) in (7, 8) and sum(d["eligible"] for d in body["by_day"]) == 4
    assert c.get("/api/metrics/auto-close-review", headers=h["t1"], params={"window": "bogus window"}).status_code == 400


def test_agreement_has_an_interval_only_from_thirty_reviews() -> None:
    ledger = ReviewLedger()
    for i in range(30):
        ledger.entries.append(ReviewEntry(
            review_id=f"r{i}", case_id=f"c{i}", sampled_at=NOW.isoformat(), day="2026-11-23",
            state="completed", agrees=i < 27, classification="false_positive" if i < 27 else "true_positive",
            ai_verdict="FALSE_POSITIVE", completed_at=NOW.isoformat(),
        ))
    out = acr.review_metrics(ledger, _cfg(), start=NOW - timedelta(days=1), end=NOW + timedelta(hours=1),
                             now=NOW, tz="UTC")
    assert out["agreement"]["status"] == "ok" and out["agreement"]["rate"] == 0.9
    low, high = out["agreement"]["interval"]["low"], out["agreement"]["interval"]["high"]
    assert 0.73 < low < 0.75 and 0.96 < high < 0.97
    assert out["missed_threats"]["count"] == 3
    ledger.entries.pop()
    out = acr.review_metrics(ledger, _cfg(), start=None, end=NOW + timedelta(hours=1), now=NOW, tz="UTC")
    assert out["agreement"]["status"] == "insufficient" and out["agreement"]["interval"] is None


def test_eligible_closes_count_by_first_agent_decision_day() -> None:
    first = _agent_closed("a", decided=NOW - timedelta(days=1))
    reclosed = _agent_closed("b", first_status="needs_human", first_by="system", decided=NOW)
    reclosed.history.append({"ts": NOW.isoformat(), "event": "decision", "status": "closed", "decision_by": "agent"})
    out = acr.eligible_closes_by_day([first, reclosed], start=NOW - timedelta(days=7), end=NOW + timedelta(hours=1),
                                     tz="UTC")
    assert out == {"2026-11-22": 1}


# --------------------------------------------------------------------------- #
# Statistics: the review grade feeds ground truth, not agent agreement (D6.8)
# --------------------------------------------------------------------------- #
def test_a_review_grade_is_ground_truth_and_out_of_feedback_stats(env) -> None:
    from app.engine.analyst_outcomes import analyst_confirmed_outcome
    from app.engine.metrics import feedback_stats

    c, state, h = env
    case = _agent_closed("case-st-1")
    _put(c, state, case)
    _sample(c, state, case)
    c.post("/api/cases/case-st-1/review", headers=h["t2"], json={"classification": "true_positive"})
    stored: Case = c.portal.call(state.cases.get, "case-st-1")
    assert analyst_confirmed_outcome(stored) is not None
    stats = feedback_stats([stored])
    assert stats["graded_cases"] == 0 and stats["feedback_count"] == 0, stats


# --------------------------------------------------------------------------- #
# Reset, export, Demo
# --------------------------------------------------------------------------- #
async def test_the_cases_reset_clears_the_ledger(app_state: AppState) -> None:
    from app.engine.reset import reset_service

    store = app_state.real_auto_close_review
    case = _agent_closed(_low_ids(1)[0])
    await _sampler(store, _Audit())(case, _prefs())
    receipt = await reset_service(app_state, "cases")
    assert "kv:auto_close_review:1" in receipt["cleared"]
    assert (await store.load()).entries == []


async def test_the_export_lists_the_ledger_metadata(app_state: AppState) -> None:
    from app.api import routes_export

    store = app_state.real_auto_close_review
    await _sampler(store, _Audit())(_agent_closed(_low_ids(1)[0]), _prefs())
    groups, meta = await routes_export._collect_scope("automation", app_state, 100)
    (row,) = groups["auto_close_review"]
    assert row["state"] == "pending" and "note" not in row and meta["count"] >= 1


async def test_demo_seeds_three_pending_two_agreeing_one_disagreeing(app_state: AppState) -> None:
    await app_state.enable_demo(mode="seeded")
    try:
        ledger = await app_state.auto_close_review.load()
        now = datetime.now(timezone.utc)
        states = [e.state_at(now, 7) for e in ledger.entries]
        assert len(ledger.entries) == 6 and states.count("pending") == 3
        done = [e for e in ledger.entries if e.state == "completed"]
        assert sorted(e.agrees for e in done) == [False, True, True]
        assert all(e.reviewer in ("asha.iyer", "farhan.qureshi", "meera.pillai") for e in done)
        for entry in done:
            case = await app_state.cases.get(entry.case_id)
            grade = case.feedback[-1]
            assert grade.origin == "auto_close_review" and is_review_grade(case, grade)
            assert case.status == CaseStatus.CLOSED and case.decision_by == DecisionBy.AGENT
        rows = await app_state.audit.records(limit=5000)
        assert sum(1 for r in rows if r.get("action") == "case.review_requested") == 6
        recorded = [r for r in rows if r.get("action") == "case.review_recorded"]
        assert len(recorded) == 3 and all(r["actor_type"] == "human" and r["outcome"] == "success" for r in recorded)
        # The real ledger and the control audit are untouched.
        assert (await app_state.real_auto_close_review.load()).entries == []
        control = await app_state.control_audit.records(limit=5000)
        assert not any(str(r.get("action") or "").startswith("case.review") for r in control)
    finally:
        await app_state.disable_demo()


async def test_review_writes_land_in_the_demo_sinks_while_demo_mode_is_on(app_state: AppState) -> None:
    from app.api.routes_auto_close_review import ReviewBody, record_auto_close_review

    class _Req:
        app = SimpleNamespace(state=SimpleNamespace(tlsoc=app_state))
        headers: dict[str, str] = {}
        cookies: dict[str, str] = {}
        state = SimpleNamespace()
        client = None
        url = SimpleNamespace(path="/api/cases/x/review")
        method = "POST"

    await app_state.enable_demo(mode="seeded")
    try:
        ledger = await app_state.auto_close_review.load()
        pending = next(e for e in ledger.entries if e.state == "pending")
        result = await record_auto_close_review(pending.case_id, ReviewBody(classification="benign"), _Req(), app_state)
        assert result.sampled is True
        assert (await app_state.auto_close_review.load()).entry_by_id(pending.review_id).state == "completed"
        demo_rows = await app_state.audit.records(limit=5000)
        assert any(r.get("action") == "case.review_recorded" and r.get("case_id") == pending.case_id for r in demo_rows)
        control = await app_state.control_audit.records(limit=5000)
        assert not any(r.get("case_id") == pending.case_id for r in control)
    finally:
        await app_state.disable_demo()


# --------------------------------------------------------------------------- #
# Catalog and the static guards (§3.6, D7.5)
# --------------------------------------------------------------------------- #
def test_the_requested_row_is_agent_activity_and_the_recorded_row_people() -> None:
    from app.audit import events

    requested = events.classify({"action": "case.review_requested", "action_type": "automation"})
    recorded = events.classify({"action": "case.review_recorded", "action_type": "feedback"})
    assert requested.category == "system" and recorded.category == "case_work"
    assert not events.in_people_scope({"action": "case.review_requested", "actor_type": "system"})


def _imports(path: Path) -> list[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    out: list[str] = []
    rel = path.relative_to(APP).with_suffix("")
    package = list(rel.parts[:-1])
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            out.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            base = package[: len(package) - (node.level - 1)] if node.level else []
            module = ".".join([*base, node.module] if node.module else base)
            if node.level:
                module = "app." + module if module else "app"
            out.append(module)
            out.extend(f"{module}.{alias.name}" for alias in node.names)
    return out


def _app_files() -> list[Path]:
    return [p for p in APP.rglob("*.py") if "__pycache__" not in p.parts]


def test_the_review_store_and_engine_never_reach_model_facing_code() -> None:
    banned_from = [p for p in _app_files() if p.relative_to(APP).parts[0] in ("agents", "tools")] + [
        APP / "engine" / "report_digest.py", APP / "engine" / "chat_starters.py", APP / "agents" / "standup.py",
    ]
    for path in banned_from:
        for name in _imports(path):
            assert not name.startswith("app.stores.auto_close_review"), f"{path} imports the review ledger"
    # engine/auto_close_review only from the pipeline, the state, the Demo runtime, its
    # route, and (judgement call, recorded in the WP5 report) the Demo seed that writes
    # entries as the sampler does.
    allowed = {
        "agents/pipeline.py", "state.py", "engine/demo_runtime.py", "api/routes_auto_close_review.py",
        "engine/demo_generator.py",
    }
    for path in _app_files():
        rel = path.relative_to(APP).as_posix()
        if rel == "engine/auto_close_review.py":
            continue
        if any(name.startswith("app.engine.auto_close_review") for name in _imports(path)):
            assert rel in allowed, f"{rel} imports engine.auto_close_review"


@pytest.mark.parametrize("rel", [
    "engine/auto_close_review.py", "engine/review_origin.py", "api/routes_auto_close_review.py",
    "stores/auto_close_review.py",
])
def test_no_review_module_imports_the_decision_core(rel) -> None:
    for line in (APP / rel).read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped.startswith(("import ", "from ")):
            assert "case_manager" not in stripped, f"{rel}: {line!r}"


def test_the_decision_core_never_names_the_review() -> None:
    src = (APP / "engine" / "case_manager.py").read_text(encoding="utf-8")
    for token in ("auto_close_review", "review_sampler", "review_id", "review_via"):
        assert token not in src


async def test_the_ledger_round_trips_on_the_sql_and_elasticsearch_kv_stores() -> None:
    from app.stores.memory import EsKVStore
    from app.stores.sql import SqlKVStore, build_async_engine, create_all

    case = _agent_closed(_low_ids(1)[0])
    engine = build_async_engine("sqlite+aiosqlite:///:memory:")
    await create_all(engine)
    try:
        for kv in (SqlKVStore(engine), EsKVStore(InMemoryESClient())):
            store = AutoCloseReviewStore(kv)
            audit = _Audit()
            assert await _sampler(store, audit)(case, _prefs()) is True
            ledger = await AutoCloseReviewStore(kv).load()
            assert [e.case_id for e in ledger.entries] == [case.case_id] and ledger.rev == 1
            # Once per case on every backend, and the compare-and-set holds.
            assert await _sampler(store, audit)(case, _prefs()) is False
            assert await store.clear() == 1
            assert (await store.load()).entries == []
    finally:
        await engine.dispose()


# --------------------------------------------------------------------------- #
# Review fixes (the WP5 independent review)
# --------------------------------------------------------------------------- #
def test_the_review_frame_is_a_registered_live_channel() -> None:
    """D6.5: the ``case.review`` nudge is named in the one SSE registry (and so in the
    browser's mirror, ``useEventStream.ts``): a channel outside it is never delivered to
    a listener."""
    from app.realtime import CASE_REVIEW_EVENT, SSE_EVENT_TYPES

    assert acr.REVIEW_EVENT == CASE_REVIEW_EVENT == "case.review"
    assert CASE_REVIEW_EVENT in SSE_EVENT_TYPES
    src = (APP / "engine" / "auto_close_review.py").read_text(encoding="utf-8")
    assert '"case.review"' not in src  # the registry constant, never a second literal


async def test_a_queue_subscriber_receives_a_typed_case_review_frame() -> None:
    """End to end over the bus: a ``cases`` subscriber gets ``event: case.review`` with
    ids and the state only, the token the browser's listener matches."""
    import asyncio

    from app.realtime import EventBus

    bus = EventBus(heartbeat_seconds=60)
    frames: list[str] = []

    async def consume() -> None:
        async for chunk in bus.subscribe(["cases"], user=None):
            frames.append(chunk.decode("utf-8"))
            if len(frames) >= 2:  # ": connected" + the first real frame
                break

    task = asyncio.create_task(consume())
    await asyncio.sleep(0)
    acr.publish_review_frame(bus, "case-0042", "acr-1", "pending")
    await asyncio.wait_for(task, timeout=5)
    assert "event: case.review\n" in frames[1]
    payload = json.loads(frames[1].split("data: ", 1)[1].split("\n", 1)[0])
    assert payload == {"case_id": "case-0042", "review_id": "acr-1", "state": "pending"}
    bus.clear()


class _DirectRequest:
    """A request for an in-process call of the review route with sign-in off."""

    def __init__(self, state: AppState) -> None:
        self.app = SimpleNamespace(state=SimpleNamespace(tlsoc=state))
        self.headers: dict[str, str] = {}
        self.cookies: dict[str, str] = {}
        self.state = SimpleNamespace()
        self.client = None
        self.url = SimpleNamespace(path="/api/cases/x/review")
        self.method = "POST"


async def _sample_direct(state: AppState, case: Case) -> str:
    decision = acr.select_for_review(ReviewLedger(), case, _cfg(sample_rate=1.0), now=NOW, tz="UTC", score=0.0)
    entry = acr.new_entry(case, decision, datetime.now(timezone.utc))

    def add(ledger: ReviewLedger) -> ReviewLedger:
        ledger.add(entry, now=datetime.now(timezone.utc), expiry_days=7)
        return ledger

    await state.real_auto_close_review.update(add)
    return entry.review_id


async def test_two_concurrent_reviews_of_one_sampled_case_record_one(
    app_state: AppState, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """D6.6: a double submission (two requests in flight at once) records ONE review:
    the second answers 409 review_already_recorded, the case keeps exactly one grade and
    one history event, and the ledger names the review that was saved. Without the
    ledger lock both passed the checks and the second case save dropped the first grade."""
    import asyncio

    from fastapi import HTTPException

    from app.api.routes_auto_close_review import ReviewBody, record_auto_close_review

    case = _agent_closed("case-race-1")
    await app_state.cases.save(case)
    review_id = await _sample_direct(app_state, case)
    store = app_state.cases
    original_save = store.save

    async def slow_save(value: Case) -> Any:
        await asyncio.sleep(0.05)  # widen the read, save window
        return await original_save(value)

    monkeypatch.setattr(store, "save", slow_save)
    results = await asyncio.gather(
        record_auto_close_review("case-race-1", ReviewBody(classification="benign", note="first"),
                                 _DirectRequest(app_state), app_state),
        record_auto_close_review("case-race-1", ReviewBody(classification="true_positive", note="second"),
                                 _DirectRequest(app_state), app_state),
        return_exceptions=True,
    )
    ok = [r for r in results if not isinstance(r, BaseException)]
    refused = [r for r in results if isinstance(r, HTTPException)]
    assert len(ok) == 1 and len(refused) == 1, results
    assert refused[0].status_code == 409 and refused[0].detail["code"] == "review_already_recorded"
    stored = await app_state.cases.get("case-race-1")
    assert len(stored.feedback) == 1
    assert len([e for e in stored.history if e.get("event") == "auto_close_review"]) == 1
    entry = (await app_state.real_auto_close_review.load()).entry_by_id(review_id)
    assert entry.state == "completed"
    saved = stored.feedback[0]
    assert entry.classification == ("benign" if saved.assessment == "agree" else "true_positive")
    rows = await app_state.audit.records_for_case("case-race-1")
    assert len([r for r in rows if r.get("action") == "case.review_recorded"]) == 1


def test_an_extra_delivery_channel_never_mutes_the_inbox_item(env) -> None:
    """D6.9: the Inbox preferences list the EXTRA channels of a category (email and the
    rest) and never ``in_app``, which is always on. A person who added email to
    Assignment still gets the disagreement item; only switching Assignment off mutes it."""
    c, state, h = env
    case = _agent_closed("case-rv-chan", number="CASE-0303")
    _put(c, state, case)
    _sample(c, state, case)
    c.portal.call(lambda: state.notif_prefs.patch(
        "t2", categories={"assignment": {"enabled": True, "channels": ["email"]}}))
    c.portal.call(lambda: state.notif_prefs.patch("boss", categories={"assignment": {"enabled": False}}))
    r = c.post("/api/cases/case-rv-chan/review", headers=h["t1"], json={"classification": "true_positive"})
    assert r.status_code == 200 and r.json()["agrees"] is False
    inbox = state.inbox
    for user, expected in (("t2", 1), ("Admin", 1), ("boss", 0)):
        items = [n for n in c.portal.call(inbox.list_for_user, user)[0]
                 if n.category == "assignment" and n.case_id == "case-rv-chan"]
        assert len(items) == expected, user


def test_the_summary_counts_a_repaired_disagreement_on_the_same_read(env, monkeypatch) -> None:
    """The summary repairs a pending entry from its case's history and counts it at
    once: a repaired disagreement on a still-closed case is an open disagreement."""
    c, state, h = env
    case = _agent_closed("case-sm-repair")
    _put(c, state, case)
    _sample(c, state, case, when=datetime.now(timezone.utc))
    store = state.real_auto_close_review
    original = store.update

    async def failing(change: Any, **kw: Any) -> Any:
        raise ReviewLedgerUnavailable("down")

    monkeypatch.setattr(store, "update", failing)
    r = c.post("/api/cases/case-sm-repair/review", headers=h["t2"], json={"classification": "true_positive"})
    assert r.status_code == 200 and r.json()["agrees"] is False
    monkeypatch.setattr(store, "update", original)
    body = c.get("/api/auto-close-review/summary", headers=h["t1"]).json()
    assert body["pending"] == 0 and body["disagreed_open"] == 1


def test_ledger_completeness_follows_the_newest_dropped_sample() -> None:
    """The ring drops settled entries first, so a dropped sample can be newer than the
    oldest kept (pending) one. The ledger keeps the newest dropped sample time, and a
    window that starts at or before it is not complete; one after it is."""
    ledger = ReviewLedger()
    base = NOW - timedelta(days=5)
    # The oldest entry is still pending (inside its expiry); the rest are completed.
    ledger.entries.append(ReviewEntry(review_id="p0", case_id="cp0", sampled_at=base.isoformat(),
                                      day=base.date().isoformat()))
    for i in range(1, LEDGER_MAX_ENTRIES):
        at = base + timedelta(minutes=i)
        ledger.entries.append(ReviewEntry(review_id=f"r{i}", case_id=f"c{i}", sampled_at=at.isoformat(),
                                          day=at.date().isoformat(), state="completed",
                                          completed_at=at.isoformat(), agrees=True))
    full = acr.review_metrics(ledger, _cfg(), start=None, end=NOW, now=NOW, tz="UTC")
    assert full["ledger_complete"] is True  # a full ring that never dropped anything
    newest_dropped = base + timedelta(minutes=3)
    for n in range(3):
        ledger.add(ReviewEntry(review_id=f"n{n}", case_id=f"cn{n}", sampled_at=NOW.isoformat(),
                               day=NOW.date().isoformat()), now=NOW, expiry_days=7)
    ids = {e.review_id for e in ledger.entries}
    assert "p0" in ids and not {"r1", "r2", "r3"} & ids and "r4" in ids
    assert ledger.evicted_instant() == newest_dropped
    # Starts after the kept pending entry but before the dropped ones: not complete
    # (the old rule, "starts before the oldest kept entry", called it complete).
    between = base + timedelta(minutes=2)
    out = acr.review_metrics(ledger, _cfg(), start=between, end=NOW + timedelta(hours=1), now=NOW, tz="UTC")
    assert out["ledger_complete"] is False
    after = acr.review_metrics(ledger, _cfg(), start=newest_dropped + timedelta(seconds=1),
                               end=NOW + timedelta(hours=1), now=NOW, tz="UTC")
    assert after["ledger_complete"] is True
    # The watermark survives the stored form and a copy; an empty ledger has none.
    doc = {**ledger.to_doc(), "_rev": 4}
    assert ReviewLedger.from_doc(doc).evicted_instant() == newest_dropped
    assert ledger.copy().evicted_through == ledger.evicted_through
    assert ReviewLedger.from_doc({**ReviewLedger().to_doc(), "_rev": 1}).evicted_instant() is None
    assert "evicted_through" not in json.loads(ReviewLedger().to_json())
