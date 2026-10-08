"""Shared helpers for the chat-tool tests (chat revamp SPEC §5). No tests here.

* :class:`RecordingAudit` — an audit logger stand-in that keeps every ``record``.
* :func:`make_ctx` — a ``ChatToolContext`` over in-memory stores (fake ES, the real
  case/usage/KV stores), every catalogue grant by default.
* :func:`artifact_block` / :func:`assert_artifacts_render` — project an artifact the
  way the materialiser will (SPEC §7.3, ``ARTIFACT_DATA_SHAPES``) and run it through
  ``blocks.validate_blocks`` so a tool can never ship data no renderer accepts.
* :func:`walk_keys` — every key in a nested observation (whitelist assertions).
* :func:`build_demo_state` / :func:`demo_context` — an AppState with Demo Mode on,
  and a context built from its demo-switchable properties as the route builder will.
"""

from __future__ import annotations

from typing import Any, Iterable

from app.agents.blocks import DEFAULT_VIEW, VIEW_BLOCK_TYPE, validate_blocks
from app.agents.chat_tools.base import Artifact, ChatToolContext, ToolOutcome
from app.agents.chat_tools.registry import catalogue_grant_pairs
from app.config import Preferences, Secrets
from app.es.fake import InMemoryESClient

FORBIDDEN_OBSERVATION_KEYS = frozenset({
    "_raw", "raw_data", "unmapped", "member_event_ids", "member_event_keys", "history",
    "verdict_history", "prompt_excerpt", "tool_input", "tool_output_summary",
    "notifications_sent", "comments",
})


class RecordingAudit:
    """Keeps every audit ``record`` call (kwargs) and answers simple reads."""

    def __init__(self, rows: list[dict[str, Any]] | None = None) -> None:
        self.calls: list[dict[str, Any]] = []
        self._rows = list(rows or [])

    async def record(self, **kwargs: Any) -> None:
        self.calls.append(kwargs)

    async def records(self, **kwargs: Any) -> list[dict[str, Any]]:
        self.read_kwargs = kwargs
        return list(self._rows)

    async def records_for_case(self, case_id: str, limit: int = 500) -> list[dict[str, Any]]:
        return [r for r in self._rows if r.get("case_id") == case_id]


def make_ctx(**overrides: Any) -> ChatToolContext:
    """A context with every catalogue grant, a fresh Preferences and recording
    audits, unless overridden."""
    fields: dict[str, Any] = {
        "prefs": Preferences(),
        "audit": RecordingAudit(),
        "control_audit": RecordingAudit(),
        "grants": catalogue_grant_pairs(),
        "user": "alice",
    }
    fields.update(overrides)
    return ChatToolContext(**fields)


def walk_keys(value: Any) -> set[str]:
    keys: set[str] = set()
    if isinstance(value, dict):
        for k, v in value.items():
            keys.add(str(k))
            keys |= walk_keys(v)
    elif isinstance(value, (list, tuple)):
        for item in value:
            keys |= walk_keys(item)
    return keys


def artifact_block(artifact: Artifact, block_id: str = "b1") -> dict[str, Any]:
    """The default-view block the materialiser builds from ``artifact`` (a test-side
    projection of SPEC §7.3; the real one is ``blocks.to_blocks``)."""
    data = artifact.data
    view = DEFAULT_VIEW[artifact.kind]
    base = {
        "id": block_id, "type": VIEW_BLOCK_TYPE[view], "title": artifact.title,
        "provenance": artifact.provenance, "artifact_kind": artifact.kind,
        "allowed_views": artifact.views(), "untrusted": artifact.untrusted_labels,
        "truncated": artifact.truncated, "total": artifact.total,
    }
    kind = artifact.kind
    if kind == "categories":
        base.update(kind=view, unit=data["unit"], x={"kind": "category", "values": data["labels"]},
                    series=[{"key": "value", "label": "Value", "values": data["values"]}])
    elif kind == "series":
        base.update(kind=view, unit=data["unit"],
                    x={"kind": "time", "values": data["x"], "bucket": data.get("bucket")},
                    series=data["series"])
    elif kind == "funnel":
        base.update(kind="funnel", unit=data["unit"], x={"kind": "category", "values": data["stages"]},
                    series=[{"key": "count", "label": "Count", "values": data["values"]}])
    elif kind == "kpis":
        base.update(items=data["items"])
    elif kind == "heatmap":
        base.update(unit=data["unit"], x={"values": data["x"]}, y={"values": data["y"]}, cells=data["cells"])
    else:
        base.update({k: v for k, v in data.items()})
    return base


def assert_artifacts_render(outcome: ToolOutcome) -> None:
    """Every artifact is well-formed for its kind and survives block validation."""
    for artifact in outcome.artifacts:
        assert not artifact.problems(), (artifact.kind, artifact.problems())
        block = artifact_block(artifact)
        kept, dropped = validate_blocks([block])
        assert kept and not dropped, (artifact.kind, artifact.title, [d.reason for d in dropped])


def assert_observation_whitelisted(outcome: ToolOutcome) -> None:
    leaked = walk_keys(outcome.observation) & FORBIDDEN_OBSERVATION_KEYS
    assert not leaked, leaked


def tool_names(tools: Iterable[Any]) -> list[str]:
    return [t.name for t in tools]


async def build_demo_state():
    """AppState with Demo Mode enabled (seeded, two days of history)."""
    from app.llm.providers import MockProvider
    from app.state import AppState

    secrets = Secrets(_env_file=None, es_store_enabled=False, redis_url="",
                      anthropic_api_key=None, openai_api_key=None)
    overrides = {"anthropic": MockProvider(), "openai": MockProvider(), "mock": MockProvider()}
    state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
    await state.startup(start_poller=False)
    await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
    await state.enable_demo(mode="seeded", seed=1337, history_days=2)
    return state


def demo_context(state: Any, **overrides: Any) -> ChatToolContext:
    """The context the route builder (``state.build_chat_tool_context``) produces in
    Demo Mode, built from the demo-switchable properties."""
    from app.engine.case_cluster import bind_cluster_for_case
    from app.engine.log_rows import demo_browse_targets

    prefs = state.execution_prefs
    fields: dict[str, Any] = dict(
        prefs=prefs, cases=state.cases, audit=state.audit, control_audit=state.control_audit,
        usage=state.usage_store, rag=state.rag_service, campaigns=state.campaign_store,
        proposals=state.proposals, tuning=state.tuning_store, baseline=state.baseline_store,
        noise=state.noise_counters, standup=state.standup_service, memory=state.memory,
        log_source=None,
        source_resolver=lambda sid: state.demo_source_connector(sid),
        browse_sources=lambda: demo_browse_targets(
            state.demo_sources_overlay(), prefs=prefs,
            demo_source_connector=state.demo_source_connector,
        ),
        enrich=None, budget_gate=state.budget_gate, demo_active=True,
        grants=catalogue_grant_pairs(), user="alice",
        source_health_rows=state.demo_source_health_overlay,
        scheduler_health=state.scheduler_health,
        cluster_for_case=bind_cluster_for_case(
            es=state.es, log_source=state.log_source, prefs=prefs,
            query_source_for=state.active_source_for_id,
        ),
    )
    fields.update(overrides)
    return ChatToolContext(**fields)
