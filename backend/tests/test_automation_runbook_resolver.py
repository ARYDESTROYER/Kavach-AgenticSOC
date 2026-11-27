"""``run_playbook`` automation resolves its runbook through ONE order (Round 14 SPEC
§4.10.16): ``ThresholdAutomation._resolve_runbook`` reads the migration's id map and
hands it to ``runbook_model.resolve_automation_runbook_id``, which alone decides
``runbook_id``, then the id map, then ``LEGACY_BUNDLED_RUNBOOK_MAP``."""

from __future__ import annotations

from typing import Any

import pytest

from app.engine import runbook_model as RM
from app.engine.threshold_automation import ThresholdAutomation

pytestmark = pytest.mark.asyncio


def _automation(migrated: Any) -> ThresholdAutomation:
    async def _migrated() -> Any:
        if isinstance(migrated, Exception):
            raise migrated
        return migrated

    return ThresholdAutomation(None, None, migrated_procedures=_migrated)


async def test_the_automation_delegates_the_whole_order_to_the_resolver(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[Any, Any]] = []

    def resolver(payload: Any, migrated: Any = None) -> str:
        calls.append((payload, migrated))
        return "from-the-resolver"

    monkeypatch.setattr(RM, "resolve_automation_runbook_id", resolver)
    payload = {"playbook_id": "brute_force_login"}
    migrated = {"brute_force_login": "brute_force_login-dir"}
    assert await _automation(migrated)._resolve_runbook(payload) == "from-the-resolver"
    # Nothing is decided before the resolver: it sees the payload and the id map as read.
    assert calls == [(payload, migrated)]


@pytest.mark.parametrize("payload, migrated, expected", [
    ({"runbook_id": "my-runbook", "playbook_id": "malware"}, {"malware": "malware-imported"}, "my-runbook"),
    ({"playbook_id": "brute_force_login"}, {"brute_force_login": "brute_force_login-dir"}, "brute_force_login-dir"),
    ({"playbook_id": "malware"}, {"malware": "malware-imported"}, "malware-imported"),
    ({"playbook_id": "malware"}, {}, "malware-endpoint"),
    ({"playbook_id": "brute_force_login"}, {}, "brute-force-password-spray"),
    ({"playbook_id": "custom_pb"}, {}, None),
], ids=["runbook-id", "bundled-from-folder", "reference-migrated", "reference-unmigrated", "bundled-unmigrated",
        "unknown"])
async def test_the_automation_and_the_resolver_agree(payload: dict, migrated: dict, expected: str | None) -> None:
    assert await _automation(migrated)._resolve_runbook(payload) == expected
    assert RM.resolve_automation_runbook_id(payload, migrated) == expected


async def test_an_unreadable_id_map_still_resolves_the_bundled_ids() -> None:
    automation = _automation(RuntimeError("marker unreadable"))
    assert await automation._resolve_runbook({"playbook_id": "ransomware_response"}) == "ransomware-destructive"
    assert await automation._resolve_runbook({"playbook_id": "custom_pb"}) is None
