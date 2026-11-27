"""Case tag rules shared by every writer of ``Case.tags`` (Round 12 polish).

The writers are the ``/cases/{id}/tags`` route (the header tag editor and the bulk tag
job), a lifecycle action's additive ``tags`` (the close dialog) and case automation's
``tag`` action. All of them keep the same two bounds, and none of them cuts or drops a
tag without saying so:

* a tag is at most ``CASE_TAG_MAX_CHARS`` characters (code points). A longer NEW tag is
  refused, never cut to fit: a shortened label is a different tag from the one meant;
* a case holds at most ``CASE_TAG_MAX_COUNT`` tags. A change that would add tags past
  that is refused, never stored with the extra tags silently left off.

A tag the case already carries passes unchanged, whatever its length, and a case that
already holds more tags than the bound keeps them all: these rules only refuse what is
new. The web console mirrors both bounds in ``webui/src/lib/tags.ts`` (same names) so a
refusal shows where the tag is typed; the server stays the authority.

Pure functions, no I/O. The route turns :class:`CaseTagError` into a 422 whose detail is
the message; automation records it on the case instead (it has no one to answer).
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

#: The longest case tag, in characters (code points, as ``len`` counts them).
CASE_TAG_MAX_CHARS = 40
#: The most tags one case holds.
CASE_TAG_MAX_COUNT = 25


class CaseTagError(ValueError):
    """A tag change the bounds refuse. ``str(error)`` says why, in plain words."""


def tag_too_long(tag: str) -> str | None:
    """The refusal for a tag over ``CASE_TAG_MAX_CHARS``, or None when it fits."""
    if len(tag) <= CASE_TAG_MAX_CHARS:
        return None
    return (
        f"A tag can be up to {CASE_TAG_MAX_CHARS} characters. "
        f"This one has {len(tag)}: shorten it and try again."
    )


def too_many_tags(total: int) -> str:
    """The refusal for a change that would leave a case with ``total`` tags."""
    over = total - CASE_TAG_MAX_COUNT
    return (
        f"A case can hold up to {CASE_TAG_MAX_COUNT} tags, and this would give it {total}. "
        f"Add fewer, or remove {over} from the case first."
    )


def merge_case_tags(existing: Iterable[Any], incoming: Iterable[Any], *, replace: bool) -> list[str]:
    """Trim and de-duplicate case tags against both bounds.

    ``replace`` takes ``incoming`` as the whole list (``/tags``); otherwise it is merged
    after ``existing`` (a lifecycle action's additive tags). Raises :class:`CaseTagError`
    for a NEW tag over the length bound, or when NEW tags would take the case past the
    count bound. Nothing is cut and nothing is dropped."""
    current = [str(t) for t in existing]
    merged: list[str] = [] if replace else list(current)
    for raw in incoming:
        tag = str(raw).strip()
        if not tag or tag in merged:
            continue
        if tag not in current:
            refusal = tag_too_long(tag)
            if refusal:
                raise CaseTagError(refusal)
        merged.append(tag)
    if len(merged) > CASE_TAG_MAX_COUNT and any(t not in current for t in merged):
        raise CaseTagError(too_many_tags(len(merged)))
    return merged


def automation_tags(payload: dict[str, Any] | None) -> list[str]:
    """The tags a case automation ``tag`` rule asks for, trimmed and de-duplicated.

    The Rule editor saves a list under ``tags``; a rule written for the API may carry a
    single ``tag`` (or ``value``) instead. ``tags`` wins when it lists anything, else the
    single value is read. Values are never cut here: the caller refuses an over-long one."""
    data = payload or {}
    raw = data.get("tags")
    items: list[Any]
    if isinstance(raw, (list, tuple)) and any(str(t).strip() for t in raw):
        items = list(raw)
    elif isinstance(raw, str) and raw.strip():
        items = [raw]
    else:
        items = [data.get("tag") or data.get("value") or ""]
    out: list[str] = []
    for item in items:
        tag = str(item if item is not None else "").strip()
        if tag and tag not in out:
            out.append(tag)
    return out
