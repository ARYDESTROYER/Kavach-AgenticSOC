"""Platform tools: ``source_health``, ``automation_status`` and ``audit_search``
(chat revamp SPEC §5.3).

* ``source_health`` builds the SAME rows and rollup as ``GET /api/sources/health``
  and ``GET /api/sources/coverage`` (``engine.source_health``) through the context's
  ``source_health_rows()`` callable (which the route binds to the demo overlay in Demo
  Mode). Connector error TEXT never reaches the observation: only whether the last
  poll failed (raw exception text is not allowed in a prompt, §5.2).
* ``automation_status`` is KIND-GATED: each kind has its own grant (tuning and
  schedulers and telemetry gaps ``automation:read``, baselines ``settings:read``,
  approvals ``proposals:read``, rule versions ``rules:read``). Every kind is a pure
  read: tuning is the dry-run the Auto-tuning page shows (no ledger row, no proposal,
  no prefs change) and approvals list the queue WITHOUT the route's expiry sweep.
* ``audit_search`` reads the EXECUTION audit only (the demo-switchable trail of agent
  and analyst actions; control-plane auth/RBAC rows stay out of chat) and its
  observation is a STRICT whitelist: counts plus at most ten rows of ``{ts,
  action_type, actor, surface, case_id, tool_name, model, source_id}`` with
  ``result_summary`` and ``query_text`` bounded to 200 characters. ``prompt_excerpt``,
  ``tool_input`` and ``tool_output_summary`` never reach a model; the UI table shows
  ``prompt_excerpt`` only when ``prefs.trace.include_prompts`` is on.
"""

from __future__ import annotations

import inspect
import logging
from collections import Counter
from typing import Any, ClassVar, Literal

from pydantic import Field, field_validator

from ...constants import ActionType
from ...utils import now_utc, to_millis
from .base import Artifact, ChatTool, ChatToolContext, ToolOutcome
from .common import (
    ToolInput,
    categories,
    column,
    finite,
    fmt_int,
    iso_or_none,
    kpi,
    millis_to_iso,
    none_if_blank,
    opt_text,
    parse_input,
    resolve_window,
    text,
)

logger = logging.getLogger("tlsoc.agents.chat_tools.ops")


async def _maybe_await(value: Any) -> Any:
    return await value if inspect.isawaitable(value) else value


# --------------------------------------------------------------------------- #
# source_health
# --------------------------------------------------------------------------- #
class SourceHealthInput(ToolInput):
    source_id: str | None = Field(default=None, max_length=128)

    @field_validator("source_id", mode="before")
    @classmethod
    def _blank(cls, value: Any) -> Any:
        return none_if_blank(value)


def _poll_time(value: Any) -> str | None:
    """The poller snapshot's last-poll instant (epoch millis or ISO) as ISO-8601."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return millis_to_iso(value)
    return iso_or_none(value)


def _source_state(row: dict[str, Any]) -> str:
    if not row.get("enabled"):
        return "disabled"
    if row.get("silent"):
        return "silent"
    if row.get("last_poll_ok") is False or row.get("last_poll_error"):
        return "error"
    state = row.get("state")
    return str(state) if isinstance(state, str) and state else "ok"


class SourceHealthTool(ChatTool):
    name: ClassVar[str] = "source_health"
    label: ClassVar[str] = "Checked source health"
    scope: ClassVar[str] = "platform"
    requires: ClassVar[tuple[tuple[str, str], ...]] = (("sources", "read"),)
    data_source: ClassVar[str] = "Source health and ingest coverage"
    signature: ClassVar[str] = (
        "source_health(source_id?) -- configured log sources: silent sources, events per minute, "
        "last event and last poll, plus the coverage rollup"
    )
    display_keys: ClassVar[tuple[str, ...]] = ("source_id",)

    async def run(self, ctx: ChatToolContext, **inp: Any) -> ToolOutcome:
        from ...engine.source_health import coverage_rollup

        args, error = parse_input(SourceHealthInput, inp)
        if error is not None:
            return error
        if ctx.source_health_rows is None:
            return ToolOutcome.failure("Source health is not available")
        try:
            rows = [r for r in (await _maybe_await(ctx.source_health_rows()) or []) if isinstance(r, dict)]
        except Exception as exc:  # noqa: BLE001
            logger.warning("source health rows failed: %s", exc)
            return ToolOutcome.failure("Source health could not be read")
        if args.source_id:
            rows = [r for r in rows if r.get("source_id") == args.source_id]
            if not rows:
                return ToolOutcome.failure("Unknown log source")
        now_ms = int(to_millis(now_utc()))
        rollup = coverage_rollup(rows, now_ms)
        projected = []
        for r in rows:
            last_event = int(finite(r.get("last_event_millis")) or 0)
            projected.append({
                "source_id": text(r.get("source_id"), 128),
                "name": text(r.get("source_name") or r.get("source_id"), 120),
                "type": text(r.get("source_type"), 40),
                "kind": text(r.get("kind") or r.get("ingest_mode"), 40),
                "enabled": bool(r.get("enabled")),
                "state": _source_state(r),
                "silent": bool(r.get("silent")),
                "events_per_min": finite(r.get("events_per_min")),
                "last_event_at": millis_to_iso(last_event),
                "last_event_age_seconds": (now_ms - last_event) // 1000 if last_event > 0 else None,
                "last_poll_at": _poll_time(r.get("last_poll_at")),
                "last_poll_failed": (r.get("last_poll_ok") is False) or bool(r.get("last_poll_error")),
                "demo": bool(r.get("demo")),
            })
        observation = {"coverage": rollup, "sources": projected[:30], "listed": len(projected)}
        artifacts = [
            Artifact(id="a1", kind="kpis", title="Ingest coverage", title_trusted=True, data={"items": [
                kpi("enabled", "Sources enabled", rollup.get("sources_enabled"), context=f"of {fmt_int(rollup.get('sources_total'))}"),
                kpi("silent", "Silent sources", rollup.get("sources_silent")),
                kpi("eps", "Events per minute", finite(rollup.get("events_per_min"))),
                kpi("worst_age", "Oldest last event", rollup.get("worst_last_event_seconds"), "seconds"),
            ]}, provenance="code"),
            Artifact(id="a2", kind="table", title="Sources", title_trusted=True, data={
                "columns": [
                    column("name", "Source", untrusted=True), column("type", "Type"), column("kind", "Kind"),
                    column("state", "State"), column("eps", "Events/min", "number", align="right"),
                    column("last_event", "Last event", "time"), column("last_poll", "Last poll", "time"),
                ],
                "rows": [[p["name"], p["type"], p["kind"], p["state"], p["events_per_min"], p["last_event_at"],
                          p["last_poll_at"]]
                         for p in projected[:200]],
            }, provenance="code", untrusted_labels=True, total=len(projected), truncated=len(projected) > 200),
        ]
        summary = (f"{fmt_int(rollup.get('sources_enabled'))} of {fmt_int(rollup.get('sources_total'))} sources "
                   f"enabled, {fmt_int(rollup.get('sources_silent'))} silent, "
                   f"{rollup.get('events_per_min', 0)} events/min")
        return ToolOutcome(ok=True, summary=summary, observation=observation, artifacts=artifacts,
                           rows=len(projected), basis="exact",
                           sources=[p["name"] for p in projected][:20])


# --------------------------------------------------------------------------- #
# automation_status
# --------------------------------------------------------------------------- #
AUTOMATION_KINDS: tuple[str, ...] = (
    "tuning", "baselines", "approvals", "schedulers", "telemetry_gaps", "rule_versions",
)


_AUTOMATION_KIND_ALIASES = {
    "baseline": "baselines", "approval": "approvals", "proposals": "approvals",
    "scheduler": "schedulers", "telemetry": "telemetry_gaps", "rules": "rule_versions",
    "versions": "rule_versions",
}


def canonical_automation_kind(value: Any) -> Any:
    """The canonical kind for a model-written spelling (aliases folded). The grant
    check and the input model share it, so an alias can never reach a kind without
    that kind's grant being checked."""
    if isinstance(value, str):
        key = value.strip().lower().replace("-", "_").replace(" ", "_")
        return _AUTOMATION_KIND_ALIASES.get(key, key)
    return value


class AutomationStatusInput(ToolInput):
    kind: Literal[AUTOMATION_KINDS]  # type: ignore[valid-type]
    rule_id: str | None = Field(default=None, max_length=128)
    limit: int = Field(default=20, ge=1, le=50)

    @field_validator("kind", mode="before")
    @classmethod
    def _kind(cls, value: Any) -> Any:
        return canonical_automation_kind(value)

    @field_validator("rule_id", mode="before")
    @classmethod
    def _blank(cls, value: Any) -> Any:
        return none_if_blank(value)


# What each kind reads, for the per-caller signature (engine text).
_AUTOMATION_KIND_TEXT: dict[str, str] = {
    "tuning": "threshold tuning (dry run)",
    "baselines": "baseline warm-up",
    "approvals": "pending approvals",
    "schedulers": "background workers",
    "telemetry_gaps": "evidence-backed telemetry gaps",
    "rule_versions": "rule version history",
}


def automation_signature(kinds: Any) -> str:
    """The one-line signature listing only ``kinds`` (in catalogue order)."""
    listed = [k for k in AUTOMATION_KINDS if k in set(kinds)]
    rule_id = ", rule_id?" if any(k in ("tuning", "rule_versions") for k in listed) else ""
    what = ", ".join(_AUTOMATION_KIND_TEXT[k] for k in listed)
    return f"automation_status(kind={'|'.join(listed)}{rule_id}, limit?=20) -- read-only view of {what}"


class AutomationStatusTool(ChatTool):
    name: ClassVar[str] = "automation_status"
    label: ClassVar[str] = "Read automation status"
    scope: ClassVar[str] = "platform"
    requires: ClassVar[tuple[tuple[str, str], ...]] = ()
    kind_permissions: ClassVar[dict[str, tuple[str, str]]] = {
        "tuning": ("automation", "read"),
        "schedulers": ("automation", "read"),
        "telemetry_gaps": ("automation", "read"),
        "baselines": ("settings", "read"),
        "approvals": ("proposals", "read"),
        "rule_versions": ("rules", "read"),
    }
    data_source: ClassVar[str] = "Automation: tuning, baselines, approvals, schedulers, rules"
    # The full catalogue signature; a caller's prompt gets :meth:`signature_for`.
    signature: ClassVar[str] = automation_signature(AUTOMATION_KINDS)
    display_keys: ClassVar[tuple[str, ...]] = ("kind", "rule_id", "limit")

    @staticmethod
    def canonical_kind(value: Any) -> Any:
        return canonical_automation_kind(value)

    @staticmethod
    def kind_available(ctx: ChatToolContext, kind: str) -> bool:
        """Whether this deployment's context can serve ``kind``: rule version history
        needs a ``rule_versions`` store on the context (an optional field the route
        builder sets). A kind that cannot work is never advertised to a model."""
        return kind != "rule_versions" or getattr(ctx, "rule_versions", None) is not None

    def kinds_for(self, ctx: ChatToolContext) -> list[str]:
        """The kinds this caller may use here: granted AND available."""
        return [k for k in self.allowed_kinds(ctx.grants) if self.kind_available(ctx, k)]

    def signature_for(self, ctx: ChatToolContext) -> str | None:
        """The caller's signature (only its usable kinds), or ``None`` when it has
        none, which keeps the tool out of the prompt altogether."""
        kinds = self.kinds_for(ctx)
        return automation_signature(kinds) if kinds else None

    async def run(self, ctx: ChatToolContext, **inp: Any) -> ToolOutcome:
        args, error = parse_input(AutomationStatusInput, inp)
        if error is not None:
            return error
        missing = ctx.missing(self, args.kind)
        if missing:  # defence in depth: the toolbox already refused (and audited) this
            return ToolOutcome.failure("Not permitted: requires " + ", ".join(missing), status="denied")
        handler = getattr(self, f"_{args.kind}")
        try:
            return await handler(ctx, args)
        except Exception as exc:  # noqa: BLE001 — engine template only
            logger.warning("automation_status %s failed: %s", args.kind, exc)
            return ToolOutcome.failure("The automation status could not be read")

    async def _tuning(self, ctx: ChatToolContext, args: AutomationStatusInput) -> ToolOutcome:
        from ...config import ThresholdTuningConfig
        from ...engine import threshold_tuner as tuner

        if ctx.cases is None or ctx.tuning is None:
            return ToolOutcome.failure("Threshold tuning is not available")
        cfg = getattr(ctx.prefs, "threshold_tuning", None) or ThresholdTuningConfig()
        reader = tuner.terminal_case_reader(ctx.cases)
        cases: list[Any] = []
        offset = 0
        page_size = 500
        max_cases = 2_000
        while len(cases) < max_cases:
            page = await reader(page_size, offset)
            if not page:
                break
            cases.extend(page)
            offset += len(page)
            if len(page) < page_size:
                break
        truncated = len(cases) >= max_cases
        stats = tuner._accumulate_rule_stats(cases, ewma_alpha=cfg.ewma_alpha, z=cfg.wilson_z)
        ledger = await ctx.tuning.list_strict()
        already, floors = tuner.tuning_guards_from_records(ledger, tuner.tuning_window_start(cfg.cadence))
        proposals = tuner.derive_proposals(ctx.prefs, stats, already_tuned=already, already_tuned_floors=floors)
        by_rule = {p.rule_id: p for p in proposals}
        rules = sorted(stats.values(), key=lambda s: (-s.fp_lower_bound, -s.observed, s.rule_id))
        if args.rule_id:
            rules = [s for s in rules if s.rule_id == args.rule_id]
        rows = []
        for st in rules[: args.limit]:
            prop = by_rule.get(st.rule_id)
            blocked = bool(prop and cfg.shadow_eval and prop.kind != "suppression"
                           and tuner.shadow_eval_hides_true_positive(prop, cases))
            rows.append({
                "rule": text(st.rule_id, 120),
                "observed": st.observed,
                "analyst_samples": st.total,
                "fp_rate_lower_bound": round(st.fp_lower_bound, 4),
                "over_target": st.total >= int(cfg.min_samples) and st.fp_lower_bound > float(cfg.fp_rate_target),
                "recommendation": prop.kind if prop else None,
                "before": prop.before if prop else None,
                "after": prop.after if prop else None,
                "blocked_by_shadow_eval": blocked,
            })
        observation = {
            "enabled": bool(cfg.enabled), "auto_apply_confirmed": bool(cfg.auto_apply_confirmed),
            "fp_rate_target": float(cfg.fp_rate_target), "min_samples": int(cfg.min_samples),
            "window_cases": len(cases), "window_truncated": truncated,
            "rules_observed": len(stats), "recommendations": len(proposals),
            "rules": rows, "applied_changes_in_ledger": len(ledger),
            "note": "dry run: nothing was applied or proposed",
        }
        artifacts = [
            Artifact(id="a1", kind="kpis", title="Threshold tuning", title_trusted=True, data={"items": [
                kpi("rules", "Rules observed", len(stats)),
                kpi("over_target", "Over the FP target", sum(1 for r in rows if r["over_target"]),
                    context=None if len(rules) <= args.limit else "in the listed rules"),
                kpi("recommendations", "Recommendations", len(proposals)),
                kpi("window_cases", "Closed cases read", len(cases), bound=truncated),
            ]}, provenance="code"),
            Artifact(id="a2", kind="table", title="Rule noise", title_trusted=True, data={
                "columns": [
                    column("rule", "Rule", untrusted=True), column("observed", "Closed cases", "number", align="right"),
                    column("samples", "Analyst-labelled", "number", align="right"),
                    column("fp", "FP rate (lower bound)", "number", unit="ratio", align="right"),
                    column("recommendation", "Recommendation"), column("change", "Change"),
                ],
                "rows": [[r["rule"], r["observed"], r["analyst_samples"], r["fp_rate_lower_bound"],
                          r["recommendation"] or "none",
                          f"{r['before']} -> {r['after']}" if r["recommendation"] else None] for r in rows],
            }, provenance="code", untrusted_labels=True, total=len(rules), truncated=len(rules) > len(rows)),
        ]
        summary = (f"Tuning dry run: {fmt_int(len(stats))} rules observed over {fmt_int(len(cases))} closed cases, "
                   f"{fmt_int(len(proposals))} recommendations")
        return ToolOutcome(ok=True, summary=summary, observation=observation, artifacts=artifacts,
                           rows=len(rows), basis="sample" if truncated else "exact")

    async def _baselines(self, ctx: ChatToolContext, args: AutomationStatusInput) -> ToolOutcome:
        if ctx.baseline is None:
            return ToolOutcome.failure("Baselining is not available")
        cfg = getattr(ctx.prefs, "baseline", None)
        series = await ctx.baseline.snapshot()
        sigs = []
        total_buckets = warm_buckets = 0
        for sig, buckets in (series or {}).items():
            n_warm = sum(1 for st in buckets.values() if getattr(st, "warm", False))
            total_buckets += len(buckets)
            warm_buckets += n_warm
            sigs.append({"signature": text(sig, 120), "buckets": len(buckets), "warm_buckets": n_warm,
                         "max_samples": int(max((getattr(st, "n_samples", 0) for st in buckets.values()), default=0))})
        sigs.sort(key=lambda s: (-s["warm_buckets"], s["signature"]))
        observation = {
            "enabled": bool(getattr(cfg, "enabled", False)), "signatures": len(sigs),
            "buckets": total_buckets, "warm_buckets": warm_buckets,
            "seasonality": text(getattr(cfg, "seasonality", "hour_of_week"), 40),
            "top": sigs[: min(args.limit, 15)],
        }
        warm_pct = round(100 * warm_buckets / total_buckets, 1) if total_buckets else None
        artifacts = [
            Artifact(id="a1", kind="kpis", title="Baseline warm-up", title_trusted=True, data={"items": [
                kpi("signatures", "Baselined signatures", len(sigs)),
                kpi("warm", "Warm buckets", warm_pct, "percent", display="gauge",
                    context=f"{fmt_int(warm_buckets)} of {fmt_int(total_buckets)}"),
            ]}, provenance="code"),
            Artifact(id="a2", kind="table", title="Baselines", title_trusted=True, data={
                "columns": [column("signature", "Signature", "code", untrusted=True),
                            column("buckets", "Buckets", "number", align="right"),
                            column("warm", "Warm", "number", align="right"),
                            column("samples", "Max samples", "number", align="right")],
                "rows": [[s["signature"], s["buckets"], s["warm_buckets"], s["max_samples"]] for s in sigs[: args.limit]],
            }, provenance="code", untrusted_labels=True, total=len(sigs), truncated=len(sigs) > args.limit),
        ]
        summary = f"{fmt_int(len(sigs))} baselined signatures; {fmt_int(warm_buckets)} of {fmt_int(total_buckets)} buckets warm"
        return ToolOutcome(ok=True, summary=summary, observation=observation, artifacts=artifacts,
                           rows=len(sigs), basis="exact")

    async def _approvals(self, ctx: ChatToolContext, args: AutomationStatusInput) -> ToolOutcome:
        if ctx.proposals is None:
            return ToolOutcome.failure("The approval queue is not available")
        from ...engine.views import proposal_public

        # ``ProposalStore.list`` only: the route's expiry sweep is a write (§5.2).
        pending = await ctx.proposals.list(status="pending")
        public = [proposal_public(p) for p in pending]
        public = [p for p in public if not p.get("expired")]
        by_kind = Counter(str(p.get("kind") or "other") for p in public)
        rows = public[: args.limit]
        observation = {
            "pending": len(public), "by_kind": dict(by_kind),
            "items": [{
                "id": text(p.get("id"), 80), "kind": text(p.get("kind"), 40),
                "created_by": text(p.get("created_by"), 60), "created_at": p.get("created_at"),
                "expires_at": p.get("expires_at"), "cases": len(p.get("source_case_ids") or []),
                "confidence": finite(p.get("confidence")),
                "rationale": opt_text(p.get("rationale"), 200),
                "approvable": bool((p.get("evidence") or {}).get("approvable", True)),
            } for p in rows[:10]],
        }
        artifacts = [
            Artifact(id="a1", kind="kpis", title="Approvals", title_trusted=True, data={"items": [
                kpi("pending", "Pending approvals", len(public)),
            ] + [kpi(f"kind_{k}"[:64], f"{k}"[:60], v) for k, v in by_kind.most_common(3)]},
                provenance="code"),
            Artifact(id="a2", kind="table", title="Pending approvals", title_trusted=True, data={
                "columns": [column("kind", "Kind"), column("created_by", "Requested by", untrusted=True),
                            column("created_at", "Requested", "time"), column("expires_at", "Expires", "time"),
                            column("cases", "Cases", "number", align="right"),
                            column("rationale", "Why", untrusted=True)],
                "rows": [[p.get("kind"), p.get("created_by"), p.get("created_at"), p.get("expires_at"),
                          len(p.get("source_case_ids") or []), opt_text(p.get("rationale"), 300)] for p in rows],
            }, provenance="code", untrusted_labels=True, total=len(public), truncated=len(public) > len(rows)),
            Artifact(id="a3", kind="guide", title="Approval pages", title_trusted=True,
                     data={"links": [{"label": "Open Approvals", "ref": {"page": "approvals"}}]}, provenance="code"),
        ]
        summary = f"{fmt_int(len(public))} pending approvals"
        return ToolOutcome(ok=True, summary=summary, observation=observation, artifacts=artifacts,
                           rows=len(public), basis="exact")

    async def _schedulers(self, ctx: ChatToolContext, args: AutomationStatusInput) -> ToolOutcome:
        if ctx.scheduler_health is None:
            return ToolOutcome.failure("Scheduler health is not available")
        health = await _maybe_await(ctx.scheduler_health()) or {}
        workers = health.get("workers") if isinstance(health, dict) else {}
        rows = []
        for name, w in (workers or {}).items():
            if not isinstance(w, dict):
                continue
            rows.append({
                "worker": text(name, 60), "enabled": bool(w.get("enabled")), "running": bool(w.get("running")),
                "cadence": text(w.get("cadence"), 40), "last_success_at": w.get("last_success_at") or None,
                "last_attempt_at": w.get("last_attempt_at") or None,
                "last_attempt_failed": bool(w.get("last_error")), "processed": w.get("processed"),
            })
        observation = {"runtime_running": bool((health or {}).get("scheduler_runtime_running")), "workers": rows}
        artifacts = [Artifact(id="a1", kind="table", title="Background workers", title_trusted=True, data={
            "columns": [column("worker", "Worker", "code"), column("enabled", "Enabled"), column("running", "Running"),
                        column("cadence", "Cadence"), column("last_success", "Last success", "time"),
                        column("failed", "Last attempt failed")],
            "rows": [[r["worker"], "yes" if r["enabled"] else "no", "yes" if r["running"] else "no", r["cadence"],
                      r["last_success_at"], "yes" if r["last_attempt_failed"] else "no"] for r in rows],
        }, provenance="code")]
        failing = sum(1 for r in rows if r["last_attempt_failed"])
        summary = f"{fmt_int(len(rows))} background workers; {fmt_int(failing)} with a failed last attempt"
        return ToolOutcome(ok=True, summary=summary, observation=observation, artifacts=artifacts,
                           rows=len(rows), basis="exact")

    async def _telemetry_gaps(self, ctx: ChatToolContext, args: AutomationStatusInput) -> ToolOutcome:
        from ...engine.telemetry_recommendations import recommend_sources
        from .cases import load_case_page

        cases, store_total, ok = await load_case_page(ctx)
        if not ok:
            return ToolOutcome.failure("The case store did not answer")
        recs = recommend_sources(cases)
        observation = {
            "recommendations": [{
                "source_type": text(r.get("source_type"), 60), "field": text(r.get("field"), 80),
                "benefit": opt_text(r.get("benefit"), 200), "affected_cases": r.get("affected_case_count"),
            } for r in recs[: args.limit]],
            "scanned_cases": len(cases), "truncated": store_total > len(cases),
            "note": None if recs else "no query-backed telemetry gap is recorded; missing connectors alone are not evidence",
        }
        artifacts = [Artifact(id="a1", kind="table", title="Telemetry gaps", title_trusted=True, data={
            "columns": [column("source_type", "Source type"), column("field", "Missing field", "code"),
                        column("cases", "Affected cases", "number", align="right"),
                        column("benefit", "Benefit")],
            "rows": [[r.get("source_type"), r.get("field"), r.get("affected_case_count"), r.get("benefit")]
                     for r in recs[: args.limit]],
        }, provenance="code", total=len(recs), truncated=len(recs) > args.limit)]
        summary = f"{fmt_int(len(recs))} evidence-backed telemetry gaps over {fmt_int(len(cases))} cases"
        return ToolOutcome(ok=True, summary=summary, observation=observation, artifacts=artifacts,
                           rows=len(recs), basis="exact" if store_total <= len(cases) else "sample")

    async def _rule_versions(self, ctx: ChatToolContext, args: AutomationStatusInput) -> ToolOutcome:
        store = getattr(ctx, "rule_versions", None)
        if store is None:
            return ToolOutcome.failure("Rule version history is not available to chat yet")
        # The strict read raises on an unreadable ledger (reported as "could not be
        # read" by ``run``) instead of presenting an outage as "0 rule versions".
        reader = getattr(store, "list_strict", None) or store.list
        versions = await reader(rule_id=args.rule_id) if args.rule_id else await reader()
        rows = versions[: args.limit]
        observation = {
            "versions": [{
                "kind": text(v.kind, 40), "rule_id": text(v.rule_id, 120), "action": text(v.action, 20),
                "actor": opt_text(v.actor, 80), "created_at": v.created_at, "summary": opt_text(v.summary, 200),
            } for v in rows[:10]],
            "total": len(versions),
        }
        artifacts = [Artifact(id="a1", kind="table", title="Rule versions", title_trusted=True, data={
            "columns": [column("kind", "Kind"), column("rule", "Rule", untrusted=True), column("action", "Change"),
                        column("actor", "By", untrusted=True), column("at", "When", "time"),
                        column("summary", "Note", untrusted=True)],
            "rows": [[v.kind, v.rule_id, v.action, v.actor or None, v.created_at, opt_text(v.summary, 300)] for v in rows],
        }, provenance="code", untrusted_labels=True, total=len(versions), truncated=len(versions) > len(rows))]
        summary = f"{fmt_int(len(versions))} rule versions"
        return ToolOutcome(ok=True, summary=summary, observation=observation, artifacts=artifacts,
                           rows=len(versions), basis="exact",
                           untrusted_params={"rule_id": args.rule_id} if args.rule_id else {})


# --------------------------------------------------------------------------- #
# audit_search
# --------------------------------------------------------------------------- #
_ACTION_TYPES = tuple(a.value for a in ActionType)
# The ONLY row keys that may reach a model (§5.3). Anything else in an audit row —
# notably prompt_excerpt, tool_input and tool_output_summary — is dropped here.
AUDIT_OBSERVATION_KEYS: tuple[str, ...] = (
    "ts", "action_type", "actor", "surface", "case_id", "tool_name", "model", "source_id",
)
AUDIT_FENCED_TEXT_KEYS: tuple[str, ...] = ("result_summary", "query_text")
_AUDIT_TEXT_CHARS = 200
_AUDIT_OBS_ROWS = 10
_AUDIT_READ_LIMIT = 500


class AuditSearchInput(ToolInput):
    actor: str | None = Field(default=None, max_length=128)
    action_type: Literal[_ACTION_TYPES] | None = None  # type: ignore[valid-type]
    surface: str | None = Field(default=None, max_length=40)
    case_id: str | None = Field(default=None, max_length=128)
    source_id: str | None = Field(default=None, max_length=128)
    window_hours: int | None = Field(default=None, ge=1, le=720)
    time_from: str | None = Field(default=None, max_length=40)
    time_to: str | None = Field(default=None, max_length=40)
    limit: int = Field(default=25, ge=1, le=100)

    @field_validator("actor", "surface", "case_id", "source_id", "window_hours", "time_from", "time_to", mode="before")
    @classmethod
    def _blank(cls, value: Any) -> Any:
        return none_if_blank(value)

    @field_validator("action_type", mode="before")
    @classmethod
    def _action(cls, value: Any) -> Any:
        value = none_if_blank(value)
        return value.strip().lower() if isinstance(value, str) else value


def audit_observation_row(row: dict[str, Any]) -> dict[str, Any]:
    """The whitelisted model-visible projection of one audit row."""
    out: dict[str, Any] = {}
    for key in AUDIT_OBSERVATION_KEYS:
        value = row.get(key)
        out[key] = text(value, 160) if isinstance(value, str) and value else None
    for key in AUDIT_FENCED_TEXT_KEYS:
        out[key] = opt_text(row.get(key), _AUDIT_TEXT_CHARS)
    return out


class AuditSearchTool(ChatTool):
    name: ClassVar[str] = "audit_search"
    label: ClassVar[str] = "Searched the audit trail"
    scope: ClassVar[str] = "platform"
    requires: ClassVar[tuple[tuple[str, str], ...]] = (("audit", "view"),)
    data_source: ClassVar[str] = "Append-only audit trail (agent and analyst actions)"
    signature: ClassVar[str] = (
        "audit_search(actor?, action_type?, surface?, case_id?, source_id?, window_hours?, time_from?, time_to?, "
        "limit?=25) -- what agents and analysts did: counts by action, actor and surface plus recent rows"
    )
    display_keys: ClassVar[tuple[str, ...]] = (
        "actor", "action_type", "surface", "case_id", "source_id", "window_hours", "time_from", "time_to", "limit",
    )

    async def run(self, ctx: ChatToolContext, **inp: Any) -> ToolOutcome:
        args, error = parse_input(AuditSearchInput, inp)
        if error is not None:
            return error
        audit = ctx.audit
        if audit is None or not hasattr(audit, "records"):
            return ToolOutcome.failure("The audit trail is not available")
        window = resolve_window(ctx, time_from=args.time_from, time_to=args.time_to,
                                window_hours=args.window_hours, default_hours=24)
        if isinstance(window, str):
            return ToolOutcome.failure(window)
        case_id = args.case_id or ctx.case_id
        try:
            rows = await audit.records(
                actor=args.actor, action_type=args.action_type, surface=args.surface, case_id=case_id,
                source_id=args.source_id, ts_from=window.iso_from(), ts_to=window.iso_to(),
                limit=_AUDIT_READ_LIMIT,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("audit_search read failed: %s", exc)
            return ToolOutcome.failure("The audit trail did not answer")
        rows = [r for r in rows or [] if isinstance(r, dict)]
        capped = len(rows) >= _AUDIT_READ_LIMIT
        by_action = Counter(str(r.get("action_type") or "unknown") for r in rows)
        by_actor = Counter(text(r.get("actor"), 80) or "unknown" for r in rows)
        by_surface = Counter(text(r.get("surface"), 40) or "none" for r in rows)
        shown = rows[: args.limit]
        observation = {
            "window": window.label,
            "filters": {k: v for k, v in {"actor": args.actor, "action_type": args.action_type,
                                          "surface": args.surface, "case_id": case_id,
                                          "source_id": args.source_id}.items() if v},
            "matched": len(rows), "newest_rows_only": capped,
            "by_action_type": dict(by_action.most_common(15)),
            "by_actor": dict(by_actor.most_common(10)),
            "by_surface": dict(by_surface.most_common(10)),
            "rows": [audit_observation_row(r) for r in shown[:_AUDIT_OBS_ROWS]],
        }
        include_prompts = bool(getattr(getattr(ctx.prefs, "trace", None), "include_prompts", False))
        columns = [
            column("ts", "Time", "time"), column("action_type", "Action"),
            column("actor", "Actor", untrusted=True), column("surface", "Surface"),
            column("case_id", "Case", "case"), column("tool", "Tool", "code"),
            column("model", "Model", "code"), column("summary", "Summary", untrusted=True),
        ]
        if include_prompts:
            columns.append(column("prompt", "Prompt excerpt", "code", untrusted=True))
        table_rows = []
        for r in shown:
            cells = [r.get("ts"), r.get("action_type"), r.get("actor"), r.get("surface"), r.get("case_id"),
                     r.get("tool_name"), r.get("model"), opt_text(r.get("result_summary"), 300)]
            if include_prompts:
                cells.append(opt_text(r.get("prompt_excerpt"), 300))
            table_rows.append(cells)
        events = [
            {"at": r.get("ts"), "label": f"{r.get('action_type') or 'action'} by {text(r.get('actor'), 60) or 'unknown'}",
             "detail": opt_text(r.get("result_summary"), 300), "kind": "action"}
            for r in reversed(shown[:50]) if isinstance(r.get("ts"), str)
        ]
        artifacts = [
            Artifact(id="a1", kind="table", title="Audit rows", title_trusted=True,
                     data={"columns": columns, "rows": table_rows}, provenance="code", untrusted_labels=True,
                     basis="newest_n" if capped else "exact", total=len(rows), truncated=len(rows) > len(shown),
                     window=window.label),
            Artifact(id="a2", kind="categories", title="Actions by type", title_trusted=True,
                     data=categories(list(by_action.items()), dimension="action_type"), provenance="code",
                     basis="newest_n" if capped else "exact", total=len(rows), window=window.label),
        ]
        if events:
            artifacts.append(Artifact(id="a3", kind="timeline", title="Audit timeline", title_trusted=True,
                                      data={"events": events}, provenance="code", untrusted_labels=True,
                                      window=window.label))
        summary = f"{fmt_int(len(rows))}{'+' if capped else ''} audit rows ({window.label})"
        return ToolOutcome(
            ok=True, summary=summary, observation=observation, artifacts=artifacts, rows=len(rows),
            basis="newest_n" if capped else "exact",
            coverage=f"newest {fmt_int(_AUDIT_READ_LIMIT)} rows" if capped else None,
            untrusted_params={k: str(v) for k, v in {"actor": args.actor, "surface": args.surface,
                                                     "case_id": case_id, "source_id": args.source_id}.items() if v},
        )


__all__ = [
    "AUDIT_FENCED_TEXT_KEYS",
    "AUDIT_OBSERVATION_KEYS",
    "AUTOMATION_KINDS",
    "AuditSearchTool",
    "AutomationStatusTool",
    "SourceHealthTool",
    "audit_observation_row",
    "automation_signature",
]
