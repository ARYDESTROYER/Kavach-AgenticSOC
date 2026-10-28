"""The runbook model (Round 14 SPEC §4.10.2, §4.10.9, §4.10.13, §4.10.14). Pure.

One Runbooks feature replaces the two retired procedure features. A runbook is a
phased, step-by-step response procedure: phases come from a fixed vocabulary (NIST
SP 800-61r3 and SANS PICERL, :data:`PHASE_FRAMEWORKS`), steps are one of five kinds
(Check, Lookup, Decision, Action, Record) and ``applies_when`` decides
deterministically which cases it fits (``engine/runbook_match.py``).

The wire models live in ``app/models.py`` (the single home of every model) and are
re-exported here. This module owns what can be decided from a definition alone:

* :func:`validate_runbook`: every content rule as a list of plain-sentence
  :class:`RunbookIssue` (the editor's live check, the import, the migration and
  publish all call it). A draft may hold invalid content; only a version with no
  issues can be published, and only Published text is ever trusted (#9).
* :func:`render_runbook_prompt`: the investigator's rendering of a Published version,
  held to :data:`MAX_RUNBOOK_PROMPT_CHARS` (E10). The prompt never truncates: an
  over-budget operator version cannot be published, and a test holds every bundled
  runbook within the budget.
* The native Markdown format (§4.10.13): :func:`parse_runbook_markdown` and
  :func:`export_runbook_markdown`, dependency-free (a strict subset of YAML front
  matter: scalars, flow lists, block lists and one level of nested mapping). Export
  then parse gives back an equal definition. Parsing and validation are linear and
  bounded: a source over 64 KiB is refused unread and at most
  :data:`RUNBOOK_MAX_ISSUES` issues are reported.
* :func:`parse_frontmatter`, which moved here from the retired
  ``engine/runbooks.py``, reads legacy documents (the migration): the same strict
  subset first, then the retired reader's lenient rules, so nothing it kept is lost.
* :func:`canonical_definition_json` and :func:`content_hash` (SHA-256 of the
  canonical definition, ``RunbookVersionDoc.content_hash``).
* The built-in library: 12 Markdown files under ``app/runbooks/library/``, loaded
  once and cached, never stored (:func:`load_builtin_runbooks`), and
  :data:`LEGACY_BUNDLED_RUNBOOK_MAP` from each of the 18 retired bundled procedure ids
  to the built-in that merged it (used by automation rules that still name a legacy
  id, and to show the stored ``Case.playbook_id`` and chat references).

Nothing here touches a store, the network or the model gateway (a test asserts it).
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Literal

from pydantic import ValidationError

from ..constants import INVISIBLE_TEXT_CLASS, CaseStatus, SourceType
from ..models import (
    LOOKUP_TOOLS,
    MAX_OPERATOR_RUNBOOKS,
    MAX_RUNBOOK_VERSIONS,
    MAX_RUNS_PER_CASE,
    PHASE_IDS,
    PHASE_LABELS,
    RUNBOOK_APPLIES_MAX_MITRE,
    RUNBOOK_APPLIES_MAX_RULE_CHARS,
    RUNBOOK_APPLIES_MAX_RULES,
    RUNBOOK_APPLIES_MAX_SOURCES,
    RUNBOOK_APPLIES_MAX_STATUSES,
    RUNBOOK_APPLIES_MAX_TAG_CHARS,
    RUNBOOK_APPLIES_MAX_TAGS,
    RUNBOOK_BUILTIN_ID_PATTERN,
    RUNBOOK_DECISION_MAX_LABEL_CHARS,
    RUNBOOK_DECISION_MAX_OPTIONS,
    RUNBOOK_DECISION_MIN_OPTIONS,
    RUNBOOK_DEFAULT_LOOKUP_WINDOW,
    RUNBOOK_DEFINITION_TRANSPORT_MAX_CHARS,
    RUNBOOK_DEFAULT_REVIEW_DAYS,
    RUNBOOK_ENTITY_TYPES,
    RUNBOOK_EVIDENCE_MAX_URL_CHARS,
    RUNBOOK_MAX_PHASES,
    RUNBOOK_MAX_PREREQUISITES_CHARS,
    RUNBOOK_MAX_REFERENCES,
    RUNBOOK_MAX_RETRIEVAL_QUERIES,
    RUNBOOK_MAX_RETRIEVAL_QUERY_CHARS,
    RUNBOOK_MAX_SOURCE_BYTES,
    RUNBOOK_MAX_STEPS,
    RUNBOOK_MAX_SUMMARY_CHARS,
    RUNBOOK_MAX_TITLE_CHARS,
    RUNBOOK_MAX_USE_WHEN_CHARS,
    RUNBOOK_OPERATOR_ID_PATTERN,
    RUNBOOK_RESERVED_IDS,
    RUNBOOK_SLUG_PATTERN,
    RUNBOOK_STEP_MAX_GUIDANCE_CHARS,
    RUNBOOK_STEP_MAX_INSTRUCTIONS_CHARS,
    RUNBOOK_STEP_MAX_TITLE_CHARS,
    RUNBOOK_TEMPLATE_VALUES,
    SEVERITY_LEVELS,
    STEP_KINDS,
    AppliesWhen,
    DecisionOption,
    LookupTemplate,
    RunbookAppliesTo,
    RunbookDefinition,
    RunbookIssue,
    RunbookStep,
    RunbookVersionDoc,
    https_url,
)
from .runbook_lookup import (
    CASE_CARRIED_ENTITY_KINDS,
    RUNBOOK_MAX_ISSUES,
    template_names_in,
    unknown_template_message,
    validate_lookup,
)

logger = logging.getLogger("tlsoc.engine.runbook_model")

# --------------------------------------------------------------------------- #
# Vocabulary and limits
# --------------------------------------------------------------------------- #
#: The investigator rendering's budget (E10). One constant for publish validation,
#: the editor's meter and the prompt itself, which never truncates.
MAX_RUNBOOK_PROMPT_CHARS = 3_000

#: Console labels of the five step kinds.
KIND_LABELS: dict[str, str] = {
    "check": "Check",
    "lookup": "Lookup",
    "decision": "Decision",
    "action": "Action",
    "record": "Record",
}
assert tuple(KIND_LABELS) == STEP_KINDS

#: How each phase maps to the two response frameworks (SPEC §4.10.2).
PHASE_FRAMEWORKS: dict[str, dict[str, str]] = {
    "triage": {"nist": "DE.AE, RS.MA-02, RS.MA-03", "sans": "Identification"},
    "investigate": {"nist": "RS.AN-03, RS.AN-06 to RS.AN-08", "sans": "Identification"},
    "contain": {"nist": "RS.MI-01", "sans": "Containment"},
    "eradicate": {"nist": "RS.MI-02", "sans": "Eradication"},
    "recover": {"nist": "RC.RP-01 to RC.RP-06", "sans": "Recovery"},
    "close": {"nist": "RC.CO-03, RC.CO-04, ID.IM", "sans": "Lessons learned"},
}
assert tuple(PHASE_FRAMEWORKS) == PHASE_IDS

#: Phases the investigator rendering spells out step by step (the rest are one line).
PROMPT_DETAILED_PHASES: frozenset[str] = frozenset({"triage", "investigate"})

#: The steps that may carry the escalate / benign pair, and the steps an approval
#: role applies to.
GUIDANCE_PAIR_KINDS: frozenset[str] = frozenset({"check", "decision"})
APPROVAL_KINDS: frozenset[str] = frozenset({"action", "record"})

RUNBOOK_OWNER_MAX_CHARS = 120
RUNBOOK_ROLE_MAX_CHARS = 64
RUNBOOK_MITRE_MAX = RUNBOOK_APPLIES_MAX_MITRE
_REACT_RE = re.compile(r"^RA\d{4}$")
_D3FEND_RE = re.compile(r"^D3-[A-Z0-9]{1,12}$")
_TECHNIQUE_RE = re.compile(r"^T\d{4}(?:\.\d{3})?$")
_BUILTIN_ID_RE = re.compile(RUNBOOK_BUILTIN_ID_PATTERN)
_OPERATOR_ID_RE = re.compile(RUNBOOK_OPERATOR_ID_PATTERN)
_SLUG_RE = re.compile(RUNBOOK_SLUG_PATTERN)
#: A source id in ``applies_when.sources`` (the lookup grammar of a source id).
_SOURCE_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}")
#: What a runbook text may never hold: the shared invisible set plus lone surrogate
#: halves (they cannot be encoded, so they would break a store write or a response).
_UNSAFE_CHARS_RE = re.compile(f"[{INVISIBLE_TEXT_CLASS}\\ud800-\\udfff]")
#: Every code point whose NFKC form is an angle bracket: the bracket set the prompt
#: marker normaliser folds (``agents/prompts.py``). Copied rather than imported so
#: this module stays pure; :func:`_has_prompt_marker` uses it.
_MARKER_LT_CHARS = "<﹤＜"
_MARKER_GT_CHARS = ">﹥＞"
_MARKER_RE = re.compile(f"[{_MARKER_LT_CHARS}]{{3}}|[{_MARKER_GT_CHARS}]{{3}}")
#: What the normaliser's folded view drops before it looks for a marker.
_MARKER_FOLD_DROPPED = frozenset({"Cc", "Cf", "Cs", "Mn", "Me"})
_CASE_STATUSES: tuple[str, ...] = tuple(s.value for s in CaseStatus)
_SOURCE_TYPES: tuple[str, ...] = tuple(s.value for s in SourceType)
_VERDICTS: tuple[str, ...] = ("TRUE_POSITIVE", "FALSE_POSITIVE", "NEEDS_HUMAN")

RunbookOriginKind = Literal["builtin", "operator", "imported"]

# Issue codes. A route answers ``422 runbook_id_reserved`` for ``reserved`` (one of
# the fixed reserved ids, RUNBOOK_RESERVED_IDS) and for ``builtin_id`` (an operator or
# imported runbook with one of the 12 built-in ids), ``422 runbook_prompt_budget`` when
# the budget is the only problem, and ``422 runbook_invalid`` otherwise
# (:func:`blocking_error_code`). The two id codes are separate so an import can tell
# them apart: an exported built-in imports back as a Draft under a new id (SPEC
# §4.10.13), while a reserved route name is simply refused. The editor hides
# ``required`` issues until the author leaves the field or tries to save (F17).
ISSUE_REQUIRED = "required"
ISSUE_TOO_LONG = "too_long"
ISSUE_TOO_MANY = "too_many"
ISSUE_TOO_FEW = "too_few"
ISSUE_INVALID = "invalid"
ISSUE_DUPLICATE = "duplicate"
ISSUE_RESERVED = "reserved"
ISSUE_BUILTIN_ID = "builtin_id"
ISSUE_NOT_ALLOWED = "not_allowed"
ISSUE_TEMPLATE_VALUE = "template_value"
ISSUE_ORDER = "order"
ISSUE_REFERENCE = "reference"
ISSUE_UNUSED = "unused"
ISSUE_SINGLE_LINE = "single_line"
ISSUE_UNSAFE_TEXT = "unsafe_text"
ISSUE_MARKDOWN = "markdown"
ISSUE_PROMPT_BUDGET = "prompt_budget"
ISSUE_SOURCE_SIZE = "source_too_large"
ISSUE_UNKNOWN_KEY = "unknown_key"
ISSUE_PARSE = "parse"
ISSUE_MORE = "more_issues"

# RUNBOOK_MAX_ISSUES (defined beside the lookup check, which this module imports, and
# re-exported here): at most this many issues are reported for one check (the parser
# and the validator each), then one ``more_issues`` issue says there are more. A
# hostile source of stray lines must not turn into an unbounded list, and no check
# does work past the point where nothing more could be reported.
#: The message of the final ``more_issues`` issue.
_MORE_ISSUES_MESSAGE = "There are more problems; fix these first."
#: The largest definition :func:`validate_runbook` checks field by field, measured as
#: its JSON text as given (sorted keys, no insignificant whitespace; nothing is
#: normalised before the measure). It is the request transport bound
#: (``RUNBOOK_DEFINITION_TRANSPORT_MAX_CHARS``), so every definition a route accepts
#: is checked field by field; anything larger (only a direct caller can pass one)
#: gets a single size issue before any content is scanned.
RUNBOOK_MAX_DEFINITION_CHARS = RUNBOOK_DEFINITION_TRANSPORT_MAX_CHARS


def _capped(issues: list[RunbookIssue]) -> list[RunbookIssue]:
    """``issues`` cut to :data:`RUNBOOK_MAX_ISSUES`, plus one ``more_issues`` issue
    when anything was cut."""
    if len(issues) <= RUNBOOK_MAX_ISSUES:
        return issues
    return [*issues[:RUNBOOK_MAX_ISSUES], RunbookIssue(path="", code=ISSUE_MORE, message=_MORE_ISSUES_MESSAGE)]


def _has_prompt_marker(text: str) -> bool:
    """True when ``text`` holds three angle brackets in a row (``<<<`` or ``>>>``) in
    any bracket form the prompt normaliser folds, also with hidden, control or
    combining characters between them (the normaliser's folded view drops those, so
    it would read them as a marker)."""
    if _MARKER_RE.search(text):
        return True
    if (sum(text.count(ch) for ch in _MARKER_LT_CHARS) < 3
            and sum(text.count(ch) for ch in _MARKER_GT_CHARS) < 3):
        return False
    folded = "".join(ch for ch in text if unicodedata.category(ch) not in _MARKER_FOLD_DROPPED)
    return bool(_MARKER_RE.search(folded))

# --------------------------------------------------------------------------- #
# The built-in library and the legacy id map
# --------------------------------------------------------------------------- #
#: Where the 12 built-in runbooks ship (package data).
RUNBOOK_LIBRARY_DIR = Path(__file__).resolve().parent.parent / "runbooks" / "library"

#: The built-in runbooks, in library order (SPEC §4.10.14).
BUILTIN_RUNBOOK_IDS: tuple[str, ...] = (
    "phishing-suspicious-email",
    "malware-endpoint",
    "ransomware-destructive",
    "brute-force-password-spray",
    "compromised-account",
    "cloud-identity-keys",
    "data-exfiltration",
    "web-application-attack",
    "scanning-reconnaissance",
    "suspicious-outbound",
    "privileged-misuse-insider",
    "generic-incident",
)
#: The fallback runbook (``applies_when.always``), attached when nothing else matches.
GENERIC_INCIDENT_RUNBOOK_ID = "generic-incident"

#: Each of the 18 retired bundled procedure ids (9 from the retired
#: ``backend/playbooks/`` directory, 9 retired reference runbooks) to the built-in that
#: merged it (the Merges column of SPEC §4.10.14). Used at fire
#: time by automation rules that still name a legacy id (``run_playbook`` with
#: ``payload.playbook_id``, see :func:`resolve_automation_runbook_id`), to show
#: ``Case.playbook_id`` and stored chat references, and by the migration's shadow rule.
#:
#: Precedence for automation: a ``payload.playbook_id`` that one of the 9 retired
#: bundled PLAYBOOKS held (:data:`LEGACY_BUNDLED_PLAYBOOK_IDS`) resolves through this
#: map BEFORE the migration's id map. Before Round 14 a bundled playbook always won an
#: id collision (``app/playbooks/durable.py``, ``shadowed_by_bundled``), so such a rule
#: ran the bundled procedure, and an operator document with that id never ran; the
#: migration turns that document into a Draft (``<id>-imported``), and resolving the
#: rule through the id map would skip it. The 9 retired reference runbook ids were
#: never playbooks, so a ``run_playbook`` rule naming one ran the operator playbook of
#: that id: the id map comes first for them, as for any other id.
LEGACY_BUNDLED_RUNBOOK_MAP: dict[str, str] = {
    # Retired bundled procedures (backend/playbooks/*.md).
    "brute_force_login": "brute-force-password-spray",
    "cloud_identity_compromise": "cloud-identity-keys",
    "data_exfiltration_response": "data-exfiltration",
    "phishing_reported_email": "phishing-suspicious-email",
    "privileged_web_access": "privileged-misuse-insider",
    "ransomware_response": "ransomware-destructive",
    "suspicious_outbound_connection": "suspicious-outbound",
    "web_application_abuse": "web-application-attack",
    "web_scanner_activity": "scanning-reconnaissance",
    # Retired bundled reference runbooks (backend/app/runbooks/*.md).
    "brute_force": "brute-force-password-spray",
    "cloud_iam_compromise": "cloud-identity-keys",
    "data_exfiltration": "data-exfiltration",
    "ip_reputation": "suspicious-outbound",
    "mail_abuse": "phishing-suspicious-email",
    "malware": "malware-endpoint",
    "port_scan": "scanning-reconnaissance",
    "vuln_scan": "scanning-reconnaissance",
    "web_attack": "web-application-attack",
}
assert set(LEGACY_BUNDLED_RUNBOOK_MAP.values()) <= set(BUILTIN_RUNBOOK_IDS)


#: The 9 ids the retired bundled playbooks (``backend/playbooks/*.md``) held. A
#: ``run_playbook`` rule naming one ran the bundled playbook, never an operator
#: document of the same id (see :data:`LEGACY_BUNDLED_RUNBOOK_MAP`).
LEGACY_BUNDLED_PLAYBOOK_IDS: frozenset[str] = frozenset({
    "brute_force_login", "cloud_identity_compromise", "data_exfiltration_response",
    "phishing_reported_email", "privileged_web_access", "ransomware_response",
    "suspicious_outbound_connection", "web_application_abuse", "web_scanner_activity",
})
assert LEGACY_BUNDLED_PLAYBOOK_IDS <= set(LEGACY_BUNDLED_RUNBOOK_MAP)


def resolve_legacy_runbook_id(legacy_id: Any) -> str | None:
    """The built-in that replaced the retired bundled procedure ``legacy_id``, or
    ``None`` when the id is not one of the 18 legacy bundled ids.

    For an automation rule, call :func:`resolve_automation_runbook_id`, which applies
    this map before the migration's id map for the ids the retired bundled playbooks
    held, and after it for every other id."""
    if not isinstance(legacy_id, str):
        return None
    return LEGACY_BUNDLED_RUNBOOK_MAP.get(legacy_id.strip())


def resolve_automation_runbook_id(payload: Any, migrated_playbooks: Any = None) -> str | None:
    """The runbook a ``run_playbook`` automation rule attaches, resolved at fire time
    from its stored ``payload`` (SPEC §4.10.16; stored Preferences are never
    rewritten), or ``None`` when the rule names nothing this can resolve.

    ``migrated_playbooks`` maps a legacy operator playbook id to the id the migration
    gave it. The caller builds it from the migration marker's ``id_map`` (SPEC
    §4.10.17 step 6): the entries of the namespaces a ``run_playbook`` rule could run
    before Round 14 (the operator playbooks and the playbook directory), keyed by the
    bare legacy id; never the reference runbooks, which were not playbooks. It is
    empty or ``None`` before the migration has run.

    In order:

    1. ``payload.runbook_id`` (what the rule editor's "Attach a runbook" writes);
    2. a ``payload.playbook_id`` that a retired bundled playbook held
       (:data:`LEGACY_BUNDLED_PLAYBOOK_IDS`) through :data:`LEGACY_BUNDLED_RUNBOOK_MAP`:
       the rule ran that bundled playbook before the upgrade, never the operator
       document the migration turned into a shadowed Draft;
    3. ``payload.playbook_id`` through ``migrated_playbooks`` (operator documents);
    4. ``payload.playbook_id`` through :data:`LEGACY_BUNDLED_RUNBOOK_MAP` (a retired
       reference runbook id), for a rule that fires before the migration or names no
       migrated document.

    The caller then checks the target: a runbook that is unknown, a Draft or retired is
    skipped with ``run.attach_skipped``. Pure: it reads only its arguments."""
    if not hasattr(payload, "get"):
        return None
    runbook_id = payload.get("runbook_id")
    if isinstance(runbook_id, str) and runbook_id.strip():
        return runbook_id.strip()
    playbook_id = payload.get("playbook_id")
    if not isinstance(playbook_id, str) or not playbook_id.strip():
        return None
    playbook_id = playbook_id.strip()
    if playbook_id in LEGACY_BUNDLED_PLAYBOOK_IDS:
        return LEGACY_BUNDLED_RUNBOOK_MAP[playbook_id]
    migrated = migrated_playbooks.get(playbook_id) if hasattr(migrated_playbooks, "get") else None
    if isinstance(migrated, str) and migrated.strip():
        return migrated.strip()
    return resolve_legacy_runbook_id(playbook_id)


#: The ids an operator document must not take (the legacy shadow rule of §4.10.17):
#: the 18 legacy bundled ids and the 12 built-in ids.
SHADOWING_IDS: frozenset[str] = frozenset(LEGACY_BUNDLED_RUNBOOK_MAP) | frozenset(BUILTIN_RUNBOOK_IDS)


# --------------------------------------------------------------------------- #
# Small pure helpers (also used by the migration and the catalog)
# --------------------------------------------------------------------------- #
_SENTENCE_END_RE = re.compile(r"[.!?](?=\s|$)")


def cut_text(text: str, limit: int) -> tuple[str, str]:
    """``(kept, rest)``: ``text`` cut to at most ``limit`` characters at the last
    sentence boundary, else the last word boundary, else hard. Nothing is lost:
    ``rest`` is what did not fit (stripped of leading whitespace)."""
    if limit <= 0:
        return "", text.strip()
    if len(text) <= limit:
        return text, ""
    window = text[:limit + 1]
    ends = [m.end() for m in _SENTENCE_END_RE.finditer(window) if m.end() <= limit]
    if ends:
        cut = ends[-1]
    else:
        space = window.rfind(" ", 0, limit + 1)
        cut = space if space > 0 else limit
    return text[:cut].rstrip(), text[cut:].lstrip()


def slugify(text: Any, *, max_len: int = 64, fallback: str = "step") -> str:
    """A lower-case slug (``a-z``, ``0-9``, ``-``) of ``text`` for a step or runbook
    id, at most ``max_len`` characters; ``fallback`` when nothing is left."""
    ascii_text = unicodedata.normalize("NFKD", str(text or "")).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_text.lower()).strip("-")
    slug = slug[:max_len].rstrip("-")
    return slug or fallback


def unique_slug(text: Any, taken: Iterable[str], *, max_len: int = 64, fallback: str = "step") -> str:
    """:func:`slugify` made unique against ``taken`` with ``-2``, ``-3`` (fitted to
    ``max_len`` by shortening the base)."""
    used = set(taken)
    base = slugify(text, max_len=max_len, fallback=fallback)
    candidate, n = base, 2
    while candidate in used:
        suffix = f"-{n}"
        candidate = base[: max_len - len(suffix)].rstrip("-") + suffix
        n += 1
    return candidate


def fit_id(base: str, suffix: str, *, max_len: int = 64) -> str:
    """``base + suffix`` with ``base`` shortened so the result is at most ``max_len``
    characters (the migration's ``-imported`` and ``-reference`` rule)."""
    return base[: max(1, max_len - len(suffix))].rstrip("-_") + suffix


def copy_runbook_id(base_id: str, taken: Iterable[str]) -> str:
    """The id "Duplicate to customise" gives a copy: ``<id>-custom``, then
    ``<id>-custom-2``, ``-3``; never a reserved or taken id."""
    used = set(taken) | set(RUNBOOK_RESERVED_IDS)
    candidate, n = fit_id(base_id, "-custom"), 2
    while candidate in used:
        candidate = fit_id(base_id, f"-custom-{n}")
        n += 1
    return candidate


def is_reserved_id(runbook_id: Any) -> bool:
    return isinstance(runbook_id, str) and runbook_id in RUNBOOK_RESERVED_IDS


def valid_runbook_id(runbook_id: Any, origin: str = "operator") -> bool:
    """True when ``runbook_id`` fits its origin's grammar and is not reserved. The
    whole raw value must fit (``fullmatch``: a pattern's ``$`` also matches before a
    trailing line break, so ``"new\n"`` would otherwise pass and normalise to the
    reserved ``new``)."""
    if not isinstance(runbook_id, str) or is_reserved_id(runbook_id):
        return False
    pattern = _BUILTIN_ID_RE if origin == "builtin" else _OPERATOR_ID_RE
    return bool(pattern.fullmatch(runbook_id))


def applies_to(defn: RunbookDefinition, *, limit: int = 3) -> RunbookAppliesTo:
    """The library row's first rule and technique chips; ``more`` counts the rest.
    Only match criteria (``applies_when.rule_ids`` and ``applies_when.mitre``) are
    chips: the top-level ``mitre`` list is coverage (the techniques a runbook
    addresses, for coverage views) and never decides a match, so showing it under
    "Applies to" would promise matches that never happen."""
    rules = list(defn.applies_when.rule_ids)
    mitre = list(defn.applies_when.mitre)
    shown_rules = rules[:limit]
    shown_mitre = mitre[: max(0, limit - len(shown_rules))] if len(shown_rules) < limit else []
    more = (len(rules) - len(shown_rules)) + (len(mitre) - len(shown_mitre))
    return RunbookAppliesTo(rule_ids=shown_rules, mitre=shown_mitre, more=more)


# --------------------------------------------------------------------------- #
# Normalisation, canonical form and hash
# --------------------------------------------------------------------------- #
def _clean_line(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ("" if value is None else str(value).strip())


def _clean_optional(value: Any) -> str | None:
    text = _clean_line(value)
    return text or None


def _clean_list(values: Iterable[Any] | None, *, upper: bool = False) -> list[str]:
    out: list[str] = []
    for item in values or []:
        text = _clean_line(item)
        if text:
            out.append(text.upper() if upper else text)
    return out


def _clean_block(value: Any) -> str:
    """Multi-line text: newlines normalised, leading and trailing blank lines dropped,
    trailing whitespace of the whole removed. Inner lines are kept as written."""
    if not isinstance(value, str):
        return ""
    lines = value.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    return "\n".join(lines).rstrip()


def normalise_definition(defn: RunbookDefinition) -> RunbookDefinition:
    """``defn`` with surrounding whitespace removed from every one-line field, empty
    optional fields set to ``None``, empty list items dropped, technique ids upper
    case and instructions trimmed of leading and trailing blank lines. Order and
    meaning are unchanged, and applying it twice changes nothing.

    It is the canonical form: :func:`canonical_definition_json` (and so
    :func:`content_hash`), :func:`export_runbook_markdown` and
    :func:`render_runbook_prompt` use it, and the Markdown parser gives it back. A
    store persists ``normalise_definition(defn)`` of a definition
    :func:`validate_runbook` accepted, so what is stored is what an export and
    re-import would give.

    Every nested model is copied with ``model_copy(update=...)``, never rebuilt field
    by field, so a field this function does not clean (one added to the shared models
    later) is kept as it is in the stored form, the hash and the export."""
    aw = defn.applies_when
    steps: list[RunbookStep] = []
    for step in defn.steps:
        lookup = step.lookup
        if lookup is not None:
            lookup = lookup.model_copy(update={
                "filter": {_clean_line(k): _clean_line(v) for k, v in (lookup.filter or {}).items()},
                "group_by": _clean_list(lookup.group_by),
                "indicator": _clean_optional(lookup.indicator),
                "window": _clean_line(lookup.window) or RUNBOOK_DEFAULT_LOOKUP_WINDOW,
            })
        steps.append(step.model_copy(update={
            "id": _clean_line(step.id),
            "title": _clean_line(step.title),
            "instructions": _clean_block(step.instructions),
            "focus": _clean_optional(step.focus),
            "escalate_if": _clean_optional(step.escalate_if),
            "benign_if": _clean_optional(step.benign_if),
            "owner_role": _clean_optional(step.owner_role),
            "approval_role": _clean_optional(step.approval_role),
            "lookup": lookup,
            "options": [
                o.model_copy(update={
                    "id": _clean_line(o.id),
                    "label": _clean_line(o.label),
                    "marks_not_applicable": _clean_list(o.marks_not_applicable),
                })
                for o in step.options
            ],
            "react": _clean_optional(step.react),
            "d3fend": _clean_optional(step.d3fend),
        }))
    return defn.model_copy(update={
        "id": _clean_line(defn.id),
        "title": _clean_line(defn.title),
        "summary": _clean_line(defn.summary),
        "use_when": _clean_block(defn.use_when).strip(),
        "prerequisites": _clean_block(defn.prerequisites).strip(),
        "applies_when": aw.model_copy(update={
            "rule_ids": _clean_list(aw.rule_ids),
            "mitre": _clean_list(aw.mitre, upper=True),
            "entity_types": list(aw.entity_types),
            "sources": _clean_list(aw.sources),
            "verdicts": list(aw.verdicts),
            "statuses": _clean_list(aw.statuses),
            "any_tags": _clean_list(aw.any_tags),
        }),
        "mitre": _clean_list(defn.mitre, upper=True),
        "phases": list(defn.phases),
        "steps": steps,
        "retrieval_queries": _clean_list(defn.retrieval_queries),
        "owner": _clean_optional(defn.owner),
        "references": _clean_list(defn.references),
    })


def _definition_json(defn: RunbookDefinition) -> str:
    """``defn`` as JSON with sorted keys and no insignificant whitespace (defaults
    included), exactly as given."""
    return json.dumps(defn.model_dump(mode="json"), sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def canonical_definition_json(defn: RunbookDefinition) -> str:
    """The canonical text of a definition: the JSON of its normalised form
    (:func:`normalise_definition`) with sorted keys and no insignificant whitespace,
    defaults included. The same runbook entered with or without surrounding spaces,
    or exported and imported again, has one canonical text and so one
    :func:`content_hash`."""
    return _definition_json(normalise_definition(defn))


def _utf8(text: str) -> bytes:
    """``text`` as UTF-8. A lone surrogate (a JSON ``"\\ud800"`` escape decodes to
    one) is encoded rather than raising: validation refuses such text, but measuring
    or hashing a draft that holds it must never fail."""
    return text.encode("utf-8", "surrogatepass")


def _utf8_bytes(text: str) -> int:
    return len(_utf8(text))


def content_hash(defn: RunbookDefinition) -> str:
    """``RunbookVersionDoc.content_hash``: SHA-256 (hex) of the canonical definition."""
    return hashlib.sha256(_utf8(canonical_definition_json(defn))).hexdigest()


# --------------------------------------------------------------------------- #
# The investigator rendering (§4.10.9)
# --------------------------------------------------------------------------- #
def render_runbook_prompt(runbook: RunbookDefinition | RunbookVersionDoc, version: int | None = None) -> str:
    """The investigator's text for one Published version (a built-in or the live
    operator version; never a draft, an in-review version or AI text, #9).

    "<title> (v<n>)", the summary, ``use_when``, then for each Triage and Investigate
    step its kind, title, focus, escalate-if and benign-if lines, then one line per
    later phase listing its step titles. Instructions are for people and are never
    included, which is why the migration moves legacy guidance into ``focus``. The
    caller (``agents/prompts.py``) puts this inside the ``<<<RUNBOOK>>>`` block; it is
    never truncated (:data:`MAX_RUNBOOK_PROMPT_CHARS` is enforced at publish).

    It renders the normalised definition (:func:`normalise_definition`), whatever form
    it is given, so the text the investigator receives is exactly the text
    :func:`prompt_chars` measured at publish: spaces around a line, which count as
    nothing in the budget, never reach the prompt either. Normalising is idempotent,
    so a stored (already normalised) version or a built-in renders unchanged."""
    if isinstance(runbook, RunbookVersionDoc):
        defn = runbook.definition
        version = runbook.version if version is None else version
    else:
        defn = runbook
    defn = normalise_definition(defn)
    lines: list[str] = [f"{defn.title} (v{version})" if version else defn.title]
    if defn.summary:
        lines.append(defn.summary)
    if defn.use_when:
        lines.append(f"Use when: {defn.use_when}")
    phases = list(dict.fromkeys([*defn.phases, *(s.phase for s in defn.steps)]))
    for phase in phases:
        steps = [s for s in defn.steps if s.phase == phase]
        if not steps:
            continue
        label = PHASE_LABELS.get(phase, phase)
        if phase in PROMPT_DETAILED_PHASES:
            lines.append(f"{label}:")
            for step in steps:
                lines.append(f"- {KIND_LABELS.get(step.kind, step.kind)}: {step.title}")
                if step.focus:
                    lines.append(f"  Focus: {step.focus}")
                if step.escalate_if:
                    lines.append(f"  Escalate if: {step.escalate_if}")
                if step.benign_if:
                    lines.append(f"  Benign if: {step.benign_if}")
        else:
            lines.append(f"{label}: " + "; ".join(step.title for step in steps))
    return "\n".join(lines)


def prompt_chars(defn: RunbookDefinition, version: int | None = None) -> int:
    """The investigator rendering's length: the length of exactly the text
    :func:`render_runbook_prompt` gives the prompt (which renders the normalised
    definition, so spaces an author typed around a line never count). Without a
    version the widest version label a runbook can carry is assumed, so a draft
    measured here never grows past the budget when it is published as a later
    version."""
    return len(render_runbook_prompt(defn, version if version else MAX_RUNBOOK_VERSIONS))


# --------------------------------------------------------------------------- #
# Validation (§4.10.2)
# --------------------------------------------------------------------------- #
def _issue(path: str, code: str, message: str) -> RunbookIssue:
    return RunbookIssue(path=path, code=code, message=message)


def _shown(text: Any, limit: int = 60) -> str:
    flat = re.sub(r"\s+", " ", _UNSAFE_CHARS_RE.sub("", str(text or ""))).strip()
    return flat if len(flat) <= limit else flat[: limit - 3].rstrip() + "..."


def _step_name(index: int, step: RunbookStep) -> str:
    title = _shown(step.title)
    return f"Step '{title}'" if title else f"Step {index + 1}"


def _lower_first(text: str) -> str:
    return text[:1].lower() + text[1:]


def _text_issues(
    path: str,
    value: str | None,
    *,
    what: str,
    max_chars: int,
    required: bool = False,
    single_line: bool = True,
    plural: bool = False,
) -> list[RunbookIssue]:
    """Length, one-line, hidden-character, reserved-marker and template checks for one
    text field. ``what`` names it in the sentence ("The title", "The focus line of
    step 'X'"); ``plural`` for a plural name ("The instructions of step 'X'").

    A field over its limit reports only that: its content is not scanned until it
    fits, so the cost of a check never grows with how far a field overruns."""
    text = value or ""
    be, contain = ("are", "contain") if plural else ("is", "contains")
    out: list[RunbookIssue] = []
    if not text.strip():
        if required:
            out.append(_issue(path, ISSUE_REQUIRED, f"{what} {be} required."))
        return out
    if len(text) > max_chars:
        out.append(_issue(path, ISSUE_TOO_LONG,
                          f"{what} {be} {len(text):,} characters; the limit is {max_chars:,}."))
        return out
    if single_line and ("\n" in text or "\r" in text or "\t" in text):
        out.append(_issue(path, ISSUE_SINGLE_LINE, f"{what} must be one line."))
    if _UNSAFE_CHARS_RE.search(text) or "\r" in text:
        out.append(_issue(path, ISSUE_UNSAFE_TEXT,
                          f"{what} {contain} hidden or control characters. Remove them."))
    if _has_prompt_marker(text):
        out.append(_issue(path, ISSUE_UNSAFE_TEXT,
                          f"{what} {contain} '<<<' or '>>>', which Agentic SOC reserves. Remove them."))
    for name in template_names_in(text):
        if name not in RUNBOOK_TEMPLATE_VALUES:
            out.append(_issue(path, ISSUE_TEMPLATE_VALUE, unknown_template_message(what, name)))
    return out


# Restricted Markdown for step instructions: paragraphs, lists, bold, italics,
# inline code and https links. No headings, code blocks, HTML or images.
#
# Links are checked by their DESTINATIONS, never by matching link text. CommonMark
# lets link text nest brackets and span lines, and lets one line break sit before an
# inline destination or a reference definition's destination, so a pattern shaped
# like a link can be walked around. Instead every ``](`` (an inline link or image)
# and every ``[label]:`` that can start a reference definition is followed to its
# destination, which must be an absolute https link, and any ``![`` is an image. Every
# read is a bounded match anchored at a known position, so the check is linear.
_MD_HEADING_RE = re.compile(r"^\s{0,3}#{1,6}(?:\s|$)")
_MD_SETEXT_RE = re.compile(r"^\s{0,3}(?:=+|-+)\s*$")
_MD_FENCE_RE = re.compile(r"^\s{0,3}(?:```|~~~)")
_MD_HTML_RE = re.compile(r"<!--|</?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?/?>")
#: A line that opens an HTML block even without a closing '>': a tag name, '</', '<!'
#: or '<?' first on the line, after any blockquote or list markers.
_MD_HTML_BLOCK_START_RE = re.compile(r"^[ \t]*(?:(?:>|[-*+]|\d{1,9}[.)])[ \t]*)*<(?:/?[A-Za-z]|[!?])", re.M)
_MD_AUTOLINK_RE = re.compile(r"<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*)>")
_MD_EMAIL_AUTOLINK_RE = re.compile(
    r"<[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,20}>"
)
#: The blockquote and list markers (and indentation) a line may start with; a
#: heading, a code fence or a reference definition still counts after them.
_MD_CONTAINER_PREFIX_RE = re.compile(r"(?:[ \t>]|[-*+](?=[ \t])|\d{1,9}[.)](?=[ \t]))*")
#: A reference definition's label (at most 999 characters, which may span lines; no
#: unescaped bracket inside) and its colon.
_MD_DEFINITION_LABEL_RE = re.compile(r"\[(?:[^\[\]\\]|\\.){1,999}\]:", re.S)
#: How far a destination is read: one character past the longest link ``https_url``
#: accepts, so an over-long destination always fails.
_MD_DEST_READ = RUNBOOK_EVIDENCE_MAX_URL_CHARS + 1
#: Spaces and tabs, with at most one line break, between '](' or ']:' and a destination.
_MD_DEST_GAP_RE = re.compile(r"[ \t]*(?:\n[ \t]*)?")
_MD_DEST_ANGLE_RE = re.compile(r"<[^<>\n]{0,%d}>?" % _MD_DEST_READ)
_MD_DEST_INLINE_RE = re.compile(r"[^\s)]{0,%d}" % _MD_DEST_READ)
_MD_DEST_DEFINITION_RE = re.compile(r"\S{0,%d}" % _MD_DEST_READ)
#: :func:`markdown_problems` refuses longer text without scanning it (instructions are
#: at most 2,000 characters, and :func:`validate_runbook` scans only text within its
#: limit).
MARKDOWN_CHECK_MAX_CHARS = 65_536


def _md_destination(text: str, start: int, *, inline: bool) -> str | None:
    """The link destination after the ``](`` or ``]:`` that ends at ``start``: the
    text of a ``<...>`` destination, or of a plain one up to whitespace (and, inline,
    up to ')'). ``""`` for an empty destination; ``None`` when there is none at all
    (the end of the text or a blank line), which makes it no link. An unclosed or
    over-long destination is returned as read, so it never passes as https."""
    pos = _MD_DEST_GAP_RE.match(text, start).end()
    if pos >= len(text) or text[pos] == "\n":
        return None
    if text[pos] == "<":
        raw = _MD_DEST_ANGLE_RE.match(text, pos).group(0)
        return raw[1:-1] if len(raw) > 1 and raw.endswith(">") else raw
    if inline and text[pos] == ")":
        return ""
    return (_MD_DEST_INLINE_RE if inline else _MD_DEST_DEFINITION_RE).match(text, pos).group(0)


def _md_destinations(text: str, line_starts: list[tuple[int, int]]) -> list[str]:
    """Every link destination in ``text``: after each ``](`` and after the label of
    each line that can start a reference definition (``line_starts`` holds each
    line's start and where its container markers end)."""
    out: list[str] = []
    index = text.find("](")
    while index >= 0:
        dest = _md_destination(text, index + 2, inline=True)
        if dest is not None:
            out.append(dest)
        index = text.find("](", index + 2)
    for _start, content in line_starts:
        if text.startswith("[", content):
            label = _MD_DEFINITION_LABEL_RE.match(text, content)
            if label is not None:
                dest = _md_destination(text, label.end(), inline=False)
                if dest is not None:
                    out.append(dest)
    return out


def markdown_problems(text: str) -> list[str]:
    """Why ``text`` is not restricted Markdown, as predicates that complete "The
    instructions ..." (empty when it is). Headings, setext underlines, code fences,
    HTML, images and links that are not absolute https links are refused, also inside
    blockquotes and list items. Linear in the text; text over
    :data:`MARKDOWN_CHECK_MAX_CHARS` is refused without being scanned."""
    if len(text) > MARKDOWN_CHECK_MAX_CHARS:
        return ["are too long to check; shorten them"]
    problems: list[str] = []
    seen: set[str] = set()

    def add(reason: str) -> None:
        if reason not in seen:
            seen.add(reason)
            problems.append(reason)

    lines = text.split("\n")
    line_starts: list[tuple[int, int]] = []
    offset = 0
    for index, line in enumerate(lines):
        content = _MD_CONTAINER_PREFIX_RE.match(line).end()
        line_starts.append((offset, offset + content))
        offset += len(line) + 1
        body = line[content:]
        if _MD_HEADING_RE.match(line) or _MD_HEADING_RE.match(body):
            add("contain a heading; headings are not allowed inside a step, so start a new step instead")
        elif _MD_SETEXT_RE.match(line) and index > 0 and lines[index - 1].strip() \
                and not _MD_FENCE_RE.match(lines[index - 1]):
            add("contain a line of '=' or '-' under text, which makes a heading; remove it")
        if _MD_FENCE_RE.match(line) or _MD_FENCE_RE.match(body):
            add("contain a code block; use inline code instead")
    if "![" in text:
        add("contain an image; images are not allowed")
    for m in _MD_AUTOLINK_RE.finditer(text):
        if https_url(m.group(1)) is None:
            add("contain a link that is not an https link")
    without_autolinks = _MD_EMAIL_AUTOLINK_RE.sub("", _MD_AUTOLINK_RE.sub("", text))
    if _MD_HTML_RE.search(without_autolinks) or _MD_HTML_BLOCK_START_RE.search(without_autolinks):
        add("contain HTML; use plain Markdown")
    for dest in _md_destinations(text, line_starts):
        if https_url(dest) is None:
            add("contain a link that is not an https link")
            break
    return problems


def _list_issues(
    path: str,
    values: list[str],
    *,
    owner: str,
    noun: str,
    plural: str,
    max_items: int,
    max_chars: int,
    check: Any = None,
    expected: str = "",
) -> list[RunbookIssue]:
    """Size, length, safety, template, grammar and duplicate checks for one list field.
    The sentences read "<owner> lists the <noun> 'x', which is not <expected>.". A
    ``{{value}}`` in a list is refused: lists are used as written, never filled in.

    The work is bounded by what can be reported: a list over its item limit (reported
    as ``too_many``) is read at most :data:`RUNBOOK_MAX_ISSUES` values past the limit,
    and the scan ends once more issues than :func:`validate_runbook` returns are found
    (those it would cut anyway, so the reported list is unchanged)."""
    out: list[RunbookIssue] = []
    if len(values) > max_items:
        out.append(_issue(path, ISSUE_TOO_MANY,
                          f"{owner} lists {len(values):,} {plural}; the limit is {max_items:,}."))
    seen: set[str] = set()
    for i, value in enumerate(values[: max_items + RUNBOOK_MAX_ISSUES]):
        if len(out) > RUNBOOK_MAX_ISSUES:
            break
        ipath = f"{path}[{i}]"
        if not isinstance(value, str) or not value.strip():
            out.append(_issue(ipath, ISSUE_REQUIRED, f"{owner} lists an empty {noun}. Remove it."))
            continue
        if len(value) > max_chars:
            out.append(_issue(ipath, ISSUE_TOO_LONG,
                              f"{owner} lists a {noun} of {len(value):,} characters; the limit is {max_chars:,}."))
        elif "\n" in value or "\r" in value or "\t" in value or _UNSAFE_CHARS_RE.search(value):
            out.append(_issue(ipath, ISSUE_UNSAFE_TEXT,
                              f"{owner} lists a {noun} with a line break or hidden characters."))
        elif _has_prompt_marker(value):
            out.append(_issue(ipath, ISSUE_UNSAFE_TEXT,
                              f"{owner} lists a {noun} containing '<<<' or '>>>', which Agentic SOC reserves."))
        elif (names := template_names_in(value)):
            # Nothing fills case values into these lists (matching compares rule ids
            # and tags as written; retrieval and references use the text as is), so
            # even a known value would be searched or matched literally.
            out.append(_issue(ipath, ISSUE_TEMPLATE_VALUE,
                              f"{owner} uses {{{{{_shown(names[0], 40)}}}}} in a {noun}. "
                              f"{plural[:1].upper() + plural[1:]} are used as written, so a case value "
                              f"is never filled in. Write the value itself."))
        elif check is not None and not check(value):
            out.append(_issue(ipath, ISSUE_INVALID,
                              f"{owner} lists the {noun} '{_shown(value, 40)}', which is not {expected}."))
        key = value.strip().lower()
        if key in seen:
            out.append(_issue(ipath, ISSUE_DUPLICATE, f"{owner} lists the {noun} '{_shown(value, 40)}' twice."))
        seen.add(key)
    return out


def _is_technique(value: str) -> bool:
    return bool(_TECHNIQUE_RE.fullmatch(value.strip().upper()))


def _is_source(value: str) -> bool:
    text = value.strip()
    if text.startswith("type:"):
        return text[5:] in _SOURCE_TYPES
    return bool(_SOURCE_ID_RE.fullmatch(text))


def _role_issues(path: str, value: str | None, *, what: str) -> list[RunbookIssue]:
    if value is None:
        return []
    if not value.strip():
        return [_issue(path, ISSUE_REQUIRED, f"{what} is empty. Name a role or remove it.")]
    out = _text_issues(path, value, what=what, max_chars=RUNBOOK_ROLE_MAX_CHARS)
    if any(ch in value for ch in "{}"):
        out.append(_issue(path, ISSUE_INVALID, f"{what} cannot contain braces."))
    return out


def _applies_when_issues(aw: AppliesWhen) -> list[RunbookIssue]:
    out: list[RunbookIssue] = []
    p = "applies_when"
    owner = "Applies when"
    out += _list_issues(f"{p}.rule_ids", aw.rule_ids, owner=owner, noun="rule", plural="rules",
                        max_items=RUNBOOK_APPLIES_MAX_RULES, max_chars=RUNBOOK_APPLIES_MAX_RULE_CHARS)
    out += _list_issues(f"{p}.mitre", aw.mitre, owner=owner, noun="technique", plural="techniques",
                        max_items=RUNBOOK_APPLIES_MAX_MITRE, max_chars=9, check=_is_technique,
                        expected="an ATT&CK technique id such as T1110 or T1110.003")
    if len(set(aw.entity_types)) != len(aw.entity_types):
        out.append(_issue(f"{p}.entity_types", ISSUE_DUPLICATE, "Applies when lists an entity type twice."))
    if aw.entity_types and not set(aw.entity_types) & CASE_CARRIED_ENTITY_KINDS:
        # A case carries one entity of a kind in CASE_CARRIED_ENTITY_KINDS; a criterion
        # naming only other kinds could never match, which nothing would tell the author.
        missing = list(dict.fromkeys(aw.entity_types))
        named = missing[0] if len(missing) == 1 else ", ".join(missing[:-1]) + " and " + missing[-1]
        out.append(_issue(f"{p}.entity_types", ISSUE_NOT_ALLOWED,
                          f"Applies when lists only entity types that no case carries yet ({named}). "
                          "Add ip, user or host, or remove the entity types."))
    out += _list_issues(f"{p}.sources", aw.sources, owner=owner, noun="source", plural="sources",
                        max_items=RUNBOOK_APPLIES_MAX_SOURCES, max_chars=134, check=_is_source,
                        expected="a source id or type:<source type>")
    if len(set(aw.verdicts)) != len(aw.verdicts):
        out.append(_issue(f"{p}.verdicts", ISSUE_DUPLICATE, "Applies when lists a verdict twice."))
    out += _list_issues(f"{p}.statuses", aw.statuses, owner=owner, noun="status", plural="statuses",
                        max_items=RUNBOOK_APPLIES_MAX_STATUSES, max_chars=32,
                        check=lambda v: v in _CASE_STATUSES,
                        expected="a case status (" + ", ".join(_CASE_STATUSES) + ")")
    out += _list_issues(f"{p}.any_tags", aw.any_tags, owner=owner, noun="tag", plural="tags",
                        max_items=RUNBOOK_APPLIES_MAX_TAGS, max_chars=RUNBOOK_APPLIES_MAX_TAG_CHARS)
    if aw.always:
        others = [label for name, label in _CRITERION_LABELS if name != "always" and _has_criterion(aw, name)]
        if others:
            listed = others[0] if len(others) == 1 else ", ".join(others[:-1]) + " and " + others[-1]
            out.append(_issue(f"{p}.always", ISSUE_NOT_ALLOWED,
                              "A fallback runbook (always) applies to every case, so it cannot have "
                              f"other criteria. Remove {listed}, or turn off always."))
    return out


#: ``CASE_CARRIED_ENTITY_KINDS`` (from ``runbook_lookup``, the one definition): the
#: entity kinds a case carries as its entity. A case's primary entity comes only from
#: the correlation ladders (IP, host, user, or a rule for a rule-keyed case, which has
#: no entity kind). File hashes and domains are cross-source link keys, never a case's
#: entity. An ``applies_when.entity_types`` list must name at least one of these to
#: ever match, and a related-cases or campaign lookup can only find cases by one.


#: Plain names of the Applies when criteria, in the order the editor lists them.
_CRITERION_LABELS: tuple[tuple[str, str], ...] = (
    ("rule_ids", "rules"), ("mitre", "techniques"), ("entity_types", "entity types"),
    ("severity_at_least", "minimum severity"), ("sources", "sources"), ("verdicts", "verdicts"),
    ("statuses", "statuses"), ("any_tags", "tags"), ("min_event_count", "minimum events"),
    ("always", "fallback"),
)


def _has_criterion(aw: AppliesWhen, name: str) -> bool:
    value = getattr(aw, name)
    if name in ("severity_at_least", "min_event_count"):
        return value is not None
    return bool(value)


def validate_runbook(
    defn: RunbookDefinition,
    *,
    origin: RunbookOriginKind = "operator",
    source: str | None = None,
    version: int | None = None,
    check_prompt_budget: bool = True,
) -> list[RunbookIssue]:
    """Every content problem with ``defn``, as plain-sentence issues (empty when the
    runbook can be published). The rules of SPEC §4.10.2:

    * the id grammar of its origin (built-ins kebab-case, operator runbooks the
      legacy grammar), never a reserved id (code ``reserved``) and, for an operator
      or imported runbook, never a built-in id (code ``builtin_id``);
    * titles, summaries, guidance lines, list sizes and lengths within their limits,
      one line where the Markdown form needs one, no hidden characters and no
      ``<<<`` / ``>>>`` (the prompt markers);
    * phases: 1 to 6, in the fixed order, each used by a step; steps: 1 to 40 with
      unique stable ids, in phase order;
    * per kind: a Lookup has a valid lookup template (``runbook_lookup``) and nothing
      else has one; a Decision has 2 to 6 options that skip only later steps; the
      escalate / benign pair only on Checks and Decisions; an approval role only on
      Actions and Records;
    * every ``{{value}}`` from the closed set; instructions in restricted Markdown;
      references https only;
    * the investigator rendering within :data:`MAX_RUNBOOK_PROMPT_CHARS` and the
      Markdown source within 64 KiB (``source`` when given, else the export at
      ``version``, or at the widest version label when no version is given).

    The checks read ``defn`` as given; a store persists
    :func:`normalise_definition` of an accepted definition, which is what
    :func:`content_hash` and :func:`export_runbook_markdown` use.

    The work is bounded: a definition larger than
    :data:`RUNBOOK_MAX_DEFINITION_CHARS` gets one size issue before any field is
    read, a field over its own limit is not scanned further, a list over its item
    limit is read at most :data:`RUNBOOK_MAX_ISSUES` values past it, and at most
    :data:`RUNBOOK_MAX_ISSUES` issues are returned. The checks stop as soon as more
    issues than that are found: issues are listed in a fixed order, so the ones a
    later check would add are the ones the cap cuts, and the result is the same.
    """
    data_chars = len(_definition_json(defn))
    if data_chars > RUNBOOK_MAX_DEFINITION_CHARS:
        return [_issue("source", ISSUE_SOURCE_SIZE,
                       f"The runbook is too large to check: {data_chars:,} characters; the limit is "
                       f"{RUNBOOK_MAX_DEFINITION_CHARS:,}. Remove steps or shorten the text.")]
    issues: list[RunbookIssue] = []
    # Identity ----------------------------------------------------------------
    rid = defn.id or ""
    if not rid.strip():
        issues.append(_issue("id", ISSUE_REQUIRED, "The id is required."))
    elif is_reserved_id(rid):
        issues.append(_issue("id", ISSUE_RESERVED,
                             f"The id '{_shown(rid)}' is reserved by Agentic SOC. Choose another id."))
    elif origin != "builtin" and rid in BUILTIN_RUNBOOK_IDS:
        # A built-in always wins an id collision in the catalog, so an operator or
        # imported runbook with its id would never match; refuse it here instead. The
        # import renames such a runbook (``copy_runbook_id``, ``replaces`` the
        # built-in) before it lands as a Draft, so the code is its own.
        issues.append(_issue("id", ISSUE_BUILTIN_ID,
                             f"The id '{rid}' belongs to a built-in runbook. Choose another id, or "
                             "duplicate the built-in to customise it."))
    elif not valid_runbook_id(rid, origin):
        grammar = ("2 to 63 lower-case letters, digits and hyphens, starting with a letter or digit"
                   if origin == "builtin" else
                   "up to 64 lower-case letters, digits, hyphens and underscores, starting with a "
                   "letter or digit")
        issues.append(_issue("id", ISSUE_INVALID, f"The id '{_shown(rid)}' must be {grammar}."))
    issues += _text_issues("title", defn.title, what="The title", max_chars=RUNBOOK_MAX_TITLE_CHARS,
                           required=True)
    issues += _text_issues("summary", defn.summary, what="The summary",
                           max_chars=RUNBOOK_MAX_SUMMARY_CHARS, required=True)
    # Use when and prerequisites may run over several lines (the front matter writes
    # them JSON-quoted); the title and summary are one line (the library row).
    issues += _text_issues("use_when", defn.use_when, what="Use when",
                           max_chars=RUNBOOK_MAX_USE_WHEN_CHARS, single_line=False)
    issues += _text_issues("prerequisites", defn.prerequisites, what="Prerequisites",
                           max_chars=RUNBOOK_MAX_PREREQUISITES_CHARS, single_line=False)
    issues += _text_issues("owner", defn.owner, what="The owner", max_chars=RUNBOOK_OWNER_MAX_CHARS)
    issues += _applies_when_issues(defn.applies_when)
    issues += _list_issues("mitre", defn.mitre, owner="The runbook", noun="technique", plural="techniques",
                           max_items=RUNBOOK_MITRE_MAX, max_chars=9, check=_is_technique,
                           expected="an ATT&CK technique id such as T1110 or T1110.003")
    issues += _list_issues("retrieval_queries", defn.retrieval_queries, owner="The runbook",
                           noun="retrieval query", plural="retrieval queries",
                           max_items=RUNBOOK_MAX_RETRIEVAL_QUERIES,
                           max_chars=RUNBOOK_MAX_RETRIEVAL_QUERY_CHARS)
    issues += _list_issues("references", defn.references, owner="The runbook", noun="reference",
                           plural="references", max_items=RUNBOOK_MAX_REFERENCES, max_chars=500,
                           check=lambda v: https_url(v) is not None,
                           expected="an https link")
    if len(issues) > RUNBOOK_MAX_ISSUES:
        return _capped(issues)

    # Phases --------------------------------------------------------------------
    phases = list(defn.phases)
    if not phases:
        issues.append(_issue("phases", ISSUE_REQUIRED, "Add at least one phase."))
    elif len(phases) > RUNBOOK_MAX_PHASES:
        issues.append(_issue("phases", ISSUE_TOO_MANY,
                             f"The runbook lists {len(phases)} phases; the limit is {RUNBOOK_MAX_PHASES}."))
    # Each phase's position in the runbook (its first listing), so the step loop below
    # looks phases up in constant time however long the list is.
    phase_rank: dict[str, int] = {}
    for p in phases:
        phase_rank.setdefault(p, len(phase_rank))
    if len(phase_rank) != len(phases):
        issues.append(_issue("phases", ISSUE_DUPLICATE, "A phase is listed twice."))
    order = [PHASE_IDS.index(p) for p in phases]
    if order != sorted(order):
        issues.append(_issue("phases", ISSUE_ORDER,
                             "Phases must follow the order " + ", ".join(PHASE_LABELS[p] for p in PHASE_IDS) + "."))
    used = {s.phase for s in defn.steps}
    for p in phase_rank:
        if p not in used:
            issues.append(_issue("phases", ISSUE_UNUSED,
                                 f"The phase {PHASE_LABELS[p]} has no steps. Add a step or remove the phase."))

    # Steps ---------------------------------------------------------------------
    steps = list(defn.steps)
    if not steps:
        issues.append(_issue("steps", ISSUE_REQUIRED, "Add at least one step."))
    elif len(steps) > RUNBOOK_MAX_STEPS:
        issues.append(_issue("steps", ISSUE_TOO_MANY,
                             f"The runbook has {len(steps)} steps; the limit is {RUNBOOK_MAX_STEPS}."))
    ids = [s.id for s in steps]
    position = {sid: i for i, sid in enumerate(ids)}
    seen_ids: set[str] = set()
    last_rank = -1
    for i, step in enumerate(steps):
        if len(issues) > RUNBOOK_MAX_ISSUES:
            return _capped(issues)
        sp = f"steps[{i}]"
        name = _step_name(i, step)
        if not (step.id or "").strip():
            issues.append(_issue(f"{sp}.id", ISSUE_REQUIRED, f"{name} needs an id."))
        elif not _SLUG_RE.fullmatch(step.id):
            issues.append(_issue(f"{sp}.id", ISSUE_INVALID,
                                 f"{name} has the id '{_shown(step.id, 40)}'; a step id is up to 64 "
                                 f"lower-case letters, digits, hyphens and underscores."))
        elif step.id in seen_ids:
            issues.append(_issue(f"{sp}.id", ISSUE_DUPLICATE,
                                 f"{name} reuses the id '{step.id}'. Every step needs its own id."))
        seen_ids.add(step.id)
        if step.phase not in phase_rank:
            issues.append(_issue(f"{sp}.phase", ISSUE_REFERENCE,
                                 f"{name} is in the phase {PHASE_LABELS.get(step.phase, step.phase)}, "
                                 f"which the runbook does not list."))
        else:
            rank = phase_rank[step.phase]
            if rank < last_rank:
                issues.append(_issue(f"{sp}.phase", ISSUE_ORDER,
                                     f"{name} is in {PHASE_LABELS[step.phase]} after a step of a later "
                                     f"phase. Keep each phase's steps together, in phase order."))
            last_rank = max(last_rank, rank)
        lname = _lower_first(name)
        issues += _text_issues(f"{sp}.title", step.title, what=f"The title of {lname}",
                               max_chars=RUNBOOK_STEP_MAX_TITLE_CHARS, required=True)
        issues += _text_issues(f"{sp}.instructions", step.instructions, what=f"The instructions of {lname}",
                               max_chars=RUNBOOK_STEP_MAX_INSTRUCTIONS_CHARS, single_line=False, plural=True)
        if len(step.instructions or "") <= RUNBOOK_STEP_MAX_INSTRUCTIONS_CHARS:
            for reason in markdown_problems(step.instructions or ""):
                issues.append(_issue(f"{sp}.instructions", ISSUE_MARKDOWN,
                                     f"The instructions of {lname} {reason}."))
            leading = _leading_key_line(step.instructions or "")
            if leading is not None:
                # The Markdown form reads a key line placed right under a heading as
                # the step's own field, so this text would not survive an export.
                issues.append(_issue(f"{sp}.instructions", ISSUE_MARKDOWN,
                                     f"The instructions of {lname} start with '{leading}:', which the "
                                     f"Markdown form reads as the step's own '{leading}:' line. Put it in "
                                     f"that field, or start the instructions with other text."))
        for fname, label in (("focus", "The focus line"), ("escalate_if", "The 'Escalate if' line"),
                             ("benign_if", "The 'Benign if' line")):
            value = getattr(step, fname)
            issues += _text_issues(f"{sp}.{fname}", value, what=f"{label} of {lname}",
                                   max_chars=RUNBOOK_STEP_MAX_GUIDANCE_CHARS)
        if step.kind not in GUIDANCE_PAIR_KINDS:
            for fname, label in (("escalate_if", "Escalate if"), ("benign_if", "Benign if")):
                if getattr(step, fname):
                    issues.append(_issue(f"{sp}.{fname}", ISSUE_NOT_ALLOWED,
                                         f"{name} is a {KIND_LABELS[step.kind]} step; only Check and "
                                         f"Decision steps have '{label}'. Move it to the focus line."))
        issues += _role_issues(f"{sp}.owner_role", step.owner_role, what=f"The owner role of {lname}")
        issues += _role_issues(f"{sp}.approval_role", step.approval_role,
                               what=f"The approval role of {lname}")
        if step.approval_role and step.kind not in APPROVAL_KINDS:
            issues.append(_issue(f"{sp}.approval_role", ISSUE_NOT_ALLOWED,
                                 f"{name} asks for approval; only Action and Record steps can."))
        if step.react is not None and not _REACT_RE.fullmatch(step.react):
            issues.append(_issue(f"{sp}.react", ISSUE_INVALID,
                                 f"{name} has the RE&CT id '{_shown(step.react, 20)}'; use a form such as RA3101."))
        if step.d3fend is not None and not _D3FEND_RE.fullmatch(step.d3fend):
            issues.append(_issue(f"{sp}.d3fend", ISSUE_INVALID,
                                 f"{name} has the D3FEND id '{_shown(step.d3fend, 20)}'; use a form such as D3-NI."))
        # Lookup ------------------------------------------------------------------
        if step.kind == "lookup":
            if step.lookup is None:
                issues.append(_issue(f"{sp}.lookup", ISSUE_REQUIRED,
                                     f"{name} is a Lookup step and needs a lookup."))
            else:
                issues += validate_lookup(step.lookup, path=f"{sp}.lookup", owner=name)
        elif step.lookup is not None:
            issues.append(_issue(f"{sp}.lookup", ISSUE_NOT_ALLOWED,
                                 f"{name} is a {KIND_LABELS[step.kind]} step; only Lookup steps run a lookup."))
        # Decision ----------------------------------------------------------------
        if step.kind == "decision":
            options = list(step.options)
            if len(options) < RUNBOOK_DECISION_MIN_OPTIONS:
                issues.append(_issue(f"{sp}.options", ISSUE_TOO_FEW,
                                     f"{name} needs at least {RUNBOOK_DECISION_MIN_OPTIONS} options."))
            elif len(options) > RUNBOOK_DECISION_MAX_OPTIONS:
                issues.append(_issue(f"{sp}.options", ISSUE_TOO_MANY,
                                     f"{name} has {len(options)} options; the limit is "
                                     f"{RUNBOOK_DECISION_MAX_OPTIONS}."))
            option_ids: set[str] = set()
            for j, option in enumerate(options):
                if len(issues) > RUNBOOK_MAX_ISSUES:
                    return _capped(issues)
                op = f"{sp}.options[{j}]"
                if not (option.id or "").strip():
                    issues.append(_issue(f"{op}.id", ISSUE_REQUIRED, f"{name} has an option with no id."))
                elif not _SLUG_RE.fullmatch(option.id):
                    issues.append(_issue(f"{op}.id", ISSUE_INVALID,
                                         f"{name} has the option id '{_shown(option.id, 40)}'; use lower-case "
                                         f"letters, digits, hyphens and underscores."))
                elif option.id in option_ids:
                    issues.append(_issue(f"{op}.id", ISSUE_DUPLICATE,
                                         f"{name} has two options with the id '{option.id}'."))
                option_ids.add(option.id)
                issues += _text_issues(f"{op}.label", option.label, what=f"An option label of {lname}",
                                       max_chars=RUNBOOK_DECISION_MAX_LABEL_CHARS, required=True)
                if "|" in (option.label or ""):
                    issues.append(_issue(f"{op}.label", ISSUE_INVALID,
                                         f"{name} has an option label with '|', which the Markdown form "
                                         f"uses. Remove it."))
                # Only an entry naming a step not named before passes without an
                # issue, so this loop runs at most (steps + the cap) times.
                skipped: set[str] = set()
                for k, target in enumerate(option.marks_not_applicable):
                    if len(issues) > RUNBOOK_MAX_ISSUES:
                        return _capped(issues)
                    tp = f"{op}.marks_not_applicable[{k}]"
                    if target in skipped:
                        issues.append(_issue(tp, ISSUE_DUPLICATE,
                                             f"{name} option '{_shown(option.label, 30)}' skips '{target}' twice."))
                    skipped.add(target)
                    if target not in position:
                        issues.append(_issue(tp, ISSUE_REFERENCE,
                                             f"{name} option '{_shown(option.label, 30)}' skips "
                                             f"'{_shown(target, 40)}', which is not a step of this runbook."))
                    elif position[target] <= i:
                        issues.append(_issue(tp, ISSUE_REFERENCE,
                                             f"{name} option '{_shown(option.label, 30)}' skips "
                                             f"'{target}', which is not a later step. An option can only "
                                             f"skip steps after the decision."))
        elif step.options:
            issues.append(_issue(f"{sp}.options", ISSUE_NOT_ALLOWED,
                                 f"{name} is a {KIND_LABELS[step.kind]} step; only Decision steps have options."))

    # Budgets -------------------------------------------------------------------
    if len(issues) > RUNBOOK_MAX_ISSUES:
        return _capped(issues)
    if check_prompt_budget:
        length = prompt_chars(defn, version)
        if length > MAX_RUNBOOK_PROMPT_CHARS:
            issues.append(_issue("prompt", ISSUE_PROMPT_BUDGET,
                                 f"The investigator guidance is {length:,} characters; the limit is "
                                 f"{MAX_RUNBOOK_PROMPT_CHARS:,}. Shorten focus, escalate and benign lines "
                                 f"or Triage and Investigate step titles."))
    if source is not None:
        size = _utf8_bytes(source)
    else:
        # Export writes a "version: N" line. Without a version the widest label a
        # runbook can carry is assumed (as prompt_chars does), so a definition
        # accepted here exports at any version within the limit and imports again.
        size = _utf8_bytes(export_runbook_markdown(defn, version=version if version else MAX_RUNBOOK_VERSIONS))
    if size > RUNBOOK_MAX_SOURCE_BYTES:
        issues.append(_issue("source", ISSUE_SOURCE_SIZE,
                             f"The Markdown source is {size:,} bytes; the limit is {RUNBOOK_MAX_SOURCE_BYTES:,}."))
    return _capped(issues)


def blocking_error_code(issues: Iterable[RunbookIssue]) -> str | None:
    """The error a write answers for ``issues``: ``runbook_id_reserved`` when the id is
    reserved or belongs to a built-in (``reserved``, ``builtin_id``),
    ``runbook_prompt_budget`` when the budget is the only problem, ``runbook_invalid``
    otherwise, and ``None`` when there is nothing to refuse.

    An import resolves a ``builtin_id`` issue before asking: it gives the runbook a
    new id with :func:`copy_runbook_id` (recording that it ``replaces`` the built-in)
    and validates again, so an exported built-in lands as a Draft (SPEC §4.10.13)."""
    items = list(issues)
    if not items:
        return None
    codes = {i.code for i in items}
    if ISSUE_RESERVED in codes or ISSUE_BUILTIN_ID in codes:
        return "runbook_id_reserved"
    if codes == {ISSUE_PROMPT_BUDGET}:
        return "runbook_prompt_budget"
    return "runbook_invalid"


# --------------------------------------------------------------------------- #
# Front matter: a strict, dependency-free YAML subset
# --------------------------------------------------------------------------- #
_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_.-]*$")
_PLAIN_UNSAFE_START = tuple("[]{}\"'&*!|>%@`#,?:-")
_YAML_SPECIAL_WORDS = frozenset({"true", "false", "yes", "no", "on", "off", "null", "~", ""})
_NUMBER_LIKE_RE = re.compile(r"^[-+]?(?:\d[\d_]*)(?:\.\d*)?(?:[eE][-+]?\d+)?$")


class _YamlError(ValueError):
    """One problem in the front matter or a lookup block (line, message)."""

    def __init__(self, line: int, message: str) -> None:
        super().__init__(message)
        self.line = line
        self.message = message


def _scalar(raw: str, line: int) -> str:
    """One scalar: a JSON double-quoted string, a single-quoted string (``''`` is a
    quote) or plain text (trimmed)."""
    text = raw.strip()
    if text.startswith('"'):
        try:
            value = json.loads(text)
        except ValueError:
            raise _YamlError(line, "A quoted value is not closed or has an unknown escape.") from None
        if not isinstance(value, str):
            raise _YamlError(line, "A quoted value is not text.")
        return value
    if text.startswith("'"):
        if len(text) < 2 or not text.endswith("'"):
            raise _YamlError(line, "A quoted value is not closed.")
        inner = text[1:-1]
        if "'" in inner.replace("''", ""):
            raise _YamlError(line, "A single-quoted value has an unescaped quote; write '' for a quote.")
        return inner.replace("''", "'")
    if text.startswith("{") and not text.startswith("{{"):
        raise _YamlError(line, "Inline mappings are not supported; write one key per line.")
    return text


def _split_flow(inner: str, line: int) -> list[str]:
    """The items of a flow list's inner text (between ``[`` and ``]``). Linear: a
    quote opens a quoted item only before the item has any other text, which a flag
    tracks (re-joining the buffer at each quote made a run of quotes quadratic)."""
    items: list[str] = []
    buf: list[str] = []
    has_text = False
    quote: str | None = None
    i = 0
    while i < len(inner):
        ch = inner[i]
        if quote:
            buf.append(ch)
            if quote == '"' and ch == "\\" and i + 1 < len(inner):
                buf.append(inner[i + 1])
                i += 2
                continue
            if ch == quote:
                if quote == "'" and i + 1 < len(inner) and inner[i + 1] == "'":
                    buf.append("'")
                    i += 2
                    continue
                quote = None
        elif ch in "\"'" and not has_text:
            quote = ch
            has_text = True
            buf.append(ch)
        elif ch == ",":
            items.append("".join(buf))
            buf = []
            has_text = False
        elif ch in "[]":
            raise _YamlError(line, "Lists inside lists are not supported.")
        else:
            buf.append(ch)
            if not ch.isspace():
                has_text = True
        i += 1
    if quote:
        raise _YamlError(line, "A quoted list item is not closed.")
    items.append("".join(buf))
    if len(items) == 1 and not items[0].strip():
        return []
    out = []
    for item in items:
        if not item.strip():
            raise _YamlError(line, "A list has an empty item.")
        out.append(_scalar(item, line))
    return out


def _value(raw: str, line: int) -> str | list[str]:
    text = raw.strip()
    if text.startswith("["):
        if not text.endswith("]"):
            raise _YamlError(line, "A list that opens with '[' must close with ']' on the same line.")
        return _split_flow(text[1:-1], line)
    return _scalar(text, line)


def _key(raw: str, line: int) -> str:
    text = raw.strip()
    if text.startswith('"') or text.startswith("'"):
        return _scalar(text, line)
    return text


def _split_key(text: str) -> tuple[str, str, str]:
    """``(key, sep, rest)`` at the first ``:`` outside a quoted key."""
    stripped = text.lstrip()
    if stripped[:1] in "\"'":
        quote = stripped[0]
        end = stripped.find(quote, 1)
        while quote == '"' and end > 0 and stripped[end - 1] == "\\":
            end = stripped.find(quote, end + 1)
        if end > 0:
            head, sep, rest = stripped[end + 1:].partition(":")
            if not head.strip():
                return stripped[: end + 1], sep, rest
    return text.partition(":")


def _indent(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def _parse_block(lines: list[str], start: int, *, nested: bool) -> dict[str, Any]:
    """Parse ``lines`` (already dedented) as a mapping. ``start`` is the 1-based line
    number of ``lines[0]`` for messages. One level of nested mapping is allowed at the
    top; a nested value may itself be a scalar, a flow list or a block list."""
    data: dict[str, Any] = {}
    i, n = 0, len(lines)
    while i < n:
        line = lines[i]
        number = start + i
        if not line.strip() or line.lstrip().startswith("#"):
            i += 1
            continue
        if "\t" in line[: len(line) - len(line.lstrip())]:
            raise _YamlError(number, "Indent with spaces, not tabs.")
        if _indent(line) > 0:
            raise _YamlError(number, "This line is indented but has no key above it.")
        raw_key, sep, rest = _split_key(line)
        key = _key(raw_key, number)
        if not sep or not key:
            raise _YamlError(number, "Each line must be 'key: value'.")
        if not nested and not _KEY_RE.match(key):
            raise _YamlError(number, f"'{_shown(key, 40)}' is not a valid key.")
        if key in data:
            raise _YamlError(number, f"The key '{_shown(key, 40)}' is listed twice.")
        if rest.strip():
            data[key] = _value(rest, number)
            i += 1
            continue
        j = i + 1
        block: list[str] = []
        while j < n and (not lines[j].strip() or _indent(lines[j]) > 0 or lines[j].startswith("\t")):
            block.append(lines[j])
            j += 1
        content = [(k, b) for k, b in enumerate(block) if b.strip() and not b.lstrip().startswith("#")]
        if not content:
            data[key] = None
        elif all(b.lstrip().startswith("- ") or b.strip() == "-" for _, b in content):
            items: list[str] = []
            for k, b in content:
                item = b.strip()[1:].strip()
                if not item:
                    raise _YamlError(number + 1 + k, "A list has an empty item.")
                value = _value(item, number + 1 + k)
                if isinstance(value, list):
                    raise _YamlError(number + 1 + k, "Lists inside lists are not supported.")
                items.append(value)
            data[key] = items
        else:
            if nested:
                raise _YamlError(number + 1 + content[0][0], "Only one level of nesting is supported.")
            base = _indent(content[0][1])
            dedented: list[str] = []
            for k, b in enumerate(block):
                if b.strip() and _indent(b) < base:
                    raise _YamlError(number + 1 + k, "The indentation of this line does not match the lines above.")
                dedented.append(b[base:] if b.strip() else "")
            data[key] = _parse_block(dedented, number + 1, nested=True)
        i = j
    return data


def _parse_yaml(text: str, start: int = 1) -> dict[str, Any]:
    return _parse_block(text.split("\n"), start, nested=False)


def _split_front_matter(text: str) -> tuple[str | None, str, int]:
    """``(front matter or None, body, body's first line number)``."""
    normalized = text.lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n")
    lines = normalized.split("\n")
    if not lines or lines[0].rstrip() != "---":
        return None, normalized, 1
    for index in range(1, len(lines)):
        if lines[index].rstrip() == "---":
            return "\n".join(lines[1:index]), "\n".join(lines[index + 1:]), index + 2
    return None, normalized, 1


def _tupled(value: Any) -> Any:
    if isinstance(value, list):
        return tuple(value)
    if isinstance(value, dict):
        return {k: _tupled(v) for k, v in value.items()}
    return value


def _legacy_split_list(raw: str) -> list[str]:
    """A flow list as the retired reader split it: the brackets dropped, the items
    split at every comma, quotes stripped from each and empty items left out."""
    text = raw.strip()
    if text.startswith("[") and text.endswith("]"):
        text = text[1:-1]
    parts = [part.strip().strip("'\"") for part in text.split(",")]
    return [part for part in parts if part]


def _lenient_scalar(raw: str) -> str:
    """One scalar as the strict reader reads it or, when it cannot, as the retired
    reader did (surrounding quotes stripped)."""
    try:
        return _scalar(raw, 0)
    except _YamlError:
        return raw.strip().strip("'\"")


def _lenient_value(raw: str) -> str | list[str]:
    """A scalar or a flow list, strictly where possible, else the retired way."""
    text = raw.strip()
    if text.startswith("["):
        try:
            value = _value(text, 0)
        except _YamlError:
            return _legacy_split_list(text)
        return value if isinstance(value, list) else [value]
    return _lenient_scalar(text)


_BLOCK_SCALAR_HEADERS = frozenset({">", ">-", ">+", "|", "|-", "|+"})


def _lenient_frontmatter(raw: str) -> dict[str, Any]:
    """Front matter the strict subset refuses, read the way the retired reader read
    it: every ``key: value`` line it can read is kept, the last of a repeated key
    wins, and any other line is skipped. It never raises and runs in linear time.

    Beyond the retired reader, which kept the words but lost the shape: indented
    ``key: value`` lines under a key with no value form a nested mapping (the shape
    the strict reader gives, so callers see one shape whichever reader succeeded),
    indented lines after a plain value continue it (a folded scalar), and a ``>`` or
    ``|`` block scalar keeps its text. Lists are lists; :func:`parse_frontmatter`
    turns them into tuples.

    A folded value's continuation lines are collected and joined once, when its run
    ends, like a block scalar's lines: appending to the growing string at every line
    would copy it each time, quadratic in the length of the value."""
    meta: dict[str, Any] = {}
    parent: str | None = None        # a top-level key with no value: its block follows
    nested_key: str | None = None    # a nested key with no value: its list follows
    continued: str | None = None     # the last top-level key with a plain text value
    folded: list[str] = []           # its continuation lines so far
    block: tuple[str, str, list[str]] | None = None

    def close_fold() -> None:
        """End the folded value's run: join its continuation lines into it, the way
        the retired reader built it (one space between lines, the ends trimmed)."""
        nonlocal continued
        if continued is not None and folded and isinstance(meta.get(continued), str):
            meta[continued] = " ".join([meta[continued], *folded]).strip()
        folded.clear()
        continued = None

    def close_block() -> None:
        nonlocal block
        if block is None:
            return
        key, style, lines = block
        while lines and not lines[-1]:
            lines.pop()
        if style.startswith(">"):
            paragraphs: list[list[str]] = [[]]
            for item in lines:
                if item:
                    paragraphs[-1].append(item)
                elif paragraphs[-1]:
                    paragraphs.append([])
            meta[key] = "\n".join(" ".join(p) for p in paragraphs if p)
        else:
            meta[key] = "\n".join(lines)
        block = None

    for line in raw.split("\n"):
        stripped = line.strip()
        indented = line[:1] in (" ", "\t")
        if block is not None:
            if not stripped or indented:
                block[2].append(stripped)
                continue
            close_block()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped == "-" or stripped.startswith("- "):
            item = _lenient_scalar(stripped[1:])
            if parent is not None and nested_key is not None:
                target = meta[parent]
                if not isinstance(target.get(nested_key), list):
                    target[nested_key] = []
                target[nested_key].append(item)
            elif parent is not None and not isinstance(meta.get(parent), dict):
                if not isinstance(meta.get(parent), list):
                    meta[parent] = []
                meta[parent].append(item)
            continue
        raw_key, sep, rest = _split_key(line)
        if not sep:
            if indented and continued is not None and isinstance(meta.get(continued), str):
                folded.append(stripped)
            else:
                close_fold()
                parent = nested_key = None
            continue
        key = _lenient_scalar(raw_key)
        if not key:
            continue
        value = rest.strip()
        if indented and parent is not None and not isinstance(meta.get(parent), list):
            if not isinstance(meta.get(parent), dict):
                meta[parent] = {}
            if value:
                meta[parent][key] = _lenient_value(value)
                nested_key = None
            else:
                meta[parent][key] = None
                nested_key = key
            continue
        close_fold()
        parent = nested_key = None
        if not value:
            meta[key] = None
            parent = key
        elif value in _BLOCK_SCALAR_HEADERS:
            block = (key, value, [])
        else:
            meta[key] = _lenient_value(value)
            if isinstance(meta[key], str) and value[:1] not in "\"'":
                continued = key
    close_block()
    close_fold()
    return meta


def parse_frontmatter(text: str) -> tuple[dict[str, object], str]:
    """Return ``(meta, body)``. Never raises; linear in the text.

    The compatible successor of the retired ``engine.runbooks.parse_frontmatter``,
    used to read legacy documents (the migration). Front matter the strict subset
    reads gives its scalars (plain, double-quoted JSON or single-quoted), inline
    ``[a, b]`` lists and indented ``- item`` lists (both as tuples) and one level of
    nested mapping (as a dict, for example the ``match:`` block of a retired procedure
    document). Front matter it refuses is read leniently, the way the retired reader
    did (:func:`_lenient_frontmatter`), so a document the old write paths accepted
    keeps every key that reader kept. Text without a front matter block gives
    ``({}, text)``.
    """
    try:
        raw, body, _ = _split_front_matter(str(text or ""))
        if raw is None:
            return {}, body.strip()
        try:
            meta = _parse_yaml(raw, 2)
        except _YamlError:
            meta = _lenient_frontmatter(raw)
        return {k: ("" if v is None else _tupled(v)) for k, v in meta.items()}, body.strip()
    except Exception:  # noqa: BLE001 - the parser's contract is that it never raises
        return {}, str(text or "").strip()


# --------------------------------------------------------------------------- #
# Markdown: parse (§4.10.13)
# --------------------------------------------------------------------------- #
FRONT_MATTER_KEYS: tuple[str, ...] = (
    "id", "title", "summary", "use_when", "prerequisites", "version", "priority", "owner",
    "review_every_days", "mitre", "applies_when", "retrieval_queries", "references",
)
APPLIES_WHEN_KEYS: tuple[str, ...] = (
    "rule_ids", "mitre", "entity_types", "severity_at_least", "sources", "verdicts", "statuses",
    "any_tags", "min_event_count", "always",
)
LOOKUP_KEYS: tuple[str, ...] = ("tool", "filter", "group_by", "indicator", "window", "limit", "run")
STEP_ATTRIBUTES: tuple[str, ...] = (
    "kind", "optional", "owner", "approval", "evidence", "target", "react", "d3fend",
)
_PHASE_BY_LABEL: dict[str, str] = {
    **{p: p for p in PHASE_IDS},
    **{label.lower(): p for p, label in PHASE_LABELS.items()},
    "close": "close",
}
#: The key lines a step body may start with. Parsed with plain string operations, never
#: a backtracking pattern, because a source line can be as long as the whole upload.
STEP_KEY_LINES: tuple[str, ...] = ("Focus", "Escalate if", "Benign if", "Options")
_SKIPS_RE = re.compile(r"\|[ \t]*skips:")
_TARGET_RE = re.compile(r"^(\d{1,5})(m|h)$")
_FENCE_OPEN_RE = re.compile(r"^\s{0,3}(```|~~~)")


@dataclass(frozen=True)
class ParsedRunbook:
    """The result of :func:`parse_runbook_markdown`.

    ``definition`` is ``None`` only when the source cannot be turned into a definition
    (no front matter or id, an unknown phase or step kind, a step without an id, a
    number that is not a number, a value outside a closed vocabulary). ``issues``
    lists every problem the parser found, including recoverable ones such as an
    unknown key (reported, and not part of the definition). Content rules are
    :func:`validate_runbook`'s; :func:`parse_and_validate` returns both."""

    definition: RunbookDefinition | None
    version: int | None
    issues: tuple[RunbookIssue, ...]

    @property
    def ok(self) -> bool:
        return self.definition is not None and not self.issues


class _Collector:
    """The parser's issues, kept to :data:`RUNBOOK_MAX_ISSUES` (then one
    ``more_issues`` issue), so a source of stray lines cannot grow the list without
    bound. ``fatal`` still records every fatal problem, kept or not."""

    def __init__(self) -> None:
        self.issues: list[RunbookIssue] = []
        self.fatal = False
        self.more = False

    def add(self, path: str, code: str, message: str, *, fatal: bool = False) -> None:
        self.fatal = self.fatal or fatal
        if len(self.issues) < RUNBOOK_MAX_ISSUES:
            self.issues.append(_issue(path, code, message))
        else:
            self.more = True

    def result(self) -> tuple[RunbookIssue, ...]:
        if self.more:
            return (*self.issues, RunbookIssue(path="", code=ISSUE_MORE, message=_MORE_ISSUES_MESSAGE))
        return tuple(self.issues)


def _as_list(value: Any, path: str = "", what: str = "", sink: _Collector | None = None) -> list[str]:
    """A list value; one scalar is a one-item list. A nested block is refused (it
    would otherwise be dropped without a word)."""
    if value is None:
        return []
    if isinstance(value, list):
        return [str(v) for v in value]
    if isinstance(value, dict):
        if sink is not None:
            sink.add(path, ISSUE_PARSE, f"{what or path} must be a list such as [a, b], not a block of keys.",
                     fatal=True)
        return []
    text = str(value)
    return [text] if text.strip() else []


def _as_int(value: Any, path: str, what: str, sink: _Collector) -> int | None:
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    if isinstance(value, list) or isinstance(value, dict):
        sink.add(path, ISSUE_PARSE, f"{what} must be a whole number.", fatal=True)
        return None
    text = str(value).strip()
    if not re.fullmatch(r"[-+]?\d{1,9}", text):
        sink.add(path, ISSUE_PARSE, f"{what} must be a whole number, not '{_shown(text, 20)}'.", fatal=True)
        return None
    return int(text)


#: The issue a front-matter ``version`` that is not a version gives (never fatal).
VERSION_IGNORED_MESSAGE = "version is not a whole number of 1 or more, so it is ignored."


def _version_from(value: Any, sink: _Collector) -> int | None:
    """The front matter's ``version`` as a whole number of at least 1, else ``None``
    with one non-fatal issue (an empty value is simply absent)."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    text = "" if isinstance(value, (list, dict)) else str(value).strip()
    if re.fullmatch(r"\+?\d{1,9}", text) and int(text) >= 1:
        return int(text)
    sink.add("version", ISSUE_PARSE, VERSION_IGNORED_MESSAGE)
    return None


def _as_bool(value: Any, path: str, what: str, sink: _Collector) -> bool:
    text = str(value).strip().lower() if isinstance(value, str) else value
    if text in ("true", True):
        return True
    if text in ("false", False, None, ""):
        return False
    sink.add(path, ISSUE_PARSE, f"{what} must be true or false.", fatal=True)
    return False


def _as_text(value: Any, path: str, what: str, sink: _Collector) -> str:
    if value is None:
        return ""
    if isinstance(value, (list, dict)):
        sink.add(path, ISSUE_PARSE, f"{what} must be text, not a list.", fatal=True)
        return ""
    return str(value)


def _closed(values: list[str], allowed: tuple[str, ...], path: str, what: str, sink: _Collector) -> list[str]:
    out = []
    for value in values:
        if value in allowed:
            out.append(value)
        else:
            sink.add(path, ISSUE_PARSE,
                     f"{what} '{_shown(value, 30)}' is not one of " + ", ".join(allowed) + ".", fatal=True)
    return out


def _applies_when_from(raw: Any, sink: _Collector) -> dict[str, Any]:
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        sink.add("applies_when", ISSUE_PARSE,
                 "applies_when must be a block of 'key: value' lines.", fatal=True)
        return {}
    out: dict[str, Any] = {}
    for key, value in raw.items():
        path = f"applies_when.{key}"
        if key not in APPLIES_WHEN_KEYS:
            sink.add(path, ISSUE_UNKNOWN_KEY,
                     f"applies_when has the unknown key '{_shown(key, 40)}'. Known keys: "
                     + ", ".join(APPLIES_WHEN_KEYS) + ".")
            continue
        if key == "entity_types":
            out[key] = _closed(_as_list(value, path, key, sink), RUNBOOK_ENTITY_TYPES, path,
                               "The entity type", sink)
        elif key == "verdicts":
            out[key] = _closed(_as_list(value, path, key, sink), _VERDICTS, path, "The verdict", sink)
        elif key == "severity_at_least":
            text = _as_text(value, path, "severity_at_least", sink).strip()
            if text:
                out[key] = (_closed([text], SEVERITY_LEVELS, path, "The severity", sink) or [None])[0]
        elif key == "min_event_count":
            number = _as_int(value, path, "min_event_count", sink)
            if number is not None:
                if not 1 <= number <= 1_000_000:
                    sink.add(path, ISSUE_PARSE, "min_event_count must be between 1 and 1,000,000.", fatal=True)
                else:
                    out[key] = number
        elif key == "always":
            out[key] = _as_bool(value, path, "always", sink)
        else:
            out[key] = _as_list(value, path, key, sink)
    return out


def _lookup_from(text: str, path: str, owner: str, start: int, sink: _Collector) -> LookupTemplate | None:
    try:
        raw = _parse_yaml(text, start)
    except _YamlError as exc:
        sink.add(path, ISSUE_PARSE, f"{owner} lookup, line {exc.line}: {exc.message}", fatal=True)
        return None
    data: dict[str, Any] = {}
    for key, value in raw.items():
        kpath = f"{path}.{key}"
        if key not in LOOKUP_KEYS:
            sink.add(kpath, ISSUE_UNKNOWN_KEY,
                     f"{owner} lookup has the unknown key '{_shown(key, 40)}'. Known keys: "
                     + ", ".join(LOOKUP_KEYS) + ".")
            continue
        if key == "tool":
            tool = _as_text(value, kpath, f"{owner} lookup tool", sink).strip()
            if tool not in LOOKUP_TOOLS:
                sink.add(kpath, ISSUE_PARSE,
                         f"{owner} lookup tool '{_shown(tool, 30)}' is not one of " + ", ".join(LOOKUP_TOOLS) + ".",
                         fatal=True)
            data["tool"] = tool
        elif key == "filter":
            if value is None:
                data["filter"] = {}
            elif not isinstance(value, dict):
                sink.add(kpath, ISSUE_PARSE, f"{owner} lookup filter must be a block of 'field: value' lines.",
                         fatal=True)
            else:
                flt: dict[str, str] = {}
                for fkey, fvalue in value.items():
                    if isinstance(fvalue, list):
                        sink.add(f"{kpath}.{fkey}", ISSUE_PARSE,
                                 f"{owner} lookup filter on {_shown(fkey, 40)} must be one value.", fatal=True)
                        continue
                    flt[str(fkey)] = "" if fvalue is None else str(fvalue)
                data["filter"] = flt
        elif key == "group_by":
            data["group_by"] = _as_list(value, kpath, f"{owner} lookup group_by", sink)
        elif key in ("indicator", "window", "run"):
            text_value = _as_text(value, kpath, f"{owner} lookup {key}", sink).strip()
            if key == "run" and text_value not in ("on_attach", "on_demand"):
                sink.add(kpath, ISSUE_PARSE, f"{owner} lookup run must be on_attach or on_demand.", fatal=True)
            if text_value or key != "indicator":
                data[key] = text_value
        elif key == "limit":
            number = _as_int(value, kpath, f"{owner} lookup limit", sink)
            if number is not None:
                if not 1 <= number <= 50:
                    sink.add(kpath, ISSUE_PARSE, f"{owner} lookup limit must be between 1 and 50.", fatal=True)
                else:
                    data["limit"] = number
    if "tool" not in data:
        sink.add(f"{path}.tool", ISSUE_PARSE, f"{owner} lookup needs a tool.", fatal=True)
        return None
    if sink.fatal:
        return None
    try:
        return LookupTemplate.model_validate(data)
    except ValidationError:
        sink.add(path, ISSUE_PARSE, f"{owner} lookup is not valid.", fatal=True)
        return None


def _split_heading(heading: str) -> tuple[str, str | None]:
    """``(title, attribute text)`` of a step heading ``<title> {<attributes>}``; the
    attribute text is ``None`` when the heading does not end with a brace group."""
    text = heading.rstrip()
    if not text.endswith("}"):
        return text.strip(), None
    start = text.rfind("{")
    if start < 0 or "}" in text[start + 1:-1]:
        return text.strip(), None
    return text[:start].strip(), text[start + 1:-1]


def _key_line(line: str) -> tuple[str, str] | None:
    """``(key, value)`` when ``line`` is one of :data:`STEP_KEY_LINES` (in any letter
    case, after any indentation), else ``None``. ``key`` is the canonical spelling."""
    text = line.lstrip(" \t")
    for key in STEP_KEY_LINES:
        if text[: len(key) + 1].lower() == key.lower() + ":":
            rest = text[len(key) + 1:]
            if rest and rest[0] not in " \t":
                return None
            return key, rest.strip()
    return None


def _leading_key_line(text: str) -> str | None:
    """The key line the first non-blank line of ``text`` would be read as (its
    canonical name), or ``None``. Instructions must not start with one, because the
    Markdown form reads a key line under a heading as the step's own field."""
    for line in text.split("\n"):
        if line.strip():
            found = _key_line(line)
            return found[0] if found else None
    return None


def _option_line(line: str) -> dict[str, Any] | None:
    """``- <id>: <label>`` with an optional ``| skips: <id>, <id>``, or ``None``."""
    body = line[2:].lstrip()
    option_id, sep, rest = body.partition(":")
    if not sep or not option_id or any(ch.isspace() for ch in option_id):
        return None
    skips: list[str] = []
    match = _SKIPS_RE.search(rest)
    if match:
        skips = [s.strip() for s in rest[match.end():].split(",") if s.strip()]
        rest = rest[: match.start()]
    return {"id": option_id, "label": rest.strip(), "marks_not_applicable": skips}


def _attributes(raw: str) -> list[str]:
    tokens: list[str] = []
    buf: list[str] = []
    quote = False
    i = 0
    while i < len(raw):
        ch = raw[i]
        if quote:
            buf.append(ch)
            if ch == "\\" and i + 1 < len(raw):
                buf.append(raw[i + 1])
                i += 2
                continue
            if ch == '"':
                quote = False
        elif ch == '"':
            quote = True
            buf.append(ch)
        elif ch.isspace():
            if buf:
                tokens.append("".join(buf))
                buf = []
        else:
            buf.append(ch)
        i += 1
    if buf:
        tokens.append("".join(buf))
    return tokens


def _parse_step(
    heading: str,
    body: list[str],
    phase: str,
    index: int,
    start: int,
    sink: _Collector,
) -> dict[str, Any] | None:
    path = f"steps[{index}]"
    title, raw_attrs = _split_heading(heading)
    attrs = _attributes(raw_attrs) if raw_attrs is not None else []
    m = raw_attrs is not None
    owner = f"Step '{_shown(title)}'" if title else f"Step {index + 1}"
    step: dict[str, Any] = {"phase": phase, "title": title}
    for token in attrs:
        if token.startswith("#"):
            if "id" in step:
                sink.add(f"{path}.id", ISSUE_PARSE, f"{owner} has two ids.", fatal=True)
            step["id"] = token[1:]
            continue
        if token == "optional":
            step["required"] = False
            continue
        key, sep, value = token.partition("=")
        if sep and value.startswith('"'):
            try:
                value = json.loads(value)
            except ValueError:
                sink.add(f"{path}.{key}", ISSUE_PARSE, f"{owner} has a quoted {key} that is not closed.", fatal=True)
                continue
        if not sep or key not in STEP_ATTRIBUTES or key == "optional":
            sink.add(f"{path}.attributes", ISSUE_UNKNOWN_KEY,
                     f"{owner} has the unknown attribute '{_shown(token, 30)}'. Known attributes: "
                     "#id, kind=, optional, owner=, approval=, evidence=, target=, react=, d3fend=.")
            continue
        if key == "kind":
            if value not in STEP_KINDS:
                sink.add(f"{path}.kind", ISSUE_PARSE,
                         f"{owner} kind '{_shown(value, 20)}' is not one of " + ", ".join(STEP_KINDS) + ".",
                         fatal=True)
            step["kind"] = value
        elif key == "owner":
            step["owner_role"] = value
        elif key == "approval":
            step["approval_role"] = value
        elif key == "evidence":
            if value not in ("none", "note", "note_or_attachment"):
                sink.add(f"{path}.evidence", ISSUE_PARSE,
                         f"{owner} evidence must be note or note_or_attachment.", fatal=True)
            step["evidence"] = value
        elif key == "target":
            tm = _TARGET_RE.fullmatch(value)
            minutes = (int(tm.group(1)) * (60 if tm.group(2) == "h" else 1)) if tm else 0
            if not tm or not 1 <= minutes <= 10_080:
                sink.add(f"{path}.target", ISSUE_PARSE,
                         f"{owner} target must be minutes or hours such as 30m or 4h, at most 168h.",
                         fatal=True)
            else:
                step["target_minutes"] = minutes
        elif key in ("react", "d3fend"):
            step[key] = value
    if not m:
        sink.add(f"{path}.id", ISSUE_PARSE,
                 f"{owner} needs an id and a kind: end its heading with {{#an-id kind=check}}.", fatal=True)
    elif "id" not in step or not str(step["id"]).strip():
        sink.add(f"{path}.id", ISSUE_PARSE, f"{owner} needs an id: add #an-id inside the braces.", fatal=True)
    elif "kind" not in step:
        sink.add(f"{path}.kind", ISSUE_PARSE, f"{owner} needs a kind: add kind=check (or lookup, "
                 "decision, action, record) inside the braces.", fatal=True)

    # Key lines at the start of the body: the leading run of key lines, with blank
    # lines allowed before and between them (a blank line after a heading is ordinary
    # Markdown style, and must not turn the guidance into instructions).
    i = 0
    n_body = len(body)
    seen_keys: set[str] = set()
    while True:
        k = i
        while k < n_body and not body[k].strip():
            k += 1
        km = _key_line(body[k]) if k < n_body else None
        if km is None:
            break
        i = k
        name, value = km
        if name in seen_keys:
            sink.add(path, ISSUE_PARSE, f"{owner} has the line '{name}:' twice.", fatal=True)
        seen_keys.add(name)
        if name == "Options":
            if value:
                sink.add(f"{path}.options", ISSUE_PARSE,
                         f"{owner} lists options on the lines after 'Options:', one per line.", fatal=True)
            options: list[dict[str, Any]] = []
            i += 1
            # Blank lines may sit between 'Options:' and the first option; a blank line
            # after an option ends the list (instructions may start with a list).
            k = i
            while k < n_body and not body[k].strip():
                k += 1
            if k < n_body and body[k].lstrip(" \t").startswith("- "):
                i = k
            while i < n_body and body[i].lstrip(" \t").startswith("- "):
                option = _option_line(body[i].lstrip(" \t"))
                if option is None:
                    sink.add(f"{path}.options", ISSUE_PARSE,
                             f"{owner} option line {start + i} must be '- id: label' with an optional "
                             "'| skips: step-id, step-id'.", fatal=True)
                else:
                    options.append(option)
                i += 1
            step["options"] = options
            continue
        field = {"Focus": "focus", "Escalate if": "escalate_if", "Benign if": "benign_if"}[name]
        if value:
            step[field] = value
        i += 1

    # The lookup block, then the instructions.
    rest = body[i:]
    instructions: list[str] = []
    lookup_text: list[str] | None = None
    lookup_start = 0
    j = 0
    while j < len(rest):
        line = rest[j]
        if line.strip() in ("```lookup", "~~~lookup"):
            fence = line.strip()[:3]
            if lookup_text is not None:
                sink.add(f"{path}.lookup", ISSUE_PARSE, f"{owner} has two lookup blocks.", fatal=True)
            block: list[str] = []
            k = j + 1
            while k < len(rest) and rest[k].strip() != fence:
                block.append(rest[k])
                k += 1
            if k >= len(rest):
                sink.add(f"{path}.lookup", ISSUE_PARSE, f"{owner} lookup block is not closed with {fence}.",
                         fatal=True)
            lookup_text, lookup_start = block, start + i + j + 1
            j = k + 1
            continue
        instructions.append(line)
        j += 1
    if lookup_text is not None:
        lookup = _lookup_from("\n".join(lookup_text), f"{path}.lookup", owner, lookup_start, sink)
        if lookup is not None:
            step["lookup"] = lookup
    step["instructions"] = _clean_block("\n".join(instructions))
    return step


def parse_runbook_markdown(text: str) -> ParsedRunbook:
    """Parse the native Markdown form (SPEC §4.10.13) into a definition.

    Front matter holds the header and ``applies_when``; ``## <Phase>`` headings order
    the phases; ``### <title> {#<id> kind=<kind> ...}`` starts a step; the key lines
    ``Focus:``, ``Escalate if:``, ``Benign if:`` and ``Options:`` under the heading
    (in any letter case, blank lines allowed before and between them) carry the
    step's guidance; a fenced ``lookup`` block holds a Lookup's
    template; the rest is the instructions. ``version`` in the front matter is
    metadata outside the definition and is returned separately. Never raises.

    A source over :data:`RUNBOOK_MAX_SOURCE_BYTES` (64 KiB) is refused with one
    ``source_too_large`` issue before any of it is read."""
    sink = _Collector()
    size_issue = _source_size_issue(text)
    if size_issue is not None:
        return ParsedRunbook(None, None, (size_issue,))
    try:
        raw_meta, body, body_start = _split_front_matter(str(text or ""))
    except Exception:  # noqa: BLE001 - never raises
        raw_meta, body, body_start = None, "", 1
    if raw_meta is None:
        sink.add("source", ISSUE_PARSE,
                 "The source must start with front matter: a line '---', the header keys, then '---'.",
                 fatal=True)
        return ParsedRunbook(None, None, sink.result())
    try:
        meta = _parse_yaml(raw_meta, 2)
    except _YamlError as exc:
        sink.add("source", ISSUE_PARSE, f"Front matter, line {exc.line}: {exc.message}", fatal=True)
        return ParsedRunbook(None, None, sink.result())

    data: dict[str, Any] = {}
    version: int | None = None
    for key, value in meta.items():
        if key not in FRONT_MATTER_KEYS:
            sink.add(key, ISSUE_UNKNOWN_KEY,
                     f"The front matter has the unknown key '{_shown(key, 40)}'. Known keys: "
                     + ", ".join(FRONT_MATTER_KEYS) + ".")
            continue
        if key in ("id", "title", "summary", "use_when", "prerequisites", "owner"):
            data[key] = _as_text(value, key, key, sink).strip()
        elif key == "version":
            # Metadata outside the definition (SPEC §4.10.13): an import accepts and
            # ignores it, so a value that is not a version never refuses an otherwise
            # valid runbook; it is reported and ignored. The built-in loader still
            # refuses a built-in without a valid version.
            version = _version_from(value, sink)
        elif key in ("priority", "review_every_days"):
            number = _as_int(value, key, key, sink)
            if number is not None:
                low, high = (0, 100) if key == "priority" else (30, 730)
                if not low <= number <= high:
                    sink.add(key, ISSUE_PARSE, f"{key} must be between {low} and {high}.", fatal=True)
                else:
                    data[key] = number
        elif key == "applies_when":
            data[key] = _applies_when_from(value, sink)
        else:
            data[key] = _as_list(value, key, key, sink)
    if not data.get("id"):
        sink.add("id", ISSUE_PARSE, "The front matter needs an id.", fatal=True)
    # A missing title or summary still gives a definition; validation names the gap.
    data.setdefault("title", "")
    data.setdefault("summary", "")
    if data.get("owner") == "":
        data["owner"] = None

    # Body --------------------------------------------------------------------
    phases: list[str] = []
    steps: list[dict[str, Any]] = []
    lines = body.split("\n")
    current_phase: str | None = None
    step_heading: str | None = None
    step_lines: list[str] = []
    step_start = 0
    fence: str | None = None

    def flush() -> None:
        nonlocal step_heading, step_lines
        if step_heading is not None and current_phase is not None:
            step = _parse_step(step_heading, step_lines, current_phase, len(steps), step_start, sink)
            if step is not None:
                steps.append(step)
        step_heading, step_lines = None, []

    for offset, line in enumerate(lines):
        number = body_start + offset
        if fence is not None:
            if line.strip() == fence or (line.strip().startswith(fence) and not line.strip()[3:].strip()):
                fence = None
            step_lines.append(line)
            continue
        fm = _FENCE_OPEN_RE.match(line)
        if fm and step_heading is not None:
            fence = fm.group(1)
            step_lines.append(line)
            continue
        if line.startswith("## ") or line.rstrip() == "##":
            flush()
            label = line[2:].strip().lower()
            phase = _PHASE_BY_LABEL.get(label)
            if phase is None:
                sink.add("phases", ISSUE_PARSE,
                         f"Line {number}: '{_shown(line[2:].strip(), 40)}' is not a phase. Use "
                         + ", ".join(PHASE_LABELS[p] for p in PHASE_IDS) + ".", fatal=True)
                current_phase = None
                continue
            if phase in phases:
                sink.add("phases", ISSUE_PARSE,
                         f"Line {number}: the phase {PHASE_LABELS[phase]} appears twice. Keep its steps "
                         "under one heading.", fatal=True)
            phases.append(phase)
            current_phase = phase
            continue
        if line.startswith("### "):
            flush()
            if current_phase is None:
                sink.add("steps", ISSUE_PARSE,
                         f"Line {number}: a step must be under a phase heading such as '## Triage'.", fatal=True)
                continue
            step_heading, step_start = line[4:].strip(), number + 1
            continue
        if step_heading is not None:
            step_lines.append(line)
        elif line.strip():
            if line.startswith("# "):
                message = f"Line {number}: a top-level '#' heading is not part of the format. Remove it."
            else:
                message = (f"Line {number}: text outside a step is not kept. Put it in a step's "
                           "instructions or remove it.")
            sink.add("source", ISSUE_PARSE, message, fatal=True)
    flush()
    data["phases"] = phases
    data["steps"] = steps

    if sink.fatal:
        return ParsedRunbook(None, version, sink.result())
    try:
        definition = RunbookDefinition.model_validate(data)
    except ValidationError as exc:
        for err in exc.errors()[:20]:
            loc = ".".join(str(part) for part in err.get("loc", ()))
            sink.add(loc or "source", ISSUE_PARSE, f"'{loc}' is not valid: {err.get('msg', 'invalid value')}.",
                     fatal=True)
        return ParsedRunbook(None, version, sink.result())
    return ParsedRunbook(definition, version, sink.result())


def parse_and_validate(
    text: str,
    *,
    origin: RunbookOriginKind = "operator",
) -> tuple[RunbookDefinition | None, int | None, list[RunbookIssue]]:
    """Parse ``text`` and validate the result against the source's own size:
    ``(definition, version, parse issues + validation issues)``, at most
    :data:`RUNBOOK_MAX_ISSUES` of them. A source over 64 KiB gets only its size
    issue: it is never parsed."""
    parsed = parse_runbook_markdown(text)
    issues = [i for i in parsed.issues if i.code != ISSUE_MORE]
    more = len(issues) != len(parsed.issues)
    if parsed.definition is not None:
        checked = validate_runbook(parsed.definition, origin=origin, source=text, version=parsed.version)
        more = more or any(i.code == ISSUE_MORE for i in checked)
        issues += [i for i in checked if i.code != ISSUE_MORE]
    capped = _capped(issues)
    if more and len(capped) == len(issues):
        capped.append(RunbookIssue(path="", code=ISSUE_MORE, message=_MORE_ISSUES_MESSAGE))
    return parsed.definition, parsed.version, capped


def _source_size_issue(text: Any) -> RunbookIssue | None:
    """The ``source_too_large`` issue for a Markdown source over
    :data:`RUNBOOK_MAX_SOURCE_BYTES`, or ``None``."""
    size = _utf8_bytes(str(text or ""))
    if size <= RUNBOOK_MAX_SOURCE_BYTES:
        return None
    return _issue("source", ISSUE_SOURCE_SIZE,
                  f"The Markdown source is {size:,} bytes; the limit is {RUNBOOK_MAX_SOURCE_BYTES:,}.")


# --------------------------------------------------------------------------- #
# Markdown: export (§4.10.13)
# --------------------------------------------------------------------------- #
def _needs_quotes(value: str, *, in_flow: bool = False) -> bool:
    if value != value.strip() or not value:
        return True
    if value.lower() in _YAML_SPECIAL_WORDS or _NUMBER_LIKE_RE.match(value):
        return True
    if value.startswith(_PLAIN_UNSAFE_START) and not value.startswith("{{"):
        return True
    if value.startswith("{{"):
        return True  # a template looks like a flow mapping to YAML tools
    if ": " in value or " #" in value or value.endswith(":"):
        return True
    if in_flow and any(ch in value for ch in ",[]{}\"'"):
        return True
    return any(ch in value for ch in "\n\r\t")


def _yaml_scalar(value: str, *, in_flow: bool = False) -> str:
    return json.dumps(value, ensure_ascii=False) if _needs_quotes(value, in_flow=in_flow) else value


def _yaml_flow(values: Iterable[str]) -> str:
    return "[" + ", ".join(_yaml_scalar(v, in_flow=True) for v in values) + "]"


def _yaml_key(key: str) -> str:
    return key if _KEY_RE.fullmatch(key) and not _needs_quotes(key) else json.dumps(key, ensure_ascii=False)


def _attr_value(value: str) -> str:
    if not value or any(ch.isspace() or ch in '"{}=\\' for ch in value):
        return json.dumps(value, ensure_ascii=False)
    return value


def _format_target(minutes: int) -> str:
    return f"{minutes // 60}h" if minutes % 60 == 0 else f"{minutes}m"


def _export_lookup(lookup: LookupTemplate) -> list[str]:
    out = ["```lookup", f"tool: {lookup.tool}"]
    if lookup.filter:
        out.append("filter:")
        for key, value in lookup.filter.items():
            out.append(f"  {_yaml_key(key)}: {_yaml_scalar(value)}")
    if lookup.group_by:
        out.append(f"group_by: {_yaml_flow(lookup.group_by)}")
    if lookup.indicator:
        out.append(f"indicator: {_yaml_scalar(lookup.indicator)}")
    out.append(f"window: {_yaml_scalar(lookup.window)}")
    out.append(f"limit: {lookup.limit}")
    out.append(f"run: {lookup.run}")
    out.append("```")
    return out


def _export_step(step: RunbookStep) -> list[str]:
    attrs = [f"#{step.id}", f"kind={step.kind}"]
    if not step.required:
        attrs.append("optional")
    if step.owner_role:
        attrs.append(f"owner={_attr_value(step.owner_role)}")
    if step.approval_role:
        attrs.append(f"approval={_attr_value(step.approval_role)}")
    if step.evidence != "none":
        attrs.append(f"evidence={step.evidence}")
    if step.target_minutes:
        attrs.append(f"target={_format_target(step.target_minutes)}")
    if step.react:
        attrs.append(f"react={_attr_value(step.react)}")
    if step.d3fend:
        attrs.append(f"d3fend={_attr_value(step.d3fend)}")
    out = [f"### {step.title} {{{' '.join(attrs)}}}"]
    keys: list[str] = []
    if step.focus:
        keys.append(f"Focus: {step.focus}")
    if step.escalate_if:
        keys.append(f"Escalate if: {step.escalate_if}")
    if step.benign_if:
        keys.append(f"Benign if: {step.benign_if}")
    if step.options:
        keys.append("Options:")
        for option in step.options:
            line = f"- {option.id}: {option.label}"
            if option.marks_not_applicable:
                line += " | skips: " + ", ".join(option.marks_not_applicable)
            keys.append(line)
    out += keys
    if step.lookup is not None:
        out.append("")
        out += _export_lookup(step.lookup)
    if step.instructions:
        out.append("")
        out.append(step.instructions)
    return out


def export_runbook_markdown(defn: RunbookDefinition, *, version: int | None = None) -> str:
    """The native Markdown form of ``defn`` (SPEC §4.10.13), written from its
    normalised form (:func:`normalise_definition`). ``version`` is written to the
    front matter when given (export writes the version it exported).
    :func:`parse_runbook_markdown` of the result gives back the normalised definition,
    which is ``defn`` itself for a stored definition."""
    defn = normalise_definition(defn)
    fm: list[str] = ["---", f"id: {_yaml_scalar(defn.id)}", f"title: {_yaml_scalar(defn.title)}",
                     f"summary: {_yaml_scalar(defn.summary)}"]
    if defn.use_when:
        fm.append(f"use_when: {_yaml_scalar(defn.use_when)}")
    if defn.prerequisites:
        fm.append(f"prerequisites: {_yaml_scalar(defn.prerequisites)}")
    if version is not None:
        fm.append(f"version: {version}")
    fm.append(f"priority: {defn.priority}")
    if defn.owner:
        fm.append(f"owner: {_yaml_scalar(defn.owner)}")
    fm.append(f"review_every_days: {defn.review_every_days}")
    if defn.mitre:
        fm.append(f"mitre: {_yaml_flow(defn.mitre)}")
    aw = defn.applies_when
    aw_lines: list[str] = []
    for key in ("rule_ids", "mitre", "entity_types"):
        values = getattr(aw, key)
        if values:
            aw_lines.append(f"  {key}: {_yaml_flow(values)}")
    if aw.severity_at_least:
        aw_lines.append(f"  severity_at_least: {aw.severity_at_least}")
    for key in ("sources", "verdicts", "statuses", "any_tags"):
        values = getattr(aw, key)
        if values:
            aw_lines.append(f"  {key}: {_yaml_flow(values)}")
    if aw.min_event_count is not None:
        aw_lines.append(f"  min_event_count: {aw.min_event_count}")
    if aw.always:
        aw_lines.append("  always: true")
    if aw_lines:
        fm.append("applies_when:")
        fm += aw_lines
    if defn.retrieval_queries:
        fm.append("retrieval_queries:")
        fm += [f"  - {_yaml_scalar(q)}" for q in defn.retrieval_queries]
    if defn.references:
        fm.append("references:")
        fm += [f"  - {_yaml_scalar(r)}" for r in defn.references]
    fm.append("---")

    body: list[str] = []
    order = list(dict.fromkeys([*defn.phases, *(s.phase for s in defn.steps)]))
    for phase in order:
        body += ["", f"## {PHASE_LABELS.get(phase, phase)}"]
        for step in (s for s in defn.steps if s.phase == phase):
            body.append("")
            body += _export_step(step)
    return "\n".join(fm + body).rstrip("\n") + "\n"


# --------------------------------------------------------------------------- #
# The built-in library (§4.10.14)
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class BuiltinRunbook:
    """One bundled runbook: read-only, versioned by the release (``version`` in its
    front matter, which is the built-in's ``RunbookSummary.live_version``)."""

    definition: RunbookDefinition
    version: int
    source: str
    content_hash: str
    prompt_chars: int
    file_name: str

    @property
    def id(self) -> str:
        return self.definition.id

    @property
    def title(self) -> str:
        return self.definition.title


_BUILTIN_CACHE: tuple[BuiltinRunbook, ...] | None = None


def load_builtin_library(directory: Path) -> tuple[tuple[BuiltinRunbook, ...], dict[str, list[RunbookIssue]]]:
    """Load every ``*.md`` runbook under ``directory`` (README and index skipped):
    ``(valid runbooks in library order, {file name: issues} for the ones refused)``.
    A built-in must parse, carry a ``version``, have a built-in id and pass
    :func:`validate_runbook` with no issue."""
    loaded: list[BuiltinRunbook] = []
    refused: dict[str, list[RunbookIssue]] = {}
    if not directory.is_dir():
        return (), {}
    for path in sorted(directory.glob("*.md")):
        if path.stem.lower() in {"readme", "index"}:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as exc:
            refused[path.name] = [_issue("source", ISSUE_PARSE, f"The file could not be read: {exc}.")]
            continue
        definition, version, issues = parse_and_validate(text, origin="builtin")
        if definition is not None and version is None:
            issues.append(_issue("version", ISSUE_REQUIRED, "A built-in runbook needs a version."))
        if definition is not None and definition.id != path.stem:
            issues.append(_issue("id", ISSUE_INVALID, f"The id '{definition.id}' must match the file name."))
        if definition is None or version is None or issues:
            refused[path.name] = issues
            continue
        loaded.append(BuiltinRunbook(
            definition=definition,
            version=version,
            source=text,
            content_hash=content_hash(definition),
            prompt_chars=len(render_runbook_prompt(definition, version)),
            file_name=path.name,
        ))
    rank = {rid: i for i, rid in enumerate(BUILTIN_RUNBOOK_IDS)}
    loaded.sort(key=lambda b: (rank.get(b.id, len(rank)), b.id))
    return tuple(loaded), refused


def load_builtin_runbooks() -> tuple[BuiltinRunbook, ...]:
    """The bundled library, loaded once per process and cached (never stored). A
    file that fails to load is logged and left out; it never stops the application."""
    global _BUILTIN_CACHE
    if _BUILTIN_CACHE is None:
        loaded, refused = load_builtin_library(RUNBOOK_LIBRARY_DIR)
        for name, issues in refused.items():
            logger.error("Built-in runbook %s was not loaded: %s", name,
                         "; ".join(i.message for i in issues[:5]) or "unknown problem")
        if not loaded:
            logger.error("No built-in runbooks were loaded from %s", RUNBOOK_LIBRARY_DIR)
        _BUILTIN_CACHE = loaded
    return _BUILTIN_CACHE


def builtin_runbook(runbook_id: Any) -> BuiltinRunbook | None:
    """The built-in with ``runbook_id``, or ``None``."""
    for item in load_builtin_runbooks():
        if item.id == runbook_id:
            return item
    return None


__all__ = [
    "APPLIES_WHEN_KEYS",
    "AppliesWhen",
    "DecisionOption",
    "LookupTemplate",
    "RunbookDefinition",
    "RunbookIssue",
    "RunbookStep",
    "RunbookVersionDoc",
    "BUILTIN_RUNBOOK_IDS",
    "BuiltinRunbook",
    "CASE_CARRIED_ENTITY_KINDS",
    "FRONT_MATTER_KEYS",
    "GENERIC_INCIDENT_RUNBOOK_ID",
    "ISSUE_BUILTIN_ID",
    "ISSUE_RESERVED",
    "KIND_LABELS",
    "LEGACY_BUNDLED_PLAYBOOK_IDS",
    "LEGACY_BUNDLED_RUNBOOK_MAP",
    "LOOKUP_KEYS",
    "MAX_OPERATOR_RUNBOOKS",
    "MAX_RUNBOOK_PROMPT_CHARS",
    "MAX_RUNBOOK_VERSIONS",
    "MAX_RUNS_PER_CASE",
    "PHASE_FRAMEWORKS",
    "PHASE_IDS",
    "PHASE_LABELS",
    "ParsedRunbook",
    "RUNBOOK_DEFAULT_REVIEW_DAYS",
    "RUNBOOK_LIBRARY_DIR",
    "SHADOWING_IDS",
    "VERSION_IGNORED_MESSAGE",
    "applies_to",
    "blocking_error_code",
    "builtin_runbook",
    "canonical_definition_json",
    "content_hash",
    "copy_runbook_id",
    "cut_text",
    "export_runbook_markdown",
    "fit_id",
    "is_reserved_id",
    "load_builtin_library",
    "load_builtin_runbooks",
    "markdown_problems",
    "normalise_definition",
    "parse_and_validate",
    "parse_frontmatter",
    "parse_runbook_markdown",
    "prompt_chars",
    "render_runbook_prompt",
    "resolve_automation_runbook_id",
    "resolve_legacy_runbook_id",
    "slugify",
    "unique_slug",
    "valid_runbook_id",
    "validate_runbook",
]
