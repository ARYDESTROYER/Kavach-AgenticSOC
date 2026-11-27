"""The analyst's explicit classification always wins (Round 12 final review, D15).

Two holes let a model-derived or undeclared value beat an analyst's explicit call:

* ``confirm_fp`` set ``false_positive`` only over an unset / ``undetermined``
  disposition. On a TRUE_POSITIVE-verdict case ``case_manager.apply()`` had already
  mapped ``true_positive``, so "Confirm false positive" closed the case as a true
  positive. Because ``confirm_fp`` is a classification verb, the model's value was then
  read as analyst-confirmed ground truth (tuner, precedent corpus, resolved-case RAG)
  and the Console headline said "Closed as true positive".
* An UNDECLARED disposition on ``close``/``resolve`` (applied, never classified) could
  overwrite a disposition the analyst had explicitly classified, while the older
  classification entry still vouched for the new value.

Both paths run through ``_perform_case_action``, so the single-case endpoint, the bulk
endpoint and the ``case_lifecycle`` job are covered by the same fix.
"""

from __future__ import annotations

import json

import pytest

from app.api.routes import CaseAction, case_action
from app.constants import CaseStatus, DecisionBy, Disposition, EntityType, SourceSurface, Verdict
from app.engine.analyst_outcomes import (
    CLASSIFIED_DISPOSITION_KEY,
    analyst_confirmed_outcome,
    standing_analyst_disposition,
)
from app.models import Case, Entity
from app.utils import now_utc, to_millis
from tests.conftest import make_log_event


def _create_case(client, mock_provider, ip: str, *, verdict: str = "TRUE_POSITIVE") -> str:
    """Run the real pipeline so ``case_manager.apply()`` maps the disposition."""
    client.app.state.tlsoc.es.add_log(
        "all-logs-2026.06.16",
        make_log_event(ip=ip, ts_millis=to_millis(now_utc()) - 3_600_000),
    )
    mock_provider.push(
        "router",
        json.dumps({"bucket": "needs_strong_model", "confidence": 0.9, "reason": "serious"}),
    )
    mock_provider.push(
        "investigator",
        json.dumps({
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
        }),
    )
    r = client.post(
        "/api/investigate",
        json={"entity": {"type": "ip", "value": ip}, "source_surface": "investigate"},
    )
    assert r.status_code == 200, r.text
    return r.json()["case_id"]


def _action(client, case_id, **body):
    r = client.post(f"/api/cases/{case_id}/action", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def _outcome(payload: dict) -> tuple[str | None, str | None]:
    return analyst_confirmed_outcome(Case.model_validate(payload))


# --------------------------------------------------------------------------- #
# confirm_fp is its own classification
# --------------------------------------------------------------------------- #
def test_confirm_fp_on_a_true_positive_verdict_case_closes_as_false_positive(
    client, mock_provider
):
    cid = _create_case(client, mock_provider, "203.0.113.70")
    seeded = client.get(f"/api/cases/{cid}").json()
    # The precondition the bug needed: apply() mapped the model's TP onto the case.
    assert seeded["disposition"] == "true_positive"

    body = _action(client, cid, action="confirm_fp", note="actually benign")
    assert body["status"] == "closed"
    assert body["decision_by"] == "analyst"
    assert body["disposition"] == "false_positive"
    last = body["history"][-1]
    assert last["action"] == "confirm_fp"
    assert last[CLASSIFIED_DISPOSITION_KEY] == "false_positive"
    assert _outcome(body) == ("false_positive", "explicit_analyst_disposition")


def test_confirm_fp_replaces_an_earlier_true_positive_classification(client, mock_provider):
    """The newest explicit decision wins, even over an earlier analyst label."""
    cid = _create_case(client, mock_provider, "203.0.113.71")
    first = _action(client, cid, action="set_disposition", disposition="true_positive")
    assert _outcome(first) == ("true_positive", "explicit_analyst_disposition")

    body = _action(client, cid, action="confirm_fp")
    assert body["disposition"] == "false_positive"
    assert body["history"][-1][CLASSIFIED_DISPOSITION_KEY] == "false_positive"
    assert _outcome(body) == ("false_positive", "explicit_analyst_disposition")


@pytest.mark.parametrize("prior", ["duplicate", "suspicious", "undetermined"])
def test_confirm_fp_replaces_every_non_false_positive_value(client, mock_provider, prior):
    last_octet = {"duplicate": 72, "suspicious": 73, "undetermined": 74}[prior]
    cid = _create_case(client, mock_provider, f"203.0.113.{last_octet}")
    _action(client, cid, action="set_disposition", disposition=prior)
    body = _action(client, cid, action="confirm_fp")
    assert body["disposition"] == "false_positive"
    assert _outcome(body) == ("false_positive", "explicit_analyst_disposition")


def test_confirm_fp_keeps_the_benign_refinement(client, mock_provider):
    """``benign`` is the analyst's false-positive-class refinement: kept, and named."""
    cid = _create_case(client, mock_provider, "203.0.113.75")
    _action(client, cid, action="set_disposition", disposition="benign")
    body = _action(client, cid, action="confirm_fp")
    assert body["disposition"] == "benign"
    assert body["history"][-1][CLASSIFIED_DISPOSITION_KEY] == "benign"
    assert _outcome(body) == ("false_positive", "explicit_analyst_disposition")


def test_bulk_confirm_fp_classifies_every_case(client, mock_provider):
    tp = _create_case(client, mock_provider, "203.0.113.76")
    nh = _create_case(client, mock_provider, "203.0.113.77", verdict="NEEDS_HUMAN")
    r = client.post("/api/cases/bulk", json={"ids": [tp, nh], "action": "confirm_fp"})
    assert r.status_code == 200, r.text
    assert all(row["ok"] for row in r.json()["results"]), r.json()
    for cid in (tp, nh):
        got = client.get(f"/api/cases/{cid}").json()
        assert got["status"] == "closed"
        assert got["disposition"] == "false_positive"
        assert got["history"][-1][CLASSIFIED_DISPOSITION_KEY] == "false_positive"


def test_confirm_fp_audit_row_names_the_classification(client, mock_provider):
    cid = _create_case(client, mock_provider, "203.0.113.78")
    _action(client, cid, action="confirm_fp")
    rows = client.get(f"/api/cases/{cid}/trace").json()["steps"]
    summaries = [s.get("result_summary") or "" for s in rows]
    assert any(
        "action=confirm_fp" in s and "disposition=false_positive" in s
        and s.endswith("classified=false_positive")
        for s in summaries
    ), summaries


# --------------------------------------------------------------------------- #
# An undeclared value never overwrites an explicit classification
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("verb", ["close", "resolve"])
def test_undeclared_disposition_does_not_overwrite_an_analyst_classification(
    client, mock_provider, verb
):
    cid = _create_case(client, mock_provider, f"203.0.113.{80 if verb == 'close' else 81}")
    _action(client, cid, action="set_disposition", disposition="false_positive")

    # The stale model value, read off the case before the analyst classified it.
    body = _action(client, cid, action=verb, disposition="true_positive")
    assert body["status"] == ("closed" if verb == "close" else "resolved")
    assert body["disposition"] == "false_positive"
    assert CLASSIFIED_DISPOSITION_KEY not in body["history"][-1]
    assert _outcome(body) == ("false_positive", "explicit_analyst_disposition")


def test_undeclared_disposition_after_confirm_fp_keeps_the_false_positive(
    client, mock_provider
):
    cid = _create_case(client, mock_provider, "203.0.113.82")
    _action(client, cid, action="confirm_fp")
    _action(client, cid, action="reopen")
    body = _action(client, cid, action="close", disposition="true_positive")
    assert body["disposition"] == "false_positive"
    assert _outcome(body) == ("false_positive", "explicit_analyst_disposition")


def test_a_declared_disposition_still_replaces_an_earlier_classification(
    client, mock_provider
):
    """Only the UNDECLARED echo is held back: a new declaration is the newest decision."""
    cid = _create_case(client, mock_provider, "203.0.113.83")
    _action(client, cid, action="set_disposition", disposition="false_positive")
    body = _action(
        client, cid, action="close", disposition="true_positive", disposition_declared=True
    )
    assert body["disposition"] == "true_positive"
    assert body["history"][-1][CLASSIFIED_DISPOSITION_KEY] == "true_positive"
    assert _outcome(body) == ("true_positive", "explicit_analyst_disposition")


def test_undeclared_disposition_still_applies_when_nobody_classified(client, mock_provider):
    """Unchanged behaviour: with no analyst classification the value is applied."""
    cid = _create_case(client, mock_provider, "203.0.113.84", verdict="NEEDS_HUMAN")
    body = _action(client, cid, action="close", disposition="benign")
    assert body["disposition"] == "benign"
    assert _outcome(body) == (None, None)


# --------------------------------------------------------------------------- #
# standing_analyst_disposition: the pure predicate
# --------------------------------------------------------------------------- #
def _case(disposition: Disposition | None, history: list[dict]) -> Case:
    return Case(
        case_id="c-standing",
        cluster_signature="sig:c-standing",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="198.51.100.9"),
        verdict=Verdict.TRUE_POSITIVE,
        status=CaseStatus.CLOSED,
        decision_by=DecisionBy.ANALYST,
        disposition=disposition,
        history=history,
    )


def _entry(action: str, **extra) -> dict:
    return {"event": "analyst_action", "action": action, **extra}


def test_standing_disposition_reads_the_newest_declared_value():
    case = _case(Disposition.FALSE_POSITIVE, [
        _entry("set_disposition", classified_disposition="true_positive"),
        _entry("confirm_fp", classified_disposition="false_positive"),
        _entry("close"),  # a lifecycle move is not a classification
    ])
    assert standing_analyst_disposition(case) == "false_positive"


def test_standing_disposition_is_none_once_the_value_was_replaced():
    """A pre-fix record whose classification was already overwritten protects nothing."""
    case = _case(Disposition.TRUE_POSITIVE, [
        _entry("set_disposition", classified_disposition="false_positive"),
    ])
    assert standing_analyst_disposition(case) is None


def test_standing_disposition_for_legacy_entries():
    # Legacy confirm_fp (no key) names the false-positive class.
    assert standing_analyst_disposition(
        _case(Disposition.FALSE_POSITIVE, [_entry("confirm_fp")])
    ) == "false_positive"
    assert standing_analyst_disposition(
        _case(Disposition.BENIGN, [_entry("confirm_fp")])
    ) == "benign"
    # The pre-fix bug record (confirm_fp left TP) is not treated as an FP label.
    assert standing_analyst_disposition(
        _case(Disposition.TRUE_POSITIVE, [_entry("confirm_fp")])
    ) is None
    # Legacy set_disposition (no key) names no value.
    assert standing_analyst_disposition(
        _case(Disposition.FALSE_POSITIVE, [_entry("set_disposition")])
    ) is None
    # No classification, or no disposition at all.
    assert standing_analyst_disposition(_case(Disposition.TRUE_POSITIVE, [_entry("close")])) is None
    assert standing_analyst_disposition(_case(None, [_entry("confirm_fp")])) is None


# --------------------------------------------------------------------------- #
# The learning loop reads the analyst's label, not the model's
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_resolved_case_memory_learns_the_confirmed_false_positive(app_state):
    state = app_state
    prefs = state.prefs.model_copy(update={
        "rag": state.prefs.rag.model_copy(update={
            "enabled": True, "use_resolved_cases": True, "min_score": 0.0,
        }),
    })
    state.rag.set_prefs(prefs)
    case = Case(
        case_id="case-cfp-tp",
        cluster_signature="sig:case-cfp-tp",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="198.51.100.10"),
        rule_ids=["waf-nginx-access"],
        verdict=Verdict.TRUE_POSITIVE,
        confidence=0.6,
        risk_score=72.0,
        status=CaseStatus.ESCALATED,
        decision_by=DecisionBy.SYSTEM,
        disposition=Disposition.TRUE_POSITIVE,  # what apply() maps from the verdict
    )
    await state.cases.save(case)

    out = await case_action(
        "case-cfp-tp", CaseAction(action="confirm_fp", note="actually benign"), state
    )
    assert out["disposition"] == "false_positive"

    chunks = [
        c for c in state.rag._store._chunks if c.doc_id == "resolved_case:case-cfp-tp"
    ]
    assert len(chunks) == 1
    assert chunks[0].metadata.get("outcome") == "false_positive"
    assert "Analyst-confirmed outcome false_positive." in chunks[0].text
