"""The one-shot migration of stored operator procedures into runbooks (Round 14 SPEC
§4.10.17, §4.10.19, E9) and the retired settings keys.

Pins: the acceptance fixture (the 9 retired bundled procedures and the 9 retired
bundled reference runbooks, converted as operator documents, all land Published v1
within the 3,000-character investigator budget); the guidance a converted procedure
keeps; every mapping and overflow rule; the id rules (operator spelling kept, reserved,
shadowed, colliding, too long); the 7 + 3 acceptance store (8 Published, 2 Drafts,
audited, idempotent); interrupted runs (between documents, during the projection);
the marker and its ``id_map``; the audit rows; that nothing writes a legacy document;
that the migration runs with the retired procedure modules absent; and the retired
``Preferences`` keys mapped once by meaning.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap
from pathlib import Path
from typing import Any

import pytest

from app.audit.write import AuditUnavailableError
from app.config import LegacyPlaybookConfig, Preferences, RunbookConfig, map_retired_runbook_writes
from app.constants import PLAYBOOKS_KEY, PLAYBOOKS_NS, RUNBOOK_LIBRARY_NS, RUNBOOKS_KEY, RUNBOOKS_NS
from app.engine import runbook_migration as migration
from app.engine.runbook_migration import (
    BENIGN_FULL,
    DECISION_OPTIONS,
    ESCALATE_FULL,
    FOCUS_FLOOR_CHARS,
    ACTION_SKIPPED,
    NOTE_BUILTIN_ID,
    NOTE_BUNDLED_ID,
    NOTE_CONDITIONS_LOST,
    NOTE_COUNT_BELOW_ONE,
    NOTE_DUPLICATE,
    NOTE_FOLDER_INERT,
    NOTE_GRAMMAR,
    NOTE_KEYWORDS_LEFT_OUT,
    NOTE_NO_CONDITIONS,
    NOTE_REFERENCE,
    NOTE_REFERENCE_NO_CONDITIONS,
    NOTE_RESERVED,
    NOTE_RULE_ANY_ENTITY,
    NOTE_RULE_ENTITY_NARROWED,
    NOTE_SHADOWED,
    NOTE_SOFT_AS_RULES,
    NOTE_SOFT_EXACT,
    NOTE_TAGS_LEFT_OUT,
    NOTE_TECHNIQUES_COVERAGE,
    NOTE_WIDENED,
    TITLE_DECIDE,
    TITLE_EVIDENCE,
    TITLE_FOLLOW,
    TITLE_NEEDS_PERSON,
    TITLE_SCOPE,
    IdPlan,
    SourceDocument,
    completion_summary,
    convert_procedure_document,
    convert_reference_document,
    convert_source,
    migrated_procedure_ids,
    packaged_procedure_dir,
    plan_id,
    resume_runbook_projection,
    run_runbook_migration,
)
from app.engine.runbook_match import CaseFacts, MatchableRunbook, match
from app.engine.runbook_model import (
    LEGACY_BUNDLED_RUNBOOK_MAP,
    MAX_RUNBOOK_PROMPT_CHARS,
    cut_text,
    prompt_chars,
    render_runbook_prompt,
    resolve_automation_runbook_id,
    validate_runbook,
)
from app.es.fake import InMemoryESClient
from app.models import RUNBOOK_RESERVED_IDS
from app.stores.legacy_procedures import LegacyProcedureReader
from app.stores.memory import EsKVStore
from app.stores.runbook_library import RunbookLibraryStore, doc_key

FIXTURES = Path(__file__).parent / "fixtures" / "round14_legacy_procedures"
NOW = "2026-10-28T12:00:00+00:00"

#: The acceptance fixture's known exceptions (SPEC §4.10.17): fixture file name to the
#: rule it fails. The goal, and the current state, is none. A change here is visible in
#: review and must be listed in the Journal and in SPEC §11.3.
KNOWN_FIXTURE_EXCEPTIONS: dict[str, str] = {}


# --------------------------------------------------------------------------- #
# Helpers.
# --------------------------------------------------------------------------- #
class _Audit:
    """An audit repository double: records every strict append, can fail on a given
    append, and can check the library at append time (audit-before-visible)."""

    def __init__(self, *, fail_on: int | None = None, check: Any = None) -> None:
        self.rows: list[dict[str, Any]] = []
        self.fail_on = fail_on
        self.check = check
        self.calls = 0

    async def record_strict(self, **row: Any) -> None:
        self.calls += 1
        if self.fail_on is not None and self.calls == self.fail_on:
            raise RuntimeError("audit store down")
        if self.check is not None:
            await self.check(row)
        self.rows.append(row)

    def actions(self) -> list[str]:
        return [r["action"] for r in self.rows]


class _SpyKV:
    """Records every namespace written, and can fail writes to one key."""

    def __init__(self, inner: Any) -> None:
        self.inner = inner
        self.written: list[tuple[str, str]] = []
        self.fail_key: str | None = None

    async def get(self, namespace: str, key: str):
        return await self.inner.get(namespace, key)

    async def put(self, namespace: str, key: str, value: dict[str, Any]) -> None:
        self.written.append((namespace, key))
        await self.inner.put(namespace, key, value)

    async def put_if(self, namespace: str, key: str, value: dict[str, Any], expected_rev: int) -> bool:
        if self.fail_key is not None and key == self.fail_key:
            raise RuntimeError("store down")
        self.written.append((namespace, key))
        return await self.inner.put_if(namespace, key, value, expected_rev)


def _procedure(doc_id: str, *, title: str = "Suspicious VPN sign-in", sections: int = 2,
               escalate_if: str = "A sign-in succeeds from the flagged address.") -> str:
    body = "\n\n".join(
        f"## Look at part {i}\nCheck the sign-in records for part {i}. Note anything unusual."
        for i in range(1, sections + 1)
    )
    return textwrap.dedent(f"""\
        ---
        id: {doc_id}
        name: {title}
        description: Work a suspicious sign-in from an unexpected place.
        match:
          rule_ids: [vpn_auth]
          entity_types: [ip, user]
          mitre: [T1078]
          min_event_count: 3
        priority: 60
        rag_queries: [vpn sign-in policy]
        escalate_if: {escalate_if}
        ---
        """) + body + "\n"


def _reference(doc_id: str, *, title: str = "Beaconing host", signal: str | None = None,
               true_positive: str | None = None, summary: str | None = None) -> str:
    front = [f"id: {doc_id}", f"title: {title}", "applies_to_rules: [edr]",
             "applies_to_techniques: [T1071]", "applies_to_entities: [host]",
             "keywords: [beacon, c2]", "persona: malware"]
    if summary:
        front.append(f"summary: {summary}")
    return (
        "---\n" + "\n".join(front) + "\n---\n"
        f"SIGNAL\n{signal or 'A host contacts a known command server on a fixed interval.'}\n\n"
        "EVIDENCE REQUIRED\nProcess name, destination and interval.\n\n"
        "INVESTIGATION STEPS\n1. Confirm the interval.\n2. Find the process that opened the connection.\n\n"
        f"TRUE POSITIVE SIGNALS\n{true_positive or 'The destination is a known command server.'}\n\n"
        "FALSE POSITIVE SIGNALS\nThe destination is an approved update service.\n\n"
        "NEEDS HUMAN WHEN\nThe host is a server.\n\n"
        "RECOMMENDED NEXT ACTION\nIsolate the host.\n\n"
        "LIMITATIONS\nIntervals can be jittered.\n"
    )


def _too_many_steps(doc_id: str) -> str:
    """A procedure with 41 sections: 42 steps, over the 40-step limit."""
    body = "\n\n".join(f"## Part {i}\nLook at {i}." for i in range(1, 42))
    return f"---\nid: {doc_id}\nname: Long procedure\ndescription: Too many parts.\n---\n{body}\n"


async def _seed(kv: Any, namespace: str, docs: dict[str, str]) -> None:
    key = PLAYBOOKS_KEY if namespace == PLAYBOOKS_NS else RUNBOOKS_KEY
    await kv.put(namespace, key, {"documents": {
        doc_id: {"content": content, "revision": 3, "created_by": "alice", "updated_by": "bob",
                 "created_at": "2026-01-01T00:00:00+00:00", "updated_at": "2026-02-01T00:00:00+00:00"}
        for doc_id, content in docs.items()
    }})


async def _migrate(kv: Any, audit: _Audit | None = None, *, prefs: Preferences | None = None,
                   projector: Any = None) -> tuple[Any, RunbookLibraryStore, _Audit]:
    library = RunbookLibraryStore(kv)
    audit = audit or _Audit()
    outcome = await run_runbook_migration(
        library=library, legacy=LegacyProcedureReader(kv), audit=audit,
        prefs=prefs or Preferences(), projector=projector, now=lambda: NOW,
    )
    return outcome, library, audit


def _all_text(defn: Any) -> str:
    """Every piece of text a converted definition holds."""
    parts = [defn.title, defn.summary, defn.use_when, defn.prerequisites]
    for step in defn.steps:
        parts += [step.title, step.instructions, step.focus or "", step.escalate_if or "", step.benign_if or ""]
    return "\n".join(parts)


def _words(text: str) -> list[str]:
    return [w for w in migration._flatten(text).split(" ") if w]


# --------------------------------------------------------------------------- #
# The acceptance fixture (SPEC §4.10.17).
# --------------------------------------------------------------------------- #
FIXTURE_FILES = sorted(p.name for p in FIXTURES.glob("*.md"))


def test_the_fixture_holds_the_eighteen_retired_bundled_documents() -> None:
    assert len(FIXTURE_FILES) == 18
    assert sum(name.startswith("reference_") for name in FIXTURE_FILES) == 9
    legacy_ids = {Path(n).stem.removeprefix("reference_") for n in FIXTURE_FILES}
    assert legacy_ids == set(LEGACY_BUNDLED_RUNBOOK_MAP)


def _fixture_source(name: str) -> SourceDocument:
    reference = name.startswith("reference_")
    legacy_id = Path(name).stem.removeprefix("reference_")
    return SourceDocument(RUNBOOKS_NS if reference else PLAYBOOKS_NS, legacy_id,
                          (FIXTURES / name).read_text(encoding="utf-8"), 1)


@pytest.mark.parametrize("name", FIXTURE_FILES)
def test_every_fixture_document_lands_published_within_the_budget(name: str) -> None:
    """Converted as an operator document (the shadow rule aside: their ids are the
    shadowing ids), every one validates and fits the 3,000-character budget."""
    source = _fixture_source(name)
    doc = convert_source(source, IdPlan(runbook_id=source.legacy_id), now=NOW)
    version = doc.runbook.versions[0]
    failures = [i.message for i in doc.issues]
    if name in KNOWN_FIXTURE_EXCEPTIONS:
        assert doc.state == "draft" and failures
        return
    assert failures == [], failures
    assert doc.state == "published" and version.version == 1
    assert version.prompt_chars <= MAX_RUNBOOK_PROMPT_CHARS
    assert prompt_chars(version.definition, 1) == version.prompt_chars
    assert doc.runbook.origin == "imported" and doc.runbook.review_due_at == NOW
    assert doc.runbook.migrated_from.id == source.legacy_id


def test_the_known_fixture_exception_list_is_pinned_empty() -> None:
    failing = []
    for name in FIXTURE_FILES:
        source = _fixture_source(name)
        doc = convert_source(source, IdPlan(runbook_id=source.legacy_id), now=NOW)
        if doc.state != "published":
            failing.append(name)
    assert failing == sorted(KNOWN_FIXTURE_EXCEPTIONS) == []


@pytest.mark.parametrize("name", [n for n in FIXTURE_FILES if not n.startswith("reference_")])
def test_a_converted_procedure_keeps_its_escalation_guidance(name: str) -> None:
    """The investigator reads each step's focus and the decision's escalate-if, so the
    guidance that reached the prompt before Round 14 keeps reaching it."""
    source = _fixture_source(name)
    doc = convert_source(source, IdPlan(runbook_id=source.legacy_id), now=NOW)
    defn = doc.runbook.versions[0].definition
    rendered = render_runbook_prompt(defn, 1)
    meta, _ = migration.parse_frontmatter(source.content)
    escalate = migration._flatten(meta.get("escalate_if") or "")
    if escalate:
        kept, _ = cut_text(escalate, 300) if len(escalate) > 300 else (escalate, "")
        assert kept in rendered
    checks = [s for s in defn.steps if s.phase == "investigate" and s.kind == "check"]
    assert checks
    for step in checks:
        assert step.focus and step.focus in rendered, step.id
        # The focus is the start of the section's guidance.
        assert _words(step.focus)[:3] == _words(step.instructions)[:3]


# --------------------------------------------------------------------------- #
# Mapping rules.
# --------------------------------------------------------------------------- #
def test_procedure_mapping() -> None:
    content = _procedure("acme-vpn") .replace(
        "priority: 60\n",
        "priority: 60\nsuggested_verdict_bias: lean benign\nsuggested_tools: [es_query]\nany_tags: [vpn]\n",
    )
    conversion = convert_procedure_document(content, runbook_id="acme-vpn", fallback_title="acme-vpn")
    defn = conversion.definition
    assert defn.title == "Suspicious VPN sign-in"
    assert defn.summary == "Work a suspicious sign-in from an unexpected place."
    assert defn.applies_when.rule_ids == ["vpn_auth"]
    assert defn.applies_when.entity_types == ["ip", "user"]
    assert defn.applies_when.min_event_count == 3
    # Techniques and tags were advisory beside a hard criterion: the techniques are
    # coverage and the tags are left out, each noted (they never decided a match).
    assert defn.applies_when.mitre == [] and defn.mitre == ["T1078"]
    assert defn.applies_when.any_tags == []
    assert defn.priority == 60 and defn.retrieval_queries == ["vpn sign-in policy"]
    checks = [s for s in defn.steps if s.kind == "check"]
    assert [s.title for s in checks] == ["Look at part 1", "Look at part 2"]
    assert all(s.phase == "investigate" for s in checks)
    assert checks[0].focus == "Check the sign-in records for part 1. Note anything unusual."
    decision = defn.steps[-1]
    assert decision.kind == "decision" and decision.title == TITLE_DECIDE
    assert [(o.id, o.label) for o in decision.options] == list(DECISION_OPTIONS)
    assert decision.escalate_if == "A sign-in succeeds from the flagged address."
    notes = " ".join(conversion.notes)
    assert "verdict bias was dropped" in notes and "suggested tools list was dropped" in notes
    assert NOTE_TECHNIQUES_COVERAGE in conversion.notes and NOTE_TAGS_LEFT_OUT in conversion.notes
    assert validate_runbook(defn, origin="imported", version=1) == []


def test_a_procedure_with_only_techniques_and_tags_matches_the_rule_names_they_matched() -> None:
    """The retired matcher compared techniques and tags only with the cluster's rule
    names; with no hard criterion they are now the rule conditions. It ignored capital
    letters there and a rule condition matches exactly, so that narrowing is noted."""
    content = ("---\nid: soft\nname: Soft\ndescription: Soft criteria only.\n"
               "match:\n  mitre: [T1110, not-a-technique]\n  any_tags: [vpn_auth]\n---\n"
               "## Look\nLook at it.\n")
    conversion = convert_procedure_document(content, runbook_id="soft", fallback_title="soft")
    defn = conversion.definition
    assert defn.applies_when.rule_ids == ["T1110", "not-a-technique", "vpn_auth"]
    assert defn.applies_when.mitre == [] and defn.applies_when.any_tags == []
    assert defn.mitre == ["T1110"]
    assert NOTE_SOFT_AS_RULES in conversion.notes
    assert NOTE_SOFT_EXACT in conversion.notes
    assert any("not an ATT&CK technique id" in n for n in conversion.notes)
    facts = CaseFacts(rule_values=("vpn_auth",), entity_types=frozenset({"ip"}), event_count=2)
    assert _matches(defn, facts)
    # The comparison is exact now (the retired one lowercased both sides): a rule
    # differing only in capital letters no longer matches, which the note says.
    differs = CaseFacts(rule_values=("VPN_Auth",), entity_types=frozenset({"ip"}), event_count=2)
    assert not _matches(defn, differs)


def test_a_procedure_without_criteria_says_it_is_attached_by_hand() -> None:
    content = "---\nid: open\nname: Open\ndescription: No criteria.\n---\n## Look\nLook.\n"
    conversion = convert_procedure_document(content, runbook_id="open", fallback_title="open")
    assert conversion.definition.applies_when.model_dump(exclude_defaults=True) == {}
    assert NOTE_NO_CONDITIONS in conversion.notes


def _matches(defn: Any, facts: CaseFacts) -> bool:
    item = MatchableRunbook(id=defn.id, version=1, definition=defn, origin="imported",
                            published_at=NOW)
    result = match(facts, [item], fallback=False)
    return result.winner is not None and result.winner.id == defn.id


def test_a_converted_procedure_attaches_before_and_after_the_verdict() -> None:
    """D32 and the investigator guidance: the converted retired brute-force procedure
    (rules, entities, a count, advisory techniques and tags) matches the cluster
    before the investigation and the case after a verdict, which carries no tags."""
    source = _fixture_source("brute_force_login.md")
    doc = convert_source(source, IdPlan(runbook_id="bf_custom"), now=NOW)
    assert doc.state == "published"
    defn = doc.runbook.versions[0].definition
    before = CaseFacts(rule_values=("mail_auth",), entity_types=frozenset({"ip"}), event_count=10)
    after = CaseFacts(rule_values=("mail_auth",), entity_types=frozenset({"ip"}), event_count=10,
                      verdict="NEEDS_HUMAN", status="open", tags=(), mitre=("T1110",),
                      severity="high")
    assert _matches(defn, before)
    assert _matches(defn, after)


def test_an_entity_and_technique_procedure_still_matches_before_the_investigation() -> None:
    content = ("---\nid: user-misuse\nname: User misuse\ndescription: A user misuses access.\n"
               "match:\n  entity_types: [user]\n  mitre: [T1078]\n---\n## Look\nLook at the user.\n")
    defn = convert_procedure_document(content, runbook_id="user-misuse", fallback_title="x").definition
    assert defn.applies_when.entity_types == ["user"] and defn.applies_when.mitre == []
    assert _matches(defn, CaseFacts(rule_values=("any_rule",), entity_types=frozenset({"user"})))


def test_a_procedure_without_headings_becomes_one_check() -> None:
    content = "---\nid: plain\nname: Plain\ndescription: A plain one.\n---\nLook at the sign-in.\nThen decide.\n"
    defn = convert_procedure_document(content, runbook_id="plain", fallback_title="plain").definition
    assert [s.title for s in defn.steps] == [TITLE_FOLLOW, TITLE_DECIDE]
    assert defn.steps[0].focus == "Look at the sign-in. Then decide."
    assert defn.steps[0].instructions == "Look at the sign-in.\nThen decide."


def test_rule_with_every_other_entity_type_removes_the_entity_condition() -> None:
    """``rule`` with ``ip``, ``user`` and ``host`` named every kind a case could be
    grouped by: the condition never excluded one, so it is removed (no widening)."""
    content = _procedure("any-kind").replace("entity_types: [ip, user]",
                                             "entity_types: [user, host, ip, rule]")
    conversion = convert_procedure_document(content, runbook_id="any-kind", fallback_title="x")
    assert conversion.definition.applies_when.entity_types == []
    assert NOTE_RULE_ANY_ENTITY in conversion.notes
    assert not conversion.force_draft and NOTE_WIDENED not in conversion.notes


def test_rule_with_some_entity_types_is_left_out_and_narrows_the_match() -> None:
    """``rule`` (a case grouped by its rule alone) cannot be a runbook condition. With
    only some other kinds, dropping the whole condition would let every kind match;
    keeping the others narrows the match instead, and the note says so."""
    content = _procedure("rule-keyed").replace("entity_types: [ip, user]", "entity_types: [rule, ip]")
    conversion = convert_procedure_document(content, runbook_id="rule-keyed", fallback_title="x")
    defn = conversion.definition
    assert defn.applies_when.entity_types == ["ip"]
    assert NOTE_RULE_ENTITY_NARROWED in conversion.notes
    assert not conversion.force_draft
    assert _matches(defn, CaseFacts(rule_values=("vpn_auth",), entity_types=frozenset({"ip"}), event_count=5))
    assert not _matches(defn, CaseFacts(rule_values=("vpn_auth",), entity_types=frozenset({"user"}),
                                        event_count=5))
    assert not _matches(defn, CaseFacts(rule_values=("vpn_auth",), entity_types=frozenset(), event_count=5))


def test_a_retired_file_hash_entity_type_becomes_hash() -> None:
    content = _procedure("hashes").replace("entity_types: [ip, user]", "entity_types: [file_hash]")
    conversion = convert_procedure_document(content, runbook_id="hashes", fallback_title="x")
    assert conversion.definition.applies_when.entity_types == ["hash"]
    assert not conversion.force_draft


# --------------------------------------------------------------------------- #
# A dropped condition never widens the match of trusted guidance.
# --------------------------------------------------------------------------- #
LONG_RULE = "Windows Security: very long detection title " + "x" * 300


@pytest.mark.parametrize("match_block, kept", [
    # Every rule too long, the entity condition kept: every case with that entity.
    (f"  rule_ids: ['{LONG_RULE}']\n  entity_types: [ip]\n", {"entity_types": ["ip"]}),
    # Only 'rule' named beside a rule condition: the entity condition is gone.
    ("  rule_ids: [vpn_auth]\n  entity_types: [rule]\n", {"rule_ids": ["vpn_auth"]}),
    # Only kinds a runbook cannot match beside a count.
    ("  entity_types: [process_tree]\n  min_event_count: 4\n", {"min_event_count": 4}),
    # A count the retired reader refused, beside a rule condition.
    ("  rule_ids: [vpn_auth]\n  min_event_count: lots\n", {"rule_ids": ["vpn_auth"]}),
])
def test_a_condition_that_cannot_be_kept_beside_another_makes_a_draft(match_block: str, kept: dict) -> None:
    """The retired matcher required every hard criterion; when one cannot be kept
    while another remains, the converted runbook would match MORE cases than the
    original, so it is a Draft with the reason, never Published (#9)."""
    content = ("---\nid: widened\nname: Widened\ndescription: A narrow procedure.\nmatch:\n"
               + match_block + "---\n## Look\nLook at it.\n")
    conversion = convert_procedure_document(content, runbook_id="widened", fallback_title="x")
    assert conversion.definition.applies_when.model_dump(exclude_defaults=True) == kept
    assert conversion.force_draft and NOTE_WIDENED in conversion.notes
    doc = convert_source(SourceDocument(PLAYBOOKS_NS, "widened", content, 1), IdPlan("widened"), now=NOW)
    assert doc.state == "draft" and not doc.issues
    assert NOTE_WIDENED in doc.runbook.versions[0].import_notes


def test_a_reference_runbook_whose_rules_cannot_be_kept_is_a_draft() -> None:
    content = (f"---\nid: ref-long\ntitle: Long rule\napplies_to_rules: ['{LONG_RULE}']\n"
               "applies_to_entities: [host]\n---\nSIGNAL\nA host does a thing.\n")
    conversion = convert_reference_document(content, runbook_id="ref-long", fallback_title="x")
    assert conversion.definition.applies_when.entity_types == ["host"]
    assert conversion.definition.applies_when.rule_ids == []
    assert conversion.force_draft and NOTE_WIDENED in conversion.notes


def test_a_partly_kept_condition_narrows_and_stays_published() -> None:
    """Keeping some of a condition's values narrows the match: no Draft."""
    content = ("---\nid: partly\nname: Partly\ndescription: Two rules.\nmatch:\n"
               f"  rule_ids: [vpn_auth, '{LONG_RULE}']\n  entity_types: [ip]\n---\n## Look\nLook.\n")
    conversion = convert_procedure_document(content, runbook_id="partly", fallback_title="x")
    assert conversion.definition.applies_when.rule_ids == ["vpn_auth"]
    assert not conversion.force_draft and NOTE_WIDENED not in conversion.notes
    assert any("longer than 256 characters" in n for n in conversion.notes)


@pytest.mark.parametrize("match_block", [
    f"  rule_ids: ['{LONG_RULE}']\n",
    "  entity_types: [rule]\n  mitre: [T1110]\n",
    "  min_event_count: lots\n",
])
def test_a_procedure_whose_only_conditions_cannot_be_kept_is_attached_by_hand(match_block: str) -> None:
    """With no condition left the runbook never attaches by itself (narrower than the
    original), so it may stay Published; the note says the conditions were lost, never
    that the original matched every case."""
    content = ("---\nid: lost\nname: Lost\ndescription: Conditions lost.\nmatch:\n"
               + match_block + "---\n## Look\nLook.\n")
    conversion = convert_procedure_document(content, runbook_id="lost", fallback_title="x")
    assert conversion.definition.applies_when.model_dump(exclude_defaults=True) == {}
    assert NOTE_CONDITIONS_LOST in conversion.notes
    assert NOTE_NO_CONDITIONS not in conversion.notes and not conversion.force_draft


@pytest.mark.parametrize("count", ["0", "-5"])
def test_a_count_below_one_matched_every_case(count: str) -> None:
    """The retired matcher kept a declared count below 1 as a hard criterion every
    cluster met, so the techniques beside it never narrowed the match: the original
    matched every case, which the note says, and the techniques stay coverage."""
    content = ("---\nid: zero\nname: Zero\ndescription: Count zero.\nmatch:\n"
               f"  min_event_count: {count}\n  mitre: [T1110]\n---\n## Look\nLook.\n")
    conversion = convert_procedure_document(content, runbook_id="zero", fallback_title="x")
    defn = conversion.definition
    assert defn.applies_when.model_dump(exclude_defaults=True) == {} and defn.mitre == ["T1110"]
    assert NOTE_COUNT_BELOW_ONE in conversion.notes and NOTE_NO_CONDITIONS in conversion.notes
    assert not conversion.force_draft


@pytest.mark.parametrize("count, expected", [("5.0", 5), ("'7'", 7), ("12", 12)])
def test_the_count_is_read_as_the_retired_manifest_read_it(count: str, expected: int) -> None:
    content = ("---\nid: count\nname: Count\ndescription: A count.\nmatch:\n"
               f"  rule_ids: [vpn_auth]\n  min_event_count: {count}\n---\n## Look\nLook.\n")
    conversion = convert_procedure_document(content, runbook_id="count", fallback_title="x")
    assert conversion.definition.applies_when.min_event_count == expected
    assert not conversion.force_draft


def test_a_reference_runbook_without_conditions_says_it_was_only_found_by_search() -> None:
    content = "---\nid: plain-ref\ntitle: Plain\n---\nSIGNAL\nSomething happens.\n"
    conversion = convert_reference_document(content, runbook_id="plain-ref", fallback_title="x")
    assert conversion.definition.applies_when.model_dump(exclude_defaults=True) == {}
    assert NOTE_REFERENCE_NO_CONDITIONS in conversion.notes
    assert NOTE_NO_CONDITIONS not in conversion.notes


def test_reference_mapping() -> None:
    conversion = convert_reference_document(
        _reference("acme-beacon", summary="An endpoint beacons."), runbook_id="acme-beacon",
        fallback_title="acme-beacon",
    )
    defn = conversion.definition
    assert defn.title == "Beaconing host" and defn.summary == "An endpoint beacons."
    assert "A host contacts a known command server" in defn.use_when
    assert "Limits: Intervals can be jittered." in defn.use_when
    assert defn.applies_when.rule_ids == ["edr"] and defn.applies_when.entity_types == ["host"]
    # Reference runbooks were retrieval knowledge: beside rules and entity types the
    # techniques are coverage, and the keywords (which only helped search) are left out.
    assert defn.applies_when.mitre == [] and defn.mitre == ["T1071"]
    assert defn.applies_when.any_tags == []
    assert NOTE_TECHNIQUES_COVERAGE in conversion.notes and NOTE_KEYWORDS_LEFT_OUT in conversion.notes
    by_title = {s.title: s for s in defn.steps}
    assert by_title[TITLE_EVIDENCE].phase == "triage"
    assert by_title["Confirm the interval."].phase == "investigate"
    assert by_title["Find the process that opened the connection."].kind == "check"
    needs = by_title[TITLE_NEEDS_PERSON]
    assert needs.escalate_if == "The host is a server."
    decision = by_title[TITLE_DECIDE]
    assert decision.escalate_if == "The destination is a known command server."
    assert decision.benign_if == "The destination is an approved update service."
    action = by_title["Isolate the host."]
    assert action.phase == "contain" and action.kind == "action"
    assert any("persona was dropped" in n for n in conversion.notes)
    assert validate_runbook(defn, origin="imported", version=1) == []


def test_a_reference_runbook_with_only_techniques_matches_on_them_after_the_verdict() -> None:
    content = _reference("acme-beacon").replace("applies_to_rules: [edr]\n", "").replace(
        "applies_to_entities: [host]\n", "")
    defn = convert_reference_document(content, runbook_id="acme-beacon", fallback_title="x").definition
    assert defn.applies_when.rule_ids == [] and defn.applies_when.entity_types == []
    assert defn.applies_when.mitre == ["T1071"] and defn.mitre == ["T1071"]
    assert not _matches(defn, CaseFacts(rule_values=("edr",)))
    assert _matches(defn, CaseFacts(rule_values=("edr",), verdict="TRUE_POSITIVE", status="open",
                                    tags=(), mitre=("T1071.001",)))


def test_reference_signal_becomes_the_summary_without_front_matter_summary() -> None:
    defn = convert_reference_document(_reference("acme-beacon"), runbook_id="acme-beacon",
                                      fallback_title="x").definition
    assert defn.summary == "A host contacts a known command server on a fixed interval."


# --------------------------------------------------------------------------- #
# Overflow rules: every move noted, nothing dropped.
# --------------------------------------------------------------------------- #
def test_an_1800_character_signal_overflows_into_use_when_and_scope() -> None:
    sentence = "The host contacts the same remote address again and again on a fixed schedule. "
    signal = (sentence * 30)[:1800].strip()
    assert len(signal) >= 1790
    conversion = convert_reference_document(_reference("long-signal", signal=signal),
                                            runbook_id="long-signal", fallback_title="x")
    defn = conversion.definition
    assert len(defn.summary) <= 280 and signal.startswith(defn.summary)
    assert 0 < len(defn.use_when) <= 500
    scope = next(s for s in defn.steps if s.title == TITLE_SCOPE)
    assert scope.phase == "triage" and defn.steps[0].title == TITLE_SCOPE
    # Nothing dropped: every word of the signal is in the summary, use-when or scope.
    joined = _words(f"{defn.summary} {defn.use_when} {scope.instructions}")
    assert _words(signal) == joined[: len(_words(signal))]
    notes = " ".join(conversion.notes)
    assert "summary was shortened to 280" in notes and "'Use when' text was shortened to 500" in notes
    assert validate_runbook(defn, origin="imported", version=1) == []


def test_a_700_character_true_positive_signal_keeps_its_full_text_in_the_instructions() -> None:
    sentence = "A second host shows the same beacon to the same command server within the hour. "
    true_positive = (sentence * 9)[:700].strip()
    conversion = convert_reference_document(_reference("long-tp", true_positive=true_positive),
                                            runbook_id="long-tp", fallback_title="x")
    decision = next(s for s in conversion.definition.steps if s.kind == "decision")
    assert len(decision.escalate_if) <= 300 and true_positive.startswith(decision.escalate_if)
    assert decision.instructions.startswith(ESCALATE_FULL)
    assert true_positive in decision.instructions
    assert any("'Escalate if' line of the step" in n for n in conversion.notes)
    assert validate_runbook(conversion.definition, origin="imported", version=1) == []


def test_a_long_benign_line_is_kept_in_full_too() -> None:
    long_benign = ("The destination is an approved update service that every host contacts daily. " * 5).strip()
    content = _reference("long-fp").replace("The destination is an approved update service.", long_benign)
    decision = next(s for s in convert_reference_document(content, runbook_id="long-fp",
                                                          fallback_title="x").definition.steps
                    if s.kind == "decision")
    assert len(decision.benign_if) <= 300 and BENIGN_FULL in decision.instructions
    assert long_benign in decision.instructions


def test_long_titles_and_instructions_overflow_without_loss() -> None:
    step_title = "Check " + "the very long heading text " * 8
    paragraph = "This paragraph explains one part of the check in plain words for the analyst. " * 12
    body = f"## {step_title.strip()}\n" + "\n\n".join([paragraph.strip()] * 3) + "\n"
    long_name = "A very long procedure name that keeps going " * 4
    content = f"---\nid: long\nname: {long_name.strip()}\ndescription: Short.\n---\n{body}"
    conversion = convert_procedure_document(content, runbook_id="long", fallback_title="x")
    defn = conversion.definition
    assert len(defn.title) <= 120 and long_name.strip() in defn.use_when
    parts = [s for s in defn.steps if s.kind == "check"]
    assert len(parts) >= 2 and all("(part " in s.title for s in parts)
    assert all(len(s.title) <= 160 and len(s.instructions) <= 2000 for s in parts)
    assert parts[0].focus and not any(s.focus for s in parts[1:])
    assert parts[0].instructions.startswith(migration._flatten(step_title))
    joined = " ".join(s.instructions for s in parts)
    assert _words(joined).count("paragraph") == 36
    notes = " ".join(conversion.notes)
    assert "was shortened" in notes and "were split into" in notes
    assert validate_runbook(defn, origin="imported", version=1) == []


def test_instructions_starting_like_a_field_get_a_leading_line() -> None:
    content = "---\nid: keyline\nname: Key line\ndescription: x.\n---\n## Part\nFocus: the sign-in.\n"
    step = convert_procedure_document(content, runbook_id="keyline", fallback_title="x").definition.steps[0]
    assert step.instructions.startswith(migration.LEADING_KEY_PREFIX)
    assert "Focus: the sign-in." in step.instructions


def test_focus_lines_are_shortened_until_the_rendering_fits_the_budget() -> None:
    sections = "\n\n".join(
        f"## Part {i}\n" + ("Look closely at every record of this part and compare it with the baseline. " * 5)
        for i in range(1, 15)
    )
    content = f"---\nid: wide\nname: Wide\ndescription: Many long sections.\n---\n{sections}\n"
    conversion = convert_procedure_document(content, runbook_id="wide", fallback_title="x")
    defn = conversion.definition
    focus = [s.focus for s in defn.steps if s.focus]
    assert focus and max(len(f) for f in focus) < 300
    assert all(len(f) >= FOCUS_FLOOR_CHARS - 20 for f in focus)
    assert prompt_chars(defn, 1) <= MAX_RUNBOOK_PROMPT_CHARS
    assert any("Focus lines were shortened" in n for n in conversion.notes)


def test_more_than_forty_steps_is_stored_as_a_draft_with_the_problem() -> None:
    source = SourceDocument(PLAYBOOKS_NS, "too-long", _too_many_steps("too-long"), 2)
    doc = convert_source(source, IdPlan(runbook_id="too-long"), now=NOW)
    assert doc.state == "draft" and doc.issues
    version = doc.runbook.versions[0]
    assert version.state == "draft" and version.published_at is None
    assert any(n.startswith("Problem to fix: ") for n in version.import_notes)
    assert len(version.definition.steps) == 42  # nothing dropped


# --------------------------------------------------------------------------- #
# Ids.
# --------------------------------------------------------------------------- #
def test_an_operator_id_keeps_its_spelling() -> None:
    assert plan_id(PLAYBOOKS_NS, "acme_login", taken=set(), procedure_ids=set()) == IdPlan("acme_login")


def test_a_reserved_id_is_renamed_and_keeps_its_state() -> None:
    reserved = sorted(RUNBOOK_RESERVED_IDS)[0]
    plan = plan_id(PLAYBOOKS_NS, reserved, taken=set(), procedure_ids=set())
    assert plan.runbook_id == f"{reserved}-imported" and plan.notes == (NOTE_RESERVED,)
    assert plan.shadowed is False
    doc = convert_source(SourceDocument(PLAYBOOKS_NS, reserved, _procedure(reserved), 1), plan, now=NOW)
    assert doc.state == "published"


@pytest.mark.parametrize("namespace, legacy_id", [
    (PLAYBOOKS_NS, "brute_force_login"),  # a bundled procedure won the id
    (RUNBOOKS_NS, "malware"),  # a bundled reference runbook owned the id
])
def test_the_shadow_rule(namespace: str, legacy_id: str) -> None:
    plan = plan_id(namespace, legacy_id, taken=set(), procedure_ids=set())
    assert plan.runbook_id == f"{legacy_id}-imported" and plan.shadowed
    assert NOTE_SHADOWED in plan.notes
    content = _procedure(legacy_id) if namespace == PLAYBOOKS_NS else _reference(legacy_id)
    doc = convert_source(SourceDocument(namespace, legacy_id, content, 1), plan, now=NOW)
    assert doc.state == "draft" and not doc.issues
    assert NOTE_SHADOWED in doc.runbook.versions[0].import_notes


@pytest.mark.parametrize("namespace, legacy_id, note", [
    # A new built-in id: no retired document had it, so the stored one was live.
    (PLAYBOOKS_NS, "generic-incident", NOTE_BUILTIN_ID),
    (RUNBOOKS_NS, "malware-endpoint", NOTE_BUILTIN_ID),
    # The other kind's bundled id: the retired readers never compared across kinds.
    (PLAYBOOKS_NS, "malware", NOTE_BUNDLED_ID),
    (RUNBOOKS_NS, "brute_force_login", NOTE_BUNDLED_ID),
])
def test_a_live_document_renamed_for_a_shadowing_id_keeps_its_state(
    namespace: str, legacy_id: str, note: str,
) -> None:
    """Every id in the union is renamed ``-imported``, but only an id a bundled
    document of the SAME kind owned was never used: any other was live, so it keeps
    its validated state and its note never claims it was unused."""
    plan = plan_id(namespace, legacy_id, taken=set(), procedure_ids=set())
    assert plan.runbook_id == f"{legacy_id}-imported" and not plan.shadowed
    assert note in plan.notes and NOTE_SHADOWED not in plan.notes
    content = _procedure(legacy_id) if namespace == PLAYBOOKS_NS else _reference(legacy_id)
    doc = convert_source(SourceDocument(namespace, legacy_id, content, 1), plan, now=NOW)
    assert doc.state == "published" and not doc.issues


def test_a_seventy_character_reference_id_gains_reference_within_64() -> None:
    legacy_id = "a" * 70
    base = "a" * 64
    plan = plan_id(RUNBOOKS_NS, legacy_id, taken={base}, procedure_ids={base})
    assert plan.runbook_id.endswith("-reference") and len(plan.runbook_id) <= 64
    assert plan.notes == (NOTE_GRAMMAR, NOTE_REFERENCE)


def test_collisions_get_numbered_suffixes() -> None:
    taken = {"acme", "acme-imported"}
    plan = plan_id(PLAYBOOKS_NS, "acme", taken=taken, procedure_ids=set())
    assert plan.runbook_id == "acme-imported-2" and NOTE_DUPLICATE in plan.notes
    reference = plan_id(RUNBOOKS_NS, "acme", taken={"acme", "acme-reference"}, procedure_ids={"acme"})
    assert reference.runbook_id == "acme-reference-2"
    bad = plan_id(PLAYBOOKS_NS, "Bad Name!", taken=set(), procedure_ids=set())
    assert bad.runbook_id == "bad-name" and bad.notes == (NOTE_GRAMMAR,)


# --------------------------------------------------------------------------- #
# The 7 + 3 acceptance store.
# --------------------------------------------------------------------------- #
PLAYBOOKS_7 = {
    "acme-login": _procedure("acme-login", title="Acme sign-in"),
    "acme-phish": _procedure("acme-phish", title="Acme phishing"),
    "acme-vpn": _procedure("acme-vpn", title="Acme VPN"),
    "acme-dns": _procedure("acme-dns", title="Acme DNS"),
    "acme-shared": _procedure("acme-shared", title="Acme shared"),
    "acme-too-long": _too_many_steps("acme-too-long"),
    "brute_force_login": _procedure("brute_force_login", title="Our brute force copy"),
}
RUNBOOKS_3 = {
    "acme-shared": _reference("acme-shared", title="Acme shared reference"),
    "acme-malware": _reference("acme-malware", title="Acme malware"),
    "acme-beacon": _reference("acme-beacon", title="Acme beacon"),
}
EXPECTED_PUBLISHED = {
    "acme-login", "acme-phish", "acme-vpn", "acme-dns", "acme-shared", "acme-shared-reference",
    "acme-malware", "acme-beacon",
}
EXPECTED_DRAFT = {"acme-too-long", "brute_force_login-imported"}


async def _store_7_3() -> Any:
    kv = EsKVStore(InMemoryESClient())
    await _seed(kv, PLAYBOOKS_NS, PLAYBOOKS_7)
    await _seed(kv, RUNBOOKS_NS, RUNBOOKS_3)
    return kv


async def test_seven_procedures_and_three_reference_runbooks_yield_8_published_and_2_drafts() -> None:
    kv = await _store_7_3()
    library = RunbookLibraryStore(kv)

    async def _not_visible_yet(row: dict[str, Any]) -> None:
        if row["action"] == "runbook.migrated":
            assert await library.get(row["target"].id) is None  # audit first

    projected: list[str] = []

    async def _projector(generation: str) -> bool:
        projected.append(generation)
        return True

    outcome, library, audit = await _migrate(kv, _Audit(check=_not_visible_yet), projector=_projector)
    assert (outcome.status, outcome.published, outcome.draft, outcome.skipped) == ("done", 8, 2, 0)
    assert outcome.migrated_now == 10 and outcome.projection_completed
    rows = {r.id: r for r in await library.list_rows()}
    assert {i for i, r in rows.items() if r.live_version == 1} == EXPECTED_PUBLISHED
    assert {i for i, r in rows.items() if r.live_version is None and r.draft_version == 1} == EXPECTED_DRAFT
    assert all(r.origin == "imported" and r.review_due_at == NOW for r in rows.values())
    catalog_ids = {p.runbook.id for p in await library.published_catalog()}
    assert catalog_ids == EXPECTED_PUBLISHED  # the shadowed copy never matches
    shadowed = await library.require("brute_force_login-imported")
    assert NOTE_SHADOWED in shadowed.runbook.versions[0].import_notes
    assert shadowed.runbook.migrated_from.revision == 3
    reference = await library.require("acme-shared-reference")
    assert NOTE_REFERENCE in reference.runbook.versions[0].import_notes
    assert reference.runbook.versions[0].author == "bob"

    # Audit: one row per document, then the summary; system actor.
    assert audit.actions() == ["runbook.migrated"] * 10 + ["runbook.migration_completed"]
    assert {(r["actor"], r["actor_type"], r["surface"]) for r in audit.rows} == {
        ("runbook_migration", "system", "runbook_migration"),
    }
    first = audit.rows[0]
    assert first["tool_input"]["source"] == {"namespace": PLAYBOOKS_NS, "id": "acme-login", "revision": 3}
    assert first["tool_input"]["state"] == "published"
    draft_row = next(r for r in audit.rows if r["tool_input"].get("runbook_id") == "acme-too-long")
    assert draft_row["tool_input"]["state"] == "draft" and draft_row["tool_input"]["issue_count"] >= 1
    summary = audit.rows[-1]
    assert summary["tool_input"]["counts"] == {"published": 8, "draft": 2, "skipped": 0}
    assert first["result_summary"] == "converted the stored procedure 'acme-login' to runbook acme-login as Published v1"
    # Audit summaries and import notes are shown in the Console: plain words only.
    shown = [r["result_summary"] for r in audit.rows]
    shown += [n for row in rows.values() for n in (await library.require(row.id)).runbook.versions[0].import_notes]
    assert not any("playbook" in text.lower() or "\u2014" in text for text in shown)

    # The marker, its id_map and the projection.
    record = await library.read_marker()
    marker = record.marker
    assert marker.completed_at == NOW and marker.projection_completed_at == NOW
    assert projected == [marker.projection_generation] and len(marker.projection_generation) == 32
    assert marker.id_map["playbooks:brute_force_login"] == "brute_force_login-imported"
    assert marker.id_map["runbooks:acme-shared"] == "acme-shared-reference"
    assert marker.id_map["playbooks:acme-shared"] == "acme-shared"
    assert len(marker.id_map) == 10
    notice = await library.migration_notice()
    assert (notice.published, notice.draft, notice.skipped) == (8, 2, 0)

    # Idempotent: a second start does nothing.
    again, _, audit2 = await _migrate(kv, projector=_projector)
    assert again.status == "already_done" and (again.published, again.draft) == (8, 2)
    assert audit2.rows == [] and await library.count() == 10 and len(projected) == 1


async def test_automation_rules_resolve_through_the_id_map() -> None:
    kv = await _store_7_3()
    _, library, _ = await _migrate(kv)
    migrated = migrated_procedure_ids((await library.read_marker()).marker)
    assert "acme-malware" not in migrated  # reference runbooks never ran from a rule
    # The stored copy of a retired bundled procedure was shadowed, so it never ran.
    id_map = (await library.read_marker()).marker.id_map
    assert id_map["playbooks:brute_force_login"] == "brute_force_login-imported"
    assert "brute_force_login" not in migrated
    assert migrated["acme-login"] == "acme-login"
    assert resolve_automation_runbook_id({"playbook_id": "acme-login"}, migrated) == "acme-login"
    # A rule naming the bundled id ran the bundled procedure, never the shadowed copy.
    assert resolve_automation_runbook_id({"playbook_id": "brute_force_login"}, migrated) == \
        LEGACY_BUNDLED_RUNBOOK_MAP["brute_force_login"]
    assert resolve_automation_runbook_id({"playbook_id": "malware"}, migrated) == "malware-endpoint"
    assert migrated_procedure_ids(None) == {}
    assert migrated_procedure_ids({"id_map": {"playbook_dir:x": "x-dir", "playbooks:x": "x"}}) == {"x": "x-dir"}
    # A retired bundled id is kept only from a configured folder (the live file).
    assert migrated_procedure_ids({"id_map": {
        "playbooks:brute_force_login": "brute_force_login-imported",
        "playbooks:malware": "malware-imported",
    }}) == {"malware": "malware-imported"}
    assert migrated_procedure_ids({"id_map": {
        "playbook_dir:brute_force_login": "brute_force_login-imported",
    }}) == {"brute_force_login": "brute_force_login-imported"}


async def test_the_migration_never_writes_a_legacy_document() -> None:
    inner = await _store_7_3()
    before = {ns: await inner.get(ns, "documents") for ns in (PLAYBOOKS_NS, RUNBOOKS_NS)}
    spy = _SpyKV(inner)
    await _migrate(spy)
    assert {ns for ns, _ in spy.written} == {RUNBOOK_LIBRARY_NS}
    after = {ns: await inner.get(ns, "documents") for ns in (PLAYBOOKS_NS, RUNBOOKS_NS)}
    assert after == before
    assert not hasattr(LegacyProcedureReader, "put") and not any(
        name.startswith(("put", "write", "save", "delete", "mutate")) for name in dir(LegacyProcedureReader)
    )


async def test_a_crash_between_documents_resumes_without_converting_twice() -> None:
    kv = await _store_7_3()
    with pytest.raises(AuditUnavailableError):
        await _migrate(kv, _Audit(fail_on=4))
    library = RunbookLibraryStore(kv)
    assert await library.read_marker() is None
    assert await library.count() == 3
    outcome, library, audit = await _migrate(kv)
    assert (outcome.status, outcome.published, outcome.draft) == ("done", 8, 2)
    assert outcome.migrated_now == 7
    assert {r.id for r in await library.list_rows()} == EXPECTED_PUBLISHED | EXPECTED_DRAFT
    assert audit.actions() == ["runbook.migrated"] * 7 + ["runbook.migration_completed"]
    assert len((await library.read_marker()).marker.id_map) == 10


async def test_a_failed_library_write_is_audited_and_resumed() -> None:
    inner = await _store_7_3()
    spy = _SpyKV(inner)
    spy.fail_key = doc_key("acme-vpn")
    first_audit = _Audit()
    with pytest.raises(Exception):
        await _migrate(spy, first_audit)
    # The failed write appends the failure row PAIRED with its action row (the same
    # request id); a document never attempted has its own action (below).
    assert first_audit.actions()[-2:] == ["runbook.migrated", "runbook.migrate_failed"]
    assert first_audit.rows[-1]["outcome"] == "failure"
    assert first_audit.rows[-1]["request_id"] == first_audit.rows[-2]["request_id"]
    assert ACTION_SKIPPED not in first_audit.actions()
    spy.fail_key = None
    outcome, library, _ = await _migrate(spy)
    assert (outcome.published, outcome.draft) == (8, 2) and await library.count() == 10


class _IndexCommitThenRaiseKV:
    """Wraps a KV: the chosen write of the library index COMMITS and then raises once
    (an Elasticsearch timeout after the write landed)."""

    def __init__(self, inner: Any, *, nth: int) -> None:
        self.inner = inner
        self.nth = nth
        self.count = 0

    async def get(self, namespace: str, key: str):
        return await self.inner.get(namespace, key)

    async def put(self, namespace: str, key: str, value: dict[str, Any]) -> None:
        await self.inner.put(namespace, key, value)

    async def put_if(self, namespace: str, key: str, value: dict[str, Any], expected_rev: int) -> bool:
        ok = await self.inner.put_if(namespace, key, value, expected_rev)
        if namespace == RUNBOOK_LIBRARY_NS and key == "index":
            self.count += 1
            if self.count == self.nth:
                raise TimeoutError("request timed out after the write committed")
        return ok


@pytest.mark.parametrize("dangle_by_hand", [False, True])
async def test_an_index_write_that_committed_then_failed_never_counts_a_document_as_converted(
    dangle_by_hand: bool,
) -> None:
    """The third document's index write commits and then reports a failure: the
    first start fails (its failure row is written). The next start converts that
    document, every ``id_map`` value names a runbook that exists, and the counts
    match the library. With ``dangle_by_hand`` the failed create's rollback could not
    remove the row either (the worst case): the dangling row is still never counted."""
    inner = await _store_7_3()
    flaky = _IndexCommitThenRaiseKV(inner, nth=3)
    with pytest.raises(Exception):
        await _migrate(flaky)
    if dangle_by_hand:
        library = RunbookLibraryStore(inner)
        rows = {r.id for r in await library.list_rows()}
        index = await inner.get(RUNBOOK_LIBRARY_NS, "index")
        if "acme-vpn" not in rows:  # put the dangling row back, as a failed removal leaves it
            raw_rows = json.loads(index["runbook_index_json"])
            raw_rows.append({"id": "acme-vpn", "origin": "imported", "live_version": 1, "doc_rev": 1,
                             "migrated_from": {"namespace": PLAYBOOKS_NS, "id": "acme-vpn", "revision": 3}})
            index = dict(index, runbook_index_json=json.dumps(raw_rows))
            await inner.put(RUNBOOK_LIBRARY_NS, "index", index)
        assert "acme-vpn" in {r.id for r in await RunbookLibraryStore(inner).list_rows()}
        assert await RunbookLibraryStore(inner).get("acme-vpn") is None
    outcome, library, audit = await _migrate(inner)
    assert (outcome.status, outcome.published, outcome.draft) == ("done", 8, 2)
    assert await library.count() == 10
    marker = (await library.read_marker()).marker
    for key, runbook_id in marker.id_map.items():
        assert await library.get(runbook_id) is not None, key
    vpn = await library.require(marker.id_map[f"{PLAYBOOKS_NS}:acme-vpn"])
    assert vpn.runbook.migrated_from.id == "acme-vpn" and vpn.runbook.live is not None
    assert "runbook.migrated" in audit.actions()


def test_the_summary_row_counts_drafts_in_plain_words() -> None:
    from app.stores.runbook_library import RunbookMigrationCounts

    assert completion_summary(RunbookMigrationCounts(published=9, draft=1, skipped=0)) == (
        "runbook conversion finished: 9 published, 1 draft, 0 not converted"
    )
    assert completion_summary(RunbookMigrationCounts(published=8, draft=2, skipped=1)) == (
        "runbook conversion finished: 8 published, 2 drafts, 1 not converted"
    )


async def test_an_audit_outage_stores_nothing() -> None:
    kv = await _store_7_3()
    with pytest.raises(AuditUnavailableError):
        await _migrate(kv, _Audit(fail_on=1))
    library = RunbookLibraryStore(kv)
    assert await library.count() == 0 and await library.read_marker() is None


async def test_a_crash_during_the_projection_resumes_at_the_projection() -> None:
    kv = await _store_7_3()
    calls: list[str] = []

    async def _crashing(generation: str) -> bool:
        calls.append(generation)
        raise RuntimeError("projection interrupted")

    outcome, library, _ = await _migrate(kv, projector=_crashing)
    assert outcome.status == "done" and outcome.projection_completed is False
    marker = (await library.read_marker()).marker
    assert marker.completed_at == NOW and marker.projection_completed_at is None

    async def _unfinished(generation: str) -> bool:
        calls.append(generation)
        return False

    pending, _, _ = await _migrate(kv, projector=_unfinished)
    assert pending.status == "projection_pending"
    no_projector, _, _ = await _migrate(kv)
    assert no_projector.status == "projection_pending"

    async def _finishing(generation: str) -> bool:
        calls.append(generation)
        return True

    resumed, _, audit = await _migrate(kv, projector=_finishing)
    assert resumed.status == "projection_resumed" and resumed.projection_completed
    assert audit.rows == [] and await library.count() == 10
    assert calls == [marker.projection_generation] * 3
    assert (await library.read_marker()).marker.projection_completed_at == NOW


async def test_damaged_legacy_entries_are_audited_as_not_converted() -> None:
    kv = EsKVStore(InMemoryESClient())
    await _seed(kv, PLAYBOOKS_NS, {"good": _procedure("good")})
    doc = await kv.get(PLAYBOOKS_NS, PLAYBOOKS_KEY)
    doc["documents"]["broken"] = {"content": "   "}
    doc["documents"]["not-an-object"] = "text"
    await kv.put(PLAYBOOKS_NS, PLAYBOOKS_KEY, doc)
    outcome, library, audit = await _migrate(kv)
    assert (outcome.published, outcome.draft, outcome.skipped) == (1, 0, 2)
    failed = [r for r in audit.rows if r["action"] == ACTION_SKIPPED]
    assert {r["tool_input"]["source"]["id"] for r in failed} == {"broken", "not-an-object"}
    assert all(r["outcome"] == "failure" for r in failed)
    # A document never attempted is not a failed write: no unpaired write-failure row.
    assert "runbook.migrate_failed" not in audit.actions()
    assert (await library.read_marker()).marker.counts.skipped == 2


async def test_a_full_library_leaves_the_rest_in_the_legacy_store(monkeypatch) -> None:
    kv = await _store_7_3()
    monkeypatch.setattr(migration, "MAX_OPERATOR_RUNBOOKS", 4)
    outcome, library, audit = await _migrate(kv)
    assert outcome.migrated_now == 4 and outcome.skipped == 6
    assert await library.count() == 4
    assert audit.actions().count(ACTION_SKIPPED) == 6
    assert "runbook.migrate_failed" not in audit.actions()


async def test_an_empty_store_finishes_with_one_summary_row_and_no_notice() -> None:
    """A fresh install converts nothing, but the marker is a state change (the sources
    are never read again, the reprojection follows): one summary row with zero counts
    is appended before it, and no notice is shown."""
    kv = EsKVStore(InMemoryESClient())
    outcome, library, audit = await _migrate(kv)
    assert (outcome.status, outcome.published, outcome.draft, outcome.skipped) == ("done", 0, 0, 0)
    assert audit.actions() == ["runbook.migration_completed"]
    row = audit.rows[0]
    assert row["tool_input"]["counts"] == {"published": 0, "draft": 0, "skipped": 0}
    assert row["actor_type"] == "system" and row["outcome"] == "success"
    assert row["result_summary"] == "runbook conversion finished: 0 published, 0 drafts, 0 not converted"
    assert (await library.read_marker()).marker.completed_at == NOW
    assert await library.migration_notice() is None
    sources = (await library.read_marker()).marker.sources
    assert {s["namespace"]: s["status"] for s in sources} == {PLAYBOOKS_NS: "absent", RUNBOOKS_NS: "absent"}
    # An audit outage refuses the marker: the next start runs again.
    kv2 = EsKVStore(InMemoryESClient())
    with pytest.raises(AuditUnavailableError):
        await _migrate(kv2, _Audit(fail_on=1))
    assert await RunbookLibraryStore(kv2).read_marker() is None


# --------------------------------------------------------------------------- #
# The configured procedure directory.
# --------------------------------------------------------------------------- #
async def test_the_configured_directory_is_a_source(tmp_path: Path) -> None:
    """With a folder configured, only its files were read before Round 14: they keep
    their validated state (a file named like a retired bundled procedure or a
    built-in was LIVE, so it is renamed but stays Published), while every stored
    procedure document was never read and lands as a Draft that says so."""
    (tmp_path / "acme-dir.md").write_text(_procedure("acme-dir"), encoding="utf-8")
    (tmp_path / "named.md").write_text(_procedure("named-by-front-matter"), encoding="utf-8")
    (tmp_path / "brute_force_login.md").write_text(
        (FIXTURES / "brute_force_login.md").read_text(encoding="utf-8"), encoding="utf-8")
    (tmp_path / "builtin.md").write_text(_procedure("malware-endpoint"), encoding="utf-8")
    (tmp_path / "README.md").write_text("# Notes\n", encoding="utf-8")
    (tmp_path / "empty.md").write_text("   \n", encoding="utf-8")
    (tmp_path / "huge.md").write_text("x" * (migration.MAX_DIRECTORY_FILE_BYTES + 1), encoding="utf-8")
    (tmp_path / "ignored.txt").write_text("not markdown", encoding="utf-8")
    kv = EsKVStore(InMemoryESClient())
    await _seed(kv, PLAYBOOKS_NS, {
        "acme-dir": _procedure("acme-dir", title="Stored copy"),
        "inert_proc": _procedure("inert_proc"),
        "web_scanner_activity": _procedure("web_scanner_activity"),
    })
    await _seed(kv, RUNBOOKS_NS, {"acme-ref": _reference("acme-ref")})
    prefs = Preferences(playbooks=LegacyPlaybookConfig(dir=str(tmp_path)))
    outcome, library, audit = await _migrate(kv, prefs=prefs)
    # 4 folder files and the reference runbook published; 3 stored procedures drafts.
    assert (outcome.published, outcome.draft, outcome.skipped) == (5, 3, 2)
    marker = (await library.read_marker()).marker
    assert marker.id_map["playbook_dir:acme-dir"] == "acme-dir"
    assert marker.id_map["playbook_dir:named-by-front-matter"] == "named-by-front-matter"
    assert marker.id_map["playbooks:acme-dir"] == "acme-dir-imported"  # the directory wins
    assert migrated_procedure_ids(marker)["acme-dir"] == "acme-dir"

    async def _state(runbook_id: str) -> tuple[str, list[str]]:
        stored = (await library.require(runbook_id)).runbook
        return stored.versions[0].state, list(stored.versions[0].import_notes)

    state, notes = await _state(marker.id_map["playbook_dir:brute_force_login"])
    assert marker.id_map["playbook_dir:brute_force_login"] == "brute_force_login-imported"
    assert state == "published" and NOTE_BUNDLED_ID in notes and NOTE_SHADOWED not in notes
    state, notes = await _state(marker.id_map["playbook_dir:malware-endpoint"])
    assert state == "published" and NOTE_BUILTIN_ID in notes
    for legacy_id in ("acme-dir", "inert_proc", "web_scanner_activity"):
        state, notes = await _state(marker.id_map[f"playbooks:{legacy_id}"])
        assert state == "draft" and NOTE_FOLDER_INERT in notes, legacy_id
        assert NOTE_SHADOWED not in notes
    assert marker.id_map["playbooks:web_scanner_activity"] == "web_scanner_activity-imported"
    # The folder's file with a retired bundled id was the live procedure, so a rule
    # naming that id resolves to it; the stored copy was never read, so it is left out.
    migrated = migrated_procedure_ids(marker)
    assert migrated["brute_force_login"] == "brute_force_login-imported"
    assert "web_scanner_activity" not in migrated
    state, _ = await _state(marker.id_map["runbooks:acme-ref"])
    assert state == "published"  # reference runbooks never depended on the folder
    dir_info = next(s for s in marker.sources if s["namespace"] == "playbook_dir")
    assert dir_info["status"] == "read" and dir_info["documents"] == 4
    reasons = {r["tool_input"]["source"]["id"]: r["tool_input"]["reason"]
               for r in audit.rows if r["action"] == ACTION_SKIPPED}
    assert set(reasons) == {"empty", "huge"} and "256 KiB" in reasons["huge"]


async def test_the_packaged_directory_converts_nothing_and_a_missing_one_is_audited(tmp_path: Path) -> None:
    kv = EsKVStore(InMemoryESClient())
    packaged = Preferences(playbooks=LegacyPlaybookConfig(dir=str(packaged_procedure_dir())))
    outcome, library, audit = await _migrate(kv, prefs=packaged)
    assert outcome.published == 0 and outcome.skipped == 0
    assert all(s["namespace"] != "playbook_dir" for s in (await library.read_marker()).marker.sources)
    assert audit.actions() == ["runbook.migration_completed"]

    # A configured folder that is missing at this start (an unmounted volume) is
    # audited and counted, never silently passed over; the stored procedures were
    # still never read before the upgrade, so they land as Drafts.
    kv2 = EsKVStore(InMemoryESClient())
    await _seed(kv2, PLAYBOOKS_NS, {"inert_proc": _procedure("inert_proc")})
    missing = Preferences(playbooks=LegacyPlaybookConfig(dir=str(tmp_path / "gone")))
    outcome2, library2, audit2 = await _migrate(kv2, prefs=missing)
    assert (outcome2.published, outcome2.draft, outcome2.skipped) == (0, 1, 1)
    info = next(s for s in (await library2.read_marker()).marker.sources if s["namespace"] == "playbook_dir")
    assert info["status"] == "missing"
    failed = [r for r in audit2.rows if r["action"] == ACTION_SKIPPED]
    assert len(failed) == 1 and failed[0]["outcome"] == "failure"
    assert failed[0]["tool_input"]["source"] == {"namespace": "playbook_dir", "path": str(tmp_path / "gone")}
    assert failed[0]["result_summary"].startswith("could not read the procedure folder:")
    notice = await library2.migration_notice()
    assert notice is not None and notice.skipped == 1


# --------------------------------------------------------------------------- #
# The retired procedure modules are not needed.
# --------------------------------------------------------------------------- #
def test_the_migration_runs_with_the_retired_procedure_modules_absent() -> None:
    script = textwrap.dedent("""
        import asyncio, sys
        for name in ("app.playbooks", "app.stores.playbooks", "app.stores.runbooks",
                     "app.engine.runbooks", "app.engine.runbook_service"):
            sys.modules[name] = None  # any import of them now fails
        from app.engine.runbook_migration import run_runbook_migration
        from app.es.fake import InMemoryESClient
        from app.stores.legacy_procedures import LegacyProcedureReader
        from app.stores.memory import EsKVStore
        from app.stores.runbook_library import RunbookLibraryStore

        class Audit:
            async def record_strict(self, **row):
                return None

        async def main():
            kv = EsKVStore(InMemoryESClient())
            await kv.put("playbooks", "documents", {"documents": {"acme": {"content": CONTENT}}})
            outcome = await run_runbook_migration(
                library=RunbookLibraryStore(kv), legacy=LegacyProcedureReader(kv),
                audit=Audit(), prefs=None)
            print(outcome.status, outcome.published, outcome.draft)

        asyncio.run(main())
    """).replace("CONTENT", repr(_procedure("acme")))
    backend = Path(__file__).resolve().parent.parent
    env = dict(os.environ, PYTHONPATH=str(backend))
    result = subprocess.run([sys.executable, "-c", script], cwd=backend, env=env,
                            capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip().splitlines()[-1] == "done 1 0"


# --------------------------------------------------------------------------- #
# Startup (AppState).
# --------------------------------------------------------------------------- #
async def test_startup_runs_the_migration_once_with_the_real_control_audit() -> None:
    from app.config import Secrets
    from app.llm.providers import MockProvider
    from app.state import AppState

    es = InMemoryESClient()
    seed = EsKVStore(es)
    await _seed(seed, PLAYBOOKS_NS, {"acme-login": _procedure("acme-login")})
    mock = MockProvider()
    secrets = Secrets(_env_file=None, es_store_enabled=False, redis_url="",
                      anthropic_api_key=None, openai_api_key=None)
    state = AppState.create(secrets=secrets, es=es,
                            provider_overrides={"anthropic": mock, "openai": mock, "mock": mock})
    await state.startup(start_poller=False)
    try:
        record = await state.runbook_library.require("acme-login")
        assert record.runbook.live is not None
        marker = (await state.runbook_library.read_marker()).marker
        assert marker.counts.published == 1
        rows = await state.control_audit.records_for_actor("runbook_migration", limit=10)
        actions = sorted(r.get("action") for r in rows)
        assert actions == ["runbook.migrated", "runbook.migration_completed"]
        assert all(r.get("actor_type") == "system" for r in rows)
        again = await state.run_runbook_migration()
        assert again.status in ("already_done", "projection_pending", "projection_resumed")
        assert await state.runbook_library.count() == 1
    finally:
        await state.shutdown()


async def test_the_projection_can_run_after_the_conversion() -> None:
    """``project=False`` stops after the marker; :func:`resume_runbook_projection`
    then runs step 7 and records it (what startup does in the background)."""
    kv = EsKVStore(InMemoryESClient())
    await _seed(kv, PLAYBOOKS_NS, {"acme-login": _procedure("acme-login")})
    library = RunbookLibraryStore(kv)
    calls: list[str] = []

    async def _projector(generation: str) -> bool:
        calls.append(generation)
        return True

    outcome = await run_runbook_migration(
        library=library, legacy=LegacyProcedureReader(kv), audit=_Audit(), prefs=Preferences(),
        projector=_projector, now=lambda: NOW, project=False,
    )
    assert outcome.status == "done" and outcome.projection_completed is False and calls == []
    marker = (await library.read_marker()).marker
    assert marker.completed_at and marker.projection_completed_at is None
    assert await resume_runbook_projection(library=library, projector=_projector, now=lambda: NOW)
    assert calls == [marker.projection_generation]
    assert (await library.read_marker()).marker.projection_completed_at == NOW
    assert await resume_runbook_projection(library=library, projector=_projector) is True
    assert len(calls) == 1
    assert await resume_runbook_projection(library=RunbookLibraryStore(EsKVStore(InMemoryESClient())),
                                           projector=_projector) is False


async def test_startup_never_waits_for_the_rag_projection() -> None:
    """Startup converts inline and projects in the background: with a projection that
    blocks (an unreachable embedding provider), the API starts anyway, and the
    projection completes and is recorded when it can."""
    import asyncio

    from app.config import Secrets
    from app.llm.providers import MockProvider
    from app.state import AppState

    es = InMemoryESClient()
    await _seed(EsKVStore(es), PLAYBOOKS_NS, {"acme-login": _procedure("acme-login")})
    mock = MockProvider()
    secrets = Secrets(_env_file=None, es_store_enabled=False, redis_url="",
                      anthropic_api_key=None, openai_api_key=None)
    state = AppState.create(secrets=secrets, es=es,
                            provider_overrides={"anthropic": mock, "openai": mock, "mock": mock})
    release = asyncio.Event()
    started = asyncio.Event()

    async def _slow_projector(generation: str) -> bool:
        started.set()
        await release.wait()
        return True

    state._project_runbook_corpus = _slow_projector  # type: ignore[method-assign]
    await asyncio.wait_for(state.startup(start_poller=False), timeout=60)
    try:
        assert (await state.runbook_library.require("acme-login")).runbook.live is not None
        await asyncio.wait_for(started.wait(), timeout=10)
        assert (await state.runbook_library.read_marker()).marker.projection_completed_at is None
        release.set()
        assert await asyncio.wait_for(state._runbook_projection_task, timeout=10) is True
        assert (await state.runbook_library.read_marker()).marker.projection_completed_at
    finally:
        release.set()
        await state.shutdown()


async def test_a_pending_projection_is_cancelled_at_shutdown_and_resumed_next_start() -> None:
    import asyncio

    from app.config import Secrets
    from app.llm.providers import MockProvider
    from app.state import AppState

    es = InMemoryESClient()
    mock = MockProvider()
    secrets = Secrets(_env_file=None, es_store_enabled=False, redis_url="",
                      anthropic_api_key=None, openai_api_key=None)
    overrides = {"anthropic": mock, "openai": mock, "mock": mock}
    first = AppState.create(secrets=secrets, es=es, provider_overrides=overrides)
    never = asyncio.Event()

    async def _stuck(generation: str) -> bool:
        await never.wait()
        return True

    first._project_runbook_corpus = _stuck  # type: ignore[method-assign]
    await first.startup(start_poller=False)
    task = first._runbook_projection_task
    await first.shutdown()
    assert task.cancelled() or task.done()
    second = AppState.create(secrets=secrets, es=es, provider_overrides=overrides)

    async def _quick(generation: str) -> bool:
        return True

    second._project_runbook_corpus = _quick  # type: ignore[method-assign]
    await second.startup(start_poller=False)
    try:
        assert await asyncio.wait_for(second._runbook_projection_task, timeout=10) is True
        marker = (await second.runbook_library.read_marker()).marker
        assert marker.projection_completed_at
        rows = await second.control_audit.records_for_actor("runbook_migration", limit=10)
        assert [r.get("action") for r in rows] == ["runbook.migration_completed"]  # converted once
    finally:
        await second.shutdown()


# --------------------------------------------------------------------------- #
# The retired settings keys (SPEC §4.10.19), mapped once by meaning.
# --------------------------------------------------------------------------- #
def _load(stored: dict[str, Any]) -> Preferences:
    return Preferences.model_validate(stored)


@pytest.mark.parametrize(
    ("stored", "guidance", "corpus"),
    [
        ({"setup_complete": True}, True, True),
        ({"playbooks": {"enabled": False}}, False, True),
        ({"playbooks": {"enabled": True, "llm_select": True}}, True, True),
        ({"runbooks": {"enabled": False}}, True, False),
        ({"rag": {"use_runbooks": False}}, True, False),
        ({"playbooks": {"enabled": "false"}, "runbooks": {"enabled": "no"}}, False, False),
        ({"playbooks": {"enabled": False}, "rag": {"use_runbooks": False}}, False, False),
    ],
)
def test_retired_keys_map_by_meaning_and_never_switch_the_feature_off(
    stored: dict[str, Any], guidance: bool, corpus: bool,
) -> None:
    prefs = _load(stored)
    assert prefs.runbooks.enabled is True
    assert prefs.runbooks.investigator_guidance is guidance
    assert prefs.runbooks.rag_corpus is corpus
    assert prefs.runbooks.runbooks_config_version == 1
    # The retired keys mirror their successors.
    assert prefs.playbooks.enabled is guidance and prefs.rag.use_runbooks is corpus


def test_a_stamped_block_is_never_re_decided() -> None:
    prefs = _load({
        "runbooks": {"runbooks_config_version": 1, "investigator_guidance": True, "rag_corpus": True},
        "playbooks": {"enabled": False}, "rag": {"use_runbooks": False},
    })
    assert prefs.runbooks.investigator_guidance is True and prefs.runbooks.rag_corpus is True
    assert prefs.playbooks.enabled is True and prefs.rag.use_runbooks is True
    # Round trip: the mapping ran once, the dump is stamped and stable.
    dumped = prefs.model_dump(mode="json")
    assert Preferences.model_validate(dumped).model_dump(mode="json") == dumped
    off = prefs.model_copy(update={"runbooks": prefs.runbooks.model_copy(update={"rag_corpus": False})})
    reloaded = Preferences.model_validate(off.model_dump(mode="json"))
    assert reloaded.runbooks.rag_corpus is False and reloaded.rag.use_runbooks is False


@pytest.mark.parametrize(
    "block",
    [
        {"enabled": False, "auto_attach": False},
        {"enabled": False, "rag_corpus": True},
        {"enabled": False, "review_every_days_default": 90},
    ],
)
def test_an_unstamped_block_in_the_new_vocabulary_is_never_remapped(block: dict[str, Any]) -> None:
    """A block code, an import or Demo built with the new keys but no stamp keeps the
    new meaning of ``enabled`` (the feature off), and is stamped, not remapped."""
    prefs = _load({"runbooks": dict(block)})
    assert prefs.runbooks.enabled is False
    assert prefs.runbooks.rag_corpus is True
    assert prefs.runbooks.runbooks_config_version == 1
    # A block holding only ``enabled`` is the old shape, so the old meaning applies.
    old = _load({"runbooks": {"enabled": False}})
    assert old.runbooks.enabled is True and old.runbooks.rag_corpus is False


def test_a_changed_retired_key_in_a_settings_write_carries_onto_its_successor() -> None:
    """The retired keys are read-only mirrors, so a settings route maps a write that
    changed one of them onto its successor before merging (SPEC §4.10.19)."""
    current = Preferences()
    body = {"rag": {"use_runbooks": False, "top_k": 3}, "playbooks": {"enabled": "off"}}
    mapped = map_retired_runbook_writes(body, current)
    assert mapped["runbooks"] == {"rag_corpus": False, "investigator_guidance": False}
    assert body == {"rag": {"use_runbooks": False, "top_k": 3}, "playbooks": {"enabled": "off"}}
    merged = current.model_dump(mode="json")
    for section, value in mapped.items():
        merged[section] = {**merged[section], **value}
    saved = Preferences.model_validate(merged)
    assert saved.runbooks.rag_corpus is False and saved.rag.use_runbooks is False
    assert saved.runbooks.investigator_guidance is False and saved.playbooks.enabled is False
    assert saved.runbooks.enabled is True
    # A body that only echoes the stored mirror (a whole section resent) maps nothing.
    assert "runbooks" not in map_retired_runbook_writes({"rag": {"use_runbooks": True}}, current)
    # The successor named in the same body wins.
    both = map_retired_runbook_writes(
        {"rag": {"use_runbooks": False}, "runbooks": {"rag_corpus": True}}, current,
    )
    assert both["runbooks"] == {"rag_corpus": True}
    # Without the stored settings every named retired key is carried.
    assert map_retired_runbook_writes({"rag": {"use_runbooks": True}})["runbooks"] == {"rag_corpus": True}
    assert map_retired_runbook_writes({"rag": {"use_runbooks": "maybe"}}, current) == {
        "rag": {"use_runbooks": "maybe"},
    }


def test_the_runbook_block_is_repaired_never_rejected() -> None:
    prefs = _load({"runbooks": {"runbooks_config_version": 1, "auto_attach": "maybe",
                                "review_every_days_default": 5000, "step_approvals": "yes"}})
    assert prefs.runbooks.auto_attach is True and prefs.runbooks.step_approvals is True
    assert prefs.runbooks.review_every_days_default == 730
    low = RunbookConfig.model_validate({"review_every_days_default": 1, "runbooks_config_version": "x"})
    assert low.review_every_days_default == 30 and low.runbooks_config_version == 0
    defaults = RunbookConfig()
    assert (defaults.enabled, defaults.auto_attach, defaults.fallback, defaults.investigator_guidance,
            defaults.rag_corpus, defaults.ai_suggest, defaults.ai_step_drafts) == (True,) * 7
    assert defaults.require_distinct_approver is False and defaults.step_approvals is False
    assert defaults.review_every_days_default == 180


def test_the_retired_procedure_section_keeps_its_directory_for_the_migration() -> None:
    prefs = _load({"playbooks": {"enabled": True, "dir": "/srv/procedures", "llm_select": True}})
    assert prefs.playbooks.dir == "/srv/procedures"
    assert "llm_select" not in prefs.model_dump()["playbooks"]
