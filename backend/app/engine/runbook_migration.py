"""The one-shot migration of stored operator procedures into runbooks (Round 14 SPEC
§4.10.17, E9).

Before Round 14 an operator kept two kinds of procedure: Markdown procedure documents
(the retired ``playbooks`` KV namespace, and optionally ``*.md`` files in the
directory ``Preferences.playbooks.dir`` named) and plain-text reference runbooks (the
retired ``runbooks`` KV namespace). Round 14 has one Runbooks feature. At application
startup, after the stores are ready, :func:`run_runbook_migration` converts every
stored document ONCE into an operator runbook in the new library, then reprojects the
RAG corpus. It is not a Job (no person starts it, E9) and costs no model call (#6).

Steps (SPEC §4.10.17):

1. Read the marker ``runbook_library:migration``. With ``completed_at`` and
   ``projection_completed_at`` there is nothing to do. With ``completed_at`` only,
   resume the projection (step 7).
2. Read the legacy documents, never writing them (``stores.legacy_procedures``), and
   the configured procedure directory when it is not the packaged one.
3. Convert each document (:func:`convert_procedure_document`,
   :func:`convert_reference_document`), with the deterministic overflow rules: every
   move is one line in the version's ``import_notes``, and no text is dropped.
4. A converted document that passes ``validate_runbook`` is stored Published v1
   (origin ``imported``, due for review at once, D38); one that fails is stored as a
   Draft with its issues in ``import_notes``. A document that was never used before
   the upgrade lands as a Draft and never matches until someone publishes it: a
   stored document whose id a bundled document of its own kind owned (the shadow
   rule, ``<id>-imported``), and, when a procedure folder was configured, every stored
   procedure document (only the folder was read). A live document renamed because a
   built-in or a retired bundled id meets it, and the folder's own files (the live
   set), keep their validated state (:func:`plan_id`). So does every other document,
   unless a match condition could not be kept and dropping it would widen the match
   (:func:`_criteria`): that one is a Draft too, so a dropped criterion never makes
   trusted guidance reach more cases than before.
5. One ``runbook.migrated`` audit row per document, appended BEFORE its library write
   (E16; a failed write appends the paired ``runbook.migrate_failed``), one
   ``runbook.migration_skipped`` row per document (or configured procedure folder)
   that was never attempted (unreadable, or the library full), and one
   ``runbook.migration_completed`` summary row, always (zero counts on a fresh
   install: the marker it records is a state change, E16); actor
   ``runbook_migration``, actor type ``system``, sink ``control_audit``.
6. Write the marker ``{version, completed_at, counts, sources, id_map,
   projection_generation}``. ``id_map`` is what an automation rule naming a legacy
   procedure resolves against at fire time (:func:`migrated_procedure_ids`).
7. Run the full Published-only RAG projection in process (the ``projector`` the
   caller passes, tagged with ``projection_generation``), then write
   ``projection_completed_at``. Until then the retriever excludes untagged legacy
   runbook chunks (``tools/rag.py``). Application startup runs steps 1 to 6 inline
   (bounded) and this step as a tracked background task
   (:func:`resume_runbook_projection`), so a slow or unreachable embedding provider
   never delays the API.

Idempotency: a failure before the marker leaves it absent; the next start resumes and
skips every document whose ``migrated_from`` already names it (the library index
carries it). A crash during the projection resumes at step 7. The legacy documents are
never written, so a downgrade finds them as they were (step 9).

This module never imports the retired procedure modules (``app.playbooks``,
``stores.playbooks``, ``stores.runbooks``, ``engine.runbooks``,
``engine.runbook_service``): a test runs it with them absent. Nothing here feeds
``case_manager.decide()`` (#3); converted runbook text is trusted only once it is
Published (#9).
"""

from __future__ import annotations

import logging
import math
import re
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Iterable, Literal

from ..constants import RUNBOOK_MIGRATION_ACTOR, ActionType
from ..models import (
    MAX_OPERATOR_RUNBOOKS,
    PHASE_IDS,
    RUNBOOK_APPLIES_MAX_MITRE,
    RUNBOOK_APPLIES_MAX_RULE_CHARS,
    RUNBOOK_APPLIES_MAX_RULES,
    RUNBOOK_ENTITY_TYPES,
    RUNBOOK_MAX_RETRIEVAL_QUERIES,
    RUNBOOK_MAX_RETRIEVAL_QUERY_CHARS,
    RUNBOOK_MAX_SUMMARY_CHARS,
    RUNBOOK_MAX_TITLE_CHARS,
    RUNBOOK_MAX_USE_WHEN_CHARS,
    RUNBOOK_OPERATOR_ID_PATTERN,
    RUNBOOK_RESERVED_IDS,
    RUNBOOK_STEP_MAX_GUIDANCE_CHARS,
    RUNBOOK_STEP_MAX_INSTRUCTIONS_CHARS,
    RUNBOOK_STEP_MAX_TITLE_CHARS,
    AppliesWhen,
    AuditTarget,
    DecisionOption,
    RunbookDefinition,
    RunbookIssue,
    RunbookMigratedFrom,
    RunbookStep,
    RunbookVersionDoc,
)
from ..stores.legacy_procedures import LegacyDocument, LegacyProcedureReader
from ..stores.runbook_library import (
    RunbookLibraryStore,
    RunbookMigrationCounts,
    RunbookMigrationMarker,
    StoredRunbook,
    migrated_map,
)
from ..utils import iso_now
from .runbook_model import (
    BUILTIN_RUNBOOK_IDS,
    LEGACY_BUNDLED_PLAYBOOK_IDS,
    LEGACY_BUNDLED_RUNBOOK_MAP,
    MAX_RUNBOOK_PROMPT_CHARS,
    SHADOWING_IDS,
    content_hash,
    cut_text,
    export_runbook_markdown,
    fit_id,
    normalise_definition,
    parse_frontmatter,
    prompt_chars,
    unique_slug,
    validate_runbook,
)

logger = logging.getLogger("tlsoc.engine.runbook_migration")

#: The marker version this module writes.
MIGRATION_VERSION = 1
#: ``migrated_from.namespace`` / ``id_map`` prefixes of the three legacy sources.
NS_PROCEDURES = "playbooks"
NS_PROCEDURE_DIR = "playbook_dir"
NS_REFERENCE = "runbooks"
#: The legacy sources an automation rule could run before Round 14 (the procedure
#: documents, never the reference runbooks).
PROCEDURE_NAMESPACES: tuple[str, ...] = (NS_PROCEDURE_DIR, NS_PROCEDURES)
#: The retired directory reader's per-file bound.
MAX_DIRECTORY_FILE_BYTES = 256 * 1024
#: Focus lines the migration created are shortened in steps of this many characters,
#: down to :data:`FOCUS_FLOOR_CHARS`, until the investigator rendering fits (§4.10.17).
FOCUS_STEP_CHARS = 20
FOCUS_FLOOR_CHARS = 80
#: How many issues a Draft's audit row lists in full.
_AUDIT_ISSUES = 20

# Console-authored strings (SPEC §3.1: plain, sentence case, never the retired word).
NOTE_RESERVED = "Renamed because the id is reserved."
NOTE_SHADOWED = "This had the same id as a bundled procedure, so it was never used."
NOTE_BUILTIN_ID = "Renamed because a built-in runbook uses this id."
NOTE_BUNDLED_ID = "Renamed because a retired bundled procedure used this id."
NOTE_FOLDER_INERT = ("This was stored while a procedure folder was configured, so it was "
                     "never used.")
NOTE_REFERENCE = "Renamed because a converted procedure already uses this id."
NOTE_DUPLICATE = "Renamed because another converted document already uses this id."
NOTE_GRAMMAR = "Renamed to fit the runbook id rules."
NOTE_TECHNIQUES_COVERAGE = "Techniques are listed as coverage; they never decided a match."
NOTE_TAGS_LEFT_OUT = "Tags only matched rule names and never decided a match, so they were left out."
NOTE_SOFT_AS_RULES = ("The techniques and tags only matched rule names, so they are now rule "
                      "conditions.")
NOTE_SOFT_EXACT = ("The original ignored capital letters, but rule conditions match rule names "
                   "exactly, so check these against your rule names.")
NOTE_KEYWORDS_LEFT_OUT = "The keywords only helped search find this text, so they were left out."
NOTE_NO_CONDITIONS = ("The original matched every case. A runbook without conditions is attached "
                      "by hand, so add conditions to attach it automatically.")
NOTE_REFERENCE_NO_CONDITIONS = ("The original named no conditions and was only found by search. A "
                                "runbook without conditions is attached by hand, so add conditions "
                                "to attach it automatically.")
NOTE_CONDITIONS_LOST = ("The original's conditions could not be kept. A runbook without conditions "
                        "is attached by hand, so add conditions to attach it automatically.")
NOTE_WIDENED = ("A condition could not be kept, so this runbook would match more cases than the "
                "original did. It is a draft until someone checks its conditions and publishes it.")
NOTE_RULE_ANY_ENTITY = ("The entity types included 'rule', which meant any entity, so the entity "
                        "condition was removed.")
NOTE_RULE_ENTITY_LEFT_OUT = ("The entity type 'rule' (a case grouped by its rule alone) cannot be a "
                             "runbook condition, so it was left out.")
NOTE_RULE_ENTITY_NARROWED = ("The entity type 'rule' (a case grouped by its rule alone) cannot be a "
                             "runbook condition, so it was left out, and cases grouped by their rule "
                             "alone no longer match.")
NOTE_COUNT_UNREADABLE = "The minimum event count was not a whole number, so it was left out."
NOTE_COUNT_BELOW_ONE = "The minimum event count was below 1, which every case meets, so it was left out."
TITLE_SCOPE = "Scope and background"
TITLE_FOLLOW = "Follow the procedure"
TITLE_EVIDENCE = "Collect the required evidence"
TITLE_INVESTIGATE = "Investigate the signal"
TITLE_NEEDS_PERSON = "Does this need a person?"
TITLE_DECIDE = "Decide the outcome"
TITLE_NEXT_ACTION = "Take the recommended next action"
DECISION_OPTIONS: tuple[tuple[str, str], ...] = (
    ("confirmed", "Confirmed"),
    ("suspicious", "Suspicious"),
    ("benign", "Benign"),
)
ESCALATE_FULL = "Escalate if, in full:"
BENIGN_FULL = "Benign if, in full:"
LEADING_KEY_PREFIX = "Notes from the original procedure:"

#: The labelled sections of a legacy reference runbook (in their written order).
REFERENCE_LABELS: tuple[str, ...] = (
    "SIGNAL",
    "EVIDENCE REQUIRED",
    "INVESTIGATION STEPS",
    "TRUE POSITIVE SIGNALS",
    "FALSE POSITIVE SIGNALS",
    "NEEDS HUMAN WHEN",
    "RECOMMENDED NEXT ACTION",
    "LIMITATIONS",
)

_HEADING_RE = re.compile(r"^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$")
_EMPTY_HEADING_RE = re.compile(r"^ {0,3}(#{1,6})[ \t]*$")
_FENCE_RE = re.compile(r"^ {0,3}(```|~~~)")
_LIST_MARKER_RE = re.compile(r"^\s*(?:[-*+]|\d{1,9}[.)])\s+")
_STEP_NUMBER_RE = re.compile(r"^\s*(?:\d{1,3}[.)]|[-*+])\s+")
_KEY_LINE_RE = re.compile(r"^\s*(focus|escalate if|benign if|options)\s*:(\s|$)", re.I)
_WS_RE = re.compile(r"\s+")
_ID_CHARS_RE = re.compile(r"[^a-z0-9_-]+")
_OPERATOR_GRAMMAR_RE = re.compile(RUNBOOK_OPERATOR_ID_PATTERN)
_TECHNIQUE_RE = re.compile(r"^T\d{4}(?:\.\d{3})?$")
_PARAGRAPH_RE = re.compile(r"\n[ \t]*\n")

MigrationState = Literal["published", "draft"]
Projector = Callable[[str], Awaitable[bool]]


# --------------------------------------------------------------------------- #
# Small text helpers (pure).
# --------------------------------------------------------------------------- #
def _flatten(text: Any) -> str:
    """``text`` as one line: list markers at line starts dropped, whitespace
    collapsed (a focus, summary or title must be one line)."""
    lines = [_LIST_MARKER_RE.sub("", line) for line in str(text or "").splitlines()]
    return _WS_RE.sub(" ", " ".join(lines)).strip()


def _cut_words(text: str, limit: int) -> tuple[str, str]:
    """``(kept, rest)``: ``text`` cut at the last word boundary within ``limit``
    (hard when one word is longer)."""
    if len(text) <= limit:
        return text, ""
    space = text.rfind(" ", 0, limit + 1)
    cut = space if space > 0 else limit
    return text[:cut].rstrip(), text[cut:].lstrip()


def _block(text: Any) -> str:
    """Multi-line text with surrounding blank lines removed (line breaks kept)."""
    lines = str(text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    return "\n".join(line.rstrip() for line in lines)


def _as_list(value: Any) -> list[str]:
    """A front-matter value as a list of non-empty strings (scalars split on commas,
    the retired readers' rule)."""
    if value is None or value == "":
        return []
    if isinstance(value, (list, tuple)):
        items = [str(v).strip() for v in value]
    else:
        items = [part.strip() for part in str(value).split(",")]
    return [item for item in items if item]


def _as_int(value: Any) -> int | None:
    """``value`` as the retired manifest read an integer field (Pydantic's lax mode):
    an int, a bool (``True`` is 1), a float or numeric text with no fraction (``5.0``,
    ``"5"``, ``"5.0"``). Anything else is ``None`` (the retired reader refused it)."""
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value) if math.isfinite(value) and value.is_integer() else None
    text = str(value).strip() if value is not None else ""
    try:
        return int(text)
    except (TypeError, ValueError):
        pass
    try:
        number = float(text)
    except (TypeError, ValueError):
        return None
    return int(number) if math.isfinite(number) and number.is_integer() else None


def _split_paragraphs(text: str, limit: int) -> list[str]:
    """``text`` in parts of at most ``limit`` characters, cut at paragraph, then
    sentence, then word boundaries (the "(part n)" rule). Nothing is dropped."""
    text = _block(text)
    if len(text) <= limit:
        return [text] if text else []
    parts: list[str] = []
    current = ""
    for paragraph in (p.strip("\n") for p in _PARAGRAPH_RE.split(text)):
        if not paragraph.strip():
            continue
        pieces: list[str] = []
        rest = paragraph
        while len(rest) > limit:
            kept, rest = cut_text(rest, limit)
            if not kept:  # one very long word: hard cut
                kept, rest = rest[:limit], rest[limit:]
            pieces.append(kept)
        if rest:
            pieces.append(rest)
        for piece in pieces:
            joined = f"{current}\n\n{piece}" if current else piece
            if len(joined) <= limit:
                current = joined
            else:
                if current:
                    parts.append(current)
                current = piece
    if current:
        parts.append(current)
    return parts


# --------------------------------------------------------------------------- #
# The step builder.
# --------------------------------------------------------------------------- #
@dataclass
class _Builder:
    """Collects steps and import notes for one converted document."""

    notes: list[str] = field(default_factory=list)
    steps: list[RunbookStep] = field(default_factory=list)
    #: Step ids whose focus line the migration created (the budget rule shortens them).
    created_focus: dict[str, str] = field(default_factory=dict)
    #: Set when a match condition could not be kept and dropping it would make the
    #: runbook match more cases than the original (:func:`_criteria`): such a
    #: conversion is stored as a Draft, never Published, so text that guided fewer
    #: cases never becomes trusted guidance on more without a review (#9).
    force_draft: bool = False

    def note(self, text: str) -> None:
        if text not in self.notes:
            self.notes.append(text)

    def _step_id(self, title: str) -> str:
        return unique_slug(title, (s.id for s in self.steps), fallback="step")

    def add(
        self,
        *,
        phase: str,
        kind: str,
        title: str,
        instructions: str = "",
        focus: str | None = None,
        escalate_if: str | None = None,
        benign_if: str | None = None,
        options: list[DecisionOption] | None = None,
        what: str = "a step",
    ) -> None:
        """Add one step, applying the overflow rules of SPEC §4.10.17: a title over
        160 is cut at a word boundary (the full title becomes the first line of the
        instructions); a focus over 300 is cut at a sentence boundary; an escalate or
        benign line over 300 keeps its first 300 at a sentence boundary and the full
        text goes to the instructions under "Escalate if, in full:" / "Benign if, in
        full:"; instructions over 2,000 split into "(part n)" steps of the same kind
        and phase (only part 1 carries the focus and the guidance pair)."""
        full_title = _flatten(title) or TITLE_FOLLOW
        body_parts: list[str] = []
        short_title = full_title
        if len(full_title) > RUNBOOK_STEP_MAX_TITLE_CHARS:
            short_title, _ = _cut_words(full_title, RUNBOOK_STEP_MAX_TITLE_CHARS)
            body_parts.append(full_title)
            self.note(f"The title of the step '{short_title}' was shortened; the full title "
                      "is the first line of its instructions.")
        if instructions.strip():
            body_parts.append(_block(instructions))
        flat_focus = _flatten(focus) if focus else ""
        if len(flat_focus) > RUNBOOK_STEP_MAX_GUIDANCE_CHARS:
            flat_focus, _ = cut_text(flat_focus, RUNBOOK_STEP_MAX_GUIDANCE_CHARS)
        guidance: dict[str, str | None] = {"escalate_if": None, "benign_if": None}
        for name, value, header in (("escalate_if", escalate_if, ESCALATE_FULL),
                                    ("benign_if", benign_if, BENIGN_FULL)):
            flat = _flatten(value) if value else ""
            if not flat:
                continue
            if len(flat) > RUNBOOK_STEP_MAX_GUIDANCE_CHARS:
                kept, _ = cut_text(flat, RUNBOOK_STEP_MAX_GUIDANCE_CHARS)
                guidance[name] = kept
                body_parts.append(f"{header}\n\n{_block(value)}")
                label = "Escalate if" if name == "escalate_if" else "Benign if"
                self.note(f"The '{label}' line of the step '{short_title}' was shortened to "
                          f"{RUNBOOK_STEP_MAX_GUIDANCE_CHARS} characters; the full text is in "
                          "its instructions.")
            else:
                guidance[name] = flat
        body = "\n\n".join(p for p in body_parts if p)
        if body and _KEY_LINE_RE.match(body.split("\n", 1)[0]):
            body = f"{LEADING_KEY_PREFIX}\n\n{body}"
            self.note(f"A line was added before the instructions of the step '{short_title}' "
                      "so their first line is not read as a field.")
        parts = _split_paragraphs(body, RUNBOOK_STEP_MAX_INSTRUCTIONS_CHARS) or [""]
        if len(parts) > 1:
            self.note(f"The instructions of the step '{short_title}' were split into "
                      f"{len(parts)} steps of at most {RUNBOOK_STEP_MAX_INSTRUCTIONS_CHARS:,} "
                      "characters each.")
        for index, part in enumerate(parts, start=1):
            if len(parts) > 1:
                suffix = f" (part {index})"
                base, _ = _cut_words(short_title, RUNBOOK_STEP_MAX_TITLE_CHARS - len(suffix))
                step_title = f"{base}{suffix}"
            else:
                step_title = short_title
            first = index == 1
            step = RunbookStep(
                id=self._step_id(step_title),
                phase=phase,  # type: ignore[arg-type]
                kind=kind,  # type: ignore[arg-type]
                title=step_title,
                instructions=part,
                focus=(flat_focus or None) if first else None,
                escalate_if=guidance["escalate_if"] if first else None,
                benign_if=guidance["benign_if"] if first else None,
                options=list(options or []) if first else [],
            )
            if kind == "decision" and not first:
                # A continuation of a decision's text is a Check: a Decision needs its
                # options, and only the first part records the outcome.
                step = step.model_copy(update={"kind": "check"})
            self.steps.append(step)
            if first and flat_focus:
                self.created_focus[step.id] = flat_focus

    def decision(self, *, escalate_if: str | None, benign_if: str | None) -> None:
        self.add(
            phase="investigate", kind="decision", title=TITLE_DECIDE,
            escalate_if=escalate_if, benign_if=benign_if,
            options=[DecisionOption(id=oid, label=label) for oid, label in DECISION_OPTIONS],
        )


def _ordered(steps: list[RunbookStep]) -> list[RunbookStep]:
    """Steps grouped in phase order, keeping their order within a phase."""
    rank = {p: i for i, p in enumerate(PHASE_IDS)}
    return [s for _, s in sorted(enumerate(steps), key=lambda pair: (rank[pair[1].phase], pair[0]))]


# --------------------------------------------------------------------------- #
# Shared front-matter mapping.
# --------------------------------------------------------------------------- #
@dataclass
class _Header:
    title: str
    summary: str
    use_when: str
    prerequisites: str
    applies_when: AppliesWhen
    priority: int
    retrieval_queries: list[str]
    mitre: list[str] = field(default_factory=list)


def _bounded_list(
    values: list[str], *, max_items: int, max_chars: int, what: str, b: _Builder,
) -> list[str]:
    kept: list[str] = []
    for value in values:
        if len(value) > max_chars:
            b.note(f"The {what} '{value[:40]}' is longer than {max_chars} characters and was left out.")
            continue
        if value not in kept:
            kept.append(value)
    if len(kept) > max_items:
        b.note(f"Only the first {max_items} {what}s were kept ({len(kept)} were listed).")
        kept = kept[:max_items]
    return kept


def _coverage(techniques: list[str], b: _Builder) -> list[str]:
    """The ATT&CK technique ids of ``techniques`` (upper-cased, in order, at most
    :data:`RUNBOOK_APPLIES_MAX_MITRE`): a runbook's top-level ``mitre``, its coverage,
    which never decides a match. A value that is not a technique id is noted."""
    kept: list[str] = []
    for value in techniques:
        upper = value.strip().upper()
        if not _TECHNIQUE_RE.fullmatch(upper):
            b.note(f"'{value[:40]}' is not an ATT&CK technique id, so it was left out of the coverage.")
            continue
        if upper not in kept:
            kept.append(upper)
    return _bounded_list(kept, max_items=RUNBOOK_APPLIES_MAX_MITRE, max_chars=16, what="technique", b=b)


#: The kinds a case was grouped by before Round 14 besides ``rule`` (correlation's
#: per-source ladder). A list that named all of them and ``rule`` named every kind.
_LEGACY_PER_SOURCE_KINDS: frozenset[str] = frozenset({"ip", "user", "host"})
#: Retired entity type names a runbook condition spells differently.
_LEGACY_ENTITY_ALIASES: dict[str, str] = {"file_hash": "hash"}


def _entity_condition(listed_raw: list[str], b: _Builder) -> tuple[list[str], bool]:
    """``(entity_types, lost)`` for a legacy entity type list, mapped by meaning.

    ``rule`` is the kind of a case grouped by its rule alone (no address, account or
    host); a runbook condition cannot name it. A list that names it with every other
    kind (``ip``, ``user``, ``host``) meant any entity, so the condition is removed.
    Otherwise ``rule`` alone is left out and the other kinds are kept, which narrows
    the match (cases grouped by their rule alone no longer match) rather than widening
    it. ``file_hash`` is the runbook kind ``hash``; a kind a runbook cannot match is
    left out. ``lost`` is True when the list named kinds and none could be kept: the
    condition is gone, so a caller must not let the runbook match every entity
    silently (:func:`_criteria`)."""
    if not listed_raw:
        return [], False
    listed: list[str] = []
    for value in listed_raw:
        kind = value.strip().lower()
        kind = _LEGACY_ENTITY_ALIASES.get(kind, kind)
        if kind and kind not in listed:
            listed.append(kind)
    if "rule" in listed:
        if _LEGACY_PER_SOURCE_KINDS <= set(listed):
            # Every kind a case could be grouped by: the condition never excluded one
            # (the built-in library made the same choice).
            b.note(NOTE_RULE_ANY_ENTITY)
            return [], False
        listed = [kind for kind in listed if kind != "rule"]
        rule_note = NOTE_RULE_ENTITY_NARROWED
    else:
        rule_note = ""
    kept: list[str] = []
    for kind in listed:
        if kind in RUNBOOK_ENTITY_TYPES:
            kept.append(kind)
        else:
            b.note(f"The entity type '{kind[:40]}' is not one a runbook can match, so it was left out.")
    if rule_note:
        b.note(rule_note if kept else NOTE_RULE_ENTITY_LEFT_OUT)
    return kept, not kept


def _criteria(
    *, rule_ids: Any, entity_types: Any, mitre: Any, any_tags: Any, min_event_count: Any,
    b: _Builder, reference: bool = False,
) -> tuple[AppliesWhen, list[str]]:
    """``(applies_when, coverage)`` for a legacy document's match criteria, mapped BY
    MEANING (the retired matchers, not the field names).

    The retired procedure matcher (``app/playbooks/registry.py``) treated rule ids,
    entity types and the minimum event count as hard criteria, and techniques and tags
    as ADVISORY: compared only with the cluster's rule names, they never excluded a
    rule, entity or count match, and a document with only those matched only a rule
    named like one of them. A declared count below 1 was still a hard criterion that
    every cluster met, so a document with it matched every case. The runbook matcher
    treats ``mitre`` and ``any_tags`` as hard criteria checked against the case's
    techniques and analyst tags, so mapping them by name would keep a converted
    runbook from ever attaching after the verdict (cases carry no tags) or before it
    (techniques are not known yet). So:

    * with a hard criterion, the hard criteria become ``applies_when``; techniques
      become coverage (top-level ``mitre``) and tags are left out, each noted;
    * with only techniques and tags, they become ``applies_when.rule_ids`` (what they
      were compared with), and the techniques are also kept as coverage. The retired
      matcher ignored capital letters there and a rule condition matches exactly, so
      that narrowing is noted too.

    A retired reference runbook (``reference=True``) was retrieval knowledge and never
    matched; its rules and entity types become ``applies_when``. Its techniques are
    coverage when rules or entity types are present, else ``applies_when.mitre``; its
    keywords only helped search find it, so they are left out (noted).

    A value that cannot be kept (a rule over 256 characters, an entity kind a runbook
    cannot match, a count that is not a whole number) is left out and noted. When that
    removes a whole condition while another remains, the runbook would match MORE
    cases than the original, so the conversion is forced to a Draft
    (:attr:`_Builder.force_draft`, :data:`NOTE_WIDENED`): a dropped criterion never
    widens the match of trusted guidance. A runbook left with no condition at all says
    why it is attached by hand (:data:`NOTE_NO_CONDITIONS`,
    :data:`NOTE_REFERENCE_NO_CONDITIONS` or :data:`NOTE_CONDITIONS_LOST`)."""
    raw_rules = _as_list(rule_ids)
    raw_entities = _as_list(entity_types)
    raw_techniques = _as_list(mitre)
    raw_tags = _as_list(any_tags)
    # The conditions that named something and kept nothing.
    lost: list[str] = []
    rules = _bounded_list(raw_rules, max_items=RUNBOOK_APPLIES_MAX_RULES,
                          max_chars=RUNBOOK_APPLIES_MAX_RULE_CHARS, what="rule", b=b)
    if raw_rules and not rules:
        lost.append("rule_ids")
    entities, entities_lost = _entity_condition(raw_entities, b)
    if entities_lost:
        lost.append("entity_types")
    count: int | None = None
    count_declared = min_event_count not in (None, "")
    if count_declared:
        parsed = _as_int(min_event_count)
        if parsed is None:
            b.note(NOTE_COUNT_UNREADABLE)
            lost.append("min_event_count")
        elif parsed < 1:
            b.note(NOTE_COUNT_BELOW_ONE)
        else:
            count = min(parsed, 1_000_000)
    techniques: list[str] = []
    coverage = _coverage(raw_techniques, b) if raw_techniques else []
    if reference:
        if raw_tags:
            b.note(NOTE_KEYWORDS_LEFT_OUT)
        if raw_rules or raw_entities:
            if coverage:
                b.note(NOTE_TECHNIQUES_COVERAGE)
        else:
            techniques = list(coverage)
            if raw_techniques and not techniques:
                lost.append("mitre")
    else:
        hard = bool(raw_rules or raw_entities) or count_declared
        if hard:
            if coverage:
                b.note(NOTE_TECHNIQUES_COVERAGE)
            if raw_tags:
                b.note(NOTE_TAGS_LEFT_OUT)
        elif raw_techniques or raw_tags:
            soft = [*raw_techniques, *raw_tags]
            rules = _bounded_list(soft, max_items=RUNBOOK_APPLIES_MAX_RULES,
                                  max_chars=RUNBOOK_APPLIES_MAX_RULE_CHARS, what="rule", b=b)
            b.note(NOTE_SOFT_AS_RULES)
            # The retired matcher compared these case-insensitively; a rule condition
            # is compared exactly and cannot say otherwise, so the narrowing is noted.
            b.note(NOTE_SOFT_EXACT)
            if not rules:
                lost.append("rule_ids")
    applies = AppliesWhen(rule_ids=rules, mitre=techniques, entity_types=entities,  # type: ignore[arg-type]
                          min_event_count=count)
    has_condition = bool(rules or techniques or entities or count is not None)
    if lost and has_condition:
        b.force_draft = True
        b.note(NOTE_WIDENED)
    elif not has_condition:
        if lost:
            b.note(NOTE_CONDITIONS_LOST)
        else:
            b.note(NOTE_REFERENCE_NO_CONDITIONS if reference else NOTE_NO_CONDITIONS)
    return applies, coverage


def _place_text(header_summary: str, header_use_when: str, b: _Builder) -> tuple[str, str, str]:
    """Apply the summary and use-when overflow rules: a summary over 280 is cut at
    the last word boundary and the rest prepended to use-when; a use-when over 500
    keeps its first 500 at a sentence boundary and the rest goes to the Triage Check
    "Scope and background". Returns ``(summary, use_when, scope_overflow)``."""
    summary = _flatten(header_summary)
    use_when = _block(header_use_when)
    if len(summary) > RUNBOOK_MAX_SUMMARY_CHARS:
        summary, rest = _cut_words(summary, RUNBOOK_MAX_SUMMARY_CHARS)
        use_when = f"{rest}\n\n{use_when}".strip() if use_when else rest
        b.note(f"The summary was shortened to {RUNBOOK_MAX_SUMMARY_CHARS} characters; the rest "
               "starts the 'Use when' text.")
    scope = ""
    if len(use_when) > RUNBOOK_MAX_USE_WHEN_CHARS:
        use_when, scope = cut_text(use_when, RUNBOOK_MAX_USE_WHEN_CHARS)
        b.note(f"The 'Use when' text was shortened to {RUNBOOK_MAX_USE_WHEN_CHARS} characters; "
               f"the rest is in the step '{TITLE_SCOPE}'.")
    return summary, use_when, scope


def _finish(
    *, runbook_id: str, header: _Header, b: _Builder,
) -> RunbookDefinition:
    """Assemble the definition, then apply the budget rule: when the investigator
    rendering is over 3,000 characters, every focus line the migration created is
    shortened to the same maximum at a word boundary, in 20-character steps down to
    80, until it fits."""
    steps = _ordered(b.steps)
    phases = [p for p in PHASE_IDS if any(s.phase == p for s in steps)]
    defn = RunbookDefinition(
        id=runbook_id,
        title=header.title,
        summary=header.summary,
        use_when=header.use_when,
        prerequisites=header.prerequisites,
        applies_when=header.applies_when,
        priority=header.priority,
        mitre=header.mitre,
        phases=phases,  # type: ignore[arg-type]
        steps=steps,
        retrieval_queries=header.retrieval_queries,
    )
    if prompt_chars(defn, 1) <= MAX_RUNBOOK_PROMPT_CHARS or not b.created_focus:
        return normalise_definition(defn)
    limit = RUNBOOK_STEP_MAX_GUIDANCE_CHARS - FOCUS_STEP_CHARS
    while limit >= FOCUS_FLOOR_CHARS:
        shortened = [
            s.model_copy(update={"focus": _cut_words(b.created_focus[s.id], limit)[0]})
            if s.id in b.created_focus else s
            for s in steps
        ]
        candidate = defn.model_copy(update={"steps": shortened})
        if prompt_chars(candidate, 1) <= MAX_RUNBOOK_PROMPT_CHARS:
            b.note(f"Focus lines were shortened to {limit} characters so the investigator "
                   f"guidance fits its {MAX_RUNBOOK_PROMPT_CHARS:,}-character budget.")
            return normalise_definition(candidate)
        limit -= FOCUS_STEP_CHARS
    floor = [
        s.model_copy(update={"focus": _cut_words(b.created_focus[s.id], FOCUS_FLOOR_CHARS)[0]})
        if s.id in b.created_focus else s
        for s in steps
    ]
    b.note(f"Focus lines were shortened to {FOCUS_FLOOR_CHARS} characters, and the investigator "
           "guidance is still over its budget.")
    return normalise_definition(defn.model_copy(update={"steps": floor}))


def _header_text(meta: dict[str, Any], *, title_keys: Iterable[str], fallback: str, b: _Builder) -> str:
    title = ""
    for key in title_keys:
        value = meta.get(key)
        if isinstance(value, str) and value.strip():
            title = _flatten(value)
            break
    title = title or fallback
    if len(title) > RUNBOOK_MAX_TITLE_CHARS:
        short, _ = _cut_words(title, RUNBOOK_MAX_TITLE_CHARS)
        b.note(f"The title was shortened to {RUNBOOK_MAX_TITLE_CHARS} characters; the full title "
               "starts the 'Use when' text.")
        return short
    return title


# --------------------------------------------------------------------------- #
# Conversions (pure).
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Conversion:
    """A converted document: the definition, every overflow move, and whether a
    match condition that could not be kept forces it to a Draft
    (:attr:`_Builder.force_draft`)."""

    definition: RunbookDefinition
    notes: tuple[str, ...]
    force_draft: bool = False


def _sections(body: str, b: _Builder) -> list[tuple[str | None, str]]:
    """``(heading, text)`` for each heading of level 1 to 3 in ``body`` (text before
    the first heading has no heading). A heading of level 4 to 6 inside a section
    becomes a bold line, since step instructions hold no headings. Fenced code is
    never split."""
    sections: list[tuple[str | None, list[str]]] = [(None, [])]
    in_fence = False
    demoted = False
    for line in body.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if _FENCE_RE.match(line):
            in_fence = not in_fence
            sections[-1][1].append(line)
            continue
        if not in_fence:
            match = _HEADING_RE.match(line) or _EMPTY_HEADING_RE.match(line)
            if match is not None:
                level = len(match.group(1))
                text = match.group(2).strip() if match.lastindex and match.lastindex >= 2 else ""
                if level <= 3:
                    sections.append((text, []))
                    continue
                if text:
                    sections[-1][1].append(f"**{text}**")
                    demoted = True
                    continue
        sections[-1][1].append(line)
    if demoted:
        b.note("Sub-headings inside a section became bold lines.")
    out = [(heading, _block("\n".join(lines))) for heading, lines in sections]
    return [(h, t) for h, t in out if h is not None or t.strip()]


def convert_procedure_document(
    content: str, *, runbook_id: str, fallback_title: str,
) -> Conversion:
    """Convert a retired procedure document (Markdown with front matter) into a
    runbook definition (SPEC §4.10.17 step 3):

    ``name`` → title, ``description`` → summary, the ``match`` block (nested or flat)
    → ``applies_when`` by meaning (:func:`_criteria`: rule ids, entity types and the
    minimum event count; advisory techniques become coverage), ``priority`` kept,
    ``rag_queries`` → retrieval queries. Each ``##`` or
    ``###`` section becomes an Investigate Check (title the heading, focus the
    section's guidance up to 300 characters, instructions the full text); a body
    without headings becomes one Check "Follow the procedure". A Decision "Decide the
    outcome" (Confirmed, Suspicious, Benign) carries ``escalate_if``.
    ``suggested_verdict_bias`` and ``suggested_tools`` are dropped (noted)."""
    b = _Builder()
    meta, body = parse_frontmatter(content)
    meta = dict(meta) if isinstance(meta, dict) else {}
    raw_match = meta.get("match")
    match: dict[str, Any] = dict(raw_match) if isinstance(raw_match, dict) else {}
    for key in ("rule_ids", "entity_types", "mitre", "min_event_count", "any_tags"):
        if key in meta:
            match[key] = meta[key]
    title = _header_text(meta, title_keys=("name", "title"), fallback=fallback_title, b=b)
    full_title = _flatten(meta.get("name") or meta.get("title") or "")
    applies, coverage = _criteria(
        rule_ids=match.get("rule_ids"), entity_types=match.get("entity_types"),
        mitre=match.get("mitre"), any_tags=match.get("any_tags"),
        min_event_count=match.get("min_event_count"), b=b,
    )
    description = _flatten(meta.get("description") or "")
    sections = _sections(body, b)
    if not description:
        first_text = next((t for _, t in sections if t.strip()), "")
        description = _flatten(cut_text(_flatten(first_text), RUNBOOK_MAX_SUMMARY_CHARS)[0]) or title
    use_when = full_title if len(full_title) > RUNBOOK_MAX_TITLE_CHARS else ""
    summary, use_when, scope = _place_text(description, use_when, b)
    priority = _as_int(meta.get("priority"))
    if priority is None:
        priority = 0
    if not 0 <= priority <= 100:
        clamped = max(0, min(100, priority))
        b.note(f"The priority {priority} was outside 0 to 100 and is now {clamped}.")
        priority = clamped
    queries = []
    for query in _as_list(meta.get("rag_queries")):
        flat = _flatten(query)
        if len(flat) > RUNBOOK_MAX_RETRIEVAL_QUERY_CHARS:
            flat, _ = _cut_words(flat, RUNBOOK_MAX_RETRIEVAL_QUERY_CHARS)
            b.note(f"A retrieval query was shortened to {RUNBOOK_MAX_RETRIEVAL_QUERY_CHARS} characters.")
        if flat and flat not in queries:
            queries.append(flat)
    if len(queries) > RUNBOOK_MAX_RETRIEVAL_QUERIES:
        b.note(f"Only the first {RUNBOOK_MAX_RETRIEVAL_QUERIES} retrieval queries were kept "
               f"({len(queries)} were listed).")
        queries = queries[:RUNBOOK_MAX_RETRIEVAL_QUERIES]
    if meta.get("suggested_verdict_bias"):
        b.note("The suggested verdict bias was dropped; the verdict is the investigation's alone.")
    if meta.get("suggested_tools"):
        b.note("The suggested tools list was dropped; it never had an effect.")
    if scope:
        b.add(phase="triage", kind="check", title=TITLE_SCOPE, instructions=scope)
    if any(heading is not None for heading, _ in sections):
        for heading, text in sections:
            b.add(phase="investigate", kind="check", title=heading or TITLE_FOLLOW,
                  instructions=text, focus=text or None)
    else:
        text = sections[0][1] if sections else ""
        b.add(phase="investigate", kind="check", title=TITLE_FOLLOW, instructions=text, focus=text or None)
    b.decision(escalate_if=str(meta.get("escalate_if") or "") or None, benign_if=None)
    header = _Header(title=title, summary=summary, use_when=use_when, prerequisites="",
                     applies_when=applies, priority=priority, retrieval_queries=queries,
                     mitre=coverage)
    return Conversion(definition=_finish(runbook_id=runbook_id, header=header, b=b), notes=tuple(b.notes),
                      force_draft=b.force_draft)


def _labelled_sections(body: str) -> tuple[dict[str, str], str]:
    """The labelled sections of a retired reference runbook and any text before the
    first label. A label is a line holding exactly one of :data:`REFERENCE_LABELS`."""
    found: dict[str, list[str]] = {}
    preamble: list[str] = []
    current: list[str] | None = None
    for line in body.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        label = line.strip().rstrip(":").upper() if line.strip() else ""
        if label in REFERENCE_LABELS and line.strip().rstrip(":").isupper():
            current = found.setdefault(label, [])
            continue
        (current if current is not None else preamble).append(line)
    return {k: _block("\n".join(v)) for k, v in found.items()}, _block("\n".join(preamble))


def convert_reference_document(
    content: str, *, runbook_id: str, fallback_title: str,
) -> Conversion:
    """Convert a retired plain-text reference runbook (SPEC §4.10.17 step 3):

    SIGNAL → the summary (when the front matter has none) and ``use_when``; EVIDENCE
    REQUIRED → a Triage Check "Collect the required evidence"; each line of
    INVESTIGATION STEPS → an Investigate Check (the line is its title, and its focus
    when longer than the 160-character title); TRUE POSITIVE and FALSE POSITIVE
    SIGNALS → the Decision's ``escalate_if`` and ``benign_if``; NEEDS HUMAN WHEN → a
    Check "Does this need a person?" with ``escalate_if``; RECOMMENDED NEXT ACTION → a
    Contain Action; LIMITATIONS → appended to ``use_when`` as "Limits: ...";
    ``applies_to_rules`` and ``applies_to_entities`` → ``applies_when``;
    ``applies_to_techniques`` → coverage (or ``applies_when.mitre`` when the runbook
    names no rule or entity type); ``keywords`` left out (:func:`_criteria`). A body
    without any label is converted like a procedure body (headings, else one
    Check)."""
    b = _Builder()
    meta, body = parse_frontmatter(content)
    meta = dict(meta) if isinstance(meta, dict) else {}
    title = _header_text(meta, title_keys=("title", "name"), fallback=fallback_title, b=b)
    full_title = _flatten(meta.get("title") or meta.get("name") or "")
    applies, coverage = _criteria(
        rule_ids=meta.get("applies_to_rules"), entity_types=meta.get("applies_to_entities"),
        mitre=meta.get("applies_to_techniques"), any_tags=meta.get("keywords"),
        min_event_count=None, b=b, reference=True,
    )
    if meta.get("persona"):
        b.note("The persona was dropped; the investigator chooses its own.")
    sections, preamble = _labelled_sections(body)
    signal = sections.get("SIGNAL", "")
    fm_summary = _flatten(meta.get("summary") or "")
    use_when_parts: list[str] = []
    if len(full_title) > RUNBOOK_MAX_TITLE_CHARS:
        use_when_parts.append(full_title)
    if fm_summary:
        summary_source = fm_summary
        if signal:
            use_when_parts.append(signal)
    else:
        summary_source = _flatten(signal) or title
    if sections.get("LIMITATIONS"):
        use_when_parts.append(f"Limits: {_block(sections['LIMITATIONS'])}")
    summary, use_when, scope = _place_text(summary_source, "\n\n".join(use_when_parts), b)
    # Text before the first label (only when there are labels: a body without any is
    # converted section by section below) joins the use-when overflow.
    scope_text = "\n\n".join(p for p in (scope, preamble if sections else "") if p.strip())
    if scope_text:
        b.add(phase="triage", kind="check", title=TITLE_SCOPE, instructions=scope_text)
    if not sections:
        for heading, text in _sections(body, b):
            b.add(phase="investigate", kind="check", title=heading or TITLE_FOLLOW,
                  instructions=text, focus=text or None)
        b.decision(escalate_if=None, benign_if=None)
    else:
        evidence = sections.get("EVIDENCE REQUIRED", "")
        if evidence:
            b.add(phase="triage", kind="check", title=TITLE_EVIDENCE, instructions=evidence, focus=evidence)
        for line in (sections.get("INVESTIGATION STEPS", "") or "").split("\n"):
            item = _flatten(_STEP_NUMBER_RE.sub("", line))
            if not item:
                continue
            if len(item) > RUNBOOK_STEP_MAX_TITLE_CHARS:
                b.add(phase="investigate", kind="check", title=item, focus=item)
            else:
                b.add(phase="investigate", kind="check", title=item)
        needs = sections.get("NEEDS HUMAN WHEN", "")
        if needs:
            b.add(phase="investigate", kind="check", title=TITLE_NEEDS_PERSON, escalate_if=needs)
        b.decision(
            escalate_if=sections.get("TRUE POSITIVE SIGNALS") or None,
            benign_if=sections.get("FALSE POSITIVE SIGNALS") or None,
        )
        action = sections.get("RECOMMENDED NEXT ACTION", "")
        if action:
            flat = _flatten(action)
            if len(flat) <= RUNBOOK_STEP_MAX_TITLE_CHARS:
                b.add(phase="contain", kind="action", title=flat)
            else:
                b.add(phase="contain", kind="action", title=TITLE_NEXT_ACTION, instructions=action)
        if not any(s.phase == "investigate" and s.kind == "check" for s in b.steps) and not evidence:
            # A reference runbook with only the outcome signals still gets one Check
            # so the investigator rendering names what to look at.
            b.add(phase="investigate", kind="check", title=TITLE_INVESTIGATE, focus=signal or None)
    header = _Header(title=title, summary=summary, use_when=use_when, prerequisites="",
                     applies_when=applies, priority=50, retrieval_queries=[], mitre=coverage)
    return Conversion(definition=_finish(runbook_id=runbook_id, header=header, b=b), notes=tuple(b.notes),
                      force_draft=b.force_draft)


# --------------------------------------------------------------------------- #
# Ids (pure).
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class IdPlan:
    """The id a legacy document gets, why, and whether it is forced to a Draft
    (``shadowed``: it was never used before the upgrade, so its text must not become
    trusted without a review)."""

    runbook_id: str
    notes: tuple[str, ...] = ()
    shadowed: bool = False


def _operator_id(legacy_id: str) -> tuple[str, bool]:
    """``legacy_id`` in the operator grammar (``True`` when it had to change). A
    reserved id fits the grammar and keeps its spelling here; :func:`plan_id` renames
    it with its own note."""
    if _OPERATOR_GRAMMAR_RE.fullmatch(legacy_id):
        return legacy_id, False
    text = _ID_CHARS_RE.sub("-", legacy_id.strip().lower()).strip("-_")
    text = re.sub(r"^[^a-z0-9]+", "", text)[:64].rstrip("-_") or "imported"
    return text, True


#: The stored ids a bundled document of the SAME kind owned before Round 14, so the
#: stored document was never used: the retired procedure registry let a bundled
#: procedure win its id, and the retired reference catalog ignored an operator
#: runbook whose id a bundled reference runbook owned. Both compared ids exactly, and
#: neither consulted the other kind's bundled set.
SHADOWED_BEFORE: dict[str, frozenset[str]] = {
    NS_PROCEDURES: LEGACY_BUNDLED_PLAYBOOK_IDS,
    NS_REFERENCE: frozenset(LEGACY_BUNDLED_RUNBOOK_MAP) - LEGACY_BUNDLED_PLAYBOOK_IDS,
}


def plan_id(
    namespace: str, legacy_id: str, *, taken: set[str], procedure_ids: set[str],
    folder_configured: bool = False,
) -> IdPlan:
    """The new id of one legacy document (SPEC §4.10.17 step 3), unique against
    ``taken``, and whether it was live before the upgrade.

    Which procedures were live depended on ``Preferences.playbooks.dir``
    (``folder_configured``). Without a folder the bundled set and the stored documents
    were read, a bundled document winning an id collision; with one, ONLY the folder's
    files were read (the bundled set and the stored documents never were):

    * an operator id keeps its spelling when it fits the operator grammar, and a
      reserved id becomes ``<id>-imported`` ("Renamed because the id is reserved.");
    * an id in the union of the 18 legacy bundled ids and the 12 built-in ids
      (:data:`SHADOWING_IDS`) is renamed ``<id>-imported`` in every case (the built-in
      owns it, or the legacy maps send it to a built-in);
    * the shadow rule: a stored document whose exact id a bundled document of its own
      kind owned (:data:`SHADOWED_BEFORE`) was never used, so it is also forced to a
      Draft ("This had the same id as a bundled procedure, so it was never used.");
    * any other renamed collision was live (a stored procedure named like a bundled
      reference runbook or a new built-in, or a folder file), so it keeps its
      validated state, with the note that says which id it met;
    * a folder: every stored procedure document was never read, so it is forced to a
      Draft (and renamed the same way);
    * a reference runbook whose id equals a converted procedure's becomes
      ``<id>-reference``;
    * any other collision gets ``-imported``, then ``-2``, ``-3``.

    Every suffix is fitted by shortening the base so the id stays at most 64
    characters. (SPEC §4.10.17 forces the whole union to a Draft; only an id that a
    bundled document of the same kind owned was never used, so only that one is, and
    the note never claims "never used" for a document that was live.)"""
    notes: list[str] = []
    base, changed = _operator_id(legacy_id)
    if changed:
        notes.append(NOTE_GRAMMAR)
    collides = legacy_id in SHADOWING_IDS or base in SHADOWING_IDS
    builtin = legacy_id in BUILTIN_RUNBOOK_IDS or base in BUILTIN_RUNBOOK_IDS
    inert = folder_configured and namespace == NS_PROCEDURES
    if inert:
        notes.append(NOTE_FOLDER_INERT)
    shadowed = inert
    was_shadowed = not inert and legacy_id in SHADOWED_BEFORE.get(namespace, frozenset())
    if collides and was_shadowed:
        candidate = fit_id(base, "-imported")
        notes.append(NOTE_SHADOWED)
        shadowed = True
    elif collides:
        candidate = fit_id(base, "-imported")
        notes.append(NOTE_BUILTIN_ID if builtin else NOTE_BUNDLED_ID)
    elif base in RUNBOOK_RESERVED_IDS:
        candidate = fit_id(base, "-imported")
        notes.append(NOTE_RESERVED)
    elif namespace == NS_REFERENCE and base in procedure_ids:
        candidate = fit_id(base, "-reference")
        notes.append(NOTE_REFERENCE)
    else:
        candidate = base
    if candidate in taken:
        if candidate == base:
            suffix = "-reference" if namespace == NS_REFERENCE else "-imported"
            notes.append(NOTE_REFERENCE if namespace == NS_REFERENCE else NOTE_DUPLICATE)
        else:
            suffix = "-reference" if candidate.endswith("-reference") else "-imported"
        n = 1
        while candidate in taken:
            candidate = fit_id(base, suffix if n == 1 else f"{suffix}-{n}")
            n += 1
    return IdPlan(runbook_id=candidate, notes=tuple(notes), shadowed=shadowed)


def migrated_procedure_ids(marker: RunbookMigrationMarker | dict[str, Any] | None) -> dict[str, str]:
    """``legacy procedure id -> runbook id`` from a migration marker's ``id_map``,
    for the procedure sources only (the configured directory first, then the stored
    procedure documents; never the reference runbooks, which a rule never ran).
    What ``runbook_model.resolve_automation_runbook_id`` takes as
    ``migrated_playbooks``; empty before the migration.

    A stored procedure document with a retired bundled procedure's id
    (:data:`LEGACY_BUNDLED_PLAYBOOK_IDS`) never ran from a rule: without a folder the
    bundled document won the id, and with one the stored documents were never read.
    So it is left out, and a retired bundled id is in the result only when a
    configured folder's file held it, which was the live procedure a rule naming
    that id ran."""
    if marker is None:
        return {}
    id_map = marker.id_map if isinstance(marker, RunbookMigrationMarker) else marker.get("id_map")
    if not isinstance(id_map, dict):
        return {}
    out: dict[str, str] = {}
    for namespace in PROCEDURE_NAMESPACES:
        prefix = f"{namespace}:"
        for key, value in id_map.items():
            if not (isinstance(key, str) and key.startswith(prefix) and isinstance(value, str)):
                continue
            legacy_id = key[len(prefix):]
            if namespace == NS_PROCEDURES and legacy_id in LEGACY_BUNDLED_PLAYBOOK_IDS:
                continue
            out.setdefault(legacy_id, value)
    return out


# --------------------------------------------------------------------------- #
# Reading the sources.
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class SourceDocument:
    """One legacy document to convert."""

    namespace: str
    legacy_id: str
    content: str
    revision: int | None = None
    author: str = ""


@dataclass(frozen=True)
class SkippedDocument:
    """A legacy document (or, with ``whole_source``, a whole legacy source such as a
    configured procedure folder that is missing) the migration could not convert."""

    namespace: str
    legacy_id: str
    reason: str
    whole_source: bool = False


@dataclass
class _Sources:
    documents: list[SourceDocument] = field(default_factory=list)
    skipped: list[SkippedDocument] = field(default_factory=list)
    summary: list[dict[str, Any]] = field(default_factory=list)


def packaged_procedure_dir() -> Path:
    """The retired packaged procedure directory (``backend/playbooks``): never a
    migration source, its documents became the built-in library."""
    return Path(__file__).resolve().parent.parent.parent / "playbooks"


def _configured_dir(prefs: Any) -> Path | None:
    section = getattr(prefs, "playbooks", None)
    raw = getattr(section, "dir", None) if section is not None else None
    if not isinstance(raw, str) or not raw.strip():
        return None
    path = Path(raw.strip()).expanduser()
    try:
        if path.resolve(strict=False) == packaged_procedure_dir().resolve(strict=False):
            return None
    except (OSError, RuntimeError):
        return path
    return path


#: The reasons a configured procedure folder could not be read (one audited
#: ``runbook.migration_skipped`` row each; the marker is still written, so it is read
#: once).
FOLDER_MISSING = "The configured procedure folder does not exist, so its files were not converted."
FOLDER_UNREADABLE = "The configured procedure folder could not be read, so its files were not converted."


def _read_directory(path: Path) -> tuple[list[SourceDocument], list[SkippedDocument], dict[str, Any]]:
    docs: list[SourceDocument] = []
    skipped: list[SkippedDocument] = []
    info: dict[str, Any] = {"namespace": NS_PROCEDURE_DIR, "path": str(path)}
    label = str(path)[:200]
    try:
        if not path.is_dir():
            info.update(status="missing", documents=0)
            skipped.append(SkippedDocument(NS_PROCEDURE_DIR, label, FOLDER_MISSING, whole_source=True))
            return docs, skipped, info
        files = sorted(p for p in path.glob("*.md") if p.is_file())
    except OSError as exc:
        info.update(status="unreadable", documents=0, reason=type(exc).__name__)
        skipped.append(SkippedDocument(NS_PROCEDURE_DIR, label, FOLDER_UNREADABLE, whole_source=True))
        return docs, skipped, info
    for file in files:
        if file.stem.lower() in {"readme", "index"}:
            continue
        try:
            size = file.stat().st_size
            if size > MAX_DIRECTORY_FILE_BYTES:
                skipped.append(SkippedDocument(NS_PROCEDURE_DIR, file.stem,
                                               "The file is larger than 256 KiB."))
                continue
            text = file.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            skipped.append(SkippedDocument(NS_PROCEDURE_DIR, file.stem,
                                           f"The file could not be read ({type(exc).__name__})."))
            continue
        if not text.strip():
            skipped.append(SkippedDocument(NS_PROCEDURE_DIR, file.stem, "The file is empty."))
            continue
        meta, _ = parse_frontmatter(text)
        raw_id = meta.get("id") if isinstance(meta, dict) else None
        legacy_id = str(raw_id).strip() if isinstance(raw_id, str) and raw_id.strip() else file.stem
        docs.append(SourceDocument(NS_PROCEDURE_DIR, legacy_id, text, None, ""))
    info.update(status="read", documents=len(docs), skipped=len(skipped))
    return docs, skipped, info


async def _read_sources(reader: LegacyProcedureReader, prefs: Any) -> _Sources:
    out = _Sources()
    directory = _configured_dir(prefs)
    if directory is not None:
        docs, skipped, info = _read_directory(directory)
        out.documents += docs
        out.skipped += skipped
        out.summary.append(info)
    for namespace in (NS_PROCEDURES, NS_REFERENCE):
        scan = await reader.scan(namespace)
        for doc in scan.documents:
            out.documents.append(_from_legacy(doc))
        for damage in scan.damaged:
            out.skipped.append(SkippedDocument(namespace, damage.id, damage.reason))
        out.summary.append({
            "namespace": namespace,
            "status": "read" if scan.present else "absent",
            "documents": len(scan.documents),
            "skipped": len(scan.damaged),
        })
    return out


def _from_legacy(doc: LegacyDocument) -> SourceDocument:
    return SourceDocument(
        namespace=doc.namespace, legacy_id=doc.id, content=doc.content,
        revision=doc.revision, author=doc.updated_by or doc.created_by,
    )


# --------------------------------------------------------------------------- #
# Converting one document into a stored runbook.
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class MigratedDocument:
    """One converted document, ready to store."""

    source: SourceDocument
    runbook: StoredRunbook
    state: MigrationState
    issues: tuple[RunbookIssue, ...]
    notes: tuple[str, ...]


def convert_source(
    source: SourceDocument, plan: IdPlan, *, now: str,
) -> MigratedDocument:
    """Convert, validate and wrap one legacy document as a :class:`StoredRunbook`
    with one version: Published when it validates, the shadow rule does not apply and
    no dropped condition would widen its match (:func:`_criteria`), else a Draft with
    its issues in ``import_notes`` (SPEC §4.10.17 step 4). Imported content is due for
    review at once (D38)."""
    fallback = source.legacy_id
    if source.namespace == NS_REFERENCE:
        conversion = convert_reference_document(source.content, runbook_id=plan.runbook_id,
                                                fallback_title=fallback)
    else:
        conversion = convert_procedure_document(source.content, runbook_id=plan.runbook_id,
                                                fallback_title=fallback)
    defn = conversion.definition
    issues = tuple(validate_runbook(defn, origin="imported", version=1))
    notes = [*plan.notes, *conversion.notes]
    state: MigrationState = (
        "draft" if (issues or plan.shadowed or conversion.force_draft) else "published"
    )
    import_notes = list(notes) + [f"Problem to fix: {issue.message}" for issue in issues]
    author = source.author or RUNBOOK_MIGRATION_ACTOR
    version = RunbookVersionDoc(
        version=1,
        state=state,
        definition=defn,
        source=export_runbook_markdown(defn, version=1),
        content_hash=content_hash(defn),
        author=author,
        created_at=now,
        published_by=RUNBOOK_MIGRATION_ACTOR if state == "published" else None,
        published_at=now if state == "published" else None,
        import_notes=import_notes,
        prompt_chars=prompt_chars(defn, 1),
    )
    stored = StoredRunbook(
        id=plan.runbook_id,
        origin="imported",
        versions=[version],
        review_due_at=now,
        migrated_from=RunbookMigratedFrom(
            namespace=source.namespace, id=source.legacy_id, revision=source.revision,
        ),
        created_at=now,
        created_by=RUNBOOK_MIGRATION_ACTOR,
        updated_at=now,
        updated_by=RUNBOOK_MIGRATION_ACTOR,
    )
    return MigratedDocument(source=source, runbook=stored, state=state, issues=issues,
                            notes=tuple(notes))


# --------------------------------------------------------------------------- #
# The run.
# --------------------------------------------------------------------------- #
@dataclass
class MigrationOutcome:
    """What one call did (for the startup log and tests)."""

    status: Literal["done", "already_done", "projection_resumed", "projection_pending"]
    published: int = 0
    draft: int = 0
    skipped: int = 0
    migrated_now: int = 0
    id_map: dict[str, str] = field(default_factory=dict)
    projection_completed: bool = False


#: How an audit summary names each source (plain words, never the retired feature
#: name; the namespace itself stays in ``tool_input``).
_SOURCE_LABELS: dict[str, str] = {
    NS_PROCEDURES: "the stored procedure",
    NS_PROCEDURE_DIR: "the procedure file",
    NS_REFERENCE: "the reference runbook",
}


def _source_label(namespace: str) -> str:
    return _SOURCE_LABELS.get(namespace, "the document")


#: The migration's audit actions (actor ``runbook_migration``, sink ``control_audit``):
#: one ``runbook.migrated`` per converted document, appended before its library
#: write (a failed write appends the paired ``runbook.migrate_failed``, SPEC §3.6);
#: one ``runbook.migration_skipped`` per document or folder that was never attempted
#: (unreadable, or the library full); one ``runbook.migration_completed`` summary.
ACTION_MIGRATED = "runbook.migrated"
ACTION_SKIPPED = "runbook.migration_skipped"
ACTION_COMPLETED = "runbook.migration_completed"


def _plural(count: int, one: str, many: str) -> str:
    return f"{count} {one if count == 1 else many}"


def completion_summary(counts: RunbookMigrationCounts) -> str:
    """The summary row's text: ``runbook conversion finished: 8 published, 1 draft,
    0 not converted``."""
    return (f"runbook conversion finished: {counts.published} published, "
            f"{_plural(counts.draft, 'draft', 'drafts')}, {counts.skipped} not converted")


def _id_key(namespace: str, legacy_id: str) -> str:
    return f"{namespace}:{legacy_id}"


async def _audit_row(audit: Any, *, action: str, outcome: str, target: AuditTarget | None,
                     summary: str, tool_input: dict[str, Any]) -> None:
    await audit.record_strict(
        action_type=ActionType.RUNBOOK,
        action=action,
        outcome=outcome,
        actor=RUNBOOK_MIGRATION_ACTOR,
        actor_type="system",
        surface="runbook_migration",
        target=target,
        result_summary=summary,
        tool_input=tool_input,
    )


async def run_runbook_migration(
    *,
    library: RunbookLibraryStore,
    legacy: LegacyProcedureReader,
    audit: Any,
    prefs: Any,
    projector: Projector | None = None,
    now: Callable[[], str] = iso_now,
    project: bool = True,
) -> MigrationOutcome:
    """Run the one-shot migration (SPEC §4.10.17), or resume it. ``audit`` is the
    REAL control audit (``state.control_audit``); ``projector(generation)`` runs the
    full Published-only RAG projection and returns True when it finished (``None``,
    or False: the projection stays pending and the next start resumes it).

    ``project=False`` stops after the marker (steps 1 to 6, bounded: at most
    :data:`MAX_OPERATOR_RUNBOOKS` documents) and leaves step 7 to the caller
    (:func:`resume_runbook_projection`), so application startup never waits for the
    embedding provider; the outcome then reads ``projection_pending``. Until the
    projection completes the retriever excludes untagged legacy runbook chunks (#9).

    Raises on a storage or audit failure before the marker (the next start resumes;
    nothing converted twice). Never writes a legacy document."""
    from ..audit.write import audited_write

    existing = await library.read_marker()
    if existing is not None and existing.marker.completed_at:
        marker = existing.marker
        if marker.projection_completed_at:
            return MigrationOutcome(
                status="already_done", published=marker.counts.published,
                draft=marker.counts.draft, skipped=marker.counts.skipped,
                id_map=dict(marker.id_map), projection_completed=True,
            )
        done = await _project(library, existing.revision, marker, projector, now) if project else False
        return MigrationOutcome(
            status="projection_resumed" if done else "projection_pending",
            published=marker.counts.published, draft=marker.counts.draft,
            skipped=marker.counts.skipped, id_map=dict(marker.id_map),
            projection_completed=done,
        )

    folder_configured = _configured_dir(prefs) is not None
    sources = await _read_sources(legacy, prefs)
    # Every listed runbook read through its document (a row whose document is absent,
    # left by a create whose index write committed but reported a failure, is removed
    # and never counted as converted): the document's ``migrated_from`` is the truth.
    rows = {row.id: row for row in await library.verified_rows()}
    already = migrated_map(rows.values())
    taken: set[str] = set(rows)
    id_map: dict[str, str] = {}
    procedure_ids: set[str] = set()
    counts = RunbookMigrationCounts()
    migrated_now = 0
    stamp = now()

    # Procedure documents first, so a reference runbook that shares an id becomes
    # ``<id>-reference`` (the order is stable across a resumed run).
    ordered = (
        [d for d in sources.documents if d.namespace == NS_PROCEDURE_DIR]
        + [d for d in sources.documents if d.namespace == NS_PROCEDURES]
        + [d for d in sources.documents if d.namespace == NS_REFERENCE]
    )
    for source in ordered:
        key = _id_key(source.namespace, source.legacy_id)
        done_id = already.get((source.namespace, source.legacy_id))
        if done_id is not None:
            # Converted by an earlier, interrupted run: counted, never converted twice.
            id_map[key] = done_id
            taken.add(done_id)
            if source.namespace != NS_REFERENCE:
                procedure_ids.add(_operator_id(source.legacy_id)[0])
            row = rows.get(done_id)
            if row is not None and row.live_version is not None:
                counts.published += 1
            else:
                counts.draft += 1
            continue
        if len(taken) >= MAX_OPERATOR_RUNBOOKS:
            # The library is full (200 runbooks): the document stays in its legacy
            # namespace, readable and exported for one release, and is reported.
            sources.skipped.append(SkippedDocument(
                source.namespace, source.legacy_id,
                f"The runbook library already holds {MAX_OPERATOR_RUNBOOKS} runbooks, the limit.",
            ))
            continue
        plan = plan_id(source.namespace, source.legacy_id, taken=taken, procedure_ids=procedure_ids,
                       folder_configured=folder_configured)
        if source.namespace != NS_REFERENCE:
            procedure_ids.add(_operator_id(source.legacy_id)[0])
        doc = convert_source(source, plan, now=stamp)
        target = AuditTarget(type="runbook", id=doc.runbook.id, label=doc.runbook.versions[0].definition.title)
        tool_input = {
            "source": {"namespace": source.namespace, "id": source.legacy_id, "revision": source.revision},
            "runbook_id": doc.runbook.id,
            "state": doc.state,
            "issues": [i.model_dump(mode="json") for i in doc.issues[:_AUDIT_ISSUES]],
            "issue_count": len(doc.issues),
            "moves": list(doc.notes),
            "prompt_chars": doc.runbook.versions[0].prompt_chars,
        }
        summary = (f"converted {_source_label(source.namespace)} '{source.legacy_id[:120]}' to runbook "
                   f"{doc.runbook.id} as {'Published v1' if doc.state == 'published' else 'a Draft'}")

        async def _store(doc: MigratedDocument = doc) -> Any:
            return await library.create(doc.runbook, system=True)

        await audited_write(
            None,
            sink=audit,
            action=ACTION_MIGRATED,
            target=target,
            expected_revision=None,
            changes=None,
            write=_store,
            action_type=ActionType.RUNBOOK,
            actor=RUNBOOK_MIGRATION_ACTOR,
            actor_type="system",
            surface="runbook_migration",
            result_summary=summary,
            tool_input=tool_input,
        )
        taken.add(doc.runbook.id)
        id_map[key] = doc.runbook.id
        migrated_now += 1
        if doc.state == "published":
            counts.published += 1
        else:
            counts.draft += 1

    for skipped in sources.skipped:
        counts.skipped += 1
        if skipped.whole_source:
            summary = f"could not read the procedure folder: {skipped.reason}"
            source_ref: dict[str, Any] = {"namespace": skipped.namespace, "path": skipped.legacy_id[:200]}
        else:
            summary = (f"could not convert {_source_label(skipped.namespace)} "
                       f"'{skipped.legacy_id[:120]}': {skipped.reason}")
            source_ref = {"namespace": skipped.namespace, "id": skipped.legacy_id[:200]}
        # A document (or folder) that was never attempted: its own action, so
        # ``runbook.migrate_failed`` stays the failure row paired by request id with a
        # ``runbook.migrated`` row whose library write failed (SPEC §3.6).
        await _audit_row(
            audit, action=ACTION_SKIPPED, outcome="failure", target=None,
            summary=summary, tool_input={"source": source_ref, "reason": skipped.reason},
        )

    marker = RunbookMigrationMarker(
        version=MIGRATION_VERSION,
        completed_at=now(),
        counts=counts,
        sources=sources.summary,
        id_map=id_map,
        projection_generation=uuid.uuid4().hex,
    )

    async def _write_marker() -> int:
        return await library.write_marker(marker, expected_revision=None)

    # One summary row, always (SPEC §4.10.17 step 5, #2): the marker is a state change
    # (the sources are never read again, the reprojection follows), so it is audited
    # before it is written, with zero counts on a store that held no procedure.
    revision = await audited_write(
        None,
        sink=audit,
        action=ACTION_COMPLETED,
        target=None,
        expected_revision=None,
        changes=None,
        write=_write_marker,
        action_type=ActionType.RUNBOOK,
        actor=RUNBOOK_MIGRATION_ACTOR,
        actor_type="system",
        surface="runbook_migration",
        result_summary=completion_summary(counts),
        tool_input={"counts": counts.model_dump(), "sources": sources.summary,
                    "converted_now": migrated_now, "id_map_size": len(id_map),
                    "projection_generation": marker.projection_generation},
    )
    logger.info(
        "Runbook migration finished: %d published, %d drafts, %d not converted",
        counts.published, counts.draft, counts.skipped,
    )
    done = await _project(library, revision, marker, projector, now) if project else False
    return MigrationOutcome(
        status="done", published=counts.published, draft=counts.draft, skipped=counts.skipped,
        migrated_now=migrated_now, id_map=id_map, projection_completed=done,
    )


async def resume_runbook_projection(
    *,
    library: RunbookLibraryStore,
    projector: Projector | None,
    now: Callable[[], str] = iso_now,
) -> bool:
    """Step 7 on its own: when the marker says the conversion finished but the RAG
    projection did not, run it and record ``projection_completed_at``. Returns True
    when the projection is complete (now or earlier); False when there is no marker
    yet or the projection stays pending (the next start resumes it). Never raises for
    a projection failure; a marker that cannot be read raises."""
    existing = await library.read_marker()
    if existing is None or not existing.marker.completed_at:
        return False
    if existing.marker.projection_completed_at:
        return True
    return await _project(library, existing.revision, existing.marker, projector, now)


async def _project(
    library: RunbookLibraryStore,
    revision: int,
    marker: RunbookMigrationMarker,
    projector: Projector | None,
    now: Callable[[], str],
) -> bool:
    """Step 7: the full Published-only RAG projection, then ``projection_completed_at``.
    A missing projector, a False result or a failure leaves the projection pending
    (the next start resumes it); the retriever keeps excluding untagged legacy runbook
    chunks meanwhile."""
    if projector is None:
        logger.info("Runbook RAG projection pending: no projector in this build")
        return False
    try:
        finished = bool(await projector(marker.projection_generation))
    except Exception as exc:  # noqa: BLE001 - resumed at the next start
        logger.warning("Runbook RAG projection failed (%s); it resumes at the next start", exc)
        return False
    if not finished:
        return False
    updated = marker.model_copy(update={"projection_completed_at": now()})
    try:
        await library.write_marker(updated, expected_revision=revision)
    except Exception as exc:  # noqa: BLE001 - the projection is repeated next start
        logger.warning("Runbook RAG projection finished but was not recorded (%s)", exc)
        return False
    return True
