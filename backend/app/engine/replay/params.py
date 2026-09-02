"""The submit-time contract for a replay experiment.

This module is the enforcement point for the harness's central rule: an ARM is a
replay CONFIGURATION run NOW, never a historical time period or a shipped build.
``extra="forbid"`` plus this exact field list means a comparison between a fresh
replay and outcomes logged earlier cannot be expressed at all — the corpus is the
causal variable and no snapshot of its earlier state exists, so such a comparison
would be uninterpretable rather than merely weak.
"""

from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from ...config import Provider

FIXTURE_ID_RE = re.compile(r"^fx-[0-9a-f]{32}$")

# Roles whose per-call model configuration an arm may pin. These are exactly the
# three case-pipeline completion roles, so an arm can vary the models under study
# without reaching any input that must be held identical across arms.
ArmRole = Literal["router", "investigator", "formatter"]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ReplayModelOverride(_Strict):
    """One role's model pin for an arm.

    ``base_url``/``api_version``/``region`` are deliberately NOT overridable: a job
    parameter must never be able to open a new egress endpoint.
    """

    provider: Provider
    model: str = Field(min_length=1, max_length=200)
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    max_tokens: int | None = Field(default=None, ge=1, le=32_000)


class ReplayArmSpec(_Strict):
    """A named replay configuration.

    Everything NOT named here is held identical across arms and comes from the
    fixture or the run pin: the fixture bytes, the resolved evidence projection, the
    captured field mapping, the corpus snapshot, WHICH memory entries the run pinned,
    the frozen log source and its time anchor, the enrichment seed,
    correlation/risk/asset configuration, the auto-close policy, analyst rule policies,
    the budget and batch blocks, every threshold block, and the offline ``decide()``
    policy. ``memory_enabled`` varies only whether that one pinned snapshot is injected,
    never its contents.
    """

    arm_id: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]{0,39}$")
    models: dict[ArmRole, ReplayModelOverride] = Field(default_factory=dict)
    rag_top_k: int | None = Field(default=None, ge=1, le=50)
    caps_max_tool_calls: int | None = Field(default=None, ge=0, le=20)
    playbooks_enabled: bool | None = None
    personas_enabled: bool | None = None
    memory_enabled: bool | None = None
    precedent_enabled: bool | None = None


class ReplayExperimentParams(_Strict):
    """Job parameters for one replay run.

    ``spend_bound_usd`` is REQUIRED and has no default: real providers are called with
    real money, so the operator states the ceiling explicitly rather than inheriting
    one. ``alpha`` is a reporting convention, not a threshold tuned to any deployment.
    """

    fixture_ids: list[str] = Field(min_length=1, max_length=200)
    arms: list[ReplayArmSpec] = Field(min_length=1, max_length=2)
    repeats: int = Field(default=2, ge=1, le=3)
    spend_bound_usd: float = Field(gt=0.0, le=1000.0)
    alpha: float = Field(default=0.05, gt=0.0, lt=0.5)
    corpus_chunk_limit: int = Field(default=5000, ge=1, le=50_000)

    @field_validator("fixture_ids")
    @classmethod
    def _canonical_fixture_ids(cls, value: list[str]) -> list[str]:
        normalized = [str(item).strip() for item in value]
        if any(not FIXTURE_ID_RE.match(item) for item in normalized):
            raise ValueError("fixture_ids must be canonical replay fixture identifiers")
        if len(set(normalized)) != len(normalized):
            raise ValueError("fixture_ids must be unique")
        return normalized

    @model_validator(mode="after")
    def _unique_arm_ids(self) -> "ReplayExperimentParams":
        ids = [arm.arm_id for arm in self.arms]
        if len(set(ids)) != len(ids):
            raise ValueError("arm_id must be unique across arms")
        return self
