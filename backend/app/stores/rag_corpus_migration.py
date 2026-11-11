"""The marker contract for an intentional migration of one RAG knowledge source.

A release that deliberately replaces a source's chunks (its document ids change shape
and its chunk count changes by design) records the migration here. The projection
guard (``RagService._guard_projection_collapse``) reads the marker so that a build on
EITHER side of the migration, an upgrade or an image-only rollback, does not mistake
the other build's corpus for a shrink of its own source.

Contract version 1, one KV document per source under ``rag_corpus_migration/<source>``
(the existing state-backend KV: no new ES index, SQL table or migration). The document
holds one opaque canonical-JSON string under the fixed field
``rag_corpus_migration_json`` (the reports-store rule, so the shared Elasticsearch
config index never maps the marker's fields); decoded, it reads::

    {"contract": 1,
     "source": "runbook",                       # the knowledge source
     "scheme": "runbook-library:",              # the document-id prefix the writer projects
     "replaced": ["runbook:", "seed:runbook"],  # the prefixes it replaced on purpose
     "app_version": "0.1.13", "build_sha": "...",  # the writing build
     "written_at": "<iso>"}

``source``, ``scheme`` and ``replaced`` keep their meaning in every later contract
version, and a reader ignores fields it does not know. A writer whose migration
replaces an earlier one keeps the earlier schemes in ``replaced`` (cumulative), so a
build two migrations back still finds its own scheme named.

What the marker licenses, and only that: the stored chunks of the marked source whose
ids belong to one of the marker's schemes OTHER than the reading build's own are an
expected state, so the retention-floor comparison leaves them out (the projection then
replaces them). The zero-projection refusal is untouched and absolute, and a source
without a marker, or a marker that does not name the reading build's scheme, is
guarded exactly as before.

Advisory plumbing only: nothing here feeds ``case_manager.decide()`` (#3), and no chunk
text, case id, secret or prompt is stored (#9). The guard's reads fail closed for the
corpus (an unreadable marker reads as absent, so the guard stays strict). Recording is
the opposite: it reads strictly and writes nothing when that read fails, so a transient
error never mistakes a newer build's marker for an absent one and overwrites it. The
write is a compare-and-set (``kv_mutate_strict``), so a concurrent writer is merged, not
lost.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from ..build_identity import current_record_provenance
from ..constants import RAG_CORPUS_MIGRATION_NS
from ..utils import iso_now
from .base import KVStore, kv_mutate_strict

logger = logging.getLogger("tlsoc.stores.rag_corpus_migration")

#: The marker contract version this build writes.
CORPUS_MIGRATION_CONTRACT = 1
#: The one field of a stored marker document: the marker as canonical JSON.
MARKER_FIELD = "rag_corpus_migration_json"
_MAX_SCHEMES = 32
_MAX_SCHEME_CHARS = 120


class CorpusMigrationMarker:
    """One decoded marker: the source, the writer's scheme and the replaced schemes."""

    __slots__ = ("source", "scheme", "replaced", "raw")

    def __init__(
        self, source: str, scheme: str, replaced: tuple[str, ...], raw: dict[str, Any]
    ) -> None:
        self.source = source
        self.scheme = scheme
        self.replaced = replaced
        self.raw = raw

    @property
    def schemes(self) -> frozenset[str]:
        """Every document-id scheme the marker names for its source."""
        return frozenset((self.scheme, *self.replaced))

    def names(self, scheme: str) -> bool:
        return scheme in self.schemes


def _scheme_list(value: Any) -> tuple[str, ...] | None:
    if not isinstance(value, list):
        return None
    out: list[str] = []
    for item in value[:_MAX_SCHEMES]:
        if not isinstance(item, str) or not item or len(item) > _MAX_SCHEME_CHARS:
            return None
        if item not in out:
            out.append(item)
    return tuple(out)


def encode_marker(marker: dict[str, Any]) -> dict[str, Any]:
    """The stored document of a marker (see the module docstring)."""
    return {MARKER_FIELD: json.dumps(marker, sort_keys=True, separators=(",", ":"))}


def decode_marker(source: str, stored: Any) -> CorpusMigrationMarker | None:
    """A stored marker for ``source``, or ``None`` when absent or unreadable (any
    contract version whose ``source``, ``scheme`` and ``replaced`` are readable)."""
    if not isinstance(stored, dict) or not isinstance(stored.get(MARKER_FIELD), str):
        return None
    try:
        doc = json.loads(stored[MARKER_FIELD])
    except (TypeError, ValueError):
        return None
    if not isinstance(doc, dict):
        return None
    scheme = doc.get("scheme")
    replaced = _scheme_list(doc.get("replaced", []))
    if (
        doc.get("source") != source
        or not isinstance(scheme, str)
        or not scheme
        or len(scheme) > _MAX_SCHEME_CHARS
        or replaced is None
    ):
        return None
    return CorpusMigrationMarker(
        source, scheme, tuple(item for item in replaced if item != scheme), dict(doc)
    )


def scheme_of(document_id: str, schemes: frozenset[str] | set[str]) -> str | None:
    """The longest scheme ``document_id`` starts with, or ``None``."""
    best: str | None = None
    for scheme in schemes:
        if document_id.startswith(scheme) and (best is None or len(scheme) > len(best)):
            best = scheme
    return best


class RagCorpusMigrationStore:
    """Read and record the corpus-migration marker of one knowledge source."""

    def __init__(self, kv: KVStore) -> None:
        self._kv = kv
        self._lock = asyncio.Lock()

    async def read(self, source: str) -> CorpusMigrationMarker | None:
        """The marker of ``source``; ``None`` when absent or unreadable."""
        try:
            doc = await self._kv.get(RAG_CORPUS_MIGRATION_NS, source)
        except Exception as exc:  # noqa: BLE001 - absent keeps the guard strict
            logger.warning("RAG corpus migration marker for %s unreadable: %s", source, exc)
            return None
        return decode_marker(source, doc)

    async def _read_strict(self, source: str) -> CorpusMigrationMarker | None:
        """The marker of ``source``; raises when the read itself fails (a fail-soft
        backend read would turn an error into "absent")."""
        getter = getattr(self._kv, "get_strict", None) or self._kv.get
        return decode_marker(source, await getter(RAG_CORPUS_MIGRATION_NS, source))

    async def record(
        self, source: str, *, scheme: str, replaced: tuple[str, ...] | list[str]
    ) -> CorpusMigrationMarker | None:
        """Record that this build projects ``source`` under ``scheme`` and replaced
        ``replaced`` on purpose. Idempotent: a stored marker that already names
        ``scheme`` is kept as it is (a newer build's marker carries more and is never
        overwritten by an older build). A stored marker that does not name it is
        superseded, its schemes kept in ``replaced``. Returns the marker now in force,
        or ``None`` when it could not be read or written (nothing is written then, and
        the next start retries)."""
        try:
            current = await self._read_strict(source)
        except Exception as exc:  # noqa: BLE001 - never overwrite what could not be read
            logger.warning(
                "RAG corpus migration marker for %s unreadable; not recorded: %s", source, exc
            )
            return None
        if current is not None and current.names(scheme):
            return current
        box: dict[str, Any] = {}

        def merge(stored: dict[str, Any] | None) -> dict[str, Any]:
            latest = decode_marker(source, stored)
            if latest is not None and latest.names(scheme):
                box["marker"] = latest  # a concurrent writer already recorded it
                box.pop("merged", None)  # an earlier attempt's merge did not stand
                return {MARKER_FIELD: stored[MARKER_FIELD]}  # type: ignore[index]
            earlier: list[str] = list(replaced)
            if latest is not None:
                earlier.extend(latest.schemes)
            merged = tuple(
                dict.fromkeys(item for item in earlier if item and item != scheme)
            )
            doc: dict[str, Any] = {
                "contract": CORPUS_MIGRATION_CONTRACT,
                "source": source,
                "scheme": scheme,
                "replaced": list(merged[:_MAX_SCHEMES]),
                **current_record_provenance(),
                "written_at": iso_now(),
            }
            encoded = encode_marker(doc)
            box["marker"] = decode_marker(source, encoded)
            box["merged"] = merged
            return encoded

        try:
            await kv_mutate_strict(
                self._kv, RAG_CORPUS_MIGRATION_NS, source, merge, lock=self._lock
            )
        except Exception as exc:  # noqa: BLE001 - best effort; the next start retries
            logger.warning("RAG corpus migration marker for %s not written: %s", source, exc)
            return None
        if "merged" in box:
            logger.info(
                "Recorded the %s corpus migration: scheme %s replaces %s",
                source, scheme, ", ".join(box["merged"]) or "nothing",
            )
        return box.get("marker")
