"""Round 14 WP-0 contracts (docs/research/2026-10-round14/SPEC.md §3.7, §7.2).

Pins the shared contracts every later Round 14 package builds on, before any of them
exists: the constants, the new permission actions and their default holders (with the
legacy ``playbooks`` resource still present, §3.7 step 1), and every new wire model of
``app.models`` (§4.4.1, §4.4.2, §4.5.3, §4.5.10, §4.6.2, §4.10.2, §4.10.7, §4.10.15,
§4.10.15a). Each model is built from the spec's own field tables and round-tripped
through JSON, so a later package that drifts a field breaks here first.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import get_args

import pytest
from pydantic import ValidationError

from app import models as m
from app.constants import (
    RUNBOOK_LIBRARY_DOC_KEY_PREFIX,
    RUNBOOK_LIBRARY_INDEX_KEY,
    RUNBOOK_LIBRARY_MIGRATION_KEY,
    RUNBOOK_LIBRARY_NS,
    RUNBOOK_MIGRATION_ACTOR,
    RUNBOOK_RUNS_CASE_KEY_PREFIX,
    RUNBOOK_RUNS_LEDGER_KEY_PREFIX,
    RUNBOOK_RUNS_NS,
    RUNBOOK_SELECTOR_ACTOR,
    ActionType,
    JobKind,
    SourceSurface,
    UserRole,
)
from app.rbac.policy import ALL, DEFAULT_MATRIX, RESOURCES, can, effective_matrix


def _roundtrip(model_cls: type, instance):
    """JSON out and back in: the same model, and a stable second serialisation."""
    wire = instance.model_dump_json()
    again = model_cls.model_validate_json(wire)
    assert again == instance
    assert again.model_dump_json() == wire
    return json.loads(wire)


# --------------------------------------------------------------------------- #
# Constants
# --------------------------------------------------------------------------- #
def test_runbook_namespaces_and_keys_are_the_spec_values() -> None:
    assert RUNBOOK_LIBRARY_NS == "runbook_library"
    assert RUNBOOK_RUNS_NS == "runbook_runs"
    assert RUNBOOK_LIBRARY_INDEX_KEY == "index"
    assert RUNBOOK_LIBRARY_MIGRATION_KEY == "migration"
    assert RUNBOOK_LIBRARY_DOC_KEY_PREFIX == "rb:"
    assert RUNBOOK_RUNS_CASE_KEY_PREFIX == "case:"
    assert RUNBOOK_RUNS_LEDGER_KEY_PREFIX == "ledger:"


def test_new_action_type_job_kind_and_actor_names() -> None:
    assert ActionType.AUDIT_VIEW.value == "audit_view"
    assert ActionType("audit_view") is ActionType.AUDIT_VIEW
    assert JobKind.AUDIT_EXPORT.value == "audit_export"
    assert RUNBOOK_SELECTOR_ACTOR == "runbook_selector"
    assert RUNBOOK_MIGRATION_ACTOR == "runbook_migration"
    # The legacy kinds and types stay accepted forever (§4.10.16).
    assert JobKind.RUNBOOK_REINDEX.value == "runbook_reindex"
    assert ActionType.PLAYBOOK.value == "playbook"
    assert ActionType.RUNBOOK.value == "runbook"


# --------------------------------------------------------------------------- #
# Permissions (§3.7 step 1)
# --------------------------------------------------------------------------- #
def test_resources_gain_the_new_actions_and_keep_playbooks() -> None:
    assert RESOURCES["runbooks"] == ["read", "run", "manage", "publish"]
    assert RESOURCES["audit"] == ["view", "export"]
    # ``playbooks`` stays until A8c proves nothing gates on it.
    assert RESOURCES["playbooks"] == ["read", "run", "manage"]


_EXPECTED_ROUND14 = {
    # role: (runbooks actions, audit actions, playbooks actions)
    UserRole.SUPER_ADMIN.value: ([ALL], [ALL], [ALL]),
    UserRole.SOC_MANAGER.value: ([ALL], ["view", "export"], [ALL]),
    UserRole.ANALYST_TIER2.value: (["read", "run"], None, ["read", "run"]),
    UserRole.ANALYST_TIER1.value: (["read", "run"], None, ["read"]),
    UserRole.RESPONDER.value: (["read", "run"], None, ["read", "run"]),
    UserRole.AUDITOR.value: (["read"], ["view", "export"], ["read"]),
}


@pytest.mark.parametrize("role", sorted(_EXPECTED_ROUND14))
def test_default_matrix_pins_the_round14_holders(role: str) -> None:
    runbooks, audit, playbooks = _EXPECTED_ROUND14[role]
    row = DEFAULT_MATRIX[role]
    assert row.get("runbooks") == runbooks
    assert row.get("audit") == audit
    assert row.get("playbooks") == playbooks


@pytest.mark.parametrize(
    ("role", "resource", "action", "allowed"),
    [
        # audit:export (D5): super admin, SOC manager, auditor only.
        ("super_admin", "audit", "export", True),
        ("soc_manager", "audit", "export", True),
        ("auditor", "audit", "export", True),
        ("analyst_tier2", "audit", "export", False),
        ("analyst_tier1", "audit", "export", False),
        ("responder", "audit", "export", False),
        # runbooks:run (E8): every role except the auditor.
        ("soc_manager", "runbooks", "run", True),
        ("analyst_tier2", "runbooks", "run", True),
        ("analyst_tier1", "runbooks", "run", True),
        ("responder", "runbooks", "run", True),
        ("auditor", "runbooks", "run", False),
        # runbooks:publish: super admin and SOC manager.
        ("super_admin", "runbooks", "publish", True),
        ("soc_manager", "runbooks", "publish", True),
        ("analyst_tier2", "runbooks", "publish", False),
        ("analyst_tier1", "runbooks", "publish", False),
        ("responder", "runbooks", "publish", False),
        ("auditor", "runbooks", "publish", False),
        # runbooks:read: every role.
        ("auditor", "runbooks", "read", True),
        ("analyst_tier1", "runbooks", "read", True),
        # The legacy gates keep answering exactly as before this round.
        ("analyst_tier1", "playbooks", "run", False),
        ("analyst_tier2", "playbooks", "run", True),
        ("responder", "playbooks", "run", True),
        ("soc_manager", "playbooks", "manage", True),
        ("analyst_tier2", "runbooks", "manage", False),
    ],
)
def test_can_answers_the_round14_grants(role: str, resource: str, action: str, allowed: bool) -> None:
    assert can(role, resource, action) is allowed


def test_a_narrow_deny_still_bites_on_the_new_actions() -> None:
    matrix = effective_matrix(denies={"soc_manager": {"runbooks": ["publish"], "audit": ["export"]}})
    row = matrix["soc_manager"]
    assert "publish" not in row["runbooks"] and {"read", "run", "manage"} <= set(row["runbooks"])
    assert row["audit"] == ["view"]
    # The owner can never be locked out.
    assert matrix["super_admin"]["runbooks"] == [ALL]


# --------------------------------------------------------------------------- #
# §4.4.1 dashboards and personal prefs
# --------------------------------------------------------------------------- #
def test_dashboard_layout_round14_fields_round_trip() -> None:
    board = m.DashboardLayout(
        id="dash-1", name="SOC operations (copy)", default_window="now-24h",
        derived_from="builtin:soc-operations",
    )
    wire = _roundtrip(m.DashboardLayout, board)
    assert wire["default_window"] == "now-24h"
    assert wire["derived_from"] == "builtin:soc-operations"
    # A board stored before Round 14 loads unchanged with both fields absent.
    legacy = m.DashboardLayout.model_validate({"id": "overview", "name": "Overview", "widgets": []})
    assert legacy.default_window is None and legacy.derived_from is None
    assert m.DASHBOARD_WINDOWS == ("now-24h", "now-7d", "now-30d", "now-90d")


@pytest.mark.parametrize("window", ["now-1d", "now-24H", "all", "now-6M", "", 24])
def test_dashboard_request_refuses_anything_but_the_four_presets(window) -> None:
    with pytest.raises(ValidationError):
        m.DashboardLayoutIn(default_window=window)
    # A stored board with a value this build does not know still loads (read as unset).
    assert m.DashboardLayout.model_validate({"id": "b1", "default_window": window}).default_window is None


@pytest.mark.parametrize(
    "value", ["x" * 65, "builtin:soc operations", "<script>", "builtin:é", "builtin:soc-operations\n", 7],
)
def test_dashboard_derived_from_is_a_short_plain_id(value) -> None:
    with pytest.raises(ValidationError):
        m.DashboardLayoutIn(derived_from=value)
    assert m.DashboardLayout.model_validate({"id": "b1", "derived_from": value}).derived_from is None


def test_dashboard_request_model_accepts_the_documented_values() -> None:
    body = m.DashboardLayoutIn.model_validate(
        {"name": "SOC operations (copy)", "default_window": "now-90d", "derived_from": "builtin:soc-operations"},
    )
    assert (body.default_window, body.derived_from) == ("now-90d", "builtin:soc-operations")
    assert isinstance(body, m.DashboardLayout)  # the routes store it as the stored model


async def test_a_board_with_a_drifted_window_survives_another_users_save(app_state) -> None:
    """One shared document holds every user's boards, and the store drops a board that
    fails to load and re-encodes the rest on the next write. A value written by a
    later release must therefore never erase the board (the rollback case)."""
    from app.constants import DASHBOARDS_KEY, DASHBOARDS_NS

    store = app_state.dashboards
    drifted = {"id": "b1", "name": "Mine", "widgets": [], "default_window": "now-6M",
               "derived_from": "builtin:" + "a" * 70}
    kept = {"id": "b2", "name": "Also mine", "widgets": [], "default_window": "now-7d"}
    await store._kv.put(DASHBOARDS_NS, DASHBOARDS_KEY, {"dashboards": {"alice": {"b1": drifted, "b2": kept}}})
    await store.save("bob", m.DashboardLayout(id="x", name="Bob's board"))
    boards = {b.id: b for b in await store.list_for_user("alice")}
    assert set(boards) == {"b1", "b2"}
    assert boards["b1"].default_window is None and boards["b1"].derived_from is None
    assert boards["b2"].default_window == "now-7d"
    assert [b.id for b in await store.list_for_user("bob")] == ["x"]


@pytest.mark.parametrize(
    ("dashboard_id", "reserved"),
    [
        ("new", True), ("builtin:soc-operations", True), ("builtin:x", True), ("u:1a2b3c4d", True),
        ("overview", False), ("dash-abc", False), ("newer", False), ("NEW", False),
    ],
)
def test_reserved_dashboard_ids(dashboard_id: str, reserved: bool) -> None:
    assert m.is_reserved_dashboard_id(dashboard_id) is reserved


def test_dashboards_hidden_is_normalised_never_rejected() -> None:
    raw = [
        "builtin:soc-operations",
        "builtin:cyber-defence-center",  # the landing page cannot be hidden
        "builtin:soc-operations",  # duplicate
        "builtin:Bad",  # outside the id alphabet
        "overview",  # a personal board, not a built-in
        7,
        "builtin:executive-summary",
    ] + [f"builtin:board-{'x' * i}" for i in range(1, 12)]
    prefs = m.UserPrefs(misc={"dashboards_hidden": raw, "nav_collapsed": True})
    hidden = prefs.misc["dashboards_hidden"]
    assert hidden[:2] == ["builtin:soc-operations", "builtin:executive-summary"]
    assert len(hidden) == m.MAX_HIDDEN_DASHBOARDS == 8
    assert m.BUILTIN_DASHBOARD_LANDING_ID not in hidden
    assert prefs.dashboards_hidden == hidden
    assert prefs.misc["nav_collapsed"] is True  # other keys are untouched
    # A non-list value is removed so the whole bucket still loads.
    assert "dashboards_hidden" not in m.UserPrefs(misc={"dashboards_hidden": "builtin:x"}).misc
    assert m.UserPrefs().dashboards_hidden == []


def test_list_prefs_refuse_a_trailing_newline() -> None:
    """``re.match`` with ``$`` accepts ``"x\\n"``; the normalisers must not."""
    prefs = m.UserPrefs(misc={
        "dashboards_hidden": ["builtin:soc-operations\n", "builtin:executive-summary"],
        "dismissed_intros": ["runbooks.migration\n", "audit.scope"],
    })
    assert prefs.dashboards_hidden == ["builtin:executive-summary"]
    assert prefs.dismissed_intros == ["audit.scope"]


def test_dismissed_intros_is_normalised_never_rejected() -> None:
    prefs = m.UserPrefs(misc={"dismissed_intros": ["runbooks.migration", "runbooks.migration", "Bad Id", "", 1]})
    assert prefs.misc["dismissed_intros"] == ["runbooks.migration"]
    assert prefs.dismissed_intros == ["runbooks.migration"]
    many = [f"intro-{i}" for i in range(80)]
    assert len(m.UserPrefs(misc={"dismissed_intros": many}).dismissed_intros) == m.MAX_DISMISSED_INTROS
    assert "dismissed_intros" not in m.UserPrefs(misc={"dismissed_intros": {"a": 1}}).misc


def test_existing_misc_rules_still_apply_beside_the_new_keys() -> None:
    prefs = m.UserPrefs(misc={"chat_stream_mode": "TEXT", "chat_suggest_start": "yes", "dashboards_hidden": []})
    assert prefs.misc == {"chat_stream_mode": "text", "dashboards_hidden": []}


# --------------------------------------------------------------------------- #
# §4.4.2 the breakdown response
# --------------------------------------------------------------------------- #
def test_metrics_breakdown_spec_example_round_trips_and_its_families_sum() -> None:
    example = {
        "by": "rule", "then": None, "bucket": None, "status_group": None,
        "window_label": "Last 7 days", "window_from": "2026-10-19T00:00:00Z", "window_to": "2026-10-26T00:00:00Z",
        "total": 1874, "exact": True, "partial": False, "multi_valued": True,
        "groups": [{"key": "ssh_auth_failed", "then_key": None, "bucket": None, "count": 41,
                    "open_now": 3, "verdicted": 33,
                    "verdict_tp": 4, "verdict_fp": 18, "verdict_needs_human": 11,
                    "analyst_tp": 3, "analyst_fp": 14, "analyst_ungraded": 24}],
        "other": {"count": 210, "groups": 37},
    }
    model = m.MetricsBreakdown.model_validate(example)
    _roundtrip(m.MetricsBreakdown, model)
    group = model.groups[0]
    assert group.verdict_tp + group.verdict_fp + group.verdict_needs_human == group.verdicted
    assert group.analyst_tp + group.analyst_fp + group.analyst_ungraded == group.count
    assert model.kind == "cases" and model.other is not None and model.other.groups == 37
    assert set(m.BREAKDOWN_CASE_METRICS) == {
        "count", "open_now", "verdicted", "verdict_tp", "verdict_fp", "verdict_needs_human",
        "analyst_tp", "analyst_fp", "analyst_ungraded",
    }


def test_metrics_breakdown_usage_and_bucketed_shapes() -> None:
    usage = m.MetricsBreakdown(
        kind="usage", by="surface", window_label="Last 30 days", total=12,
        groups=[m.MetricsBreakdownGroup(key="investigation", count=12, calls=12, cost_usd=1.25)],
    )
    assert _roundtrip(m.MetricsBreakdown, usage)["groups"][0]["cost_usd"] == 1.25
    trend = m.MetricsBreakdown(
        by="severity", bucket="day", total=3,
        buckets=[m.MetricsBreakdownBucket(label="2026-10-25"), m.MetricsBreakdownBucket(label="2026-10-26", in_progress=True)],
        groups=[m.MetricsBreakdownGroup(key="high", bucket="2026-10-26", count=3)],
    )
    assert _roundtrip(m.MetricsBreakdown, trend)["buckets"][1] == {"label": "2026-10-26", "in_progress": True}
    assert set(m.BREAKDOWN_CASE_FIELDS) | set(m.BREAKDOWN_USAGE_FIELDS) == set(get_args(m.BreakdownField))
    assert m.BREAKDOWN_MULTI_VALUED_FIELDS == {"rule", "mitre_tactic", "mitre_technique"}
    with pytest.raises(ValidationError):
        m.MetricsBreakdown(by="priority")


# --------------------------------------------------------------------------- #
# §4.5.3 audit record additions
# --------------------------------------------------------------------------- #
_LEGACY_AUDIT_KEYS = {
    "event_id", "app_version", "build_sha", "ts", "case_id", "source_id", "surface", "actor",
    "action_type", "model", "prompt_excerpt", "query_text", "tool_name", "tool_input",
    "tool_output_summary", "result_summary",
}


def test_an_audit_row_that_uses_no_new_field_keeps_its_exact_legacy_shape() -> None:
    doc = m.AuditDoc(action_type=ActionType.STATUS, surface="settings", actor="bob")
    assert set(doc.model_dump(mode="json")) == _LEGACY_AUDIT_KEYS
    assert set(doc.model_dump()) == _LEGACY_AUDIT_KEYS
    assert set(json.loads(doc.model_dump_json())) == _LEGACY_AUDIT_KEYS


def test_an_audit_row_with_every_new_field_round_trips() -> None:
    doc = m.AuditDoc(
        action_type=ActionType.USER_MGMT, surface="users", actor="trao",
        outcome="success", actor_type="human", action="user.role_changed", actor_role="soc_manager",
        client={"ip": "203.0.113.7", "ip_source": "trusted_proxy", "peer": "172.18.0.4",
                "forwarded_for": "198.51.100.1, 203.0.113.7", "user_agent": "Mozilla/5.0"},
        session_ref="0123456789abcdef",
        target={"type": "user", "id": "vpatel", "label": "vpatel"},
        changes=[{"field": "role", "before": "analyst_tier1", "after": "analyst_tier2"},
                 {"field": "smtp_password", "before": None, "after": None, "secret": True}],
        request_id="9f3b2c1d-1111-4222-8333-444455556666", run_id="run-abc",
    )
    wire = _roundtrip(m.AuditDoc, doc)
    assert set(wire) == _LEGACY_AUDIT_KEYS | set(m.AUDIT_ROUND14_FIELDS)
    assert wire["client"]["ip_source"] == "trusted_proxy"
    assert wire["changes"][1] == {"field": "smtp_password", "before": None, "after": None, "secret": True}


def test_audit_change_values_of_any_type_are_stored_as_text() -> None:
    """A writer that forgets to stringify a setting value must never fail the
    audit-first append (that would refuse the user's write with a 503)."""
    changes = m.AuditDoc(
        action_type=ActionType.STATUS,
        changes=[
            {"field": "budget.daily_usd", "before": 10, "after": 20.5},
            {"field": "rbac.enabled", "before": False, "after": True},
            {"field": "tags", "before": ["a"], "after": ["a", "b"]},
            {"field": "limits", "before": {"b": 1, "a": "x"}, "after": None},
            {"field": "big", "before": list(range(400)), "after": "unchanged"},
        ],
    ).changes
    assert [(c.before, c.after) for c in changes[:4]] == [
        ("10", "20.5"), ("false", "true"), ('["a"]', '["a", "b"]'), ('{"a": "x", "b": 1}', None),
    ]
    assert len(changes[4].before) == m.AUDIT_CHANGE_VALUE_MAX_CHARS


@pytest.mark.parametrize(
    ("raw", "stored"),
    [
        ("203.0.113.7", "203.0.113.7"),
        ("2001:DB8::1", "2001:db8::1"),
        ("[2001:db8::1]:443", "2001:db8::1"),
        ("fe80::1%eth0", "fe80::1"),
        ("198.51.100.9:5678", "198.51.100.9"),
        (" 192.0.2.1 ", "192.0.2.1"),
        ("", None),
        ("testclient", None),
        ("unix:", None),
        ("unix:/run/backend.sock", None),
        ("tlsoc-webui", None),
        ("999.1.1.1", None),
        (None, None),
    ],
)
def test_audit_client_ip_is_an_address_or_null(raw, stored) -> None:
    """``client.ip`` is mapped as Elasticsearch type ``ip``, which refuses the WHOLE row
    for ``""`` or a non-address (a lost audit row, #2). The raw peer stays in ``peer``."""
    client = m.AuditClient(ip=raw, peer=raw if isinstance(raw, str) else "")
    assert client.ip == stored
    assert m.AuditClient().ip is None
    assert m.AuditDoc(action_type=ActionType.AUTH_EVENT, client=client).model_dump(mode="json")["client"]["ip"] == stored


def test_audit_target_carries_the_revision_the_write_creates() -> None:
    doc = m.AuditDoc(
        action_type=ActionType.RUNBOOK, action="runbook.published",
        target={"type": "runbook", "id": "brute-force", "label": "Brute force", "revision": 7},
    )
    assert _roundtrip(m.AuditDoc, doc)["target"] == {
        "type": "runbook", "id": "brute-force", "label": "Brute force", "revision": 7,
    }
    assert m.AuditTarget(type="case", id="case-1").revision is None
    with pytest.raises(ValidationError):
        m.AuditTarget(type="runbook", id="x", revision=-1)


def test_audit_caller_supplied_values_are_bounded_not_rejected() -> None:
    doc = m.AuditDoc(
        action_type=ActionType.STATUS,
        client={"ip": "198.51.100.9", "peer": "198.51.100.9", "user_agent": "u" * 2_000,
                "forwarded_for": "f" * 900},
        target={"type": "dashboard", "id": "d" * 400, "label": "l" * 400},
        changes=[{"field": f"k{i}", "before": "b" * 900, "after": "a" * 900} for i in range(70)],
        actor_role="r" * 90,
    )
    assert len(doc.client.user_agent) == m.AUDIT_USER_AGENT_MAX_CHARS == 512
    assert len(doc.client.forwarded_for) == m.AUDIT_FORWARDED_FOR_MAX_CHARS == 256
    assert len(doc.target.id) == m.AUDIT_TARGET_ID_MAX_CHARS
    assert len(doc.target.label) == m.AUDIT_TARGET_LABEL_MAX_CHARS
    assert len(doc.changes) == m.AUDIT_MAX_CHANGES == 50
    assert {len(c.before) for c in doc.changes} == {m.AUDIT_CHANGE_VALUE_MAX_CHARS} == {500}
    assert len(doc.actor_role) == m.AUDIT_ROLE_MAX_CHARS


@pytest.mark.parametrize(
    "kwargs",
    [
        {"action": "Auth.Login"},
        {"action": "auth"},
        {"action": "auth.login.extra"},
        {"action": "a" * 40 + "." + "b" * 40},
        {"outcome": "ok"},
        {"actor_type": "robot"},
        {"session_ref": "0123456789ABCDEF"},
        {"session_ref": "abc"},
        {"request_id": "short"},
        {"request_id": "has space in it"},
        {"target": {"type": "planet", "id": "x"}},
        {"client": {"ip": "1.2.3.4", "ip_source": "header"}},
    ],
)
def test_audit_code_controlled_fields_are_strict(kwargs: dict) -> None:
    with pytest.raises(ValidationError):
        m.AuditDoc(action_type=ActionType.AUTH_EVENT, **kwargs)


def test_audit_target_types_and_vocabularies_are_the_spec_sets() -> None:
    assert m.AUDIT_TARGET_TYPES == (
        "case", "user", "role", "source", "setting", "job", "rule", "runbook", "dashboard", "export",
    )
    assert m.AUDIT_OUTCOMES == ("success", "failure", "denied", "partial", "unknown")
    assert m.AUDIT_ACTOR_TYPES == ("human", "agent", "system", "service")
    for action in ("auth.login", "auth.login_failed", "user.role_changed", "settings.updated",
                   "audit.exported", "audit.export_downloaded", "runbook.published",
                   "runbook.publish_failed", "step.updated", "job.artifact_downloaded"):
        assert m.AuditDoc(action_type=ActionType.AUTH_EVENT, action=action).action == action


# --------------------------------------------------------------------------- #
# §4.5.10 audit read models
# --------------------------------------------------------------------------- #
_ES_INDEX = "tlsoc-agent-audit-000001"


@pytest.mark.parametrize(
    ("store", "ref", "kwargs"),
    [
        ("es", "Zm9vYmFyYmF6cXV4MTIzNA", {"index": _ES_INDEX}),  # an auto-generated _id
        ("es", "job:0f3a9c:transition:3", {"index": _ES_INDEX}),  # keyed rows use event_id
        ("es", "job:0f3a9c:data-export", {"index": _ES_INDEX, "demo": True}),
        ("es", "proposal-decision:prop-1:approve", {"index": _ES_INDEX}),
        ("es", ("system-update:terminal:" + "j" * 600)[:512], {"index": _ES_INDEX}),
        ("es", "ünïcode/slash%and space", {"index": "tlsoc-agent-audit-2026.10"}),
        ("sql", 123456789, {}),
        ("sql", -4611686018427387904, {}),  # a keyed SQL row's negative surrogate id
        ("sql", -1, {"demo": True}),
        ("mem", 42, {}),
        ("mem", 0, {"demo": True}),
    ],
)
def test_audit_record_ids_follow_e12_for_every_stored_row(store: str, ref, kwargs: dict) -> None:
    record_id = m.encode_audit_record_id(store, ref, **kwargs)
    assert len(record_id) <= m.AUDIT_RECORD_ID_MAX_CHARS
    assert re.fullmatch(r"[A-Za-z0-9_.:+-]+", record_id)  # no "/", "%" or space in a URL path
    assert m.AuditRecord(record_id=record_id).record_id == record_id
    parsed = m.decode_audit_record_id(record_id)
    assert (parsed.store, parsed.ref, parsed.demo) == (store, ref, bool(kwargs.get("demo")))
    assert parsed.index == kwargs.get("index")


def test_the_longest_es_id_fits_the_grammar_and_one_byte_more_does_not() -> None:
    longest = m.encode_audit_record_id("es", "x" * 512, index="a" * 255, demo=True)
    assert len(longest) == m.AUDIT_RECORD_ID_MAX_CHARS
    assert m.AuditRecord(record_id=longest).record_id == longest
    with pytest.raises(ValueError):
        m.encode_audit_record_id("es", "x" * 513, index=_ES_INDEX)
    for bad in [("es", "", {"index": _ES_INDEX}), ("es", "x", {"index": "Upper"}), ("es", "x", {"index": "a:b"}),
                ("es", "x", {}), ("sql", 0, {}), ("sql", 1 << 63, {}), ("sql", "7", {}), ("mem", -1, {})]:
        with pytest.raises(ValueError):
            m.encode_audit_record_id(bad[0], bad[1], **bad[2])


@pytest.mark.parametrize(
    "record_id",
    ["", "es:idx", "sql:abc", "demo:", "mem:-1", "file:/etc/passwd", "es:a b:c", "sql:0", "sql:-0",
     "sql:007", "es:Upper:QQ", "es:idx:Q", "es:idx:QQ==", "es:idx:QR", "es:idx:a/b", "demo:demo:mem:1",
     "sql:1\n", "es:idx:" + "Q" * 684],
)
def test_audit_record_ids_reject_anything_else(record_id: str) -> None:
    with pytest.raises(ValueError):
        m.decode_audit_record_id(record_id)
    if record_id != "es:idx:QR":  # grammar-shaped; refused only as a non-canonical base64url form
        with pytest.raises(ValidationError):
            m.AuditRecord(record_id=record_id)


def test_audit_record_reads_legacy_and_drifted_rows_leniently() -> None:
    legacy = m.AuditRecord.model_validate({
        "record_id": "sql:7", "ts": "2026-10-25T15:09:15Z", "actor": "system", "action_type": "poll",
        "surface": None, "tool_input": {"q": 1}, "category": "system", "event_label": "Poll",
    })
    wire = legacy.model_dump(mode="json")
    # Fields a legacy row lacks are omitted, never sent empty.
    assert not set(m.AUDIT_ROUND14_FIELDS) & set(wire)
    assert wire["surface"] == "" and wire["outcome_derived"] is False
    drifted = m.AuditRecord.model_validate({
        "record_id": "es:idx:MQ", "action_type": "brand_new_type", "outcome": "SUCCESS",
        "actor_type": "robot", "action": "not valid", "client": {"ip": 5}, "target": "x",
        "changes": [{"field": "ok", "after": "1"}, {"nope": True}], "category": "unknown",
    })
    assert drifted.action_type == "brand_new_type"  # the token is kept, never hidden
    assert drifted.outcome == "success"
    assert drifted.actor_type is None and drifted.action is None
    assert drifted.client is None and drifted.target is None
    assert [c.field for c in drifted.changes] == ["ok"]
    assert drifted.category == "system"
    # A row written before ``client.ip`` became an address-or-null reads with ip None.
    assert m.AuditRecord(record_id="mem:3", client={"ip": "", "peer": "unix:"}).client.ip is None


def test_audit_record_lenient_reads_never_raise_on_a_trailing_newline() -> None:
    record = m.AuditRecord(record_id="mem:1", action="auth.login\n")
    assert record.action is None  # dropped as not recorded; the page still renders


@pytest.mark.parametrize(
    ("stored", "read"),
    [
        ([], []),  # recorded: no fields changed
        (None, None),  # not recorded
        ({}, None),
        ("settings", None),
        ([{"nope": True}, 5], None),  # nothing readable is not recorded, never "no changes"
        ([{"field": "a", "after": "1"}], ["a"]),
    ],
)
def test_audit_record_changes_tell_not_recorded_from_none(stored, read) -> None:
    changes = m.AuditRecord(record_id="mem:1", changes=stored).changes
    assert (None if changes is None else [c.field for c in changes]) == read


def test_audit_page_keeps_the_old_list_keys_and_round_trips() -> None:
    page = m.AuditPage(
        records=[m.AuditRecord(record_id="mem:1", action_type="auth", run_id=None),
                 m.AuditRecord(record_id="demo:mem:2", action_type="verdict", run_id="run-1",
                               actor_type="agent", demo=True, category="agent")],
        total=10_000, total_relation="gte", next_cursor="opaque.signed", run_totals={"run-1": 10},
        retention=m.AuditRetention(hot_days=180, warm_days=90),
    )
    wire = _roundtrip(m.AuditPage, page)
    assert {"records", "total"} <= set(wire)
    assert wire["records"][1]["run_id"] == "run-1" and "run_id" not in wire["records"][0]
    assert _roundtrip(m.AuditCount, m.AuditCount(count=100_001, relation="gte")) == {"count": 100_001, "relation": "gte"}
    assert m.AUDIT_COUNT_MAX_CAP == m.AUDIT_EXPORT_MAX_ROWS + 1
    assert (m.AUDIT_PAGE_DEFAULT_LIMIT, m.AUDIT_LEGACY_DEFAULT_LIMIT, m.AUDIT_PAGE_MAX_LIMIT) == (50, 100, 200)


# --------------------------------------------------------------------------- #
# §4.6.2 the rule summary
# --------------------------------------------------------------------------- #
def test_rule_summary_spec_example_round_trips() -> None:
    example = {
        "rule": "Web scanner user agent detected",
        "window": {"label": "Last 3 days", "from": "2026-10-23T00:00:00Z", "to": "2026-10-26T00:00:00Z"},
        "alerts": {"status": "ok", "count": 381, "count_relation": "eq",
                   "first_seen": "2026-10-23T01:00:00Z", "last_seen": "2026-10-25T14:02:00Z",
                   "series": {"bucket": "12h", "levels": ["critical", "high", "medium", "low", "info"],
                              "points": [{"t": "2026-10-23T00:00:00Z", "critical": 0, "high": 3,
                                          "medium": 40, "low": 2, "info": 0}]},
                   "sources": [{"id": "src-1", "name": "Wazuh", "exact": True}]},
        "top_source_ips": {"status": "ok", "rows": [{"value": "198.51.100.23", "count": 120}], "exact": True},
        "top_targets": {"status": "ok", "rows": [{"value": "web01", "kind": "host", "count": 88}], "exact": True},
        "cases": {"status": "ok", "count": 3, "open_now": 1,
                  "outcomes": {"analyst_tp": 1, "analyst_fp": 1, "analyst_ungraded": 1},
                  "latest": [{"case_id": "case-1", "case_number": "CASE-000214", "title": "Scan",
                              "status": "investigating", "verdict": "NEEDS_HUMAN"}]},
        "definition": {"status": "ok", "kind": "source", "suite_rule": None},
        "tuning": {"status": "forbidden"},
        "analyst_policy": {"status": "ok", "policy": None},
    }
    model = m.RuleSummary.model_validate(example)
    wire = _roundtrip(m.RuleSummary, model)
    # The window keeps its wire key ``from`` whatever the serialiser options.
    assert wire["window"] == example["window"]
    assert model.model_dump(by_alias=False)["window"]["from"] == "2026-10-23T00:00:00Z"
    assert wire["tuning"]["status"] == "forbidden"
    assert m.SEVERITY_LEVELS_DESCENDING == ("critical", "high", "medium", "low", "info")
    assert m.RuleSeveritySeries().levels == list(m.SEVERITY_LEVELS_DESCENDING)
    with pytest.raises(ValidationError):
        m.RuleSummary.model_validate({**example, "alerts": {"status": "maybe"}})


# --------------------------------------------------------------------------- #
# §4.10.2 the runbook model
# --------------------------------------------------------------------------- #
def _definition() -> m.RunbookDefinition:
    """The spec's §4.10.13 example, as a definition."""
    return m.RunbookDefinition.model_validate({
        "id": "brute-force-password-spray",
        "title": "Brute force and password spray",
        "summary": "Many failed sign-ins against one or more accounts, from one or many sources.",
        "use_when": "A detection reports repeated failed authentication against our accounts.",
        "priority": 60,
        "owner": "soc-leads",
        "review_every_days": 180,
        "mitre": ["T1110", "T1110.003"],
        "applies_when": {"rule_ids": ["ssh_auth_failed", "win_logon_failure_burst"],
                         "mitre": ["T1110"], "entity_types": ["ip", "user"]},
        "references": ["https://attack.mitre.org/techniques/T1110/"],
        "phases": ["triage", "investigate", "contain"],
        "steps": [
            {"id": "source-scope", "phase": "triage", "kind": "check",
             "title": "Is the source internal or external?",
             "focus": "source IP, its network zone and the asset inventory.",
             "escalate_if": "the source is an internal host that is not an approved scanner.",
             "benign_if": "the source is an approved vulnerability scanner or a known test.",
             "instructions": "Look the source up in the asset inventory before anything else."},
            {"id": "accounts-tried", "phase": "triage", "kind": "lookup",
             "title": "How many accounts were tried?",
             "lookup": {"tool": "log_stats",
                        "filter": {"source.ip": "{{entity.ip}}", "event.outcome": "failure"},
                        "group_by": ["user.name"], "limit": 20, "run": "on_attach"}},
            {"id": "decide", "phase": "investigate", "kind": "decision",
             "title": "Is this a confirmed compromise?",
             "options": [{"id": "confirmed", "label": "Confirmed compromise"},
                         {"id": "suspicious", "label": "Suspicious, unconfirmed"},
                         {"id": "benign", "label": "Benign",
                          "marks_not_applicable": ["block-source", "reset-credentials"]}]},
            {"id": "block-source", "phase": "contain", "kind": "action", "required": False,
             "title": "Block the source at the edge", "react": "RA3101", "d3fend": "D3-NI",
             "instructions": "Record where you blocked it (firewall, WAF or ticket number)."},
        ],
    })


def test_runbook_definition_round_trips_with_its_defaults() -> None:
    defn = _definition()
    _roundtrip(m.RunbookDefinition, defn)
    lookup = defn.steps[1].lookup
    assert lookup is not None and lookup.window == m.RUNBOOK_DEFAULT_LOOKUP_WINDOW
    assert defn.steps[0].required is True and defn.steps[0].evidence == "none"
    assert defn.applies_when.always is False and defn.applies_when.min_event_count is None
    # The definition carries no version; a version is document metadata (§4.10.13).
    assert "version" not in m.RunbookDefinition.model_fields


@pytest.mark.parametrize(
    "patch",
    [
        {"priority": 101},
        {"priority": -1},
        {"review_every_days": 29},
        {"review_every_days": 731},
        {"phases": ["triage", "respond"]},
        {"applies_when": {"min_event_count": 0}},
        {"applies_when": {"entity_types": ["planet"]}},
        {"applies_when": {"severity_at_least": "severe"}},
        {"applies_when": {"verdicts": ["MAYBE"]}},
        {"steps": [{"id": "a", "phase": "triage", "kind": "ask", "title": "x"}]},
        {"steps": [{"id": "a", "phase": "triage", "kind": "check", "title": "x", "target_minutes": 0}]},
        {"steps": [{"id": "a", "phase": "triage", "kind": "check", "title": "x", "evidence": "photo"}]},
        {"steps": [{"id": "a", "phase": "triage", "kind": "lookup", "title": "x",
                    "lookup": {"tool": "shell"}}]},
        {"steps": [{"id": "a", "phase": "triage", "kind": "lookup", "title": "x",
                    "lookup": {"tool": "log_search", "limit": 51}}]},
    ],
)
def test_runbook_model_rejects_wrong_types_and_numeric_bounds(patch: dict) -> None:
    data = _definition().model_dump(mode="json")
    data.update(patch)
    with pytest.raises(ValidationError):
        m.RunbookDefinition.model_validate(data)


def test_runbook_vocabularies_and_reserved_ids() -> None:
    assert m.STEP_KINDS == ("check", "lookup", "decision", "action", "record")
    assert m.PHASE_IDS == ("triage", "investigate", "contain", "eradicate", "recover", "close")
    assert m.PHASE_LABELS["close"] == "Close and learn"
    assert m.LOOKUP_TOOLS == ("log_stats", "log_search", "enrich", "related_cases", "campaign", "mitre")
    assert m.STEP_STATUSES == ("todo", "in_progress", "done", "not_applicable", "blocked")
    assert m.RUNBOOK_RESERVED_IDS == {
        "new", "metrics", "validate", "import", "progress", "match-preview", "lookup-test",
        "reindex", "readme", "index",
    }
    assert "entity.ipaddr" not in m.RUNBOOK_TEMPLATE_VALUES and "entity.ip" in m.RUNBOOK_TEMPLATE_VALUES
    assert (m.RUNBOOK_MAX_STEPS, m.MAX_OPERATOR_RUNBOOKS, m.MAX_RUNBOOK_VERSIONS, m.MAX_RUNS_PER_CASE) == (40, 200, 100, 5)
    for label in m.PHASE_LABELS.values():
        assert "\u2014" not in label and "playbook" not in label.lower()


# --------------------------------------------------------------------------- #
# §4.10.7 runs
# --------------------------------------------------------------------------- #
def _run() -> m.RunbookRun:
    defn = _definition()
    rows_result = m.LookupResult(
        tool="log_search", params={"source.ip": "198.51.100.23"},
        window_from="2026-10-25T11:00:00Z", window_to="2026-10-25T14:31:00Z",
        ran_at="2026-10-25T14:31:00Z", ran_by=m.RUNBOOK_SYSTEM_RUNNER,
        status="ok", count=12, facts=[{"label": "Accounts", "value": "12"}],
        table={"columns": ["user.name", "count"], "rows": [["root", "4"]]},
        table_kind="rows", window_clamped=True,
    )
    return m.RunbookRun(
        run_id="run-0b8c", case_id="case-1", runbook_id=defn.id, version=4, title=defn.title,
        snapshot=defn, attached_by="rule",
        attached_reason=m.MatchExplanation(
            tier=3, matched=[m.MatchedCriterion(criterion="rule_ids", value="ssh_auth_failed")],
        ).model_dump(mode="json"),
        attached_at="2026-10-25T12:52:00Z", attached_actor=m.RUNBOOK_SYSTEM_RUNNER,
        steps={
            "source-scope": m.StepState(status="done", completed_by="asha", note="External."),
            "accounts-tried": m.StepState(
                status="in_progress",
                evidence=[m.StepEvidence(kind="lookup_result", lookup=rows_result),
                          m.StepEvidence(kind="ticket", url="https://tickets.example/INC-1", label="INC-1")],
                ai_draft={"text": "12 accounts were tried.", "created_at": "2026-10-25T14:32:00Z",
                          "model": "demo", "usage_id": "u-1", "confirmed": False},
            ),
            "decide": m.StepState(decision={"option_id": "benign", "label": "Benign", "by": "asha",
                                            "at": "2026-10-25T14:40:00Z"}),
            "block-source": m.StepState(status="not_applicable", reason="Skipped by the decision 'Benign'"),
        },
    )


def test_runbook_run_and_progress_round_trip() -> None:
    run = _run()
    wire = _roundtrip(m.RunbookRun, run)
    assert wire["steps"]["accounts-tried"]["evidence"][0]["lookup"]["table_kind"] == "rows"
    assert wire["status"] == "active" and wire["revision"] == 0
    progress = m.RunbookProgress(done=1, not_applicable=1, total=4, required_open=2, blocked=0, waiting=0)
    assert _roundtrip(m.RunbookProgress, progress)["required_open"] == 2
    with pytest.raises(ValidationError):
        m.StepState(status="waiting_for_approval")  # a derived display state, never stored
    with pytest.raises(ValidationError):
        m.RunbookRun.model_validate({**wire, "attached_by": "ai"})


# --------------------------------------------------------------------------- #
# §4.10.15a responses
# --------------------------------------------------------------------------- #
def _summary(**kw) -> m.RunbookSummary:
    base = dict(
        id="brute-force-password-spray", title="Brute force and password spray",
        summary="Many failed sign-ins.", origin="builtin", state="published", live_version=4,
        phases=["triage", "investigate", "contain"], step_count=4,
        applies_to=m.RunbookAppliesTo(rule_ids=["ssh_auth_failed"], mitre=["T1110"], more=1),
        runs_30d=None, review_due_at="2027-04-23T00:00:00Z",
    )
    base.update(kw)
    return m.RunbookSummary(**base)


def test_runbook_library_responses_round_trip() -> None:
    defn = _definition()
    imported = _summary(id="brute_force_login", origin="imported", state="draft", live_version=None,
                        draft_version=1, migrated_from=m.RunbookMigratedFrom(namespace="playbooks",
                                                                            id="brute_force_login", revision=3),
                        derived_from=m.RunbookRef(id="brute-force-password-spray", version=4))
    _roundtrip(m.RunbookSummary, imported)
    version = m.RunbookVersionDoc(
        version=4, state="published", definition=defn, source="---\nid: x\n---\n", content_hash="a" * 64,
        author="asha", created_at="2026-10-01T00:00:00Z", published_by="trao", published_at="2026-10-02T00:00:00Z",
        review_notes=[m.RunbookReviewNote(by="trao", at="2026-10-02T00:00:00Z", text="Looks good.")],
        import_notes=["Renamed because the id is reserved."], prompt_chars=2140,
    )
    detail = m.RunbookDetail(
        summary=_summary(), live=version,
        versions=[m.RunbookVersionListItem(version=4, state="published", published_by="trao",
                                           published_at="2026-10-02T00:00:00Z")],
        open_runs_by_version={4: 3, 3: 1}, revision=12,
    )
    wire = _roundtrip(m.RunbookDetail, detail)
    assert wire["open_runs_by_version"] == {"4": 3, "3": 1}
    assert wire["draft"] is None and wire["in_review"] is None
    validation = m.RunbookValidation(
        issues=[m.RunbookIssue(path="steps[1].lookup.filter", code="template_value",
                               message="Step 'How many accounts were tried?' uses {{entity.ipaddr}}, "
                                       "which is not a case value. Use {{entity.ip}}.")],
        prompt_chars=2140, prompt_budget=3000,
    )
    _roundtrip(m.RunbookValidation, validation)
    with pytest.raises(ValidationError):
        m.RunbookVersionDoc(version=0, state="published", definition=defn)
    with pytest.raises(ValidationError):
        _summary(state="superseded")  # a version state, never a library row state


def test_match_preview_metrics_and_case_runbooks_round_trip() -> None:
    explanation = m.MatchExplanation(
        tier=2, matched=[m.MatchedCriterion(criterion="mitre", value=["T1110"])],
        missed=[m.MissedCriterion(criterion="severity_at_least", expected="high", actual="medium")], tie=True,
    )
    preview = m.MatchPreview(
        considered=500, window_label="Last 30 days",
        gets_it=[m.MatchPreviewCase(case_id="case-1", case_number="CASE-000214", title="Spray", explanation=explanation)],
        another_wins=[m.MatchPreviewOther(case_id="case-2", winner_id="generic-incident", winner_title="Generic incident (NIST 800-61)")],
        near_misses=[m.MatchPreviewNearMiss(case_id="case-3", failed=explanation.missed)],
        counts=m.MatchPreviewCounts(gets_it=6, another_wins=3, near_misses=5), truncated=False,
    )
    _roundtrip(m.MatchPreview, preview)
    metrics = m.RunbookMetrics(
        window_label="Last 30 days", partial=True,
        per_runbook=[m.RunbookMetricsRunbookRow(id="generic-incident", started=4, completed=2, abandoned=1,
                                                median_minutes_to_complete=42.5)],
        per_phase=[m.RunbookMetricsPhaseRow(runbook_id="generic-incident", phase="triage", median_minutes=5.0)],
        per_step=[m.RunbookMetricsStepRow(runbook_id="generic-incident", step_id="lead", skipped=2)],
        coverage=m.RunbookMetricsCoverage(cases_with_run=52, human_handled_cases=73),
        rules_without_runbook=[m.RunbookMetricsRuleGap(rule="dns_tunnel", cases=4)],
        cohorts=m.RunbookMetricsCohorts(
            with_completed_run=m.RunbookMetricsCohort(cases=40, mttr_p50_minutes=95.0),
            without=m.RunbookMetricsCohort(cases=33, mttr_p50_minutes=None),
        ),
        recent_runs=[m.RunbookMetricsRecentRun(run_id="run-1", case_id="case-1", case_number="CASE-000214",
                                               runbook_id="generic-incident", started_at="2026-10-25T12:00:00Z")],
    )
    assert _roundtrip(m.RunbookMetrics, metrics)["cohorts"]["note"] == "comparison, not cause"
    run = _run()
    case_runbooks = m.CaseRunbooks(
        runs=[run], progress={run.run_id: m.RunbookProgress(done=1, total=4)},
        newer_versions={run.run_id: 5},
        other_tasks=[m.CaseTask(id="task-1", case_id="case-1", title="Call the owner")], revision=3,
    )
    _roundtrip(m.CaseRunbooks, case_runbooks)
    candidates = m.RunbookCandidates(candidates=[
        m.RunbookCandidate(id="brute-force-password-spray", version=4, origin="builtin", group="best",
                           explanation=explanation),
        m.RunbookCandidate(id="generic-incident", version=1, origin="builtin", group="fallback"),
    ])
    _roundtrip(m.RunbookCandidates, candidates)
    steps_open = m.RunbookStepsOpenDetail(required_open=1, steps=[m.RunbookStepsOpen(run_id="run-1", step_id="decide")])
    _roundtrip(m.RunbookStepsOpenDetail, steps_open)


# --------------------------------------------------------------------------- #
# §4.10.15 request bodies
# --------------------------------------------------------------------------- #
def test_runbook_request_bodies_accept_the_documented_shapes() -> None:
    defn = _definition().model_dump(mode="json")
    assert m.RunbookSourceBody.model_validate({"definition": defn}).definition is not None
    assert m.RunbookSourceBody.model_validate({"source": "---\nid: x\n---"}).source
    assert m.RunbookSourceBody.model_validate({"id": "generic-incident"}).id == "generic-incident"
    assert m.RunbookDraftBody.model_validate({"definition": defn, "expected_revision": 3}).expected_revision == 3
    assert m.RunbookVersionBody.model_validate({"version": 5, "expected_revision": 3}).version == 5
    assert m.RunbookVersionBody.model_validate({"version": 5}).expected_revision is None  # submit
    publish = m.RunbookPublishBody.model_validate({"version": 5, "expected_revision": 3, "content_hash": "a" * 64})
    assert (publish.version, publish.expected_revision, publish.content_hash) == (5, 3, "a" * 64)
    assert m.RunbookPublishBody.model_validate({"version": 5, "expected_revision": 0}).content_hash is None
    assert m.RunbookRejectBody.model_validate({"version": 5, "reason": "Needs a lookup."}).reason
    assert m.RunbookRevisionBody.model_validate({}).expected_revision is None
    assert m.RunbookAttachBody.model_validate({"runbook_id": "generic-incident", "note": "By hand."}).note
    update = m.RunbookStepUpdate.model_validate({
        "expected_revision": 2, "status": "done", "assignee": None, "note": "Checked.",
        "decision": {"option_id": "benign"}, "action_record": {"where": "INC-1", "outcome": "Blocked."},
        "evidence_link": {"kind": "ticket", "url": "https://tickets.example/INC-1", "label": "INC-1"},
    })
    assert "assignee" in update.model_fields_set and update.assignee is None
    assert "reason" not in update.model_fields_set
    assert m.StepApprovalBody.model_validate({"decision": "approve"}).decision == "approve"
    assert m.StepDraftConfirmBody.model_validate({"text": "12 accounts."}).text
    assert m.RunSwitchVersionBody.model_validate({"version": 5}).version == 5
    assert m.RunAbandonBody.model_validate({"reason": "Duplicate case."}).reason
    assert len(m.RunbookProgressBody.model_validate({"case_ids": ["c1", "c2"]}).case_ids) == 2
    test_body = m.RunbookLookupTestBody.model_validate({"lookup": {"tool": "enrich", "indicator": "{{entity.ip}}"},
                                                        "case_id": "case-1"})
    assert test_body.lookup.tool == "enrich"


@pytest.mark.parametrize(
    ("model", "data"),
    [
        ("RunbookDraftBody", {"definition": None}),  # expected_revision is required
        ("RunbookStepUpdate", {"status": "done"}),
        ("RunbookStepUpdate", {"expected_revision": 1, "status": "waiting"}),
        ("RunbookStepUpdate", {"expected_revision": 1, "note": "n" * 4_001}),
        ("RunbookStepUpdate", {"expected_revision": 1, "reason": "r" * 501}),
        ("StepApprovalBody", {"decision": "maybe"}),
        ("StepDraftConfirmBody", {"text": ""}),
        ("StepDraftConfirmBody", {"text": "t" * 2_001}),
        ("RunAbandonBody", {"reason": ""}),
        ("RunbookProgressBody", {"case_ids": [f"c{i}" for i in range(101)]}),
        ("RunbookProgressBody", {"case_ids": ["c" * 10_000]}),  # an id becomes part of a store key
        ("RunbookProgressBody", {"case_ids": [""]}),
        ("RunbookVersionBody", {"version": 0}),
        # Publishing makes text trusted guidance (#9): it is bound to the reviewed revision.
        ("RunbookPublishBody", {"version": 5}),
        ("RunbookPublishBody", {"version": 5, "expected_revision": None}),
        ("RunbookPublishBody", {"version": 5, "expected_revision": 3, "content_hash": "abc"}),
        ("RunbookPublishBody", {"version": 5, "expected_revision": 3, "content_hash": "A" * 64}),
        ("RunbookAttachBody", {"runbook_id": ""}),
        ("StepActionRecordInput", {"performed_at": "t" * 65}),
        ("RunbookLookupTestBody", {"lookup": {"tool": "log_stats", "filter": {f"f{i}": "v" * 100 for i in range(400)}},
                                   "case_id": "case-1"}),
    ],
)
def test_runbook_request_bodies_enforce_their_bounds(model: str, data: dict) -> None:
    with pytest.raises(ValidationError):
        getattr(m, model).model_validate(data)


def test_an_oversized_definition_is_refused_before_content_validation() -> None:
    defn = _definition().model_dump(mode="json")
    defn["steps"] = [dict(defn["steps"][0], id=f"s{i}", instructions="i" * 2_000) for i in range(200)]
    for model, extra in (("RunbookSourceBody", {}), ("RunbookDraftBody", {"expected_revision": 1})):
        with pytest.raises(ValidationError, match="larger than"):
            getattr(m, model).model_validate({"definition": defn, **extra})
    # A realistic overrun (41 long steps) still reaches validate_runbook as issues.
    defn["steps"] = defn["steps"][:41]
    assert len(m.RunbookSourceBody.model_validate({"definition": defn}).definition.steps) == 41


_REQUEST_BODIES = (
    "RunbookSourceBody", "RunbookDraftBody", "RunbookVersionBody", "RunbookPublishBody", "RunbookRejectBody",
    "RunbookRevisionBody", "RunbookAttachBody", "StepDecisionInput", "StepActionRecordInput",
    "StepEvidenceLinkInput", "RunbookStepUpdate", "StepApprovalBody", "StepDraftConfirmBody",
    "RunSwitchVersionBody", "RunAbandonBody", "RunbookProgressBody", "RunbookLookupTestBody",
)


@pytest.mark.parametrize("model", _REQUEST_BODIES)
def test_runbook_request_bodies_refuse_unknown_keys(model: str) -> None:
    """A misspelt key (``evidence`` for ``evidence_link``) is a 422, never a silent no-op."""
    cls = getattr(m, model)
    assert cls.model_config.get("extra") == "forbid"
    with pytest.raises(ValidationError, match="extra"):
        cls.model_validate({"surprise": 1})


def test_a_misspelt_step_update_key_is_refused() -> None:
    with pytest.raises(ValidationError):
        m.RunbookStepUpdate.model_validate({"expected_revision": 1, "evidence": {"url": "https://x.example"}})


def test_the_old_runbook_write_shape_is_recognisable_after_validation() -> None:
    """``{id, content}`` must answer ``410 runbooks_moved``, never be taken for a
    match-preview ``{id}`` with the content silently dropped (E14)."""
    legacy = m.RunbookSourceBody.model_validate({"id": "brute_force_login", "content": "# Old\n"})
    assert "content" in legacy.model_fields_set
    blank = m.RunbookSourceBody.model_validate({"id": "", "content": ""})  # the old blank-form submit
    assert "content" in blank.model_fields_set
    preview = m.RunbookSourceBody.model_validate({"id": "brute_force_login"})
    assert "content" not in preview.model_fields_set


@pytest.mark.parametrize(
    "url",
    ["javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,<b>x</b>", "http://tickets.example/1",
     "HTTPS ://tickets.example", "https://", "https:///path", "//tickets.example/1", "/cases/1",
     "https://tickets.example/a b", 'https://tickets.example/"onmouseover=x', "https://t.example/\x00",
     "vbscript:msgbox(1)", "https://" + "a" * 500],
)
def test_evidence_links_are_https_only(url: str) -> None:
    with pytest.raises(ValidationError):
        m.StepEvidenceLinkInput(url=url)
    # A stored row that somehow holds one reads as no link (the label still shows).
    stored = m.StepEvidence(kind="link", url=url, label="Ticket")
    assert stored.url is None and stored.label == "Ticket"


def test_evidence_links_keep_a_valid_https_url() -> None:
    assert m.StepEvidenceLinkInput(url=" HTTPS://tickets.example/INC-1?x=1#y ").url == "https://tickets.example/INC-1?x=1#y"
    assert m.StepEvidenceLinkInput(kind="ticket", label="INC-1").url is None
    assert m.StepEvidence(kind="link", url="https://tickets.example/INC-1").url == "https://tickets.example/INC-1"
    assert m.https_url("https://attack.mitre.org/techniques/T1110/") == "https://attack.mitre.org/techniques/T1110/"


# --------------------------------------------------------------------------- #
# §4.10.9 case provenance
# --------------------------------------------------------------------------- #
def test_case_runbook_provenance_is_nullable_and_legacy_cases_load() -> None:
    legacy = m.Case.model_validate({
        "case_id": "case-1", "cluster_signature": "sig", "source_surface": SourceSurface.AUTOMATED_SCAN.value,
        "entity": {"type": "ip", "value": "198.51.100.23"}, "playbook_id": "brute_force_login",
    })
    assert legacy.runbook_id is None and legacy.runbook_version is None
    assert legacy.playbook_id == "brute_force_login"  # kept readable, never rewritten
    stamped = legacy.model_copy(update={"runbook_id": "brute-force-password-spray", "runbook_version": 4})
    wire = _roundtrip(m.Case, stamped)
    assert (wire["runbook_id"], wire["runbook_version"]) == ("brute-force-password-spray", 4)


def test_runbook_result_models_round_trip() -> None:
    run = _run()
    progress = m.RunbookProgress(done=1, total=4, required_open=2)
    library = m.RunbookLibrary(
        runbooks=[_summary()],
        migration=m.RunbookMigrationNotice(completed_at="2026-10-26T00:00:00Z", published=9, draft=1),
    )
    assert _roundtrip(m.RunbookLibrary, library)["migration"]["published"] == 9
    assert m.RunbookLibrary().migration is None
    _roundtrip(m.RunbookDiscardResult, m.RunbookDiscardResult(id="my-runbook", removed=True))
    _roundtrip(m.RunbookAttachResult, m.RunbookAttachResult(already_attached=True))
    _roundtrip(m.RunbookAttachResult, m.RunbookAttachResult(run=run, progress=progress, revision=1))
    update = m.RunbookRunUpdate(run=run, progress=progress, revision=2)
    _roundtrip(m.RunbookRunUpdate, update)
    estimate = m.ReportSummaryEstimate(prompt_tokens=900, max_output_tokens=400, total_tokens=1300)
    _roundtrip(m.RunbookSuggestion, m.RunbookSuggestion(estimate=estimate))
    _roundtrip(m.RunbookStepDraftResult, m.RunbookStepDraftResult(update=update))


# --------------------------------------------------------------------------- #
# The TypeScript mirrors carry the same fields (until WP-B1 reconciles them with
# the generated contract, this is what keeps the hand mirrors from drifting).
# --------------------------------------------------------------------------- #
_WEBUI_LIB = Path(__file__).resolve().parents[2] / "webui" / "src" / "lib"
_INTERFACE_RE = re.compile(r"^export interface (\w+)(?: extends [^{]+)? \{$")
_FIELD_RE = re.compile(r"^  (\w+)(\??): (.*)$")


def _ts_interface_fields(*files: str) -> dict[str, dict[str, tuple[bool, str]]]:
    """``{interface: {field: (optional, type text)}}`` of the top-level fields."""
    out: dict[str, dict[str, tuple[bool, str]]] = {}
    for name in files:
        current: str | None = None
        for line in (_WEBUI_LIB / name).read_text(encoding="utf-8").splitlines():
            if current is None:
                match = _INTERFACE_RE.match(line)
                if match:
                    current = match.group(1)
                    out[current] = {}
                continue
            if line == "}":
                current = None
                continue
            field = _FIELD_RE.match(line)
            if field:
                out[current][field.group(1)] = (field.group(2) == "?", field.group(3))
    return out


def _ts_interfaces(*files: str) -> dict[str, set[str]]:
    return {name: set(fields) for name, fields in _ts_interface_fields(*files).items()}


def _wire_fields(model: type) -> set[str]:
    return {info.alias or name for name, info in model.model_fields.items()}


_MIRRORS: dict[str, tuple[str, ...]] = {
    "types-audit.ts": (
        "AuditClient", "AuditTarget", "AuditChange", "AuditRecord", "AuditRetention", "AuditPage", "AuditCount",
    ),
    "types-dashboards.ts": (
        "MetricsBreakdownGroup", "MetricsBreakdownOther", "MetricsBreakdownBucket", "MetricsBreakdown",
    ),
    "types-rules.ts": (
        "RuleSummaryWindow", "RuleSeverityPoint", "RuleSeveritySeries", "RuleSummarySource", "RuleSummaryAlerts",
        "RuleTopRow", "RuleCaseOutcomes", "RuleCaseRow", "RuleSummaryCases", "RuleSuiteDefinition",
        "RuleSummaryDefinition", "RuleSummaryTuning", "RuleSummaryAnalystPolicy", "RuleSummary",
    ),
    "types-runbooks.ts": (
        "AppliesWhen", "LookupTemplate", "DecisionOption", "RunbookStep", "RunbookDefinition",
        "MatchedCriterion", "MissedCriterion", "MatchExplanation", "LookupResult", "StepEvidence", "StepState",
        "RunbookRun", "RunbookProgress", "RunbookRef", "RunbookAppliesTo", "RunbookMigratedFrom",
        "RunbookSummary", "RunbookReviewNote", "RunbookVersionDoc", "RunbookVersionListItem", "RunbookDetail",
        "RunbookMigrationNotice", "RunbookLibrary", "RunbookIssue", "RunbookValidation", "MatchPreviewCase",
        "MatchPreviewOther", "MatchPreviewNearMiss", "MatchPreviewCounts", "MatchPreview",
        "RunbookMetricsRunbookRow", "RunbookMetricsPhaseRow", "RunbookMetricsStepRow", "RunbookMetricsCohort",
        "RunbookMetricsRecentRun", "RunbookMetrics", "CaseRunbooks", "RunbookCandidate", "RunbookCandidates",
        "RunbookStepsOpen", "RunbookStepsOpenDetail", "RunbookDiscardResult", "RunbookAttachResult",
        "RunbookRunUpdate", "RunbookSuggestion", "RunbookStepDraftResult", "RunbookSourceBody",
        "RunbookDraftBody", "RunbookVersionBody", "RunbookPublishBody", "RunbookRejectBody", "RunbookRevisionBody",
        "RunbookAttachBody", "RunbookStepUpdate", "StepApprovalBody", "StepDraftConfirmBody",
        "RunbookLookupTestBody",
    ),
}


@pytest.mark.parametrize(
    ("ts_file", "name"),
    [(ts_file, name) for ts_file, names in _MIRRORS.items() for name in names],
)
def test_typescript_mirror_has_the_model_fields(ts_file: str, name: str) -> None:
    interfaces = _ts_interfaces(ts_file)
    assert name in interfaces, f"{ts_file} has no interface {name}"
    assert interfaces[name] == _wire_fields(getattr(m, name)), name


#: Request bodies the Console sends: a field the server requires must be required in
#: the mirror (so the client cannot omit it), and an optional one optional.
_REQUEST_MIRRORS: tuple[str, ...] = (
    "RunbookSourceBody", "RunbookDraftBody", "RunbookVersionBody", "RunbookPublishBody", "RunbookRejectBody",
    "RunbookRevisionBody", "RunbookAttachBody", "RunbookStepUpdate", "StepApprovalBody", "StepDraftConfirmBody",
    "RunbookLookupTestBody",
)


@pytest.mark.parametrize("name", _REQUEST_MIRRORS)
def test_typescript_request_bodies_match_required_and_optional_fields(name: str) -> None:
    ts_fields = _ts_interface_fields("types-runbooks.ts")[name]
    model = getattr(m, name)
    for field_name, info in model.model_fields.items():
        optional, ts_type = ts_fields[info.alias or field_name]
        assert optional is (not info.is_required()), f"{name}.{field_name}"
        if info.is_required():
            assert "null" not in ts_type, f"{name}.{field_name} is required and never null"


def test_typescript_publish_body_requires_the_reviewed_revision() -> None:
    fields = _ts_interface_fields("types-runbooks.ts")["RunbookPublishBody"]
    assert fields["expected_revision"] == (False, "number;")
    api_runbooks = (_WEBUI_LIB / "api-runbooks.ts").read_text(encoding="utf-8")
    assert "export function publishRunbook(runbookId: string, body: RunbookPublishBody)" in api_runbooks


def test_typescript_audit_client_ip_and_target_revision_are_nullable() -> None:
    fields = _ts_interface_fields("types-audit.ts")
    assert fields["AuditClient"]["ip"] == (False, "string | null;")
    assert fields["AuditTarget"]["revision"] == (True, "number | null;")


#: Actions ``policy.RESOURCES`` has that the Roles matrix editor's hand mirror
#: (``webui/src/soc/pages/Roles.api.ts``, owned by WP-W9a) does not list yet. W9a adds
#: them; until then this set may only shrink, and any OTHER drift fails here.
_ROLES_MIRROR_PENDING: frozenset[tuple[str, str]] = frozenset({
    ("runbooks", "run"), ("runbooks", "publish"), ("audit", "export"),
})


def test_roles_matrix_mirror_never_drifts_beyond_the_pending_round14_actions() -> None:
    source = (_WEBUI_LIB.parent / "soc" / "pages" / "Roles.api.ts").read_text(encoding="utf-8")
    block = re.search(r"export const RESOURCE_ACTIONS: Record<string, string\[\]> = \{(.*?)\n\};", source, re.S)
    assert block, "RESOURCE_ACTIONS not found"
    web = {
        res: re.findall(r"'([a-z_]+)'", actions)
        for res, actions in re.findall(r"^\s+(\w+): \[([^\]]*)\],", block.group(1), re.M)
    }
    assert set(web) == set(RESOURCES), "the Console lists a different set of resources"
    unknown = {(res, act) for res, acts in web.items() for act in acts if act not in RESOURCES[res]}
    assert not unknown, f"the Console lists actions the server does not have: {sorted(unknown)}"
    missing = {(res, act) for res, acts in RESOURCES.items() for act in acts if act not in web.get(res, [])}
    assert missing <= _ROLES_MIRROR_PENDING, f"new drift: {sorted(missing - _ROLES_MIRROR_PENDING)}"


def test_existing_typescript_types_gained_the_optional_round14_fields() -> None:
    types_ts = (_WEBUI_LIB / "types.ts").read_text(encoding="utf-8")
    for needle in (
        "object_scoped?: boolean;",
        "open_steps_reason?: string;",
        "require_open_steps_reason?: boolean;",
        "| 'audit_export';",
        "default_window?: 'now-24h' | 'now-7d' | 'now-30d' | 'now-90d' | null;",
        "derived_from?: string | null;",
        "runbook_id?: string | null;",
        "runbook_version?: number | null;",
    ):
        assert needle in types_ts, needle
    assert set(get_args(m.DashboardWindow)) == {"now-24h", "now-7d", "now-30d", "now-90d"}
