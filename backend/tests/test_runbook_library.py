"""The 12 built-in runbooks (Round 14 SPEC §4.10.14, §4.10.9, WP-A3).

Every bundled runbook must parse, validate as a built-in, carry its release version,
render the investigator guidance within the 3,000-character budget with nothing cut
(F14: three bundled procedures used to be truncated), survive the Markdown round trip,
and say what §4.10.14 says it says. Built-in matching precedence is pinned too, so a
change to one file's rules or priority is visible in review.
"""

from __future__ import annotations

import re
import shutil
from datetime import datetime, timezone
from pathlib import Path

import pytest

from app.constants import EntityType
from app.engine import runbook_lookup as L
from app.engine import runbook_match as M
from app.engine import runbook_model as RM
from app.models import Cluster, Entity, RawEvent

LIBRARY = RM.RUNBOOK_LIBRARY_DIR
LOADED, REFUSED = RM.load_builtin_library(LIBRARY)
BY_ID = {b.id: b for b in LOADED}

# The phases each built-in uses (SPEC §4.10.14).
EXPECTED_PHASES: dict[str, list[str]] = {
    "phishing-suspicious-email": ["triage", "investigate", "contain", "recover", "close"],
    "malware-endpoint": ["triage", "investigate", "contain", "eradicate", "recover"],
    "ransomware-destructive": ["triage", "contain", "eradicate", "recover", "close"],
    "brute-force-password-spray": ["triage", "investigate", "contain", "close"],
    "compromised-account": ["triage", "investigate", "contain", "recover"],
    "cloud-identity-keys": ["triage", "investigate", "contain", "eradicate", "recover"],
    "data-exfiltration": ["triage", "investigate", "contain", "close"],
    "web-application-attack": ["triage", "investigate", "contain", "close"],
    "scanning-reconnaissance": ["triage", "close"],
    "suspicious-outbound": ["triage", "investigate", "contain"],
    "privileged-misuse-insider": ["triage", "investigate", "contain", "close"],
    "generic-incident": ["triage", "investigate", "contain", "eradicate", "recover", "close"],
}

# The ATT&CK techniques each built-in covers (SPEC §4.10.14).
EXPECTED_MITRE: dict[str, list[str]] = {
    "phishing-suspicious-email": ["T1566"],
    "malware-endpoint": ["T1204", "T1059"],
    "ransomware-destructive": ["T1486", "T1490"],
    "brute-force-password-spray": ["T1110"],
    "compromised-account": ["T1078"],
    "cloud-identity-keys": ["T1078.004", "T1552"],
    "data-exfiltration": ["T1041", "T1567"],
    "web-application-attack": ["T1190"],
    "scanning-reconnaissance": ["T1595", "T1046"],
    "suspicious-outbound": ["T1071", "T1571"],
    "privileged-misuse-insider": ["T1078.003"],
    "generic-incident": [],
}

# The rule ids of the 18 retired bundled files each built-in merged (their
# ``match.rule_ids`` and ``applies_to_rules``), copied here because the retired
# files are deleted in this round. A built-in's ``applies_when.rule_ids`` is their
# union (SPEC §4.10.14), plus the documented additions below.
LEGACY_RULES: dict[str, dict[str, list[str]]] = {
    "phishing-suspicious-email": {
        "mail_abuse": ["postfix"],
        "phishing_reported_email": ["postfix", "roundcube_login", "mail_auth", "mail_apache_access", "suricata_mail"],
    },
    "malware-endpoint": {"malware": ["clamav", "defender", "crowdstrike", "edr"]},
    "ransomware-destructive": {"ransomware_response": ["ransomware_behavior", "mass_file_encryption",
                                                       "ransomware_encryption", "endpoint_ransomware",
                                                       "file_encryption_burst"]},
    "brute-force-password-spray": {
        "brute_force": ["sshd", "linux_auth", "postfix", "winlogon"],
        "brute_force_login": ["mail_auth", "waf_auth", "web_auth", "roundcube_login", "postfix"],
    },
    "cloud-identity-keys": {
        "cloud_iam_compromise": ["cloud_iam_anomaly", "iam_role_assumption", "oauth_token_replay",
                                 "risky_service_principal_signin", "impossible_travel"],
        "cloud_identity_compromise": ["cloud_iam_anomaly", "iam_role_assumption", "oauth_token_replay",
                                      "risky_service_principal_signin", "impossible_travel", "identity_signin"],
    },
    "data-exfiltration": {
        "data_exfiltration": ["data_exfiltration", "bulk_data_download", "cloud_storage_exfiltration",
                              "dns_tunneling", "loan_api_access"],
        "data_exfiltration_response": ["data_exfiltration", "bulk_data_download", "cloud_storage_exfiltration",
                                       "dns_tunneling", "loan_api_access"],
    },
    "web-application-attack": {
        "web_attack": ["modsecurity", "modsec_audit_log", "nginx", "apache"],
        "web_application_abuse": ["web_app_endpoint_abuse", "web_app_session_token_reuse",
                                  "web_app_dangerous_file_upload", "web_app_path_enumeration",
                                  "web_app_privileged_admin_action", "web_app_sensitive_data_access"],
    },
    "scanning-reconnaissance": {
        "port_scan": ["suricata", "et_scan"],
        "vuln_scan": ["nessus-openvas", "nessus", "openvas", "nikto"],
        "web_scanner_activity": ["automated_vulnerability_scanning", "suspicious_web_shell_execution"],
    },
    "suspicious-outbound": {
        "ip_reputation": ["enrichment"],
        "suspicious_outbound_connection": ["suricata_mail", "ml_stats"],
    },
    "privileged-misuse-insider": {"privileged_web_access": ["external_admin_panel_access"]},
}
# Rules a built-in carries beyond the union of its merged files, with the reason:
# * web-application-attack also takes ``suspicious_web_shell_execution``: an executed
#   web shell is an exploited web application, not scanning, so the web runbook
#   (priority 80) wins it over scanning (75), which keeps it as its union requires;
# * compromised-account is new (no merged file); it takes the sign-in rules
#   ``impossible_travel`` and ``identity_signin`` (priority 84) from cloud identity
#   (82), which keeps them as its union requires.
EXTRA_RULES: dict[str, list[str]] = {
    "web-application-attack": ["suspicious_web_shell_execution"],
    "compromised-account": ["impossible_travel", "identity_signin"],
}

# The entity types of the same retired files (``applies_to_entities``,
# ``match.entity_types``). A built-in's ``applies_when.entity_types`` is their union,
# or empty (any entity) when a merged file allowed every entity (it listed ``rule``,
# which a rule-keyed case has), SPEC §4.10.14.
LEGACY_ENTITY_TYPES: dict[str, dict[str, list[str]]] = {
    "phishing-suspicious-email": {"mail_abuse": ["ip"], "phishing_reported_email": ["user", "ip"]},
    "malware-endpoint": {"malware": ["host", "ip"]},
    "ransomware-destructive": {"ransomware_response": ["host", "user", "ip", "rule"]},
    "brute-force-password-spray": {"brute_force": ["ip", "user"], "brute_force_login": ["ip", "user", "host"]},
    "cloud-identity-keys": {"cloud_iam_compromise": ["user", "host", "ip"],
                            "cloud_identity_compromise": ["user", "host", "ip", "rule"]},
    "data-exfiltration": {"data_exfiltration": ["user", "host", "ip"],
                          "data_exfiltration_response": ["user", "host", "ip", "rule"]},
    "web-application-attack": {"web_attack": ["ip"], "web_application_abuse": ["ip", "user", "host", "rule"]},
    "scanning-reconnaissance": {"port_scan": ["ip"], "vuln_scan": ["ip"],
                                "web_scanner_activity": ["ip", "host", "rule"]},
    "suspicious-outbound": {"ip_reputation": ["ip"], "suspicious_outbound_connection": ["ip", "host"]},
    "privileged-misuse-insider": {"privileged_web_access": ["ip", "user", "host", "rule"]},
}
EXPECTED_ENTITY_TYPES: dict[str, set[str]] = {
    "phishing-suspicious-email": {"ip", "user"},
    "malware-endpoint": {"host", "ip"},
    "brute-force-password-spray": {"ip", "user", "host"},
    "suspicious-outbound": {"ip", "host"},
}


def test_the_library_holds_exactly_the_twelve_built_ins() -> None:
    files = sorted(p.name for p in LIBRARY.glob("*.md"))
    assert files == sorted(f"{rid}.md" for rid in RM.BUILTIN_RUNBOOK_IDS)
    assert REFUSED == {}
    assert [b.id for b in LOADED] == list(RM.BUILTIN_RUNBOOK_IDS)
    assert len(LOADED) == 12


@pytest.mark.parametrize("rid", RM.BUILTIN_RUNBOOK_IDS)
def test_every_built_in_is_valid_and_versioned(rid: str) -> None:
    item = BY_ID[rid]
    assert item.version >= 1
    assert RM.valid_runbook_id(rid, "builtin")
    assert RM.validate_runbook(item.definition, origin="builtin", source=item.source, version=item.version) == []
    assert item.content_hash == RM.content_hash(item.definition)
    assert RM.normalise_definition(item.definition) == item.definition


@pytest.mark.parametrize("rid", RM.BUILTIN_RUNBOOK_IDS)
def test_every_built_in_fits_the_prompt_budget_with_nothing_cut(rid: str) -> None:
    item = BY_ID[rid]
    text = RM.render_runbook_prompt(item.definition, item.version)
    assert len(text) == item.prompt_chars <= RM.MAX_RUNBOOK_PROMPT_CHARS
    # Also at the widest version label a later release could give it.
    assert RM.prompt_chars(item.definition) <= RM.MAX_RUNBOOK_PROMPT_CHARS
    # Nothing is cut: every guidance line and every step title is in the rendering.
    defn = item.definition
    assert text.startswith(f"{defn.title} (v{item.version})\n{defn.summary}\n")
    for step in defn.steps:
        assert step.title in text
        if step.phase in ("triage", "investigate"):
            for line in (step.focus, step.escalate_if, step.benign_if):
                if line:
                    assert line in text
    assert "<<<" not in text and ">>>" not in text


@pytest.mark.parametrize("rid", RM.BUILTIN_RUNBOOK_IDS)
def test_every_built_in_survives_the_markdown_round_trip(rid: str) -> None:
    item = BY_ID[rid]
    parsed = RM.parse_runbook_markdown(item.source)
    assert parsed.issues == () and parsed.definition == item.definition and parsed.version == item.version
    exported = RM.export_runbook_markdown(parsed.definition, version=parsed.version)
    again = RM.parse_runbook_markdown(exported)
    assert again.issues == () and again.definition == parsed.definition and again.version == item.version


@pytest.mark.parametrize("rid", RM.BUILTIN_RUNBOOK_IDS)
def test_every_built_in_has_the_spec_shape(rid: str) -> None:
    defn = BY_ID[rid].definition
    assert defn.phases == EXPECTED_PHASES[rid]
    assert defn.mitre == EXPECTED_MITRE[rid]
    assert defn.review_every_days == RM.RUNBOOK_DEFAULT_REVIEW_DAYS
    # The Close phase, or the last phase, ends with the same Record step.
    last = defn.steps[-1]
    assert (last.kind, last.title) == ("record", "Record the outcome and what you would change")
    assert last.phase == defn.phases[-1]
    # Checks are written as questions, and every decision has its escalate / benign pair.
    for step in defn.steps:
        if step.kind == "check":
            assert step.title.endswith("?"), step.title
        if step.kind == "decision":
            assert step.escalate_if and step.benign_if
            assert 2 <= len(step.options) <= 6
    assert all(ref.startswith("https://") for ref in defn.references) and defn.references
    assert defn.references[-1] == "https://csrc.nist.gov/pubs/sp/800/61/r3/final"


@pytest.mark.parametrize("rid", [r for r in RM.BUILTIN_RUNBOOK_IDS if r != "generic-incident"])
def test_applies_when_is_the_union_of_the_merged_files(rid: str) -> None:
    aw = BY_ID[rid].definition.applies_when
    union: list[str] = []
    for rules in LEGACY_RULES.get(rid, {}).values():
        union += [r for r in rules if r not in union]
    expected = set(union) | set(EXTRA_RULES.get(rid, []))
    assert set(aw.rule_ids) == expected
    assert len(aw.rule_ids) == len(set(aw.rule_ids))
    assert aw.always is False
    # Built-ins are chosen by their rules; techniques are coverage, not a gate, so the
    # match never depends on the AI's technique labels (see the runbook_match docstring).
    assert aw.mitre == [] and aw.verdicts == [] and aw.statuses == [] and aw.any_tags == []


@pytest.mark.parametrize("rid", RM.BUILTIN_RUNBOOK_IDS)
def test_entity_types_are_the_union_of_the_merged_files(rid: str) -> None:
    merged = LEGACY_ENTITY_TYPES.get(rid, {})
    union: set[str] = set()
    for kinds in merged.values():
        union |= set(kinds)
    expected = set() if (not merged or "rule" in union) else union
    assert expected == EXPECTED_ENTITY_TYPES.get(rid, set())
    entity_types = BY_ID[rid].definition.applies_when.entity_types
    assert set(entity_types) == expected
    assert len(entity_types) == len(set(entity_types))
    assert set(entity_types) <= RM.CASE_CARRIED_ENTITY_KINDS


def test_the_generic_incident_is_the_only_fallback() -> None:
    fallbacks = [b.id for b in LOADED if b.definition.applies_when.always]
    assert fallbacks == [RM.GENERIC_INCIDENT_RUNBOOK_ID]
    generic = BY_ID["generic-incident"].definition
    assert M.present_criteria(generic.applies_when) == ["always"]


def test_the_legacy_map_covers_the_eighteen_retired_ids() -> None:
    legacy = RM.LEGACY_BUNDLED_RUNBOOK_MAP
    assert len(legacy) == 18
    expected = {old: new for new, merged in LEGACY_RULES.items() for old in merged}
    assert legacy == expected
    assert set(legacy.values()) == set(RM.BUILTIN_RUNBOOK_IDS) - {"compromised-account", "generic-incident"}
    assert RM.resolve_legacy_runbook_id(" brute_force_login ") == "brute-force-password-spray"
    assert RM.resolve_legacy_runbook_id("unknown") is None and RM.resolve_legacy_runbook_id(None) is None
    assert RM.SHADOWING_IDS == set(legacy) | set(RM.BUILTIN_RUNBOOK_IDS)
    assert len(RM.SHADOWING_IDS) == 30


@pytest.mark.parametrize("rid", RM.BUILTIN_RUNBOOK_IDS)
def test_built_in_copy_is_plain(rid: str) -> None:
    text = (LIBRARY / f"{rid}.md").read_text(encoding="utf-8")
    assert "—" not in text and "–" not in text
    assert re.search(r"playbook", text, re.IGNORECASE) is None
    assert re.search(r"tlsoc|trustlab", text, re.IGNORECASE) is None  # only the product name is used


def test_lookups_use_only_the_closed_template_values() -> None:
    seen: set[str] = set()
    for item in LOADED:
        for step in item.definition.steps:
            if step.lookup is None:
                continue
            for value in [*step.lookup.filter.values(), step.lookup.indicator or ""]:
                seen.update(re.findall(r"\{\{\s*([^{}]+?)\s*\}\}", value))
    assert seen and seen <= set(RM.RUNBOOK_TEMPLATE_VALUES)


# --------------------------------------------------------------------------- #
# Matching precedence between built-ins
# --------------------------------------------------------------------------- #
CATALOG = tuple(M.MatchableRunbook(id=b.id, version=b.version, definition=b.definition, origin="builtin")
                for b in LOADED)


@pytest.mark.parametrize(("rule", "entity", "winner"), [
    ("sshd", "ip", "brute-force-password-spray"),
    ("postfix", "ip", "brute-force-password-spray"),  # brute force (50) over phishing (45), as before
    ("mail_apache_access", "user", "phishing-suspicious-email"),
    ("suricata_mail", "ip", "phishing-suspicious-email"),  # phishing (45) over outbound (40), as before
    ("clamav", "host", "malware-endpoint"),
    ("edr", "host", "malware-endpoint"),
    ("edr", "ip", "malware-endpoint"),
    ("mass_file_encryption", "host", "ransomware-destructive"),
    ("impossible_travel", "user", "compromised-account"),
    ("iam_role_assumption", "user", "cloud-identity-keys"),
    ("dns_tunneling", "user", "data-exfiltration"),
    ("modsecurity", "ip", "web-application-attack"),
    ("suspicious_web_shell_execution", "host", "web-application-attack"),
    ("nikto", "ip", "scanning-reconnaissance"),
    ("enrichment", "ip", "suspicious-outbound"),
    ("external_admin_panel_access", "user", "privileged-misuse-insider"),
    ("never_seen_rule", "ip", "generic-incident"),
])
def test_built_in_precedence(rule: str, entity: str, winner: str) -> None:
    facts = M.CaseFacts(rule_values=(rule,), entity_types=frozenset({entity}), event_count=10)
    result = M.match(facts, CATALOG)
    assert result.winner is not None and result.winner.id == winner
    assert result.explanation.tie is False


def test_entity_types_still_narrow_a_built_in() -> None:
    # mail_apache_access names only phishing, which applies to IP and user cases; a
    # host-keyed case falls back to the generic runbook.
    facts = M.CaseFacts(rule_values=("mail_apache_access",), entity_types=frozenset({"host"}))
    assert M.match(facts, CATALOG).winner.id == "generic-incident"
    # The same holds for malware, whose merged file named host and IP cases only.
    for kinds in (frozenset({"user"}), frozenset()):
        facts = M.CaseFacts(rule_values=("clamav",), entity_types=kinds)
        assert M.match(facts, CATALOG).winner.id == "generic-incident", kinds


# --------------------------------------------------------------------------- #
# Every built-in lookup can bind on a case of its own runbook
# --------------------------------------------------------------------------- #
_FIRST = datetime(2026, 10, 26, 12, 52, tzinfo=timezone.utc)
_LAST = datetime(2026, 10, 26, 13, 40, tzinfo=timezone.utc)
_NOW = datetime(2026, 10, 27, 9, 0, tzinfo=timezone.utc)


def _representative_cluster(rid: str) -> Cluster:
    """A cluster of the first of ``rid``'s rules that ``rid`` wins (a rule two
    built-ins share goes to one of them), keyed by IP, whose events carry what a
    detection for it usually reports: IP, user, host, a file hash and a domain."""
    aw = BY_ID[rid].definition.applies_when
    ip_facts = [(r, M.CaseFacts(rule_values=(r,), entity_types=frozenset({"ip"}))) for r in aw.rule_ids]
    rule = next((r for r, facts in ip_facts if M.match(facts, CATALOG).winner.id == rid), "never_seen_rule")
    millis = int(_FIRST.timestamp() * 1000)
    events = [RawEvent(id=f"e{i}", ip="203.0.113.45", user="asha", host="ws-01", rule=rule, timestamp_millis=millis,
                       source={"file": {"hash": {"sha256": "9f" * 32}}, "url": {"domain": "evil.example.com"}})
              for i in range(3)]
    return Cluster(signature=f"sig-{rid}", entity=Entity(type=EntityType.IP, value="203.0.113.45"),
                   group_by=EntityType.IP, rule_values=[rule], member_events=events, count=3,
                   first_seen_millis=millis, last_seen_millis=int(_LAST.timestamp() * 1000))


@pytest.mark.parametrize("rid", RM.BUILTIN_RUNBOOK_IDS)
def test_every_built_in_lookup_binds_on_a_case_of_its_runbook(rid: str) -> None:
    cluster = _representative_cluster(rid)
    assert M.match(M.case_facts_from_cluster(cluster), CATALOG).winner.id == rid
    values = L.case_values_from_cluster(cluster)
    lookups = [step for step in BY_ID[rid].definition.steps if step.lookup is not None]
    assert lookups, rid
    for step in lookups:
        bound = L.bind_lookup(step.lookup, values, now=_NOW)
        assert isinstance(bound, L.LookupBinding), (rid, step.id, bound)


@pytest.mark.parametrize("rid", RM.BUILTIN_RUNBOOK_IDS)
def test_no_lookup_reads_the_case_ip_as_a_destination(rid: str) -> None:
    # A case's IP is the event's source IP (Preferences.source_ip_field), so comparing
    # a destination field with it would answer a different question than the title.
    for step in BY_ID[rid].definition.steps:
        if step.lookup is None:
            continue
        for key, value in step.lookup.filter.items():
            if L.template_name(value) == "entity.ip":
                assert not key.startswith("destination."), (rid, step.id, key)


def test_suspicious_outbound_lists_destinations_and_their_domain_reputation() -> None:
    steps = {s.id: s for s in BY_ID["suspicious-outbound"].definition.steps}
    destinations, reputation = steps["destinations"], steps["destination-reputation"]
    assert destinations.title == "Where did this address connect, and how often?"
    assert destinations.lookup.tool == "log_stats"
    assert destinations.lookup.filter == {"ip": "{{entity.ip}}"}
    assert destinations.lookup.group_by == ["destination.ip", "destination.port"]
    assert reputation.title == "Reputation of the destination domain"
    assert (reputation.lookup.tool, reputation.lookup.indicator) == ("enrich", "{{entity.domain}}")


def _log_lookups() -> list[tuple[str, object]]:
    return [(item.id, step) for item in LOADED for step in item.definition.steps
            if step.lookup is not None and step.lookup.tool in ("log_stats", "log_search")]


def _mapped_physical_paths() -> set[str]:
    """Every physical path a logical field resolves to by default, and on Wazuh."""
    from app.config import Preferences
    from app.connectors.base import aggregate_field

    defaults = Preferences()
    wazuh = defaults.model_copy(update={"source_ip_field": "data.srcip", "user_field": "data.srcuser",
                                        "host_field": "agent.name"})
    out: set[str] = set()
    for prefs in (defaults, wazuh):
        for name in L.LOOKUP_LOGICAL_FIELDS:
            path = aggregate_field(prefs, name)
            assert path, name
            out.add(path)
    return out


def test_no_built_in_lookup_names_a_path_that_a_logical_field_maps() -> None:
    # The suite's field mapping is per source (Wazuh keeps the source IP in
    # data.srcip), so a built-in that filtered on source.ip would read nothing there
    # and store "0" as evidence. Built-ins name the source's mapped field instead.
    mapped = _mapped_physical_paths()
    assert {"source.ip", "user.name", "host.name", "event.action", "rule.name", "data.srcip"} <= mapped
    lookups = _log_lookups()
    assert lookups
    for rid, step in lookups:
        names = [*step.lookup.filter, *step.lookup.group_by]
        assert not set(names) & mapped, (rid, step.id, names)


def test_every_built_in_log_filter_on_a_case_entity_is_logical() -> None:
    for rid, step in _log_lookups():
        for key, value in step.lookup.filter.items():
            name = L.template_name(value)
            if name in ("entity.ip", "entity.user", "entity.host"):
                assert key == name.split(".", 1)[1] and L.is_logical_field(key), (rid, step.id, key)


def _fixed_path_logical_fields() -> dict[str, str]:
    """The logical names whose path stays put when every mapped field moves, asked of
    the connector itself (``action`` is ECS ``event.action`` on every source)."""
    from app.config import Preferences
    from app.connectors.base import AGGREGATE_FIELDS, aggregate_field

    ecs = Preferences()
    remapped = ecs.model_copy(update={attr: f"vendor.{attr}" for attr in AGGREGATE_FIELDS.values() if attr})
    out: dict[str, str] = {}
    for name in L.LOOKUP_LOGICAL_FIELDS:
        path = aggregate_field(ecs, name)
        if path and path == aggregate_field(remapped, name):
            out[name] = path
    return out


def test_every_physical_field_a_built_in_reads_is_named_for_the_analyst() -> None:
    # A field no mapping names is read as its ECS path on every source: a physical
    # path, or a logical name with a fixed path (``action`` reads ``event.action``).
    # The step names that path, so an empty split on a source that does not record it
    # is never read as "none".
    fixed = _fixed_path_logical_fields()
    assert fixed == dict(L.LOOKUP_FIXED_FIELD_PATHS) == {"action": "event.action"}
    checked: set[str] = set()
    for rid, step in _log_lookups():
        for name in [*step.lookup.filter, *step.lookup.group_by]:
            path = fixed.get(name) if L.is_logical_field(name) else name
            if path is None:
                continue
            checked.add(name)
            assert f"`{path}`" in step.instructions and "ECS" in step.instructions, (rid, step.id, name)
    # The built-ins do read both kinds, so the check above is not vacuous.
    assert "action" in checked and {"event.outcome", "destination.ip", "url.domain"} <= checked


def test_every_built_in_step_that_splits_by_action_says_an_empty_split_is_not_none() -> None:
    steps = [(rid, step) for rid, step in _log_lookups() if "action" in step.lookup.group_by]
    assert {(rid, step.id) for rid, step in steps} == {
        ("cloud-identity-keys", "api-activity"), ("cloud-identity-keys", "new-locations"),
        ("data-exfiltration", "transfer-volume"), ("phishing-suspicious-email", "find-copies"),
        ("phishing-suspicious-email", "clicks"), ("privileged-misuse-insider", "privileged-actions")}
    for rid, step in steps:
        assert "the field is missing, not that" in step.instructions, (rid, step.id)


def test_malware_finds_other_hosts_with_the_hash_in_the_logs() -> None:
    # A case is keyed by an IP, a user or a host, never a hash, so a related-cases
    # lookup by hash would always store "none" (false scoping evidence). The step
    # counts the hosts whose logs show the hash instead.
    step = {s.id: s for s in BY_ID["malware-endpoint"].definition.steps}["same-hash-hosts"]
    assert step.title == "Other hosts with the same hash"
    lookup = step.lookup
    assert (lookup.tool, lookup.filter, lookup.group_by, lookup.run) == (
        "log_stats", {"file.hash.sha256": "{{entity.hash}}"}, ["host"], "on_attach")
    assert lookup.window == "case_last_seen-7d..case_last_seen+1h"
    bound = L.bind_lookup(lookup, L.case_values_from_cluster(_representative_cluster("malware-endpoint")), now=_NOW)
    assert isinstance(bound, L.LookupBinding)
    assert bound.filters == (L.BoundFilter("file.hash.sha256", "9f" * 32, "entity.hash", False),)
    assert bound.logical_group_by == ("host",)
    for item in LOADED:
        for s in item.definition.steps:
            if s.lookup is not None and s.lookup.tool in ("related_cases", "campaign"):
                entity = L.template_name(s.lookup.filter.get("entity", ""))
                assert entity is None or entity.split(".", 1)[1] in L.CASE_CARRIED_ENTITY_KINDS, (item.id, s.id)


# --------------------------------------------------------------------------- #
# The loader
# --------------------------------------------------------------------------- #
def test_the_library_is_loaded_once_and_cached() -> None:
    first = RM.load_builtin_runbooks()
    assert first is RM.load_builtin_runbooks()
    assert [b.id for b in first] == list(RM.BUILTIN_RUNBOOK_IDS)
    assert RM.builtin_runbook("generic-incident") is first[-1]
    assert RM.builtin_runbook("nope") is None


def test_the_loader_refuses_a_broken_file_and_keeps_the_rest(tmp_path: Path) -> None:
    for name in ("generic-incident.md", "malware-endpoint.md"):
        shutil.copy(LIBRARY / name, tmp_path / name)
    (tmp_path / "README.md").write_text("# not a runbook\n", encoding="utf-8")
    good = (LIBRARY / "scanning-reconnaissance.md").read_text(encoding="utf-8")
    (tmp_path / "no-version.md").write_text(good.replace("id: scanning-reconnaissance", "id: no-version")
                                            .replace("version: 1\n", ""), encoding="utf-8")
    (tmp_path / "wrong-name.md").write_text(good, encoding="utf-8")
    (tmp_path / "broken.md").write_text("---\nid: broken\n---\n## Nowhere\n", encoding="utf-8")
    loaded, refused = RM.load_builtin_library(tmp_path)
    assert [b.id for b in loaded] == ["malware-endpoint", "generic-incident"]
    assert set(refused) == {"no-version.md", "wrong-name.md", "broken.md"}
    assert any(i.path == "version" for i in refused["no-version.md"])
    assert any("match the file name" in i.message for i in refused["wrong-name.md"])
    assert RM.load_builtin_library(tmp_path / "missing") == ((), {})
