"""The public Help Center pages hold no invisible characters (Round 12, WP-DOC review).

A page once showed a literal U+200B ZERO WIDTH SPACE inside the example of a "visible
escape", so the built page rendered an empty-looking code span and the app-knowledge
corpus built from the pages would have carried the hidden character into chat's
product-help answers. ``scripts/check_docs.py`` now refuses Unicode format (Cf) and
control (Cc) characters, bar tab and carriage return, in every public page. These tests
pin the helper, the gate itself (a page with one fails it), and the committed pages.
Offline and deterministic: the gate is run against a temporary documentation tree.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

import app

REPO_ROOT = Path(app.__file__).resolve().parents[2]


def _check_docs_module():
    path = REPO_ROOT / "scripts" / "check_docs.py"
    spec = importlib.util.spec_from_file_location("check_docs_under_test", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize(
    "character",
    [
        "\u200b",  # zero width space
        "\u200d",  # zero width joiner
        "\u202e",  # right-to-left override
        "\u2066",  # left-to-right isolate
        "\ufeff",  # byte-order mark / zero width no-break space
        "\u00ad",  # soft hyphen
        "\u0007",  # bell (a control character)
    ],
)
def test_hidden_character_is_reported_with_its_position(character):
    check_docs = _check_docs_module()
    source = f"# Title\n\nAn escape such as `{character}` here.\n"
    found = check_docs.hidden_characters(source)
    assert found == [(3, 20, f"U+{ord(character):04X}")]


def test_visible_text_and_markdown_whitespace_pass():
    check_docs = _check_docs_module()
    source = (
        "---\ntitle: T\n---\r\n# Title\n\n"
        "| a\t| b |\n"
        "Escapes are written as text: `\\u200b`.\n"
        "Arrows → and ≥ 20,000, accents é, dashes — and emoji \U0001f512 stay.\n"
    )
    assert check_docs.hidden_characters(source) == []


def _write_tree(root: Path, page_text: str) -> None:
    sections = "\n".join(
        f"  - {name}:" if index else f"  - {name}:\n      - Home: index.md"
        for index, name in enumerate(
            ["Use the product", "Administer", "Deploy and operate", "Reference",
             "Releases and versions"]
        )
    )
    (root / "mkdocs.yml").write_text(f"site_name: t\nnav:\n{sections}\n", encoding="utf-8")
    docs = root / "docs"
    docs.mkdir()
    (docs / "index.md").write_text(page_text, encoding="utf-8")


def _run_gate(check_docs, root: Path, monkeypatch, capsys) -> tuple[int, str]:
    monkeypatch.setattr(check_docs, "ROOT", root)
    monkeypatch.setattr(check_docs, "DOCS", root / "docs")
    status = check_docs.main()
    captured = capsys.readouterr()
    return status, captured.out + captured.err


def test_gate_fails_on_a_page_with_a_hidden_character(tmp_path, monkeypatch, capsys):
    check_docs = _check_docs_module()
    _write_tree(tmp_path, "---\ntitle: Home\n---\n\n# Home\n\nAn escape such as `\u200b`.\n")
    status, output = _run_gate(check_docs, tmp_path, monkeypatch, capsys)
    assert status == 1
    assert "docs/index.md:7:" in output
    assert "invisible character U+200B" in output


def test_gate_passes_the_same_page_with_a_visible_escape(tmp_path, monkeypatch, capsys):
    check_docs = _check_docs_module()
    _write_tree(tmp_path, "---\ntitle: Home\n---\n\n# Home\n\nAn escape such as `\\u200b`.\n")
    status, output = _run_gate(check_docs, tmp_path, monkeypatch, capsys)
    assert status == 0, output
    assert "Documentation consistency check passed: 1 public pages" in output


def test_committed_public_pages_hold_no_hidden_characters():
    check_docs = _check_docs_module()
    offenders = {
        page.as_posix(): hits
        for page in sorted(check_docs.public_pages())
        if (hits := check_docs.hidden_characters((check_docs.DOCS / page).read_text(encoding="utf-8")))
    }
    assert offenders == {}


def test_chat_page_shows_the_inspector_escape_as_visible_text():
    """The Inspect a lookup example names the escape the step inspector really writes
    (``\\u`` plus four lower-case hex digits, ``StepInspector.tsx``)."""
    chat = (REPO_ROOT / "docs" / "analyst" / "chat.md").read_text(encoding="utf-8")
    assert "`\\u200b`" in chat
    assert "\u200b" not in chat
