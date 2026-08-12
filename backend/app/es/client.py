"""Concrete Elasticsearch client backed by the official async driver.

Holds TWO physically separate connections:

* ``_ro`` authenticates with the read-only, log-scoped API key and backs
  ``search_logs`` only.
* ``_mgmt`` authenticates with the management key (scoped to ``tlsoc-agent-*``)
  and backs every write / bookkeeping operation.

If a key is missing the corresponding connection is ``None`` and its operations
raise a clear, actionable error rather than silently escalating.
"""

from __future__ import annotations

import logging
from typing import Any

from ..config import Secrets
from ..constants import AUDIT_INDEX, USAGE_INDEX
from .base import BaseESClient

logger = logging.getLogger("tlsoc.es")

try:  # The driver is optional at import time so tests can run with the fake.
    from elasticsearch import AsyncElasticsearch
    from elasticsearch import exceptions as es_exceptions

    _DRIVER_AVAILABLE = True
except Exception:  # pragma: no cover - exercised only when driver absent
    AsyncElasticsearch = None  # type: ignore[assignment]
    es_exceptions = None  # type: ignore[assignment]
    _DRIVER_AVAILABLE = False


def _elastic_status(exc: Exception) -> int | None:
    """Extract an HTTP status from official-driver and test-double exceptions."""
    status = getattr(exc, "status_code", None)
    if status is None:
        status = getattr(getattr(exc, "meta", None), "status", None)
    try:
        return int(status) if status is not None else None
    except (TypeError, ValueError):
        return None


def _is_not_found(exc: Exception) -> bool:
    return bool(
        (es_exceptions and isinstance(exc, es_exceptions.NotFoundError))
        or _elastic_status(exc) == 404
    )


def _is_conflict(exc: Exception) -> bool:
    return bool(
        (es_exceptions and isinstance(exc, es_exceptions.ConflictError))
        or _elastic_status(exc) == 409
    )


class RealESClient(BaseESClient):
    storage_lifecycle_backend = "elasticsearch"
    _LIFECYCLE_INDEX_PATTERNS = (f"{AUDIT_INDEX}-*", f"{USAGE_INDEX}-*")

    def __init__(self, secrets: Secrets) -> None:
        if not _DRIVER_AVAILABLE:
            raise RuntimeError("elasticsearch driver not installed; install requirements.txt")
        self._secrets = secrets
        common: dict[str, Any] = {
            "request_timeout": secrets.es_request_timeout,
            "verify_certs": secrets.es_verify_certs,
        }
        if secrets.es_ca_cert:
            common["ca_certs"] = secrets.es_ca_cert

        self._ro: AsyncElasticsearch | None = None
        self._mgmt: AsyncElasticsearch | None = None
        if secrets.es_api_key:
            self._ro = AsyncElasticsearch(secrets.es_url, api_key=secrets.es_api_key, **common)
        if secrets.es_mgmt_api_key:
            self._mgmt = AsyncElasticsearch(
                secrets.es_url, api_key=secrets.es_mgmt_api_key, **common
            )
        elif secrets.es_api_key:
            # No dedicated management key: the suite cannot own its indices with a
            # read-only key. We do NOT silently fall back to a write credential.
            logger.warning(
                "ES_MGMT_API_KEY not set: the backend cannot persist its own indices. "
                "Provide a management key scoped to tlsoc-agent-* (see DEPLOY.md)."
            )

    # --- internals ---
    def _require_ro(self) -> "AsyncElasticsearch":
        if self._ro is None:
            raise RuntimeError(
                "Read-only ES API key (ES_API_KEY) is not configured; cannot read the log surface."
            )
        return self._ro

    def _require_mgmt(self) -> "AsyncElasticsearch":
        if self._mgmt is None:
            raise RuntimeError(
                "Management ES API key (ES_MGMT_API_KEY) is not configured; "
                "cannot write the suite's own indices."
            )
        return self._mgmt

    # --- health ---
    async def ping(self) -> bool:
        client = self._mgmt or self._ro
        if client is None:
            return False
        try:
            return bool(await client.ping())
        except Exception as exc:  # noqa: BLE001
            logger.warning("ES ping failed: %s", exc)
            return False

    async def ping_state(self) -> bool:
        """Readiness probe for the management client that owns app state."""
        if self._mgmt is None:
            return False
        try:
            return bool(await self._mgmt.ping())
        except Exception as exc:  # noqa: BLE001
            logger.warning("ES state-store ping failed: %s", exc)
            return False

    # --- read-only log surface ---
    async def search_logs(self, index: str, body: dict[str, Any]) -> dict[str, Any]:
        client = self._require_ro()
        # Elasticsearch rejects an explicit index when a PIT is supplied; the PIT
        # already captures the scoped index set opened through this same read-only
        # client.  Non-PIT searches preserve the original call exactly.
        if body.get("pit"):
            resp = await client.search(body=body)
        else:
            resp = await client.search(index=index, body=body)
        return resp.body if hasattr(resp, "body") else dict(resp)

    async def open_log_pit(self, index: str, keep_alive: str = "1m") -> str | None:
        client = self._require_ro()
        resp = await client.open_point_in_time(index=index, keep_alive=keep_alive)
        body = resp.body if hasattr(resp, "body") else resp
        pit_id = body.get("id") if isinstance(body, dict) else None
        return str(pit_id) if pit_id else None

    async def close_log_pit(self, pit_id: str) -> None:
        if not pit_id:
            return
        client = self._require_ro()
        try:
            await client.close_point_in_time(id=pit_id)
        except TypeError:  # compatibility with clients requiring an explicit body
            await client.close_point_in_time(body={"id": pit_id})

    async def open_state_pit(self, index: str, keep_alive: str = "10m") -> str | None:
        client = self._require_mgmt()
        resp = await client.open_point_in_time(index=index, keep_alive=keep_alive)
        body = resp.body if hasattr(resp, "body") else resp
        pit_id = body.get("id") if isinstance(body, dict) else None
        return str(pit_id) if pit_id else None

    async def close_state_pit(self, pit_id: str) -> None:
        if not pit_id:
            return
        client = self._require_mgmt()
        try:
            await client.close_point_in_time(id=pit_id)
        except TypeError:
            await client.close_point_in_time(body={"id": pit_id})

    # --- management ---
    async def index_template_exists(self, name: str) -> bool:
        client = self._require_mgmt()
        try:
            return bool(await client.indices.exists_index_template(name=name))
        except Exception:  # noqa: BLE001
            return False

    async def put_index_template(self, name: str, body: dict[str, Any]) -> None:
        client = self._require_mgmt()
        await client.indices.put_index_template(name=name, **body)

    async def index_exists(self, name: str) -> bool:
        client = self._require_mgmt()
        try:
            return bool(await client.indices.exists(index=name))
        except Exception:  # noqa: BLE001
            return False

    async def create_index(self, name: str, body: dict[str, Any] | None = None) -> None:
        client = self._require_mgmt()
        try:
            await client.indices.create(index=name, **(body or {}))
        except Exception as exc:  # noqa: BLE001
            # resource_already_exists is benign (idempotent bootstrap).
            if es_exceptions and isinstance(exc, es_exceptions.BadRequestError):
                if "resource_already_exists" in str(exc):
                    return
            raise

    async def index_doc(
        self,
        index: str,
        doc: dict[str, Any],
        doc_id: str | None = None,
        refresh: bool = False,
    ) -> str:
        client = self._require_mgmt()
        resp = await client.index(index=index, id=doc_id, document=doc, refresh=refresh)
        return str(resp["_id"])

    async def create_doc_strict(
        self,
        index: str,
        doc_id: str,
        doc: dict[str, Any],
        refresh: bool = False,
    ) -> bool:
        """Atomically create a document through an owned write alias."""

        client = self._require_mgmt()
        try:
            await client.index(
                index=index,
                id=doc_id,
                document=doc,
                op_type="create",
                refresh=refresh,
            )
            return True
        except Exception as exc:
            if _is_conflict(exc):
                return False
            raise

    async def delete_index(self, name: str) -> None:
        """Drop a management index (used to recreate the RAG vector index on an
        embedding-space change). Missing index is benign."""
        client = self._require_mgmt()
        try:
            await client.indices.delete(index=name)
        except Exception as exc:  # noqa: BLE001
            if es_exceptions and isinstance(exc, es_exceptions.NotFoundError):
                return
            logger.warning("delete_index(%s) failed: %s", name, exc)

    async def delete_doc(self, index: str, doc_id: str, refresh: bool = False) -> bool:
        """Delete a single management document by id (used by RAG document
        management to remove an imported document's chunks). Missing doc/index is
        benign (returns False)."""
        client = self._require_mgmt()
        try:
            await client.delete(index=index, id=doc_id, refresh=refresh)
            return True
        except Exception as exc:  # noqa: BLE001
            if es_exceptions and isinstance(exc, es_exceptions.NotFoundError):
                return False
            logger.warning("delete_doc(%s/%s) failed: %s", index, doc_id, exc)
            return False

    async def get_doc(self, index: str, doc_id: str) -> dict[str, Any] | None:
        client = self._require_mgmt()
        try:
            resp = await client.get(index=index, id=doc_id)
            return resp["_source"]
        except Exception as exc:  # noqa: BLE001
            if es_exceptions and isinstance(exc, es_exceptions.NotFoundError):
                return None
            logger.warning("get_doc(%s/%s) failed: %s", index, doc_id, exc)
            return None

    async def get_doc_strict(self, index: str, doc_id: str) -> dict[str, Any] | None:
        """Strict owned-state read used where persistence is part of the API contract."""
        client = self._require_mgmt()
        try:
            resp = await client.get(index=index, id=doc_id)
            return resp["_source"]
        except Exception as exc:  # noqa: BLE001
            if _is_not_found(exc):
                return None
            raise

    async def compare_and_set_doc(
        self,
        index: str,
        doc_id: str,
        doc: dict[str, Any],
        expected_rev: int,
        refresh: bool = False,
    ) -> bool:
        """Atomically replace one owned-state doc with Elasticsearch OCC.

        Existing documents are fenced by the exact ``_seq_no`` and
        ``_primary_term`` returned by the management read.  An absent document is
        created with ``op_type=create``.  A 409 is an ordinary compare-and-set miss;
        every other backend failure propagates to the strict durability caller.

        The embedded ``_rev`` check preserves the backend-neutral KV contract and
        supports documents created before CAS bookkeeping (revision zero).  Native
        Elasticsearch metadata closes the read/write race across processes and
        replicas; no process-local lock is relied upon here.
        """
        client = self._require_mgmt()
        try:
            current = await client.get(index=index, id=doc_id)
        except Exception as exc:  # noqa: BLE001
            if not _is_not_found(exc):
                raise
            if int(expected_rev) != 0:
                return False
            try:
                await client.index(
                    index=index,
                    id=doc_id,
                    document=doc,
                    op_type="create",
                    refresh=refresh,
                )
                return True
            except Exception as create_exc:  # noqa: BLE001
                if _is_conflict(create_exc):
                    return False
                raise

        source = current.get("_source") or {}
        try:
            current_rev = int(source.get("_rev", 0) or 0)
        except (TypeError, ValueError):
            current_rev = 0
        if current_rev != int(expected_rev):
            return False

        try:
            await client.index(
                index=index,
                id=doc_id,
                document=doc,
                if_seq_no=int(current["_seq_no"]),
                if_primary_term=int(current["_primary_term"]),
                refresh=refresh,
            )
            return True
        except Exception as exc:  # noqa: BLE001
            if _is_conflict(exc):
                return False
            raise

    async def update_doc(
        self,
        index: str,
        doc_id: str,
        doc: dict[str, Any],
        refresh: bool = False,
    ) -> None:
        client = self._require_mgmt()
        await client.update(
            index=index, id=doc_id, doc=doc, doc_as_upsert=True, refresh=refresh
        )

    async def search(self, index: str, body: dict[str, Any]) -> dict[str, Any]:
        client = self._require_mgmt()
        try:
            # A PIT already captures the management-scoped index pattern; ES rejects
            # sending that PIT together with another explicit ``index`` argument.
            resp = (
                await client.search(body=body)
                if body.get("pit")
                else await client.search(index=index, body=body)
            )
            return resp.body if hasattr(resp, "body") else dict(resp)
        except Exception as exc:  # noqa: BLE001
            if es_exceptions and isinstance(exc, es_exceptions.NotFoundError):
                return {"hits": {"hits": [], "total": {"value": 0}}, "aggregations": {}}
            raise

    async def count(self, index: str, body: dict[str, Any]) -> int:
        client = self._require_mgmt()
        try:
            resp = await client.count(index=index, query=body.get("query"))
            return int(resp["count"])
        except Exception as exc:  # noqa: BLE001
            # Mirror search(): a missing index is legitimately zero, but any OTHER fault
            # (auth, connection, cluster red) must NOT be masked as "0 documents" — that
            # silently hides a live ES failure that tests (fake ES) can't reproduce
            # (audit #41). Log + re-raise so callers can tell "no docs" from "lookup failed".
            if es_exceptions and isinstance(exc, es_exceptions.NotFoundError):
                return 0
            logger.warning("ES count(%s) failed: %s", index, exc)
            raise

    # --- OWN-index lifecycle management ----------------------------------
    async def index_lifecycle_capabilities(self) -> dict[str, Any]:
        """Probe ILM privilege and Hot/Warm node roles without writing anything."""
        if self._mgmt is None:
            return {
                "supported": False,
                "can_manage": False,
                "privileged": False,
                "index_privileged": False,
                "hot_ready": False,
                "warm_ready": False,
                "roles": [],
                "reason": "ES_MGMT_API_KEY is not configured.",
            }
        try:
            privilege_response = await self._mgmt.security.has_privileges(
                cluster=["manage_ilm", "manage_index_templates", "monitor"],
                index=[
                    {
                        "names": list(self._LIFECYCLE_INDEX_PATTERNS),
                        "privileges": ["manage"],
                    }
                ],
            )
            privilege_body = (
                privilege_response.body
                if hasattr(privilege_response, "body")
                else dict(privilege_response)
            )
        except Exception as exc:  # noqa: BLE001
            return {
                "supported": False,
                "can_manage": False,
                "privileged": False,
                "index_privileged": False,
                "hot_ready": False,
                "warm_ready": False,
                "roles": [],
                "reason": (
                    "The management credential's lifecycle privileges could not be "
                    f"inspected (probe: {type(exc).__name__})."
                ),
            }
        all_requested = bool(privilege_body.get("has_all_requested"))
        granted = privilege_body.get("cluster") or {}
        index_grants = privilege_body.get("index") or {}
        control_cluster_privileged = bool(
            granted.get("manage_ilm") and granted.get("manage_index_templates")
        )
        monitor_privileged = bool(granted.get("monitor"))
        index_privileged = bool(
            all_requested
            or all(
                (index_grants.get(pattern) or {}).get("manage")
                for pattern in self._LIFECYCLE_INDEX_PATTERNS
            )
        )
        can_manage = bool(
            all_requested or (control_cluster_privileged and index_privileged)
        )
        if not can_manage:
            missing = [
                name
                for name in ("manage_ilm", "manage_index_templates")
                if not granted.get(name)
            ]
            missing.extend(
                f"manage on {pattern}"
                for pattern in self._LIFECYCLE_INDEX_PATTERNS
                if not (index_grants.get(pattern) or {}).get("manage")
            )
            return {
                "supported": False,
                "can_manage": False,
                "privileged": control_cluster_privileged,
                "index_privileged": index_privileged,
                "hot_ready": False,
                "warm_ready": False,
                "roles": [],
                "reason": (
                    "The management credential needs lifecycle privileges: "
                    + ", ".join(
                        missing or ["manage_ilm", "manage_index_templates", "monitor"]
                    )
                    + "."
                ),
            }
        if not (all_requested or monitor_privileged):
            return {
                "supported": False,
                "can_manage": True,
                "privileged": True,
                "index_privileged": True,
                "hot_ready": False,
                "warm_ready": False,
                "roles": [],
                "reason": (
                    "The management credential can detach lifecycle, but cluster "
                    "monitor is required to verify Hot/Warm tier readiness before enabling it."
                ),
            }
        try:
            status_response = await self._mgmt.ilm.get_status()
            status_body = (
                status_response.body
                if hasattr(status_response, "body")
                else dict(status_response)
            )
            ilm_mode = str(status_body.get("operation_mode") or "unknown").upper()
        except Exception as exc:  # noqa: BLE001
            return {
                "supported": False,
                "can_manage": True,
                "privileged": True,
                "index_privileged": True,
                "hot_ready": False,
                "warm_ready": False,
                "roles": [],
                "reason": f"ILM status could not be read (probe: {type(exc).__name__}).",
            }
        if ilm_mode != "RUNNING":
            return {
                "supported": False,
                "can_manage": True,
                "privileged": True,
                "index_privileged": True,
                "hot_ready": False,
                "warm_ready": False,
                "roles": [],
                "ilm_mode": ilm_mode,
                "reason": f"Elasticsearch ILM is {ilm_mode}; start ILM before applying lifecycle.",
            }
        try:
            response = await self._mgmt.nodes.info(metric="settings")
            body = response.body if hasattr(response, "body") else dict(response)
            roles = sorted({
                str(role)
                for node in (body.get("nodes") or {}).values()
                for role in (node.get("roles") or [])
            })
        except Exception as exc:  # noqa: BLE001
            return {
                "supported": False,
                "can_manage": True,
                "privileged": True,
                "index_privileged": True,
                "hot_ready": False,
                "warm_ready": False,
                "roles": [],
                "reason": (
                    "ILM is visible, but data-tier readiness could not be inspected; "
                    f"grant cluster monitor (probe: {type(exc).__name__})."
                ),
            }
        generic_data = "data" in roles
        hot_ready = generic_data or "data_hot" in roles or "data_content" in roles
        warm_ready = generic_data or "data_warm" in roles
        ready = bool(hot_ready and warm_ready)
        return {
            "supported": ready,
            "can_manage": True,
            "privileged": True,
            "index_privileged": True,
            "hot_ready": hot_ready,
            "warm_ready": warm_ready,
            "roles": roles,
            "ilm_mode": ilm_mode,
            "reason": (
                "ILM privilege and Hot/Warm data roles are available."
                if ready
                else "The cluster needs both Hot and Warm-capable data roles."
            ),
        }

    async def put_index_lifecycle_policy(self, name: str, body: dict[str, Any]) -> None:
        client = self._require_mgmt()
        try:
            await client.ilm.put_lifecycle(name=name, policy=body["policy"])
        except TypeError:  # elasticsearch-py compatibility
            await client.ilm.put_lifecycle(name=name, body=body)

    async def get_index_lifecycle_policy(self, name: str) -> dict[str, Any] | None:
        client = self._require_mgmt()
        try:
            response = await client.ilm.get_lifecycle(name=name)
            body = response.body if hasattr(response, "body") else dict(response)
            entry = body.get(name)
            if not isinstance(entry, dict):
                return None
            policy = entry.get("policy")
            return {"policy": policy} if isinstance(policy, dict) else None
        except Exception as exc:  # noqa: BLE001
            if es_exceptions and isinstance(exc, es_exceptions.NotFoundError):
                return None
            raise

    async def get_owned_index_lifecycle_attachment(
        self, base: str, policy_name: str
    ) -> dict[str, Any]:
        """Inspect lifecycle settings for one allow-listed append-only ledger."""
        if base not in {AUDIT_INDEX, USAGE_INDEX}:
            raise ValueError("lifecycle attachment inspection is limited to owned ledgers")
        client = self._require_mgmt()

        def setting(settings: dict[str, Any], dotted: str) -> Any:
            if dotted in settings:
                return settings[dotted]
            current: Any = settings
            for part in dotted.split("."):
                if not isinstance(current, dict) or part not in current:
                    return None
                current = current[part]
            return current

        template_attached = False
        try:
            response = await client.indices.get_index_template(
                name=f"{base}-template", flat_settings=True
            )
            body = response.body if hasattr(response, "body") else dict(response)
            templates = body.get("index_templates") or []
            entry = next(
                (
                    item
                    for item in templates
                    if isinstance(item, dict) and item.get("name") == f"{base}-template"
                ),
                None,
            )
            template_settings = (
                entry.get("index_template", {}).get("template", {}).get("settings", {})
                if isinstance(entry, dict)
                else {}
            )
            template_attached = bool(
                setting(template_settings, "index.lifecycle.name") == policy_name
                and setting(template_settings, "index.lifecycle.rollover_alias") == base
            )
        except Exception as exc:  # noqa: BLE001
            if not (es_exceptions and isinstance(exc, es_exceptions.NotFoundError)):
                raise

        response = await client.indices.get_settings(
            index=f"{base}-*",
            name=["index.lifecycle.name", "index.lifecycle.rollover_alias"],
            allow_no_indices=True,
            ignore_unavailable=True,
            expand_wildcards="all",
            flat_settings=True,
        )
        body = response.body if hasattr(response, "body") else dict(response)
        existing_indices = [
            value for value in body.values() if isinstance(value, dict)
        ]
        attached_count = 0
        for value in existing_indices:
            index_settings = value.get("settings") or {}
            if (
                setting(index_settings, "index.lifecycle.name") == policy_name
                and setting(index_settings, "index.lifecycle.rollover_alias") == base
            ):
                attached_count += 1
        all_existing_attached = attached_count == len(existing_indices)
        attached = bool(template_attached and all_existing_attached)
        return {
            "verified": True,
            "template_attached": template_attached,
            "indices_total": len(existing_indices),
            "indices_attached": attached_count,
            "all_existing_indices_attached": all_existing_attached,
            "attached": attached,
            "reason": (
                "Template and existing indices carry the expected lifecycle settings."
                if attached
                else "Template or existing-index lifecycle settings are missing or drifted."
            ),
        }

    async def index_lifecycle_policy_exists(self, name: str) -> bool:
        return await self.get_index_lifecycle_policy(name) is not None

    async def delete_index_lifecycle_policy(self, name: str) -> None:
        client = self._require_mgmt()
        try:
            await client.ilm.delete_lifecycle(name=name)
        except Exception as exc:  # noqa: BLE001
            if es_exceptions and isinstance(exc, es_exceptions.NotFoundError):
                return
            raise

    async def put_index_settings(self, index: str, settings: dict[str, Any]) -> None:
        client = self._require_mgmt()
        try:
            await client.indices.put_settings(index=index, settings=settings)
        except TypeError:  # elasticsearch-py compatibility
            await client.indices.put_settings(index=index, body={"index": settings})

    async def remove_index_lifecycle(self, index: str) -> None:
        client = self._require_mgmt()
        try:
            await client.ilm.remove_policy(index=index)
        except Exception as exc:  # noqa: BLE001
            # A missing index or an index without a policy is already in the desired
            # unmanaged state. Other failures must surface to the explicit caller.
            if es_exceptions and isinstance(exc, es_exceptions.NotFoundError):
                return
            if "not managed" in str(exc).lower():
                return
            raise

    async def close(self) -> None:
        for client in (self._ro, self._mgmt):
            if client is not None:
                try:
                    await client.close()
                except Exception:  # noqa: BLE001
                    pass
