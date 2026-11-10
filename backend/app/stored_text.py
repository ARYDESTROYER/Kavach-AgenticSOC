"""Text a stored JSON document can hold on every state backend, and the username rule.

PostgreSQL stores the SQL backend's documents in ``json`` columns, which accept any
escape at write time. Reading one field with ``->>`` de-escapes EVERY string in the
document, and two escapes cannot be de-escaped: ``\\u0000`` (NUL cannot be text) and an
unpaired UTF-16 surrogate such as ``\\ud800``. One such value anywhere in an audit row
made every JSON-filtered read over that row fail. The write side therefore cleans the
text an audit row carries, and :func:`username_problem` refuses a new account name that
could carry such a value into every row its account writes (sign-in refuses only the
characters, :func:`username_char_problem`).

The policy, chosen once and used everywhere (characters are REMOVED, never replaced,
the same as the chat audit actor in ``app.api.deps``):

* :func:`single_line` (an actor, an id, a name, a label, a client header): every C0 and
  C1 control character (``U+0000``-``U+001F``, ``U+007F``-``U+009F``) and every lone
  surrogate is removed, then the text is cut to ``limit`` characters.
* :func:`multi_line` (a summary, a query, a prompt excerpt, a changed value): only NUL
  and lone surrogates are removed. Line breaks and tabs are part of the text.
* :func:`clean_tree` applies :func:`multi_line` to every string key and leaf of a
  JSON-like structure (``tool_input``).

:func:`shown` is for display only: a row an older build stored may still hold a lone
surrogate, which a UTF-8 JSON response cannot carry, so it is shown as U+FFFD (a NUL
is shown as stored; JSON escapes it).

What a person or an attacker typed is still recorded, minus those characters, so the
trail keeps the evidence of what was attempted. Values that are not strings pass
through unchanged, so validation reports them as before. Standard library only.
"""

from __future__ import annotations

import hashlib
import re
from typing import Any, Callable

#: A Python string holds a surrogate code point only when it is unpaired (a valid pair
#: decodes to one astral code point), and JSON writes it back as a lone ``\uD8xx``.
_SURROGATES = "\ud800-\udfff"
#: C0 and C1 controls (the chat audit actor's policy, ``app.api.deps``) and surrogates.
_LINE_UNSAFE_RE = re.compile(f"[\x00-\x1f\x7f-\x9f{_SURROGATES}]")
_TEXT_UNSAFE_RE = re.compile(f"[\x00{_SURROGATES}]")
_SURROGATE_RE = re.compile(f"[{_SURROGATES}]")

#: The longest username an account may have, and the bound of an audit ``actor``.
USERNAME_MAX_CHARS = 160
#: An actor longer than :data:`USERNAME_MAX_CHARS` (an account an older build created
#: without a length bound) is recorded as its first characters, ``~`` and the first
#: hex digits of the SHA-256 of the whole cleaned name, exactly 160 characters in all.
_ACTOR_DIGEST_CHARS = 12
_ACTOR_PREFIX_CHARS = USERNAME_MAX_CHARS - _ACTOR_DIGEST_CHARS - 1
_ACTOR_KEY_SHAPE_RE = re.compile(f"^.{{{_ACTOR_PREFIX_CHARS}}}~[0-9a-f]{{{_ACTOR_DIGEST_CHARS}}}$", re.S)


def single_line(value: Any, limit: int | None = None) -> Any:
    """``value`` without control characters or lone surrogates, cut to ``limit``."""
    if not isinstance(value, str):
        return value
    text = _LINE_UNSAFE_RE.sub("", value)
    return text[:limit] if limit is not None else text


def audit_actor_key(value: Any) -> Any:
    """The audit ``actor`` for a name: :func:`single_line`, kept whole when it fits in
    :data:`USERNAME_MAX_CHARS`; a longer name keeps its first characters and ends in
    ``~`` and a digest of the whole name, so two long names that share their first 160
    characters never become one actor (the account activity feed and the audit actor
    filter match the actor exactly). Every audit writer records this form."""
    if not isinstance(value, str):
        return value
    text = single_line(value)
    if len(text) <= USERNAME_MAX_CHARS:
        return text
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:_ACTOR_DIGEST_CHARS]
    return f"{text[:_ACTOR_PREFIX_CHARS]}~{digest}"


def multi_line(value: Any) -> Any:
    """``value`` without NUL or lone surrogates; every other character is kept."""
    if not isinstance(value, str):
        return value
    return _TEXT_UNSAFE_RE.sub("", value)


def clean_tree(value: Any, leaf: Callable[[Any], Any] = multi_line) -> Any:
    """A copy of a JSON-like value with ``leaf`` (:func:`multi_line` by default) applied
    to every string key and string leaf (dicts, lists, tuples and sets are rebuilt;
    anything else is kept)."""
    if isinstance(value, str):
        return leaf(value)
    if isinstance(value, dict):
        return {leaf(key): clean_tree(item, leaf) for key, item in value.items()}
    if isinstance(value, list):
        return [clean_tree(item, leaf) for item in value]
    if isinstance(value, tuple):
        return tuple(clean_tree(item, leaf) for item in value)
    if isinstance(value, (set, frozenset)):
        return type(value)(clean_tree(item, leaf) for item in value)
    return value


def _surrogate_marked(value: Any) -> Any:
    return _SURROGATE_RE.sub("\ufffd", value) if isinstance(value, str) else value


def shown(value: Any) -> Any:
    """A stored value as a response can carry it: every lone surrogate, in any string
    key or leaf, becomes U+FFFD. For display only, never for writing."""
    return clean_tree(value, _surrogate_marked)


def username_char_problem(value: Any) -> str | None:
    """Why ``value`` cannot be a username because of its characters (a control
    character or a lone surrogate), or ``None``. Sign-in checks only this: an older
    build created accounts with no length bound, and they must still sign in (the
    recorded actor is bounded by ``AuditDoc``)."""
    if not isinstance(value, str):
        return "the username must be text"
    if _LINE_UNSAFE_RE.search(value.strip()):
        return "the username contains control or invalid characters"
    return None


def username_problem(value: Any) -> str | None:
    """Why ``value`` cannot be the name of a new account, or ``None`` when it can:
    :func:`username_char_problem`, then at most :data:`USERNAME_MAX_CHARS` characters,
    and not shaped like the actor :func:`audit_actor_key` records for a longer name
    (a new account must never share an older long account's audit actor).

    Checked on the name as the stores keep it (surrounding whitespace removed). An
    empty name is left to the caller, which already answers it its own way."""
    problem = username_char_problem(value)
    if problem is not None:
        return problem
    name = value.strip()
    if len(name) > USERNAME_MAX_CHARS:
        return f"the username is longer than {USERNAME_MAX_CHARS} characters"
    if _ACTOR_KEY_SHAPE_RE.match(name):
        return "the username has a reserved form"
    return None


__all__ = [
    "USERNAME_MAX_CHARS",
    "audit_actor_key",
    "clean_tree",
    "multi_line",
    "shown",
    "single_line",
    "username_char_problem",
    "username_problem",
]
