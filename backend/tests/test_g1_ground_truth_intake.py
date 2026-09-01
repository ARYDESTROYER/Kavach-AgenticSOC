"""G1 — analyst ground-truth intake, both channels.

Before this, ``engine.analyst_outcomes.analyst_confirmed_outcome`` was structurally
unreachable from the Console:

* **Channel A (feedback).** The classifier only accepts a binary ``actual_outcome``,
  but the grading UI never offered a control that could set one, so every graded close
  posted the ``unknown`` default and produced no label.
* **Channel B (close).** The Console's PRIMARY close posts ``action="close"`` WITH the
  disposition the analyst picked. The backend parsed that field and then never assigned
  it — only ``set_disposition``/``confirm_fp`` wrote ``case.disposition`` — and the
  history row recorded ``action: "close"``, which is not a classification verb. So the
  main close path could never produce analyst-confirmed ground truth either.

Channel B is now open, but it is gated on an EXPLICIT declaration
(``CaseAction.disposition_declared``) rather than on the presence of the field. That
gate is load-bearing: ``case_manager.apply()`` derives a disposition from the LLM
verdict, so a client that reads a case and posts its stored disposition back is quoting
the model to itself. Applying the disposition and CLASSIFYING the case are therefore
separate, and both halves are pinned below.

Both channels are exercised here, together with the invariants that must NOT move: a
non-binary disposition is not a label, a bare close is not a label, an undeclared close
is not a label, and an ``assessment`` of ``disagree`` is not a label.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest

from app.constants import (
    CaseStatus,
    DecisionBy,
    Disposition,
    EntityType,
    SourceSurface,
    Verdict,
)
from app.engine.analyst_outcomes import (
    CLASSIFIED_DISPOSITION_KEY,
    analyst_confirmation_time,
    analyst_confirmed_outcome,
    ground_truth_supply,
    is_classification_entry,
)
from app.models import Case, Entity, FeedbackEntry
from app.utils import now_utc, to_millis
from tests.conftest import make_log_event


# --------------------------------------------------------------------------- #
# HTTP helpers (shared ``client`` fixture: fake ES + mock LLM, auth off)
# --------------------------------------------------------------------------- #
def _create_case(client, mock_provider, ip: str, *, verdict: str = "NEEDS_HUMAN") -> str:
    """Run the real pipeline and return the case id.

    ``verdict`` is scripted at low confidence on purpose: the case lands non-terminal and
    analyst-actionable, while ``case_manager.apply()`` still derives a disposition from
    it. That derived value is precisely what the echo-back tests below post.
    """
    es = client.app.state.tlsoc.es
    es.add_log(
        "all-logs-2026.06.16",
        make_log_event(ip=ip, ts_millis=to_millis(now_utc()) - 3_600_000),
    )
    mock_provider.push(
        "router",
        json.dumps({"bucket": "needs_strong_model", "confidence": 0.9, "reason": "serious"}),
    )
    mock_provider.push(
        "investigator",
        json.dumps(
            {
                "action": "final",
                "reasoning": "scripted",
                "verdict": {
                    "verdict": verdict,
                    "confidence": 0.2,
                    "evidence": [{"summary": "e", "event_ids": []}],
                    "mitre": [],
                    "recommended_action": "review",
                    "reproduce_query": 'source.ip : "x"',
                },
            }
        ),
    )
    r = client.post(
        "/api/investigate",
        json={"entity": {"type": "ip", "value": ip}, "source_surface": "investigate"},
    )
    assert r.status_code == 200, r.text
    return r.json()["case_id"]


def _action(client, case_id, **body):
    return client.post(f"/api/cases/{case_id}/action", json=body)


def _case_from_response(payload: dict) -> Case:
    """Rebuild the persisted Case from the action/feedback response body.

    The endpoints return ``case.model_dump(mode="json")`` of exactly what was saved, so
    re-validating it exercises the SAME document the classifier reads in production
    without needing a second event loop to reach the store.
    """
    return Case.model_validate(payload)


# --------------------------------------------------------------------------- #
# Channel B — the PRIMARY close path
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "disposition,expected",
    [("false_positive", "false_positive"), ("benign", "false_positive"), ("true_positive", "true_positive")],
)
def test_close_with_declared_binary_disposition_produces_ground_truth(
    client, mock_provider, disposition, expected
):
    cid = _create_case(client, mock_provider, "203.0.113.40")
    r = _action(
        client,
        cid,
        action="close",
        disposition=disposition,
        disposition_declared=True,
        note="checked",
    )
    assert r.status_code == 200, r.text
    body = r.json()

    # The disposition is actually ASSIGNED now (it used to be parsed and dropped).
    assert body["status"] == "closed"
    assert body["disposition"] == disposition

    case = _case_from_response(body)
    outcome, source = analyst_confirmed_outcome(case)
    assert outcome == expected
    assert source == "explicit_analyst_disposition"

    # The append-only history entry carries the explicit classification marker, and the
    # action token itself is untouched (still a plain lifecycle "close").
    last = case.history[-1]
    assert last["action"] == "close"
    assert last[CLASSIFIED_DISPOSITION_KEY] == disposition
    assert is_classification_entry(last) is True
    assert analyst_confirmation_time(case) == last["ts"]


def test_close_without_a_disposition_produces_no_ground_truth(client, mock_provider):
    cid = _create_case(client, mock_provider, "203.0.113.41")
    r = _action(client, cid, action="close", note="handled")
    assert r.status_code == 200, r.text
    case = _case_from_response(r.json())

    assert analyst_confirmed_outcome(case) == (None, None)
    assert analyst_confirmation_time(case) is None
    assert CLASSIFIED_DISPOSITION_KEY not in case.history[-1]
    assert is_classification_entry(case.history[-1]) is False


# --------------------------------------------------------------------------- #
# The gate: a disposition on the wire is NOT a declaration
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("verdict", ["TRUE_POSITIVE", "FALSE_POSITIVE"])
def test_closing_with_the_models_own_disposition_echoed_back_is_not_a_label(
    client, mock_provider, verdict
):
    """The closed-loop regression this gate exists to prevent.

    ``case_manager.apply()`` maps the LLM verdict onto ``case.disposition``. A client
    that GETs the case and posts that stored value straight back has stated nothing —
    it has quoted the model to itself. Without ``disposition_declared`` the close must
    apply the value and record NO classification, otherwise the threshold tuner's
    "independent analyst outcomes" and the CONFIRMED precedent tier are trained on the
    very verdicts they are meant to audit.
    """
    cid = _create_case(client, mock_provider, "203.0.113.60", verdict=verdict)

    # The disposition on the case BEFORE any human touches it — written by apply().
    seeded = client.get(f"/api/cases/{cid}").json()["disposition"]
    assert seeded == verdict.lower(), seeded

    r = _action(client, cid, action="close", disposition=seeded)
    assert r.status_code == 200, r.text
    case = _case_from_response(r.json())

    # APPLIED (the value is honoured) but NOT CLASSIFIED (no independent evidence).
    assert case.disposition.value == seeded
    assert CLASSIFIED_DISPOSITION_KEY not in case.history[-1]
    assert is_classification_entry(case.history[-1]) is False
    assert analyst_confirmed_outcome(case) == (None, None)
    assert analyst_confirmation_time(case) is None
    assert ground_truth_supply([case])["qualifying_precedents"] == 0


def test_declaring_the_same_value_the_model_chose_still_counts(client, mock_provider):
    """The gate is on INTENT, not on difference.

    An analyst who reviews a case and affirmatively re-states the model's own
    conclusion has confirmed it, and that confirmation is exactly the evidence the
    tuner needs. Gating on "the value differs" instead would label only DISAGREEMENTS
    and hand every downstream FP-rate a structural bias, so the flag — not a diff — is
    what opens the channel.
    """
    cid = _create_case(client, mock_provider, "203.0.113.61", verdict="FALSE_POSITIVE")
    seeded = client.get(f"/api/cases/{cid}").json()["disposition"]
    assert seeded == "false_positive"

    r = _action(client, cid, action="close", disposition=seeded, disposition_declared=True)
    assert r.status_code == 200, r.text
    case = _case_from_response(r.json())
    assert case.history[-1][CLASSIFIED_DISPOSITION_KEY] == "false_positive"
    assert analyst_confirmed_outcome(case) == ("false_positive", "explicit_analyst_disposition")


def test_the_declaration_flag_is_inert_without_a_disposition(client, mock_provider):
    """A flag on its own classifies nothing — there is no value to record."""
    cid = _create_case(client, mock_provider, "203.0.113.62", verdict="TRUE_POSITIVE")
    r = _action(client, cid, action="close", disposition_declared=True, note="done")
    assert r.status_code == 200, r.text
    case = _case_from_response(r.json())
    assert CLASSIFIED_DISPOSITION_KEY not in case.history[-1]
    assert analyst_confirmed_outcome(case) == (None, None)


def test_the_declaration_flag_is_ignored_by_non_disposition_actions(client, mock_provider):
    """No lifecycle verb acquires classification power by carrying the flag."""
    cid = _create_case(client, mock_provider, "203.0.113.63", verdict="TRUE_POSITIVE")
    before = client.get(f"/api/cases/{cid}").json()["disposition"]
    r = _action(
        client, cid, action="acknowledge", disposition="false_positive", disposition_declared=True
    )
    assert r.status_code == 200, r.text
    case = _case_from_response(r.json())
    assert (case.disposition.value if case.disposition else None) == before
    assert CLASSIFIED_DISPOSITION_KEY not in case.history[-1]
    assert analyst_confirmed_outcome(case) == (None, None)


def test_set_disposition_needs_no_flag_because_the_verb_is_the_declaration(
    client, mock_provider
):
    """Byte-compatible with the pre-change contract: the dedicated verb still labels.

    ``set_disposition`` exists for no purpose other than classifying, and the wire
    rejects it without a disposition, so performing it IS the declaration.
    """
    cid = _create_case(client, mock_provider, "203.0.113.64", verdict="TRUE_POSITIVE")
    r = _action(client, cid, action="set_disposition", disposition="false_positive")
    assert r.status_code == 200, r.text
    case = _case_from_response(r.json())
    assert case.history[-1][CLASSIFIED_DISPOSITION_KEY] == "false_positive"
    assert analyst_confirmed_outcome(case) == ("false_positive", "explicit_analyst_disposition")


@pytest.mark.parametrize("disposition", ["suspicious", "undetermined", "duplicate"])
def test_close_with_a_non_binary_disposition_produces_no_ground_truth(
    client, mock_provider, disposition
):
    """A recorded outcome is not automatically a BINARY one.

    ``suspicious``/``undetermined``/``duplicate`` are real, useful dispositions, but
    none of them says "this was/wasn't real", so none may become a training label.
    """
    cid = _create_case(client, mock_provider, "203.0.113.42")
    r = _action(client, cid, action="close", disposition=disposition, disposition_declared=True)
    assert r.status_code == 200, r.text
    case = _case_from_response(r.json())

    assert case.disposition.value == disposition
    assert analyst_confirmed_outcome(case) == (None, None)


def test_close_with_an_unknown_disposition_is_rejected(client, mock_provider):
    """The close no longer silently ignores a disposition it cannot parse."""
    cid = _create_case(client, mock_provider, "203.0.113.43")
    r = _action(client, cid, action="close", disposition="nonsense")
    assert r.status_code == 400, r.text
    assert "nonsense" in r.json()["detail"]


def test_a_bare_lifecycle_action_never_classifies(client, mock_provider):
    """Acknowledge / hold / escalate carry no classification power, even with a body.

    The case already holds the ``undetermined`` disposition ``apply()`` derived from
    its NEEDS_HUMAN verdict; a stray ``disposition`` on a non-classifying verb must not
    overwrite it, and must certainly not manufacture a label.
    """
    cid = _create_case(client, mock_provider, "203.0.113.44")
    before = client.get(f"/api/cases/{cid}").json()["disposition"]
    r = _action(client, cid, action="acknowledge", disposition="false_positive")
    assert r.status_code == 200, r.text
    case = _case_from_response(r.json())
    # The field is ignored outside the disposition-carrying actions.
    assert (case.disposition.value if case.disposition else None) == before
    assert CLASSIFIED_DISPOSITION_KEY not in case.history[-1]
    assert analyst_confirmed_outcome(case) == (None, None)


def test_close_audit_row_appends_the_classification_without_reordering(client, mock_provider):
    cid = _create_case(client, mock_provider, "203.0.113.45")
    assert _action(
        client,
        cid,
        action="close",
        disposition="true_positive",
        disposition_declared=True,
        reason="confirmed breach",
    ).status_code == 200

    rows = client.get("/api/audit", params={"case_id": cid, "limit": 100}).json()
    summaries = [str(r.get("result_summary") or "") for r in rows["records"]]
    status_rows = [s for s in summaries if s.startswith("action=close")]
    assert status_rows, summaries
    row = status_rows[0]
    # Existing tokens keep their existing ORDER; the new one is appended at the end.
    assert row.index("action=close") < row.index("disposition=") < row.index("reason=")
    assert row.index("reason=") < row.index("classified=true_positive")


# --------------------------------------------------------------------------- #
# Channel A — the feedback path
# --------------------------------------------------------------------------- #
def test_outcome_selected_in_the_ui_reaches_the_classifier_and_projects(client, mock_provider):
    """The value the new picker posts becomes a label AND a projectable precedent."""
    cid = _create_case(client, mock_provider, "203.0.113.46")
    assert _action(client, cid, action="close", note="closed first").status_code == 200

    r = client.post(
        f"/api/cases/{cid}/feedback",
        json={"assessment": "disagree", "actual_outcome": "false_positive", "comment": "known scanner"},
    )
    assert r.status_code == 200, r.text
    case = _case_from_response(r.json())

    outcome, source = analyst_confirmed_outcome(case)
    assert outcome == "false_positive"
    assert source == "analyst_feedback"

    # …and the projection can actually draw on it. ``_resolved_case_item`` is the ONE
    # per-case precedent projection both the bulk window and the incremental path use.
    rag = client.app.state.tlsoc.rag_service
    item = rag._resolved_case_item(case)
    assert item is not None
    assert item["metadata"]["outcome"] == "false_positive"
    assert item["metadata"]["ground_truth_source"] == "analyst_feedback"


def test_the_unknown_default_still_produces_no_label(client, mock_provider):
    """An untouched picker posts nothing, and the backend default is not a label."""
    cid = _create_case(client, mock_provider, "203.0.113.47")
    assert _action(client, cid, action="close").status_code == 200
    r = client.post(f"/api/cases/{cid}/feedback", json={"assessment": "agree"})
    assert r.status_code == 200, r.text
    case = _case_from_response(r.json())
    assert case.feedback[-1].actual_outcome == "unknown"
    assert analyst_confirmed_outcome(case) == (None, None)


def test_an_unknown_outcome_value_is_rejected_not_silently_stored(client, mock_provider):
    """A 422 the Console must SURFACE — the wire vocabulary is closed."""
    cid = _create_case(client, mock_provider, "203.0.113.48")
    r = client.post(
        f"/api/cases/{cid}/feedback",
        json={"assessment": "agree", "actual_outcome": "definitely_bad"},
    )
    assert r.status_code == 422, r.text


# --------------------------------------------------------------------------- #
# The invariant: never infer a label from an assessment
# --------------------------------------------------------------------------- #
def _case(**kw) -> Case:
    base = dict(
        case_id="c-1",
        cluster_signature="sig",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="203.0.113.9"),
        status=CaseStatus.CLOSED,
        verdict=Verdict.FALSE_POSITIVE,
    )
    base.update(kw)
    return Case(**base)


def test_disagree_alone_is_never_a_label():
    """355 disagreements produced 345 ``undetermined`` closes on the reference
    deployment. ``assessment`` is an opinion about the model, not a statement about
    what happened, and must never be read as one."""
    for assessment in ("agree", "partial", "disagree"):
        case = _case(
            decision_by=DecisionBy.ANALYST,
            disposition=Disposition.UNDETERMINED,
            feedback=[FeedbackEntry(analyst="a", assessment=assessment, comment="wrong")],
            history=[{"ts": "2026-08-01T00:00:00Z", "event": "analyst_action", "action": "close"}],
        )
        assert analyst_confirmed_outcome(case) == (None, None), assessment


def test_a_model_derived_disposition_is_still_not_a_label():
    """``apply()`` fills a disposition in from the verdict. Closing such a case without
    an explicit classification must stay unlabelled — otherwise the corpus trains on
    the model's own output."""
    case = _case(
        decision_by=DecisionBy.ANALYST,
        disposition=Disposition.FALSE_POSITIVE,  # written by apply(), not by a human
        history=[{"ts": "2026-08-01T00:00:00Z", "event": "analyst_action", "action": "close"}],
    )
    assert analyst_confirmed_outcome(case) == (None, None)


def test_legacy_classification_verbs_still_label():
    """No relabelling and no regression: rows written before the marker existed keep
    working through the action token alone."""
    case = _case(
        decision_by=DecisionBy.ANALYST,
        disposition=Disposition.BENIGN,
        history=[
            {"ts": "2026-08-01T00:00:00Z", "event": "analyst_action", "action": "set_disposition"}
        ],
    )
    assert analyst_confirmed_outcome(case) == ("false_positive", "explicit_analyst_disposition")


# --------------------------------------------------------------------------- #
# (d) Corpus-SUPPLY health — measured, threshold-free
# --------------------------------------------------------------------------- #
_FORBIDDEN_VERDICT_KEYS = {
    "status", "status_reason", "starved", "healthy", "ok", "degraded", "severity",
    "threshold", "thresholds", "alert", "alerts", "level", "score",
}


def test_supply_reports_measured_values_and_no_verdict():
    now = datetime(2026, 8, 31, 12, 0, tzinfo=timezone.utc)
    confirmed = _case(
        case_id="c-confirmed",
        decision_by=DecisionBy.ANALYST,
        disposition=Disposition.TRUE_POSITIVE,
        history=[
            {
                "ts": (now - timedelta(days=6, hours=12)).isoformat(),
                "event": "analyst_action",
                "action": "close",
                CLASSIFIED_DISPOSITION_KEY: "true_positive",
            }
        ],
    )
    ungraded = _case(
        case_id="c-ungraded",
        decision_by=DecisionBy.ANALYST,
        feedback=[FeedbackEntry(analyst="a", assessment="disagree", actual_outcome="unknown")],
        history=[{"ts": now.isoformat(), "event": "analyst_action", "action": "close"}],
    )
    graded = _case(
        case_id="c-graded",
        decision_by=DecisionBy.AGENT,
        feedback=[
            FeedbackEntry(
                analyst="a",
                assessment="agree",
                actual_outcome="false_positive",
                ts=(now - timedelta(days=1)).isoformat(),
            )
        ],
    )

    supply = ground_truth_supply([confirmed, ungraded, graded], now=now, store_total=3)

    # Measured, not judged.
    assert supply["qualifying_precedents"] == 2
    assert supply["days_since_last_qualifying_precedent"] == pytest.approx(1.0, abs=1e-6)
    assert supply["feedback_entries"] == 2
    assert supply["feedback_entries_with_ground_truth"] == 1
    assert supply["feedback_entries_without_ground_truth"] == 1
    assert supply["feedback_without_ground_truth_share"] == pytest.approx(0.5)
    assert supply["truncated"] is False

    # No threshold, no verdict, no alarm vocabulary anywhere in the block.
    assert _FORBIDDEN_VERDICT_KEYS.isdisjoint(supply.keys())


def test_supply_reports_unmeasured_as_null_not_zero():
    """No feedback is not a 0% gap, and no precedent is not "0 days ago"."""
    supply = ground_truth_supply([_case(decision_by=DecisionBy.AGENT)])
    assert supply["feedback_entries"] == 0
    assert supply["feedback_without_ground_truth_share"] is None
    assert supply["qualifying_precedents"] == 0
    assert supply["days_since_last_qualifying_precedent"] is None
    assert supply["last_qualifying_precedent_at"] is None


def test_supply_counts_only_what_the_projection_can_draw_from():
    """An escalated case an analyst graded is real evidence but is not corpus SUPPLY —
    the resolved-case projection only ever scans CLOSED/RESOLVED."""
    escalated = _case(
        case_id="c-escalated",
        status=CaseStatus.ESCALATED,
        decision_by=DecisionBy.AGENT,
        feedback=[FeedbackEntry(analyst="a", assessment="agree", actual_outcome="true_positive")],
    )
    supply = ground_truth_supply([escalated])
    assert analyst_confirmed_outcome(escalated)[0] == "true_positive"
    assert supply["qualifying_precedents"] == 0
    # The feedback still counts toward the intake measurement.
    assert supply["feedback_entries"] == 1
    assert supply["feedback_entries_with_ground_truth"] == 1


def test_the_diagnostics_surface_publishes_supply_beside_corpus_health():
    """(d) The signal lives next to the existing rag-health block, and stays evidence:
    it contributes nothing to ``alerts``/``unknowns`` and carries no verdict."""
    from contextlib import asynccontextmanager

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.api.routes import router as monolith_router
    from app.api.routes_diagnostics import router as diagnostics_router
    from app.config import Secrets
    from app.es.fake import InMemoryESClient
    from app.llm.providers import MockProvider
    from app.state import AppState

    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="",
        anthropic_api_key=None, openai_api_key=None,
    )
    mock = MockProvider()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(
            secrets=secrets,
            es=InMemoryESClient(),
            provider_overrides={"anthropic": mock, "openai": mock, "mock": mock},
        )
        await state.startup(start_poller=False)
        await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(monolith_router)
    api.include_router(diagnostics_router)
    with TestClient(api) as c:
        body = c.get("/api/diagnostics/health").json()

    assert "precedent_corpus" in body
    supply = body["ground_truth_supply"]
    for key in (
        "qualifying_precedents",
        "last_qualifying_precedent_at",
        "days_since_last_qualifying_precedent",
        "feedback_entries",
        "feedback_entries_without_ground_truth",
        "feedback_without_ground_truth_share",
    ):
        assert key in supply, key
    assert _FORBIDDEN_VERDICT_KEYS.isdisjoint(supply.keys())
    # Evidence, not an alarm: an empty deployment publishes numbers and raises nothing.
    assert body["alerts"] == [] or all(
        "ground_truth_supply" not in str(a) for a in body["alerts"]
    )
