"""Preference round-trip preservation: a save never erases what this build does not model.

``Preferences`` is one stored document that more than one release reads and writes. An
image-only rollback (release N to N-1) and the return (N-1 to N) both load the document
into the running build's schema and later save it back. A plain
``prefs.model_dump()`` would write only the keys the running build models, so an older
build silently deleted every setting a newer build added (and persisted values it had
only clamped into its own narrower range). The next upgrade then started those settings
from their defaults.

:func:`preferences_document` is the document a config store writes instead. It is the
running build's dump plus, from the document stored right now:

1. every key this build does not model, at the top level and inside every nested
   section (a field whose type is a settings model), except the keys this build retired
   on purpose (:data:`CONSUMED_PREFERENCE_KEYS`, never resurrected);
2. every stored value this build could not accept as stored (its own declared type and
   bounds reject it, so a load repaired or clamped it for this build's use) when the
   caller left the repaired value unchanged. A value the operator changed is saved as
   changed. A migration stamp (:data:`MIGRATION_STAMP_KEYS`) is the exception: only a
   newer build's valid stamp (an integer above the one this build loaded) is kept. A
   malformed stamp is replaced by the stamp this build's load set, so a once-only
   migration keyed on it runs once and never again on every load.

It never raises for an unknown key and never turns one into a validation failure: an
unknown key is ignored on load (``extra`` stays ``ignore``) and carried on save.

Limits, by design: a list item or a map value (a source, a rule, a per-rule override) is
written as this build models it; an operator who explicitly sets exactly the value this
build clamped to cannot be told apart from an unchanged value, so the stored one is
kept. A factory reset writes its defaults directly and keeps nothing.

Nothing here reads or feeds ``case_manager.decide()`` (#3), and no key is renamed.
"""

from __future__ import annotations

import copy
import functools
import logging
import types
import typing
from collections.abc import Mapping
from typing import Annotated, Any

from pydantic import BaseModel, TypeAdapter

from .config import Preferences

logger = logging.getLogger("tlsoc.preferences_roundtrip")

#: The preference keys this build retired on purpose, as key paths. A stored copy is
#: dropped on save rather than carried as an unknown key: ``playbooks.llm_select``
#: never had an effect and the Round 14 runbook migration consumed the section. A later
#: retirement adds its path here.
CONSUMED_PREFERENCE_KEYS: frozenset[tuple[str, ...]] = frozenset(
    {("playbooks", "llm_select")}
)

#: The migration stamps, as key paths. A once-only migration runs while its stamp reads
#: as older than this build's, so a stamp is never carried as a "repaired" value: only a
#: newer build's valid stamp is kept (that build's once-only rule must not run again
#: here), and a malformed one is saved as the stamp this build's load set. A later
#: stamp adds its path here.
MIGRATION_STAMP_KEYS: frozenset[tuple[str, ...]] = frozenset(
    {
        ("autopilot_config_version",),
        ("rule_catalog_seed_version",),
        ("rbac", "rbac_grants_version"),
        ("runbooks", "runbooks_config_version"),
        ("chat_agent", "chat_limits_version"),
    }
)

_MISSING = object()


def preferences_document(prefs: Preferences | BaseModel, stored: Any) -> dict[str, Any]:
    """The document to persist for ``prefs`` when ``stored`` is the document stored
    now (``None`` or a non-object: there is nothing to preserve). The schema is
    ``type(prefs)``: this build's :class:`Preferences` in production, any settings
    model in a test that plays an older or newer build. Pure; never raises for the
    content of ``stored``."""
    model = type(prefs)
    document = prefs.model_dump(mode="json")
    if not isinstance(stored, Mapping):
        return document
    try:
        baseline: Mapping[str, Any] | None = model.model_validate(
            copy.deepcopy(dict(stored))
        ).model_dump(mode="json")
    except Exception as exc:  # noqa: BLE001 - the load used defaults; keys still carry
        logger.info("Stored preferences do not validate (%s); keeping unknown keys only", exc)
        baseline = None
    _carry(model, document, stored, baseline, ())
    return document


def _carry(
    model: type[BaseModel],
    document: dict[str, Any],
    stored: Mapping[str, Any],
    baseline: Mapping[str, Any] | None,
    path: tuple[str, ...],
) -> None:
    fields = model.model_fields
    for key, raw in stored.items():
        if not isinstance(key, str):
            continue
        here = path + (key,)
        field = fields.get(key)
        if field is None:
            if here not in CONSUMED_PREFERENCE_KEYS and key not in document:
                document[key] = copy.deepcopy(raw)
            continue
        if key not in document:
            continue
        base = baseline.get(key, _MISSING) if isinstance(baseline, Mapping) else _MISSING
        section = _section_model(field.annotation)
        if section is not None:
            if isinstance(raw, Mapping) and isinstance(document[key], dict):
                _carry(
                    section,
                    document[key],
                    raw,
                    base if isinstance(base, Mapping) else None,
                    here,
                )
            continue
        if base is _MISSING or document[key] != base or raw == base:
            continue
        if here in MIGRATION_STAMP_KEYS:
            if _is_int(raw) and _is_int(base) and raw > base:
                document[key] = raw  # a newer build's stamp: its migration already ran
            continue
        if not _accepts(model, key, raw):
            # This build repaired the stored value for its own use and nobody changed
            # it: keep what was stored (a newer build's value survives the rollback).
            document[key] = copy.deepcopy(raw)


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _section_model(annotation: Any) -> type[BaseModel] | None:
    """The settings model a field holds directly (``Model`` or ``Model | None``)."""
    if isinstance(annotation, type) and issubclass(annotation, BaseModel):
        return annotation
    origin = typing.get_origin(annotation)
    if origin is typing.Union or origin is types.UnionType:
        members = [arg for arg in typing.get_args(annotation) if arg is not type(None)]
        if len(members) == 1:
            return _section_model(members[0])
    return None


@functools.lru_cache(maxsize=None)
def _adapter(model: type[BaseModel], key: str) -> TypeAdapter[Any] | None:
    field = model.model_fields[key]
    try:
        if field.metadata:
            return TypeAdapter(Annotated[(field.annotation, *field.metadata)])  # type: ignore[valid-type]
        return TypeAdapter(field.annotation)
    except Exception:  # noqa: BLE001 - an unbuildable type is treated as accepting
        return None


def _accepts(model: type[BaseModel], key: str, raw: Any) -> bool:
    """Whether this build's declared type and bounds for ``model.key`` accept ``raw``
    as stored (no repair needed)."""
    adapter = _adapter(model, key)
    if adapter is None:
        return True
    try:
        adapter.validate_python(copy.deepcopy(raw))
    except Exception:  # noqa: BLE001 - rejected: this build had to repair it
        return False
    return True
