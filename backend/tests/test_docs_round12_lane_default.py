"""Round 12 final review: the chat's default width and its records agree (operator ask 1).

The orchestrator decided that the conversation fills the screen by default (Full width)
instead of the Wide 88rem cap that SPEC D12 first chose. The default lives in one place
(``DEFAULT_LANE_WIDTH`` in ``webui/src/soc/chat/message/lane.ts``); the binding records that
describe it (Round 12 SPEC D12 and §7.2, chat-revamp A62, the UI standard and the analyst
guide) must name the same default, and the line-chart end-label rule recorded in BLOCKS
amendment 31 must match ``charts/geometry.ts``. Offline: reads repository files only.
"""

from __future__ import annotations

import re
from pathlib import Path

import app

REPO_ROOT = Path(app.__file__).resolve().parents[2]
LANE_TS = REPO_ROOT / "webui" / "src" / "soc" / "chat" / "message" / "lane.ts"
GEOMETRY_TS = REPO_ROOT / "webui" / "src" / "soc" / "chat" / "blocks" / "charts" / "geometry.ts"
ROUND12_SPEC = REPO_ROOT / "docs" / "research" / "2026-10-round12" / "SPEC.md"
REVAMP_SPEC = REPO_ROOT / "docs" / "research" / "2026-10-chat-revamp" / "SPEC.md"
BLOCKS = REPO_ROOT / "docs" / "research" / "2026-10-chat-revamp" / "BLOCKS.md"
UI_STANDARD = REPO_ROOT / "docs" / "development" / "ui-standard.md"
ANALYST_CHAT = REPO_ROOT / "docs" / "analyst" / "chat.md"


def _flat(path: Path) -> str:
    return " ".join(path.read_text(encoding="utf-8").split())


def _default_lane_width() -> str:
    match = re.search(r"export const DEFAULT_LANE_WIDTH: ChatLaneWidth = '(\w+)';", LANE_TS.read_text(encoding="utf-8"))
    assert match, "DEFAULT_LANE_WIDTH not found in lane.ts"
    return match.group(1)


def test_the_default_conversation_width_is_full():
    assert _default_lane_width() == "full"
    lane = LANE_TS.read_text(encoding="utf-8")
    # The menu names the default, so a viewer who chose another width can find it again.
    assert re.search(r"full: '[^']*\(default\)'", lane)
    assert not re.search(r"(comfortable|wide): '[^']*\(default\)'", lane)


def test_every_record_names_full_width_as_the_default():
    spec = _flat(ROUND12_SPEC)
    assert "Comfortable 64rem / Wide 88rem (default)" not in spec
    assert "Full is the default; it was Wide 88rem." in spec
    assert "18. **Full width is the default conversation width** (amends D12;" in spec

    revamp = _flat(REVAMP_SPEC)
    a62 = re.search(r"\*\*A62 — .*", revamp)
    assert a62, "chat-revamp amendment A62 is missing"
    assert "The default conversation width is **Full width**" in a62.group(0)
    assert "A stored choice" in a62.group(0)

    ui = _flat(UI_STANDARD)
    assert "Wide 88rem (default)" not in ui
    assert "Full width (no cap, the default" in ui

    guide = _flat(ANALYST_CHAT)
    assert "| **Full width** (default) |" in guide
    assert "| **Wide** (default) |" not in guide


def test_end_label_rule_matches_its_record():
    geometry = GEOMETRY_TS.read_text(encoding="utf-8")
    assert "export const END_LABEL_MIN_CHARS = 14;" in geometry
    assert "export const END_LABEL_WIDTH_SHARE = 0.25;" in geometry
    blocks = _flat(BLOCKS)
    assert "31. **Line end labels sized to the chart" in blocks
    assert "up to a quarter of the chart's width and never fewer than 14 characters" in blocks
