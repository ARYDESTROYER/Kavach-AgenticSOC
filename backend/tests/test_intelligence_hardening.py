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
from app.models import Campaign, Case, Cluster, Entity
from app.playbooks.durable import DurablePlaybookRegistry
from app.playbooks.registry import (
    DEFAULT_BUNDLED_PLAYBOOK_FILES,
    PlaybookConflictError,
    PlaybookManagementError,
    PlaybookProtectedError,
)
from app.stores.playbooks import PlaybookStore
from app.stores.runbooks import RunbookStore


def _cluster(rule: str, *, count: int = 1) -> Cluster:
    return Cluster(
        signature="sig",
        entity=Entity(type=EntityType.IP, value="198.51.100.10"),
        group_by=EntityType.IP,
        rule_values=[rule],
        count=count,
    )


def _document(playbook_id: str, *, version: int = 1, body: str = "Confirm evidence.") -> str:
    return (
        "---\n"
        f"id: {playbook_id}\n"
        f"name: {playbook_id}\n"
        f"version: {version}\n"
        "priority: 10\n"
        "match:\n"
        "  rule_ids: [operator_rule]\n"
        "---\n"
        "## Procedure\n"
        f"{body}\n"
    )


async def test_default_catalog_is_durable_and_revision_guarded(app_state) -> None:
    created, _summary = await app_state.create_playbook(
        "durable_response", _document("durable_response"), actor="alice"
    )
    assert app_state.playbooks.metadata(created)["storage"] == "state"
    assert app_state.playbooks.metadata(created)["revision"] == 1

    # A fresh registry over the same state backend sees the document, proving the
    # management response was not only an in-memory/file-system mutation.
    packaged = app_state._playbooks_dir()
    fresh = DurablePlaybookRegistry(
        packaged,
        PlaybookStore(app_state._kv),
        protected_filenames=DEFAULT_BUNDLED_PLAYBOOK_FILES,
    )
    await fresh.refresh()
    assert fresh.get("durable_response") is not None

    updated, _summary = await fresh.update_durable(
        "durable_response",
        _document("durable_response", version=2),
        actor="bob",
        expected_revision=1,
    )
    assert fresh.metadata(updated)["revision"] == 2
    with pytest.raises(PlaybookConflictError, match="reload before saving"):
        await fresh.update_durable(
            "durable_response",
            _document("durable_response", version=3),
            actor="carol",
            expected_revision=1,
        )


async def test_runbook_mutation_preserves_malformed_sibling_by_failing_closed(
    app_state,
) -> None:
    raw = {
        "documents": {
            "existing": {"content": "Existing operator procedure.", "revision": 1},
            "opaque-future-row": {"future_format": ["not", "understood"]},
        },
        "pending_deletes": [],
        "future_metadata": {"schema": 2},
    }
    await app_state._kv.put(RUNBOOKS_NS, RUNBOOKS_KEY, raw)
    getter = getattr(app_state._kv, "get_strict", None) or app_state._kv.get
    before = await getter(RUNBOOKS_NS, RUNBOOKS_KEY)

    with pytest.raises(ValueError, match="invalid document"):
        await RunbookStore(app_state._kv).create(
            "new-runbook", "New operator procedure.", actor="alice"
        )

    assert await getter(RUNBOOKS_NS, RUNBOOKS_KEY) == before


async def test_playbook_mutation_preserves_malformed_sibling_by_failing_closed(
    app_state,
) -> None:
    raw = {
        "documents": {
            "existing": {"content": _document("existing"), "revision": 1},
            "opaque-future-row": "future-format-playbook",
        },
        "future_metadata": {"schema": 2},
    }
    await app_state._kv.put(PLAYBOOKS_NS, PLAYBOOKS_KEY, raw)
    getter = getattr(app_state._kv, "get_strict", None) or app_state._kv.get
    before = await getter(PLAYBOOKS_NS, PLAYBOOKS_KEY)

    with pytest.raises(ValueError, match="invalid document"):
        await PlaybookStore(app_state._kv).create(
            "new-playbook", _document("new-playbook"), actor="alice"
        )

    assert await getter(PLAYBOOKS_NS, PLAYBOOKS_KEY) == before


async def test_authoring_rejects_procedure_beyond_real_prompt_budget(app_state) -> None:
    with pytest.raises(PlaybookManagementError, match="2400-character prompt budget"):
        await app_state.create_playbook(
            "too_large_for_prompt",
            _document("too_large_for_prompt", body="x" * 2500),
            actor="alice",
        )


async def test_a_bundled_id_that_shadows_an_operator_playbook_stays_bundled_everywhere(
    app_state,
) -> None:
    """A release that RENAMES a bundled playbook can land on an id an operator holds.

    ``create_durable`` refuses a colliding id, so this state is reachable only from the
    bundled side — exactly what the vendor-agnostic rename of the web-application
    playbook does to any deployment that had already authored ``web_application_abuse``.
    ``_merge_snapshot`` drops the operator row from the live set, so the procedure that
    RUNS under that id is the bundled one; every ownership answer has to agree with
    that, or the Console shows an editable, operator-owned playbook that silently is
    neither.
    """
    shadowed_id = sorted(DEFAULT_BUNDLED_PLAYBOOK_FILES)[0].removesuffix(".md")

    def _registry() -> DurablePlaybookRegistry:
        return DurablePlaybookRegistry(
            app_state._playbooks_dir(),
            PlaybookStore(app_state._kv),
            protected_filenames=DEFAULT_BUNDLED_PLAYBOOK_FILES,
        )

    # 0. BASELINE, before any collision exists: the key is always present and empty,
    #    so a consumer can read it unconditionally rather than probing for it.
    assert (await _registry().refresh())["shadowed_by_bundled"] == []

    # Write the operator row STRAIGHT to the store: this is the pre-upgrade state,
    # authored before the id was reserved. (Going through create_durable would be
    # rejected today, which is the point.)
    await PlaybookStore(app_state._kv).create(
        shadowed_id, _document(shadowed_id, body="OUR site procedure."), actor="alice"
    )

    registry = _registry()
    summary = await registry.refresh()

    # 1. The displacement is REPORTED, not only logged — the Console can tell the
    #    operator their procedure is inert instead of leaving them to read a log.
    assert summary["shadowed_by_bundled"] == [shadowed_id]
    # …and the operator row is still counted as stored: it was not deleted, only
    #    displaced, so nothing about this is a silent data loss either.
    assert summary["operator_count"] == 1

    live = registry.get(shadowed_id)
    assert live is not None

    # 2. Ownership: bundled, protected, read-only — plus the additive marker that says
    #    an operator document exists underneath.
    meta = registry.metadata(live)
    assert meta["source_type"] == "bundled"
    assert meta["protected"] is True
    assert meta["editable"] is False
    assert meta["shadowed_operator_document"] is True

    # 3. The editor is shown what RUNS, not the shadowed document.
    opened, content = registry.read_document(shadowed_id)
    assert opened.id == shadowed_id
    assert "OUR site procedure." not in content
    assert opened.name == live.name

    # 4. An update FAILS LOUDLY instead of returning the unchanged bundled playbook
    #    with a success, consuming a CAS revision and auditing a write that never was.
    with pytest.raises(PlaybookProtectedError, match="bundled and read-only"):
        await registry.update_durable(
            shadowed_id,
            _document(shadowed_id, version=2, body="Try to edit the bundled id."),
            actor="alice",
            expected_revision=1,
        )
    after = registry.get(shadowed_id)
    assert after is not None and after.version == live.version

    # 5. And the store was not written either — the rejected update must not consume
    #    the operator row's CAS revision on its way out.
    assert (await PlaybookStore(app_state._kv).list())[shadowed_id]["revision"] == 1


async def test_bundled_portable_rule_exact_match_and_no_match_diagnostics(app_state) -> None:
    await app_state.refresh_playbooks()
    # Bundled playbooks declare PORTABLE Layer-3 rule ids; an operator maps their
    # own SIEM rule title onto one with a RuleDefinition. Source edge whitespace is
    # normalized, while matching otherwise remains exact.
    diagnostics = app_state.playbooks.diagnose(
        _cluster("  external_admin_panel_access  ")
    )
    assert diagnostics["selected_playbook_id"] == "privileged_web_access"
    exact = next(
        row for row in diagnostics["candidates"]
        if row["playbook_id"] == "privileged_web_access"
    )
    assert exact["matched"] is True

    missing = app_state.playbooks.diagnose(_cluster("Unknown Exact Family"))
    assert missing["selected_playbook_id"] is None
    assert missing["selection_reason"] == "no_playbook_matched"
    assert all(row["failed_criteria"] for row in missing["candidates"])


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
