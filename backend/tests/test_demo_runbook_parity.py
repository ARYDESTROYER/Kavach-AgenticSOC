"""Demo Mode honours the runbook library (Round 14 SPEC D45, §4.10.16, §4.10.18).

Both Demo knowledge indexes project the REAL library's Published runbooks (read only),
as the real index does, and a ``run_playbook`` automation rule on a Demo case attaches
its runbook into the Demo run store and the Demo audit, never the real ones."""
from __future__ import annotations

from app.config import AutomationRule, Preferences, ThresholdAutomationConfig
from app.constants import CaseStatus, SourceSurface, Verdict
from app.models import Case, Entity
from app.stores.runbook_library import StoredRunbook

from tests.test_runbook_rag_projection import _version


def _case(case_id: str) -> Case:
    return Case(
        case_id=case_id, cluster_signature=f"sig:{case_id}",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type="ip", value="203.0.113.5"), rule_ids=["modsec_sqli"],
        source_id="src-1", risk_score=80.0, verdict=Verdict.TRUE_POSITIVE,
        confidence=0.9, status=CaseStatus.NEEDS_HUMAN,
    )


async def test_the_demo_indexes_project_published_operator_runbooks(app_state) -> None:
    await app_state.runbook_library.create(StoredRunbook(id="acme-pub", created_by="alice", versions=[
        _version("acme-pub", 1, "published", "Acme widget"),
    ]))
    await app_state.enable_demo(mode="seeded", seed=1337, history_days=1)
    demo = app_state._demo  # noqa: SLF001
    try:
        pipeline_rag = demo.rag_service
        chat_rag = demo.chat_engine._rag  # noqa: SLF001
        for rag in (pipeline_rag, chat_rag):
            assert rag._library_store() is app_state.runbook_library  # noqa: SLF001
        assert (await pipeline_rag.runbook_projection_revisions()).get("acme-pub") == 1
        # The real index is untouched by the Demo projection.
        assert app_state.rag.store is not pipeline_rag.store
    finally:
        await app_state.disable_demo()


async def test_a_demo_rule_attaches_its_runbook_into_the_demo_stack(app_state) -> None:
    await app_state.enable_demo(mode="seeded", seed=1337, history_days=1)
    demo = app_state._demo  # noqa: SLF001
    try:
        automation = demo.pipeline.automation
        case = _case("demo-rule-case")
        await demo.cases.save(case)
        prefs = Preferences(threshold_automation=ThresholdAutomationConfig(enabled=True, rules=[
            AutomationRule(id="pb", action="run_playbook", payload={"playbook_id": "brute_force_login"}),
        ]))
        await automation.run(case, prefs, save=demo.cases.save)
        demo_runs = list((await demo.runbook_runs.get("demo-rule-case")).runs)
        assert [r.runbook_id for r in demo_runs] == ["brute-force-password-spray"]
        assert list((await app_state.real_runbook_runs.get("demo-rule-case")).runs) == []
        demo_rows = await demo.audit.records_for_actor("threshold_automation", limit=20)
        assert "run.attached" in {r.get("action") for r in demo_rows}
        real_rows = await app_state.control_audit.records_for_actor("threshold_automation", limit=20)
        assert not [r for r in real_rows if str(r.get("action", "")).startswith("run.")]
        assert case.status == CaseStatus.NEEDS_HUMAN
    finally:
        await app_state.disable_demo()
    # A stale stack's automation attaches nothing once Demo Mode is off.
    stale = _case("after-demo-case")
    assert await automation._attach_runbook(stale, "brute-force-password-spray", "pb") is None  # noqa: SLF001
    assert list((await app_state.runbook_runs.get("after-demo-case")).runs) == []
