"""Read-only chat tools (chat revamp SPEC §5).

The contract every tool implements lives in :mod:`app.agents.chat_tools.base`
(``ChatTool``, ``ToolOutcome``, ``Artifact``, ``ChatToolContext`` and the prompt
renderers). Concrete tools and the registry live in sibling modules; importing this
package stays light (no store or connector imports) so the engine, the routes and
the Demo planner can depend on the contract without import cycles.
"""

from __future__ import annotations

from .base import (
    ARTIFACT_DATA_SHAPES,
    Artifact,
    ChatTool,
    ChatToolContext,
    Grant,
    ToolOutcome,
    granted_tool_names,
    render_artifact_manifest,
    render_tool_call_header,
    render_tool_signatures,
)

__all__ = [
    "ARTIFACT_DATA_SHAPES",
    "Artifact",
    "ChatTool",
    "ChatToolContext",
    "Grant",
    "ToolOutcome",
    "granted_tool_names",
    "render_artifact_manifest",
    "render_tool_call_header",
    "render_tool_signatures",
]
