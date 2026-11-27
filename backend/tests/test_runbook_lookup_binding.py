"""Runbook lookups: validation and parameter binding (Round 14 SPEC §4.10.8, WP-A3).

Pins the closed template-value set, the per-tool rules, the window grammar and the
30-day bound, and that binding resolves every case value into a STRUCTURED parameter
(never query text) or into a plain not-applicable reason, with the window cut to the
moment the lookup ran.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.constants import CaseStatus, EntityType, SourceSurface
from app.engine import runbook_lookup as L
from app.models import RUNBOOK_DEFAULT_LOOKUP_WINDOW, RUNBOOK_TEMPLATE_VALUES, Case, Cluster, Entity, LookupTemplate, RawEvent, TriggerReason

NOW = datetime(2026, 10, 26, 14, 31, tzinfo=timezone.utc)
FIRST = datetime(2026, 10, 26, 12, 52, tzinfo=timezone.utc)
LAST = datetime(2026, 10, 26, 13, 40, tzinfo=timezone.utc)
OWNER = "Step 'How many accounts were tried?'"


def _values(**entities: tuple[str, ...]) -> L.CaseValues:
    return L.CaseValues(rule="ssh_auth_failed", source_id="src-1", first_seen=FIRST, last_seen=LAST,
                        entities=entities)


def _codes(issues) -> list[str]:
    return [i.code for i in issues]


# --------------------------------------------------------------------------- #
# The closed template set
# --------------------------------------------------------------------------- #
def test_template_set_is_the_closed_spec_set() -> None:
    assert set(RUNBOOK_TEMPLATE_VALUES) == {
        "case.rule", "case.source_id", "case.first_seen", "case.last_seen", "entity.ip", "entity.user",
        "entity.host", "entity.domain", "entity.hash", "entity.url", "entity.email",
    }
    assert set(L.TEMPLATE_NOUNS) == set(RUNBOOK_TEMPLATE_VALUES)
    assert set(L.INDICATOR_TEMPLATE_VALUES) <= set(RUNBOOK_TEMPLATE_VALUES)
    assert "entity.user" not in L.INDICATOR_TEMPLATE_VALUES


def test_template_name_accepts_only_a_whole_single_template() -> None:
    assert L.template_name("{{entity.ip}}") == "entity.ip"
    assert L.template_name("  {{ entity.ip }}  ") == "entity.ip"
    assert L.template_name("x-{{entity.ip}}") is None
    assert L.template_name("{{entity.ip}}{{entity.user}}") is None
    assert L.template_name("entity.ip") is None
    assert L.template_name(None) is None


def test_unknown_template_message_is_the_spec_sentence() -> None:
    msg = L.unknown_template_message(OWNER, "entity.ipaddr")
    assert msg == ("Step 'How many accounts were tried?' uses {{entity.ipaddr}}, which is not a case value. "
                   "Use {{entity.ip}}.")
    assert L.suggest_template("entity.hostname") == "entity.host"
    assert L.suggest_template("case.rul") == "case.rule"
    # With nothing close, the sentence lists the closed set.
    assert "{{entity.email}}" in L.unknown_template_message("This lookup", "zzz.qqq")


# --------------------------------------------------------------------------- #
# Validation per tool
# --------------------------------------------------------------------------- #
def test_a_valid_log_stats_lookup_has_no_issues() -> None:
    lookup = LookupTemplate(tool="log_stats", filter={"source.ip": "{{entity.ip}}", "event.outcome": "failure"},
                            group_by=["user.name"])
    assert L.validate_lookup(lookup, owner=OWNER) == []


def test_unknown_template_value_is_named_with_its_fix() -> None:
    lookup = LookupTemplate(tool="log_stats", filter={"source.ip": "{{entity.ipaddr}}"})
    issues = L.validate_lookup(lookup, path="steps[1].lookup", owner=OWNER)
    assert _codes(issues) == ["template_value"]
    assert issues[0].path == "steps[1].lookup.filter.source.ip"
    assert issues[0].message.endswith("Use {{entity.ip}}.")


@pytest.mark.parametrize("tool", ["log_stats", "log_search"])
def test_log_tools_need_a_filter(tool: str) -> None:
    issues = L.validate_lookup(LookupTemplate(tool=tool), owner=OWNER)
    assert "required" in _codes(issues)


def test_log_search_rows_are_capped_at_20_and_cannot_group() -> None:
    lookup = LookupTemplate(tool="log_search", filter={"host.name": "{{entity.host}}"}, limit=21,
                            group_by=["user.name"])
    codes = _codes(L.validate_lookup(lookup, owner=OWNER))
    assert "too_many" in codes and "not_allowed" in codes


def test_group_by_is_log_stats_only_at_most_two_and_unique() -> None:
    lookup = LookupTemplate(tool="log_stats", filter={"source.ip": "{{entity.ip}}"},
                            group_by=["user.name", "user.name", "host.name"])
    codes = _codes(L.validate_lookup(lookup, owner=OWNER))
    assert "too_many" in codes and "duplicate" in codes


def test_at_most_eight_filters() -> None:
    lookup = LookupTemplate(tool="log_stats", filter={f"field.f{i}": "x" for i in range(9)})
    assert "too_many" in _codes(L.validate_lookup(lookup, owner=OWNER))


@pytest.mark.parametrize("field", ["bad field", "*", "_omitted_fields", "a" * 129, "source..ip", ".x", "a;b",
                                   "source.ip\n", "user.name\r\n", "\nsource.ip"])
def test_field_names_follow_the_evidence_grammar(field: str) -> None:
    assert not L.is_field_name(field)
    lookup = LookupTemplate(tool="log_stats", filter={field: "x"})
    assert "invalid" in _codes(L.validate_lookup(lookup, owner=OWNER))


@pytest.mark.parametrize("field", ["source.ip", "event.outcome", "@timestamp", "http.response.status_code",
                                   "file.hash.sha256", "user_agent.original"])
def test_field_names_accepted(field: str) -> None:
    assert L.is_field_name(field)


def test_a_field_name_with_a_trailing_line_break_is_refused_in_filters_and_group_by() -> None:
    # Python's ``$`` also matches before a final newline; the whole value must fit.
    lookup = LookupTemplate(tool="log_stats", filter={"source.ip\n": "{{entity.ip}}"}, group_by=["user.name\n"])
    issues = L.validate_lookup(lookup, owner=OWNER)
    assert [(i.path, i.code) for i in issues] == [("lookup.filter.source.ip\n", "invalid"),
                                                  ("lookup.group_by[0]", "invalid")]
    assert all("\n" not in i.message for i in issues)
    assert isinstance(L.bind_lookup(lookup, _values(ip=("203.0.113.45",)), now=NOW), L.LookupNotApplicable)


@pytest.mark.parametrize("tool", ["log_stats", "log_search"])
@pytest.mark.parametrize("key", sorted(L.LOOKUP_SETTING_KEYS))
def test_a_filter_on_a_setting_name_is_refused(tool: str, key: str) -> None:
    # The resolved parameters hold the filters beside the lookup's own settings, so a
    # filter on one of those names would be overwritten in what is stored and audited.
    lookup = LookupTemplate(tool=tool, filter={"source.ip": "{{entity.ip}}", key: "5"})
    issues = L.validate_lookup(lookup, owner=OWNER)
    assert [(i.path, i.code) for i in issues] == [(f"lookup.filter.{key}", "not_allowed")]
    assert issues[0].message == (f"{OWNER} filters on '{key}', a name the lookup uses for its own settings. "
                                 f"Filter on another field.")
    bound = L.bind_lookup(lookup, _values(ip=("203.0.113.45",)), now=NOW)
    assert bound == L.LookupNotApplicable("This lookup has problems in its runbook, so it did not run.")


def test_resolved_parameters_hold_every_filter_and_setting() -> None:
    lookup = LookupTemplate(tool="log_stats", filter={"source.ip": "{{entity.ip}}", "event.outcome": "failure"},
                            group_by=["user.name"], limit=5)
    bound = L.bind_lookup(lookup, _values(ip=("203.0.113.45",)), now=NOW)
    assert bound.params == {"source.ip": "203.0.113.45", "event.outcome": "failure", "group_by": "user.name",
                            "limit": "5"}
    assert [f.key for f in bound.filters] == ["source.ip", "event.outcome"]


@pytest.mark.parametrize("value", ["", "   ", "x" * 257, "line\nbreak", "tab\there", "pre-{{entity.ip}}",
                                   "hidden​char"])
def test_literal_values_are_bounded_and_plain(value: str) -> None:
    lookup = LookupTemplate(tool="log_stats", filter={"event.outcome": value})
    assert L.validate_lookup(lookup, owner=OWNER), value


def test_enrich_needs_an_indicator_template_of_an_indicator_kind() -> None:
    assert "required" in _codes(L.validate_lookup(LookupTemplate(tool="enrich"), owner=OWNER))
    assert "invalid" in _codes(L.validate_lookup(LookupTemplate(tool="enrich", indicator="203.0.113.5"),
                                                 owner=OWNER))
    assert "not_allowed" in _codes(L.validate_lookup(LookupTemplate(tool="enrich", indicator="{{entity.user}}"),
                                                     owner=OWNER))
    assert "template_value" in _codes(L.validate_lookup(LookupTemplate(tool="enrich", indicator="{{entity.ipv4}}"),
                                                        owner=OWNER))
    for name in L.INDICATOR_TEMPLATE_VALUES:
        assert L.validate_lookup(LookupTemplate(tool="enrich", indicator="{{" + name + "}}"), owner=OWNER) == []


def test_enrich_takes_no_filters_and_only_enrich_takes_an_indicator() -> None:
    issues = L.validate_lookup(LookupTemplate(tool="enrich", indicator="{{entity.ip}}", filter={"a.b": "x"}),
                               owner=OWNER)
    assert _codes(issues) == ["not_allowed"]
    issues = L.validate_lookup(LookupTemplate(tool="log_stats", filter={"a.b": "x"}, indicator="{{entity.ip}}"),
                               owner=OWNER)
    assert _codes(issues) == ["not_allowed"]


def test_related_cases_and_campaign_keys() -> None:
    ok = LookupTemplate(tool="related_cases", filter={"entity": "{{entity.ip}}"})
    assert L.validate_lookup(ok, owner=OWNER) == []
    for rule in ("{{case.rule}}", "ssh_auth_failed"):
        lookup = LookupTemplate(tool="related_cases", filter={"rule": rule})
        assert L.validate_lookup(lookup, owner=OWNER) == []
    assert "required" in _codes(L.validate_lookup(LookupTemplate(tool="related_cases"), owner=OWNER))
    assert "not_allowed" in _codes(L.validate_lookup(
        LookupTemplate(tool="related_cases", filter={"host.name": "{{entity.host}}"}), owner=OWNER))
    assert "invalid" in _codes(L.validate_lookup(
        LookupTemplate(tool="related_cases", filter={"entity": "203.0.113.5"}), owner=OWNER))
    assert "not_allowed" in _codes(L.validate_lookup(
        LookupTemplate(tool="related_cases", filter={"entity": "{{case.rule}}"}), owner=OWNER))
    assert L.validate_lookup(LookupTemplate(tool="campaign"), owner=OWNER) == []
    assert L.validate_lookup(LookupTemplate(tool="campaign", filter={"entity": "{{entity.user}}"}), owner=OWNER) == []


@pytest.mark.parametrize("tool", ["related_cases", "campaign"])
@pytest.mark.parametrize(("template", "noun"), [("entity.hash", "file hash"), ("entity.domain", "domain"),
                                                ("entity.url", "URL"), ("entity.email", "email address")])
def test_cases_are_never_found_by_a_value_no_case_is_keyed_by(tool: str, template: str, noun: str) -> None:
    # The case store finds cases by their entity, and campaigns bind cases on it; a
    # case is keyed by an IP, a user or a host only, so a lookup by a hash would
    # always store "no related cases", which reads as false scoping evidence.
    lookup = LookupTemplate(tool=tool, filter={"entity": "{{" + template + "}}"})
    issues = L.validate_lookup(lookup, path="steps[3].lookup", owner="Step 'Other hosts with the same hash'")
    assert [(i.path, i.code) for i in issues] == [("steps[3].lookup.filter.entity", "not_allowed")]
    assert issues[0].message == (
        "Cases are keyed by an IP address, a user or a host, so step 'Other hosts with the same hash' never finds "
        "a case by {{" + template + "}}. Use a log lookup on the " + noun + " field instead.")
    values = _values(ip=("203.0.113.45",), hash=("c" * 64,), domain=("evil.example.com",),
                     url=("https://evil.example.com/x",), email=("mallory@evil.example.com",))
    assert isinstance(L.bind_lookup(lookup, values, now=NOW), L.LookupNotApplicable)
    for kind in sorted(L.CASE_CARRIED_ENTITY_KINDS):
        assert L.validate_lookup(LookupTemplate(tool=tool, filter={"entity": "{{entity." + kind + "}}"}),
                                 owner=OWNER) == []
    assert L.CASE_CARRIED_ENTITY_KINDS == {"ip", "user", "host"}


# --------------------------------------------------------------------------- #
# Logical field names (the source's mapped field)
# --------------------------------------------------------------------------- #
def test_logical_fields_are_the_connector_aggregate_fields() -> None:
    from app.connectors.base import AGGREGATE_FIELDS

    assert set(L.LOOKUP_LOGICAL_FIELDS) == set(AGGREGATE_FIELDS)
    assert len(L.LOOKUP_LOGICAL_FIELDS) == len(set(L.LOOKUP_LOGICAL_FIELDS))
    for name in L.LOOKUP_LOGICAL_FIELDS:
        assert L.is_field_name(name) and L.is_logical_field(name)
    for name in ("source.ip", "user.name", "IP", "ip ", "hostname", None, 3):
        assert not L.is_logical_field(name)


def test_logical_fields_resolve_per_source_through_the_field_mapping() -> None:
    from app.config import Preferences
    from app.connectors.base import aggregate_field

    ecs = Preferences()
    wazuh = ecs.model_copy(update={"source_ip_field": "data.srcip", "user_field": "data.srcuser",
                                   "host_field": "agent.name"})
    assert [aggregate_field(ecs, n) for n in ("ip", "user", "host")] == ["source.ip", "user.name", "host.name"]
    assert [aggregate_field(wazuh, n) for n in ("ip", "user", "host")] == ["data.srcip", "data.srcuser",
                                                                           "agent.name"]
    assert aggregate_field(ecs, "action") == aggregate_field(wazuh, "action") == "event.action"


def test_the_fixed_path_logical_names_are_the_connector_fixed_paths() -> None:
    # A logical name whose path does not move when EVERY mapped field moves is a fixed
    # path (``action`` is ECS ``event.action`` on every source); the module says so,
    # so a step that reads it names the path for the analyst (test_runbook_library).
    from app.config import Preferences
    from app.connectors.base import AGGREGATE_FIELDS, aggregate_field

    ecs = Preferences()
    remapped = ecs.model_copy(update={attr: f"vendor.{attr}" for attr in AGGREGATE_FIELDS.values() if attr})
    fixed = {name: aggregate_field(ecs, name) for name in L.LOOKUP_LOGICAL_FIELDS
             if aggregate_field(ecs, name) == aggregate_field(remapped, name)}
    assert fixed == dict(L.LOOKUP_FIXED_FIELD_PATHS) == {"action": "event.action"}
    assert L.fixed_field_path("action") == "event.action"
    for name in ("ip", "user", "host", "rule", "rule_name", "severity", "event.action", "Action", None, 3):
        assert L.fixed_field_path(name) is None, name


def test_every_logical_field_names_the_value_it_holds() -> None:
    assert set(L.LOGICAL_FILTER_VALUES) == set(L.LOOKUP_LOGICAL_FIELDS)
    assert {k: (v.template, v.grammar) for k, v in L.LOGICAL_FILTER_VALUES.items()} == {
        "ip": ("entity.ip", "ip"), "user": ("entity.user", "user"), "host": ("entity.host", "host"),
        "rule": ("case.rule", "rule"), "rule_name": (None, "rule"), "severity": (None, None), "action": (None, None)}
    for name, expected in L.LOGICAL_FILTER_VALUES.items():
        assert expected.template is None or expected.template in RUNBOOK_TEMPLATE_VALUES, name
        # The case value a field holds resolves with the same grammar a literal must pass.
        if expected.template is not None:
            kind = expected.template.split(".", 1)[1]
            assert expected.grammar == kind, name


@pytest.mark.parametrize("tool", ["log_stats", "log_search"])
@pytest.mark.parametrize(("key", "template"), [("ip", "entity.ip"), ("user", "entity.user"),
                                               ("host", "entity.host"), ("rule", "case.rule")])
def test_a_logical_filter_takes_only_its_own_case_value(tool: str, key: str, template: str) -> None:
    def issues(value: str):
        return L.validate_lookup(LookupTemplate(tool=tool, filter={key: value}), owner=OWNER)

    assert issues("{{" + template + "}}") == []
    expected = L.LOGICAL_FILTER_VALUES[key]
    for other in RUNBOOK_TEMPLATE_VALUES:
        if other == template:
            continue
        found = issues("{{" + other + "}}")
        assert [(i.path, i.code, i.message) for i in found] == [(
            f"lookup.filter.{key}", "not_allowed",
            f"{OWNER} filters {key} on {{{{{other}}}}}; use {{{{{template}}}}} or {expected.noun}.")], other
        # A lookup that does not validate never binds, so no false "0 rows" is stored.
        values = _values(ip=("203.0.113.45",), user=("asha",), host=("ws-01",), hash=("9f" * 32,))
        assert isinstance(L.bind_lookup(LookupTemplate(tool=tool, filter={key: "{{" + other + "}}"}), values,
                                        now=NOW), L.LookupNotApplicable)


def test_the_reviewers_mismatches_are_refused_with_a_plain_sentence() -> None:
    def messages(flt: dict[str, str]) -> list[str]:
        return [i.message for i in L.validate_lookup(LookupTemplate(tool="log_stats", filter=flt, group_by=["action"]),
                                                     owner="Step 'X'")]

    assert messages({"ip": "{{entity.user}}"}) == ["Step 'X' filters ip on {{entity.user}}; use {{entity.ip}} or an "
                                                   "IP address."]
    assert messages({"ip": "not-an-ip"}) == ["Step 'X' filters ip on 'not-an-ip', which is not an IP address. Use "
                                             "{{entity.ip}} or an IP address."]
    assert messages({"host": "{{entity.hash}}"}) == ["Step 'X' filters host on {{entity.hash}}; use {{entity.host}} "
                                                     "or a host name."]
    assert messages({"user": "{{case.first_seen}}"}) == ["Step 'X' filters user on {{case.first_seen}}; use "
                                                         "{{entity.user}} or a user name."]


@pytest.mark.parametrize(("key", "good", "bad", "noun"), [
    ("ip", ["203.0.113.45", " 198.51.100.7 ", "2001:db8::1"], ["not-an-ip", "10.0.0.0/8", "203.0.113.300", "fe80::1%eth0"],
     "an IP address"),
    ("user", ["asha", "CORP\\asha", "asha@example.com", "Asha Rao"], ["asha  rao", "a|b", "<script>"], "a user name"),
    ("host", ["ws-01", "WS-01.corp.example", "srv_02"], ["ws 01", "host;rm", "a|b"], "a host name"),
])
def test_a_logical_filter_literal_must_be_of_its_kind(key: str, good: list[str], bad: list[str], noun: str) -> None:
    template = L.LOGICAL_FILTER_VALUES[key].template
    for value in good:
        assert L.validate_lookup(LookupTemplate(tool="log_search", filter={key: value}), owner=OWNER) == [], value
    for value in bad:
        found = L.validate_lookup(LookupTemplate(tool="log_search", filter={key: value}), owner=OWNER)
        assert [(i.code, i.message) for i in found] == [(
            "invalid", f"{OWNER} filters {key} on '{value.strip()}', which is not {noun}. Use "
                       f"{{{{{template}}}}} or {noun}.")], value


@pytest.mark.parametrize(("key", "noun"), [("rule_name", "a rule name"), ("severity", "a severity"),
                                           ("action", "an action")])
def test_a_field_no_case_value_holds_takes_a_literal_only(key: str, noun: str) -> None:
    assert L.validate_lookup(LookupTemplate(tool="log_stats", filter={key: "high"}), owner=OWNER) == []
    for other in RUNBOOK_TEMPLATE_VALUES:
        found = L.validate_lookup(LookupTemplate(tool="log_stats", filter={key: "{{" + other + "}}"}), owner=OWNER)
        if key == "rule_name" and other == "case.rule":
            message = (f"{OWNER} filters rule_name on {{{{case.rule}}}}, the value of the rule field; filter rule on "
                       f"it instead, or write a rule name.")
        else:
            message = f"{OWNER} filters {key} on {{{{{other}}}}}, but no case value is {noun}; write {noun} instead."
        assert [(i.code, i.message) for i in found] == [("not_allowed", message)], other


def test_a_physical_path_and_the_other_tools_keys_keep_their_own_rules() -> None:
    # Only a log tool's logical name has a known value kind; a physical path is read
    # as written (a source's own field may hold a range or another kind of value),
    # names are case-sensitive, and related_cases' ``rule`` is that tool's own key.
    for flt in ({"source.ip": "10.0.0.0/8"}, {"IP": "not-an-ip"}, {"data.srcip": "{{entity.ip}}"},
                {"winlog.event_data.TargetUserName": "{{entity.user}}"}):
        assert L.validate_lookup(LookupTemplate(tool="log_stats", filter=flt), owner=OWNER) == [], flt
    assert L.validate_lookup(LookupTemplate(tool="related_cases", filter={"rule": "ssh failed: [x]"}),
                             owner=OWNER) == []
    assert "not_allowed" in _codes(L.validate_lookup(
        LookupTemplate(tool="related_cases", filter={"rule": "{{entity.ip}}"}), owner=OWNER))


def test_a_binding_marks_logical_filters_and_group_by_fields() -> None:
    lookup = LookupTemplate(tool="log_stats", filter={"ip": "{{entity.ip}}", "event.outcome": "failure"},
                            group_by=["event.outcome", "user"])
    assert L.validate_lookup(lookup, owner=OWNER) == []
    bound = L.bind_lookup(lookup, _values(ip=("203.0.113.45",)), now=NOW)
    assert isinstance(bound, L.LookupBinding)
    assert bound.filters == (L.BoundFilter("ip", "203.0.113.45", "entity.ip", True),
                             L.BoundFilter("event.outcome", "failure", None, False))
    assert bound.group_by == ("event.outcome", "user") and bound.logical_group_by == ("user",)
    assert bound.params == {"ip": "203.0.113.45", "event.outcome": "failure", "group_by": "event.outcome, user",
                            "limit": "20"}
    # The other tools' keys are their own, never a mapped log field.
    related = L.bind_lookup(LookupTemplate(tool="related_cases", filter={"rule": "{{case.rule}}"}), _values(),
                            now=NOW)
    assert related.filters == (L.BoundFilter("rule", "ssh_auth_failed", "case.rule", False),)
    assert related.logical_group_by == ()


def test_an_unknown_field_names_both_field_forms() -> None:
    issues = L.validate_lookup(LookupTemplate(tool="log_stats", filter={"bad field": "x"}, group_by=["a b"]),
                               owner=OWNER)
    forms = ("ip, user, host, rule, rule_name or severity (the source's mapped field), action (the ECS field "
             "event.action on every source), or a log field name such as event.outcome")
    assert [i.message for i in issues] == [
        f"{OWNER} filters on 'bad field', which is not a field. Use {forms}.",
        f"{OWNER} groups by 'a b', which is not a field. Use {forms}.",
    ]


def test_mitre_lookup_takes_literal_technique_ids_only() -> None:
    assert L.validate_lookup(LookupTemplate(tool="mitre"), owner=OWNER) == []
    assert L.validate_lookup(LookupTemplate(tool="mitre", filter={"technique": "T1110.003"}), owner=OWNER) == []
    assert "invalid" in _codes(L.validate_lookup(LookupTemplate(tool="mitre", filter={"technique": "brute"}),
                                                 owner=OWNER))
    assert "not_allowed" in _codes(L.validate_lookup(
        LookupTemplate(tool="mitre", filter={"technique": "{{entity.ip}}"}), owner=OWNER))


def test_the_default_limit_never_reads_as_a_problem() -> None:
    # 20 is above the related-cases bound of 10; the bound is applied at binding.
    assert L.validate_lookup(LookupTemplate(tool="related_cases", filter={"entity": "{{entity.ip}}"}),
                             owner=OWNER) == []


@pytest.mark.parametrize("lookup", [
    LookupTemplate(tool="log_search", filter={f"!{i}": "x" for i in range(20_000)}),
    LookupTemplate(tool="log_search", filter={f"a{i}": "{{nope}}" for i in range(14_000)}),
    LookupTemplate(tool="log_stats", filter={"event.outcome": "failure"}, group_by=["user.name"] * 20_000),
    LookupTemplate(tool="log_stats", filter={"event.outcome": "failure"}, group_by=["!"] * 20_000),
], ids=["bad-keys", "unknown-values", "repeated-fields", "bad-fields"])
def test_a_long_filter_or_group_by_list_stops_at_the_issue_cap(lookup: LookupTemplate) -> None:
    import time

    started = time.perf_counter()
    issues = L.validate_lookup(lookup, owner=OWNER)
    assert time.perf_counter() - started < 0.2
    assert _codes(issues)[0] == "too_many"
    assert len(issues) == L.RUNBOOK_MAX_ISSUES + 1  # one past the runbook cap, so "more" is still said


def test_a_list_over_its_limit_is_read_only_so_far_past_it() -> None:
    last_read = L.RUNBOOK_LOOKUP_MAX_FILTERS + L.RUNBOOK_MAX_ISSUES - 1
    keys = [f"a{i}" for i in range(last_read + 10)]
    keys[last_read], keys[last_read + 1] = "!last", "!past"
    issues = L.validate_lookup(LookupTemplate(tool="log_search", filter={k: "x" for k in keys}), owner=OWNER)
    assert [(i.path, i.code) for i in issues] == [("lookup.filter", "too_many"), ("lookup.filter.!last", "invalid")]

    last_read = L.RUNBOOK_LOOKUP_MAX_GROUP_BY + L.RUNBOOK_MAX_ISSUES - 1
    fields = [f"f{i}" for i in range(last_read + 10)]
    fields[last_read], fields[last_read + 1] = "!last", "!past"
    issues = L.validate_lookup(LookupTemplate(tool="log_stats", filter={"event.outcome": "failure"},
                                              group_by=fields), owner=OWNER)
    assert [(i.path, i.code) for i in issues] == [
        ("lookup.group_by", "too_many"), (f"lookup.group_by[{last_read}]", "invalid")]


# --------------------------------------------------------------------------- #
# The window grammar
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("window", [
    "case_first_seen-1h..case_last_seen+1h", "case_first_seen..case_last_seen", "case_last_seen-7d..case_last_seen",
    "case_last_seen-30d..case_last_seen", "case_first_seen-1d..now", "now-24h..now", "now-24h", "now-7d", "now-30d",
    "now-4w", "today", "yesterday", "this_week", "last_week", "case_first_seen..case_first_seen+90m",
])
def test_valid_windows(window: str) -> None:
    spec, reason = L.parse_window(window)
    assert spec is not None and reason is None, reason


@pytest.mark.parametrize(("window", "fragment"), [
    ("", "is empty"),
    ("all", "not in a form"),
    ("this_month", "not in a form"),
    ("now-31d", "spans more than 30 days"),
    ("now-5w", "spans more than 30 days"),
    ("now-0d", "is empty"),
    ("now-6M", "not in a form"),
    ("case_last_seen..case_first_seen", "later point"),
    ("case_first_seen+1h..case_first_seen", "at or after its end"),
    ("case_first_seen-31d..case_last_seen", "more than 30 days from its anchor"),
    ("case_last_seen-40d..case_last_seen-5d", "more than 30 days from its anchor"),
    ("case_first_seen..case_first_seen+31d", "more than 30 days from its anchor"),
    ("now-25d..now+1h", "ends after now"),
    ("case_first_seen-1x..case_last_seen", "not in a form"),
    ("2026-10-01..2026-10-05", "not in a form"),
])
def test_invalid_windows(window: str, fragment: str) -> None:
    spec, reason = L.parse_window(window)
    assert spec is None and reason is not None and fragment in reason
    lookup = LookupTemplate(tool="log_stats", filter={"source.ip": "{{entity.ip}}"}, window=window)
    issues = L.validate_lookup(lookup, path="steps[0].lookup", owner=OWNER)
    assert [i.path for i in issues] == ["steps[0].lookup.window"]
    assert issues[0].message.startswith(f"{OWNER} has a window that ")


# --------------------------------------------------------------------------- #
# Binding
# --------------------------------------------------------------------------- #
def test_binding_resolves_templates_into_structured_parameters() -> None:
    lookup = LookupTemplate(tool="log_stats", filter={"source.ip": "{{entity.ip}}", "event.outcome": "failure"},
                            group_by=["user.name"])
    bound = L.bind_lookup(lookup, _values(ip=("203.0.113.45",)), now=NOW)
    assert isinstance(bound, L.LookupBinding)
    assert bound.filters == (L.BoundFilter("source.ip", "203.0.113.45", "entity.ip"),
                             L.BoundFilter("event.outcome", "failure", None))
    assert bound.group_by == ("user.name",)
    assert bound.params == {"source.ip": "203.0.113.45", "event.outcome": "failure", "group_by": "user.name",
                            "limit": "20"}
    assert bound.window_from == FIRST - timedelta(hours=1)
    assert bound.window_to == NOW  # LAST + 1h is after NOW: cut to the moment the lookup ran
    assert bound.window_clamped is True and bound.span_clamped is False
    assert bound.window_to_iso == "2026-10-26T14:31:00Z"
    assert bound.ran_at == NOW


def test_a_value_is_bound_whole_never_concatenated_into_text() -> None:
    # A user name that reads like query syntax stays one parameter value; it is never
    # pasted into a query.
    odd = "admin OR user"
    lookup = LookupTemplate(tool="log_search", filter={"user.name": "{{entity.user}}"})
    bound = L.bind_lookup(lookup, _values(user=(odd,)), now=NOW)
    assert isinstance(bound, L.LookupBinding)
    assert bound.filters == (L.BoundFilter("user.name", odd, "entity.user"),)
    # Quotes and operators fail the user grammar, so they never reach a lookup at all.
    refused = L.bind_lookup(lookup, _values(user=("admin' OR '1'='1",)), now=NOW)
    assert isinstance(refused, L.LookupNotApplicable)


@pytest.mark.parametrize(("template", "reason"), [
    ("entity.ip", "This case has no IP address."),
    ("entity.user", "This case has no user."),
    ("entity.host", "This case has no host."),
    ("entity.domain", "This case has no domain."),
    ("entity.hash", "This case has no file hash."),
    ("entity.url", "This case has no URL."),
    ("entity.email", "This case has no email address."),
])
def test_a_missing_value_makes_the_lookup_not_applicable(template: str, reason: str) -> None:
    lookup = LookupTemplate(tool="log_stats", filter={"source.ip": "{{" + template + "}}"})
    result = L.bind_lookup(lookup, L.CaseValues(first_seen=FIRST, last_seen=LAST), now=NOW)
    assert isinstance(result, L.LookupNotApplicable)
    assert result.reason == reason and result.template == template


@pytest.mark.parametrize(("kind", "bad"), [
    ("ip", "203.0.113.999"), ("ip", "fe80::1%eth0"), ("hash", "abc123"), ("domain", "not a domain"),
    ("url", "javascript:alert(1)"), ("email", "nobody"), ("host", "host name"), ("user", "  "),
    ("user", "a\nb"),
])
def test_an_invalid_value_is_never_bound(kind: str, bad: str) -> None:
    lookup = LookupTemplate(tool="log_stats", filter={"x.y": "{{entity." + kind + "}}"})
    result = L.bind_lookup(lookup, L.CaseValues(first_seen=FIRST, last_seen=LAST, entities={kind: (bad,)}), now=NOW)
    assert isinstance(result, L.LookupNotApplicable)


def test_the_first_valid_candidate_is_used() -> None:
    lookup = LookupTemplate(tool="log_stats", filter={"source.ip": "{{entity.ip}}"})
    bound = L.bind_lookup(lookup, _values(ip=("not-an-ip", "198.51.100.7")), now=NOW)
    assert isinstance(bound, L.LookupBinding) and bound.filters[0].value == "198.51.100.7"


def test_enrich_binds_the_indicator_with_its_kind() -> None:
    bound = L.bind_lookup(LookupTemplate(tool="enrich", indicator="{{entity.hash}}"),
                          _values(hash=("a" * 64,)), now=NOW)
    assert isinstance(bound, L.LookupBinding)
    assert bound.indicator == L.ResolvedValue("entity.hash", "hash", "a" * 64)
    assert bound.params["indicator"] == "a" * 64
    assert bound.window_from is None and bound.window_to is None  # enrichment is not windowed


def test_case_values_resolve_rule_source_and_times() -> None:
    lookup = LookupTemplate(tool="related_cases", filter={"rule": "{{case.rule}}"})
    bound = L.bind_lookup(lookup, _values(), now=NOW)
    assert isinstance(bound, L.LookupBinding) and bound.filters[0].value == "ssh_auth_failed"
    assert L.resolve_template("case.source_id", _values()) == L.ResolvedValue("case.source_id", "source_id", "src-1")
    assert L.resolve_template("case.first_seen", _values()).value == "2026-10-26T12:52:00Z"
    assert L.resolve_template("case.last_seen", _values()).value == "2026-10-26T13:40:00Z"
    missing = L.resolve_template("case.rule", L.CaseValues())
    assert isinstance(missing, L.LookupNotApplicable) and missing.reason == "This case has no detection rule."


def test_rule_values_may_hold_spaces_and_punctuation_but_never_line_breaks() -> None:
    assert L.valid_value("rule", "LP QRadar: remote access brute force") == "LP QRadar: remote access brute force"
    assert L.valid_value("rule", "SQL injection (OWASP CRS 942xxx)") is not None
    assert L.valid_value("rule", "a\nb") is None
    assert L.valid_value("rule", "{{entity.ip}}") is None
    assert L.valid_value("user", "Asha Rao") == "Asha Rao"
    assert L.valid_value("user", "CORP\\asha") == "CORP\\asha"
    assert L.valid_value("user", "Asha  Rao") is None
    assert L.valid_value("host", "web-01.example.com") == "web-01.example.com"
    assert L.valid_value("url", "https://example.com/a?b=c") is not None
    assert L.valid_value("email", "asha@example.com") == "asha@example.com"
    assert L.valid_value("domain", "example.co.uk") == "example.co.uk"
    assert L.valid_value("hash", "A" * 40) == "A" * 40


def test_related_cases_limit_is_bound_to_ten() -> None:
    bound = L.bind_lookup(LookupTemplate(tool="related_cases", filter={"entity": "{{entity.ip}}"}),
                          _values(ip=("203.0.113.45",)), now=NOW)
    assert isinstance(bound, L.LookupBinding) and bound.limit == 10 and bound.params["limit"] == "10"


def test_a_long_case_keeps_its_last_thirty_days() -> None:
    values = L.CaseValues(first_seen=NOW - timedelta(days=60), last_seen=NOW - timedelta(days=2),
                          entities={"ip": ("203.0.113.45",)})
    bound = L.bind_lookup(LookupTemplate(tool="log_stats", filter={"source.ip": "{{entity.ip}}"}), values, now=NOW)
    assert isinstance(bound, L.LookupBinding)
    assert bound.span_clamped is True and bound.window_clamped is False
    assert bound.window_to - bound.window_from == timedelta(days=30)
    assert bound.window_to == NOW - timedelta(days=2) + timedelta(hours=1)


def test_a_window_entirely_in_the_future_is_not_applicable() -> None:
    values = L.CaseValues(first_seen=NOW + timedelta(hours=3), last_seen=NOW + timedelta(hours=4),
                          entities={"ip": ("203.0.113.45",)})
    result = L.bind_lookup(LookupTemplate(tool="log_stats", filter={"source.ip": "{{entity.ip}}"}), values, now=NOW)
    assert isinstance(result, L.LookupNotApplicable)
    assert result.reason == "The search window starts after now, so there is nothing to search yet."


def test_a_past_window_that_starts_after_it_ends_says_so() -> None:
    # A one-hour case, entirely in the past, with a window that starts two hours after
    # first seen and ends at last seen: empty, but not because it lies in the future.
    values = L.CaseValues(first_seen=NOW - timedelta(hours=5), last_seen=NOW - timedelta(hours=4),
                          entities={"ip": ("203.0.113.45",)})
    lookup = LookupTemplate(tool="log_stats", filter={"source.ip": "{{entity.ip}}"},
                            window="case_first_seen+2h..case_last_seen")
    result = L.bind_lookup(lookup, values, now=NOW)
    assert isinstance(result, L.LookupNotApplicable)
    assert result.reason == "The search window is empty for this case: it starts after it ends."


def test_a_case_at_the_end_of_the_calendar_binds_as_not_applicable() -> None:
    # Event times are log-derived: a year-9999 case must never raise into the
    # background lookup, whichever window the step uses.
    case = Case(
        case_id="case-9999", cluster_signature="sig", source_surface=SourceSurface.INVESTIGATE,
        rule_ids=["r1"], entity=Entity(type=EntityType.IP, value="203.0.113.45"),
        first_seen_millis=253_402_300_000_000,
        trigger_reason=TriggerReason(rule_value="r1", window_end=253_402_300_799_000),
    )
    values = L.case_values_from_case(case)
    assert values.last_seen is not None and values.last_seen.year == 9999
    for window in (RUNBOOK_DEFAULT_LOOKUP_WINDOW, "case_last_seen..case_last_seen+1h"):
        lookup = LookupTemplate(tool="log_stats", filter={"source.ip": "{{entity.ip}}"}, window=window)
        result = L.bind_lookup(lookup, values, now=NOW)
        assert isinstance(result, L.LookupNotApplicable), window
        assert result.reason == ("This case's times are outside the supported range, so the search window "
                                 "is unknown."), window
    early = L.CaseValues(first_seen=datetime(1, 1, 1, tzinfo=timezone.utc),
                         last_seen=datetime(1, 1, 1, tzinfo=timezone.utc), entities={"ip": ("203.0.113.45",)})
    result = L.bind_lookup(LookupTemplate(tool="log_stats", filter={"source.ip": "{{entity.ip}}"}), early, now=NOW)
    assert isinstance(result, L.LookupNotApplicable)


def test_a_case_without_times_cannot_resolve_a_case_window() -> None:
    values = L.CaseValues(entities={"ip": ("203.0.113.45",)})
    result = L.bind_lookup(LookupTemplate(tool="log_stats", filter={"source.ip": "{{entity.ip}}"}), values, now=NOW)
    assert isinstance(result, L.LookupNotApplicable)


@pytest.mark.parametrize(("window", "start", "end"), [
    ("now-24h", NOW - timedelta(hours=24), NOW),
    ("now-24h..now", NOW - timedelta(hours=24), NOW),
    ("today", datetime(2026, 10, 26, tzinfo=timezone.utc), NOW),
    ("case_last_seen-7d..case_last_seen", LAST - timedelta(days=7), LAST),
])
def test_window_tokens_resolve_against_now(window: str, start: datetime, end: datetime) -> None:
    lookup = LookupTemplate(tool="log_stats", filter={"source.ip": "{{entity.ip}}"}, window=window)
    bound = L.bind_lookup(lookup, _values(ip=("203.0.113.45",)), now=NOW)
    assert isinstance(bound, L.LookupBinding)
    assert (bound.window_from, bound.window_to) == (start, end)
    assert bound.window_clamped is False


def test_an_invalid_template_binds_as_not_applicable_and_never_raises() -> None:
    lookup = LookupTemplate(tool="log_stats", filter={"source.ip": "{{entity.ipaddr}}"})
    result = L.bind_lookup(lookup, _values(ip=("203.0.113.45",)), now=NOW)
    assert isinstance(result, L.LookupNotApplicable)


def test_mitre_literal_is_upper_cased() -> None:
    for raw in ("t1110.003", "T1110.003"):
        bound = L.bind_lookup(LookupTemplate(tool="mitre", filter={"technique": raw}), _values(), now=NOW)
        assert isinstance(bound, L.LookupBinding)
        assert bound.params["technique"] == "T1110.003"
        assert bound.filters == (L.BoundFilter("technique", "T1110.003"),)
        assert bound.window_from is None


# --------------------------------------------------------------------------- #
# Case values from stored records
# --------------------------------------------------------------------------- #
def test_case_values_from_a_case() -> None:
    case = Case(
        case_id="case-1", cluster_signature="sig", source_surface=SourceSurface.INVESTIGATE,
        rule_ids=["fallback_rule"], entity=Entity(type=EntityType.FILE_HASH, value="b" * 64),
        source_id="src-9", first_seen_millis=int(FIRST.timestamp() * 1000), status=CaseStatus.OPEN,
        trigger_reason=TriggerReason(rule_value="ssh_auth_failed", window_end=int(LAST.timestamp() * 1000)),
    )
    values = L.case_values_from_case(case, extra={"user": ["asha"], "bogus": ["x"]})
    assert values.rule == "ssh_auth_failed"
    assert values.source_id == "src-9"
    assert values.first_seen == FIRST and values.last_seen == LAST
    assert values.entities == {"hash": ("b" * 64,), "user": ("asha",)}


def test_case_values_from_a_rule_keyed_case_have_no_entity() -> None:
    case = Case(case_id="c", cluster_signature="s", source_surface=SourceSurface.INVESTIGATE,
                rule_ids=["r1"], entity=Entity(type=EntityType.RULE, value="r1"), created_at="2026-10-26T10:00:00Z")
    values = L.case_values_from_case(case)
    assert values.entities == {}
    assert values.rule == "r1"
    assert values.first_seen == datetime(2026, 10, 26, 10, tzinfo=timezone.utc) == values.last_seen


def test_event_time_span() -> None:
    first, last = int(FIRST.timestamp() * 1000), int(LAST.timestamp() * 1000)
    events = [_event(1, timestamp_millis=last), _event(2, timestamp_millis=first), _event(3),
              RawEvent.model_construct(id="x", timestamp_millis="soon"),
              RawEvent.model_construct(id="y", timestamp_millis=True)]
    assert L.event_time_span(events) == (FIRST, LAST)
    assert L.event_time_span([]) == (None, None) and L.event_time_span([_event(1)]) == (None, None)
    # A time the calendar cannot hold is skipped, never raised.
    assert L.event_time_span([_event(1, timestamp_millis=10**18), _event(2, timestamp_millis=first)]) == (FIRST, FIRST)


def _spray_case() -> tuple[Case, list[RawEvent]]:
    """A six-hour password spray (one failure a minute from 08:00 to 14:00 UTC, a
    success at 13:00), triggered by a THRESHOLD rule of 5 events in 5 minutes. The
    trigger's window is the densest one, the first five minutes."""
    from app.config import CorrelationRule
    from app.constants import CorrelationMode
    from app.engine import correlation

    start = int(datetime(2026, 10, 20, 8, 0, tzinfo=timezone.utc).timestamp() * 1000)
    events = [RawEvent(id=str(i), timestamp_millis=start + i * 60_000, ip="203.0.113.9", user="asha", rule="sshd")
              for i in range(361)]
    detail = correlation._window_detail(events, CorrelationRule(mode=CorrelationMode.THRESHOLD, n=5,
                                                                window_seconds=300))
    assert detail.window_end - detail.window_start == 300_000  # the densest window: the first burst
    case = Case(case_id="case-spray", cluster_signature="sig", source_surface=SourceSurface.INVESTIGATE,
                rule_ids=["sshd"], entity=Entity(type=EntityType.IP, value="203.0.113.9"), first_seen_millis=start,
                member_event_keys=[f"k{i}" for i in range(361)],
                trigger_reason=TriggerReason(rule_value="sshd", mode="threshold", n=5, window_seconds=300,
                                             observed_count=detail.observed_count, window_start=detail.window_start,
                                             window_end=detail.window_end))
    return case, events


def test_a_threshold_case_binds_a_window_that_holds_its_last_event() -> None:
    case, events = _spray_case()
    success_at = datetime(2026, 10, 20, 13, 0, tzinfo=timezone.utc)
    last_event = datetime(2026, 10, 20, 14, 0, tzinfo=timezone.utc)
    lookup = LookupTemplate(tool="log_stats", filter={"ip": "{{entity.ip}}"}, group_by=["event.outcome", "user"])
    ran = datetime(2026, 10, 21, tzinfo=timezone.utc)
    values = L.case_values_from_case(case, events=events)
    assert (values.first_seen, values.last_seen) == (datetime(2026, 10, 20, 8, 0, tzinfo=timezone.utc), last_event)
    bound = L.bind_lookup(lookup, values, now=ran)
    assert isinstance(bound, L.LookupBinding)
    assert bound.window_from <= success_at <= last_event <= bound.window_to
    # The events also give the case's other values when ``extra`` is not passed.
    assert values.entities["user"] == ("asha",)
    # The same incident as a cluster binds the same window.
    cluster = Cluster(signature="sig", entity=case.entity, group_by=EntityType.IP, rule_values=["sshd"],
                      member_events=events, first_seen_millis=case.first_seen_millis,
                      last_seen_millis=int(last_event.timestamp() * 1000))
    from_cluster = L.bind_lookup(lookup, L.case_values_from_cluster(cluster), now=ran)
    assert (from_cluster.window_from, from_cluster.window_to) == (bound.window_from, bound.window_to)


def test_without_events_last_seen_is_only_a_lower_bound() -> None:
    # A Case has no last-seen field: without its events the trigger window's end is
    # all there is, and the docstring says so; the run engine passes the events.
    case, _events = _spray_case()
    values = L.case_values_from_case(case)
    assert values.last_seen == datetime(2026, 10, 20, 8, 5, tzinfo=timezone.utc)
    assert values.last_seen < L.case_values_from_case(case, events=_events).last_seen
    # Partial events never move last seen below what the trigger already proves.
    early = [e for e in _events if e.timestamp_millis < case.trigger_reason.window_start + 60_000]
    assert L.case_values_from_case(case, events=early).last_seen == values.last_seen
    # Events earlier than first_seen_millis move first seen back.
    before = RawEvent(id="b", timestamp_millis=case.first_seen_millis - 3_600_000)
    moved = L.case_values_from_case(case, events=[before, *_events])
    assert moved.first_seen == datetime(2026, 10, 20, 7, 0, tzinfo=timezone.utc)
    # An explicit ``extra`` is kept as given.
    assert L.case_values_from_case(case, events=_events, extra={"user": ["bob"]}).entities["user"] == ("bob",)


def test_case_values_from_a_cluster_rank_member_values() -> None:
    events = [RawEvent(id=str(i), user=u, host="web-01", ip="203.0.113.45") for i, u in
              enumerate(["bob", "asha", "asha"])]
    cluster = Cluster(signature="s", entity=Entity(type=EntityType.IP, value="203.0.113.45"),
                      group_by=EntityType.IP, rule_values=["sshd"], member_events=events,
                      first_seen_millis=int(FIRST.timestamp() * 1000), last_seen_millis=int(LAST.timestamp() * 1000))
    values = L.case_values_from_cluster(cluster)
    assert values.entities["ip"] == ("203.0.113.45",)
    assert values.entities["user"] == ("asha", "bob")
    assert values.entities["host"] == ("web-01",)
    assert values.rule == "sshd"
    assert (values.first_seen, values.last_seen) == (FIRST, LAST)


def _event(i: int, **kw) -> RawEvent:
    return RawEvent(id=str(i), **kw)


def test_entity_values_from_events_read_hashes_domains_urls_and_emails() -> None:
    events = [
        _event(1, ip="10.0.0.5", host="h1", user="bob", source={
            "file": {"hash": {"sha256": "A" * 64}}, "url": {"domain": "evil.example.com",
                                                              "full": "https://evil.example.com/x"},
            "email": {"from": {"address": ["mallory@evil.example.com", "second@example.com"]}}}),
        _event(2, ip="10.0.0.5", source={"file.hash.md5": "b" * 32, "destination.domain": "cdn.example.net"}),
        _event(3, source={"process": {"hash": {"sha256": "a" * 64}}, "dns": {"question": {"name": "evil.example.com"}},
                          "user": {"email": "asha@example.com"}}),
    ]
    values = L.entity_values_from_events(events)
    assert values == {
        "ip": ["10.0.0.5"], "user": ["bob"], "host": ["h1"],
        "hash": ["a" * 64, "b" * 32],                       # lower case, most frequent first
        "domain": ["evil.example.com", "cdn.example.net"],
        "url": ["https://evil.example.com/x"],
        "email": ["asha@example.com", "mallory@evil.example.com"],  # one each, then by value
    }


def test_entity_values_skip_the_hosts_own_directory_domain() -> None:
    # host.domain names the host's own directory domain, never an observed domain.
    events = [_event(1, host="ws-1", source={"host": {"domain": "corp.example.com"}})]
    assert "domain" not in L.entity_values_from_events(events)
    assert L.EVENT_ENTITY_FIELDS["domain"] == tuple(f for f in RawEvent._DOMAIN_FIELDS if f != "host.domain")
    assert L.EVENT_ENTITY_FIELDS["hash"] == RawEvent._FILE_HASH_FIELDS


def test_entity_values_from_events_are_bounded_and_tolerant() -> None:
    events = [_event(i, user=f"user{i:03d}") for i in range(50)]
    events.append(RawEvent.model_construct(id="x", source="not a mapping", ip=None, user=None, host=None))
    values = L.entity_values_from_events(events)
    assert len(values["user"]) == L.ENTITY_VALUES_MAX_PER_KIND
    assert values["user"][0] == "user000"
    assert L.entity_values_from_events([]) == {}
    assert L.entity_values_from_events([_event(1, source={"url": {"domain": ["", None]}, "sha256": True})]) == {}


def test_a_cluster_binds_hash_and_domain_lookups_from_its_events() -> None:
    events = [_event(1, ip="10.0.0.5", host="h1", user="bob",
                     source={"file": {"hash": {"sha256": "c" * 64}}, "url": {"domain": "evil.example.com"}})]
    cluster = Cluster(signature="s", entity=Entity(type=EntityType.HOST, value="h1"), group_by=EntityType.HOST,
                      rule_values=["edr"], member_events=events, first_seen_millis=int(FIRST.timestamp() * 1000),
                      last_seen_millis=int(LAST.timestamp() * 1000))
    values = L.case_values_from_cluster(cluster)
    assert values.entities["hash"] == ("c" * 64,) and values.entities["domain"] == ("evil.example.com",)
    bound = L.bind_lookup(LookupTemplate(tool="enrich", indicator="{{entity.hash}}"), values, now=NOW)
    assert isinstance(bound, L.LookupBinding) and bound.indicator.value == "c" * 64
    # A case is never keyed by a hash, so cases are not found by one; the logs are.
    related = L.bind_lookup(LookupTemplate(tool="related_cases", filter={"entity": "{{entity.hash}}"}), values,
                            now=NOW)
    assert isinstance(related, L.LookupNotApplicable)
    hosts = L.bind_lookup(LookupTemplate(tool="log_stats", filter={"file.hash.sha256": "{{entity.hash}}"},
                                         group_by=["host"]), values, now=NOW)
    assert isinstance(hosts, L.LookupBinding) and hosts.params["file.hash.sha256"] == "c" * 64
    domain = L.bind_lookup(LookupTemplate(tool="enrich", indicator="{{entity.domain}}"), values, now=NOW)
    assert isinstance(domain, L.LookupBinding) and domain.indicator.kind == "domain"
    # A stored case gets the same values from its member events through ``extra``.
    case = Case(case_id="case-1", cluster_signature="sig", source_surface=SourceSurface.INVESTIGATE,
                rule_ids=["edr"], entity=Entity(type=EntityType.HOST, value="h1"),
                first_seen_millis=int(FIRST.timestamp() * 1000))
    from_case = L.case_values_from_case(case, extra=L.entity_values_from_events(events))
    assert from_case.entities["host"] == ("h1",) and from_case.entities["hash"] == ("c" * 64,)
    assert L.case_values_from_case(case).entities == {"host": ("h1",)}


def test_iso_utc_is_one_form() -> None:
    assert L.iso_utc(datetime(2026, 1, 2, 3, 4, 5, 999, tzinfo=timezone.utc)) == "2026-01-02T03:04:05Z"
    assert L.iso_utc(datetime(2026, 1, 2, 3, 4, 5)) == "2026-01-02T03:04:05Z"
