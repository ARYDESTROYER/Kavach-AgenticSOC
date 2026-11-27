"""Offline tests for the runbook LOADERS that replaced the playbook loader.

Round 14 (SPEC §4.10.14, §4.10.16) retired the Markdown playbook loader. Two loaders
remain, and this file pins both:

* the bundled library loader (``runbook_model.load_builtin_library``), which reads the
  built-in runbooks from package data, keeps the valid ones and refuses (never loads)
  a broken one, and
* the legacy front-matter reader (``runbook_model.parse_frontmatter``), which the
  one-shot migration uses to read a stored playbook document in the old format.

No network, no ES, no LLM: pure parsing of in-memory and tmp-dir Markdown text.
"""

from __future__ import annotations

from pathlib import Path

from app.engine.runbook_model import (
    RUNBOOK_LIBRARY_DIR,
    load_builtin_library,
    parse_frontmatter,
)


def _legacy_playbook_text(id_: str = "mail_bruteforce") -> str:
    return (
        "---\n"
        f"id: {id_}\n"
        "name: Mail credential brute force\n"
        "version: 2\n"
        "description: A burst of failed mail authentications.\n"
        "priority: 50\n"
        "match:\n"
        "  rule_ids: [mail_auth, waf_auth]\n"
        "  entity_types: [ip, user]\n"
        "  min_event_count: 3\n"
        "suggested_tools: [es_query, enrich]\n"
        "rag_queries:\n"
        "  - mail brute force playbook\n"
        "escalate_if: a single attempt succeeded\n"
        "suggested_verdict_bias: lean TRUE_POSITIVE on success\n"
        "---\n"
        "## Procedure\n"
        "1. Confirm the failure burst.\n"
    )


def _builtin_text(id_: str) -> str:
    return (
        "---\n"
        f"id: {id_}\n"
        "title: Test runbook\n"
        "summary: A short test runbook.\n"
        "version: 3\n"
        "applies_when:\n"
        "  rule_ids: [mail_auth]\n"
        "---\n"
        "\n"
        "## Triage\n"
        "\n"
        "### Is the source internal? {#source-scope kind=check}\n"
        "Focus: the source address and the account.\n"
    )


def test_legacy_playbook_front_matter_is_still_read() -> None:
    meta, body = parse_frontmatter(_legacy_playbook_text())
    assert meta["id"] == "mail_bruteforce"
    assert meta["name"] == "Mail credential brute force"
    assert meta["priority"] == "50"
    assert meta["match"]["rule_ids"] == ("mail_auth", "waf_auth")
    assert meta["match"]["entity_types"] == ("ip", "user")
    assert meta["rag_queries"] == ("mail brute force playbook",)
    assert meta["escalate_if"] == "a single attempt succeeded"
    assert body.startswith("## Procedure")


def test_text_without_front_matter_reads_as_body_only() -> None:
    meta, body = parse_frontmatter("Just a plain body, no front matter.\n")
    assert meta == {}
    assert body.startswith("Just a plain body")
    assert parse_frontmatter("") == ({}, "")


def test_library_loader_keeps_good_and_refuses_broken(tmp_path: Path) -> None:
    (tmp_path / "good-one.md").write_text(_builtin_text("good-one"), encoding="utf-8")
    # Broken: no version, which a built-in must carry.
    (tmp_path / "no-version.md").write_text(
        _builtin_text("no-version").replace("version: 3\n", ""), encoding="utf-8"
    )
    # Broken: the id does not match the file name.
    (tmp_path / "wrong-name.md").write_text(_builtin_text("other-name"), encoding="utf-8")
    # Not a runbook: skipped, never refused.
    (tmp_path / "README.md").write_text("# Library\n", encoding="utf-8")

    loaded, refused = load_builtin_library(tmp_path)
    assert [b.id for b in loaded] == ["good-one"]
    assert loaded[0].version == 3 and loaded[0].file_name == "good-one.md"
    assert set(refused) == {"no-version.md", "wrong-name.md"}
    assert all(issues for issues in refused.values())


def test_library_loader_missing_dir_returns_empty(tmp_path: Path) -> None:
    assert load_builtin_library(tmp_path / "does_not_exist") == ((), {})


def test_the_shipped_library_loads_whole() -> None:
    loaded, refused = load_builtin_library(RUNBOOK_LIBRARY_DIR)
    assert refused == {}
    assert len(loaded) == 12
