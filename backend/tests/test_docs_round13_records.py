"""Round 13 chat: the records describe the code that ships (WP-DOC13).

The Round 13 chat work added dynamic starters, two starter routes, anchored follow-ups and
conversation titles. Its records (the Help Center chat and settings pages, the API
reference, AGENTS.md, the chat-revamp amendments A64 to A68, BLOCKS amendments 32 and 33
and the Round 13 SPEC's "As built") must name what the code does, so each check below reads
the code fact first and then the record. Offline: reads repository files and imports
modules only.
"""

from __future__ import annotations

import re
from pathlib import Path

import app
from app.agents import chat_followups, chat_starter_text
from app.api.routes_chat_starters import EVENTS_PER_MINUTE
from app.config import ChatAgentConfig
from app.engine import chat_starters

REPO_ROOT = Path(app.__file__).resolve().parents[2]
DOCS = REPO_ROOT / "docs"
ANALYST_CHAT = DOCS / "analyst" / "chat.md"
SETTINGS = DOCS / "administration" / "settings.md"
CONFIGURATION = DOCS / "reference" / "configuration.md"
API = DOCS / "reference" / "api.md"
ROUND13_SPEC = DOCS / "research" / "2026-10-round13" / "SPEC-chat.md"
REVAMP_SPEC = DOCS / "research" / "2026-10-chat-revamp" / "SPEC.md"
BLOCKS = DOCS / "research" / "2026-10-chat-revamp" / "BLOCKS.md"
UI_STANDARD = DOCS / "development" / "ui-standard.md"
AGENTS = REPO_ROOT / "AGENTS.md"
API_DIR = REPO_ROOT / "backend" / "app" / "api"
SETTINGS_TSX = REPO_ROOT / "webui" / "src" / "soc" / "pages" / "settings" / "chat-agent.tsx"
SHORTCUTS_TS = REPO_ROOT / "webui" / "src" / "soc" / "chat" / "shortcuts" / "shortcut-list.ts"


def _flat(path: Path) -> str:
    return " ".join(path.read_text(encoding="utf-8").split())


def test_the_starter_routes_are_in_the_api_reference():
    api = _flat(API)
    assert "`GET /api/chat/starters`" in api
    assert "`POST /api/chat/starters/events`" in api
    assert f"At most {EVENTS_PER_MINUTE} events per caller per minute" in api
    assert f"Cached per caller for {chat_starters.CACHE_TTL_S} seconds" in api
    assert f"`expires_at` is `as_of` plus {chat_starters.EXPIRES_AFTER_S} seconds" in api


def test_agents_counts_every_feature_router():
    routers = sorted(path.name for path in API_DIR.glob("routes_*.py"))
    assert "routes_chat_starters.py" in routers
    assert f"**{len(routers)} `routes_*.py` feature routers**" in _flat(AGENTS)


def test_agents_names_the_round13_modules_and_namespace():
    agents = _flat(AGENTS)
    for name in ("chat_starter_text", "chat_followups", "chat_starters", "routes_chat_starters",
                 "`chat_starters` namespace", "`dynamic_starters`"):
        assert name in agents, name


def test_the_suggestions_switch_is_worded_as_the_code_words_it():
    description = ChatAgentConfig.model_fields["dynamic_starters"].description
    assert description
    assert ChatAgentConfig().dynamic_starters is True
    assert " ".join(description.split()) in _flat(SETTINGS)
    settings_tsx = SETTINGS_TSX.read_text(encoding="utf-8")
    assert "export const DYNAMIC_STARTERS_LABEL = 'Suggest questions from live data';" in settings_tsx
    assert " ".join(description.split()) in " ".join(settings_tsx.split())
    for page in (SETTINGS, ANALYST_CHAT):
        assert "Suggest questions from live data" in _flat(page), page.name
    assert "| `dynamic_starters` | `true` | `true`, `false` |" in _flat(CONFIGURATION)


def test_the_hunt_wording_and_its_record_agree():
    question = chat_starter_text.template("hunt").question
    assert question.endswith("cases in the last 7 days."), question
    spec = _flat(ROUND13_SPEC)
    assert "beyond the {n} cases in the last 7 days." in spec
    assert "this week" not in question


def test_the_follow_up_bounds_are_recorded():
    spec = _flat(ROUND13_SPEC)
    assert (
        f"at most {chat_followups.MAX_MODEL_CHIPS} usable model chips are checked, read from at "
        f"most {chat_followups.MODEL_CHIPS_SCANNED} header entries, against at most "
        f"{chat_followups.MAX_ANCHORS} anchors"
    ) in spec


def test_the_shortcut_sheet_and_the_help_center_name_the_hide_keys():
    shortcuts = SHORTCUTS_TS.read_text(encoding="utf-8")
    assert "label: 'Hide a suggestion for a day'" in shortcuts
    assert "keys: ['Delete']" in shortcuts and "altKeys: ['Backspace']" in shortcuts
    assert "| Delete or Backspace | Hide a suggestion for a day (on a focused suggestion) |" in _flat(ANALYST_CHAT)


def test_the_round13_records_exist():
    assert "## 10. As built" in ROUND13_SPEC.read_text(encoding="utf-8")
    revamp = REVAMP_SPEC.read_text(encoding="utf-8")
    for label in ("A64", "A65", "A66", "A67", "A68"):
        assert re.search(rf"^\*\*{label} — ", revamp, re.MULTILINE), label
    blocks = BLOCKS.read_text(encoding="utf-8")
    assert re.search(r"^32\. \*\*Compact and wide block widths", blocks, re.MULTILINE)
    assert re.search(r"^33\. \*\*Block header controls and the shared scope line", blocks, re.MULTILINE)


def test_the_ui_standard_records_the_bottom_anchored_start_stack():
    ui = _flat(UI_STANDARD)
    assert "The empty state is top-aligned in the lane" not in ui
    assert "**bottom-anchored stack**" in ui
    assert "**Suggestions (Round 13).**" in ui


# --------------------------------------------------------------------------- #
# Wave 3 docs round fixer: each record below is read against the code it describes.
# --------------------------------------------------------------------------- #
HANDOFF = DOCS / "HANDOFF.md"
CHANGELOG = REPO_ROOT / "CHANGELOG.md"
ROADMAP = REPO_ROOT / "ROADMAP.md"
WEB_CHAT = REPO_ROOT / "webui" / "src" / "soc" / "chat"
STEP_INSPECTOR = WEB_CHAT / "message" / "StepInspector.tsx"
ACCESS_COPY = WEB_CHAT / "composer" / "access-copy.ts"
THREAD_TOOLBAR = WEB_CHAT / "workspace" / "ThreadToolbar.tsx"
HISTORY_RAIL = WEB_CHAT / "workspace" / "HistoryRail.tsx"
BLOCK_LAYOUT = WEB_CHAT / "blocks" / "layout.ts"
LANE = WEB_CHAT / "message" / "lane.ts"


def test_case_chip_records_say_up_to_three():
    """§3.14 picks only templates that apply, so a case can get fewer than three chips
    (SPEC-chat §10.2): no record may promise exactly three."""
    assert chat_starters.case_chip_templates(
        status="open", verdict="FALSE_POSITIVE", has_entity=False, has_related=False) == ["case_handoff"]
    assert len(chat_starters.case_chip_templates(
        status="new", verdict="FALSE_POSITIVE", has_entity=True, has_related=False)) == 2
    records = {
        ANALYST_CHAT: "An empty case chat offers up to three suggested questions",
        API: "`case` up to three Case Manager questions",
        UI_STANDARD: "and up to three case chips read from",
        AGENTS: "up to three Case Manager case chips",
        REVAMP_SPEC: "Case Manager chat shows up to three value-free case chips",
        CHANGELOG: "Case Manager chat offers up to three questions chosen from the case's state",
    }
    for path, phrase in records.items():
        assert phrase in _flat(path), (path.name, phrase)
    assert "Case Manager chat offers up to three value-free case questions" in _flat(CHANGELOG)
    stale = re.compile(r"(?<!up to )\bthree (?:suggested questions|case chips|Case Manager|value-free case"
                       r"|questions chosen from the case)", re.IGNORECASE)
    for path in records:
        assert not stale.search(_flat(path)), (path.name, stale.search(_flat(path)))
    assert "**Case chips (amends §3.1 and §3.14):**" in _flat(ROUND13_SPEC)


def test_case_chip_records_match_the_needs_a_person_rule():
    """The Help Center and SPEC-chat §10.2 say an open case whose verdict is NEEDS_HUMAN
    gets the needs-a-person chip (the home ``needs_human`` rule); the engine must pick it
    for every open status, and a closed case still leads with why it was closed."""
    assert ("(an escalated case, one waiting for review, or an open case whose AI verdict "
            "is Needs human)") in _flat(ANALYST_CHAT)
    assert ("`case_needs_person` applies to a case with status `needs_human` or `escalated`, "
            "and also to an open case whose verdict is NEEDS_HUMAN") in _flat(ROUND13_SPEC)
    for status in sorted(chat_starters.OPEN_CASE_STATUSES):
        assert chat_starters.case_chip_templates(
            status=status, verdict="NEEDS_HUMAN", has_entity=True, has_related=False,
        )[0] == "case_needs_person", status
    assert chat_starters.case_chip_templates(
        status="closed", verdict="NEEDS_HUMAN", has_entity=True, has_related=False,
    )[0] == "case_closed_why"


def test_handoff_counts_and_names_every_feature_router():
    routers = sorted(path.stem for path in API_DIR.glob("routes_*.py"))
    handoff = _flat(HANDOFF)
    assert f"**{len(routers)} feature routers total**" in handoff
    missing = [name for name in routers if not re.search(rf"\b{name}\b", handoff)]
    assert not missing, missing


def test_the_start_here_records_name_the_newest_round():
    """HANDOFF and AGENTS name the same newest round: the highest-numbered round with a
    research folder (today Round 13), never an older one."""
    rounds = [int(m.group(1)) for d in (DOCS / "research").iterdir()
              if d.is_dir() and (m := re.search(r"-round(\d+)$", d.name))]
    newest = str(max(rounds))
    assert re.findall(r"\*\*Round (\d+)[^*]*\(newest\b", _flat(HANDOFF)) == [newest]
    assert re.findall(r"\*\*Round (\d+)[^*]*\bis the newest\b", _flat(AGENTS)) == [newest]


def test_the_step_inspector_records_describe_its_header():
    """The sheet's title is "Step N:" and the run-log label; the catalogue label and the
    tool id sit in the "Lookup" field of "What was sent" (SPEC-chat T14, T28)."""
    from app.agents.chat_tools.logs import SearchLogsTool

    source = STEP_INSPECTOR.read_text(encoding="utf-8")
    assert "Step {step.index}: {step.label}" in source
    assert '<Field name="Lookup">' in source and "({step.tool})" in source
    assert SearchLogsTool.name == "search_logs" and SearchLogsTool.label == "Searched logs"
    assert "search_logs: 'Search logs'," in ACCESS_COPY.read_text(encoding="utf-8")
    for path in (UI_STANDARD, ANALYST_CHAT):
        text = _flat(path)
        assert '"Step 2: Searched logs"' in text, path.name
        assert '"Search logs (search_logs)"' in text, path.name
    assert "names the lookup by its catalogue label with the tool id as muted text" not in _flat(UI_STANDARD)
    assert "Its header names the lookup in words" not in _flat(ANALYST_CHAT)


def test_the_conversation_menus_and_the_help_center_say_export():
    """Both conversation menus label the action "Export" (SPEC-chat T26)."""
    trigger = re.compile(r"aria-hidden />\s*Export\s*</DropdownMenuSubTrigger>")
    for path in (THREAD_TOOLBAR, HISTORY_RAIL):
        source = path.read_text(encoding="utf-8")
        assert trigger.search(source), path.name
        assert "Export conversation" not in source, path.name
    assert "**Export conversation**" not in _flat(ANALYST_CHAT)
    assert "**Save conversation as report** and **Export** leave it out." in _flat(ANALYST_CHAT)


def test_the_history_rail_records_give_the_row_name_the_code_builds():
    """A row's accessible name is "title[, state], exact date[ · N messages]", with no dash."""
    source = HISTORY_RAIL.read_text(encoding="utf-8")
    table = re.search(r"const ROW_STATUS_TEXT = \{(.*?)\} as const;", source, re.DOTALL)
    assert table, "ROW_STATUS_TEXT"
    states = re.findall(r":\s*'([^']+)'", table.group(1))
    assert states == ["answering", "needs your input", "answer failed", "new answer"]
    ui = _flat(UI_STANDARD)
    assert 'is "title, state, exact date · N messages"' in ui
    for state in states:
        assert f'"{state}"' in ui, state
    assert "the temporary row has no count" in ui
    assert "title — exact date" not in ui
    assert "<title> — <exact date>" not in _flat(REVAMP_SPEC)


def test_blocks_amendment_32_records_the_prose_caps():
    """``markdown`` and ``callout`` read as compact; the block column caps them at 38rem
    and 42rem (A66, T7). Amendment 32 must not call them wide or capped by the lane."""
    layout = " ".join(BLOCK_LAYOUT.read_text(encoding="utf-8").split())
    assert "case 'markdown': case 'callout': case 'entity': case 'case_list': case 'mitre': return 'compact';" in layout
    lane = LANE.read_text(encoding="utf-8")
    assert "'[&>*>*[data-block-type=markdown]]:max-w-[38rem]'" in lane
    assert "'[&>*>*[data-block-type=callout]]:max-w-[42rem]'" in lane
    # Both prose blocks are compact, so a compact cap that matched them would win the
    # cascade over the prose caps above: each compact cap must leave them out.
    compact_caps = re.findall(r"'[^']*\[data-block-width=compact\][^']*:max-w-[^']*'", lane)
    assert len(compact_caps) == 2, compact_caps
    for cap in compact_caps:
        assert "[data-block-width=compact]:not([data-block-type=markdown]):not([data-block-type=callout])]" in cap, cap
    blocks = _flat(BLOCKS)
    amendment = blocks[blocks.index("32. **Compact and wide block widths"):blocks.index("33. **Block header controls")]
    assert ("caps a `markdown` block at the 38rem prose measure and a `callout` at the 42rem reading "
            "column") in amendment
    assert "capped by the lane" not in amendment
    assert "every other framed block is wide" in amendment


def test_the_old_demo_source_names_record_lists_every_fixture():
    """§10.7 and ROADMAP name exactly the test fixtures that still carry a Demo source
    name from before the T36 rename, and no product file carries one."""
    dash = chr(0x2014)  # built, so this file is not itself a carrier
    old = (f"Splunk Enterprise Security {dash} HEC", f"Wazuh Manager {dash} endpoint telemetry",
           f"Network & Linux {dash} RFC 5424 Syslog")
    roots = (REPO_ROOT / "backend" / "app", REPO_ROOT / "backend" / "tests", REPO_ROOT / "webui" / "src")
    carriers = []
    for root in roots:
        for path in root.rglob("*"):
            if path.suffix not in (".py", ".ts", ".tsx", ".json") or "node_modules" in path.parts:
                continue
            if any(name in path.read_text(encoding="utf-8", errors="ignore") for name in old):
                carriers.append(path)
    assert all("tests" in p.parts or "__tests__" in p.parts for p in carriers), carriers
    spec = _flat(ROUND13_SPEC)
    roadmap = _flat(ROADMAP)
    if not carriers:
        assert "**Old Demo source names**" not in spec
        assert "carry the old Demo source names" not in roadmap
        return
    bullet = spec[spec.index("**Old Demo source names**"):]
    ends = [i for i in (bullet.find(" - **"), bullet.find(" ### ")) if i > 0]
    bullet = bullet[:min(ends)] if ends else bullet
    named = set(re.findall(r"`([^`]+\.(?:tsx?|py))`", bullet))
    assert {p.name for p in carriers} == {n.rsplit("/", 1)[-1] for n in named}, (carriers, named)
    words = {1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six"}
    assert f"{words[len(carriers)]} test fixtures" in bullet
    assert f"{words[len(carriers)]} test fixtures" in roadmap
    backend = [p for p in carriers if "backend" in p.parts]
    for path in backend:
        assert f"backend/tests/{path.name}" in roadmap, path.name


def test_the_t36_record_names_the_placeholder_labels_the_tools_use():
    """T36 as built: a blank counted log value and a category without a label read as the
    labels ``chat_tools.common`` defines, which never anchor a follow-up; the record must
    not still say an em dash is left as the empty category label."""
    from app.agents.chat_tools import common

    spec = _flat(ROUND13_SPEC)
    bullet = spec[spec.index("- **T36:**"):]
    bullet = bullet[:bullet.index(" - **T37:**")]
    for label in (common.EMPTY_VALUE_LABEL, common.MISSING_LABEL):
        assert f'"{label}"' in bullet, label
        assert label in chat_followups.PLACEHOLDER_LABELS, label
    assert "`EMPTY_VALUE_LABEL` and `MISSING_LABEL`" in bullet
    assert "empty category label" not in bullet
    assert "flagged for Wave 3" not in bullet
    changelog = _flat(CHANGELOG)
    assert (f'a blank log value reads "{common.EMPTY_VALUE_LABEL}" and a category with no label '
            f'"{common.MISSING_LABEL}"') in changelog
