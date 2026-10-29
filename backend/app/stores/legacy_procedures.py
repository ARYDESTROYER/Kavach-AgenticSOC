"""Read-only decoder of the two retired procedure namespaces (Round 14 SPEC §4.10.6).

Before Round 14 operator procedures lived in two strict-CAS KV documents, one per
feature: ``(PLAYBOOKS_NS, PLAYBOOKS_KEY)`` and ``(RUNBOOKS_NS, RUNBOOKS_KEY)``, each a
bounded ``{"documents": {<id>: {content, revision, ...}}}`` map. Round 14 merges both
into the one runbook library; the legacy documents stay untouched and readable for
one release (rollback finds them as they were, §4.10.17 step 9) and are read ONLY
through this module:

* the one-shot migration (``engine.runbook_migration``) converts them, and
* the legacy export groups (``routes_export``) keep exporting them for one release.

This module has NO write method, by design: nothing in Round 14 may change a legacy
document. It re-implements the decode rules of the retired stores
(``stores/playbooks.py`` and ``stores/runbooks.py``) so those modules can be deleted
without breaking either reader (a test runs the migration with them absent).

Two read modes:

* ``list_*_strict()`` keep the retired stores' ``list_strict`` contract exactly: the
  complete catalog or :class:`LegacyCatalogDamaged`, never a partial projection that
  silently drops a damaged sibling (what an export must never do).
* ``scan_*()`` return every readable document AND a report of each damaged one, so the
  migration converts what it can and audits what it cannot (nothing is dropped
  silently).

A storage failure (the KV backend could not answer) always raises
:class:`LegacyStoreUnavailable`: the caller retries later instead of reading an
outage as "no documents".
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from ..constants import PLAYBOOKS_KEY, PLAYBOOKS_NS, RUNBOOKS_KEY, RUNBOOKS_NS
from .base import KVStore

LegacyNamespace = Literal["playbooks", "runbooks"]

#: The retired namespaces, in the order the migration reads them (procedures first,
#: so a reference runbook that shares an id becomes ``<id>-reference``, §4.10.17).
LEGACY_NAMESPACES: tuple[LegacyNamespace, ...] = (PLAYBOOKS_NS, RUNBOOKS_NS)  # type: ignore[assignment]
_KEYS: dict[str, str] = {PLAYBOOKS_NS: PLAYBOOKS_KEY, RUNBOOKS_NS: RUNBOOKS_KEY}
_LABELS: dict[str, str] = {
    PLAYBOOKS_NS: "operator procedure catalog",
    RUNBOOKS_NS: "operator reference runbook catalog",
}


class LegacyStoreUnavailable(RuntimeError):
    """The KV backend could not prove what a legacy document holds."""


class LegacyCatalogDamaged(ValueError):
    """A strict read found a document it cannot decode (the retired stores'
    ``list_strict`` refused it the same way)."""


@dataclass(frozen=True)
class LegacyDocument:
    """One readable legacy document. ``content`` is the stored Markdown, verbatim;
    ``row`` is the whole stored row (unknown fields kept)."""

    namespace: str
    id: str
    content: str
    revision: int
    created_at: str = ""
    updated_at: str = ""
    created_by: str = ""
    updated_by: str = ""
    row: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class LegacyDamage:
    """A stored entry that could not be decoded, and why (plain text)."""

    namespace: str
    id: str
    reason: str


@dataclass(frozen=True)
class LegacyScan:
    """Everything one legacy namespace holds: the readable documents (in stored order)
    and the damaged entries. ``present`` is False when the KV document never existed."""

    namespace: str
    documents: tuple[LegacyDocument, ...] = ()
    damaged: tuple[LegacyDamage, ...] = ()
    present: bool = False
    pending_deletes: tuple[str, ...] = ()


def _revision(value: Any) -> int:
    """The retired stores' revision rule: ``max(1, int(value or 1))``."""
    return max(1, int(value if value not in (None, "") else 1))


def _decode_row(namespace: str, doc_id: Any, value: Any) -> LegacyDocument | str:
    """One stored entry as a :class:`LegacyDocument`, or the reason it is damaged.

    The rules are the retired stores' ``_decode_strict``: the id is a non-empty string
    without surrounding whitespace, the value an object whose ``content`` is non-blank
    text, and the revision an integer."""
    if not isinstance(doc_id, str) or not doc_id or doc_id.strip() != doc_id:
        return "The stored id is empty or has surrounding spaces."
    if not isinstance(value, dict):
        return "The stored entry is not an object."
    content = value.get("content")
    if not isinstance(content, str) or not content.strip():
        return "The stored entry has no text."
    try:
        revision = _revision(value.get("revision", 1))
    except (TypeError, ValueError):
        return "The stored revision is not a whole number."
    return LegacyDocument(
        namespace=namespace,
        id=doc_id,
        content=content,
        revision=revision,
        created_at=str(value.get("created_at") or ""),
        updated_at=str(value.get("updated_at") or ""),
        created_by=str(value.get("created_by") or ""),
        updated_by=str(value.get("updated_by") or ""),
        row=dict(value),
    )


class LegacyProcedureReader:
    """Read-only access to the retired ``playbooks`` and ``runbooks`` KV documents.

    Constructed over the shared KV (``LegacyProcedureReader(state.kv)``). There is no
    write method; the class never calls ``put``/``put_if``/``mutate`` on the KV."""

    def __init__(self, kv: KVStore) -> None:
        self._kv = kv

    async def _raw(self, namespace: str) -> dict[str, Any] | None:
        getter = getattr(self._kv, "get_strict", None) or self._kv.get
        try:
            doc = await getter(namespace, _KEYS[namespace])
        except Exception as exc:  # noqa: BLE001 - an outage is never "no documents"
            raise LegacyStoreUnavailable(
                f"The {_LABELS[namespace]} could not be read."
            ) from exc
        return doc

    async def scan(self, namespace: str) -> LegacyScan:
        """Every readable document of ``namespace`` plus a report of each damaged
        entry (the migration's read). Raises :class:`LegacyStoreUnavailable` on a
        storage failure and ``KeyError`` for an unknown namespace."""
        if namespace not in _KEYS:
            raise KeyError(namespace)
        doc = await self._raw(namespace)
        if doc is None:
            return LegacyScan(namespace=namespace)
        if not isinstance(doc, dict):
            return LegacyScan(
                namespace=namespace,
                present=True,
                damaged=(LegacyDamage(namespace, "*", "The stored catalog is not an object."),),
            )
        raw = doc.get("documents", {})
        pending_raw = doc.get("pending_deletes", [])
        pending = tuple(
            str(v) for v in (pending_raw if isinstance(pending_raw, list) else [])
            if isinstance(v, str) and v.strip()
        )
        if not isinstance(raw, dict):
            return LegacyScan(
                namespace=namespace,
                present=True,
                pending_deletes=pending,
                damaged=(LegacyDamage(namespace, "*", "The stored documents are not an object."),),
            )
        documents: list[LegacyDocument] = []
        damaged: list[LegacyDamage] = []
        for doc_id, value in raw.items():
            decoded = _decode_row(namespace, doc_id, value)
            if isinstance(decoded, LegacyDocument):
                documents.append(decoded)
            else:
                damaged.append(LegacyDamage(namespace, str(doc_id)[:200], decoded))
        return LegacyScan(
            namespace=namespace,
            documents=tuple(documents),
            damaged=tuple(damaged),
            present=True,
            pending_deletes=pending,
        )

    async def scan_playbooks(self) -> LegacyScan:
        return await self.scan(PLAYBOOKS_NS)

    async def scan_runbooks(self) -> LegacyScan:
        return await self.scan(RUNBOOKS_NS)

    async def _list_strict(self, namespace: str) -> dict[str, dict[str, Any]]:
        scan = await self.scan(namespace)
        if scan.damaged:
            raise LegacyCatalogDamaged(
                f"The {_LABELS[namespace]} contains an invalid document."
            )
        out: dict[str, dict[str, Any]] = {}
        for d in scan.documents:
            row: dict[str, Any] = {
                **d.row,
                "content": d.content,
                "revision": d.revision,
                "created_at": d.created_at,
                "updated_at": d.updated_at,
                "created_by": d.created_by,
                "updated_by": d.updated_by,
            }
            if namespace == RUNBOOKS_NS:
                # The retired reference-runbook store also normalised its index fields.
                try:
                    indexed = max(0, int(d.row.get("indexed_revision", 0) or 0))
                except (TypeError, ValueError) as exc:
                    raise LegacyCatalogDamaged(
                        f"The {_LABELS[namespace]} contains an invalid document."
                    ) from exc
                row.update({
                    "index_status": str(d.row.get("index_status") or "pending"),
                    "indexed_revision": indexed,
                    "last_indexed_at": str(d.row.get("last_indexed_at") or ""),
                    "index_error": str(d.row.get("index_error") or ""),
                })
            out[d.id] = row
        return out

    async def list_playbooks_strict(self) -> dict[str, dict[str, Any]]:
        """``id -> row`` of the retired operator procedure catalog, exactly as the
        retired store's ``list_strict`` returned it, or :class:`LegacyCatalogDamaged`
        (never a partial projection)."""
        return await self._list_strict(PLAYBOOKS_NS)

    async def list_runbooks_strict(self) -> dict[str, dict[str, Any]]:
        """``id -> row`` of the retired operator reference runbook catalog (index
        status fields kept as stored), or :class:`LegacyCatalogDamaged`."""
        return await self._list_strict(RUNBOOKS_NS)
