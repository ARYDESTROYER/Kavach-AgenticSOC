"""The runbook model (Round 14 SPEC §4.10.2, §4.10.9, §4.10.13, WP-A3).

Pins ``validate_runbook`` (every limit, the closed template set, cross-references and
the prompt budget), the investigator rendering, the canonical form and its hash, the
Markdown format (parse, export, parse gives an equal definition) and the compatible
front-matter parser, and that the three runbook modules stay pure.
"""

from __future__ import annotations

import ast
import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

from app.engine import runbook_model as RM
from app.models import (
    AppliesWhen,
    DecisionOption,
    LookupTemplate,
    RunbookDefinition,
    RunbookIssue,
    RunbookStep,
    RunbookVersionDoc,
)

BACKEND = Path(__file__).resolve().parents[1]

SPEC_EXAMPLE = """---
id: brute-force-password-spray
title: Brute force and password spray
summary: Many failed sign-ins against one or more accounts, from one or many sources.
use_when: A detection reports repeated failed authentication against our accounts.
version: 4
priority: 60
owner: soc-leads
review_every_days: 180
mitre: [T1110, T1110.003]
applies_when:
  rule_ids: [ssh_auth_failed, win_logon_failure_burst]
  mitre: [T1110]
  entity_types: [ip, user]
references:
  - https://attack.mitre.org/techniques/T1110/
---

## Triage

### Is the source internal or external? {#source-scope kind=check}
Focus: source IP, its network zone and the asset inventory.
Escalate if: the source is an internal host that is not an approved scanner.
Benign if: the source is an approved vulnerability scanner or a known test.

Look the source up in the asset inventory before anything else.

### How many accounts were tried? {#accounts-tried kind=lookup}
```lookup
tool: log_stats
filter:
  source.ip: "{{entity.ip}}"
  event.outcome: failure
group_by: [user.name]
window: case_first_seen-1h..case_last_seen+1h
limit: 20
run: on_attach
```

## Investigate

### Is this a confirmed compromise? {#decide kind=decision}
Options:
- confirmed: Confirmed compromise
- suspicious: Suspicious, unconfirmed
- benign: Benign | skips: block-source, reset-credentials

## Contain

### Block the source at the edge {#block-source kind=action optional react=RA3101 d3fend=D3-NI}
Record where you blocked it (firewall, WAF or ticket number).

### Reset the credentials {#reset-credentials kind=action}
Reset the password of every affected account.
"""


def _step(**kw) -> RunbookStep:
    base = {"id": "s1", "phase": "triage", "kind": "check", "title": "Is it real?"}
    base.update(kw)
    return RunbookStep(**base)


def _defn(**kw) -> RunbookDefinition:
    base = {
        "id": "my-runbook",
        "title": "My runbook",
        "summary": "A short summary.",
        "applies_when": AppliesWhen(rule_ids=["r1"]),
        "phases": ["triage"],
        "steps": [_step()],
    }
    base.update(kw)
    return RunbookDefinition(**base)


def _codes(issues) -> list[str]:
    return [i.code for i in issues]


def _paths(issues) -> list[str]:
    return [i.path for i in issues]


# --------------------------------------------------------------------------- #
# Validation: identity and header
# --------------------------------------------------------------------------- #
def test_a_minimal_runbook_is_valid() -> None:
    assert RM.validate_runbook(_defn()) == []
    assert RM.blocking_error_code([]) is None


def test_every_reserved_id_is_refused() -> None:
    from app.models import RUNBOOK_RESERVED_IDS
    assert {"new", "metrics", "validate", "import", "progress", "match-preview", "lookup-test", "reindex",
            "readme", "index"} == set(RUNBOOK_RESERVED_IDS)
    for rid in RUNBOOK_RESERVED_IDS:
        issues = RM.validate_runbook(_defn(id=rid))
        assert _codes(issues) == ["reserved"], rid
        assert RM.blocking_error_code(issues) == "runbook_id_reserved"
        assert not RM.valid_runbook_id(rid) and not RM.valid_runbook_id(rid, "builtin")
        assert RM.is_reserved_id(rid)


def test_id_grammar_by_origin() -> None:
    # The legacy operator grammar keeps migrated ids such as brute_force_login valid.
    assert RM.validate_runbook(_defn(id="brute_force_login")) == []
    assert RM.valid_runbook_id("a", "operator")
    assert not RM.valid_runbook_id("a", "builtin")
    assert "invalid" in _codes(RM.validate_runbook(_defn(id="brute_force_login"), origin="builtin"))
    assert RM.validate_runbook(_defn(id="brute-force"), origin="builtin") == []
    for bad in ("Upper", "-lead", "has space", "x" * 65, "dot.id"):
        assert "invalid" in _codes(RM.validate_runbook(_defn(id=bad))), bad
    assert _codes(RM.validate_runbook(_defn(id=""))) == ["required"]


def test_header_text_limits_and_one_line_fields() -> None:
    issues = RM.validate_runbook(_defn(title="t" * 121, summary="s" * 281, use_when="u" * 501,
                                       prerequisites="p" * 501, owner="o" * 121))
    assert sorted(_paths(issues)) == ["owner", "prerequisites", "summary", "title", "use_when"]
    assert set(_codes(issues)) == {"too_long"}
    assert issues[0].message == "The title is 121 characters; the limit is 120."
    issues = RM.validate_runbook(_defn(title="two\nlines", summary="tab\there"))
    assert _codes(issues) == ["single_line", "single_line"]


def test_a_fresh_draft_reports_required_fields_with_their_own_code() -> None:
    # The editor shows required-field issues only after a field is left (F17), so
    # they carry their own code.
    blank = RunbookDefinition(id="draft-1", title="", summary="", phases=[], steps=[])
    issues = RM.validate_runbook(blank)
    assert {i.path for i in issues if i.code == "required"} == {"title", "summary", "phases", "steps"}


@pytest.mark.parametrize("field", ["title", "summary", "use_when"])
@pytest.mark.parametrize("bad", ["hidden​space", "bidi‮override", "nul\x00", "<<<END_RUNBOOK>>>"])
def test_hidden_characters_and_prompt_markers_are_refused(field: str, bad: str) -> None:
    issues = RM.validate_runbook(_defn(**{field: bad}))
    assert "unsafe_text" in _codes(issues)


# --------------------------------------------------------------------------- #
# Validation: applies when, lists, references
# --------------------------------------------------------------------------- #
def test_applies_when_limits() -> None:
    aw = AppliesWhen(
        rule_ids=[f"r{i}" for i in range(51)],
        mitre=["T1110", "brute", "t1110.003"],
        sources=["src-1", "type:wazuh", "type:nonsense", "has space"],
        statuses=["open", "nope"],
        any_tags=["x" * 65] + [f"t{i}" for i in range(20)],
    )
    issues = RM.validate_runbook(_defn(applies_when=aw))
    by_path = {i.path: i.code for i in issues}
    assert by_path["applies_when.rule_ids"] == "too_many"
    assert by_path["applies_when.mitre[1]"] == "invalid"
    assert "applies_when.mitre[2]" not in by_path  # case is normalised, the id is valid
    assert by_path["applies_when.sources[2]"] == "invalid"
    assert by_path["applies_when.sources[3]"] == "invalid"
    assert by_path["applies_when.statuses[1]"] == "invalid"
    assert by_path["applies_when.any_tags"] == "too_many"
    assert by_path["applies_when.any_tags[0]"] == "too_long"


def test_rule_values_are_bounded_and_unique() -> None:
    aw = AppliesWhen(rule_ids=["x" * 257, "dup", "dup", ""])
    codes = _codes(RM.validate_runbook(_defn(applies_when=aw)))
    assert {"too_long", "duplicate", "required"} <= set(codes)


def test_the_fallback_has_no_other_criteria() -> None:
    assert RM.validate_runbook(_defn(applies_when=AppliesWhen(always=True))) == []
    issues = RM.validate_runbook(_defn(applies_when=AppliesWhen(always=True, rule_ids=["r1"], min_event_count=3)))
    assert _paths(issues) == ["applies_when.always"]
    assert issues[0].message.endswith("Remove rules and minimum events, or turn off always.")


def test_a_runbook_with_no_criteria_is_valid_and_attached_only_by_hand() -> None:
    assert RM.validate_runbook(_defn(applies_when=AppliesWhen())) == []


def test_references_are_https_only() -> None:
    ok = _defn(references=["https://attack.mitre.org/techniques/T1110/"])
    assert RM.validate_runbook(ok) == []
    for bad in ("http://example.com", "javascript:alert(1)", "data:text/html,x", "/relative", "ftp://x"):
        assert "invalid" in _codes(RM.validate_runbook(_defn(references=[bad]))), bad
    assert "too_many" in _codes(RM.validate_runbook(_defn(references=[f"https://e.com/{i}" for i in range(11)])))


def test_retrieval_queries_and_techniques_are_bounded() -> None:
    issues = RM.validate_runbook(_defn(retrieval_queries=["q"] * 4 + ["q" * 201, "z"], mitre=["T1110", "x"]))
    assert {"too_many", "too_long", "duplicate", "invalid"} <= set(_codes(issues))


# --------------------------------------------------------------------------- #
# Validation: phases and steps
# --------------------------------------------------------------------------- #
def test_phases_are_ordered_unique_and_used() -> None:
    steps = [_step(id="a", phase="contain"), _step(id="b", phase="triage")]
    issues = RM.validate_runbook(_defn(phases=["contain", "triage", "recover"], steps=steps))
    codes = _codes(issues)
    assert "order" in codes  # contain before triage, and steps out of phase order
    assert "unused" in codes  # recover has no step
    issues = RM.validate_runbook(_defn(phases=["triage", "triage"]))
    assert "duplicate" in _codes(issues)


def test_a_step_in_an_unlisted_phase_is_a_reference_problem() -> None:
    issues = RM.validate_runbook(_defn(steps=[_step(phase="contain")]))
    assert "reference" in _codes(issues)


def test_step_count_and_ids() -> None:
    many = [_step(id=f"s{i}") for i in range(41)]
    assert "too_many" in _codes(RM.validate_runbook(_defn(steps=many)))
    dup = [_step(id="same"), _step(id="same")]
    assert "duplicate" in _codes(RM.validate_runbook(_defn(steps=dup)))
    assert "invalid" in _codes(RM.validate_runbook(_defn(steps=[_step(id="Bad Id")])))
    assert "required" in _codes(RM.validate_runbook(_defn(steps=[_step(id="")])))


def test_step_text_limits() -> None:
    step = _step(title="t" * 161, instructions="i" * 2001, focus="f" * 301, escalate_if="e" * 301,
                 benign_if="b\nb")
    issues = RM.validate_runbook(_defn(steps=[step]))
    by_path = {i.path: i for i in issues}
    assert by_path["steps[0].title"].code == "too_long"
    assert by_path["steps[0].instructions"].message.startswith("The instructions of step")
    assert " are 2,001 characters; the limit is 2,000." in by_path["steps[0].instructions"].message
    assert by_path["steps[0].focus"].code == "too_long"
    assert by_path["steps[0].escalate_if"].code == "too_long"
    assert by_path["steps[0].benign_if"].code == "single_line"


@pytest.mark.parametrize(("text", "fragment"), [
    ("## Heading", "heading"),
    ("Text\n---", "heading"),
    ("```\ncode\n```", "code block"),
    ("<script>alert(1)</script>", "HTML"),
    ("![img](https://e.com/x.png)", "image"),
    ("[link](http://e.com)", "https link"),
    ("[link](javascript:alert(1))", "https link"),
    ("<http://e.com>", "https link"),
    ("[ref]: http://e.com", "https link"),
    # CommonMark forms a link-text pattern can be walked around with: the destination
    # is what is checked (review of WP-A3).
    ("[click](\njavascript:alert(1))", "https link"),
    ("[a [b] c](javascript:alert(1))", "https link"),
    ("[multi\nline](javascript:alert(1))", "https link"),
    ("[x][r]\n\n[r]:\njavascript:alert(1)", "https link"),
    ("![a [b]](https://x.example/i.png)", "image"),
    ("[x][long label]\n\n[long\nlabel]: javascript:alert(1)", "https link"),
    ("> [r]: javascript:alert(1)", "https link"),
    ("- [r]: javascript:alert(1)", "https link"),
    ("[a\\]b]: javascript:alert(1)", "https link"),
    ("[x](<javascript:alert(1)>)", "https link"),
    ("[x](<javascript:alert(1)", "https link"),
    ("[x]()", "https link"),
    ("[x](https://example.com/" + "a" * 600 + ")", "https link"),
    ("<script\nalert(1)", "HTML"),
    ("<?php echo 1; ?>", "HTML"),
    ("<!DOCTYPE html", "HTML"),
    ("> # Heading in a quote", "heading"),
    ("- ```\n- code\n- ```", "code block"),
])
def test_instructions_are_restricted_markdown(text: str, fragment: str) -> None:
    issues = RM.validate_runbook(_defn(steps=[_step(instructions=text)]))
    markdown = [i for i in issues if i.code == "markdown"]
    assert markdown and fragment in markdown[0].message


def test_allowed_markdown_passes() -> None:
    text = ("Check **who** owns it and _why_.\n\n- one\n- two\n\n1. first\n\nUse `grep` and "
            "[the guide](https://example.com/guide) or <https://example.com>.\n\n---\n\nAfter a break, a < b.")
    assert RM.markdown_problems(text) == []
    assert RM.validate_runbook(_defn(steps=[_step(instructions=text)])) == []
    more = ("A [nested (link)](https://x.example/(y)) and [a guide](\nhttps://example.com/g).\n\n"
            "See [RFC 1918] ranges: private.\n\n- [guide](https://example.com/list)\n\n"
            "Mail <soc@example.com> when a<b, then see [the doc][r].\n\n[r]: https://example.com/doc")
    assert RM.markdown_problems(more) == []


def test_escalate_and_benign_only_on_checks_and_decisions() -> None:
    action = _step(kind="action", escalate_if="x", benign_if="y")
    issues = RM.validate_runbook(_defn(steps=[action]))
    assert _codes(issues) == ["not_allowed", "not_allowed"]
    assert "only Check and Decision steps" in issues[0].message


def test_approval_role_only_on_actions_and_records() -> None:
    assert "not_allowed" in _codes(RM.validate_runbook(_defn(steps=[_step(approval_role="soc_manager")])))
    for kind in ("action", "record"):
        assert RM.validate_runbook(_defn(steps=[_step(kind=kind, approval_role="soc_manager")])) == []
    assert "invalid" in _codes(RM.validate_runbook(_defn(steps=[_step(kind="action", approval_role="a{b}")])))


def test_react_and_d3fend_grammar() -> None:
    assert RM.validate_runbook(_defn(steps=[_step(kind="action", react="RA3101", d3fend="D3-NI")])) == []
    issues = RM.validate_runbook(_defn(steps=[_step(kind="action", react="3101", d3fend="NI")]))
    assert _paths(issues) == ["steps[0].react", "steps[0].d3fend"]
    # The whole raw value must fit: a line break or a space around the id is refused.
    for react, d3fend in (("RA3101\n", "D3-NI\n"), (" RA3101", "D3-NI ")):
        issues = RM.validate_runbook(_defn(steps=[_step(kind="action", react=react, d3fend=d3fend)]))
        assert _paths(issues) == ["steps[0].react", "steps[0].d3fend"], (react, d3fend)


# --------------------------------------------------------------------------- #
# A trailing line break never slips past an id or field-name grammar
# (Python's ``$`` also matches just before a final newline)
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(("rid", "origin"), [
    ("new\n", "operator"), ("metrics\n", "imported"), ("brute-force-password-spray\n", "operator"),
    ("brute-force-password-spray\n", "imported"), ("my-runbook\n", "operator"), ("my-runbook\n", "builtin"),
])
def test_an_id_with_a_trailing_line_break_is_refused(rid: str, origin: str) -> None:
    issues = RM.validate_runbook(_defn(id=rid), origin=origin)
    assert [(i.path, i.code) for i in issues] == [("id", "invalid")], rid
    assert RM.blocking_error_code(issues) == "runbook_invalid"
    assert not RM.valid_runbook_id(rid, origin)
    assert "\n" not in issues[0].message


def test_step_and_option_ids_with_a_trailing_line_break_are_refused() -> None:
    issues = RM.validate_runbook(_defn(steps=[_step(id="a\n")]))
    assert [(i.path, i.code) for i in issues] == [("steps[0].id", "invalid")]
    decision = _step(id="d", kind="decision", options=[DecisionOption(id="x\n", label="X"),
                                                         DecisionOption(id="y", label="Y")])
    issues = RM.validate_runbook(_defn(steps=[decision]))
    assert [(i.path, i.code) for i in issues] == [("steps[0].options[0].id", "invalid")]


def test_lookup_field_names_with_a_trailing_line_break_are_refused() -> None:
    lookup = LookupTemplate(tool="log_stats", filter={"source.ip\n": "{{entity.ip}}"}, group_by=["user.name\n"])
    issues = RM.validate_runbook(_defn(steps=[_step(kind="lookup", lookup=lookup)]))
    assert [(i.path, i.code) for i in issues] == [
        ("steps[0].lookup.filter.source.ip\n", "invalid"), ("steps[0].lookup.group_by[0]", "invalid")]


def test_lookup_steps_need_a_lookup_and_others_have_none() -> None:
    assert "required" in _codes(RM.validate_runbook(_defn(steps=[_step(kind="lookup")])))
    lookup = LookupTemplate(tool="enrich", indicator="{{entity.ip}}")
    issues = RM.validate_runbook(_defn(steps=[_step(kind="action", lookup=lookup)]))
    assert _codes(issues) == ["not_allowed"]
    assert RM.validate_runbook(_defn(steps=[_step(kind="lookup", lookup=lookup)])) == []


def test_lookup_issues_carry_the_step_path_and_the_spec_sentence() -> None:
    lookup = LookupTemplate(tool="log_stats", filter={"source.ip": "{{entity.ipaddr}}"})
    step = _step(kind="lookup", title="How many accounts were tried?", lookup=lookup)
    issues = RM.validate_runbook(_defn(steps=[step]))
    assert [(i.path, i.code) for i in issues] == [("steps[0].lookup.filter.source.ip", "template_value")]
    assert issues[0].message == ("Step 'How many accounts were tried?' uses {{entity.ipaddr}}, which is not a "
                                 "case value. Use {{entity.ip}}.")


@pytest.mark.parametrize(("field", "noun", "plural"), [
    ("rule_ids", "rule", "Rules"), ("any_tags", "tag", "Tags"),
])
@pytest.mark.parametrize("token", ["{{entity.ipaddr}}", "{{case.rule}}"])
def test_a_case_value_in_an_applies_when_list_is_refused(field: str, noun: str, plural: str, token: str) -> None:
    criteria = {"rule_ids": ["r1"], field: [f"{token} x"]} if field != "rule_ids" else {"rule_ids": ["r1", f"{token} x"]}
    issues = RM.validate_runbook(_defn(applies_when=AppliesWhen(**criteria)))
    index = 1 if field == "rule_ids" else 0
    assert [(i.path, i.code) for i in issues] == [(f"applies_when.{field}[{index}]", "template_value")]
    assert issues[0].message == (f"Applies when uses {token} in a {noun}. {plural} are used as written, so a case "
                                 f"value is never filled in. Write the value itself.")


@pytest.mark.parametrize(("field", "value", "noun", "plural"), [
    ("retrieval_queries", "{{entity.ipaddr}} brute", "retrieval query", "Retrieval queries"),
    ("retrieval_queries", "{{entity.ip}} brute", "retrieval query", "Retrieval queries"),
    ("references", "https://example.com/{{entity.nope}}", "reference", "References"),
])
def test_a_case_value_in_a_runbook_list_is_refused(field: str, value: str, noun: str, plural: str) -> None:
    issues = RM.validate_runbook(_defn(**{field: [value]}))
    assert [(i.path, i.code) for i in issues] == [(f"{field}[0]", "template_value")]
    token = re.search(r"\{\{[^{}]*\}\}", value).group(0)
    assert issues[0].message == (f"The runbook uses {token} in a {noun}. {plural} are used as written, so a case "
                                 f"value is never filled in. Write the value itself.")


def test_lists_without_case_values_are_unchanged() -> None:
    defn = _defn(applies_when=AppliesWhen(rule_ids=["r1", "brace { x }"], any_tags=["{ not a value"]),
                 retrieval_queries=["brute force {single}"], references=["https://example.com/a"])
    assert RM.validate_runbook(defn) == []


def test_unknown_template_values_anywhere_are_reported() -> None:
    issues = RM.validate_runbook(_defn(steps=[_step(focus="Look at {{entity.ipaddr}}")]))
    assert _codes(issues) == ["template_value"]
    assert RM.validate_runbook(_defn(steps=[_step(focus="Look at {{entity.ip}}")])) == []


def _decision(options, **kw) -> RunbookStep:
    return _step(id="decide", kind="decision", title="Real?", options=options, **kw)


def test_decision_options() -> None:
    later = _step(id="later", kind="action", title="Act")
    good = [DecisionOption(id="yes", label="Yes"), DecisionOption(id="no", label="No", marks_not_applicable=["later"])]
    assert RM.validate_runbook(_defn(steps=[_decision(good), later])) == []
    assert "too_few" in _codes(RM.validate_runbook(_defn(steps=[_decision(good[:1])])))
    seven = [DecisionOption(id=f"o{i}", label=f"O{i}") for i in range(7)]
    assert "too_many" in _codes(RM.validate_runbook(_defn(steps=[_decision(seven)])))
    dup = [DecisionOption(id="a", label="A"), DecisionOption(id="a", label="B")]
    assert "duplicate" in _codes(RM.validate_runbook(_defn(steps=[_decision(dup)])))
    long_label = [DecisionOption(id="a", label="x" * 81), DecisionOption(id="b", label="a | b")]
    codes = _codes(RM.validate_runbook(_defn(steps=[_decision(long_label)])))
    assert "too_long" in codes and "invalid" in codes
    assert "not_allowed" in _codes(RM.validate_runbook(_defn(steps=[_step(options=good)])))


def test_an_option_skips_only_later_steps() -> None:
    earlier = _step(id="earlier", title="First")
    later = _step(id="later", title="Later")

    def opts(target: str) -> list[DecisionOption]:
        return [DecisionOption(id="a", label="A"), DecisionOption(id="b", label="B", marks_not_applicable=[target])]

    for target in ("earlier", "decide", "missing"):
        issues = RM.validate_runbook(_defn(steps=[earlier, _decision(opts(target)), later]))
        assert _codes(issues) == ["reference"], target
    assert RM.validate_runbook(_defn(steps=[earlier, _decision(opts("later")), later])) == []


# --------------------------------------------------------------------------- #
# The prompt budget and the investigator rendering
# --------------------------------------------------------------------------- #
def _defn_with_focus_chars(n_steps: int, focus_len: int) -> RunbookDefinition:
    steps = [_step(id=f"s{i}", title=f"Question {i}?", focus="f" * focus_len) for i in range(n_steps)]
    return _defn(steps=steps)


def test_over_budget_is_refused_with_the_measured_length_and_never_truncated() -> None:
    defn = _defn_with_focus_chars(12, 290)
    rendered = RM.render_runbook_prompt(defn, 1)
    assert len(rendered) > RM.MAX_RUNBOOK_PROMPT_CHARS
    assert rendered.count("f" * 290) == 12  # nothing was cut
    issues = RM.validate_runbook(defn)
    assert _codes(issues) == ["prompt_budget"]
    measured = RM.prompt_chars(defn)
    assert f"{measured:,} characters; the limit is 3,000" in issues[0].message
    assert RM.blocking_error_code(issues) == "runbook_prompt_budget"
    assert RM.validate_runbook(defn, check_prompt_budget=False) == []


def test_the_budget_constant_is_three_thousand() -> None:
    assert RM.MAX_RUNBOOK_PROMPT_CHARS == 3_000


def test_prompt_chars_assumes_the_widest_version_label_for_a_draft() -> None:
    defn = _defn()
    assert RM.prompt_chars(defn) == len(RM.render_runbook_prompt(defn, RM.MAX_RUNBOOK_VERSIONS))
    assert RM.prompt_chars(defn, 4) == len(RM.render_runbook_prompt(defn, 4))


def test_prompt_chars_measures_the_normalised_form() -> None:
    # Spaces an author typed around a line are not stored, so they never count
    # against the budget, and the rendering never carries them either.
    padded = _defn(steps=[_step(focus=" " * 250 + "Look at the source." + " " * 30)])
    assert RM.prompt_chars(padded) == RM.prompt_chars(RM.normalise_definition(padded))
    assert RM.prompt_chars(padded) == len(RM.render_runbook_prompt(padded, RM.MAX_RUNBOOK_VERSIONS))
    assert "  Focus: Look at the source.\n" in RM.render_runbook_prompt(padded, 1) + "\n"


@pytest.mark.parametrize("version", [1, 2, 37, RM.MAX_RUNBOOK_VERSIONS])
def test_the_prompt_is_exactly_the_text_the_budget_measured(version: int) -> None:
    # Per-field limits are checked on the raw length, so whitespace up to each limit
    # passes validation and counts as nothing in the budget. Rendering the raw text
    # would then put up to ~5,000 characters into the trusted runbook block against
    # a measured 1,800; the prompt renders the normalised form instead.
    base = RM.builtin_runbook("brute-force-password-spray").definition
    steps = [s.model_copy(update={"title": s.title.ljust(RM.RUNBOOK_STEP_MAX_TITLE_CHARS),
                                  "focus": (s.focus or "Look closely.").ljust(RM.RUNBOOK_STEP_MAX_GUIDANCE_CHARS)})
             for s in base.steps]
    padded = base.model_copy(update={"id": "bf-copy", "steps": steps})
    assert RM.validate_runbook(padded, version=version) == []
    rendered = RM.render_runbook_prompt(padded, version)
    assert len(rendered) == RM.prompt_chars(padded, version) <= RM.MAX_RUNBOOK_PROMPT_CHARS
    assert rendered == RM.render_runbook_prompt(RM.normalise_definition(padded), version)
    doc = RunbookVersionDoc(version=version, state="published", definition=padded)
    assert RM.render_runbook_prompt(doc) == rendered
    # A stored (normalised) definition and a built-in render as they did.
    built_in = RM.builtin_runbook("brute-force-password-spray")
    assert RM.render_runbook_prompt(built_in.definition, built_in.version) == RM.render_runbook_prompt(
        RM.normalise_definition(built_in.definition), built_in.version)


def test_render_runbook_prompt_shape() -> None:
    parsed = RM.parse_runbook_markdown(SPEC_EXAMPLE)
    assert parsed.definition is not None
    text = RM.render_runbook_prompt(parsed.definition, 4)
    assert text.splitlines() == [
        "Brute force and password spray (v4)",
        "Many failed sign-ins against one or more accounts, from one or many sources.",
        "Use when: A detection reports repeated failed authentication against our accounts.",
        "Triage:",
        "- Check: Is the source internal or external?",
        "  Focus: source IP, its network zone and the asset inventory.",
        "  Escalate if: the source is an internal host that is not an approved scanner.",
        "  Benign if: the source is an approved vulnerability scanner or a known test.",
        "- Lookup: How many accounts were tried?",
        "Investigate:",
        "- Decision: Is this a confirmed compromise?",
        "Contain: Block the source at the edge; Reset the credentials",
    ]
    # Instructions are for people, never for the investigator.
    assert "asset inventory before anything else" not in text
    assert "Record where you blocked it" not in text


def test_render_accepts_a_version_document() -> None:
    defn = _defn()
    doc = RunbookVersionDoc(version=7, state="published", definition=defn)
    assert RM.render_runbook_prompt(doc).startswith("My runbook (v7)")
    assert RM.render_runbook_prompt(defn).startswith("My runbook\n")


# --------------------------------------------------------------------------- #
# Canonical form and hash
# --------------------------------------------------------------------------- #
def test_content_hash_is_sha256_of_the_canonical_definition() -> None:
    import hashlib

    defn = _defn()
    canonical = RM.canonical_definition_json(defn)
    assert json.loads(canonical) == defn.model_dump(mode="json")
    assert RM.content_hash(defn) == hashlib.sha256(canonical.encode()).hexdigest()
    # Field order of the input never changes the hash.
    reordered = RunbookDefinition.model_validate(dict(reversed(list(defn.model_dump().items()))))
    assert RM.content_hash(reordered) == RM.content_hash(defn)
    assert RM.content_hash(_defn(title="Other")) != RM.content_hash(defn)


def test_normalise_definition_makes_entry_style_irrelevant() -> None:
    messy = _defn(
        title="  My runbook ", mitre=["t1110 ", ""], owner="  ", applies_when=AppliesWhen(rule_ids=[" r1 ", ""]),
        steps=[_step(title=" Is it real? ", focus=" ", instructions="\n\nDo it.  \n\n", escalate_if="")],
    )
    clean = RM.normalise_definition(messy)
    assert clean.title == "My runbook" and clean.owner is None and clean.mitre == ["T1110"]
    assert clean.applies_when.rule_ids == ["r1"]
    step = clean.steps[0]
    assert (step.title, step.focus, step.instructions, step.escalate_if) == ("Is it real?", None, "Do it.", None)
    assert RM.normalise_definition(clean) == clean
    assert RM.content_hash(clean) == RM.content_hash(RM.normalise_definition(clean))
    # The canonical text (and so the hash) is the normalised form's, whatever the entry.
    assert RM.canonical_definition_json(messy) == RM.canonical_definition_json(clean)
    assert RM.content_hash(messy) == RM.content_hash(clean)


def _padded() -> RunbookDefinition:
    """A definition with surrounding spaces in every field that allows them (each
    validates with no issue) and the same content as ``_tricky`` otherwise."""
    base = _tricky()
    steps = list(base.steps)
    steps[0] = steps[0].model_copy(update={"focus": "  padded focus ", "escalate_if": " escalate ",
                                           "benign_if": "benign  ", "title": " Value: with a colon? "})
    steps[2] = steps[2].model_copy(update={"options": [
        DecisionOption(id="a", label="  spaced "), DecisionOption(id="b", label="No ", marks_not_applicable=["s4"])]})
    return base.model_copy(update={
        "title": " 2024 ", "summary": "  [not a list], {not a map} ", "use_when": "  lead\nand a second line  ",
        "prerequisites": "\n- leading dash\n- and another\n", "owner": " team: blue ",
        "retrieval_queries": [" query: one ", "two "], "steps": steps,
    })


def test_padded_entries_validate_and_hash_like_their_round_trip() -> None:
    padded = _padded()
    assert RM.validate_runbook(padded) == []
    round_trip = RM.parse_runbook_markdown(RM.export_runbook_markdown(padded)).definition
    assert round_trip == RM.normalise_definition(padded)
    assert round_trip.steps[0].focus == "padded focus" and round_trip.steps[2].options[0].label == "spaced"
    assert round_trip.use_when == "lead\nand a second line"
    assert RM.content_hash(round_trip) == RM.content_hash(padded)
    assert RM.canonical_definition_json(round_trip) == RM.canonical_definition_json(padded)
    # Export writes the normalised form, so exporting the padded entry or its round
    # trip gives the same text.
    assert RM.export_runbook_markdown(padded, version=2) == RM.export_runbook_markdown(round_trip, version=2)


def _accepted_corpus() -> list[RunbookDefinition]:
    """Every definition in this module's fixtures that validates with no issue."""
    corpus = [_defn(), _tricky(), _padded(), RM.parse_runbook_markdown(SPEC_EXAMPLE).definition]
    corpus += [b.definition for b in RM.load_builtin_runbooks()]
    corpus += [_defn(id="brute_force_login"), _defn(steps=[_step(kind="action", react="RA3101", d3fend="D3-NI")])]
    return corpus


def test_parse_of_the_export_is_the_normalised_definition_for_every_accepted_definition() -> None:
    for defn in _accepted_corpus():
        origin = "builtin" if defn.id in RM.BUILTIN_RUNBOOK_IDS else "operator"
        assert RM.validate_runbook(defn, origin=origin) == [], defn.id
        parsed = RM.parse_runbook_markdown(RM.export_runbook_markdown(defn))
        assert parsed.issues == (), defn.id
        assert parsed.definition == RM.normalise_definition(defn), defn.id
        assert RM.content_hash(parsed.definition) == RM.content_hash(defn), defn.id
        if RM.normalise_definition(defn) == defn:  # a stored (normalised) definition comes back as is
            assert parsed.definition == defn, defn.id


# --------------------------------------------------------------------------- #
# Markdown: parse
# --------------------------------------------------------------------------- #
def test_parse_the_spec_example() -> None:
    parsed = RM.parse_runbook_markdown(SPEC_EXAMPLE)
    assert parsed.issues == () and parsed.ok
    defn = parsed.definition
    assert parsed.version == 4
    assert defn.id == "brute-force-password-spray"
    assert defn.priority == 60 and defn.owner == "soc-leads" and defn.review_every_days == 180
    assert defn.mitre == ["T1110", "T1110.003"]
    assert defn.applies_when.rule_ids == ["ssh_auth_failed", "win_logon_failure_burst"]
    assert defn.applies_when.mitre == ["T1110"] and defn.applies_when.entity_types == ["ip", "user"]
    assert defn.references == ["https://attack.mitre.org/techniques/T1110/"]
    assert defn.phases == ["triage", "investigate", "contain"]
    check, lookup, decision, block, reset = defn.steps
    assert (check.id, check.kind, check.phase) == ("source-scope", "check", "triage")
    assert check.focus == "source IP, its network zone and the asset inventory."
    assert check.instructions == "Look the source up in the asset inventory before anything else."
    assert lookup.lookup == LookupTemplate(tool="log_stats", filter={"source.ip": "{{entity.ip}}",
                                                                     "event.outcome": "failure"},
                                           group_by=["user.name"], window="case_first_seen-1h..case_last_seen+1h",
                                           limit=20, run="on_attach")
    assert lookup.instructions == ""
    assert [(o.id, o.label, o.marks_not_applicable) for o in decision.options] == [
        ("confirmed", "Confirmed compromise", []), ("suspicious", "Suspicious, unconfirmed", []),
        ("benign", "Benign", ["block-source", "reset-credentials"]),
    ]
    assert (block.required, block.react, block.d3fend) == (False, "RA3101", "D3-NI")
    assert block.instructions == "Record where you blocked it (firewall, WAF or ticket number)."
    assert reset.required is True
    # The example carries a built-in's id: valid as a built-in, refused for any other
    # origin (a built-in wins an id collision, so the copy would never match).
    assert RM.validate_runbook(defn, origin="builtin", source=SPEC_EXAMPLE, version=4) == []
    assert RM.validate_runbook(defn.model_copy(update={"id": "brute-force-local"}), source=SPEC_EXAMPLE,
                               version=4) == []


def test_version_is_metadata_outside_the_definition() -> None:
    a = RM.parse_runbook_markdown(SPEC_EXAMPLE)
    b = RM.parse_runbook_markdown(SPEC_EXAMPLE.replace("version: 4", "version: 9"))
    assert a.definition == b.definition and (a.version, b.version) == (4, 9)
    no_version = RM.parse_runbook_markdown(SPEC_EXAMPLE.replace("version: 4\n", ""))
    assert no_version.definition == a.definition and no_version.version is None


@pytest.mark.parametrize("value", ["4.1", "v4", "2026-10", "0", "-3", "[1, 2]", "1234567890", "'four'"])
def test_an_import_ignores_a_version_that_is_not_one(value: str) -> None:
    # Import accepts and ignores the version (an import is always a new Draft), so a
    # malformed one is reported and ignored, never a reason to refuse the runbook.
    exported = RM.export_runbook_markdown(_tricky(), version=3)
    parsed = RM.parse_runbook_markdown(exported.replace("version: 3", f"version: {value}"))
    assert parsed.definition == _tricky() and parsed.version is None
    assert [(i.path, i.code, i.message) for i in parsed.issues] == [("version", "parse", RM.VERSION_IGNORED_MESSAGE)]
    assert RM.VERSION_IGNORED_MESSAGE == "version is not a whole number of 1 or more, so it is ignored."
    assert RM.parse_runbook_markdown(exported.replace("version: 3", "version: +3")).version == 3


def test_a_built_in_with_a_version_that_is_not_one_is_still_refused(tmp_path: Path) -> None:
    good = (RM.RUNBOOK_LIBRARY_DIR / "scanning-reconnaissance.md").read_text(encoding="utf-8")
    assert "version: 1\n" in good
    (tmp_path / "scanning-reconnaissance.md").write_text(good.replace("version: 1\n", "version: 1.1\n"),
                                                         encoding="utf-8")
    loaded, refused = RM.load_builtin_library(tmp_path)
    assert loaded == () and set(refused) == {"scanning-reconnaissance.md"}
    assert {i.message for i in refused["scanning-reconnaissance.md"]} == {
        RM.VERSION_IGNORED_MESSAGE, "A built-in runbook needs a version."}


def test_unknown_keys_are_reported_and_never_silently_dropped() -> None:
    text = SPEC_EXAMPLE.replace("owner: soc-leads", "owner: soc-leads\nseverity: high").replace(
        "  entity_types: [ip, user]", "  entity_types: [ip, user]\n  tags: [x]").replace(
        "kind=check}", "kind=check color=red}").replace("run: on_attach", "run: on_attach\ncolour: red")
    parsed = RM.parse_runbook_markdown(text)
    assert parsed.definition is not None  # recoverable: the rest still parses
    assert [(i.path, i.code) for i in parsed.issues] == [
        ("severity", "unknown_key"), ("applies_when.tags", "unknown_key"),
        ("steps[0].attributes", "unknown_key"), ("steps[1].lookup.colour", "unknown_key"),
    ]
    definition, _version, issues = RM.parse_and_validate(text)
    assert "unknown_key" in _codes(issues)


@pytest.mark.parametrize(("change", "fragment"), [
    (("kind=check}", "kind=question}"), "kind 'question'"),
    (("{#source-scope kind=check}", "{kind=check}"), "needs an id"),
    (("{#source-scope kind=check}", ""), "needs an id and a kind"),
    (("{#source-scope kind=check}", "{#source-scope}"), "needs a kind"),
    (("## Investigate", "## Analyse"), "is not a phase"),
    (("## Contain", "## Triage"), "appears twice"),
    (("## Triage\n", "Stray text.\n\n## Triage\n"), "text outside a step"),
    (("priority: 60", "priority: high"), "whole number"),
    (("priority: 60", "priority: 101"), "between 0 and 100"),
    (("entity_types: [ip, user]", "entity_types: [ip, rule]"), "The entity type 'rule'"),
    (("tool: log_stats", "tool: shell"), "lookup tool 'shell'"),
    (("run: on_attach", "run: always"), "on_attach or on_demand"),
    (("limit: 20", "limit: 500"), "between 1 and 50"),
    (("```\n\n## Investigate", "\n## Investigate"), "not closed"),
])
def test_unreadable_sources_give_no_definition_and_a_plain_issue(change: tuple[str, str], fragment: str) -> None:
    text = SPEC_EXAMPLE.replace(*change)
    assert text != SPEC_EXAMPLE
    parsed = RM.parse_runbook_markdown(text)
    assert parsed.definition is None
    assert any(fragment in i.message for i in parsed.issues), [i.message for i in parsed.issues]


def test_missing_front_matter_or_id() -> None:
    assert RM.parse_runbook_markdown("## Triage\n").definition is None
    parsed = RM.parse_runbook_markdown("---\ntitle: x\n---\n")
    assert parsed.definition is None and parsed.issues[0].path == "id"


def test_a_missing_title_still_parses_and_validation_names_it() -> None:
    text = SPEC_EXAMPLE.replace("title: Brute force and password spray\n", "")
    definition, _version, issues = RM.parse_and_validate(text)
    assert definition is not None and definition.title == ""
    assert ("title", "required") in [(i.path, i.code) for i in issues]


def test_two_lookup_blocks_are_refused() -> None:
    block = SPEC_EXAMPLE[SPEC_EXAMPLE.index("```lookup"):SPEC_EXAMPLE.index("run: on_attach\n```") + 18]
    text = SPEC_EXAMPLE.replace(block, block + "\n" + block)
    assert "two lookup blocks" in " ".join(i.message for i in RM.parse_runbook_markdown(text).issues)


def test_parse_tolerates_crlf_and_a_byte_order_mark() -> None:
    a = RM.parse_runbook_markdown(SPEC_EXAMPLE)
    b = RM.parse_runbook_markdown("﻿" + SPEC_EXAMPLE.replace("\n", "\r\n"))
    assert b.definition == a.definition


@pytest.mark.parametrize("garbage", [
    "", "---", "---\n---", "---\n: x\n---", "---\nid: [\n---", "---\nid: \"open\n---", "---\napplies_when: x\n---",
    "\x00\x01", "---\nid: x\n---\n### orphan {#a kind=check}", "---\nid: x\n---\n## Triage\n### t {#a kind=check}\n```",
    "---\nid: x\n  bad: indent\n---", "---\nid: x\nid: y\n---", "---\nmitre:\n  - [a]\n---",
])
def test_parse_never_raises(garbage: str) -> None:
    parsed = RM.parse_runbook_markdown(garbage)
    assert isinstance(parsed, RM.ParsedRunbook)


# --------------------------------------------------------------------------- #
# Markdown: export and the round trip
# --------------------------------------------------------------------------- #
def _tricky() -> RunbookDefinition:
    lookup = LookupTemplate(tool="log_stats", filter={"source.ip": "{{entity.ip}}", "@timestamp": "now",
                                                      "event.outcome": "failure, then success"},
                            group_by=["user.name", "event.action"], window="now-24h", limit=7, run="on_demand")
    steps = [
        _step(id="s1", title="Value: with a colon?", focus="Starts plain: then a colon",
              escalate_if="#hash-like start", benign_if="'quoted' start",
              instructions="Read this first.\nFocus: this is not a key line, because text comes before it.",
              evidence="note", owner_role="Incident lead", target_minutes=90),
        _step(id="s2", kind="lookup", title="Look it up", lookup=lookup, instructions="- a list\n- second"),
        _step(id="s3", phase="investigate", kind="decision", title="Decide {{entity.ip}}?",
              options=[DecisionOption(id="a", label="Yes, really"),
                       DecisionOption(id="b", label="No", marks_not_applicable=["s4", "s5"])]),
        _step(id="s4", phase="contain", kind="action", title="Act", required=False, approval_role="soc_manager",
              target_minutes=120, react="RA3101", d3fend="D3-NI"),
        _step(id="s5", phase="close", kind="record", title="Record it", evidence="note_or_attachment"),
    ]
    return RunbookDefinition(
        id="tricky_one", title="2024", summary="[not a list], {not a map}", use_when="true\nand a second line",
        prerequisites="- leading dash\n- and another", priority=0, owner="team: blue", review_every_days=30,
        mitre=["T1110", "T1110.003"],
        applies_when=AppliesWhen(rule_ids=["LP QRadar: remote access, brute force", "a\"b", "it's", "plain"],
                                 mitre=["T1110"], entity_types=["ip", "user"], severity_at_least="high",
                                 sources=["src-1", "type:wazuh"], verdicts=["NEEDS_HUMAN"], statuses=["open"],
                                 any_tags=["brute force"], min_event_count=5),
        phases=["triage", "investigate", "contain", "close"], steps=steps,
        retrieval_queries=["query: one", "two"], references=["https://example.com/a?b=c#d"],
    )


def test_export_then_parse_gives_an_equal_definition() -> None:
    defn = _tricky()
    assert RM.validate_runbook(defn) == []
    text = RM.export_runbook_markdown(defn, version=3)
    parsed = RM.parse_runbook_markdown(text)
    assert parsed.issues == ()
    assert parsed.definition == defn and parsed.version == 3
    # And the fixed point: export of the parse is the same text.
    assert RM.export_runbook_markdown(parsed.definition, version=3) == text


def test_round_trip_parse_export_parse_on_the_spec_example() -> None:
    first = RM.parse_runbook_markdown(SPEC_EXAMPLE)
    again = RM.parse_runbook_markdown(RM.export_runbook_markdown(first.definition, version=first.version))
    assert again.definition == first.definition and again.version == 4


def test_export_writes_the_documented_form() -> None:
    defn = RM.parse_runbook_markdown(SPEC_EXAMPLE).definition
    text = RM.export_runbook_markdown(defn, version=4)
    assert text.startswith("---\nid: brute-force-password-spray\ntitle: Brute force and password spray\n")
    assert "version: 4\n" in text
    assert "applies_when:\n  rule_ids: [ssh_auth_failed, win_logon_failure_burst]\n" in text
    assert '  source.ip: "{{entity.ip}}"\n' in text
    assert "### Block the source at the edge {#block-source kind=action optional react=RA3101 d3fend=D3-NI}" in text
    assert "- benign: Benign | skips: block-source, reset-credentials" in text
    assert "## Contain" in text and text.endswith("\n")
    assert "version" not in RM.export_runbook_markdown(defn)


def test_export_quotes_attribute_values_with_spaces() -> None:
    text = RM.export_runbook_markdown(_tricky())
    assert 'owner="Incident lead"' in text and "target=90m" in text and "target=2h" in text


# --------------------------------------------------------------------------- #
# The compatible front-matter parser (moved from engine/runbooks.py)
# --------------------------------------------------------------------------- #
LEGACY_PLAYBOOK_DOC = """---
id: brute_force_login
name: Brute-force / password-spray login
version: 1
description: Repeated failed authentications or password spray against accounts or services.
match:
  rule_ids: [mail_auth, waf_auth, web_auth, roundcube_login, postfix]
  entity_types: [ip, user, host]
  min_event_count: 5
priority: 50
rag_queries:
  - brute force lockout policy runbook
  - MITRE T1110 password spray
escalate_if: A successful authentication (event.outcome:success) follows the failure burst.
---
## Objective
Decide.
"""

LEGACY_RUNBOOK_DOC = """---
id: web_attack
title: Web application attack (WAF / ModSecurity)
applies_to_rules: [modsecurity, modsec_audit_log, nginx, apache]
keywords: [modsec, waf, sqli, "941"]
summary: A WAF/ModSec rule fired on a request to a public-facing web app.
---
SIGNAL
A request matched a WAF rule.
"""


def test_parse_frontmatter_reads_retired_documents() -> None:
    meta, body = RM.parse_frontmatter(LEGACY_PLAYBOOK_DOC)
    assert meta["id"] == "brute_force_login"
    assert meta["match"] == {"rule_ids": ("mail_auth", "waf_auth", "web_auth", "roundcube_login", "postfix"),
                             "entity_types": ("ip", "user", "host"), "min_event_count": "5"}
    assert meta["rag_queries"] == ("brute force lockout policy runbook", "MITRE T1110 password spray")
    assert meta["escalate_if"].endswith("follows the failure burst.")
    assert body == "## Objective\nDecide."
    meta, body = RM.parse_frontmatter(LEGACY_RUNBOOK_DOC)
    assert meta["keywords"] == ("modsec", "waf", "sqli", "941")
    assert body.startswith("SIGNAL")


def test_parse_frontmatter_never_raises() -> None:
    assert RM.parse_frontmatter("no front matter") == ({}, "no front matter")
    # Front matter the strict subset refuses is read the retired reader's way, which
    # kept what it could ('[' alone was a one-item list).
    assert RM.parse_frontmatter("---\nid: [\n---\nbody") == ({"id": ("[",)}, "body")
    assert RM.parse_frontmatter("---\ntitle: x\nid: [\n---\nbody")[0]["title"] == "x"
    assert RM.parse_frontmatter(None) == ({}, "")  # type: ignore[arg-type]
    assert RM.parse_frontmatter("---\n\x00: \ud800\n---\nb")[1] == "b"


# --------------------------------------------------------------------------- #
# Helpers and constants
# --------------------------------------------------------------------------- #
def test_cut_text_prefers_a_sentence_then_a_word_boundary() -> None:
    assert RM.cut_text("Short.", 10) == ("Short.", "")
    assert RM.cut_text("One. Two three four.", 12) == ("One.", "Two three four.")
    assert RM.cut_text("alpha beta gamma", 12) == ("alpha beta", "gamma")
    assert RM.cut_text("abcdefghij", 4) == ("abcd", "efghij")


def test_slugs_and_copy_ids() -> None:
    assert RM.slugify("Is the source internal or external?") == "is-the-source-internal-or-external"
    assert RM.slugify("") == "step" and RM.slugify("Ünïcode Ok") == "unicode-ok"
    assert RM.unique_slug("Act", {"act", "act-2"}) == "act-3"
    assert len(RM.unique_slug("x" * 80, {"x" * 64})) <= 64
    assert RM.fit_id("y" * 64, "-imported") == "y" * 55 + "-imported"
    assert RM.copy_runbook_id("brute-force", set()) == "brute-force-custom"
    assert RM.copy_runbook_id("brute-force", {"brute-force-custom"}) == "brute-force-custom-2"
    assert RM.copy_runbook_id("brute-force", {"brute-force-custom", "brute-force-custom-2"}) == "brute-force-custom-3"
    assert len(RM.copy_runbook_id("z" * 64, set())) <= 64


def test_applies_to_chips() -> None:
    defn = _defn(applies_when=AppliesWhen(rule_ids=["a", "b", "c", "d"], mitre=["T1110"]))
    chips = RM.applies_to(defn)
    assert (chips.rule_ids, chips.mitre, chips.more) == (["a", "b", "c"], [], 2)
    chips = RM.applies_to(_defn(applies_when=AppliesWhen(rule_ids=["a"], mitre=["T1110", "T1078"])))
    assert (chips.rule_ids, chips.mitre, chips.more) == (["a"], ["T1110", "T1078"], 0)


def test_applies_to_chips_never_show_coverage_techniques() -> None:
    # The top-level mitre list is coverage only; matching never reads it, so the
    # "Applies to" chips (and their "+N") never show it.
    chips = RM.applies_to(_defn(applies_when=AppliesWhen(rule_ids=["a"]), mitre=["T1110", "T1078"]))
    assert (chips.rule_ids, chips.mitre, chips.more) == (["a"], [], 0)
    for builtin in RM.load_builtin_runbooks():
        chips = RM.applies_to(builtin.definition)
        assert chips.mitre == builtin.definition.applies_when.mitre[: len(chips.mitre)], builtin.id
        assert set(chips.mitre) <= set(builtin.definition.applies_when.mitre), builtin.id
        shown = len(chips.rule_ids) + len(chips.mitre) + chips.more
        assert shown == len(builtin.definition.applies_when.rule_ids) + len(builtin.definition.applies_when.mitre)


def test_vocabulary() -> None:
    assert tuple(RM.KIND_LABELS.values()) == ("Check", "Lookup", "Decision", "Action", "Record")
    assert RM.PHASE_LABELS["close"] == "Close and learn"
    assert RM.PHASE_FRAMEWORKS["contain"] == {"nist": "RS.MI-01", "sans": "Containment"}


# --------------------------------------------------------------------------- #
# Purity: no store, network or gateway
# --------------------------------------------------------------------------- #
_MODULES = ("app.engine.runbook_model", "app.engine.runbook_match", "app.engine.runbook_lookup")
_FORBIDDEN_PREFIXES = ("app.stores", "app.llm", "app.tools", "app.connectors", "app.es", "app.api", "app.state",
                       "app.agents", "app.realtime", "app.cache", "app.notifications", "app.enrichment")


def test_runbook_core_imports_nothing_from_stores_network_or_gateway() -> None:
    code = (
        "import sys\n"
        f"import {', '.join(_MODULES)}\n"
        "mods = sorted(m for m in sys.modules if m.startswith('app.'))\n"
        "net = sorted(m for m in sys.modules if m.split('.')[0] in "
        "('httpx', 'aiohttp', 'requests', 'elasticsearch', 'redis', 'sqlalchemy', 'asyncpg', 'anthropic', 'openai'))\n"
        "print(repr((mods, net)))\n"
    )
    out = subprocess.run([sys.executable, "-c", code], cwd=BACKEND, capture_output=True, text=True, check=True)
    mods, net = ast.literal_eval(out.stdout.strip().splitlines()[-1])
    # ``app.models`` imports ``app.agents.blocks`` (the pure answer-block schemas), which
    # loads the ``app.agents`` package itself; nothing else of the agents may load.
    own = [m for m in mods if m.startswith(_FORBIDDEN_PREFIXES) and m not in ("app.agents", "app.agents.blocks")]
    assert own == [], own
    assert net == [], net


@pytest.mark.parametrize("module", _MODULES)
def test_runbook_core_source_imports_only_pure_modules(module: str) -> None:
    path = BACKEND / (module.replace(".", "/") + ".py")
    tree = ast.parse(path.read_text(encoding="utf-8"))
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            imported.add(("." * node.level) + (node.module or ""))
        elif isinstance(node, ast.Import):
            imported.update(alias.name for alias in node.names)
    allowed = {
        "__future__", "difflib", "ipaddress", "re", "unicodedata", "dataclasses", "datetime", "typing", "hashlib",
        "json", "logging", "pathlib", "pydantic", "..constants", "..models", "..evidence_fields", "..utils", ".",
        ".runbook_lookup", ".runbook_model", ".priority",
    }
    assert imported <= allowed, imported - allowed


# --------------------------------------------------------------------------- #
# Hostile input: every parse and check stays linear
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("hostile", [
    "{{" + " " * 200_000,
    "[" * 200_000,
    "![" * 100_000,
    '[a](b "' * 20_000,
    "<a " + "x" * 200_000,
    "Text " + " " * 200_000 + "x",
], ids=["template-spaces", "brackets", "images", "open-links", "open-tag", "space-run"])
def test_validation_of_hostile_text_is_fast(hostile: str) -> None:
    import time

    step = _step(instructions=hostile, focus=hostile[:5_000], title=hostile[:5_000])
    started = time.perf_counter()
    issues = RM.validate_runbook(_defn(steps=[step]))
    assert time.perf_counter() - started < 3.0
    assert issues  # too long, at least


_HEADING = "### Is the source internal or external? {#source-scope kind=check}"


@pytest.mark.parametrize(("anchor", "replacement"), [
    (_HEADING, "### Title" + " " * 200_000 + "x"),
    (_HEADING, "### " + "{" * 100_000 + " " * 100_000),
    (_HEADING, _HEADING + "\nFocus: x" + " " * 200_000 + "y"),
    ("- confirmed: Confirmed compromise", "- confirmed: label" + " " * 200_000 + "| skips: a"),
    ("- confirmed: Confirmed compromise", "- confirmed: " + "|" * 200_000),
], ids=["heading-spaces", "heading-braces", "key-line", "option-line", "option-bars"])
def test_parsing_hostile_lines_is_fast(anchor: str, replacement: str) -> None:
    import time

    text = SPEC_EXAMPLE.replace(anchor, replacement)
    assert text != SPEC_EXAMPLE
    started = time.perf_counter()
    RM.parse_and_validate(text)
    assert time.perf_counter() - started < 3.0


# --------------------------------------------------------------------------- #
# Copy rules (SPEC §3.1): plain text, no em or en dashes, never the retired word
# --------------------------------------------------------------------------- #
def _string_constants(path: Path) -> list[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    docstrings: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            body = getattr(node, "body", [])
            if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
                docstrings.add(id(body[0].value))
    return [node.value for node in ast.walk(tree)
            if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in docstrings]


#: Code and wire identifiers that keep the retired word, each deliberately: the stored
#: automation payload key ``playbook_id`` (AGENTS.md naming contract: it stays the
#: stored form of a ``run_playbook`` rule) and the public name of the retired bundled
#: playbook ids. Neither is ever shown to a person.
_COMPAT_IDENTIFIERS = frozenset({"playbook_id", "LEGACY_BUNDLED_PLAYBOOK_IDS"})


@pytest.mark.parametrize("module", _MODULES)
def test_user_facing_strings_follow_the_copy_rules(module: str) -> None:
    for text in _string_constants(BACKEND / (module.replace(".", "/") + ".py")):
        assert "\u2014" not in text and "\u2013" not in text, text
        if text not in _COMPAT_IDENTIFIERS:
            assert "playbook" not in text.lower(), text


def test_issue_messages_follow_the_copy_rules() -> None:
    hostile = _defn(
        id="new", title="", summary="s" * 300, references=["http://x"], mitre=["x"],
        applies_when=AppliesWhen(always=True, rule_ids=["r"], sources=["type:x"], statuses=["x"]),
        phases=["contain", "triage"],
        steps=[_step(id="Bad", kind="lookup", focus="{{entity.ipaddr}}", instructions="## h\n<b>x</b>",
                     lookup=LookupTemplate(tool="log_search", limit=50, window="all", group_by=["a"])),
               _step(id="d", kind="decision", options=[DecisionOption(id="a", label="A|B",
                                                                      marks_not_applicable=["zz"])])],
    )
    messages = [i.message for i in RM.validate_runbook(hostile)]
    assert len(messages) > 10
    for message in messages:
        assert "\u2014" not in message and "\u2013" not in message
        assert "playbook" not in message.lower()
        assert message[0].isupper() and message.endswith((".", "?")), message


# --------------------------------------------------------------------------- #
# Review fixes (WP-A3): bounded work on hostile input
# --------------------------------------------------------------------------- #
def _fast(fn, budget: float = 1.0):
    import time

    started = time.perf_counter()
    result = fn()
    elapsed = time.perf_counter() - started
    assert elapsed < budget, f"took {elapsed:.2f} s"
    return result


@pytest.mark.parametrize("quote", ["'", '"'])
def test_a_quote_filled_flow_list_parses_in_linear_time(quote: str) -> None:
    # Each quote used to re-join the item's buffer: 60,000 quotes took about 8 s.
    source = "---\nid: a\ntitle: t\nsummary: s\nmitre: [a" + quote * 60_000 + "]\n---\n"
    assert len(source.encode("utf-8")) <= 65_536
    _defn_, _version, issues = _fast(lambda: RM.parse_and_validate(source))
    assert issues
    _fast(lambda: RM.parse_frontmatter(source))


@pytest.mark.parametrize("size", [1 << 20, 2 * 1024 * 1024])
def test_an_oversized_source_is_refused_before_it_is_read(size: int) -> None:
    source = "---\nid: x\n---\n" + "x\n" * (size // 2)
    parsed = _fast(lambda: RM.parse_runbook_markdown(source))
    assert parsed.definition is None and [i.code for i in parsed.issues] == ["source_too_large"]
    definition, version, issues = _fast(lambda: RM.parse_and_validate(source))
    assert definition is None and version is None
    assert [(i.path, i.code) for i in issues] == [("source", "source_too_large")]
    assert issues[0].message == f"The Markdown source is {len(source.encode()):,} bytes; the limit is 65,536."


def test_a_source_at_the_size_limit_is_still_parsed() -> None:
    source = SPEC_EXAMPLE + "\n" * (65_536 - len(SPEC_EXAMPLE.encode("utf-8")))
    assert len(source.encode("utf-8")) == 65_536
    parsed = RM.parse_runbook_markdown(source)
    assert parsed.definition is not None and parsed.issues == ()


def test_parser_issues_are_capped() -> None:
    source = "---\nid: x\ntitle: t\nsummary: s\n---\n" + "x\n" * 30_000
    parsed = _fast(lambda: RM.parse_runbook_markdown(source))
    assert parsed.definition is None
    assert len(parsed.issues) == RM.RUNBOOK_MAX_ISSUES + 1
    assert (parsed.issues[-1].code, parsed.issues[-1].message) == (
        "more_issues", "There are more problems; fix these first.")
    _definition, _version, issues = RM.parse_and_validate(source)
    assert len(issues) == RM.RUNBOOK_MAX_ISSUES + 1 and issues[-1].code == "more_issues"
    assert [i.code for i in issues].count("more_issues") == 1


def test_validation_issues_are_capped() -> None:
    steps = [_step(id=f"Bad {i}", phase="contain") for i in range(300)]
    issues = RM.validate_runbook(_defn(steps=steps))
    assert len(issues) == RM.RUNBOOK_MAX_ISSUES + 1
    assert issues[-1].code == "more_issues" and [i.code for i in issues].count("more_issues") == 1


def test_an_oversized_definition_gets_one_issue_before_any_scan() -> None:
    huge = _defn(steps=[_step(instructions="[x](" * 70_000)])
    issues = _fast(lambda: RM.validate_runbook(huge))
    assert [(i.path, i.code) for i in issues] == [("source", "source_too_large")]
    assert issues[0].message.startswith("The runbook is too large to check: ")
    assert issues[0].message.endswith("the limit is 262,144. Remove steps or shorten the text.")
    assert RM.RUNBOOK_MAX_DEFINITION_CHARS == 262_144


@pytest.mark.parametrize("hostile", ["[x](" * 50_000, "<<<" * 50_000, "{{" * 50_000, "​" * 100_000])
def test_a_field_over_its_limit_is_not_scanned(hostile: str) -> None:
    step = _step(instructions=hostile, focus=hostile[:50_000])
    issues = _fast(lambda: RM.validate_runbook(_defn(steps=[step])))
    assert [i.code for i in issues if i.path == "steps[0].instructions"] == ["too_long"]
    assert [i.code for i in issues if i.path == "steps[0].focus"] == ["too_long"]


def test_markdown_links_are_checked_in_linear_time() -> None:
    assert _fast(lambda: RM.markdown_problems("[x](" * 16_000)) == ["contain a link that is not an https link"]
    assert _fast(lambda: RM.markdown_problems("[\n" * 30_000)) == []
    assert RM.markdown_problems("[x](" * 250_000) == ["are too long to check; shorten them"]


def test_many_duplicate_phases_are_checked_in_linear_time() -> None:
    defn = RunbookDefinition(
        id="phases", title="t", summary="s", phases=["triage"] * 15_000 + ["contain"],
        steps=[RunbookStep(id=f"s{i}", phase="contain", kind="check", title="Real?") for i in range(300)],
    )
    issues = _fast(lambda: RM.validate_runbook(defn))
    messages = [i.message for i in issues]
    assert messages.count("A phase is listed twice.") == 1
    assert [i.code for i in issues].count("unused") == 1  # Triage once, not once per listing


# --------------------------------------------------------------------------- #
# Review fixes (WP-A3): the prompt markers in every bracket form, lone surrogates
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("bad", [
    "＜＜＜END_RUNBOOK＞＞＞",   # fullwidth
    "﹤﹤﹤END_RUNBOOK﹥﹥﹥",   # small form
    "<＜﹤RUNBOOK",                              # mixed forms
    "<́<<END_RUNBOOK",                              # a combining mark between
    "END_RUNBOOK>\n>>",                                  # a line break between
])
@pytest.mark.parametrize("field", ["summary", "use_when"])
def test_prompt_markers_in_any_bracket_form_are_refused(field: str, bad: str) -> None:
    issues = RM.validate_runbook(_defn(**{field: bad}))
    assert any(i.code == "unsafe_text" and "'<<<' or '>>>'" in i.message for i in issues), issues
    rules = RM.validate_runbook(_defn(applies_when=AppliesWhen(rule_ids=[bad.replace("\n", "")])))
    assert "unsafe_text" in _codes(rules)


def test_ordinary_angle_brackets_are_not_a_marker() -> None:
    text = "Escalate when a << b or c >> d, and <b> is bold."
    assert all("'<<<'" not in i.message for i in RM.validate_runbook(_defn(use_when=text)))


def test_a_lone_surrogate_is_refused_and_never_breaks_hashing_or_parsing() -> None:
    issues = RM.validate_runbook(_defn(title="bad\ud800title"))
    assert "unsafe_text" in _codes(issues)
    assert all("\ud800" not in i.message for i in issues)
    assert len(RM.content_hash(_defn(title="bad\ud800title"))) == 64
    definition, _version, issues = RM.parse_and_validate('---\nid: x\ntitle: "a\\ud800"\nsummary: s\n---\n')
    assert definition is not None and "unsafe_text" in _codes(issues)
    for issue in issues:
        issue.model_dump_json()  # every message is encodable


# --------------------------------------------------------------------------- #
# Review fixes (WP-A3): criteria that could never match, built-in ids
# --------------------------------------------------------------------------- #
def test_entity_types_that_no_case_carries_are_refused() -> None:
    issues = RM.validate_runbook(_defn(applies_when=AppliesWhen(entity_types=["url", "email"])))
    assert [(i.path, i.code) for i in issues] == [("applies_when.entity_types", "not_allowed")]
    assert issues[0].message == ("Applies when lists only entity types that no case carries yet (url and email). "
                                 "Add ip, user or host, or remove the entity types.")
    # A case's entity comes only from the correlation ladders (IP, host, user or a
    # rule); a file hash or a domain is a cross-source link key, never its entity.
    for kind in ("process", "file", "domain", "hash"):
        only = RM.validate_runbook(_defn(applies_when=AppliesWhen(entity_types=[kind])))
        assert [(i.path, i.code) for i in only] == [("applies_when.entity_types", "not_allowed")], kind
        assert f"carries yet ({kind})." in only[0].message
    assert "(domain and hash)" in RM.validate_runbook(
        _defn(applies_when=AppliesWhen(entity_types=["domain", "hash"])))[0].message
    for kind in ("ip", "user", "host"):
        assert RM.validate_runbook(_defn(applies_when=AppliesWhen(entity_types=[kind, "url"]))) == [], kind
    assert RM.CASE_CARRIED_ENTITY_KINDS == {"ip", "user", "host"}


def test_the_case_carried_kinds_are_the_correlation_ladders() -> None:
    from app.engine import correlation

    ladder_kinds = {t.value for t in correlation._AUTO_LADDER}
    for ladder in correlation._PINNED_LADDER.values():
        ladder_kinds |= {t.value for t in ladder}
    assert ladder_kinds - {"rule"} == RM.CASE_CARRIED_ENTITY_KINDS


def test_an_operator_or_imported_runbook_cannot_take_a_built_in_id() -> None:
    for rid in RM.BUILTIN_RUNBOOK_IDS:
        for origin in ("operator", "imported"):
            issues = RM.validate_runbook(_defn(id=rid), origin=origin)
            # Its own code, so an import can rename it and land a Draft (§4.10.13)
            # while a reserved route name is simply refused.
            assert _codes(issues) == ["builtin_id"], (rid, origin)
            assert RM.blocking_error_code(issues) == "runbook_id_reserved"
            assert issues[0].message == (f"The id '{rid}' belongs to a built-in runbook. Choose another id, or "
                                         "duplicate the built-in to customise it.")
        assert RM.validate_runbook(_defn(id=rid), origin="builtin") == []
        assert RM.validate_runbook(_defn(id=RM.copy_runbook_id(rid, ())), origin="operator") == []
    assert (RM.ISSUE_BUILTIN_ID, RM.ISSUE_RESERVED) == ("builtin_id", "reserved")


def test_an_exported_built_in_imports_back_under_a_copy_id() -> None:
    # The import path: the built-in collision is told apart by its code, renamed with
    # copy_runbook_id, and the renamed definition validates as an imported Draft.
    builtin = RM.builtin_runbook("brute-force-password-spray")
    text = RM.export_runbook_markdown(builtin.definition, version=builtin.version)
    definition, version, issues = RM.parse_and_validate(text, origin="imported")
    assert version == builtin.version and _codes(issues) == ["builtin_id"]
    renamed = definition.model_copy(update={"id": RM.copy_runbook_id(definition.id, RM.BUILTIN_RUNBOOK_IDS)})
    assert renamed.id == "brute-force-password-spray-custom"
    assert RM.validate_runbook(renamed, origin="imported") == []


# --------------------------------------------------------------------------- #
# Review fixes (WP-A3): key lines after a blank line, and instructions that would
# read as one
# --------------------------------------------------------------------------- #
def _step_source(body: str, kind: str = "check") -> str:
    return ("---\nid: rb\ntitle: T\nsummary: S\n---\n\n## Triage\n\n"
            f"### Is the source internal or external? {{#source-scope kind={kind}}}\n" + body)


def test_a_blank_line_after_the_heading_keeps_the_key_lines() -> None:
    body = ("\nFocus: source IP and zone.\nEscalate if: internal and unapproved.\n"
            "Benign if: an approved scanner.\n\nLook it up first.\n")
    definition, _version, issues = RM.parse_and_validate(_step_source(body))
    assert issues == []
    step = definition.steps[0]
    assert (step.focus, step.escalate_if, step.benign_if) == (
        "source IP and zone.", "internal and unapproved.", "an approved scanner.")
    assert step.instructions == "Look it up first."
    prompt = RM.render_runbook_prompt(definition)
    assert "  Escalate if: internal and unapproved." in prompt and "  Benign if: an approved scanner." in prompt


def test_blank_lines_between_key_lines_and_any_letter_case() -> None:
    body = "\n\nfocus: a.\n\nESCALATE IF: b.\n\n  Benign If: c.\n\nText.\n"
    definition, _version, issues = RM.parse_and_validate(_step_source(body))
    assert issues == []
    step = definition.steps[0]
    assert (step.focus, step.escalate_if, step.benign_if, step.instructions) == ("a.", "b.", "c.", "Text.")
    duplicate = RM.parse_runbook_markdown(_step_source("Focus: a.\n\nfocus: b.\n"))
    assert duplicate.definition is None and "has the line 'Focus:' twice" in duplicate.issues[0].message


def test_a_decision_with_a_blank_line_before_its_options() -> None:
    body = ("\nOptions:\n\n- confirmed: Confirmed compromise\n- benign: Benign\n\n"
            "- the instructions may start with a list: like this\n")
    definition, _version, issues = RM.parse_and_validate(_step_source(body, kind="decision"))
    assert issues == []
    step = definition.steps[0]
    assert [o.id for o in step.options] == ["confirmed", "benign"]
    assert step.instructions == "- the instructions may start with a list: like this"
    again = RM.parse_runbook_markdown(RM.export_runbook_markdown(definition))
    assert again.issues == () and again.definition == definition


@pytest.mark.parametrize("first", ["Focus: x", "escalate if: y", "  Benign if: z", "OPTIONS:"])
def test_instructions_cannot_start_with_a_key_line(first: str) -> None:
    issues = RM.validate_runbook(_defn(steps=[_step(instructions=f"\n{first}\nMore text.")]))
    markdown = [i for i in issues if i.code == "markdown"]
    assert len(markdown) == 1 and "which the Markdown form reads as the step's own" in markdown[0].message
    # Later in the instructions the same line is ordinary text and survives the round trip.
    later = _defn(steps=[_step(instructions=f"First line.\n{first}")])
    assert RM.validate_runbook(later) == []
    again = RM.parse_runbook_markdown(RM.export_runbook_markdown(later))
    assert again.issues == () and again.definition == later


# --------------------------------------------------------------------------- #
# Review fixes (WP-A3): use when and prerequisites may span lines (SPEC §4.10.2 sets
# only their lengths); the title and summary stay one line
# --------------------------------------------------------------------------- #
def test_use_when_and_prerequisites_may_span_lines() -> None:
    defn = _defn(use_when="Line one.\nLine two.", prerequisites="- access to the proxy\n- a ticket")
    assert RM.validate_runbook(defn) == []
    parsed = RM.parse_runbook_markdown(RM.export_runbook_markdown(defn))
    assert parsed.issues == () and parsed.definition == defn
    assert "Use when: Line one.\nLine two." in RM.render_runbook_prompt(defn)
    assert _codes(RM.validate_runbook(_defn(summary="a\nb"))) == ["single_line"]
    assert "unsafe_text" in _codes(RM.validate_runbook(_defn(use_when="a\rb")))
    normalised = RM.normalise_definition(_defn(use_when="\r\n  Line one.\r\nLine two.  \n\n", prerequisites=" x "))
    assert (normalised.use_when, normalised.prerequisites) == ("Line one.\nLine two.", "x")


# --------------------------------------------------------------------------- #
# Review fixes (WP-A3): the front-matter reader keeps what the retired reader kept.
# The retired reader is copied here as the oracle, because its module is deleted
# this round (SPEC §4.10.16).
# --------------------------------------------------------------------------- #
_RETIRED_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n?(.*)$", re.DOTALL)


def _retired_split_list(raw: str) -> tuple[str, ...]:
    raw = raw.strip()
    if raw.startswith("[") and raw.endswith("]"):
        raw = raw[1:-1]
    parts = [p.strip().strip("'\"") for p in raw.split(",")]
    return tuple(p for p in parts if p)


def retired_parse_frontmatter(text: str) -> tuple[dict[str, object], str]:
    """``engine/runbooks.parse_frontmatter`` as it shipped before Round 14."""
    normalized = text.lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n")
    m = _RETIRED_FRONTMATTER_RE.match(normalized)
    if not m:
        return {}, normalized.strip()
    raw_meta, body = m.group(1), m.group(2).strip()
    meta: dict[str, object] = {}
    current_key: str | None = None
    current_list: list[str] = []

    def _flush() -> None:
        nonlocal current_key, current_list
        if current_key is not None:
            meta[current_key] = tuple(current_list)
        current_key, current_list = None, []

    for line in raw_meta.splitlines():
        if not line.strip():
            continue
        if line.lstrip().startswith("- ") and current_key is not None:
            current_list.append(line.lstrip()[2:].strip().strip("'\""))
            continue
        _flush()
        if ":" not in line:
            continue
        key, _, val = line.partition(":")
        key = key.strip()
        val = val.strip()
        if not val:
            current_key = key
            current_list = []
        elif val.startswith("["):
            meta[key] = _retired_split_list(val)
        else:
            meta[key] = val.strip("'\"")
    _flush()
    return meta, body


def _assert_keeps_retired_keys(text: str, *, extended: tuple[str, ...] = ()) -> dict[str, object]:
    """Every key the retired reader returned is returned again with the same value
    (one level of nesting flattened, as the retired reader flattened it). A key in
    ``extended`` may hold more text than the retired reader kept, never less."""
    old, old_body = retired_parse_frontmatter(text)
    new, new_body = RM.parse_frontmatter(text)
    flat: dict[str, object] = dict(new)
    for value in new.values():
        if isinstance(value, dict):
            flat.update(value)
    for key, value in old.items():
        if value == () and (isinstance(new.get(key), dict) or flat.get(key) in ("", ())):
            continue  # a block the retired reader read as an empty list
        assert key in flat, key
        if key in extended:
            assert str(flat[key]).startswith(str(value)), (key, flat[key], value)
        else:
            assert flat[key] == value, (key, flat[key], value)
    assert new_body == old_body
    return new


_LENIENT_CASES = {
    "apostrophe_single_quoted": "---\nid: foo\ntitle: Foo\nsummary: 'Don't panic'\napplies_to_rules: [sshd]\n---\nbody\n",
    "duplicate_key": "---\nid: foo\ntitle: Foo\ntitle: Bar\napplies_to_rules: [sshd]\n---\nbody\n",
    "tab_indent_list": "---\nid: foo\ntitle: Foo\napplies_to_rules:\n\t- sshd\n---\nbody\n",
    "stray_line": "---\nid: foo\ntitle: Foo\nsee below\napplies_to_rules: [sshd]\n---\nbody\n",
    "unterminated_quote": "---\nid: foo\ntitle: \"Foo\napplies_to_rules: [sshd]\n---\nbody\n",
    "nested_list_value": "---\nid: foo\ntitle: Foo\nkeywords: [a, [b]]\n---\nbody\n",
    "key_with_space": "---\nid: foo\ntitle: Foo\nlegacy key: x\n---\nbody\n",
    "quote_then_text": "---\nid: foo\ntitle: \"Brute\" force\n---\nbody\n",
    "braces": "---\nid: foo\ntitle: {scary} title\n---\nbody\n",
    "unclosed_list": "---\nid: foo\nkeywords: [a, b\ntitle: Foo\n---\nbody\n",
}


@pytest.mark.parametrize("name", sorted(_LENIENT_CASES))
def test_parse_frontmatter_keeps_what_the_retired_reader_kept(name: str) -> None:
    meta = _assert_keeps_retired_keys(_LENIENT_CASES[name])
    assert meta["id"] == "foo"


LEGACY_FRONT_MATTER: dict[str, str] = {
    "brute_force_login": (
        '---\n'
        'id: brute_force_login\n'
        'name: Brute-force / password-spray login\n'
        'version: 1\n'
        'description: Repeated failed authentications or password spray against accounts or'
        ' services.\n'
        'match:\n'
        '  rule_ids: [mail_auth, waf_auth, web_auth, roundcube_login, postfix]\n'
        '  entity_types: [ip, user, host]\n'
        '  mitre: [T1110, T1078]\n'
        '  min_event_count: 5\n'
        '  any_tags: [auth, login, credential]\n'
        'priority: 50\n'
        'suggested_tools: [es_query, enrich, rag_retrieve]\n'
        'rag_queries:\n'
        '  - brute force lockout policy runbook\n'
        '  - MITRE T1110 password spray\n'
        '  - credential stuffing detection thresholds\n'
        'escalate_if: A successful authentication (event.outcome:success) follows the failure'
        ' burst from the same source.ip or for the same user.name \u2014 treat as possible account'
        ' compromise and escalate.\n'
        'suggested_verdict_bias: Bias toward TRUE_POSITIVE when failures are sustained from a'
        ' hostile source.ip with no legitimate success; bias toward FALSE_POSITIVE when a handful'
        ' of failures precede a normal success from a known user/host.\n'
        '---\n'
    ),
    "cloud_identity_compromise": (
        '---\n'
        'id: cloud_identity_compromise\n'
        'name: Cloud identity compromise\n'
        'version: 1\n'
        'description: Investigate anomalous role assumptions, OAuth tokens, access keys, and'
        ' service-principal sessions.\n'
        'priority: 82\n'
        'rule_ids: [cloud_iam_anomaly, iam_role_assumption, oauth_token_replay,'
        ' risky_service_principal_signin, impossible_travel, identity_signin]\n'
        'entity_types: [user, host, ip, rule]\n'
        'mitre: [T1078, T1098, T1550.001]\n'
        'any_tags: [cloud, iam, identity, oauth]\n'
        'suggested_tools: [es_query, enrich, rag_retrieve]\n'
        'rag_queries: [cloud IAM compromise, OAuth token replay, suspicious role assumption]\n'
        'escalate_if: A successful unexpected session changes privileges or credentials, grants'
        ' consent, or accesses sensitive resources.\n'
        'suggested_verdict_bias: Require successful activity plus identity, session, and'
        ' authorization evidence; unusual geography or reputation alone is not compromise.\n'
        '---\n'
    ),
    "data_exfiltration_response": (
        '---\n'
        'id: data_exfiltration_response\n'
        'name: Data exfiltration response\n'
        'version: 1\n'
        'description: Investigate abnormal sensitive-data collection, staging, and transfer to an'
        ' external destination.\n'
        'priority: 88\n'
        'rule_ids: [data_exfiltration, bulk_data_download, cloud_storage_exfiltration,'
        ' dns_tunneling, loan_api_access]\n'
        'entity_types: [user, host, ip, rule]\n'
        'mitre: [T1020, T1041, T1048, T1530]\n'
        'any_tags: [exfil, staging, bulk-download, dns-tunnel]\n'
        'suggested_tools: [es_query, enrich, rag_retrieve]\n'
        'rag_queries: [data exfiltration response, sensitive data staging, unusual outbound'
        ' transfer]\n'
        'escalate_if: Sensitive data reached an unapproved external destination or access and'
        ' transfer evidence indicates unauthorized loss.\n'
        'suggested_verdict_bias: Volume is not sufficient by itself; require data sensitivity,'
        ' authorization, destination, and transfer-outcome evidence.\n'
        '---\n'
    ),
    "phishing_reported_email": (
        '---\n'
        'id: phishing_reported_email\n'
        'name: Reported phishing email\n'
        'version: 1\n'
        'description: A user-reported phishing message \u2014 scope reach, reputation, and follow-on.\n'
        'match:\n'
        '  rule_ids: [postfix, roundcube_login, mail_auth, mail_apache_access, suricata_mail]\n'
        '  entity_types: [user, ip]\n'
        '  mitre: [T1566]\n'
        '  any_tags: [mail, phishing, email]\n'
        'priority: 45\n'
        'suggested_tools: [enrich, es_query, rag_retrieve]\n'
        'rag_queries:\n'
        '  - phishing triage runbook\n'
        '  - MITRE T1566 phishing\n'
        '  - malicious URL and attachment reputation triage\n'
        'escalate_if: A recipient clicked the link or opened the attachment AND a subsequent'
        ' authentication for that user.name originates from a new/unexpected source.ip \u2014 treat as'
        ' likely credential compromise and escalate.\n'
        'suggested_verdict_bias: Bias toward TRUE_POSITIVE when sender source.ip or embedded'
        ' url.original has hostile reputation and the message reached real mailboxes; bias toward'
        ' FALSE_POSITIVE for a benign newsletter/marketing message a user mis-reported.\n'
        '---\n'
    ),
    "privileged_web_access": (
        '---\n'
        'id: privileged_web_access\n'
        'name: Privileged web access\n'
        'version: 1\n'
        'description: Exact procedure for successful external access to administrative web'
        ' surfaces.\n'
        'priority: 85\n'
        'match:\n'
        '  rule_ids: [external_admin_panel_access]\n'
        '  entity_types: [ip, user, host, rule]\n'
        'suggested_tools: [es_query, enrich, rag_retrieve]\n'
        'rag_queries: [privileged web access response, administrative login verification]\n'
        'escalate_if: The successful access is unauthorized, originates from hostile'
        ' infrastructure, or is followed by privileged changes.\n'
        'suggested_verdict_bias: A successful external administrative login requires identity and'
        ' change evidence; source reputation alone is not a verdict.\n'
        '---\n'
    ),
    "ransomware_response": (
        '---\n'
        'id: ransomware_response\n'
        'name: Ransomware impact response\n'
        'version: 1\n'
        'description: Investigate mass encryption, destructive file changes, and related'
        ' command-and-control activity.\n'
        'priority: 92\n'
        'rule_ids: [ransomware_behavior, mass_file_encryption, ransomware_encryption,'
        ' endpoint_ransomware, file_encryption_burst]\n'
        'entity_types: [host, user, ip, rule]\n'
        'mitre: [T1486, T1490, T1071]\n'
        'any_tags: [ransomware, encryption, impact]\n'
        'suggested_tools: [es_query, enrich, rag_retrieve]\n'
        'rag_queries: [ransomware containment, mass file encryption, inhibit system recovery]\n'
        'escalate_if: Encryption or destructive modification is active, containment failed, or'
        ' multiple hosts or shared repositories are affected.\n'
        'suggested_verdict_bias: Treat high-rate file changes as impact only when process lineage,'
        ' file behavior, containment, and affected scope corroborate it.\n'
        '---\n'
    ),
    "suspicious_outbound_connection": (
        '---\n'
        'id: suspicious_outbound_connection\n'
        'name: Suspicious outbound / beacon-like connection\n'
        'version: 1\n'
        'description: Beacon-like egress or outbound traffic to flagged infrastructure.\n'
        'match:\n'
        '  rule_ids: [suricata_mail, ml_stats]\n'
        '  entity_types: [ip, host]\n'
        '  mitre: [T1071]\n'
        '  min_event_count: 3\n'
        '  any_tags: [network, egress, beacon, c2]\n'
        'priority: 40\n'
        'suggested_tools: [enrich, es_query, rag_retrieve]\n'
        'rag_queries:\n'
        '  - C2 beacon detection\n'
        '  - MITRE T1071 application layer protocol C2\n'
        '  - outbound traffic reputation triage\n'
        'escalate_if: The destination.ip is confirmed-malicious (threat-intel hit) and outbound'
        ' contact shows regular periodicity from one or more internal host.name \u2014 treat as active'
        ' C2 and escalate.\n'
        'suggested_verdict_bias: Bias toward TRUE_POSITIVE when cadence is regular and'
        ' destination.ip reputation is hostile; bias toward FALSE_POSITIVE when the destination is'
        ' a known SaaS/update/CDN endpoint with naturally periodic traffic.\n'
        '---\n'
    ),
    "web_application_abuse": (
        '---\n'
        'id: web_application_abuse\n'
        'name: Web application abuse\n'
        'version: 1\n'
        'description: Exact procedures for application session, privileged-administration, upload,'
        ' and enumeration alert families.\n'
        'priority: 80\n'
        'match:\n'
        '  rule_ids: [web_app_endpoint_abuse, web_app_session_token_reuse,'
        ' web_app_dangerous_file_upload, web_app_path_enumeration,'
        ' web_app_privileged_admin_action, web_app_sensitive_data_access]\n'
        '  entity_types: [ip, user, host, rule]\n'
        'suggested_tools: [es_query, enrich, rag_retrieve]\n'
        'rag_queries: [web application incident response, application session abuse, application'
        ' administrative activity]\n'
        'escalate_if: Confirmed account misuse, destructive administration, executable upload, or'
        ' sustained service impact.\n'
        'suggested_verdict_bias: Require corroborating authentication, application, and'
        ' authorization evidence; automation alone is not compromise.\n'
        '---\n'
    ),
    "web_scanner_activity": (
        '---\n'
        'id: web_scanner_activity\n'
        'name: Web scanner and exploit activity\n'
        'version: 1\n'
        'description: Exact procedure for vulnerability scanning and web-shell or PHP execution'
        ' alert families.\n'
        'priority: 75\n'
        'match:\n'
        '  rule_ids: [automated_vulnerability_scanning, suspicious_web_shell_execution]\n'
        '  entity_types: [ip, host, rule]\n'
        'suggested_tools: [es_query, enrich, rag_retrieve]\n'
        'rag_queries: [web scanner triage, web shell response, approved vulnerability assessment]\n'
        'escalate_if: A scanner achieves execution, creates a file or process, or is not'
        ' attributable to an approved assessment.\n'
        'suggested_verdict_bias: Scanner signatures require approval and outcome evidence;'
        ' confirmed server-side execution is high risk.\n'
        '---\n'
    ),
    "brute_force": (
        '---\n'
        'id: brute_force\n'
        'title: SSH / credential brute force\n'
        'applies_to_rules: [sshd, linux_auth, postfix, winlogon]\n'
        'applies_to_techniques: [T1110, T1078]\n'
        'applies_to_entities: [ip, user]\n'
        'keywords: [ssh, brute, failed password, auth, login, credential, 4625]\n'
        'persona: identity_access\n'
        'summary: A burst of failed authentications from one source against a host or user.\n'
        '---\n'
    ),
    "cloud_iam_compromise": (
        '---\n'
        'id: cloud_iam_compromise\n'
        'title: Cloud IAM session and credential compromise\n'
        'applies_to_rules: [cloud_iam_anomaly, iam_role_assumption, oauth_token_replay,'
        ' risky_service_principal_signin, impossible_travel]\n'
        'applies_to_techniques: [T1078, T1098, T1550.001]\n'
        'applies_to_entities: [user, host, ip]\n'
        'keywords: [cloudtrail, assume role, iam, oauth token, service principal, access key,'
        ' conditional access]\n'
        'persona: cloud_identity\n'
        'summary: Triage anomalous cloud sessions, role assumptions, tokens, access keys, and'
        ' service-principal activity.\n'
        '---\n'
    ),
    "data_exfiltration": (
        '---\n'
        'id: data_exfiltration\n'
        'title: Data staging and exfiltration\n'
        'applies_to_rules: [data_exfiltration, bulk_data_download, cloud_storage_exfiltration,'
        ' dns_tunneling, loan_api_access]\n'
        'applies_to_techniques: [T1020, T1041, T1048, T1530]\n'
        'applies_to_entities: [user, host, ip]\n'
        'keywords: [exfiltration, data staging, bulk download, archive, personal address, dns'
        ' tunneling, cloud storage]\n'
        'persona: data_protection\n'
        'summary: Triage abnormal data collection, staging, transfer, and access to sensitive'
        ' repositories.\n'
        '---\n'
    ),
    "ip_reputation": (
        '---\n'
        'id: ip_reputation\n'
        'title: Known-bad source IP (threat-intel reputation)\n'
        'applies_to_rules: [enrichment]\n'
        'applies_to_techniques: [T1071]\n'
        'applies_to_entities: [ip]\n'
        'keywords: [reputation, abuseipdb, virustotal, malicious_ip, blocklist, ioc, threatfeed]\n'
        'persona: threat_intel\n'
        'summary: Enrichment flags the source IP as known-bad; pivot on the IP across the estate.\n'
        '---\n'
    ),
    "mail_abuse": (
        '---\n'
        'id: mail_abuse\n'
        'title: Suspicious mail activity (Postfix)\n'
        'applies_to_rules: [postfix]\n'
        'applies_to_techniques: [T1566]\n'
        'applies_to_entities: [ip]\n'
        'keywords: [postfix, smtp, relay, recipient, spam, mail]\n'
        'persona: identity_access\n'
        'summary: High-volume relay attempts, rejected recipients, or submission auth failures.\n'
        '---\n'
    ),
    "malware": (
        '---\n'
        'id: malware\n'
        'title: Malware / C2 detection\n'
        'applies_to_rules: [clamav, defender, crowdstrike, edr]\n'
        'applies_to_techniques: [T1071, T1059, T1547]\n'
        'applies_to_entities: [host, ip]\n'
        'keywords: [malware, virus, yara, trojan, ransom, c2, beacon, miner, backdoor, quarantine]\n'
        'persona: malware\n'
        'summary: An endpoint/AV/EDR detection of malicious code or C2 activity.\n'
        '---\n'
    ),
    "port_scan": (
        '---\n'
        'id: port_scan\n'
        'title: Port scan / network reconnaissance\n'
        'applies_to_rules: [suricata, et_scan]\n'
        'applies_to_techniques: [T1046, T1595]\n'
        'applies_to_entities: [ip]\n'
        'keywords: [suricata, et scan, scan, nmap, port, recon, probe, sweep, masscan]\n'
        'persona: network_recon\n'
        'summary: Many connection attempts to distinct ports/hosts from one source IP.\n'
        '---\n'
    ),
    "vuln_scan": (
        '---\n'
        'id: vuln_scan\n'
        'title: Vulnerability scanning (Nessus / OpenVAS / nikto)\n'
        'applies_to_rules: [nessus-openvas, nessus, openvas, nikto]\n'
        'applies_to_techniques: [T1595]\n'
        'applies_to_entities: [ip]\n'
        'keywords: [nessus, openvas, nikto, vuln, scanner, cve probe]\n'
        'persona: network_recon\n'
        'summary: Bursts of varied requests probing known CVEs and default paths from one IP.\n'
        '---\n'
    ),
    "web_attack": (
        '---\n'
        'id: web_attack\n'
        'title: Web application attack (WAF / ModSecurity)\n'
        'applies_to_rules: [modsecurity, modsec_audit_log, nginx, apache]\n'
        'applies_to_techniques: [T1190]\n'
        'applies_to_entities: [ip]\n'
        'keywords: [modsec, waf, sqli, xss, lfi, rfi, traversal, owasp, http, web, "941"]\n'
        'persona: web_application\n'
        'summary: A WAF/ModSec rule fired on a request to a public-facing web app.\n'
        '---\n'
    ),
}


@pytest.mark.parametrize("name", sorted(LEGACY_FRONT_MATTER))
def test_parse_frontmatter_reads_every_retired_bundled_document(name: str) -> None:
    text = LEGACY_FRONT_MATTER[name] + "## Body\nText.\n"
    meta = _assert_keeps_retired_keys(text)
    assert meta["id"] == name
    assert meta.get("title") or meta.get("name")


def test_parse_frontmatter_reads_folded_and_block_scalars() -> None:
    folded = ("---\nid: my_brute\nname: Brute force on the mail gateway\n"
              "description: Repeated failed authentications or password spray\n  against the mail gateway.\n"
              "match:\n  rule_ids: [sshd]\n  min_event_count: 5\npriority: 60\n---\n## Objective\nDecide.\n")
    meta = _assert_keeps_retired_keys(folded, extended=("description",))
    assert meta["description"] == "Repeated failed authentications or password spray against the mail gateway."
    assert meta["match"] == {"rule_ids": ("sshd",), "min_event_count": "5"}
    assert (meta["id"], meta["name"], meta["priority"]) == ("my_brute", "Brute force on the mail gateway", "60")

    block = ("---\nid: blocky\ndescription: >\n  Repeated failed authentications\n  against accounts.\n\n"
             "  Second paragraph.\nnotes: |\n  line one\n  line two\nmatch:\n  rule_ids:\n    - sshd\n"
             "    - linux_auth\npriority: 50\n---\nbody\n")
    meta, body = RM.parse_frontmatter(block)
    assert meta["description"] == "Repeated failed authentications against accounts.\nSecond paragraph."
    assert meta["notes"] == "line one\nline two"
    assert meta["match"] == {"rule_ids": ("sshd", "linux_auth")}
    assert (meta["id"], meta["priority"], body) == ("blocky", "50", "body")
    old, _ = retired_parse_frontmatter(block)
    assert (old["description"], old["rule_ids"]) == (">", ("sshd", "linux_auth"))  # the retired reader lost both


def test_parse_frontmatter_stays_linear_on_long_legacy_documents() -> None:
    # The retired stores held documents of up to 256 KiB; both readers stay linear.
    text = "---\nid: big\n" + "".join(f"k{i}: [a, \"b, c\", 'it''s']\n" for i in range(12_000)) + "---\nbody"
    assert len(text.encode("utf-8")) > 256 * 1024
    meta, body = _fast(lambda: RM.parse_frontmatter(text), budget=2.0)
    assert meta["id"] == "big" and body == "body" and meta["k11999"] == ("a", "b, c", "it's")
    broken = text.replace("k5: ", "k5 broken line\nk5: ", 1).replace("id: big", "id: big\nid: again", 1)
    meta, _ = _fast(lambda: RM.parse_frontmatter(broken), budget=2.0)
    assert meta["id"] == "again" and meta["k11999"] == ("a", "b, c", "it's")


# --------------------------------------------------------------------------- #
# Final review fixes (WP-A3): folded values are joined once; validation stops
# where nothing more could be reported
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("first", ["id: [\n", "id: big\n"], ids=["stray-line", "folded-only"])
def test_a_long_folded_value_is_read_in_linear_time(first: str) -> None:
    # Each continuation line used to copy the whole value read so far: 1 MiB took
    # about 3 s. The strict reader refuses continuation lines, so a document without
    # a stray line takes the lenient path too.
    lines = 100_000
    text = "---\n" + first + "description: start\n" + " a\n" * lines + "---\nbody"
    assert len(text.encode("utf-8")) > 256 * 1024
    meta, body = _fast(lambda: RM.parse_frontmatter(text))
    assert meta["description"] == "start" + " a" * lines and body == "body"


@pytest.mark.parametrize(("front", "expected"), [
    ("d: a\n  b\n  c\nother: x\n  d\n", {"d": "a b c", "other": "x d"}),   # a key line ends the run
    ("d: a\n  b\nstray\n  c\n", {"d": "a b"}),                              # so does a stray line
    ("d: a\n  b\nd: c\n", {"d": "c"}),                                      # the last repeat wins
    ("d: a\n  b\n\n  # note\n  c\n", {"d": "a b c"}),                       # blanks and comments skip
    ("d: a\n: x\n  b\n", {"d": "a b"}),                                     # a line with no key skips
    ("d: 'a'\n  b\n", {"d": "a"}),                                          # quoted values never fold
    ("d: [a, b]\n  c\n", {"d": ("a", "b")}),                                # nor lists
    ("d: a\n  b\n  - c\n  e\n", {"d": "a b e"}),                            # a list item is skipped
    ("p:\n  k: v\n  more\n", {"p": {"k": "v"}}),
], ids=["key-line", "stray", "repeat", "blank-comment", "no-key", "quoted", "list", "item", "nested"])
def test_folded_values_keep_the_lenient_readers_shape(front: str, expected: dict[str, object]) -> None:
    meta, body = RM.parse_frontmatter("---\n" + front + "---\nbody")
    assert meta == expected and body == "body"


def _within_transport(defn: RunbookDefinition) -> RunbookDefinition:
    assert len(RM.canonical_definition_json(defn)) <= RM.RUNBOOK_MAX_DEFINITION_CHARS
    return defn


def _check_step() -> list[RunbookStep]:
    return [RunbookStep(id="a", title="Is it real?", kind="check", phase="triage")]


_AT_THE_TRANSPORT_BOUND = {
    "skips": lambda: _defn(steps=[RunbookStep(
        id="d", title="Is it real?", kind="decision", phase="triage",
        options=[DecisionOption(id="o", label="Yes", marks_not_applicable=[str(j % 10) for j in range(64_000)]),
                 DecisionOption(id="p", label="No")])]),
    "duplicate-rules": lambda: _defn(applies_when=AppliesWhen(rule_ids=["a"] * 64_000), steps=_check_step()),
    "empty-tags": lambda: _defn(applies_when=AppliesWhen(any_tags=[""] * 64_000), steps=_check_step()),
    "bad-techniques": lambda: _defn(mitre=["x"] * 52_000, steps=_check_step()),
    "bad-references": lambda: _defn(references=["x"] * 52_000, steps=_check_step()),
    "bad-filters": lambda: _defn(steps=[_step(kind="lookup", lookup=LookupTemplate(
        tool="log_search", filter={f"!{i}": "x" for i in range(20_000)}))]),
    "duplicate-group-by": lambda: _defn(steps=[_step(kind="lookup", lookup=LookupTemplate(
        tool="log_stats", filter={"event.outcome": "failure"}, group_by=["user.name"] * 20_000))]),
    "bad-steps": lambda: _defn(steps=[_step(id=f"Bad {i}", title="") for i in range(900)]),
}


@pytest.mark.parametrize("shape", sorted(_AT_THE_TRANSPORT_BOUND))
def test_validation_at_the_transport_bound_stops_at_the_issue_cap(shape: str, monkeypatch) -> None:
    # Every issue used to be built before the list was cut: 64,000 skips took 0.76 s.
    # The work is measured by counting the issues the validator builds (in this module
    # and in the lookup checks), not by a clock, so CPU load cannot fail the test. In
    # every shape each value the validator reads builds at least one issue, so the
    # count also bounds how far it reads.
    from app.engine import runbook_lookup

    built = 0

    def counted(**fields: object) -> RunbookIssue:
        nonlocal built
        built += 1
        return RunbookIssue(**fields)

    monkeypatch.setattr(RM, "RunbookIssue", counted)
    monkeypatch.setattr(runbook_lookup, "RunbookIssue", counted)
    defn = _within_transport(_AT_THE_TRANSPORT_BOUND[shape]())
    issues = RM.validate_runbook(defn)
    assert len(issues) == RM.RUNBOOK_MAX_ISSUES + 1
    assert issues[-1].code == "more_issues" and [i.code for i in issues].count("more_issues") == 1
    # The cap, at most the two issues of the value read last, and the closing
    # "more_issues": tens of thousands of values in, a few hundred issues out.
    assert len(issues) <= built <= RM.RUNBOOK_MAX_ISSUES + 3, built


def test_stopping_at_the_cap_reports_the_same_issues() -> None:
    # Issues are listed in a fixed order (rules before steps), so stopping early
    # returns exactly the first 200 of the full list.
    rules = AppliesWhen(rule_ids=["r"] * 150)
    bad_steps = [_step(id=f"Bad {i}") for i in range(100)]
    rule_issues = RM.validate_runbook(_defn(applies_when=rules))
    step_issues = RM.validate_runbook(_defn(steps=bad_steps))
    assert (len(rule_issues), len(step_issues)) == (150, 101)  # too_many + 149 repeats; too_many + 100 ids
    combined = RM.validate_runbook(_defn(applies_when=rules, steps=bad_steps))
    assert combined[:-1] == (rule_issues + step_issues)[:RM.RUNBOOK_MAX_ISSUES]
    assert combined[-1].code == "more_issues"


def test_a_list_over_its_limit_is_read_only_so_far_past_it() -> None:
    limit = RM.RUNBOOK_APPLIES_MAX_RULES
    rules = [f"r{i}" for i in range(limit + RM.RUNBOOK_MAX_ISSUES + 10)]
    last_read = limit + RM.RUNBOOK_MAX_ISSUES - 1
    rules[last_read] = "r0"       # the last value read: its repeat is reported
    rules[last_read + 1] = "r1"   # one past it: not read
    issues = RM.validate_runbook(_defn(applies_when=AppliesWhen(rule_ids=rules)))
    assert [(i.path, i.code) for i in issues] == [
        ("applies_when.rule_ids", "too_many"),
        (f"applies_when.rule_ids[{last_read}]", "duplicate"),
    ]
    assert issues[0].message == f"Applies when lists {len(rules)} rules; the limit is {limit}."


# --------------------------------------------------------------------------- #
# The source size limit is measured on what an export writes
# --------------------------------------------------------------------------- #
def _sized_definition(target_bytes: int) -> RunbookDefinition:
    """A 40-step operator definition whose export at the widest version label is
    exactly ``target_bytes`` long (the instructions of the filler steps take up the
    difference; they never reach the prompt, so the budget is unaffected)."""
    base = RM.builtin_runbook("generic-incident").definition.model_copy(update={"id": "big_rb"})
    steps = list(base.steps)
    para = "Write down what happened and who did what. " * 46
    # A focus line in the Close phase is not in the investigator rendering (later
    # phases list step titles only), so it grows the source without the budget.
    filler = [_step(id=f"x{k}", phase="close", kind="record", title=f"Note {k}", instructions=para.strip(),
                    focus="Look at the notes and the ticket history.")
              for k in range(RM.RUNBOOK_MAX_STEPS - len(steps))]
    defn = base.model_copy(update={"steps": steps[:-1] + filler + steps[-1:]})
    size = len(RM.export_runbook_markdown(defn, version=RM.MAX_RUNBOOK_VERSIONS).encode())
    over = size - target_bytes
    assert 0 < over < 1_900
    first = filler[0].model_copy(update={"instructions": "x" * (len(para.strip()) - over)})
    defn = base.model_copy(update={"steps": steps[:-1] + [first, *filler[1:]] + steps[-1:]})
    assert len(RM.export_runbook_markdown(defn, version=RM.MAX_RUNBOOK_VERSIONS).encode()) == target_bytes
    return defn


def test_a_definition_accepted_without_a_version_exports_and_imports_at_any_version() -> None:
    # Export writes "version: N"; the check measures the export with the widest label
    # a runbook can carry, so the editor's live check and a draft save never accept a
    # definition whose export at a later version cannot be imported back.
    limit = RM.RUNBOOK_MAX_SOURCE_BYTES
    at_limit = _sized_definition(limit)
    assert RM.validate_runbook(at_limit) == []
    for version in (1, 9, 12, 99, RM.MAX_RUNBOOK_VERSIONS):
        exported = RM.export_runbook_markdown(at_limit, version=version)
        definition, parsed_version, issues = RM.parse_and_validate(exported)
        assert issues == [] and parsed_version == version, version
        assert definition == RM.normalise_definition(at_limit), version
    # Without the version line the export is smaller, yet one byte more at the widest
    # label is refused.
    assert len(RM.export_runbook_markdown(at_limit).encode()) < limit
    one_over = _sized_definition(limit + 1)
    issues = RM.validate_runbook(one_over)
    assert [i.code for i in issues] == ["source_too_large"]
    assert issues[0].message == f"The Markdown source is {limit + 1:,} bytes; the limit is {limit:,}."
    # Measured at the version that is given, when one is given.
    assert RM.validate_runbook(one_over, version=3) == []


# --------------------------------------------------------------------------- #
# run_playbook automation targets (SPEC §4.10.16)
# --------------------------------------------------------------------------- #
def test_automation_resolves_through_the_id_map_before_the_bundled_map() -> None:
    """SPEC §4.10.16: ``runbook_id``, else ``playbook_id`` through the migration's id
    map, else through ``LEGACY_BUNDLED_RUNBOOK_MAP``: one order, the one
    ``ThresholdAutomation`` uses."""
    resolve = RM.resolve_automation_runbook_id
    # An operator procedure through the migrated ids.
    migrated = {"my_procedure": "my_procedure", "malware": "malware-imported"}
    assert resolve({"playbook_id": "my_procedure"}, migrated) == "my_procedure"
    # The id map comes first for every id, a retired reference runbook id included.
    assert resolve({"playbook_id": "malware"}, migrated) == "malware-imported"
    # A retired bundled playbook id is in the map only when a configured folder's
    # file held it, the procedure the rule ran: the map wins for it too.
    for legacy in sorted(RM.LEGACY_BUNDLED_PLAYBOOK_IDS):
        assert resolve({"playbook_id": legacy}, {legacy: f"{legacy}-imported"}) == f"{legacy}-imported"
    # With no migrated entry the built-in that merged it is the target, also before
    # the migration has run.
    for legacy in sorted(RM.LEGACY_BUNDLED_RUNBOOK_MAP):
        assert resolve({"playbook_id": legacy}, {}) == RM.LEGACY_BUNDLED_RUNBOOK_MAP[legacy]
        assert resolve({"playbook_id": legacy}) == RM.LEGACY_BUNDLED_RUNBOOK_MAP[legacy]
    assert resolve({"playbook_id": "port_scan"}, {}) == "scanning-reconnaissance"
    # The rule editor's runbook_id always wins.
    assert resolve({"runbook_id": "my-runbook", "playbook_id": "brute_force_login"},
                   {"brute_force_login": "brute_force_login-imported"}) == "my-runbook"
    # Nothing resolvable.
    assert resolve({"playbook_id": "unknown"}, migrated) is None
    assert resolve({}, migrated) is None and resolve(None) is None and resolve({"playbook_id": 3}) is None
    assert resolve({"playbook_id": "x"}, ["not", "a", "map"]) is None
    assert resolve({"playbook_id": "x"}, {"x": " "}) is None
    assert resolve({"playbook_id": "port_scan"}, {"port_scan": "  "}) == "scanning-reconnaissance"
    assert resolve({"runbook_id": "  ", "playbook_id": " port_scan "}) == "scanning-reconnaissance"


def test_a_shadowed_copy_of_a_bundled_playbook_never_wins_through_the_real_id_map() -> None:
    """Before Round 14 a bundled playbook always won an id collision, so a rule naming
    ``brute_force_login`` ran the bundled procedure, and the stored operator document
    with that id (migrated to the Draft ``brute_force_login-imported``) never ran.
    ``migrated_procedure_ids`` leaves that document out, so the id-map-first order
    still resolves to the built-in; a configured folder's file with the id did run,
    and is kept."""
    from app.engine.runbook_migration import migrated_procedure_ids

    resolve = RM.resolve_automation_runbook_id
    stored_copy = migrated_procedure_ids({"id_map": {"playbooks:brute_force_login": "brute_force_login-imported"}})
    assert resolve({"playbook_id": "brute_force_login"}, stored_copy) == "brute-force-password-spray"
    folder_file = migrated_procedure_ids({"id_map": {"playbook_dir:brute_force_login": "brute_force_login-dir"}})
    assert resolve({"playbook_id": "brute_force_login"}, folder_file) == "brute_force_login-dir"


def test_the_retired_bundled_playbook_ids() -> None:
    assert len(RM.LEGACY_BUNDLED_PLAYBOOK_IDS) == 9
    assert RM.LEGACY_BUNDLED_PLAYBOOK_IDS < set(RM.LEGACY_BUNDLED_RUNBOOK_MAP)
    assert RM.LEGACY_BUNDLED_PLAYBOOK_IDS < RM.SHADOWING_IDS
    assert "brute_force_login" in RM.LEGACY_BUNDLED_PLAYBOOK_IDS and "malware" not in RM.LEGACY_BUNDLED_PLAYBOOK_IDS


# --------------------------------------------------------------------------- #
# The Markdown key sets and the normaliser follow the shared models
# --------------------------------------------------------------------------- #
def test_the_markdown_key_sets_name_every_model_field() -> None:
    # models.py is shared and grows additively; a new field must fail a test here
    # until the parser, the export and the normaliser carry it, instead of silently
    # disappearing from stored runbooks, their hash and their export.
    assert set(AppliesWhen.model_fields) == set(RM.APPLIES_WHEN_KEYS)
    assert set(LookupTemplate.model_fields) == set(RM.LOOKUP_KEYS)
    assert set(RunbookDefinition.model_fields) == (set(RM.FRONT_MATTER_KEYS) - {"version"}) | {"phases", "steps"}
    assert set(DecisionOption.model_fields) == {"id", "label", "marks_not_applicable"}  # "- id: label | skips:"
    heading = {"#id": "id", "kind": "kind", "optional": "required", "owner": "owner_role",
               "approval": "approval_role", "evidence": "evidence", "target": "target_minutes",
               "react": "react", "d3fend": "d3fend"}
    assert set(heading) - {"#id"} == set(RM.STEP_ATTRIBUTES)
    key_lines = {"Focus": "focus", "Escalate if": "escalate_if", "Benign if": "benign_if", "Options": "options"}
    assert set(key_lines) == set(RM.STEP_KEY_LINES)
    structural = {"phase", "title", "lookup", "instructions"}  # "## Phase", "### Title", ```lookup, the body
    covered = set(heading.values()) | set(key_lines.values()) | structural
    assert covered == set(RunbookStep.model_fields)


def test_normalise_keeps_every_nested_field_it_does_not_clean() -> None:
    # The normaliser copies each nested model rather than rebuilding it field by
    # field, so a field it does not know (a later additive one) survives it.
    class WiderAppliesWhen(AppliesWhen):
        future: str = ""

    class WiderLookup(LookupTemplate):
        future: str = ""

    class WiderOption(DecisionOption):
        future: str = ""

    base = _tricky()
    steps = []
    for step in base.steps:
        update: dict = {}
        if step.lookup is not None:
            update["lookup"] = WiderLookup(**step.lookup.model_dump(), future="kept")
        if step.options:
            update["options"] = [WiderOption(**o.model_dump(), future="kept") for o in step.options]
        steps.append(step.model_copy(update=update))
    wide = base.model_copy(update={
        "applies_when": WiderAppliesWhen(**base.applies_when.model_dump(), future="kept"), "steps": steps})
    clean = RM.normalise_definition(wide)
    assert clean.applies_when.future == "kept"
    assert all(s.lookup.future == "kept" for s in clean.steps if s.lookup is not None)
    assert all(o.future == "kept" for s in clean.steps for o in s.options)
    assert any(s.lookup is not None for s in clean.steps) and any(s.options for s in clean.steps)
    # And the cleaning itself is unchanged.
    assert RM.normalise_definition(base) == base
