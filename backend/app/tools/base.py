"""Tool interface and registry (MCP-shaped).

A ``Tool`` exposes a ``name``, a human description, a JSON ``input_schema`` and an
async ``run(input) -> ToolResult``. These four fields map one-to-one onto an MCP
tool definition, so the in-process registry can be replaced by an MCP client
transport without touching any agent code.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

from ..constants import ToolTier


@dataclass
class ToolResult:
    ok: bool
    summary: str = ""
    data: Any = None
    error: str | None = None
    # The reproducible query (KQL/DSL) behind the result, surfaced to audit and to
    # the one-click Discover locator (Section 8.1/8.2).
    query: str | None = None
    meta: dict[str, Any] = field(default_factory=dict)


class Tool(ABC):
    name: str = "tool"
    description: str = ""
    input_schema: dict[str, Any] = {}
    # Capability tier (authorisation firewall). Every built-in tool today is SAFE
    # (read-only). A write/response tool declares a higher tier and the investigator
    # gates it accordingly (FORBIDDEN → never; REQUIRES_APPROVAL → propose-only).
    tier: ToolTier = ToolTier.SAFE

    @abstractmethod
    async def run(self, **kwargs: Any) -> ToolResult: ...

    def bind_events(self, events: list[Any]) -> None:
        """Give the tool the current investigation's events (no-op by default).

        The investigator calls this once per investigation, before the ReAct loop,
        on every tool. A tool that must operate on a FULL event field the model can
        only see truncated (e.g. an SDDL blob past the #9 fence cap) overrides this to
        index the events, so the model can reference an event by id and the tool reads
        the untruncated value server-side. Most tools ignore it."""
        return None

    def definition(self) -> dict[str, Any]:
        """MCP-style tool definition for prompting / future MCP export."""
        return {
            "name": self.name,
            "description": self.description,
            "input_schema": self.input_schema,
        }


class ToolRegistry:
    def __init__(self, tools: list[Tool] | None = None) -> None:
        self._tools: dict[str, Tool] = {}
        for tool in tools or []:
            self.register(tool)

    def register(self, tool: Tool) -> None:
        self._tools[tool.name] = tool

    def get(self, name: str) -> Tool | None:
        return self._tools.get(name)

    def all(self) -> list[Tool]:
        return list(self._tools.values())

    def names(self) -> list[str]:
        return list(self._tools)

    def definitions(self) -> list[dict[str, Any]]:
        return [t.definition() for t in self._tools.values()]
