"""The chat toolbox: the catalogue, per-caller filtering and guarded execution.

Chat revamp SPEC §5.1–§5.3. The engine never calls a tool's ``run`` directly; it
builds ONE :class:`ChatToolbox` per turn with :func:`build_toolbox` and calls
:meth:`ChatToolbox.execute`, which is the single choke point that:

1. re-checks the caller's grants for the tool AND the requested ``kind`` (defence in
   depth: the prompt lists only granted tools, but a model can name any tool) and,
   on a refusal, writes exactly ONE ``ACCESS_DENIED`` control-audit row (§5.1);
2. refuses a tool outside the request's @-scopes (``skipped``, no audit: a scope is a
   selection, not a permission);
3. runs the tool under ``chat_agent.tool_timeout_s`` with the per-call
   :class:`~app.agents.chat_tools.common.ToolCall` bound (turn/step ids for audit
   correlation, the turn's taint ledger), turning any unexpected exception into an
   ENGINE-template error (raw exception text never reaches a prompt or the UI);
4. feeds the call's artifacts to the taint ledger so later calls in the turn may
   look up what this one found (§4.8.3);
5. gives a successful log call's artifacts their EXACT "Open in Logs" view
   (``open_in``, see :func:`~app.agents.chat_tools.common.logs_console_view`), only
   when the Logs page can express the filter the call ran with and every source it
   read applied that filter (never a live-tail ring), over the absolute window the
   call resolved when it started;
6. writes the execution audit row (§5.2): ``ES_QUERY`` for log tools, ``TOOL_CALL``
   otherwise, ``actor`` = the username (``"default"`` when auth is off),
   ``surface="chat"``, ``tool_input`` = the whitelisted display params, the native
   query in ``query_text`` and a ``result_summary`` starting ``turn=<id> step=<n>``.

The catalogue is discovered from the sibling tool modules (the data tools here and
WP-E's ``app_help``/``app_status`` when present), so adding a tool is adding a class.
"""

from __future__ import annotations

import asyncio
import copy
import importlib
import inspect
import logging
import re
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Iterable

from ...constants import ActionType
from ...models import ChatToolInfo
from .base import ChatTool, ChatToolContext, Grant, ToolOutcome, render_tool_signatures
from .common import ToolCall, call_scope, logs_console_view, parse_input
from .taint import TaintLedger

logger = logging.getLogger("tlsoc.agents.chat_tools")

# Display / prompt order (SPEC §5.3 table order). Unknown names follow, sorted.
TOOL_ORDER: tuple[str, ...] = (
    "search_logs", "log_stats", "search_cases", "get_case", "soc_metrics",
    "shift_report", "list_campaigns", "lookup_indicator", "mitre_lookup",
    "search_knowledge", "cost_usage", "source_health", "automation_status",
    "explain_decision", "audit_search", "app_help", "app_status",
)
# Tools whose execution audit row is ``ES_QUERY`` (a read of the log surface).
LOG_TOOLS: frozenset[str] = frozenset({"search_logs", "log_stats"})
# Tools that consume the taint ledger's third-party lookup budget.
BUDGETED_TOOLS: frozenset[str] = frozenset({"lookup_indicator"})
# Modules holding the data tools (this package) and the optional app-knowledge tools
# (WP-E). A missing optional module is not an error: the catalogue simply lacks it.
DATA_TOOL_MODULES: tuple[str, ...] = ("logs", "cases", "metrics", "intel", "ops")
OPTIONAL_TOOL_MODULES: tuple[str, ...] = ("app_help", "app_status")

_ACTOR_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f-\x9f]")
_TOKEN_RE = re.compile(r"[^A-Za-z0-9_.:\-]")
_RESERVED_KWARGS = frozenset({"self", "ctx"})
_AUDIT_SUMMARY_CHARS = 900

_CATALOGUE: tuple[ChatTool, ...] | None = None


def _discover() -> tuple[ChatTool, ...]:
    """Instantiate every concrete :class:`ChatTool` defined in the tool modules,
    once per process (instances are stateless and shared across turns)."""
    found: dict[str, type[ChatTool]] = {}
    for name in DATA_TOOL_MODULES + OPTIONAL_TOOL_MODULES:
        try:
            module = importlib.import_module(f"{__package__}.{name}")
        except Exception as exc:  # noqa: BLE001 — see below
            if name not in OPTIONAL_TOOL_MODULES:
                raise
            # An optional module that is absent or broken must cost only its own
            # tools, never the whole catalogue (an engine treats a failed catalogue
            # as "no tools at all").
            if not (isinstance(exc, ModuleNotFoundError) and exc.name and exc.name.endswith(name)):
                logger.error("optional chat tool module %s failed to import: %s", name, exc)
            continue
        for _attr, obj in inspect.getmembers(module, inspect.isclass):
            if (
                issubclass(obj, ChatTool)
                and obj is not ChatTool
                and obj.__module__ == module.__name__
                and not inspect.isabstract(obj)
            ):
                found.setdefault(obj.name, obj)
    rank = {n: i for i, n in enumerate(TOOL_ORDER)}
    ordered = sorted(found.values(), key=lambda c: (rank.get(c.name, len(rank)), c.name))
    return tuple(cls() for cls in ordered)


def catalogue() -> tuple[ChatTool, ...]:
    """Every chat tool in this build, in display order."""
    global _CATALOGUE
    if _CATALOGUE is None:
        _CATALOGUE = _discover()
    return _CATALOGUE


def get_tool(name: str) -> ChatTool | None:
    return next((t for t in catalogue() if t.name == name), None)


def catalogue_grant_pairs() -> frozenset[Grant]:
    """Every ``(resource, action)`` any tool or tool kind needs — the set the route
    hands ``api.deps.resolve_grants(request, pairs)`` to build ``ctx.grants``."""
    pairs: set[Grant] = set()
    for tool in catalogue():
        pairs.update(tool.requires)
        pairs.update(tool.kind_permissions.values())
        pairs.update(getattr(tool, "optional_grants", ()))
    return frozenset(pairs)


def catalogue_infos(grants: Iterable[Grant]) -> list[ChatToolInfo]:
    """The ``/api/chat/context`` catalogue rows for a caller (no audit writes)."""
    held = frozenset(grants)
    return [tool.info(held) for tool in catalogue()]


def tool_available(tool: ChatTool, ctx: ChatToolContext) -> bool:
    """Configuration that switches a granted tool off for everyone (not a grant):
    ``max_indicator_lookups == 0`` turns ``lookup_indicator`` off (§4.2)."""
    check = getattr(tool, "available", None)
    if callable(check):
        try:
            return bool(check(ctx))
        except Exception:  # noqa: BLE001 — a broken probe hides the tool, never raises
            return False
    return True


def caller_signature(tool: ChatTool, ctx: ChatToolContext) -> str | None:
    """The signature this caller's prompt shows for ``tool``: the tool's
    ``signature_for(ctx)`` hook when it has one (a kind-aware tool lists only the
    kinds the caller holds and the deployment can serve), else its catalogue
    signature. ``None`` keeps the tool out of the prompt. A broken hook falls back
    to the catalogue signature, never raises."""
    hook = getattr(tool, "signature_for", None)
    if not callable(hook):
        return tool.signature
    try:
        signature = hook(ctx)
    except Exception:  # noqa: BLE001 — presentation only
        logger.debug("signature_for failed for %s", tool.name, exc_info=True)
        return tool.signature
    if signature is None:
        return None
    if not isinstance(signature, str) or not signature.startswith(f"{tool.name}(") or "\n" in signature:
        return tool.signature
    return signature


def _for_caller(tool: ChatTool, ctx: ChatToolContext) -> ChatTool | None:
    """A per-turn copy of ``tool`` carrying the caller's signature (instances are
    stateless, so a shallow copy shares everything else), or ``None`` to hide it."""
    signature = caller_signature(tool, ctx)
    if signature is None:
        return None
    if signature == tool.signature:
        return tool
    clone = copy.copy(tool)
    # An instance attribute shadows the class-level signature for this turn only.
    clone.signature = signature  # type: ignore[misc]
    return clone


def _actor(ctx: ChatToolContext) -> str:
    """The audit actor exactly as the other chat audit writers spell it (control
    characters removed, 160 chars, ``default`` when auth is off)."""
    return _ACTOR_CONTROL_RE.sub("", str(ctx.user or ""))[:160] or "default"


def _token(value: Any, limit: int = 64) -> str:
    return _TOKEN_RE.sub("?", str(value if value is not None else ""))[:limit]


def audit_prefix(call: ToolCall | None) -> str:
    """``turn=<id> step=<n>`` — the correlation prefix of every chat audit row."""
    parts: list[str] = []
    if call is not None and call.turn_id:
        parts.append(f"turn={_token(call.turn_id)}")
    if call is not None and isinstance(call.step, int) and not isinstance(call.step, bool):
        parts.append(f"step={call.step}")
    return " ".join(parts)


@dataclass(frozen=True)
class ToolCheck:
    """A pre-flight answer for one requested call: ``status`` is ``ok``,
    ``unknown``, ``denied`` (``missing`` grants) or ``skipped`` (outside the
    request's @-scopes, or switched off by configuration)."""

    status: str
    missing: tuple[str, ...] = ()
    reason: str = ""


class ChatToolbox:
    """The granted, in-scope tools of ONE turn plus guarded execution.

    ``tools`` are the tools whose signatures go into the prompt
    (:meth:`signatures`); :meth:`execute` still accepts any catalogue name and
    refuses ungranted / out-of-scope ones itself, because a model can name a tool it
    was never shown."""

    def __init__(
        self, ctx: ChatToolContext, tools: Iterable[ChatTool], scopes: frozenset[str],
        disabled: Iterable[str] = (),
    ) -> None:
        self.ctx = ctx
        self.tools: tuple[ChatTool, ...] = tuple(tools)
        self.scopes = scopes
        # Granted, in-scope tools this deployment's configuration switched off
        # (:func:`tool_available`). The prompt names them so an answer says "turned
        # off on this deployment" instead of naming a grant the caller already holds.
        self.disabled: tuple[str, ...] = tuple(dict.fromkeys(disabled))
        self._by_name = {t.name: t for t in self.tools}

    # -- prompt + catalogue ------------------------------------------------- #
    def names(self) -> list[str]:
        return [t.name for t in self.tools]

    def get(self, name: str) -> ChatTool | None:
        return self._by_name.get(name)

    def signatures(self) -> str:
        """The granted tools' one-line signatures (§4.3), in display order; a
        kind-aware tool lists only the kinds this caller can use (see
        :func:`caller_signature`)."""
        return render_tool_signatures(self.tools)

    def infos(self) -> list[ChatToolInfo]:
        return catalogue_infos(self.ctx.grants)

    # -- pre-flight --------------------------------------------------------- #
    def check(self, name: str, inp: Any = None) -> ToolCheck:
        """Would :meth:`execute` run this call? (No side effects, no audit.)"""
        tool = get_tool(name) if isinstance(name, str) else None
        if tool is None:
            return ToolCheck("unknown", reason="Unknown tool")
        kind = _kind_of(tool, inp)
        missing = tuple(self.ctx.missing(tool, kind))
        if missing:
            return ToolCheck("denied", missing, "Not permitted: requires " + ", ".join(missing))
        if not self.ctx.in_scope(tool) or (self.scopes and tool.scope not in self.scopes):
            return ToolCheck("skipped", reason="Outside the selected @-scopes")
        if not tool_available(tool, self.ctx):
            return ToolCheck("skipped", reason="Turned off on this deployment")
        return ToolCheck("ok")

    # -- execution ---------------------------------------------------------- #
    async def execute(
        self,
        name: str,
        inp: Any = None,
        *,
        turn_id: str = "",
        step: int | None = None,
        ordinal: int | None = None,
        taint: TaintLedger | None = None,
        record_denial: bool = True,
        timeout_s: float | None = None,
    ) -> ToolOutcome:
        """Run one requested call through every guard (module docstring).

        ``turn_id``/``step``/``ordinal`` identify the call for audit correlation;
        ``taint`` is the turn's :class:`TaintLedger` (``lookup_indicator`` refuses
        every value without one). ``record_denial=False`` leaves the ACCESS_DENIED
        row to the caller. ``timeout_s`` overrides ``chat_agent.tool_timeout_s``.
        Never raises for a tool failure; returns a :class:`ToolOutcome` whose
        ``status`` is ok/error/denied/timeout/skipped."""
        call = ToolCall(turn_id=str(turn_id or ""), step=step, ordinal=ordinal, taint=taint)
        verdict = self.check(name, inp)
        tool = get_tool(name) if isinstance(name, str) else None
        if verdict.status == "unknown" or tool is None:
            return ToolOutcome.failure("Unknown tool", status="error")
        if verdict.status == "denied":
            if record_denial:
                await self._record_denial(tool, verdict.missing, call)
            return ToolOutcome.failure(verdict.reason, status="denied", refusal="grant")
        if verdict.status == "skipped":
            return ToolOutcome.failure(verdict.reason, status="skipped")

        clean = _clean_input(inp)
        limit = float(timeout_s) if timeout_s else float(
            getattr(getattr(self.ctx.prefs, "chat_agent", None), "tool_timeout_s", 15) or 15
        )
        # Third-party lookups are budgeted per turn and per conversation (§4.2): hold
        # one BEFORE running, so parallel calls in one batch cannot overspend, and
        # commit it only when the lookup actually happened.
        budgeted = tool.name in BUDGETED_TOOLS and taint is not None
        if budgeted and not taint.reserve_lookup():
            return ToolOutcome.failure(
                "Not looked up: the indicator lookup limit for this turn or conversation is reached",
                status="skipped",
            )
        started = time.monotonic()
        # The instant the call started: its "Open in Logs" link names the window the
        # tool resolved now, as absolute instants (common.logs_console_view).
        called_at = datetime.now(timezone.utc)
        try:
            with call_scope(call):
                outcome = await asyncio.wait_for(tool.run(self.ctx, **clean), timeout=limit)
            if not isinstance(outcome, ToolOutcome):
                raise TypeError("tool returned a non-ToolOutcome")
        except asyncio.TimeoutError:
            outcome = ToolOutcome.failure(
                f"Lookup timed out after {int(limit)} s", status="timeout",
            )
        except asyncio.CancelledError:
            if budgeted:
                taint.release_lookup()
            raise
        except Exception as exc:  # noqa: BLE001 — engine template only (§5.2)
            logger.warning("chat tool %s failed: %s", tool.name, exc, exc_info=True)
            outcome = ToolOutcome.failure("Lookup failed because of an internal error")
        if budgeted:
            if _consumes_budget(tool, outcome):
                taint.commit_lookup()
            else:
                # A lookup that reached providers which all failed (or timed out)
                # gives back its per-turn slot but still counts toward the
                # conversation egress cap within this turn (SPEC A13).
                taint.release_lookup(egressed=_left_deployment(tool, outcome))
        duration_ms = int((time.monotonic() - started) * 1000)
        if outcome.ok and tool.name in LOG_TOOLS:
            _attach_logs_view(tool.name, clean, outcome, self.ctx, now=called_at)
        if taint is not None and outcome.ok:
            try:
                taint.observe(outcome.artifacts)
            except Exception:  # noqa: BLE001 — evidence capture is best-effort
                logger.debug("taint observe failed for %s", tool.name, exc_info=True)
        await self._record_execution(tool, clean, outcome, call, duration_ms)
        return outcome

    async def _record_denial(self, tool: ChatTool, missing: tuple[str, ...], call: ToolCall) -> None:
        # Lazy: app.api.deps imports app.state, which imports the chat engine.
        from ...api.deps import record_chat_tool_denial

        await record_chat_tool_denial(
            self.ctx.control_audit,
            actor=_actor(self.ctx),
            tool_name=tool.name,
            missing=list(missing),
            turn_id=call.turn_id or None,
            step=call.step,
            case_id=self.ctx.case_id,
        )

    async def _record_execution(
        self, tool: ChatTool, inp: dict[str, Any], outcome: ToolOutcome, call: ToolCall,
        duration_ms: int,
    ) -> None:
        audit = self.ctx.audit
        if audit is None:
            return
        prefix = audit_prefix(call)
        ordinal = f" t{call.ordinal}" if isinstance(call.ordinal, int) else ""
        text = outcome.summary if outcome.ok else (outcome.error or outcome.summary)
        summary = f"{prefix}{ordinal} {tool.name} {outcome.status} {duration_ms}ms: {text}".strip()
        try:
            params = tool.display_params(inp)
        except Exception:  # noqa: BLE001 — the row is still written without chips
            params = {}
        try:
            await audit.record(
                action_type=ActionType.ES_QUERY if tool.name in LOG_TOOLS else ActionType.TOOL_CALL,
                surface="chat",
                actor=_actor(self.ctx),
                case_id=self.ctx.case_id,
                query_text=outcome.query,
                tool_name=tool.name,
                tool_input=params,
                tool_output_summary=outcome.summary or None,
                result_summary=summary[:_AUDIT_SUMMARY_CHARS],
            )
        except Exception as exc:  # noqa: BLE001 — an audit hiccup never fails a turn
            logger.error("chat tool audit write failed (tool=%s): %s", tool.name, exc)


def _attach_logs_view(
    name: str, inp: dict[str, Any], outcome: ToolOutcome, ctx: ChatToolContext, *, now: datetime | None = None,
) -> None:
    """"Open in Logs" (SPEC §10.3/§10.7): give every artifact of a successful log
    call the EXACT Logs view of that call (``open_in``), which the materialiser copies
    onto the block. The view is derived by :func:`common.logs_console_view` from the
    call's own parsed input — the same model the tool validated — never from model
    prose; a filter the Logs page cannot express, or a live-tail source that ignored
    it, yields no view, so the block offers "Copy query" only. ``now`` is the instant
    the call started (the link's window is written as absolute instants). A tool that
    already set ``open_in`` keeps its own. Best-effort: a failure here never touches
    the outcome."""
    try:
        from . import logs  # lazy: the log tools import this module's siblings

        model = {"search_logs": logs.SearchLogsInput, "log_stats": logs.LogStatsInput}.get(name)
        if model is None or not outcome.artifacts:
            return
        args, error = parse_input(model, inp)
        if error is not None:
            return
        view = logs_console_view(ctx, args, outcome.observation, now=now)
        if view is None:
            return
        for artifact in outcome.artifacts:
            if isinstance(artifact.data, dict) and "open_in" not in artifact.data:
                artifact.data["open_in"] = {"page": view["page"], "opts": dict(view["opts"])}
    except Exception:  # noqa: BLE001 — a convenience link never fails a lookup
        logger.debug("logs view not attached for %s", name, exc_info=True)


def _consumes_budget(tool: ChatTool, outcome: ToolOutcome) -> bool:
    """Whether a budgeted call spends its reserved lookup: the tool's
    ``consumes_budget(outcome)`` hook when it has one, else any successful call."""
    hook = getattr(tool, "consumes_budget", None)
    if callable(hook):
        try:
            return bool(hook(outcome))
        except Exception:  # noqa: BLE001 — count it: the safe side of a budget
            return True
    return bool(outcome.ok and outcome.status == "ok")


def _left_deployment(tool: ChatTool, outcome: ToolOutcome) -> bool:
    """Whether a budgeted call that gave the analyst nothing may still have sent its
    value out: the tool's ``left_deployment(outcome)`` hook, else no."""
    hook = getattr(tool, "left_deployment", None)
    if not callable(hook):
        return False
    try:
        return bool(hook(outcome))
    except Exception:  # noqa: BLE001 — count it: the safe side of an egress cap
        return True


def _kind_of(tool: ChatTool, inp: Any) -> str | None:
    """The CANONICAL ``kind`` input of a kind-aware tool, else ``None``. A tool that
    folds aliases (``proposals`` → ``approvals``) exposes ``canonical_kind``, and the
    grant check MUST see the folded kind: checking the raw spelling would let an
    alias reach a kind without that kind's grant.

    A KIND-GATED tool asked for a kind it does not have (``kind="bogus"``) is checked
    as if no kind were given, so the "needs at least one kind grant" rule still
    applies: a caller with none of its grants is denied (and audited) rather than
    reaching the tool and relying on input validation to stop it."""
    if not tool.kind_permissions or not isinstance(inp, dict):
        return None
    kind = inp.get("kind")
    canonical = getattr(tool, "canonical_kind", None)
    if callable(canonical):
        try:
            kind = canonical(kind)
        except Exception:  # noqa: BLE001 — fall back to the raw spelling
            pass
    kind = kind.strip().lower() if isinstance(kind, str) and kind.strip() else None
    if kind is not None and tool.kind_gated() and kind not in tool.kind_permissions:
        return None
    return kind


def _clean_input(inp: Any) -> dict[str, Any]:
    """Model input as keyword arguments: identifier keys only, never ``ctx``/``self``
    (which would collide with ``run``'s own parameters)."""
    if not isinstance(inp, dict):
        return {}
    return {
        k: v for k, v in inp.items()
        if isinstance(k, str) and k.isidentifier() and k not in _RESERVED_KWARGS
    }


def build_toolbox(ctx: ChatToolContext, scopes: Iterable[str] | None = None) -> ChatToolbox:
    """The toolbox for one turn: the catalogue filtered to the tools the caller holds
    the grants for (a kind-gated tool when ANY of its kinds is granted), inside the
    request's @-scopes (``scopes`` overrides ``ctx.scopes``; empty = all) and not
    switched off by configuration (those are named in ``ChatToolbox.disabled``).
    Writes nothing."""
    scope_set = frozenset(s for s in (scopes if scopes is not None else ctx.scopes) if isinstance(s, str))
    granted: list[ChatTool] = []
    disabled: list[str] = []
    for tool in catalogue():
        if ctx.missing(tool) or (scope_set and tool.scope not in scope_set):
            continue
        if not tool_available(tool, ctx):
            disabled.append(tool.name)
            continue
        # The caller's own signature (only its usable kinds); a kind-aware tool none
        # of whose kinds this caller can use here is left out of the prompt.
        mine = _for_caller(tool, ctx)
        if mine is not None:
            granted.append(mine)
    return ChatToolbox(ctx, granted, scope_set, disabled)


def _reset_catalogue_for_tests() -> None:  # pragma: no cover - test helper
    global _CATALOGUE
    _CATALOGUE = None


__all__ = [
    "BUDGETED_TOOLS",
    "ChatToolbox",
    "DATA_TOOL_MODULES",
    "LOG_TOOLS",
    "OPTIONAL_TOOL_MODULES",
    "TOOL_ORDER",
    "ToolCheck",
    "audit_prefix",
    "build_toolbox",
    "caller_signature",
    "catalogue",
    "catalogue_grant_pairs",
    "catalogue_infos",
    "get_tool",
    "tool_available",
]
