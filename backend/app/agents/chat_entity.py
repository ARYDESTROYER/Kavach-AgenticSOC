"""Ask AI entity questions (Round 12 WP-ASK; SPEC §4 WP-ASK, SYNTHESIS-chat P1-5).

An "Ask AI" chip beside an IP, host, user, file hash, domain, URL, e-mail address,
detection rule or case id sends the chat page a TYPED REFERENCE ``{kind, value}``,
never free text (the topic pattern, SPEC A7). This module is the server's one place
that turns that reference into a question:

* :func:`entity_value` checks the value against a strict grammar for its kind. An IP
  must parse as an IP address, a hash is 32, 40 or 64 hex digits, a URL, e-mail
  address or domain has its own ASCII shape, and a host, user, rule or case is ONE
  identifier token: letters, digits and ``_ . @ \\ $ : / # + -`` only, so no
  whitespace, quotes, angle brackets, protocol markers or invisible characters
  (``constants.INVISIBLE_TEXT_RANGES``). A value that fails has no question at all; it
  is never quoted, cut or altered into a different value.
* :func:`entity_question` words the question from a server template.
* :func:`parse_entity_question` recognises a question this module wrote, so the Demo
  planner can plan it like a model that honours the indicator taint rule.

Taint (#9, §4.8): the value is log- or case-derived. The chat page sends the question
with ``origin: "starter"`` (like a topic question), so the value is NOT user-authored
for the indicator taint rule: ``lookup_indicator`` runs on it only when the policy
allows it (it turned up as code evidence this turn). The templates therefore never ask
for third-party reputation; the analyst can still ask for it in their own words. The
strict grammar is what keeps the value, which reaches the model as part of the live
question, to a single token that cannot carry instructions.

The web client mirrors the grammar in ``webui/src/soc/components/ask-ai.ts`` so it only
shows a chip the server will answer; both sides are pinned to the shared table in
``webui/src/soc/components/ask-ai.contract.json``.
"""

from __future__ import annotations

import ipaddress
import re
import unicodedata
from typing import Any, Literal, get_args

from pydantic import BaseModel, ConfigDict, Field

from ..constants import INVISIBLE_TEXT_CLASS

EntityAskKind = Literal["ip", "host", "user", "hash", "domain", "url", "email", "rule", "case"]
ENTITY_ASK_KINDS: tuple[str, ...] = get_args(EntityAskKind)

#: The longest value any kind accepts (the request bound; each kind has its own below).
ENTITY_VALUE_MAX_CHARS = 512

_MAX_CHARS: dict[str, int] = {
    "ip": 45, "hash": 64, "domain": 253, "url": 512, "email": 254,
    "host": 256, "user": 256, "rule": 256, "case": 128,
}

_INVISIBLE_RE = re.compile(f"[{INVISIBLE_TEXT_CLASS}]")
_HASH_RE = re.compile(r"[0-9A-Fa-f]{32}|[0-9A-Fa-f]{40}|[0-9A-Fa-f]{64}")
_LABEL = r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
_TLD = r"(?:[A-Za-z]{2,63}|xn--[A-Za-z0-9-]{1,59})"
_DOMAIN_RE = re.compile(rf"(?:{_LABEL}\.)+{_TLD}")
_EMAIL_RE = re.compile(rf"[A-Za-z0-9._%+-]{{1,64}}@(?:{_LABEL}\.)+{_TLD}")
# Printable ASCII without whitespace, quotes, angle brackets, backslash, braces, pipe,
# caret or backtick; a host is required after the scheme.
_URL_RE = re.compile(r"(?:https?|hxxps?)://[^\s/?#\"'<>`\\{}|^]+[^\s\"'<>`\\{}|^]*", re.IGNORECASE)
_URL_ASCII_RE = re.compile(r"[!-~]+")
_CASE_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}")
#: The punctuation an identifier (host, user, rule) may carry besides letters and digits.
_IDENT_PUNCT = frozenset("_.@\\$:/#+-")


class ChatEntityRef(BaseModel):
    """``POST /api/chat/entity-question`` body: what an Ask AI chip asks about."""

    model_config = ConfigDict(extra="forbid")

    kind: EntityAskKind
    value: str = Field(min_length=1, max_length=ENTITY_VALUE_MAX_CHARS)


class ChatEntityQuestion(BaseModel):
    """The server-worded question for one entity (sent with ``origin: "starter"``)."""

    kind: EntityAskKind
    value: str
    question: str


def _is_ip(value: str) -> bool:
    # A zone id (``fe80::1%eth0``) carries free text after the ``%``: never accepted.
    if "%" in value:
        return False
    try:
        ipaddress.ip_address(value)
    except ValueError:
        return False
    return True


def _is_identifier(value: str) -> bool:
    """One token of letters, digits (any script), combining marks after a base
    character, and ``_ . @ \\ $ : / # + -``; at least one letter or digit."""
    has_alnum = False
    for index, ch in enumerate(value):
        if ch in _IDENT_PUNCT:
            continue
        major = unicodedata.category(ch)[0]
        if major in "LN":
            has_alnum = True
            continue
        if major == "M" and index > 0:
            continue
        return False
    return has_alnum


def _is_url(value: str) -> bool:
    return bool(_URL_ASCII_RE.fullmatch(value) and _URL_RE.fullmatch(value))


_VALID: dict[str, Any] = {
    "ip": _is_ip,
    "hash": lambda v: bool(_HASH_RE.fullmatch(v)),
    "domain": lambda v: bool(_DOMAIN_RE.fullmatch(v)),
    "url": _is_url,
    "email": lambda v: bool(_EMAIL_RE.fullmatch(v)),
    "host": _is_identifier,
    "user": _is_identifier,
    "rule": _is_identifier,
    "case": lambda v: bool(_CASE_RE.fullmatch(v)),
}


def entity_value(kind: Any, raw: Any) -> str | None:
    """The value an Ask AI question may name for ``kind``, or ``None``.

    Surrounding whitespace is trimmed; nothing else is changed. ``None`` for an unknown
    kind, a non-string or empty value, one longer than its kind allows, one with an
    invisible, control, bidi or separator character, or one that does not have its
    kind's shape."""
    if kind not in _VALID or not isinstance(raw, str):
        return None
    value = raw.strip()
    if not value or len(value) > _MAX_CHARS[kind] or _INVISIBLE_RE.search(value):
        return None
    return value if _VALID[kind](value) else None


# --------------------------------------------------------------------------- #
# The questions. Sentence case, plain words, one window the answer states. None asks
# for reputation (see the module docstring); host, user and IP ask for an in-depth
# look, the other indicators for cases and sightings, a rule for its case outcomes.
# --------------------------------------------------------------------------- #
_TEMPLATES: dict[str, str] = {
    "ip": ("Investigate everything about IP {v}: related cases, log activity over the last 7 days, "
           "and the hosts and users seen with it."),
    "host": ("Investigate everything about host {v}: related cases, log activity over the last 7 days, "
             "and the users and IPs seen with it."),
    "user": ("Investigate everything about user {v}: related cases, sign-in and log activity over the "
             "last 7 days, and the hosts they used."),
    "domain": "Investigate the domain {v}: related cases and where it was seen in the logs over the last 7 days.",
    "url": "Investigate the URL {v}: related cases and where it was seen in the logs over the last 7 days.",
    "hash": "Investigate the file hash {v}: related cases and where it was seen in the logs over the last 7 days.",
    "email": ("Investigate the email address {v}: related cases and where it was seen in the logs over the "
              "last 7 days."),
    "rule": "How many cases did detection rule {v} create in the last 7 days, and how were they decided?",
    "case": "Investigate case {v}: what happened, the evidence and why it was decided that way.",
}
# A case id that already reads as one ("case-0042", "CASE_17") is not called a case twice.
_CASE_NAMED_TEMPLATE = "Investigate {v}: what happened, the evidence and why it was decided that way."
_CASE_NAMED_RE = re.compile(r"case", re.IGNORECASE)


def _template(kind: str, value: str) -> str:
    if kind == "case" and _CASE_NAMED_RE.match(value):
        return _CASE_NAMED_TEMPLATE
    return _TEMPLATES[kind]


def entity_question(kind: str, value: str) -> str:
    """The question for a value :func:`entity_value` accepted (``ValueError`` else)."""
    checked = entity_value(kind, value)
    if checked is None:
        raise ValueError("no question for that value")
    return _template(kind, checked).replace("{v}", checked)


def parse_entity_question(text: Any) -> tuple[str, str] | None:
    """``(kind, value)`` when ``text`` is exactly a question :func:`entity_question`
    words, else ``None``. Pure; used by the Demo planner to recognise a console
    question (its value is not the analyst's own words)."""
    if not isinstance(text, str):
        return None
    text = text.strip()
    for kind, template in (*_TEMPLATES.items(), ("case", _CASE_NAMED_TEMPLATE)):
        prefix, _, suffix = template.partition("{v}")
        if len(text) <= len(prefix) + len(suffix) or not (text.startswith(prefix) and text.endswith(suffix)):
            continue
        value = text[len(prefix): len(text) - len(suffix)]
        if entity_value(kind, value) == value and _template(kind, value) == template:
            return kind, value
    return None


__all__ = [
    "ENTITY_ASK_KINDS",
    "ENTITY_VALUE_MAX_CHARS",
    "ChatEntityQuestion",
    "ChatEntityRef",
    "EntityAskKind",
    "entity_question",
    "entity_value",
    "parse_entity_question",
]
