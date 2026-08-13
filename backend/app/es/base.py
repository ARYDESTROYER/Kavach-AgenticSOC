"""Abstract Elasticsearch client interface.

The engine and stores depend on this interface, never on a concrete client. That
is what lets the test suite swap in an in-memory fake, and what keeps the
read-only/management credential split explicit and auditable.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class BaseESClient(ABC):
    # Effective lifecycle provider. A local in-memory fallback must never be
    # reported as a persistent Elasticsearch cluster merely because
    # ``Secrets.state_backend`` still carries its configured value.
    storage_lifecycle_backend = "unsupported"

    # --- health ---
    @abstractmethod
    async def ping(self) -> bool: ...

    async def ping_state(self) -> bool:
        """Probe the suite's OWN-state path.

        The default preserves compatibility for test and third-party clients. The
        real two-key client overrides it so readiness requires the management
        credential, not merely a reachable read-only log surface.
        """
        return await self.ping()

    async def write_state_probe(self) -> bool:
        """Prove the suite's management path can persist, not merely connect.

        The fixed document is intentionally tiny and overwritten on each readiness
        probe.  ``refresh=False`` avoids forcing an Elasticsearch refresh cycle.
        Implementations may override this when their state surface differs.
        """
        await self.index_doc(
            "tlsoc-agent-config",
            {"kind": "readiness_probe", "schema": 1},
            doc_id="_readiness",
            refresh=False,
        )
        return True

    # --- READ-ONLY log surface (scoped read-only key ONLY) ---
    @abstractmethod
    async def search_logs(self, index: str, body: dict[str, Any]) -> dict[str, Any]:
        """Search the configured log indices. Read-only. This is the agent's only
        path to log data (Section 6.5, es_query tool)."""

    async def open_log_pit(self, index: str, keep_alive: str = "1m") -> str | None:
        """Open a read-only point-in-time view for stable pull pagination.

        Optional by design: third-party/older compatible clients can return None
        and the connector uses bounded offset pagination instead.
        """
        return None

    async def close_log_pit(self, pit_id: str) -> None:
        """Close a PIT opened by :meth:`open_log_pit` (optional no-op)."""
        return None

    async def open_state_pit(self, index: str, keep_alive: str = "10m") -> str | None:
        """Open a point-in-time view over an OWN-state index pattern.

        Full-history exports use this optional capability with ``search_after`` so
        append-only ledgers can grow while an operator downloads them without
        duplicates, omissions, or Elasticsearch's 10k result-window ceiling.
        Third-party clients may return ``None``; callers must then describe their
        result as bounded/best-effort rather than an exact point-in-time snapshot.
        """
        return None

    async def close_state_pit(self, pit_id: str) -> None:
        """Close an OWN-state PIT (optional no-op; PITs also expire server-side)."""
        return None

    # --- MANAGEMENT: the suite's OWN indices (scoped management key) ---
    @abstractmethod
    async def index_template_exists(self, name: str) -> bool: ...

    @abstractmethod
    async def put_index_template(self, name: str, body: dict[str, Any]) -> None: ...

    @abstractmethod
    async def index_exists(self, name: str) -> bool: ...

    @abstractmethod
    async def create_index(self, name: str, body: dict[str, Any] | None = None) -> None: ...

    @abstractmethod
    async def index_doc(
        self,
        index: str,
        doc: dict[str, Any],
        doc_id: str | None = None,
        refresh: bool = False,
    ) -> str:
        """Index (create or overwrite) a document. Returns the document id."""

    async def create_doc_strict(
        self,
        index: str,
        doc_id: str,
        doc: dict[str, Any],
        refresh: bool = False,
    ) -> bool:
        """Create one owned-state document, returning False on an id conflict.

        Bundled clients override this atomically.  The compatibility fallback keeps
        third-party clients working but is only safe under caller-owned serialization.
        Every backend failure other than an existing id propagates.
        """

        if await self.get_doc_strict(index, doc_id) is not None:
            return False
        await self.index_doc(index, doc, doc_id=doc_id, refresh=refresh)
        return True

    @abstractmethod
    async def get_doc(self, index: str, doc_id: str) -> dict[str, Any] | None: ...

    async def get_doc_strict(self, index: str, doc_id: str) -> dict[str, Any] | None:
        """Read owned state while preserving backend failures for strict callers.

        Compatible clients may inherit the ordinary read. The bundled real client
        overrides this because its legacy ``get_doc`` intentionally fails soft.
        """
        return await self.get_doc(index, doc_id)

    async def compare_and_set_doc(
        self,
        index: str,
        doc_id: str,
        doc: dict[str, Any],
        expected_rev: int,
        refresh: bool = False,
    ) -> bool:
        """Conditionally replace one owned-state document by its embedded revision.

        This compatibility implementation is a read/check/write sequence and is only
        safe under a caller-owned in-process lock.  The bundled Elasticsearch and
        in-memory clients override it with an atomic implementation; older third-party
        clients can continue to function without implementing a new abstract method.
        Backend failures propagate.  ``False`` means another writer moved the document.
        """
        current = await self.get_doc_strict(index, doc_id)
        try:
            current_rev = int((current or {}).get("_rev", 0) or 0)
        except (TypeError, ValueError):
            current_rev = 0
        if current_rev != int(expected_rev):
            return False
        await self.index_doc(index, doc, doc_id=doc_id, refresh=refresh)
        return True

    async def delete_index_strict(self, name: str) -> bool:
        """Delete one owned-state index/pattern without masking backend failure.

        ``False`` means the target was already absent.  Bundled clients implement
        this against the management credential; compatibility clients must opt in
        explicitly rather than inheriting a fail-soft deletion at a destructive
        privacy boundary.
        """
        raise NotImplementedError(
            "Elasticsearch client does not implement strict owned-index deletion"
        )

    async def delete_doc_strict(
        self,
        index: str,
        doc_id: str,
        refresh: bool = False,
    ) -> bool:
        """Delete one owned-state document without masking backend failure.

        ``False`` is reserved for a real missing document/index.  Authorization,
        connectivity, cluster, and every other failure must propagate.
        """
        raise NotImplementedError(
            "Elasticsearch client does not implement strict owned-document deletion"
        )

    @abstractmethod
    async def update_doc(
        self,
        index: str,
        doc_id: str,
        doc: dict[str, Any],
        refresh: bool = False,
    ) -> None:
        """Upsert a document (used for the single-doc config/cursor indices and
        for case updates)."""

    @abstractmethod
    async def search(self, index: str, body: dict[str, Any]) -> dict[str, Any]:
        """Search a management index (cases/audit/usage). Never the log surface."""

    @abstractmethod
    async def count(self, index: str, body: dict[str, Any]) -> int: ...

    # --- OPTIONAL OWN-index lifecycle management -------------------------
    # Narrow, typed methods only: callers may manage Agentic SOC's allow-listed
    # append-only indices, never issue arbitrary requests against source logs.
    async def index_lifecycle_capabilities(self) -> dict[str, Any]:
        """Return ILM privilege/tier readiness without mutating cluster state."""
        return {
            "supported": False,
            "can_manage": False,
            "privileged": False,
            "index_privileged": False,
            "hot_ready": False,
            "warm_ready": False,
            "roles": [],
            "reason": "Index lifecycle management is unavailable for this client.",
        }

    async def supports_index_lifecycle(self) -> bool:
        caps = await self.index_lifecycle_capabilities()
        return bool(caps.get("supported"))

    async def put_index_lifecycle_policy(self, name: str, body: dict[str, Any]) -> None:
        raise RuntimeError("Index lifecycle management is unavailable for this client.")

    async def get_index_lifecycle_policy(self, name: str) -> dict[str, Any] | None:
        return None

    async def get_owned_index_lifecycle_attachment(
        self, base: str, policy_name: str
    ) -> dict[str, Any]:
        """Read one allow-listed owned-index template/attachment state.

        Concrete clients must reject arbitrary bases.  The default is explicitly
        unverified so status callers can never infer active lifecycle from a policy
        document alone.
        """
        return {
            "verified": False,
            "template_attached": False,
            "indices_total": 0,
            "indices_attached": 0,
            "all_existing_indices_attached": False,
            "attached": False,
            "reason": "Lifecycle attachment inspection is unavailable for this client.",
        }

    async def index_lifecycle_policy_exists(self, name: str) -> bool:
        return await self.get_index_lifecycle_policy(name) is not None

    async def delete_index_lifecycle_policy(self, name: str) -> None:
        raise RuntimeError("Index lifecycle management is unavailable for this client.")

    async def put_index_settings(self, index: str, settings: dict[str, Any]) -> None:
        raise RuntimeError("Index lifecycle management is unavailable for this client.")

    async def remove_index_lifecycle(self, index: str) -> None:
        raise RuntimeError("Index lifecycle management is unavailable for this client.")

    @abstractmethod
    async def close(self) -> None: ...
