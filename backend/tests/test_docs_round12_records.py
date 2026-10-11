"""Round 12 records stay true to the code they describe (WP-DOC final review).

Four review findings were documentation that contradicted the shipped code:

* the daily AI budget was still called the global spend bound in reference pages, while
  the gateway exempts chat from both its daily and its monthly ceilings and chat's own
  daily cap is off by default (SPEC D5);
* the chat-revamp amendments A42 and A43 quoted a ``/compact`` reply and a
  ``budget_state`` scope that the engine and the route do not produce;
* A59 and the Round 12 SPEC §7.3 "Entry bundle" item named entry growth in files that
  did not change and did not hold the rebased baseline they promise to hold;
* two pieces of chat copy that contradict the Help Center (the scope popover's default
  hint and the context note in case chat) were not recorded as known limitations.

These tests tie each record to the code fact it states, so the next change to either
side has to update the other. Offline and deterministic: they read repository files and
call pure helpers only.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

import app
from app.agents.chat import _COMPACT_DONE
from app.api.routes_chat import _budget_state
from app.config import ChatAgentConfig
from app.llm.gateway import BUDGET_EXEMPT_SURFACES, budget_exempt

REPO_ROOT = Path(app.__file__).resolve().parents[2]
REVAMP_SPEC = REPO_ROOT / "docs" / "research" / "2026-10-chat-revamp" / "SPEC.md"
ROUND12_SPEC = REPO_ROOT / "docs" / "research" / "2026-10-round12" / "SPEC.md"
KNOWN_LIMITATIONS = REPO_ROOT / "docs" / "releases" / "known-limitations.md"
BUNDLE_TEST = REPO_ROOT / "webui" / "src" / "soc" / "__tests__" / "bundle-first-paint.test.ts"
SCOPE_CONTROLS = REPO_ROOT / "webui" / "src" / "soc" / "chat" / "composer" / "ScopeControls.tsx"
COMPOSER_FORMAT = REPO_ROOT / "webui" / "src" / "soc" / "chat" / "composer" / "format.ts"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _paragraphs(text: str) -> list[str]:
    """Blank-line separated blocks, each joined onto one line (a table is one block)."""
    return [" ".join(block.split()) for block in re.split(r"\n\s*\n", text) if block.strip()]


_ITEM_START = re.compile(r"^\s*(?:[-*] |\d+\. |\|)")


def _units(text: str) -> list[str]:
    """The smallest prose units a claim and its qualifier must share: each paragraph,
    split further into its list items (with their continuation lines) and table rows."""
    units: list[str] = []
    for block in re.split(r"\n\s*\n", text):
        current: list[str] = []
        for line in block.splitlines():
            if _ITEM_START.match(line) and current:
                units.append(" ".join(" ".join(current).split()))
                current = []
            current.append(line)
        if current:
            units.append(" ".join(" ".join(current).split()))
    return [unit for unit in units if unit]


def _amendment(spec: str, label: str) -> str:
    """The paragraph of one ``**A<n> — …**`` amendment."""
    for paragraph in _paragraphs(spec):
        if paragraph.startswith(f"**{label} — "):
            return paragraph
    raise AssertionError(f"amendment {label} not found in the chat-revamp SPEC")


def _section(spec: str, heading: str) -> str:
    start = spec.index(heading)
    end = spec.find("\n### ", start + len(heading))
    return spec[start:] if end == -1 else spec[start:end]


def _bullet(section: str, title: str) -> str:
    """One ``- **Title.** …`` item of a bullet list, joined onto one line."""
    match = re.search(rf"(?ms)^- \*\*{re.escape(title)}\*\*.*?(?=^- \*\*|\Z)", section)
    assert match, f"item {title!r} not found"
    return " ".join(match.group(0).split())


# --------------------------------------------------------------------------------------
# D5: the daily AI budget bounds the pipeline; chat is outside it.
# --------------------------------------------------------------------------------------

def test_code_facts_behind_the_budget_wording():
    """What the wording below describes: chat is exempt and its own cap is off."""
    assert BUDGET_EXEMPT_SURFACES == ("chat",)
    assert budget_exempt("chat", "chat")
    assert not budget_exempt("chat", "report")  # report summaries stay inside the budget
    assert not budget_exempt("investigator", "investigate")
    assert ChatAgentConfig().chat_daily_cap_usd is None


#: Live documents that describe the budget (history in CHANGELOG, Journal and research
#: folders is a record of its time and is not scanned).
_LIVE_DOCS = (
    "AGENTS.md",
    "ROADMAP.md",
    "DEPLOY.md",
    "README.md",
    "docs/HANDOFF.md",
    "docs/ENVIRONMENT.md",
    "docs/USAGE.md",
)

_GLOBAL_BOUND_CLAIM = re.compile(
    r"(?i)global spend bound|global bound|one spend bound|remains the spend bound"
    r"|spend bound for the pipeline"
)


def _live_doc_paths() -> list[Path]:
    paths = [REPO_ROOT / name for name in _LIVE_DOCS]
    paths += [
        page for page in sorted((REPO_ROOT / "docs").rglob("*.md"))
        if "research" not in page.relative_to(REPO_ROOT / "docs").parts
    ]
    return [path for path in dict.fromkeys(paths) if path.exists()]


def test_every_global_budget_claim_carries_the_chat_exception():
    offenders = []
    for path in _live_doc_paths():
        for unit in _units(_read(path)):
            if _GLOBAL_BOUND_CLAIM.search(unit) and "chat" not in unit.lower():
                offenders.append(f"{path.relative_to(REPO_ROOT)}: {unit[:160]}…")
    assert not offenders, (
        "The daily AI budget is not the global spend bound since Round 12 (SPEC D5): "
        "say that Workspace and Case Manager chat are outside its daily and monthly "
        "ceilings and that chat_agent.chat_daily_cap_usd (off by default) is chat's only "
        "bound.\n" + "\n".join(offenders)
    )


@pytest.mark.parametrize(
    "relative",
    [
        "docs/ENVIRONMENT.md",
        "docs/USAGE.md",
        "docs/concepts/state-audit-cost.md",
        "docs/administration/models-spend.md",
        "docs/reference/configuration.md",
        "docs/administration/settings.md",
    ],
)
def test_budget_reference_pages_name_the_chat_cap_and_its_default(relative):
    text = " ".join(_read(REPO_ROOT / relative).split())
    lowered = text.lower()
    assert "chat_daily_cap_usd" in text or "chat spending limit" in lowered, relative
    assert "off by default" in lowered or "`null`" in text, relative
    assert re.search(r"(?i)chat[^.]{0,120}\boutside\b", text), (
        f"{relative} must say that chat is outside the AI budget"
    )


@pytest.mark.parametrize(
    ("relative", "heading"),
    [
        ("docs/USAGE.md", "### Budget gate — a pre-flight spend ceiling"),
        ("docs/USAGE.md", "### The default budget backstop"),
    ],
)
def test_usage_budget_sections_carry_the_exception(relative, heading):
    section = " ".join(_section(_read(REPO_ROOT / relative), heading).split())
    assert "Workspace and Case Manager chat are outside" in section
    assert "chat_agent.chat_daily_cap_usd" in section
    assert "off by default" in section


def test_environment_budget_rows_carry_the_exception():
    text = _read(REPO_ROOT / "docs" / "ENVIRONMENT.md")
    rows = [line for line in text.splitlines()
            if line.startswith("| `budget.{enabled") or line.startswith("| `caps.max_auto_investigations_per_tick`")]
    assert len(rows) == 2
    for row in rows:
        assert "chat" in row.lower(), row[:80]
    budget_gate = next(p for p in _paragraphs(text) if "**`BudgetGate`**" in p)
    assert "outside both its daily and its monthly ceilings" in budget_gate
    assert "chat_agent.chat_daily_cap_usd" in budget_gate


# --------------------------------------------------------------------------------------
# A42 / A43: the quoted engine and route facts.
# --------------------------------------------------------------------------------------

def test_a42_quotes_the_compact_reply_the_engine_writes():
    a42 = _amendment(_read(REVAMP_SPEC), "A42")
    quoted = _COMPACT_DONE.format(count="N", noun="exchanges")
    assert quoted == "Summarised N earlier exchanges. The conversation continues from the summary."
    assert f'"{quoted}"' in a42
    assert "earlier messages…" not in a42


def test_budget_state_covers_the_monthly_window():
    over_monthly = {
        "enabled": True,
        "daily": {"band": "ok", "fraction": 0.1},
        "monthly": {"band": "over", "fraction": 1.2},
    }
    warn_monthly = {
        "enabled": True,
        "daily": {"band": "ok", "fraction": 0.1},
        "monthly": {"band": "warn", "fraction": 0.85},
    }
    assert _budget_state(over_monthly) == "reached"
    assert _budget_state(warn_monthly) == "approaching"
    assert _budget_state({"enabled": False}) == "ok"


def test_a43_describes_budget_state_over_both_windows():
    a43 = _amendment(_read(REVAMP_SPEC), "A43")
    assert "still reports the daily AI budget" not in a43
    assert "either the daily or the monthly window" in a43
    assert "never to block Send" in a43


# --------------------------------------------------------------------------------------
# A59 / §7.3: the entry bundle record holds the measured baseline.
# --------------------------------------------------------------------------------------

def _entry_baseline() -> tuple[str, int]:
    match = re.search(r"const PRE_REVAMP_ENTRY_BYTES = ([\d_]+);", _read(BUNDLE_TEST))
    assert match, "PRE_REVAMP_ENTRY_BYTES not found in bundle-first-paint.test.ts"
    raw = match.group(1)
    return raw, int(raw.replace("_", ""))


def test_round12_entry_bundle_item_records_the_rebased_baseline():
    raw, value = _entry_baseline()
    item = _bullet(_section(_read(ROUND12_SPEC), "### 7.3 Known limitations"), "Entry bundle.")
    assert f"PRE_REVAMP_ENTRY_BYTES = {raw}" in item, (
        "SPEC §7.3 'Entry bundle' is the one record of the rebased entry baseline (A59); "
        "update it with the value in bundle-first-paint.test.ts"
    )
    assert f"{value:,} B" in item
    # The measured sources, not files that did not change this round.
    for name in ("prefs.tsx", "NavSidebar.tsx", "patchMisc", "Remember me", "CommandPalette"):
        assert name in item, name
    for name in ("ReauthDialog", "ThemeModePill"):
        assert name not in item, name


def test_a59_names_the_measured_sources_and_points_to_the_record():
    a59 = _amendment(_read(REVAMP_SPEC), "A59")
    for name in ("prefs.tsx", "NavSidebar.tsx", "patchMisc", "Remember me", "PRE_REVAMP_ENTRY_BYTES"):
        assert name in a59, name
    for name in ("ReauthDialog", "ThemeModePill"):
        assert name not in a59, name
    assert '"Entry bundle" item of the Round 12 SPEC §7.3' in a59


# --------------------------------------------------------------------------------------
# Chat copy that contradicts the Help Center is recorded until it is fixed.
# --------------------------------------------------------------------------------------

_SCOPE_HINT = "unless your question names another window"
_SCOPE_HINT_HEADING = "### The chat scope popover names the wrong default window"


def test_scope_popover_default_hint_is_recorded_while_it_ships():
    """Both ways: a fixed hint must also retire its known-limitation entry."""
    ships = _SCOPE_HINT in _read(SCOPE_CONTROLS)
    recorded = _SCOPE_HINT_HEADING in _read(KNOWN_LIMITATIONS)
    in_spec = "The scope popover's default hint names the wrong default" in _read(ROUND12_SPEC)
    if ships:
        assert recorded and in_spec, (
            "ScopeControls.tsx still says 'Last 24 hours, unless your question names another "
            "window' for the default chip, but case counts and searches default to all time; "
            "keep it recorded in known-limitations.md and SPEC §7.3"
        )
    else:
        assert not recorded, (
            "The scope popover hint was fixed: remove its entry from known-limitations.md "
            "(and the ROADMAP G item)"
        )
        roadmap = " ".join(_read(REPO_ROOT / "ROADMAP.md").split())
        assert "**Scope popover default hint**" not in roadmap, "retire the ROADMAP G item too"


def test_context_note_overstatement_is_recorded_while_it_ships():
    if "There is no hard cap" not in _read(COMPOSER_FORMAT):
        pytest.skip("the context note no longer claims there is no hard cap")
    assert "### The context note overstates in Case Manager chat" in _read(KNOWN_LIMITATIONS)
    item = _bullet(_section(_read(ROUND12_SPEC), "### 7.3 Known limitations"),
                   "Case Manager chat keeps no running summary.")
    assert "known-limitations.md" in item and "ROADMAP G" in item
    roadmap = " ".join(_read(REPO_ROOT / "ROADMAP.md").split())
    assert "**Context note only where a summary is stored**" in roadmap
