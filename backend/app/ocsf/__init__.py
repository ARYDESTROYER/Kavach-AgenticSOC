"""OCSF — the canonical internal event schema (AGNOSTIC_ARCHITECTURE.md §3).

Every connector normalises its source-native records into an :class:`OCSFEvent`
before the engine sees them, so the agents reason over ONE vocabulary regardless
of whether the alert came from Elasticsearch, Splunk, CrowdStrike or a raw syslog
line. OCSF is self-describing (``category → class → type_uid → activity_id``),
which is the most LLM-friendly representation: the event *class* tells the model
what happened before it reads a single field.

The public surface:
  * :class:`OCSFEvent` (+ nested objects) — the pinned-version event model.
  * :func:`ecs_to_ocsf` — maps an Elasticsearch/ECS ``_source`` doc to OCSF.
  * :func:`generic_to_ocsf` — best-effort mapping for arbitrary JSON (webhooks,
    queues) that already looks ECS/OCSF-ish or is wholly unknown.
"""

from __future__ import annotations

from .ecs import ecs_to_ocsf, generic_to_ocsf
from .identity import native_event_uid, source_scoped_event_uid
from .model import (
    Device,
    Endpoint,
    Metadata,
    OCSFEvent,
    Observable,
    Product,
    User,
    project_severity_magnitude,
    resolve_severity_scale_max,
    score_to_severity_id,
    severity_id_to_score,
)

__all__ = [
    "OCSFEvent",
    "Metadata",
    "Product",
    "Endpoint",
    "User",
    "Device",
    "Observable",
    "ecs_to_ocsf",
    "generic_to_ocsf",
    "native_event_uid",
    "source_scoped_event_uid",
    "severity_id_to_score",
    "score_to_severity_id",
    "project_severity_magnitude",
    "resolve_severity_scale_max",
]
