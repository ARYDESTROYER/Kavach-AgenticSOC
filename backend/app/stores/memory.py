"""Operator MEMORY store — durable facts the agents remember (Claude.ai-style).

A MEMORY is a small TRUSTED operator fact ("10.0.0.0/8 is internal", "Nessus scans
run Sun 02:00 from 10.1.2.3", "bastion01 is a jump box") that is auto-injected into
BOTH automated investigations and chat so the LLM reasons WITH the operator's
knowledge. It NEVER overrides the deterministic case_manager — it only informs.

Backend-agnostic by construction: the whole memory set is ONE JSON list persisted
through the existing :class:`KVStore` abstraction (``ns="memory"``, ``key="entries"``)
— so it needs NO new ES index / SQL table / migration. The SQL backend uses
``SqlKVStore`` (the shared KV table); the ES backend uses the thin
:class:`EsKVStore` adapter below (a doc in the existing config index).

Writes use the shared KV compare-and-set mutation helper, so concurrent operators
cannot silently clobber each other's facts. The store NEVER raises: a load/save
failure degrades to an empty list / best-effort write and is logged, so a memory
glitch can never drop an alert or break chat.
"""

from __future__ import annotations

import asyncio
import copy
import logging
from typing import Any

from ..constants import (
    BATCH_JOBS_KEY,
    BATCH_JOBS_NS,
    CHAT_CONVERSATIONS_DOC_ID,
    CHAT_CONVERSATIONS_KEY,
    CHAT_CONVERSATIONS_NS,
    CONFIG_INDEX,
    JOBS_KEY,
    JOBS_NS,
    MEMORY_DOC_ID,
    MEMORY_KEY,
    MEMORY_NS,
    PROPOSALS_DOC_ID,
    PROPOSALS_KEY,
    PROPOSALS_NS,
    SESSIONS_DOC_ID,
    SESSIONS_KEY,
    SESSIONS_NS,
    USER_PREFS_DOC_ID,
    USER_PREFS_KEY,
    USER_PREFS_NS,
    USERS_DOC_ID,
    USERS_KEY,
    USERS_NS,
)
from ..es.base import BaseESClient
from ..models import MemoryEntry
from ..utils import iso_now
from .base import KVStore
from .base import kv_mutate_strict
from .update_operations import UPDATE_OPERATIONS_NS

logger = logging.getLogger("tlsoc.stores.memory")


class EsKVStore(KVStore):
    """A minimal :class:`KVStore` over an Elasticsearch client.

    The ES OWN-state backend has no generic KV table (config/cursor each call ES
    directly), so this adapter gives MemoryStore the SAME ``get/put`` contract the
    SQL backend already provides. Each (namespace, key) maps to a single doc in the
    existing ``CONFIG_INDEX`` (no new index), keyed ``<namespace>:<key>`` so it
    never collides with the preferences/cursor docs. Ordinary reads/writes fail soft;
    strict durability methods preserve backend failures."""

    def __init__(self, es: BaseESClient) -> None:
        self._es = es

    @staticmethod
    def _doc_id(namespace: str, key: str) -> str:
        # The memory singleton keeps a stable, readable id; any other ns/key gets a
        # composed id so this adapter is reusable for future KV needs.
        if namespace == MEMORY_NS and key == MEMORY_KEY:
            return MEMORY_DOC_ID
        if namespace == PROPOSALS_NS and key == PROPOSALS_KEY:
            return PROPOSALS_DOC_ID
        if namespace == USERS_NS and key == USERS_KEY:
            return USERS_DOC_ID
        if namespace == SESSIONS_NS and key == SESSIONS_KEY:
            return SESSIONS_DOC_ID
        if namespace == USER_PREFS_NS and key == USER_PREFS_KEY:
            return USER_PREFS_DOC_ID
        if namespace == CHAT_CONVERSATIONS_NS and key == CHAT_CONVERSATIONS_KEY:
            return CHAT_CONVERSATIONS_DOC_ID
        return f"{namespace}:{key}"

    async def get(self, namespace: str, key: str) -> dict[str, Any] | None:
        try:
            return await self._es.get_doc(CONFIG_INDEX, self._doc_id(namespace, key))
        except Exception as exc:  # noqa: BLE001 — memory is best-effort
            logger.warning("KV get(%s/%s) failed: %s", namespace, key, exc)
            return None

    async def put(self, namespace: str, key: str, value: dict[str, Any]) -> None:
        try:
            await self._es.index_doc(
                CONFIG_INDEX, value, doc_id=self._doc_id(namespace, key), refresh=True
            )
        except Exception as exc:  # noqa: BLE001 — memory is best-effort
            logger.warning("KV put(%s/%s) failed: %s", namespace, key, exc)

    async def get_strict(self, namespace: str, key: str) -> dict[str, Any] | None:
        """Variant for stores whose HTTP contract requires a confirmed read."""
        return await self._es.get_doc_strict(
            CONFIG_INDEX, self._doc_id(namespace, key)
        )

    async def put_strict(
        self, namespace: str, key: str, value: dict[str, Any]
    ) -> None:
        """Variant for stores that must surface persistence failures."""
        await self._es.index_doc(
            CONFIG_INDEX, value, doc_id=self._doc_id(namespace, key), refresh=True
        )

    async def put_if(
        self,
        namespace: str,
        key: str,
        value: dict[str, Any],
        expected_rev: int,
    ) -> bool:
        """Native backend CAS for best-effort KV mutations."""
        return await self._es.compare_and_set_doc(
            CONFIG_INDEX,
            self._doc_id(namespace, key),
            value,
            expected_rev,
            refresh=True,
        )

    async def put_if_strict(
        self,
        namespace: str,
        key: str,
        value: dict[str, Any],
        expected_rev: int,
    ) -> bool:
        """Native Elasticsearch CAS; backend errors propagate to strict callers."""
        return await self.put_if(namespace, key, value, expected_rev)

    async def _config_snapshot_strict(self) -> dict[str, dict[str, Any]]:
        """Read the complete config index through a stable management PIT."""
        pit_id = str(await self._es.open_state_pit(CONFIG_INDEX, "10m") or "")
        if not pit_id:
            raise RuntimeError(
                "strict factory purge requires a point-in-time config scan"
            )
        rows: dict[str, dict[str, Any]] = {}
        after: list[Any] | None = None
        try:
            while True:
                body: dict[str, Any] = {
                    "size": 500,
                    "track_total_hits": True,
                    "query": {"match_all": {}},
                    "sort": ["_shard_doc"],
                    "pit": {"id": pit_id, "keep_alive": "10m"},
                }
                if after is not None:
                    body["search_after"] = after
                response = await self._es.search(CONFIG_INDEX, body)
                pit_id = str(response.get("pit_id") or pit_id)
                hits = response.get("hits", {}).get("hits", [])
                if not isinstance(hits, list):
                    raise RuntimeError("config PIT search returned malformed hits")
                if not hits:
                    return rows
                for hit in hits:
                    if not isinstance(hit, dict) or not hit.get("_id"):
                        raise RuntimeError(
                            "config PIT search returned a hit without an id"
                        )
                    doc_id = str(hit["_id"])
                    source = hit.get("_source")
                    if not isinstance(source, dict):
                        raise RuntimeError(
                            f"config document {doc_id!r} is not a JSON object"
                        )
                    if doc_id in rows:
                        raise RuntimeError(
                            f"config PIT search repeated document {doc_id!r}"
                        )
                    rows[doc_id] = copy.deepcopy(source)
                marker = hits[-1].get("sort")
                if (
                    not isinstance(marker, list)
                    or len(marker) != 1
                    or marker == after
                ):
                    raise RuntimeError("config PIT search returned no stable cursor")
                after = list(marker)
        finally:
            await self._es.close_state_pit(pit_id)

    async def factory_purge_strict(self) -> int:
        """Delete all tenant config/KV docs except the three protected classes.

        The exact factory-fenced Jobs and Batch documents are mandatory.  A stable
        PIT avoids Elasticsearch's result-window limit; per-document strict deletes
        keep both control anchors continuously present if a later deletion fails.
        """
        jobs_id = self._doc_id(JOBS_NS, JOBS_KEY)
        batch_id = self._doc_id(BATCH_JOBS_NS, BATCH_JOBS_KEY)
        update_prefix = f"{UPDATE_OPERATIONS_NS}:"
        before = await self._config_snapshot_strict()
        if jobs_id not in before or batch_id not in before:
            raise RuntimeError(
                "factory purge requires durable Jobs and Batch fence documents"
            )
        protected = {
            doc_id: copy.deepcopy(source)
            for doc_id, source in before.items()
            if doc_id in {jobs_id, batch_id} or doc_id.startswith(update_prefix)
        }
        deleted = 0
        pending = [doc_id for doc_id in before if doc_id not in protected]
        for doc_id in pending:
            if await self._es.delete_doc_strict(
                CONFIG_INDEX, doc_id, refresh=True
            ):
                deleted += 1

        after = await self._config_snapshot_strict()
        if after != protected:
            retained = len(set(after) - set(protected))
            missing = len(set(protected) - set(after))
            changed = sum(
                after[doc_id] != protected[doc_id]
                for doc_id in set(after).intersection(protected)
            )
            raise RuntimeError(
                "factory KV purge verification failed "
                f"(retained={retained}, missing={missing}, changed={changed})"
            )
        return deleted


class MemoryStore:
    """CRUD over the operator-memory list, persisted as one KV document.

    The KV value is ``{"entries": [<MemoryEntry json>, ...]}``. Ordinary methods
    remain fail-soft; :meth:`list_strict` is the evidence/export boundary."""

    def __init__(self, kv: KVStore) -> None:
        self._kv = kv
        self._approval_lock = asyncio.Lock()

    async def _load(self) -> list[MemoryEntry]:
        try:
            doc = await self._kv.get(MEMORY_NS, MEMORY_KEY)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Loading memory failed (%s); using empty set", exc)
            return []
        if not doc:
            return []
        raw = doc.get("entries", []) if isinstance(doc, dict) else []
        out: list[MemoryEntry] = []
        for item in raw or []:
            try:
                out.append(MemoryEntry.model_validate(item))
            except Exception:  # noqa: BLE001 — skip a single corrupt entry, keep the rest
                continue
        return out

    async def _load_strict(self) -> list[MemoryEntry]:
        """Load every memory entry or raise when export completeness is unknown."""
        getter = getattr(self._kv, "get_strict", None) or self._kv.get
        doc = await getter(MEMORY_NS, MEMORY_KEY)
        if doc is None:
            return []
        if not isinstance(doc, dict):
            raise ValueError("memory registry is not a JSON object")
        raw = doc.get("entries", [])
        if not isinstance(raw, list):
            raise ValueError("memory registry entries are not a list")
        try:
            return [MemoryEntry.model_validate(item) for item in raw]
        except Exception as exc:  # noqa: BLE001 — strict evidence reads fail closed
            raise ValueError("memory registry contains an invalid entry") from exc

    async def _save(self, entries: list[MemoryEntry]) -> None:
        try:
            await self._kv.put(
                MEMORY_NS, MEMORY_KEY,
                {"entries": [e.model_dump(mode="json") for e in entries]},
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("Persisting memory failed (%s); continuing", exc)

    async def list(self, active_only: bool = True) -> list[MemoryEntry]:
        entries = await self._load()
        if active_only:
            entries = [e for e in entries if e.active]
        # Newest first so injection picks the most recent facts when bounded.
        return sorted(entries, key=lambda e: e.created_at, reverse=True)

    async def list_strict(self, active_only: bool = True) -> list[MemoryEntry]:
        """Newest-first memory, raising on unavailable or malformed persistence."""
        entries = await self._load_strict()
        if active_only:
            entries = [e for e in entries if e.active]
        return sorted(entries, key=lambda e: e.created_at, reverse=True)

    async def get(self, entry_id: str) -> MemoryEntry | None:
        for e in await self._load():
            if e.id == entry_id:
                return e
        return None

    async def add(
        self,
        text: str,
        category: str = "",
        tags: list[str] | None = None,
        source: str = "human",
        author: str = "",
        review_status: str | None = None,
        approved_by: str = "",
    ) -> MemoryEntry:
        source = source if source in ("human", "agent") else "human"
        status = review_status if review_status in ("approved", "pending") else (
            "pending" if source == "agent" else "approved"
        )
        now = iso_now()
        entry = MemoryEntry(
            text=(text or "").strip(),
            category=(category or "").strip(),
            tags=[str(t).strip() for t in (tags or []) if str(t).strip()],
            source=source,
            author=(author or "").strip(),
            review_status=status,
            approved_by=(approved_by or author or "").strip() if status == "approved" else "",
            approved_at=now if status == "approved" else "",
        )

        def _append(doc: dict[str, Any] | None) -> dict[str, Any]:
            rows = list((doc or {}).get("entries", []) or [])
            rows.append(entry.model_dump(mode="json"))
            return {"entries": rows}

        await self._kv.mutate(MEMORY_NS, MEMORY_KEY, _append)
        return entry

    async def add_approved_proposal_strict(
        self,
        text: str,
        *,
        proposal_id: str,
        category: str = "",
        tags: list[str] | None = None,
        author: str = "",
    ) -> MemoryEntry:
        """Persist one trusted proposal-derived fact exactly once or raise.

        Approval is a durability boundary: a fail-soft Memory write must never be
        reported as a successful approval. ``approval_proposal_id`` is the stable
        idempotency key used when an approval is replayed after an ambiguous finalise.
        """
        pid = str(proposal_id or "").strip()
        if not pid:
            raise ValueError("proposal_id is required for approved Memory")
        now = iso_now()
        candidate = MemoryEntry(
            text=(text or "").strip(),
            category=(category or "").strip(),
            tags=[str(t).strip() for t in (tags or []) if str(t).strip()],
            source="agent",
            author=(author or "").strip(),
            review_status="approved",
            approved_by=(author or "").strip(),
            approved_at=now,
            approval_proposal_id=pid,
        )
        selected: dict[str, MemoryEntry] = {"entry": candidate}

        def _append_once(doc: dict[str, Any] | None) -> dict[str, Any]:
            rows = list((doc or {}).get("entries", []) or [])
            for raw in rows:
                if not isinstance(raw, dict):
                    continue
                if str(raw.get("approval_proposal_id") or "") == pid:
                    selected["entry"] = MemoryEntry.model_validate(raw)
                    return {"entries": rows}
            rows.append(candidate.model_dump(mode="json"))
            selected["entry"] = candidate
            return {"entries": rows}

        await kv_mutate_strict(
            self._kv,
            MEMORY_NS,
            MEMORY_KEY,
            _append_once,
            lock=self._approval_lock,
        )
        return selected["entry"]

    async def update(self, entry_id: str, **fields: Any) -> MemoryEntry | None:
        updated: MemoryEntry | None = None
        allowed = {
            "text", "category", "tags", "active", "source", "author",
            "review_status", "approved_by",
        }

        def _update(doc: dict[str, Any] | None) -> dict[str, Any]:
            nonlocal updated
            rows = list((doc or {}).get("entries", []) or [])
            for idx, raw in enumerate(rows):
                try:
                    entry = MemoryEntry.model_validate(raw)
                except Exception:  # noqa: BLE001 — preserve unrelated corrupt rows
                    continue
                if entry.id != entry_id:
                    continue
                patch = {k: v for k, v in fields.items() if k in allowed and v is not None}
                if "tags" in patch and isinstance(patch["tags"], list):
                    patch["tags"] = [str(t).strip() for t in patch["tags"] if str(t).strip()]
                if patch.get("review_status") == "approved":
                    patch["approved_by"] = str(patch.get("approved_by") or "operator").strip()
                    patch["approved_at"] = iso_now()
                elif patch.get("review_status") == "pending":
                    patch["approved_by"] = ""
                    patch["approved_at"] = ""
                patch["updated_at"] = iso_now()
                updated = entry.model_copy(update=patch)
                rows[idx] = updated.model_dump(mode="json")
                break
            return {"entries": rows}

        await self._kv.mutate(MEMORY_NS, MEMORY_KEY, _update)
        return updated

    async def delete(self, entry_id: str) -> bool:
        removed = False

        def _delete(doc: dict[str, Any] | None) -> dict[str, Any]:
            nonlocal removed
            rows = list((doc or {}).get("entries", []) or [])
            kept: list[Any] = []
            for raw in rows:
                try:
                    is_match = MemoryEntry.model_validate(raw).id == entry_id
                except Exception:  # noqa: BLE001
                    is_match = False
                if is_match:
                    removed = True
                else:
                    kept.append(raw)
            return {"entries": kept}

        await self._kv.mutate(MEMORY_NS, MEMORY_KEY, _delete)
        return removed

    async def delete_by_text(self, text: str) -> list[MemoryEntry]:
        """Fuzzy 'forget …' helper: delete every entry whose text CONTAINS the given
        phrase (case-insensitive). Returns the removed entries. Used by the chat
        memory_action 'remove' path when no id is supplied."""
        needle = (text or "").strip().lower()
        if not needle:
            return []
        removed: list[MemoryEntry] = []

        def _delete(doc: dict[str, Any] | None) -> dict[str, Any]:
            nonlocal removed
            rows = list((doc or {}).get("entries", []) or [])
            kept: list[Any] = []
            for raw in rows:
                try:
                    entry = MemoryEntry.model_validate(raw)
                except Exception:  # noqa: BLE001
                    kept.append(raw)
                    continue
                if needle in entry.text.lower():
                    removed.append(entry)
                else:
                    kept.append(raw)
            return {"entries": kept}

        await self._kv.mutate(MEMORY_NS, MEMORY_KEY, _delete)
        return removed
