"""Best-effort settings-schema introspection (Wave 7 / F12).

Produces a JSON-serialisable description of the :class:`~app.config.Preferences`
sections + field types so the webui can render/group the settings forms generically
(instead of hard-coding every field). It is purely descriptive metadata derived from
the Pydantic models — it carries NO values, NO secrets, and NEVER affects behaviour.

The shape is intentionally simple + stable:

    {
      "sections": [
        {
          "key": "rag",                 # the Preferences attribute name
          "title": "RAG",               # humanised label
          "kind": "object",             # "object" (a nested model) | "group" (scalars)
          "model": "RagConfig",         # the pydantic model name for object sections
          "fields": [
            {"name": "enabled", "type": "boolean", "default": true,
             "required": false, "choices": null, "description": "..."},
            ...
          ]
        },
        ...
      ]
    }

``kind == "group"`` is the synthetic ``general`` bucket that collects the top-level
SCALAR / list / dict preferences that are not themselves nested models, so the UI
still has a home for ``data_view_pattern`` etc.

Round-5 Sett-C / Rules R7 — ELEMENT-MODEL DESCENT
-------------------------------------------------
The original reflector treated ``list[Model]`` and ``dict[str, Model]`` fields as
opaque ``array``/``object`` scalars that landed in the junk ``general`` bucket with no
way to describe their element shape, so *rule collections* (``rule_catalog`` /
``correlation_rules`` / ``suppression_rules`` / ``channels`` / ``asset_networks`` /
``rule_model_override`` …) were undescribable by the generic renderer.

We now DESCEND into element models WITHOUT changing the existing shape:
  - a ``list[Model]`` / ``dict[str, Model]`` field grows an additive ``element``
    descriptor ``{container, model, fields:[...]}`` (``container`` = ``"list"`` |
    ``"dict"``); the ``type`` stays ``"array"``/``"object"`` (byte-identical for old
    consumers), and the field STILL lands in ``general`` (its parent is
    ``Preferences``, not a nested model) — so no existing section moves.
  - a ``list[Model]`` / ``dict[str, Model]`` field on a NESTED section model
    (e.g. ``AutomationConfig.rules: list[CaseAutomationRule]``) likewise grows the
    ``element`` descriptor in place.

This is purely additive metadata: no new sections, no values beyond defaults, no
secrets, and it does NOT change ``PUT /api/settings`` deep-merge semantics.
"""

from __future__ import annotations

import enum
import typing
from typing import Any, get_args, get_origin

from pydantic import BaseModel
from pydantic.fields import FieldInfo

from ..config import Preferences

# Humanised titles for the known sections (falls back to a Title-Cased key).
_SECTION_TITLES: dict[str, str] = {
    "general": "General",
    "rag": "RAG",
    "rbac": "RBAC",
    "mfa": "Multi-Factor Auth",
    "sso": "Single Sign-On",
    "notifications": "Notifications",
    "branding": "Branding",
    "case_id_format": "Case ID Format",
    "cross_source_correlation": "Cross-Source Correlation",
    "threat_context": "Threat Context",
    "threshold_automation": "Threshold Automation",
    "auto_close": "Auto-Close Policy",
    "fp_auto_close": "Auto-Close (legacy)",
    "enrichment": "Enrichment",
    "personas": "Personas",
    "runbooks": "Runbooks",
    "playbooks": "Playbooks",
    "caps": "Caps / Kill Switch",
    "standup": "Standup",
    "trace": "Trace",
    "risk_weights": "Risk Weights",
    "default_correlation": "Default Correlation",
    # Round 3 additions.
    "sla": "SLA Policy",
    "priority_matrix": "Priority Matrix",
    "budget": "Cost Budget",
    "realtime": "Realtime Updates",
    "release_updates": "Release Updates",
    "storage_lifecycle": "Storage Lifecycle",
    "customization": "Customization",
    # Round 4 additions.
    "threshold_tuning": "Threshold Tuning",
    "batch": "Batch Inference",
    "baseline": "Anomaly Baseline",
    "campaign": "Campaign Clustering",
    # Rule-identity precedent (promotion / window fairness / futility reporting).
    "precedent": "Analyst Precedent",
}


def _humanise(key: str) -> str:
    return _SECTION_TITLES.get(key, key.replace("_", " ").title())


def _type_name(annotation: Any) -> str:
    """A coarse, UI-friendly type tag for one field annotation."""
    origin = get_origin(annotation)
    # Optional[X] / X | None — describe the non-None member.
    if origin is typing.Union:  # includes ``X | None``
        members = [a for a in get_args(annotation) if a is not type(None)]
        if len(members) == 1:
            return _type_name(members[0])
        return "union"
    if origin in (list, tuple, set, frozenset):
        return "array"
    if origin is dict:
        return "object"
    if annotation is bool:
        return "boolean"
    if annotation is int:
        return "integer"
    if annotation is float:
        return "number"
    if annotation is str:
        return "string"
    if isinstance(annotation, type):
        if issubclass(annotation, enum.Enum):
            return "enum"
        if issubclass(annotation, BaseModel):
            return "object"
    # Literal[...] surfaces as a typing special form.
    if get_origin(annotation) is typing.Literal:
        return "enum"
    return "string"


def _choices(annotation: Any) -> list[str] | None:
    """Enumerated choices for an enum / Literal field (else None)."""
    origin = get_origin(annotation)
    if origin is typing.Union:
        for a in get_args(annotation):
            if a is type(None):
                continue
            got = _choices(a)
            if got is not None:
                return got
        return None
    if get_origin(annotation) is typing.Literal:
        return [str(v) for v in get_args(annotation)]
    if isinstance(annotation, type) and issubclass(annotation, enum.Enum):
        return [str(getattr(m, "value", m)) for m in annotation]
    return None


def _element_model(annotation: Any) -> tuple[str, type[BaseModel]] | None:
    """For a ``list[Model]`` / ``set[Model]`` / ``tuple[Model, ...]`` or a
    ``dict[K, Model]`` annotation, return ``(container, ElementModel)`` where
    ``container`` is ``"list"`` or ``"dict"``; else ``None``.

    Unwraps ``Optional[...]`` first so ``list[Model] | None`` still descends. The
    element must be a concrete Pydantic model — ``list[str]`` / ``dict[str, float]``
    (scalar collections) return ``None`` and stay opaque, exactly as before."""
    origin = get_origin(annotation)
    # Unwrap Optional[...]/X|None to its single non-None member.
    if origin is typing.Union:
        members = [a for a in get_args(annotation) if a is not type(None)]
        if len(members) == 1:
            return _element_model(members[0])
        return None
    if origin in (list, set, frozenset, tuple):
        args = [a for a in get_args(annotation) if a is not Ellipsis]
        if args and isinstance(args[0], type) and issubclass(args[0], BaseModel):
            return ("list", args[0])
        return None
    if origin is dict:
        args = get_args(annotation)
        # dict value type is the second arg (dict[key, value]).
        if len(args) == 2 and isinstance(args[1], type) and issubclass(args[1], BaseModel):
            return ("dict", args[1])
        return None
    return None


def _default_for(field: FieldInfo, value: Any) -> Any:
    """A JSON-safe default for a field (prefers the live default value)."""
    try:
        if isinstance(value, BaseModel):
            return value.model_dump(mode="json")
        if isinstance(value, enum.Enum):
            return getattr(value, "value", str(value))
        # Round-trip through Pydantic's JSON-safe path for dates etc.
        import json

        json.dumps(value)
        return value
    except (TypeError, ValueError):
        return None


# Cap element-model descent so a hypothetical self-referential / cyclic model can never
# recurse unbounded. The real config needs 2 (rule_catalog → RuleDefinition →
# model_override → ModelConfig); we allow a little headroom. Beyond the cap the field is
# still described (type + default) but its `element` is omitted.
_MAX_ELEMENT_DEPTH = 4


def _describe_model_fields(model: type[BaseModel], depth: int = 0) -> list[dict[str, Any]]:
    """Describe every field of a Pydantic model, using a default instance for defaults
    where possible (falls back to ``None`` when the model has required fields and can't
    be default-constructed — the field descriptor's own ``default`` handles that).

    ``depth`` tracks the element-descent nesting so a cyclic model self-terminates."""
    try:
        inst: BaseModel | None = model()
    except Exception:  # noqa: BLE001 — required fields / validators; fall back to no live default
        inst = None
    return [
        _describe_field(fn, ff, getattr(inst, fn, None) if inst is not None else None, depth)
        for fn, ff in model.model_fields.items()
    ]


def _describe_field(
    name: str, field: FieldInfo, live_value: Any, depth: int = 0
) -> dict[str, Any]:
    ann = field.annotation
    desc: dict[str, Any] = {
        "name": name,
        "type": _type_name(ann),
        "default": _default_for(field, live_value),
        "required": field.is_required(),
        "choices": _choices(ann),
        "description": (field.description or "").strip() or None,
    }
    # DECLARED BOUNDS (additive; omitted when a field declares none, so every existing
    # descriptor is byte-identical). The schema-driven "Advanced (all settings)" renderer
    # is the only surface some sections have, and without these it offered an unbounded
    # integer control for a field the API now rejects below its floor — the operator only
    # learned the bound from a 422.
    for meta in field.metadata:
        for attr, out_key in (("ge", "minimum"), ("le", "maximum")):
            bound = getattr(meta, attr, None)
            if bound is None or out_key in desc:
                continue
            if isinstance(bound, bool):  # bools are ints in Python; never a bound
                continue
            try:
                desc[out_key] = bound if isinstance(bound, (int, float)) else float(bound)
            except (TypeError, ValueError):
                # A non-numeric constraint on an exotic annotated type. Describing the
                # field without a bound is always safe; failing the whole schema is not.
                continue
    # ELEMENT-MODEL DESCENT (additive): a list/dict OF a Pydantic model grows an
    # `element` descriptor so the generic renderer can describe rule collections. The
    # `type` above stays "array"/"object" (byte-identical for existing consumers).
    # Bounded by _MAX_ELEMENT_DEPTH so a self-referential model can't recurse forever.
    elem = _element_model(ann)
    if elem is not None and depth < _MAX_ELEMENT_DEPTH:
        container, elem_model = elem
        desc["element"] = {
            "container": container,
            "model": elem_model.__name__,
            "fields": _describe_model_fields(elem_model, depth + 1),
        }
    return desc


def _is_object_section(annotation: Any) -> bool:
    """True when a top-level field is itself a nested Pydantic model (its own section)."""
    return isinstance(annotation, type) and issubclass(annotation, BaseModel)


def settings_schema() -> dict[str, Any]:
    """Build the best-effort settings schema from :class:`Preferences`.

    Every top-level field that is a nested model becomes its own ``object`` section
    (with its sub-fields described); all remaining scalar/list/dict top-level fields
    are collected into a single synthetic ``general`` group section. Purely
    descriptive — no values beyond defaults, no secrets."""
    live = Preferences()
    object_sections: list[dict[str, Any]] = []
    general_fields: list[dict[str, Any]] = []

    for name, field in Preferences.model_fields.items():
        ann = field.annotation
        live_value = getattr(live, name, None)
        if _is_object_section(ann):
            sub_model: type[BaseModel] = ann  # type: ignore[assignment]
            sub_live = live_value if isinstance(live_value, BaseModel) else None
            if sub_live is None:
                try:
                    sub_live = sub_model()
                except Exception:  # noqa: BLE001
                    sub_live = None
            # Fields of a nested section model — element-model descent applies here too
            # (e.g. AutomationConfig.rules: list[CaseAutomationRule]).
            fields = [
                _describe_field(fn, ff, getattr(sub_live, fn, None) if sub_live is not None else None)
                for fn, ff in sub_model.model_fields.items()
            ]
            object_sections.append(
                {
                    "key": name,
                    "title": _humanise(name),
                    "kind": "object",
                    "model": sub_model.__name__,
                    "fields": fields,
                }
            )
        else:
            general_fields.append(_describe_field(name, field, live_value))

    sections: list[dict[str, Any]] = []
    if general_fields:
        sections.append(
            {
                "key": "general",
                "title": _humanise("general"),
                "kind": "group",
                "model": None,
                "fields": general_fields,
            }
        )
    sections.extend(object_sections)
    return {"sections": sections}


def section_keys() -> set[str]:
    """The set of valid single-subtree keys for ``GET /api/settings/{section}``
    (every top-level Preferences attribute name)."""
    return set(Preferences.model_fields.keys())
