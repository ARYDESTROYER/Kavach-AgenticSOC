"""The ``step.evidence_collected`` audit summary says what the lookup did (Round 14
FX3b2, SPEC §4.10.8, §4.10.15).

The row used to read "Lookup <tool> collected evidence (<status>)." for every status,
so a lookup that failed, found nothing or did not apply "collected evidence" in the
audit log. The summary is now one plain sentence per status, written at the source
(``runbook_runs.lookup_evidence_summary``) by the live engine and the Demo seed
alike; the action name and the machine-readable ``tool_input`` are unchanged.
Offline.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.constants import CaseStatus, EntityType, SourceSurface
from app.engine import runbook_runs as R
from app.engine.demo_generator import demo_evidence_audit_row
from app.engine.runbook_runs import lookup_evidence_summary
from app.models import RUNBOOK_SYSTEM_RUNNER, Case, Entity, LookupResult
from app.state import AppState

BRUTE = "brute-force-password-spray"
STEP = "accounts-tried"


def _result(status: str, tool: str = "log_stats", reason: str | None = None, **kw: Any) -> LookupResult:
    return LookupResult(tool=tool, status=status, reason=reason, ran_at="2026-10-28T10:00:00Z",
                        ran_by=RUNBOOK_SYSTEM_RUNNER, **kw)


@pytest.mark.parametrize("status, expected", [
    ("ok", "Log statistics lookup collected evidence."),
    ("partial", "Log statistics lookup collected partial evidence."),
    ("empty", "Log statistics lookup found no matching records."),
    ("not_applicable", "Log statistics lookup was not applicable."),
    ("error", "Log statistics lookup could not run."),
])
def test_each_status_has_its_own_sentence(status: str, expected: str) -> None:
    assert lookup_evidence_summary(_result(status)) == expected


@pytest.mark.parametrize("tool, name", [
    ("log_stats", "Log statistics"), ("log_search", "Log search"), ("enrich", "Enrichment"),
    ("related_cases", "Related cases"), ("campaign", "Campaign"), ("mitre", "ATT&CK technique"),
])
def test_every_tool_is_named_in_words(tool: str, name: str) -> None:
    assert lookup_evidence_summary(_result("ok", tool)) == f"{name} lookup collected evidence."


def test_a_lookup_that_did_not_apply_gives_its_reason() -> None:
    result = _result("not_applicable", "enrich", "This case has no value to enrich.")
    assert lookup_evidence_summary(result) == ("Enrichment lookup was not applicable. "
                                               "This case has no value to enrich.")


def test_a_failed_lookup_gives_its_reason_unless_it_only_repeats_the_summary() -> None:
    assert lookup_evidence_summary(_result("error", "log_search", "No log source answered.")) == (
        "Log search lookup could not run. No log source answered.")
    assert lookup_evidence_summary(_result("error", "log_search", "The lookup could not run.")) == (
        "Log search lookup could not run.")


def test_a_successful_lookup_never_carries_a_reason() -> None:
    for status in ("ok", "partial"):
        summary = lookup_evidence_summary(_result(status, "related_cases", "Only the 500 newest cases were read."))
        assert "500" not in summary


def test_an_empty_lookup_says_why_when_it_could_not_search() -> None:
    """An empty result can mean no search ran (no provider is set up for the value, the
    case has no technique yet): the reason says so, so the row never reads as if
    providers were asked and found nothing (FX3b2 review)."""
    result = _result("empty", "enrich", "No enrichment provider is set up for this kind of value.")
    assert lookup_evidence_summary(result) == (
        "Enrichment lookup found no matching records. No enrichment provider is set up for this kind of value.")
    assert lookup_evidence_summary(_result("empty", "mitre", "This case has no ATT&CK technique yet.")) == (
        "ATT&CK technique lookup found no matching records. This case has no ATT&CK technique yet.")
    # Without a reason the sentence stands alone.
    assert lookup_evidence_summary(_result("empty", "log_search")) == "Log search lookup found no matching records."


def test_a_reason_is_one_bounded_sentence() -> None:
    summary = lookup_evidence_summary(_result("error", "campaign", "Campaigns could\nnot be read"))
    assert summary == "Campaign lookup could not run. Campaigns could not be read."
    long = lookup_evidence_summary(_result("not_applicable", "mitre", "x " * 400))
    assert len(long) < 400 and long.endswith("...")


def test_an_unknown_tool_keeps_its_token() -> None:
    result = _result("ok").model_copy(update={"tool": "future_tool"})
    assert lookup_evidence_summary(result) == "Lookup future_tool collected evidence."


def test_no_summary_claims_a_failed_lookup_collected_evidence_or_uses_a_dash() -> None:
    for status in ("empty", "not_applicable", "error"):
        summary = lookup_evidence_summary(_result(status, reason="Some reason."))
        assert "collected" not in summary
    for status in ("ok", "partial", "empty", "not_applicable", "error"):
        summary = lookup_evidence_summary(_result(status, reason="Some reason."))
        assert "—" not in summary and "–" not in summary and "(" not in summary


@pytest.mark.parametrize("status", ["ok", "partial", "empty", "not_applicable", "error"])
def test_the_demo_seed_writes_the_live_summary(status: str) -> None:
    from types import SimpleNamespace

    result = _result(status, reason="This case has no source IP.")
    run = SimpleNamespace(case_id="case-0001", run_id="run-1", attached_at="2026-10-28T09:00:00Z")
    case = SimpleNamespace(case_id="case-0001", case_number="CASE-0001")
    row = demo_evidence_audit_row(run, case, STEP, result)
    assert row["action"] == "step.evidence_collected"
    assert row["result_summary"] == lookup_evidence_summary(result)
    assert row["tool_input"]["status"] == status


# --------------------------------------------------------------------------- #
# The live engine stores the row with that summary
# --------------------------------------------------------------------------- #
def _case(case_id: str) -> Case:
    return Case(case_id=case_id, cluster_signature=f"sig-{case_id}", source_surface=SourceSurface.INVESTIGATE,
                rule_ids=["mail_auth"], entity=Entity(type=EntityType.IP, value="203.0.113.7"),
                status=CaseStatus.NEEDS_HUMAN, case_number=f"CASE-{case_id[-3:]}")


@pytest.mark.asyncio
@pytest.mark.parametrize("status, reason, expected", [
    ("ok", None, "Log statistics lookup collected evidence."),
    ("empty", None, "Log statistics lookup found no matching records."),
    ("not_applicable", "This case has no source IP.",
     "Log statistics lookup was not applicable. This case has no source IP."),
    ("error", "No log source answered.", "Log statistics lookup could not run. No log source answered."),
])
async def test_running_a_lookup_audits_the_per_status_summary(
        app_state: AppState, monkeypatch, status: str, reason: str | None, expected: str) -> None:
    async def fixed(state, case, template, *, ran_by, now=None, events=None, load_events=True):
        return LookupResult(tool=template.tool, status=status, reason=reason, ran_at="2026-10-28T10:00:00Z",
                            ran_by=ran_by, count=0 if status in ("ok", "empty") else None)

    async def none(_state: Any, _case: Any) -> None:
        return None

    monkeypatch.setattr(R, "execute_lookup", fixed)
    monkeypatch.setattr(R, "_case_events", none)
    case = _case(f"case-sum-{status}")
    await app_state.cases.save(case)
    attached = await R.attach_by_person(app_state, case, BRUTE, note=None, actor="asha", context=None)
    # The automatic (on_attach) lookups store every result, a failed one included.
    await R.wait_for_background_lookups(20)
    if status == "error":
        # Run by a person, a failed lookup keeps the previous result and answers 503.
        with pytest.raises(R.RunbookRunError):
            await R.run_lookup_now(app_state, case, attached.run.run_id, STEP, actor="asha", context=None)
    else:
        await R.run_lookup_now(app_state, case, attached.run.run_id, STEP, actor="asha", context=None)
    rows = [r for r in await app_state.audit.records_for_case(case.case_id)
            if r.get("action") == "step.evidence_collected"]
    assert any(r.get("actor_type") == "system" for r in rows), "no automatic lookup was stored"
    if status != "error":
        assert any(r.get("actor") == "asha" for r in rows)
    for row in rows:
        assert row["tool_input"]["status"] == status
        tool = row["tool_input"]["tool"]
        assert row["result_summary"] == lookup_evidence_summary(_result(status, tool, reason))
    step_rows = [r for r in rows if r["tool_input"]["step_id"] == STEP]
    assert step_rows and all(r["result_summary"] == expected for r in step_rows)
