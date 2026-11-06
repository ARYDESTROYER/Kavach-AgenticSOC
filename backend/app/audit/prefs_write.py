"""Audited writes of the stored settings (Round 14 SPEC §3.6, §4.5.4).

Every write of ``Preferences`` made by a person (``PUT /api/settings`` and the curated
settings routes) goes through :func:`audited_prefs_write`, so a settings change is
**audited before it becomes visible** (E16): the action row, with the change set
computed from the stored document before the write and the validated document after
it, is appended first; only then is the document saved. If the row cannot be
appended the request answers ``503 audit_unavailable`` and nothing is saved (the old
"never fail the settings save" best-effort audit is gone).

The settings document has no revision number, so the write is a compare-and-swap on
the change set itself: the row says exactly which fields change from what to what,
and the save applies the same edit to the document it finds under the settings lock.
If another save changed one of those fields in between (so the row would no longer be
true), the save is not made, a failure row (``settings.update_failed``) says why, and
the whole write is tried again from a fresh read (a few times, then ``409
settings_conflict``). An edit to an unrelated section by another writer is not a
conflict: the change set this row records is still exactly what is saved. Every
attempt is an action row and, when it loses the race, its failure row, all under the
request's one id: the order is action, failure, action, and a retry's action row says
which attempt it is in ``tool_input`` (``{"attempt": 2, "of": 3}``), so the applied
row is never read as the one that failed.
"""

from __future__ import annotations

import logging
from typing import Any, Callable, Mapping, Sequence

from fastapi import HTTPException

from ..constants import ActionType
from ..models import AUDIT_TARGET_ID_MAX_CHARS, AuditChange, AuditTarget
from .changes import changed_sections, changed_values, count_changes, diff_changes
from .write import audited_write

logger = logging.getLogger("tlsoc.audit.prefs_write")

#: Fresh-read attempts before a save that keeps racing another one gives up.
SETTINGS_WRITE_ATTEMPTS = 3

Summary = str | Callable[[Sequence[AuditChange], int], str]


class SettingsMovedError(Exception):
    """Another save changed a field this write records, between the row and the save.
    Raised inside the store write, so the action row gets its failure row."""

    def __init__(self) -> None:
        super().__init__(
            "another save changed these settings after this change was recorded; "
            "the change was not saved and is being retried"
        )


def settings_conflict() -> HTTPException:
    return HTTPException(
        status_code=409,
        detail={
            "code": "settings_conflict",
            "message": "The settings changed while saving. Reload them and try again.",
        },
    )


def _dump(prefs: Any) -> dict[str, Any]:
    return prefs.model_dump(mode="json") if hasattr(prefs, "model_dump") else dict(prefs or {})


def _sentence_case(title: str) -> str:
    """``Auto-Close Policy`` → ``Auto-close policy``; acronyms (``RAG``, ``SLA``,
    ``ID``) keep their capitals (the Console's sentence-case copy rule)."""
    words = title.split(" ")
    out: list[str] = []
    for index, word in enumerate(words):
        parts = word.split("-")
        fixed = []
        for p_index, part in enumerate(parts):
            if len(part) > 1 and part.isupper():
                fixed.append(part)
            elif index == 0 and p_index == 0:
                fixed.append(part[:1].upper() + part[1:].lower())
            else:
                fixed.append(part.lower())
        out.append("-".join(fixed))
    return " ".join(out)


def section_label(key: str) -> str:
    """A settings section's display name in sentence case."""
    try:
        from ..api.settings_schema import _humanise

        title = _humanise(key)
    except Exception:  # noqa: BLE001 (a missing table falls back to the key)
        title = key.replace("_", " ")
    return _sentence_case(title)


def settings_target(changes: Sequence[AuditChange], *, default_id: str = "settings",
                    default_label: str = "Settings") -> AuditTarget:
    """The ``setting`` target of a settings write: the sections it changed (ids joined
    by commas, labels in sentence case), or the whole settings when none did."""
    sections = changed_sections(changes)
    if not sections:
        return AuditTarget(type="setting", id=default_id, label=default_label)
    target_id = ",".join(sections)
    if len(target_id) > AUDIT_TARGET_ID_MAX_CHARS:
        target_id = target_id[:AUDIT_TARGET_ID_MAX_CHARS].rsplit(",", 1)[0] or sections[0]
    return AuditTarget(type="setting", id=target_id,
                       label=", ".join(section_label(s) for s in sections))


def _summary_text(summary: Summary, changes: Sequence[AuditChange], total: int) -> str:
    text = summary(changes, total) if callable(summary) else str(summary)
    if total > len(changes):
        text = f"{text} ({total} fields changed; the first {len(changes)} are recorded)"
    return text[:1000]


class _Swap:
    """The edit as the settings lock applies it: the snapshot's result when nothing
    was saved since, else the same edit re-applied to the stored document, provided it
    changes exactly the recorded fields from and to exactly the recorded RAW values
    (so the row is still true); otherwise :class:`SettingsMovedError`."""

    def __init__(self, transform: Callable[[Any], Any], snapshot: Any, after: Any,
                 recorded: dict[str, Any]) -> None:
        self._transform = transform
        self._snapshot = snapshot
        self._after = after
        self._recorded = recorded
        self.before: Any = snapshot

    def __call__(self, current: Any) -> Any:
        if current is self._snapshot:
            return self._after
        fresh = self._transform(current)
        if changed_values(_dump(current), _dump(fresh)) != self._recorded:
            raise SettingsMovedError()
        self.before = current
        return fresh


def _attempt_input(tool_input: Any, attempt: int, total: int) -> Any:
    """The action row's ``tool_input`` for ``attempt`` of ``total``. A retry after a
    racing save is a second action row (and the first one's failure row) under the
    same request id, so a retry's row says which attempt it is
    (``{"attempt": 2, "of": 3}``); the first attempt's row is left as it always was."""
    if attempt <= 1:
        return tool_input
    marker = {"attempt": attempt, "of": total}
    if tool_input is None:
        return marker
    if isinstance(tool_input, Mapping):
        return {**tool_input, **marker}
    return {"input": tool_input, **marker}


async def _attempt(state: Any, *, transform: Callable[[Any], Any], summary: Summary,
                   target: AuditTarget | None, secret_fields: Sequence[str],
                   **row: Any) -> tuple[Any, Any]:
    """One audited save from a fresh read (see :func:`audited_prefs_write`)."""
    snapshot = state.prefs
    # The stored document is read BEFORE the edit runs, so the recorded "before" is
    # the stored value even if an edit were to touch a shared object in place.
    before_doc = _dump(snapshot)
    after = transform(snapshot)
    after_doc = _dump(after)
    changes = diff_changes(before_doc, after_doc, secret_fields=secret_fields)
    swap = _Swap(transform, snapshot, after, changed_values(before_doc, after_doc))
    saved = await audited_write(
        state,
        sink="control",
        target=target if target is not None else settings_target(changes),
        expected_revision=None,
        changes=changes,
        write=lambda: state.mutate_prefs(swap),
        result_summary=_summary_text(summary, changes, count_changes(before_doc, after_doc)),
        **row,
    )
    return swap.before, saved


async def audited_prefs_write(
    state: Any,
    *,
    transform: Callable[[Any], Any],
    actor: str,
    context: Any,
    summary: Summary,
    action: str = "settings.updated",
    action_type: ActionType = ActionType.STATUS,
    surface: str = "settings",
    actor_type: str = "human",
    target: AuditTarget | None = None,
    tool_input: Any = None,
    secret_fields: Sequence[str] = (),
    attempts: int = SETTINGS_WRITE_ATTEMPTS,
) -> tuple[Any, Any]:
    """Apply ``transform`` to the real stored settings, audit-first (module doc).

    ``transform`` is the pure edit (``current -> new``); it validates and raises the
    caller's ``HTTPException`` for a refused edit, which writes no row (nothing was
    attempted). It must not change the document it is given in place (it returns a
    copy). The row goes to ``control_audit`` (settings are real state, never
    Demo-swapped). ``secret_fields`` names dotted paths that are always recorded as
    secret (a connector field its manifest marks secret). Returns ``(before,
    after)``: the document the edit was applied to and the saved one. A save that
    keeps racing another save of the same fields gives up after ``attempts`` with
    ``409 settings_conflict``."""
    total_attempts = max(1, attempts)
    for attempt in range(total_attempts):
        try:
            return await _attempt(
                state, transform=transform, summary=summary, target=target,
                secret_fields=tuple(secret_fields),
                action=action, action_type=action_type, actor=actor, actor_type=actor_type,
                surface=surface, context=context,
                tool_input=_attempt_input(tool_input, attempt + 1, total_attempts),
            )
        except SettingsMovedError:
            logger.info("Settings save raced another save (attempt %d of %d)",
                        attempt + 1, total_attempts)
    raise settings_conflict()


__all__ = [
    "SETTINGS_WRITE_ATTEMPTS",
    "SettingsMovedError",
    "audited_prefs_write",
    "section_label",
    "settings_conflict",
    "settings_target",
]
