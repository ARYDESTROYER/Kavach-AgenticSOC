"""Plain-text runbooks — Vigil's "your playbooks are plain-text files" pillar.

A runbook is a Markdown file under ``backend/app/runbooks/`` with a small YAML-ish
frontmatter block and a free-text body of investigation guidance:

    ---
    id: brute_force
    title: SSH / credential brute force
    applies_to_rules: [sshd, linux_auth, postfix]
    applies_to_techniques: [T1110, T1078]
    applies_to_entities: [user, ip]
    keywords: [ssh, brute, failed password, auth]
    persona: identity_access
    summary: Triage a burst of failed authentications from one source.
    ---
    ## Steps
    1. Confirm whether ANY attempt succeeded ...

Runbooks feed two paths: (a) the RAG ``runbook`` corpus (so they're retrievable),
and (b) direct injection of the single best-matching runbook as TRUSTED guidance
into the investigator prompt. A tiny dependency-free frontmatter parser keeps the
"no new deps" rule (mirrors how Vigil parses its WORKFLOW.md). Loading is cached
because the files are static at runtime; ``reload_runbooks()`` clears the cache.

Operator-authored runbooks often use a different frontmatter vocabulary than the
canonical keys above (``mitre:`` instead of ``applies_to_techniques:``, ``tags:``
instead of ``keywords:``). Rather than force every author to rewrite, ``_ALIASES``
maps those spellings onto the canonical fields, technique ids are extracted from
prose entries like ``"T1110.003 (Brute Force: Password Spraying)"``, and a missing
``summary`` falls back to the body's first real paragraph. Canonical keys always
win; aliases only add. A file using purely canonical keys parses byte-identically
to before.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger("tlsoc.engine.runbooks")

RUNBOOKS_DIR = Path(__file__).resolve().parent.parent / "runbooks"


@dataclass(frozen=True)
class Runbook:
    id: str
    title: str
    body: str
    summary: str = ""
    persona: str = ""
    applies_to_rules: tuple[str, ...] = ()
    applies_to_techniques: tuple[str, ...] = ()
    applies_to_entities: tuple[str, ...] = ()
    keywords: tuple[str, ...] = ()

    def as_corpus_item(self) -> dict:
        """A RAG corpus document for this runbook (source='runbook').

        We index a CONCISE, keyword-rich descriptor (title + summary + keywords +
        rules/techniques) rather than the full multi-paragraph body: it embeds and
        BM25-matches cleanly, and the full body is injected directly into the
        investigator prompt when this runbook is the selected match anyway."""
        parts = [f"{self.title}.", self.summary]
        if self.keywords:
            parts.append("Keywords: " + ", ".join(self.keywords) + ".")
        if self.applies_to_rules:
            parts.append("Rules: " + ", ".join(self.applies_to_rules) + ".")
        if self.applies_to_techniques:
            parts.append("MITRE: " + ", ".join(self.applies_to_techniques) + ".")
        text = " ".join(p for p in parts if p).strip()
        return {
            "text": text,
            "source": "runbook",
            "doc_id": f"runbook:{self.id}",
            "metadata": {
                "runbook_id": self.id,
                "title": self.title,
                "persona": self.persona,
                "rules": list(self.applies_to_rules),
                "mitre": list(self.applies_to_techniques),
            },
        }


# --------------------------------------------------------------------------- #
# Minimal, dependency-free frontmatter parsing.
# --------------------------------------------------------------------------- #
_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n?(.*)$", re.DOTALL)


def _split_list(raw: str) -> tuple[str, ...]:
    raw = raw.strip()
    if raw.startswith("[") and raw.endswith("]"):
        raw = raw[1:-1]
    parts = [p.strip().strip("'\"") for p in raw.split(",")]
    return tuple(p for p in parts if p)


def parse_frontmatter(text: str) -> tuple[dict[str, object], str]:
    """Return (meta, body). Supports scalars, inline ``[a, b]`` lists, and indented
    ``- item`` lists. Anything it can't parse is ignored (never raises)."""
    m = _FRONTMATTER_RE.match(text.lstrip("﻿"))
    if not m:
        return {}, text.strip()
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
            current_key = key  # indented list follows
            current_list = []
        elif val.startswith("["):
            meta[key] = _split_list(val)
        else:
            meta[key] = val.strip("'\"")
    _flush()
    return meta, body


# Operator-authored spellings → canonical Runbook field. Several aliases may map
# onto the same canonical key; every one of them is merged (canonical value first).
_ALIASES: dict[str, str] = {
    "mitre": "applies_to_techniques",
    "attack_technique": "applies_to_techniques",
    "techniques": "applies_to_techniques",
    "tags": "keywords",
    "rules": "applies_to_rules",
    "entities": "applies_to_entities",
}

# ATT&CK technique id, optionally with a sub-technique: T1110, T1110.003.
_TECHNIQUE_RE = re.compile(r"\bT\d{4}(?:\.\d{3})?\b")

# A body block that is only a heading, table row, or horizontal rule is not a summary.
_NON_PROSE_PREFIXES = ("#", "|", "---", "> ", "```")


def _extract_techniques(values: tuple[str, ...]) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """Split prose technique entries into ``(ids, leftovers)``.

    ``"T1110.003 (Brute Force: Password Spraying)"`` → id ``"T1110.003"``. An entry
    carrying no ATT&CK id at all — ``"ADCS ESC1 / CVE-2022-26923 (Certifried)"`` —
    is a *leftover*: it would pollute a technique-id list, but it is exactly the
    kind of phrase an analyst searches for, so the caller folds it into keywords
    instead of dropping it."""
    ids: list[str] = []
    leftovers: list[str] = []
    for value in values:
        found = _TECHNIQUE_RE.findall(value)
        if found:
            ids.extend(found)
        elif value:
            leftovers.append(value)
    return tuple(dict.fromkeys(ids)), tuple(dict.fromkeys(leftovers))


def _first_paragraph(body: str) -> str:
    """The body's first prose paragraph, for runbooks that declare no ``summary``.

    Skips headings, tables, quotes and fences so the fallback is a real sentence.
    Bounded so a long opening paragraph can't bloat the RAG corpus entry."""
    for block in re.split(r"\n\s*\n", body):
        block = block.strip()
        if not block or block.startswith(_NON_PROSE_PREFIXES):
            continue
        return " ".join(line.strip() for line in block.splitlines())[:300]
    return ""


def _to_runbook(meta: dict[str, object], body: str, fallback_id: str) -> Runbook:
    def _tuple(key: str) -> tuple[str, ...]:
        """Values for a canonical key, merged with every alias pointing at it."""
        out: list[str] = []
        for candidate in (key, *(a for a, c in _ALIASES.items() if c == key)):
            v = meta.get(candidate)
            if isinstance(v, tuple):
                out.extend(str(x) for x in v)
            elif isinstance(v, str) and v:
                out.append(v)
        return tuple(dict.fromkeys(out))

    techniques, unparsed = _extract_techniques(_tuple("applies_to_techniques"))
    return Runbook(
        id=str(meta.get("id") or fallback_id),
        title=str(meta.get("title") or fallback_id),
        body=body,
        summary=str(meta.get("summary") or "") or _first_paragraph(body),
        persona=str(meta.get("persona") or ""),
        applies_to_rules=_tuple("applies_to_rules"),
        applies_to_techniques=techniques,
        applies_to_entities=_tuple("applies_to_entities"),
        # Technique entries that carried no ATT&CK id are searchable phrases, not
        # ids — they enrich retrieval as keywords rather than polluting the ids.
        keywords=tuple(dict.fromkeys(_tuple("keywords") + unparsed)),
    )


_CACHE: list[Runbook] | None = None


def load_runbooks(directory: Path | None = None) -> list[Runbook]:
    """Load + cache all ``*.md`` runbooks from the runbooks directory. Never raises
    (a bad file is skipped with a warning)."""
    global _CACHE
    if directory is None and _CACHE is not None:
        return _CACHE
    base = directory or RUNBOOKS_DIR
    runbooks: list[Runbook] = []
    if base.is_dir():
        for path in sorted(base.glob("*.md")):
            try:
                meta, body = parse_frontmatter(path.read_text(encoding="utf-8"))
                runbooks.append(_to_runbook(meta, body, path.stem))
            except Exception as exc:  # noqa: BLE001
                logger.warning("Skipping unparseable runbook %s: %s", path, exc)
    if directory is None:
        _CACHE = runbooks
    return runbooks


def reload_runbooks() -> None:
    """Drop the cache (e.g. after editing runbook files)."""
    global _CACHE
    _CACHE = None


def corpus_items(runbooks: list[Runbook] | None = None) -> list[dict]:
    """RAG corpus documents for all runbooks."""
    return [rb.as_corpus_item() for rb in (runbooks if runbooks is not None else load_runbooks())]

# NOTE: per-cluster PROCEDURE selection now lives in ``app/playbooks/`` (the
# Markdown playbook registry). Runbooks here are RAG knowledge only — there is no
# ``select_runbook`` anymore.
