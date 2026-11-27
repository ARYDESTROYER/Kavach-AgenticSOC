"""Wave-3 tests: branding, AI-decision feedback + stats, case collaboration
(comments/tags/assign), metrics, and export. All offline (fake ES + mock LLM)."""

from __future__ import annotations

import json

import pytest

from app.config import BrandingConfig, Preferences
from app.constants import CaseStatus, EntityType, SourceSurface, Verdict
from app.engine.metrics import compute_metrics, feedback_stats, retrieval_history
from app.models import Case, Entity, FeedbackEntry


def _case(cid: str, verdict=Verdict.TRUE_POSITIVE, status=CaseStatus.NEEDS_HUMAN, risk=50.0,
          persona="identity_access", playbook="brute_force_login") -> Case:
    return Case(
        case_id=cid, cluster_signature=f"sig-{cid}", source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="1.2.3.4"), verdict=verdict, confidence=0.9,
        risk_score=risk, status=status, agent_persona=persona, playbook_id=playbook,
        created_at="2026-06-20T00:00:00+00:00", updated_at="2026-06-20T01:00:00+00:00",
    )


# --------------------------------------------------------------------------- #
# Branding config validation
# --------------------------------------------------------------------------- #
def test_branding_defaults_and_validation() -> None:
    b = BrandingConfig()
    assert b.org_name and b.theme == "dark"
    BrandingConfig(accent_color="#1c66e0", accent_color2="#8a55c9")
    with pytest.raises(Exception):
        BrandingConfig(accent_color="not-a-hex")
    with pytest.raises(Exception):
        BrandingConfig(logo_data_url="http://evil/x.png")  # must be data:image/*
    with pytest.raises(Exception):
        BrandingConfig(logo_data_url="data:image/png;base64," + "A" * 2_000_000)  # too big


def test_branding_get_is_public_and_put_protected_shape(client) -> None:
    r = client.get("/api/branding")
    assert r.status_code == 200 and "org_name" in r.json()
    r2 = client.put("/api/branding", json={"org_name": "Acme SOC", "accent_color": "#10b981"})
    assert r2.status_code == 200 and r2.json()["org_name"] == "Acme SOC"
    assert client.get("/api/branding").json()["org_name"] == "Acme SOC"


# --------------------------------------------------------------------------- #
# AI-decision feedback + stats
# --------------------------------------------------------------------------- #
def test_feedback_stats_aggregation() -> None:
    c1 = _case("c1")
    c1.feedback = [FeedbackEntry(assessment="agree", accuracy=1.0, reasoning_quality=0.8,
                                 action_appropriateness=0.9, actual_outcome="true_positive",
                                 time_saved_minutes=15)]
    c2 = _case("c2")
    c2.feedback = [FeedbackEntry(assessment="disagree", accuracy=0.0, actual_outcome="false_positive",
                                 time_saved_minutes=5)]
    s = feedback_stats([c1, c2, _case("c3")])
    assert s["graded_cases"] == 2 and s["feedback_count"] == 2
    assert s["agreement_rate"] == 0.5  # one agree, one disagree
    assert s["time_saved_minutes"] == 20
    assert s["outcome_distribution"]["true_positive"] == 1


async def test_feedback_endpoint_appends_and_audits(app_state, mock_provider) -> None:
    case = _case("case-fb")
    await app_state.cases.save(case)
    body = {"analyst": "alice", "assessment": "agree", "accuracy": 0.9,
            "reasoning_quality": 0.8, "action_appropriateness": 0.85,
            "actual_outcome": "true_positive", "time_saved_minutes": 12}
    # Drive through the engine directly (offline) to assert persistence + snapshot.
    from app.api.routes import FeedbackBody, case_feedback
    out = await case_feedback("case-fb", FeedbackBody(**body), app_state)
    assert out["feedback"][0]["assessment"] == "agree"
    assert out["feedback"][0]["ai_verdict"] == "TRUE_POSITIVE"  # snapshot of the graded verdict
    records = await app_state.audit.records_for_case("case-fb")
    assert any((r.get("action_type") if isinstance(r, dict) else getattr(r, "action_type", "")) == "feedback"
               for r in records)


# --------------------------------------------------------------------------- #
# Case collaboration: comments / tags / assignment
# --------------------------------------------------------------------------- #
async def test_collaboration_comment_tags_assign(app_state) -> None:
    from app.api.routes import (
        AssignBody, CommentBody, TagsBody, case_assign, case_comment, case_tags,
    )
    await app_state.cases.save(_case("case-collab"))
    c = await case_comment("case-collab", CommentBody(author="bob", body="looks malicious"), app_state)
    assert c["comments"][0]["body"] == "looks malicious"
    c = await case_tags("case-collab", TagsBody(tags=["brute", "brute", " priority "], analyst="bob"), app_state)
    assert c["tags"] == ["brute", "priority"]  # de-duped + trimmed
    c = await case_assign("case-collab", AssignBody(assignee="carol"), app_state)
    assert c["assignee"] == "carol"


# --------------------------------------------------------------------------- #
# Metrics aggregation
# --------------------------------------------------------------------------- #
def test_compute_metrics() -> None:
    cases = [
        _case("m1", verdict=Verdict.TRUE_POSITIVE, status=CaseStatus.NEEDS_HUMAN, risk=80),
        _case("m2", verdict=Verdict.FALSE_POSITIVE, status=CaseStatus.CLOSED, risk=10,
              persona="web_application", playbook="web_attack"),
        _case("m3", verdict=Verdict.NEEDS_HUMAN, status=CaseStatus.OPEN, risk=40, persona="generalist",
              playbook=""),
    ]
    m = compute_metrics(cases)
    assert m["total_cases"] == 3
    assert m["by_verdict"]["TRUE_POSITIVE"] == 1 and m["by_verdict"]["FALSE_POSITIVE"] == 1
    assert m["closed_cases"] == 1 and m["open_cases"] == 1 and m["needs_human_cases"] == 1
    assert m["persona_usage"]["identity_access"] == 1
    assert m["playbook_usage"]["web_attack"] == 1
    assert m["mttr_minutes"] == 60.0  # the one closed case spans 1h
    assert m["resolved_count"] == 1
    assert isinstance(m["cases_per_day"], list)
    # Active Risk Index = mean risk over LIVE (non-terminal) cases only: m1 (80,
    # NEEDS_HUMAN) + m3 (40, OPEN) → 60.0; m2 (10, CLOSED) is terminal → excluded.
    assert m["active_risk_index"] == 60.0
    assert m["active_risk_case_count"] == 2


def test_compute_metrics_active_risk_all_terminal() -> None:
    # When every case is terminal (resolved/closed) there are no LIVE cases, so the
    # Active Risk Index is an honest 0.0 over a 0 count (never a divide-by-zero).
    cases = [
        _case("t1", status=CaseStatus.CLOSED, risk=90),
        _case("t2", status=CaseStatus.RESOLVED, risk=70),
    ]
    m = compute_metrics(cases)
    assert m["active_risk_index"] == 0.0
    assert m["active_risk_case_count"] == 0


def test_retrieval_history_all_unavailable_and_mixed_cohorts_are_null() -> None:
    legacy = _case("rh-legacy")
    legacy.knowledge_used = []  # historical default laundering must not become zero
    all_unavailable = retrieval_history([legacy])
    assert all_unavailable["status"] == "unavailable"
    assert all_unavailable["available"] is False
    assert all_unavailable["history_unavailable_cases"] == 1
    assert all_unavailable["cases_with_references"] is None
    assert all_unavailable["reference_coverage"] is None

    observed = _case("rh-observed")
    observed.retrieval_history_status = "available"
    observed.retrieval_observation_status = "measured"
    observed.knowledge_used = [{"source": "runbook", "snippet": "reference"}]
    mixed = retrieval_history([legacy, observed])
    assert mixed["status"] == "unavailable"
    assert mixed["history_available_cases"] == 1
    assert mixed["history_unavailable_cases"] == 1
    assert mixed["cases_with_references"] is None
    assert mixed["reference_coverage"] is None


def test_retrieval_history_truncated_or_without_attempt_is_null() -> None:
    no_attempt = _case("rh-no-attempt")
    no_attempt.retrieval_history_status = "available"
    no_attempt.retrieval_observation_status = "not_measured"
    no_attempt.knowledge_used = []

    incomplete = retrieval_history([no_attempt])
    assert incomplete["status"] == "insufficient_evidence"
    assert incomplete["completed_attempt_cases"] == 0
    assert incomplete["cases_with_references"] is None
    assert incomplete["reference_coverage"] is None

    measured = _case("rh-truncated")
    measured.retrieval_history_status = "available"
    measured.retrieval_observation_status = "measured"
    measured.knowledge_used = []
    truncated = retrieval_history([measured], total_cases=2)
    assert truncated["status"] == "unavailable"
    assert truncated["truncated"] is True
    assert truncated["cases_with_references"] is None
    assert truncated["reference_coverage"] is None


def test_retrieval_history_fully_observed_zero_and_half_are_numeric() -> None:
    zero_a = _case("rh-zero-a")
    zero_a.retrieval_history_status = "available"
    zero_a.retrieval_observation_status = "measured"
    zero_a.knowledge_used = []
    zero_b = _case("rh-zero-b")
    zero_b.retrieval_history_status = "available"
    zero_b.retrieval_observation_status = "measured"
    zero_b.knowledge_used = []

    zero = retrieval_history([zero_a, zero_b])
    assert zero["status"] == "available"
    assert zero["available"] is True
    assert zero["completed_attempt_cases"] == 2
    assert zero["cases_with_references"] == 0
    assert zero["reference_coverage"] == 0.0

    one_hit = zero_b.model_copy(deep=True)
    one_hit.knowledge_used = [{"source": "runbook", "snippet": "reference"}]
    half = retrieval_history([zero_a, one_hit])
    assert half["status"] == "available"
    assert half["available"] is True
    assert half["completed_attempt_cases"] == 2
    assert half["cases_with_references"] == 1
    assert half["reference_coverage"] == 0.5


async def test_metrics_endpoint(client) -> None:
    r = client.get("/api/metrics")
    assert r.status_code == 200
    body = r.json()
    assert "total_cases" in body and "by_verdict" in body and "feedback" in body
    assert "active_risk_index" in body and "active_risk_case_count" in body


# --------------------------------------------------------------------------- #
# Export
# --------------------------------------------------------------------------- #
async def test_export_json_and_markdown(app_state) -> None:
    from app.api.routes import case_export
    case = _case("case-export")
    case.tags = ["brute"]
    await app_state.cases.save(case)
    j = await case_export("case-export", "json", app_state)
    assert j["filename"] == "case-export.json" and j["content_type"] == "application/json"
    assert json.loads(j["content"])["case_id"] == "case-export"
    md = await case_export("case-export", "md", app_state)
    assert md["content_type"] == "text/markdown"
    assert "# Case case-export" in md["content"] and "brute" in md["content"]
