"""Round 15 WP1 (foundation): configuration, permissions, constants, the audit catalog
and the view recorder (SPEC D3.2, D3.10, D6.2, D7.5).

Offline: fake Elasticsearch, mock model, the conftest ``client``.

* ``Preferences.team_activity`` and ``Preferences.auto_close_review`` default on and
  are REPAIRED on load (clamped, malformed values replaced), never rejected, so one bad
  value cannot reset the stored configuration;
* a settings write out of range answers 422 (``_reject_out_of_range_auto_close_review``,
  beside ``_reject_out_of_range_caps``) and a write in range is stored as sent;
* ``team:view`` is held by Super admin, SOC manager and Auditor and by no analyst
  role, mirrored in the Console's ``RESOURCE_ACTIONS``, and kept by an upgraded install
  whose stored role override names other resources only;
* every Round 15 action has an exact catalog entry in the right category, the Console
  mirror equals the fixture, and ``case.review_requested`` lands in Agent activity;
* the view recorder is parameterised (action, surface, window) and the Team activity
  recorder writes one ``team.viewed`` row per viewer and view per ten minutes.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest

from app.audit import events, views
from app.audit.query import matches, scope_predicate
from app.config import (
    AUTO_CLOSE_REVIEW_BOUNDS,
    AutoCloseReviewConfig,
    Preferences,
    RBACConfig,
    TeamActivityConfig,
)
from app.constants import (
    AUTO_CLOSE_REVIEW_NS,
    AUTO_CLOSE_REVIEW_ORIGIN,
    CASE_ACTIONS_TAKEN,
    CASE_ACTIONS_TAKEN_LABELS,
    CASE_ACTIONS_TAKEN_MAX,
    CASE_COLLAB_AUDIT_ACTIONS,
    CASE_FILES_NS,
    CASE_GRADED_AUDIT_ACTION,
    CASE_LIFECYCLE_AUDIT_ACTIONS,
    ActionType,
    UserRole,
)
from app.rbac.policy import DEFAULT_MATRIX, RESOURCES, can, resolve_matrix

REPO = Path(__file__).resolve().parents[2]
WEB_EVENTS = REPO / "webui" / "src" / "soc" / "components" / "audit" / "events.ts"
WEB_ROLES = REPO / "webui" / "src" / "soc" / "pages" / "Roles.api.ts"


# --------------------------------------------------------------------------- #
# Constants
# --------------------------------------------------------------------------- #
def test_the_round15_namespaces_and_tokens() -> None:
    assert CASE_FILES_NS == "case_files"
    assert AUTO_CLOSE_REVIEW_NS == "auto_close_review"
    assert AUTO_CLOSE_REVIEW_ORIGIN == "auto_close_review"


def test_the_actions_taken_vocabulary_is_fixed_and_labelled() -> None:
    assert CASE_ACTIONS_TAKEN == (
        "no_action_needed", "blocked_indicator", "isolated_host", "disabled_account",
        "reset_credentials", "removed_malware", "patched_or_hardened", "notified_owner",
        "escalated_externally", "tuned_detection", "other",
    )
    assert CASE_ACTIONS_TAKEN_MAX == 8
    assert set(CASE_ACTIONS_TAKEN_LABELS) == set(CASE_ACTIONS_TAKEN)
    for label in CASE_ACTIONS_TAKEN_LABELS.values():
        assert label[:1].isupper() and "\u2014" not in label and "\u2013" not in label


# --------------------------------------------------------------------------- #
# Preferences blocks (D3.4, D6.2)
# --------------------------------------------------------------------------- #
def test_both_blocks_default_on() -> None:
    prefs = Preferences()
    assert prefs.team_activity == TeamActivityConfig(enabled=True)
    assert prefs.auto_close_review.model_dump() == {
        "enabled": True, "sample_rate": 0.05, "daily_cap": 10, "per_rule_daily_cap": 3, "expiry_days": 7,
    }


def test_the_bounds_table_equals_the_field_constraints() -> None:
    for name, (lo, hi, integer) in AUTO_CLOSE_REVIEW_BOUNDS.items():
        field = AutoCloseReviewConfig.model_fields[name]
        ge = next(m.ge for m in field.metadata if getattr(m, "ge", None) is not None)
        le = next(m.le for m in field.metadata if getattr(m, "le", None) is not None)
        assert (ge, le) == (lo, hi), name
        assert (field.annotation is int) == integer, name
    assert set(AUTO_CLOSE_REVIEW_BOUNDS) == {"sample_rate", "daily_cap", "per_rule_daily_cap", "expiry_days"}


@pytest.mark.parametrize("stored, expected", [
    ({"sample_rate": 0.9}, {"sample_rate": 0.5}),
    ({"sample_rate": -1}, {"sample_rate": 0.0}),
    ({"sample_rate": "nonsense"}, {"sample_rate": 0.05}),
    ({"sample_rate": float("nan")}, {"sample_rate": 0.05}),
    ({"daily_cap": 500}, {"daily_cap": 200}),
    ({"daily_cap": -4}, {"daily_cap": 0}),
    ({"daily_cap": True}, {"daily_cap": 10}),
    ({"per_rule_daily_cap": 0}, {"per_rule_daily_cap": 1}),
    ({"per_rule_daily_cap": "7"}, {"per_rule_daily_cap": 7}),
    ({"expiry_days": 99}, {"expiry_days": 30}),
    ({"expiry_days": None}, {"expiry_days": 7}),
    ({"enabled": "no"}, {"enabled": False}),
    ({"enabled": [1]}, {"enabled": True}),
])
def test_a_stored_auto_close_review_value_is_repaired(stored: dict[str, Any], expected: dict[str, Any]) -> None:
    prefs = Preferences.model_validate({"auto_close_review": stored, "setup_complete": True})
    got = prefs.auto_close_review.model_dump()
    for key, value in expected.items():
        assert got[key] == value, key
    # The rest of the document is untouched (no reset to defaults).
    assert prefs.setup_complete is True


@pytest.mark.parametrize("stored", ["junk", 5, [1, 2], None])
def test_a_malformed_block_becomes_its_defaults(stored: Any) -> None:
    prefs = Preferences.model_validate({
        "auto_close_review": stored, "team_activity": stored, "setup_complete": True,
    })
    assert prefs.auto_close_review == AutoCloseReviewConfig()
    assert prefs.team_activity == TeamActivityConfig()
    assert prefs.setup_complete is True


def test_a_stored_team_activity_flag_is_repaired() -> None:
    assert Preferences.model_validate({"team_activity": {"enabled": "off"}}).team_activity.enabled is False
    assert Preferences.model_validate({"team_activity": {"enabled": {}}}).team_activity.enabled is True


@pytest.mark.parametrize("block", [
    {"sample_rate": 0.6},
    {"sample_rate": -0.01},
    {"sample_rate": "0.1"},
    {"sample_rate": True},
    {"daily_cap": 201},
    {"daily_cap": -1},
    {"daily_cap": 2.5},
    {"per_rule_daily_cap": 0},
    {"per_rule_daily_cap": 51},
    {"expiry_days": 0},
    {"expiry_days": 31},
    {"enabled": "yes"},
])
def test_a_settings_write_out_of_range_answers_422(client, block: dict[str, Any]) -> None:
    before = client.get("/api/settings").json()["prefs"]["auto_close_review"]
    response = client.put("/api/settings", json={"auto_close_review": block})
    assert response.status_code == 422, response.text
    assert "auto_close_review." in response.json()["detail"]
    assert client.get("/api/settings").json()["prefs"]["auto_close_review"] == before


def test_a_settings_write_of_a_non_object_answers_422(client) -> None:
    response = client.put("/api/settings", json={"auto_close_review": "on"})
    assert response.status_code == 422
    assert response.json()["detail"] == "Invalid settings: auto_close_review must be an object"


def test_a_settings_write_in_range_is_stored_as_sent(client) -> None:
    body = {"auto_close_review": {"enabled": False, "sample_rate": 0.5, "daily_cap": 200,
                                  "per_rule_daily_cap": 1, "expiry_days": 30},
            "team_activity": {"enabled": False}}
    response = client.put("/api/settings", json=body)
    assert response.status_code == 200, response.text
    stored = client.get("/api/settings").json()["prefs"]
    assert stored["auto_close_review"] == body["auto_close_review"]
    assert stored["team_activity"] == {"enabled": False}
    # 0 is a valid daily cap (no sample), and a whole float is a whole number.
    assert client.put("/api/settings", json={"auto_close_review": {"daily_cap": 0, "expiry_days": 3.0}}).status_code == 200
    assert client.get("/api/settings").json()["prefs"]["auto_close_review"]["daily_cap"] == 0


def test_the_read_only_gate_answers_before_the_range_check(client) -> None:
    assert client.put("/api/settings", json={"read_only_settings_mode": True}).status_code == 200
    response = client.put("/api/settings", json={"auto_close_review": {"sample_rate": 0.9}})
    assert response.status_code == 403
    assert response.json()["detail"] == "Settings are in read-only mode"


def test_the_settings_schema_names_both_sections() -> None:
    from app.api.settings_schema import settings_schema

    titles = {section["key"]: section["title"] for section in settings_schema()["sections"]}
    assert titles["team_activity"] == "Team activity"
    assert titles["auto_close_review"] == "Auto-close review"


# --------------------------------------------------------------------------- #
# Permissions (D3.2)
# --------------------------------------------------------------------------- #
def test_team_view_is_one_resource_with_one_action() -> None:
    assert RESOURCES["team"] == ["view"]


@pytest.mark.parametrize("role, expected", [
    (UserRole.SUPER_ADMIN.value, True),
    (UserRole.SOC_MANAGER.value, True),
    (UserRole.AUDITOR.value, True),
    (UserRole.ANALYST_TIER2.value, False),
    (UserRole.ANALYST_TIER1.value, False),
    (UserRole.RESPONDER.value, False),
])
def test_team_view_truth_table(role: str, expected: bool) -> None:
    assert can(role, "team", "view") is expected


def test_an_upgraded_install_with_a_stored_override_keeps_the_default() -> None:
    """A stored ``rbac.roles`` override replaces only the resources it names, so an
    install upgraded with an override that predates ``team`` still gets the default."""
    cfg = RBACConfig(enabled=True, roles={
        UserRole.SOC_MANAGER.value: {"cases": ["read"]},
        UserRole.AUDITOR.value: {"audit": ["view"]},
    })
    assert can(UserRole.SOC_MANAGER.value, "team", "view", cfg) is True
    assert can(UserRole.AUDITOR.value, "team", "view", cfg) is True
    assert can(UserRole.SOC_MANAGER.value, "cases", "close", cfg) is False  # the override applied
    matrix = resolve_matrix(cfg)
    assert matrix[UserRole.SOC_MANAGER.value]["team"] == ["view"]
    assert "team" not in matrix[UserRole.ANALYST_TIER2.value]
    assert DEFAULT_MATRIX[UserRole.SUPER_ADMIN.value]["team"] == ["*"]


def test_a_stored_override_can_revoke_team_view() -> None:
    cfg = RBACConfig(enabled=True, roles={UserRole.AUDITOR.value: {"team": []}})
    assert can(UserRole.AUDITOR.value, "team", "view", cfg) is False


def test_the_console_mirror_lists_team_view() -> None:
    source = WEB_ROLES.read_text(encoding="utf-8")
    block = re.search(r"export const RESOURCE_ACTIONS: Record<string, string\[\]> = \{(.*?)\n\};", source, re.S)
    assert block is not None
    assert "  team: ['view']," in block.group(1)


# --------------------------------------------------------------------------- #
# The event catalog (D7.5)
# --------------------------------------------------------------------------- #
ROUND15_ACTIONS: dict[str, str] = {
    **{action: "case_work" for action in CASE_LIFECYCLE_AUDIT_ACTIONS.values()},
    **{action: "case_work" for action in CASE_COLLAB_AUDIT_ACTIONS},
    CASE_GRADED_AUDIT_ACTION: "case_work",
    "case.file_attached": "case_work",
    "case.file_deleted": "case_work",
    "case.file_attach_failed": "case_work",
    "case.file_delete_failed": "case_work",
    "case.review_recorded": "case_work",
    "case.review_record_failed": "case_work",
    "case.review_requested": "system",
    "case.review_request_failed": "system",
    "team.viewed": "access",
}


def test_every_round15_action_has_an_exact_entry_in_its_category() -> None:
    assert len(CASE_LIFECYCLE_AUDIT_ACTIONS) == 11
    for action, category in ROUND15_ACTIONS.items():
        entry = events.TABLE.action_by_name.get(action)
        assert entry is not None, action
        assert entry.category == category, action
        assert events.classify({"action": action}).label == entry.label


def test_the_failure_names_derive_from_the_base_verbs() -> None:
    from app.audit.write import failure_action

    assert failure_action("case.file_attached") == "case.file_attach_failed"
    assert failure_action("case.file_deleted") == "case.file_delete_failed"
    assert failure_action("case.review_recorded") == "case.review_record_failed"
    assert failure_action("case.review_requested") == "case.review_request_failed"


def test_no_two_round15_entries_share_a_name_with_another_entry() -> None:
    labels = [entry.label for entry in events.TABLE.actions]
    assert len(labels) == len(set(labels))
    legacy = {entry.label for entry in events.TABLE.legacy}
    for action in ROUND15_ACTIONS:
        assert events.TABLE.action_by_name[action].label not in legacy, action


def test_the_sampler_row_is_agent_activity_and_human_work_is_people() -> None:
    system_row = {"action": "case.review_requested", "action_type": "context", "actor": "system",
                  "actor_type": "system"}
    assert not matches(scope_predicate("people"), system_row)
    assert matches(scope_predicate("agent"), system_row)
    for action in ("case.closed", "case.review_recorded", "case.file_attached"):
        assert matches(scope_predicate("people"), {"action": action, "actor": "ann", "actor_type": "human"})
    assert matches(scope_predicate("people"), {"action": "team.viewed", "actor": "ann", "actor_type": "human"})


def _ts_actions(source: str) -> list[dict[str, str]]:
    block = re.search(r"export const AUDIT_ACTIONS: readonly AuditActionEntry\[\] = \[(.*?)\n\];", source, re.S)
    assert block is not None
    found = re.findall(r"\{ action: '([^']+)', category: '([^']+)', label: '([^']+)' \}", block.group(1))
    return [{"action": a, "category": c, "label": label} for a, c, label in found]


def test_the_console_mirror_equals_the_fixture() -> None:
    raw = json.loads(events.FIXTURE_PATH.read_text(encoding="utf-8"))
    assert _ts_actions(WEB_EVENTS.read_text(encoding="utf-8")) == raw["actions"]


# --------------------------------------------------------------------------- #
# The view recorder (D3.10)
# --------------------------------------------------------------------------- #
class _Sink:
    def __init__(self) -> None:
        self.rows: list[dict[str, Any]] = []

    async def record_strict(self, **kwargs: Any) -> None:
        self.rows.append(kwargs)


async def test_the_default_recorder_writes_the_audit_log_view_row() -> None:
    sink = _Sink()
    recorder = views.ViewRecorder(clock=lambda: 0.0)
    assert await recorder.note(sink, actor="ann", view={"list": {}}, summary="Searched the audit log.")
    (row,) = sink.rows
    assert (row["action"], row["surface"], row["action_type"]) == ("audit.viewed", "audit", ActionType.AUDIT_VIEW)
    assert row["outcome"] == "success" and row["actor_type"] == "human"


async def test_the_team_recorder_writes_team_viewed_and_coalesces_for_ten_minutes() -> None:
    assert (views.TEAM_RECORDER.action, views.TEAM_RECORDER.surface) == ("team.viewed", "team")
    clock = [1000.0]
    sink = _Sink()
    recorder = views.ViewRecorder(clock=lambda: clock[0], window=views.TEAM_COALESCE_SECONDS,
                                  action=views.TEAM_VIEW_ACTION, surface=views.TEAM_VIEW_SURFACE)
    view = {"team": {"window": "today"}}
    assert await recorder.note(sink, actor="mgr", view=view, summary="Viewed Team activity: today.")
    clock[0] += 599
    assert not await recorder.note(sink, actor="mgr", view=view, summary="again")
    assert await recorder.note(sink, actor="other", view=view, summary="another viewer")
    clock[0] += 1
    assert await recorder.note(sink, actor="mgr", view=view, summary="after the window")
    assert [r["action"] for r in sink.rows] == ["team.viewed"] * 3
    assert {r["surface"] for r in sink.rows} == {"team"}
    assert views.TEAM_COALESCE_SECONDS == 600.0
    # The audit log's own recorder keeps its five-minute window.
    assert views.RECORDER.action == "audit.viewed" and views.COALESCE_SECONDS == 300.0
