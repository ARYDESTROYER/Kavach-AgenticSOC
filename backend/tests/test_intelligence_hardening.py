"""Focused contracts for the Intelligence continuous-improvement hardening."""

from __future__ import annotations

import pytest

from app.agents.personas import select_persona_with_reason
from app.config import CampaignConfig, Preferences
from app.constants import (
    PLAYBOOKS_KEY,
    PLAYBOOKS_NS,
    RUNBOOKS_KEY,
    RUNBOOKS_NS,
    EntityType,
    SourceSurface,
)
from app.engine.telemetry_recommendations import (
    TELEMETRY_GAP_CAPTURE_REASON,
    TELEMETRY_GAP_CAPTURE_STATUS,
    TELEMETRY_GAP_SCHEMA,
    recommend_sources,
)
from app.engine.runbook_match import (
    MatchableRunbook,
    case_facts_from_cluster,
    match,
    matchable_catalog,
)
from app.engine.runbook_model import (
    BUILTIN_RUNBOOK_IDS,
    ISSUE_BUILTIN_ID,
    ISSUE_PROMPT_BUDGET,
    MAX_RUNBOOK_PROMPT_CHARS,
    blocking_error_code,
    builtin_runbook,
    load_builtin_runbooks,
    prompt_chars,
    validate_runbook,
)
from app.models import Campaign, Case, Cluster, Entity, RunbookStep, RunbookVersionDoc
from app.stores.legacy_procedures import LegacyCatalogDamaged, LegacyProcedureReader
from app.stores.runbook_library import RunbookConflict, RunbookLibraryStore, StoredRunbook


def _cluster(rule: str, *, count: int = 1) -> Cluster:
    return Cluster(
        signature="sig",
        entity=Entity(type=EntityType.IP, value="198.51.100.10"),
        group_by=EntityType.IP,
        rule_values=[rule],
        count=count,
    )


def _operator_definition(runbook_id: str, *, base: str = "privileged-misuse-insider"):
    """A built-in's definition under an operator id (a valid operator runbook)."""
    item = builtin_runbook(base)
    assert item is not None
    return item.definition.model_copy(update={"id": runbook_id}, deep=True)


def _draft(runbook_id: str, number: int = 1) -> RunbookVersionDoc:
    return RunbookVersionDoc(
        version=number, state="draft", definition=_operator_definition(runbook_id),
        author="alice", created_at="2026-10-29T00:00:00+00:00",
    )


async def test_operator_runbooks_are_durable_and_revision_guarded(app_state) -> None:
    """Round 14 successor of the durable procedure catalog: an operator runbook is a
    strict-CAS document in the shared KV (SPEC §4.10.6), so a second store over the
    same backend sees it, and a write against a stale revision is refused rather than
    silently overwriting the newer text."""
    created = await app_state.runbook_library.create(
        StoredRunbook(id="durable-response", created_by="alice", versions=[_draft("durable-response")])
    )
    assert created.revision == 1

    # A fresh store over the same state backend sees the document, proving the write
    # was durable state, not an in-memory or file-system mutation.
    fresh = RunbookLibraryStore(app_state._kv)
    stored = await fresh.require("durable-response")
    assert stored.revision == 1 and stored.runbook.draft is not None

    def _retitle(title: str):
        def change(doc: StoredRunbook) -> StoredRunbook:
            versions = [
                v.model_copy(update={"definition": v.definition.model_copy(update={"title": title})})
                for v in doc.versions
            ]
            return doc.model_copy(update={"versions": versions})
        return change

    updated = await fresh.update("durable-response", _retitle("Durable response v2"), expected_revision=1)
    assert updated.revision == 2
    with pytest.raises(RunbookConflict):
        await fresh.update("durable-response", _retitle("Stale edit"), expected_revision=1)
    latest = await app_state.runbook_library.require("durable-response")
    assert latest.revision == 2
    assert latest.runbook.draft.definition.title == "Durable response v2"


@pytest.mark.parametrize(
    ("namespace", "key", "listing"),
    [
        (RUNBOOKS_NS, RUNBOOKS_KEY, "list_runbooks_strict"),
        (PLAYBOOKS_NS, PLAYBOOKS_KEY, "list_playbooks_strict"),
    ],
)
async def test_a_legacy_catalog_with_a_malformed_row_is_read_without_a_write(
    app_state, namespace: str, key: str, listing: str,
) -> None:
    """The retired namespaces are read-only for one release (SPEC §4.10.6, §4.10.16):
    their only reader has no write method, a strict listing of a catalog with an
    unreadable row fails closed instead of projecting a partial catalog, the scan
    reports the damaged row next to the readable one, and the stored document is left
    exactly as it was (a rollback finds it unchanged)."""
    raw = {
        "documents": {
            "existing": {"content": "Existing operator procedure.", "revision": 1},
            "opaque-future-row": {"future_format": ["not", "understood"]},
        },
        "pending_deletes": [],
        "future_metadata": {"schema": 2},
    }
    await app_state._kv.put(namespace, key, raw)
    getter = getattr(app_state._kv, "get_strict", None) or app_state._kv.get
    before = await getter(namespace, key)

    reader = LegacyProcedureReader(app_state._kv)
    assert not [name for name in dir(reader) if name.split("_")[0] in {"put", "create", "update", "delete", "write"}]
    with pytest.raises(LegacyCatalogDamaged, match="invalid document"):
        await getattr(reader, listing)()
    scan = await reader.scan(namespace)
    assert [d.id for d in scan.documents] == ["existing"]
    assert [d.id for d in scan.damaged] == ["opaque-future-row"]

    assert await getter(namespace, key) == before


def test_a_runbook_beyond_the_investigator_prompt_budget_cannot_be_published() -> None:
    """Round 14 successor of the procedure prompt budget (SPEC §4.10.9, E10): the
    investigator guidance of a runbook is at most 3,000 characters, checked before it
    can be made trusted, and the refusal names the budget."""
    definition = _operator_definition("too-large-for-prompt")
    extra = [
        RunbookStep(
            id=f"extra-check-{n}", phase=definition.steps[0].phase, kind="check",
            title=f"Is the extra signal number {n} present?",
            focus=("Read the account history for the window and compare it with the "
                   "approved change record; note every privileged action that has no "
                   "matching ticket and every login from an unusual network."),
        )
        for n in range(1, 11)
    ]
    # In the first step's phase, ahead of it, so the phase order stays valid.
    big = definition.model_copy(update={"steps": [*extra, *definition.steps]})
    assert prompt_chars(big, 1) > MAX_RUNBOOK_PROMPT_CHARS
    issues = validate_runbook(big, origin="operator", version=1)
    assert {i.code for i in issues} == {ISSUE_PROMPT_BUDGET}, issues  # the budget alone
    assert blocking_error_code(issues) == "runbook_prompt_budget"
    assert any(f"{MAX_RUNBOOK_PROMPT_CHARS:,}" in i.message for i in issues)
    # Every built-in fits the same budget.
    for item in load_builtin_runbooks():
        assert prompt_chars(item.definition, item.version) <= MAX_RUNBOOK_PROMPT_CHARS, item.id


def test_an_operator_runbook_never_takes_a_built_in_id_and_a_built_in_wins_a_collision() -> None:
    """Round 14 successor of the bundled-shadows-operator rule: an operator runbook
    cannot be saved under a built-in id (code ``builtin_id``), and if one exists from
    before (a migrated document), the matcher's catalog keeps the built-in, so the
    procedure that RUNS under an id is always the one the library shows as built-in."""
    builtin_id = sorted(BUILTIN_RUNBOOK_IDS)[0]
    issues = validate_runbook(_operator_definition(builtin_id), origin="operator", version=1)
    assert ISSUE_BUILTIN_ID in {i.code for i in issues}
    assert blocking_error_code(issues) == "runbook_id_reserved"

    builtin = builtin_runbook(builtin_id)
    assert builtin is not None
    impostor = MatchableRunbook(
        id=builtin_id, version=9, definition=_operator_definition(builtin_id),
        origin="operator", published_at="2026-10-29T00:00:00+00:00",
    )
    catalog = matchable_catalog(
        [MatchableRunbook(id=builtin.id, version=builtin.version, definition=builtin.definition)],
        [impostor],
    )
    assert [(item.id, item.origin) for item in catalog] == [(builtin_id, "builtin")]


def test_builtin_portable_rule_exact_match_and_no_match_fallback() -> None:
    """Round 14 successor of the bundled portable-rule diagnostics. Built-in runbooks
    declare PORTABLE Layer-3 rule ids; an operator maps their own SIEM rule title onto
    one with a RuleDefinition. Source edge whitespace is normalised, while matching
    otherwise stays exact. With nothing matched, the Generic incident fallback attaches
    with a reason that says so, and with the fallback off nothing does."""
    catalog = [
        MatchableRunbook(id=b.id, version=b.version, definition=b.definition)
        for b in load_builtin_runbooks()
    ]
    exact = match(case_facts_from_cluster(_cluster("  external_admin_panel_access  ")), catalog)
    assert exact.winner is not None and exact.winner.id == "privileged-misuse-insider"
    assert exact.explanation is not None and exact.explanation.tier == 3  # a rule matched
    assert "external_admin_panel_access" in str(exact.explanation.matched)

    missing = match(case_facts_from_cluster(_cluster("Unknown Exact Family")), catalog)
    assert missing.winner is not None and missing.winner.id == "generic-incident"
    assert missing.explanation is not None and missing.explanation.tier == 0  # the fallback
    assert match(case_facts_from_cluster(_cluster("Unknown Exact Family")), catalog, fallback=False).winner is None


def test_invalid_persona_override_is_not_silently_generalist() -> None:
    prefs = Preferences()
    prefs.personas.overrides = {"operator_rule": "removed_specialist"}
    persona, reason = select_persona_with_reason(_cluster("operator_rule"), prefs)
    assert persona.id == "generalist"
    assert reason == "invalid_override:operator_rule->removed_specialist;fallback=generalist"


async def test_campaign_full_reconciliation_removes_stale_rows(app_state) -> None:
    old = Campaign(id="campaign-old", name="old", case_ids=["a", "b"])
    new = Campaign(id="campaign-new", name="new", case_ids=["c", "d"])
    await app_state.campaign_store.upsert(old)
    stored = await app_state.campaign_store.replace_all([new])
    assert [item.id for item in stored] == ["campaign-new"]
    page, total = await app_state.campaign_store.list()
    assert total == 1 and page[0].id == "campaign-new"
    assert await app_state.campaign_store.get("campaign-old") is None
    assert await app_state.campaign_store.get_last_reconciled_at()

    assert await app_state._campaign_cadence_elapsed(
        CampaignConfig(enabled=True, cadence="daily")
    ) is False
    assert await app_state._campaign_cadence_elapsed(
        CampaignConfig(enabled=True, cadence="manual")
    ) is False


async def test_scheduler_health_is_truthful_and_push_only_is_not_gated(
    app_state, monkeypatch,
) -> None:
    prefs = app_state.prefs.model_copy(deep=True)
    prefs.setup_complete = True
    prefs.polling_enabled = False  # push/queue-only deployments do not run PULL collection
    await app_state.update_prefs(prefs)

    assert app_state._schedulers_gated_off() is False
    app_state._scheduler_running = True
    app_state._scheduler_attempt("threshold_tuner")
    app_state._scheduler_failure("threshold_tuner", RuntimeError("store unavailable"))
    failed = await app_state.scheduler_health()
    tuner = failed["workers"]["threshold_tuner"]
    assert tuner["running"] is True
    assert tuner["last_attempt_at"]
    assert tuner["last_success_at"] == ""
    assert tuner["last_error"] == "store unavailable"

    app_state._scheduler_success("threshold_tuner", processed=3)
    healthy = await app_state.scheduler_health()
    tuner = healthy["workers"]["threshold_tuner"]
    assert tuner["last_success_at"]
    assert tuner["last_error"] == ""
    assert tuner["processed"] == 3

    baseline = healthy["workers"]["baseline_producer"]
    assert baseline["enabled"] is True
    assert baseline["gated"] is False
    assert baseline["running"] is True
    assert baseline["cadence"] == "on_ingest"

    await app_state.observe_source_volume("push-source", 2)
    observed = await app_state.scheduler_health()
    baseline = observed["workers"]["baseline_producer"]
    assert baseline["last_attempt_at"]
    assert baseline["last_success_at"]
    assert baseline["last_error"] == ""
    assert baseline["processed"] == 1

    async def baseline_unavailable(*_args, **_kwargs):
        raise RuntimeError("baseline store unavailable")

    monkeypatch.setattr(app_state.baseline_store, "put_strict", baseline_unavailable)
    await app_state.observe_cluster_volume("cluster-health", 4)
    degraded = await app_state.scheduler_health()
    baseline = degraded["workers"]["baseline_producer"]
    assert baseline["last_attempt_at"]
    assert baseline["last_error"] == "baseline persistence was not confirmed"
    app_state._scheduler_running = False


def test_source_recommendation_requires_query_backed_gap() -> None:
    base = Case(
        case_id="case-1",
        cluster_signature="sig-1",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="198.51.100.10"),
    )
    # No DNS connector and arbitrary prose are not evidence.
    base.history = [{"event": "telemetry_gap", "field": "dns.question.name"}]
    assert recommend_sources([base]) == []

    base.history = [{
        "schema": TELEMETRY_GAP_SCHEMA,
        "event": "telemetry_gap",
        "producer": "tool",
        "field": "dns.question.name",
        "recommended_source": "outbound_dns",
        "evidence": {"result": "field_missing", "query": "dns.question.name:*"},
    }]
    rows = recommend_sources([base])
    assert rows[0]["source_type"] == "outbound_dns"
    assert rows[0]["affected_case_count"] == 1


def test_telemetry_gap_capture_remains_explicit_until_tools_emit_controlled_proof() -> None:
    """Do not replace missing production proof with connector-absence inference."""
    assert TELEMETRY_GAP_CAPTURE_STATUS == "not_available"
    assert "free-form errors are intentionally not treated as proof" in TELEMETRY_GAP_CAPTURE_REASON
