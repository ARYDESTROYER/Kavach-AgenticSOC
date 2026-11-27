"""Round 16 WP15E part 2: backend regressions for the setup, settings and administration
fixes (SPEC §4.5 WP15E).

* B36: an automation-drafted approval proposal no longer carries an invented 0.5
  confidence. Only a real number the rule's payload supplies is kept; nothing is made up.
* B45: Branding ``default_theme`` is the one organization theme default. The effective
  prefs stop letting the legacy ``CustomizationConfig.default_theme`` override it, and one
  ``Preferences`` after-validator copies an administrator's earlier non-system legacy
  choice into Branding once (only while Branding is still at its factory default) and
  sets the legacy value to ``system``, so the copy is idempotent and a later Branding
  reset stays reset.
"""

from __future__ import annotations

import pytest

from app.config import (
    AutomationRule,
    BrandingConfig,
    CustomizationConfig,
    Preferences,
    ThresholdAutomationConfig,
)
from app.constants import CaseStatus, EntityType, SourceSurface, Verdict
from app.engine.threshold_automation import ThresholdAutomation
from app.models import Case, Entity, UserPrefs
from app.state import AppState
from app.stores.user_prefs import resolve_effective_prefs


# --------------------------------------------------------------------------- #
# B36: no invented confidence on automation proposals
# --------------------------------------------------------------------------- #
def _case(case_id: str) -> Case:
    return Case(
        case_id=case_id,
        cluster_signature=f"sig:{case_id}",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="203.0.113.5"),
        rule_ids=["modsec_sqli"],
        risk_score=80.0,
        verdict=Verdict.TRUE_POSITIVE,
        confidence=0.9,
        status=CaseStatus.NEEDS_HUMAN,
    )


def _prefs(payload: dict) -> Preferences:
    rule = AutomationRule(id="gate", action="request_approval", conditions={}, payload=payload)
    return Preferences(threshold_automation=ThresholdAutomationConfig(enabled=True, rules=[rule]))


async def _drafted(app_state: AppState, case_id: str, payload: dict):
    case = _case(case_id)
    await app_state.cases.save(case)
    automation = ThresholdAutomation(app_state.proposals, app_state.audit)
    await automation.run(case, _prefs(payload), save=app_state.cases.save)
    pending = await app_state.proposals.list(status="pending")
    return next(p for p in pending if p.source_case_ids == [case_id])


@pytest.mark.asyncio
async def test_b36_a_generic_gate_carries_no_invented_confidence(app_state: AppState) -> None:
    prop = await _drafted(app_state, "b36-generic", {"rationale": "A lead signs off."})
    assert prop.created_by == "automation"
    # Before the fix every automation proposal read 0.5, shown as "50% confidence".
    assert prop.confidence == 0.0


@pytest.mark.asyncio
async def test_b36_an_explicit_zero_is_kept_and_a_real_number_is_used(app_state: AppState) -> None:
    zero = await _drafted(app_state, "b36-zero", {"confidence": 0})
    assert zero.confidence == 0.0  # `or 0.5` used to turn an explicit 0 into 0.5
    real = await _drafted(app_state, "b36-real", {
        "kind": "suppression", "field": "event.module", "value": "modsec_sqli", "confidence": 0.7,
    })
    assert real.confidence == pytest.approx(0.7)


@pytest.mark.asyncio
async def test_b36_a_non_number_confidence_is_not_coerced(app_state: AppState) -> None:
    for i, raw in enumerate(["0.9", True, None, [], {"x": 1}]):
        prop = await _drafted(app_state, f"b36-odd-{i}", {"confidence": raw})
        assert prop.confidence == 0.0, raw


# --------------------------------------------------------------------------- #
# B45: one organization theme default
# --------------------------------------------------------------------------- #
def test_b45_effective_theme_no_longer_takes_the_legacy_org_value() -> None:
    org = CustomizationConfig(default_theme="light")
    eff = resolve_effective_prefs(org, UserPrefs(theme_mode="system"))
    # Before the fix "light" won over Branding for every "system" user; now the Console
    # resolves "system" against Branding, the one organization default.
    assert eff["theme_mode"] == "system"
    # A person's own choice still wins.
    assert resolve_effective_prefs(org, UserPrefs(theme_mode="dark"))["theme_mode"] == "dark"


def test_b45_the_legacy_choice_moves_into_branding_once() -> None:
    prefs = Preferences.model_validate({"customization": {"default_theme": "light"}})
    assert prefs.branding.default_theme == "light"
    assert prefs.branding.effective_theme() == "light"
    assert prefs.customization.default_theme == "system"


def test_b45_the_copy_is_idempotent_and_a_branding_reset_stays_reset() -> None:
    first = Preferences.model_validate({"customization": {"default_theme": "light"}})
    dumped = first.model_dump(mode="json")
    # A second load changes nothing.
    second = Preferences.model_validate(dumped)
    assert second.model_dump(mode="json") == dumped
    # An administrator resets Branding to its factory default after the copy: the
    # legacy value is "system" now, so the next load keeps the reset value.
    reset = dict(dumped)
    reset["branding"] = {**dumped["branding"], "default_theme": "dark", "theme": "dark"}
    again = Preferences.model_validate(reset)
    assert again.branding.default_theme == "dark"
    assert again.customization.default_theme == "system"


def test_b45_an_explicit_branding_choice_is_never_overwritten() -> None:
    prefs = Preferences.model_validate({
        "branding": {"default_theme": "system"},
        "customization": {"default_theme": "light"},
    })
    # Branding is not at its factory default, so it stays the authority. The legacy
    # value still moves to "system" so the two controls can never disagree again.
    assert prefs.branding.default_theme == "system"
    assert prefs.customization.default_theme == "system"


def test_b45_a_legacy_dark_mode_flag_does_not_hide_the_copied_choice() -> None:
    prefs = Preferences.model_validate({
        "branding": {"dark_mode_default": True},
        "customization": {"default_theme": "light"},
    })
    assert prefs.branding.effective_theme() == "light"
    assert prefs.branding.dark_mode_default is False


def test_b45_a_fresh_install_is_unchanged() -> None:
    prefs = Preferences()
    assert prefs.branding.default_theme == "dark"
    assert prefs.customization.default_theme == "system"
    assert prefs.branding == BrandingConfig()
