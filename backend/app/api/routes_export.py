"""Privileged, portable application-state export.

The export is intentionally selected APPLICATION state, not a backup of credentials
or raw upstream logs. The legacy endpoint returns one bounded canonical JSON file;
the v2 endpoint walks every record in one supported safe scope through resumable,
response-bounded segments; and the archive endpoint walks those same bounded pages
into one disk-backed ZIP before serving it. Environment secrets, connector credentials,
auth users/sessions, password/MFA material and raw log payloads are never traversed. A
final recursive guard omits credential-named keys and redacts common bearer/API-key/
private-key patterns from free text.

The endpoint is gated by the dedicated ``data_export:export`` permission (default:
super-admin and SOC manager only), size/count bounded, and append-only audited after
the snapshot is captured. It never calls an LLM and never touches deterministic case
authority (#3).
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import hmac
import json
import os
import re
import secrets as stdlib_secrets
import shutil
import tempfile
import threading
import zipfile
from dataclasses import asdict, is_dataclass
from datetime import datetime, timezone
from enum import Enum
from typing import Any, AsyncIterator, Awaitable, Callable, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..build_identity import current_record_provenance
from ..constants import ActionType
from ..engine.runbooks import parse_runbook_document
from ..playbooks.loader import parse_playbook
from ..playbooks.manifest import MAX_PLAYBOOK_PROMPT_CHARS, render_playbook_prompt
from ..state import AppState
from .deps import current_username, get_state, require_fresh_auth, require_permission

router = APIRouter(prefix="/api")

_ARCHIVE_PERMISSION_DEP = require_permission("data_export", "export")
_ARCHIVE_FRESH_DEP = require_fresh_auth()

ExportScope = Literal[
    "all", "cases", "audit", "usage", "configuration", "automation", "knowledge"
]
SegmentExportScope = Literal[
    "cases", "audit", "usage", "configuration", "automation", "knowledge"
]

_SCOPE_ORDER: tuple[str, ...] = (
    "cases", "audit", "usage", "configuration", "automation", "knowledge"
)
_MAX_ITEMS_PER_SCOPE = 5000
_MAX_EXPORT_BYTES = 25 * 1024 * 1024
_MAX_TEXT_CHARS = 250_000
_MAX_CURSOR_CHARS = 32_768
_MAX_PIT_CHARS = 24_000
_ARCHIVE_STREAM_CHUNK_BYTES = 1024 * 1024
_ARCHIVE_DISK_RESERVE_BYTES = 64 * 1024 * 1024

# A single process assembles/serves at most one temporary archive at a time. This is
# deliberately non-blocking: privileged callers receive 409 instead of queueing a
# second potentially large disk artifact until their fresh-auth window has expired.
_ARCHIVE_SLOT = threading.Lock()

# Exact/suffix checks avoid stripping harmless usage fields such as prompt_tokens.
_SENSITIVE_KEYS = {
    "password", "password_hash", "api_key", "access_key", "secret_access_key",
    "client_secret", "mfa_secret", "totp_secret", "recovery_codes", "credential",
    "credentials", "authorization", "cookie", "set_cookie", "refresh_token",
    "access_token", "id_token", "session_token", "private_key", "connector_secrets",
}
_SENSITIVE_SUFFIXES = (
    "_password", "_password_hash", "_api_key", "_client_secret", "_private_key",
    "_access_token", "_refresh_token", "_session_token",
)

_TEXT_SECRET_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{8,}"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{12,}"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"),
)

_EXCLUDED = [
    "environment secrets and API keys",
    "connector credentials",
    "password hashes, MFA material, and recovery codes",
    "user and session registries",
    "browser cookies and bearer tokens",
    "upstream raw log payloads",
]


class _AuthoritativeCatalogText(str):
    """Marker for bounded operator documents that must not be silently truncated."""


class DataExportRequest(BaseModel):
    """Selectable export request. ``all`` expands to every safe application scope."""

    scopes: list[ExportScope] = Field(default_factory=lambda: ["all"], min_length=1)
    limit_per_scope: int = Field(default=1000, ge=1, le=_MAX_ITEMS_PER_SCOPE)


class DataExportSegmentRequest(BaseModel):
    """One bounded continuation segment of a complete, scope-specific export."""

    scope: SegmentExportScope
    cursor: str | None = Field(default=None, max_length=_MAX_CURSOR_CHARS)
    page_size: int = Field(default=1000, ge=1, le=_MAX_ITEMS_PER_SCOPE)


class DataExportArchiveRequest(BaseModel):
    """Selected safe scopes for one server-assembled full-history ZIP."""

    scopes: list[ExportScope] = Field(default_factory=lambda: ["all"], min_length=1)


class DataExportSegmentCancelRequest(BaseModel):
    """Release a still-open point-in-time cursor after operator cancellation."""

    scope: SegmentExportScope
    cursor: str = Field(min_length=1, max_length=_MAX_CURSOR_CHARS)


class _ArchiveArtifact:
    """Idempotent temp-file and global-slot cleanup for every response path."""

    def __init__(self) -> None:
        self.path: str | None = None
        self._done = False

    async def cleanup(self) -> None:
        if self._done:
            return
        self._done = True
        try:
            if self.path:
                await _run_blocking(_unlink_archive, self.path)
        finally:
            _ARCHIVE_SLOT.release()


class _ArchiveStreamingResponse(StreamingResponse):
    """Streaming response whose outer ASGI boundary always deletes the artifact.

    Starlette's background callback is not reached when ``send`` raises. Wrapping the
    complete response call in ``finally`` covers disconnects before the body iterator
    starts as well as failures during a chunk, while the iterator keeps its own finally
    as defense in depth.
    """

    def __init__(
        self,
        content: AsyncIterator[bytes],
        *,
        cleanup: Callable[[], Awaitable[None]],
        headers: dict[str, str],
    ) -> None:
        super().__init__(content, media_type="application/zip", headers=headers)
        self._archive_cleanup = cleanup

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            await self._archive_cleanup()


def _unlink_archive(path: str) -> None:
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass


def _new_archive_path() -> str:
    descriptor, path = tempfile.mkstemp(
        prefix="agentic-soc-export-",
        suffix=".zip",
    )
    os.close(descriptor)
    return path


async def _run_blocking(
    function: Callable[..., Any],
    *args: Any,
    **kwargs: Any,
) -> Any:
    """Finish an in-flight filesystem call before propagating cancellation.

    Cancelling ``asyncio.to_thread`` does not stop its worker. Waiting for that worker
    prevents ZIP writes racing the close/unlink cleanup path after a client abort.
    """
    task = asyncio.create_task(asyncio.to_thread(function, *args, **kwargs))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        try:
            await task
        except Exception:  # noqa: BLE001 — cancellation remains authoritative
            pass
        raise


def _ensure_archive_capacity(path: str, required_bytes: int) -> None:
    free = shutil.disk_usage(os.path.dirname(path) or ".").free
    needed = max(0, int(required_bytes)) + _ARCHIVE_DISK_RESERVE_BYTES
    if free < needed:
        raise HTTPException(
            status_code=507,
            detail=(
                "temporary storage is too full to assemble this export safely; "
                "free space or use the resumable segment export"
            ),
        )


def _write_ndjson_page(
    entry: Any,
    records: list[Any],
    digest: Any,
) -> int:
    written = 0
    for record in records:
        line = (
            json.dumps(
                record, ensure_ascii=False, sort_keys=True, separators=(",", ":")
            ).encode("utf-8")
            + b"\n"
        )
        entry.write(line)
        digest.update(line)
        written += len(line)
    return written


def _canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _verify_archive(
    path: str,
    scopes: list[str],
    expected_manifest: dict[str, Any],
) -> None:
    expected_names = [*(f"{scope}.ndjson" for scope in scopes), "manifest.json"]
    try:
        with zipfile.ZipFile(path, "r") as archive:
            if archive.namelist() != expected_names:
                raise ValueError("archive entries do not match the selected scopes")
            for scope in scopes:
                metadata = expected_manifest["scopes"][scope]
                entry_name = str(metadata["entry"])
                digest = hashlib.sha256()
                uncompressed_bytes = 0
                line_count = 0
                final_byte = b""
                with archive.open(entry_name, "r") as entry:
                    while True:
                        chunk = entry.read(_ARCHIVE_STREAM_CHUNK_BYTES)
                        if not chunk:
                            break
                        digest.update(chunk)
                        uncompressed_bytes += len(chunk)
                        line_count += chunk.count(b"\n")
                        final_byte = chunk[-1:]
                if uncompressed_bytes and final_byte != b"\n":
                    raise ValueError(f"{entry_name} is not complete NDJSON")
                if uncompressed_bytes != int(metadata["uncompressed_bytes"]):
                    raise ValueError(f"{entry_name} byte count does not match manifest")
                if digest.hexdigest() != str(metadata["sha256"]):
                    raise ValueError(f"{entry_name} digest does not match manifest")
                if line_count != int(metadata["exported"]):
                    raise ValueError(f"{entry_name} record count does not match manifest")
                if archive.getinfo(entry_name).file_size != uncompressed_bytes:
                    raise ValueError(f"{entry_name} ZIP size does not match its contents")
            stored_manifest = json.loads(archive.read("manifest.json"))
            if stored_manifest != expected_manifest:
                raise ValueError("archive manifest does not match assembled state")
    except (OSError, ValueError, zipfile.BadZipFile, json.JSONDecodeError) as exc:
        raise HTTPException(
            status_code=503,
            detail="the completed export archive failed integrity verification",
        ) from exc


async def _stream_archive(
    path: str,
    cleanup: Callable[[], Awaitable[None]],
) -> AsyncIterator[bytes]:
    handle = None
    try:
        handle = await _run_blocking(open, path, "rb")
        while True:
            chunk = await _run_blocking(handle.read, _ARCHIVE_STREAM_CHUNK_BYTES)
            if not chunk:
                break
            yield chunk
    finally:
        if handle is not None:
            await _run_blocking(handle.close)
        await cleanup()


def _redact_text(value: str, *, max_characters: int = _MAX_TEXT_CHARS) -> str:
    text = value[:max_characters]
    for pattern in _TEXT_SECRET_PATTERNS:
        text = pattern.sub("[REDACTED]", text)
    return text


def _is_sensitive_key(key: Any) -> bool:
    normal = str(key).strip().lower().replace("-", "_")
    return normal in _SENSITIVE_KEYS or normal.endswith(_SENSITIVE_SUFFIXES)


def _plain(value: Any) -> Any:
    """Convert domain models/dataclasses/enums into deterministic JSON primitives."""
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, _AuthoritativeCatalogText):
        # Operator runbooks/playbooks are individually and aggregately bounded by
        # their owning stores. Preserve the complete source document; the 25 MiB
        # response cap and adaptive segmented paging remain the outer safety bound.
        return _redact_text(value, max_characters=len(value))
    if isinstance(value, str):
        return _redact_text(value)
    if isinstance(value, Enum):
        return _plain(value.value)
    if hasattr(value, "model_dump"):
        return _plain(value.model_dump(mode="json"))
    if hasattr(value, "to_json") and callable(value.to_json):
        return _plain(value.to_json())
    if is_dataclass(value):
        return _plain(asdict(value))
    if isinstance(value, dict):
        return {
            str(key): _plain(item)
            for key, item in sorted(value.items(), key=lambda pair: str(pair[0]))
            if not _is_sensitive_key(key)
        }
    if isinstance(value, (set, frozenset)):
        return [_plain(item) for item in sorted(value, key=lambda item: str(item))]
    if isinstance(value, (list, tuple)):
        return [_plain(item) for item in value]
    return _redact_text(str(value))


def _select_scopes(requested: list[str]) -> list[str]:
    wanted = set(_SCOPE_ORDER if "all" in requested else requested)
    return [scope for scope in _SCOPE_ORDER if scope in wanted]


def _encode_cursor(
    *,
    scope: str,
    position: Any,
    snapshot_total: int,
    exported: int,
    segment: int,
    actor: str,
    snapshot_id: str,
    signing_key: bytes,
) -> str:
    """Encode authenticated continuation state bound to one operator/snapshot."""
    raw = json.dumps(
        {
            "v": 2,
            "scope": scope,
            "subject": hashlib.sha256(actor.encode("utf-8")).hexdigest(),
            "snapshot_id": snapshot_id,
            "position": position,
            "snapshot_total": max(0, int(snapshot_total)),
            "exported": max(0, int(exported)),
            "segment": max(1, int(segment)),
        },
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    payload = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
    signature = base64.urlsafe_b64encode(
        hmac.new(signing_key, payload.encode("ascii"), hashlib.sha256).digest()
    ).decode("ascii").rstrip("=")
    encoded = f"{payload}.{signature}"
    if len(encoded) > _MAX_CURSOR_CHARS:
        raise HTTPException(
            status_code=503,
            detail="the state backend returned an export cursor that is too large to resume safely",
        )
    return encoded


def _decode_cursor(
    scope: str,
    cursor: str | None,
    *,
    actor: str,
    signing_key: bytes,
) -> dict[str, Any] | None:
    if not cursor:
        return None
    if len(cursor) > _MAX_CURSOR_CHARS:
        raise HTTPException(status_code=400, detail="export cursor is too long")
    try:
        payload, supplied_signature = cursor.split(".", 1)
        expected_signature = base64.urlsafe_b64encode(
            hmac.new(signing_key, payload.encode("ascii"), hashlib.sha256).digest()
        ).decode("ascii").rstrip("=")
        if not hmac.compare_digest(expected_signature, supplied_signature):
            raise ValueError("signature mismatch")
        padded = payload + "=" * (-len(payload) % 4)
        raw = base64.b64decode(padded, altchars=b"-_", validate=True)
        value = json.loads(raw.decode("utf-8"))
    except (
        binascii.Error,
        UnicodeDecodeError,
        json.JSONDecodeError,
        ValueError,
    ):
        raise HTTPException(status_code=400, detail="invalid export cursor") from None
    expected_subject = hashlib.sha256(actor.encode("utf-8")).hexdigest()
    if (
        not isinstance(value, dict)
        or value.get("v") != 2
        or value.get("scope") != scope
        or value.get("subject") != expected_subject
    ):
        raise HTTPException(status_code=400, detail="export cursor does not match this scope")
    snapshot_id = value.get("snapshot_id")
    if (
        not isinstance(snapshot_id, str)
        or not 16 <= len(snapshot_id) <= 64
        or not re.fullmatch(r"[A-Za-z0-9_-]+", snapshot_id)
    ):
        raise HTTPException(status_code=400, detail="invalid export snapshot id")
    try:
        snapshot_total = int(value.get("snapshot_total"))
        exported = int(value.get("exported"))
        segment = int(value.get("segment"))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="invalid export cursor counters") from None
    # A continuation token is issued only *between* non-empty segments. These
    # relationships make counter progression monotonic even before the repository
    # validates its own position marker. Since the state is HMAC-authenticated, a
    # client cannot skip records by increasing either counter or changing position.
    if (
        snapshot_total <= 0
        or exported <= 0
        or exported >= snapshot_total
        or segment < 2
        or segment > exported + 1
    ):
        raise HTTPException(status_code=400, detail="invalid export cursor counters")
    position = value.get("position")
    simple_marker = (
        isinstance(position, list)
        and len(position) <= 4
        and all(isinstance(item, (str, int, float)) or item is None for item in position)
    )
    pit_marker = False
    if isinstance(position, dict) and set(position).issubset({"pit", "after", "seen"}):
        pit = position.get("pit")
        after = position.get("after")
        seen = position.get("seen", 0)
        pit_marker = (
            isinstance(pit, str)
            and 0 < len(pit) <= _MAX_PIT_CHARS
            and (after is None or (
                isinstance(after, list)
                and len(after) <= 4
                and all(isinstance(item, (str, int, float)) or item is None for item in after)
            ))
            and isinstance(seen, int)
            and seen == exported
        )
    if not (
        isinstance(position, int) and not isinstance(position, bool) and position == exported
        or simple_marker
        or pit_marker
    ):
        raise HTTPException(status_code=400, detail="invalid export cursor position")
    return {
        "snapshot_id": snapshot_id,
        "position": position,
        "snapshot_total": snapshot_total,
        "exported": exported,
        "segment": segment,
    }


def _manifest(count: int, total: int | None = None) -> dict[str, Any]:
    known_total = int(total if total is not None else count)
    return {
        "count": int(count),
        "total": known_total,
        "truncated": known_total > int(count),
    }


def _limit_grouped_rows(
    groups: dict[str, list[Any]], limit: int,
) -> dict[str, list[Any]]:
    """Fairly cap a multi-collection scope to ``limit`` total records.

    A round-robin keeps every non-empty collection represented instead of allowing
    the first large collection to consume the whole scope allowance. Group/key order
    is fixed by the caller, so the result remains deterministic and canonical.
    """
    bounded = {name: [] for name in groups}
    if limit <= 0:
        return bounded
    index = 0
    remaining = int(limit)
    while remaining > 0:
        added = False
        for name, rows in groups.items():
            if index >= len(rows):
                continue
            bounded[name].append(rows[index])
            remaining -= 1
            added = True
            if remaining <= 0:
                break
        if not added:
            break
        index += 1
    return bounded


def _playbook_catalog_record(
    playbook: Any,
    metadata: dict[str, Any],
    *,
    content: str | None = None,
) -> dict[str, Any]:
    """Return a filesystem-path-free playbook manifest for portable export."""
    manifest = playbook.manifest
    record: dict[str, Any] = {
        "id": playbook.id,
        "name": playbook.name,
        "version": playbook.version,
        "description": manifest.description,
        "priority": manifest.priority,
        "match": {
            "rule_ids": list(manifest.match.rule_ids),
            "entity_types": list(manifest.match.entity_types),
            "mitre": list(manifest.match.mitre),
            "min_event_count": manifest.match.min_event_count,
            "any_tags": list(manifest.match.any_tags),
        },
        "suggested_tools": list(manifest.suggested_tools),
        "rag_queries": list(manifest.rag_queries),
        "escalate_if": manifest.escalate_if,
        "suggested_verdict_bias": manifest.suggested_verdict_bias,
        "valid": True,
        **metadata,
    }
    if content is not None:
        # The complete operator-authored Markdown is authoritative. It is emitted
        # once (rather than duplicating the parsed body), then recursively secret-
        # redacted together with the rest of the export envelope.
        record["content"] = _AuthoritativeCatalogText(content)
        record["content_included"] = True
    else:
        record["content_included"] = False
    return record


async def _knowledge_catalog_groups(state: AppState) -> dict[str, list[Any]]:
    """Collect the complete safe Intelligence catalog from owning stores.

    Operator runbooks/playbooks are application state and therefore include their
    sanitized source document. Packaged procedures are versioned application
    assets; references and manifests are sufficient and avoid duplicating package
    content in every support export. Invalid but durably stored operator documents
    are retained with an explicit validation status so backup completeness never
    depends on whether the live parser can currently load them.
    """
    runbook_rows = await state.runbooks.store.list_strict()
    runbook_catalog = await state.runbooks.list()
    bundled_runbooks = [
        {
            **record.payload(include_content=False),
            "valid": True,
            "content_included": False,
        }
        for record in runbook_catalog
        if record.source_type == "bundled"
    ]

    operator_runbooks: list[dict[str, Any]] = []
    for runbook_id, row in sorted(runbook_rows.items()):
        content = str(row.get("content") or "")
        record: dict[str, Any] = {
            "id": runbook_id,
            "source_type": "operator",
            "protected": False,
            "editable": True,
            "file_name": f"{runbook_id}.md",
            "revision": int(row.get("revision", 1) or 1),
            "created_at": str(row.get("created_at") or ""),
            "updated_at": str(row.get("updated_at") or ""),
            "created_by": str(row.get("created_by") or ""),
            "updated_by": str(row.get("updated_by") or ""),
            "index_status": str(row.get("index_status") or "pending"),
            "indexed_revision": int(row.get("indexed_revision", 0) or 0),
            "last_indexed_at": str(row.get("last_indexed_at") or ""),
            "index_error": str(row.get("index_error") or ""),
            "content": _AuthoritativeCatalogText(content),
            "content_included": True,
        }
        try:
            parsed = parse_runbook_document(
                content,
                expected_id=runbook_id,
                enforce_authoring_standard=False,
            )
            record.update({
                "title": parsed.title,
                "summary": parsed.summary,
                "persona": parsed.persona,
                "applies_to_rules": list(parsed.applies_to_rules),
                "applies_to_techniques": list(parsed.applies_to_techniques),
                "applies_to_entities": list(parsed.applies_to_entities),
                "keywords": list(parsed.keywords),
                "body_characters": len(parsed.body),
                "valid": True,
                "validation_status": "valid",
            })
        except Exception:  # noqa: BLE001 — retain malformed authoritative state
            record.update({
                "valid": False,
                "validation_status": "stored_unparseable",
            })
        operator_runbooks.append(record)

    playbook_store = getattr(state.playbooks, "store", None)
    operator_playbooks: list[dict[str, Any]] = []
    bundled_playbooks: list[dict[str, Any]] = []
    if playbook_store is not None:
        # Read the durable operator layer once. The packaged registry is immutable;
        # its currently loaded bundled manifests are sufficient safe references.
        playbook_rows = await playbook_store.list_strict()
        for playbook in state.playbooks.all():
            metadata = dict(state.playbooks.metadata(playbook))
            if metadata.get("source_type") == "bundled":
                bundled_playbooks.append(
                    _playbook_catalog_record(playbook, metadata)
                )
        for playbook_id, row in sorted(playbook_rows.items()):
            content = str(row.get("content") or "")
            metadata = {
                "source_type": "operator",
                "protected": False,
                "editable": True,
                "file_name": f"{playbook_id}.md",
                "revision": int(row.get("revision", 1) or 1),
                "created_at": str(row.get("created_at") or ""),
                "updated_at": str(row.get("updated_at") or ""),
                "created_by": str(row.get("created_by") or ""),
                "updated_by": str(row.get("updated_by") or ""),
                "storage": "state",
            }
            parsed = parse_playbook(
                content,
                fallback_id=playbook_id,
                source_path=f"state:{playbook_id}",
            )
            if (
                parsed is not None
                and parsed.id == playbook_id
                and len(render_playbook_prompt(parsed)) <= MAX_PLAYBOOK_PROMPT_CHARS
            ):
                operator_playbooks.append(
                    _playbook_catalog_record(parsed, metadata, content=content)
                )
            else:
                operator_playbooks.append({
                    "id": playbook_id,
                    **metadata,
                    "content": _AuthoritativeCatalogText(content),
                    "content_included": True,
                    "valid": False,
                    "validation_status": "stored_unparseable",
                })
    else:
        # A deliberate directory override is operator-managed application state.
        # Refresh once, then export each validated document from the same registry.
        refresh = await state.refresh_playbooks()
        if refresh.get("skipped"):
            raise ValueError("operator playbook directory contains invalid documents")
        for playbook in state.playbooks.all():
            metadata = dict(state.playbooks.metadata(playbook))
            if metadata.get("source_type") == "operator":
                _loaded, content = state.playbooks.read_document(playbook.id)
                operator_playbooks.append(
                    _playbook_catalog_record(playbook, metadata, content=content)
                )
            else:
                bundled_playbooks.append(
                    _playbook_catalog_record(playbook, metadata)
                )

    memories = list(await state.memory.list_strict(active_only=False))
    documents = list(await state.rag_service.snapshot_documents_strict())
    custom_models = list(await state.custom_models.list_models_strict())
    catalog_manifest = {
        "schema_version": 1,
        "runbooks": {
            "total": len(operator_runbooks) + len(bundled_runbooks),
            "operator": len(operator_runbooks),
            "bundled": len(bundled_runbooks),
            "operator_content_included": len(operator_runbooks),
            "bundled_content_included": 0,
        },
        "playbooks": {
            "total": len(operator_playbooks) + len(bundled_playbooks),
            "operator": len(operator_playbooks),
            "bundled": len(bundled_playbooks),
            "operator_content_included": len(operator_playbooks),
            "bundled_content_included": 0,
        },
        "policy": (
            "operator documents include sanitized authoritative Markdown; "
            "bundled procedures include safe versioned references/manifests only"
        ),
    }
    return {
        # Keep the exact count manifest first so even a very small legacy bounded
        # export explicitly discloses what exists and whether catalog rows truncated.
        "catalog_manifests": [catalog_manifest],
        "operator_runbooks": operator_runbooks,
        "operator_playbooks": operator_playbooks,
        "bundled_runbooks": bundled_runbooks,
        "bundled_playbooks": bundled_playbooks,
        "memory": memories,
        # Metadata only: corpus chunks can contain upstream/log or operator-pasted
        # secrets and remain deliberately excluded from portable export.
        "rag_documents": documents,
        "custom_models": custom_models,
    }


async def _collect_scope(
    scope: str, state: AppState, limit: int,
) -> tuple[Any, dict[str, Any]]:
    if scope == "cases":
        rows, total = await state.cases.list(limit=limit, offset=0)
        return rows, _manifest(len(rows), total)

    if scope == "audit":
        rows = await state.audit.records(limit=limit)
        # AuditRepository has no count query; reaching the hard cap is conservatively
        # marked truncated so an analyst never assumes this is the full ledger.
        meta = _manifest(len(rows), len(rows) + 1 if len(rows) >= limit else len(rows))
        return rows, meta

    if scope == "usage":
        rows = await state.usage_store.records(limit=limit)
        meta = _manifest(len(rows), len(rows) + 1 if len(rows) >= limit else len(rows))
        return rows, meta

    if scope == "configuration":
        # Preferences intentionally contain no secret values; recursive sanitisation
        # remains a second guard. Secrets/credential stores are never touched.
        row = {
            "preferences": state.prefs,
            "demo_active": bool(state.demo_active),
        }
        return row, _manifest(1)

    if scope == "automation":
        proposals = list(await state.proposals.list_strict())
        tuning = list(await state.tuning_store.list_strict())
        campaigns, campaign_total = await state.campaign_store.list_strict(limit=limit)
        batch_jobs = sorted(
            list(await state.batch_job_store.list_strict()),
            key=lambda job: str(getattr(job, "id", "")),
        )
        rule_versions = list(await state.rule_versions.list_strict())
        groups = _limit_grouped_rows({
            "proposals": proposals,
            "tuning": tuning,
            "campaigns": list(campaigns),
            "batch_jobs": batch_jobs,
            "rule_versions": rule_versions,
        }, limit)
        total = (
            len(proposals) + len(tuning) + int(campaign_total) + len(batch_jobs)
            + len(rule_versions)
        )
        count = sum(len(rows) for rows in groups.values())
        return groups, _manifest(count, total)

    if scope == "knowledge":
        catalog = await _knowledge_catalog_groups(state)
        groups = _limit_grouped_rows(catalog, limit)
        total = sum(len(rows) for rows in catalog.values())
        count = sum(len(rows) for rows in groups.values())
        return groups, _manifest(count, total)

    raise ValueError(f"unknown export scope: {scope}")


async def _collect_segment_page(
    scope: str,
    state: AppState,
    limit: int,
    position: Any = None,
) -> tuple[list[dict[str, Any]], Any | None, int | None, str]:
    """Collect one oldest-first page without crossing a store result-window cap."""
    if scope == "cases":
        rows, next_position, total, consistency = await state.cases.export_page(
            limit=limit, cursor=position,
        )
        return [{"record": row} for row in rows], next_position, total, consistency

    if scope == "audit":
        rows, next_position, total, consistency = await state.audit.export_page(
            limit=limit, cursor=position,
        )
        return [{"record": row} for row in rows], next_position, total, consistency

    if scope == "usage":
        rows, next_position, total, consistency = await state.usage_store.export_page(
            limit=limit, cursor=position,
        )
        return [{"record": row} for row in rows], next_position, total, consistency

    # These scopes are backed by small configuration/KV collections. Their store APIs
    # already materialise the owning JSON document; flatten once, then return only the
    # requested bounded segment over the wire. Group labels preserve the v1 structure.
    grouped: dict[str, list[Any]]
    if scope == "configuration":
        grouped = {
            "configuration": [{
                "preferences": state.prefs,
                "demo_active": bool(state.demo_active),
            }]
        }
    elif scope == "automation":
        campaigns, _campaign_total = await state.campaign_store.list_strict(limit=0)
        grouped = {
            "proposals": list(await state.proposals.list_strict()),
            "tuning": list(await state.tuning_store.list_strict()),
            "campaigns": list(campaigns),
            "batch_jobs": sorted(
                list(await state.batch_job_store.list_strict()),
                key=lambda job: str(getattr(job, "id", "")),
            ),
            "rule_versions": list(await state.rule_versions.list_strict()),
        }
    elif scope == "knowledge":
        grouped = await _knowledge_catalog_groups(state)
    else:
        raise ValueError(f"unknown export scope: {scope}")

    flattened = [
        {"group": group, "record": row}
        for group, rows in grouped.items()
        for row in rows
    ]
    try:
        offset = max(0, int(position or 0))
    except (TypeError, ValueError):
        offset = 0
    page = flattened[offset: offset + limit]
    next_position = offset + len(page) if offset + len(page) < len(flattened) else None
    return page, next_position, len(flattened), "live_values_at_read"


def _scope_repository(scope: str, state: AppState) -> Any | None:
    return {
        "cases": state.cases,
        "audit": state.audit,
        "usage": state.usage_store,
    }.get(scope)


async def _close_export_position(scope: str, state: AppState, position: Any) -> None:
    repository = _scope_repository(scope, state)
    if repository is None or position is None:
        return
    try:
        await repository.close_export_cursor(position)
    except Exception:  # noqa: BLE001 — PITs also expire; export response stays valid
        pass


def _consistency_manifest(mode: str) -> dict[str, Any]:
    if mode == "point_in_time":
        return {
            "mode": mode,
            "exact": True,
            "detail": "All segments read the same fixed Elasticsearch point-in-time snapshot.",
        }
    if mode == "bounded_at_start":
        return {
            "mode": mode,
            "exact": False,
            "detail": (
                "The record count is fixed at export start; values are read page by page "
                "and may reflect concurrent updates."
            ),
        }
    if mode == "live_values_at_read":
        return {
            "mode": mode,
            "exact": False,
            "detail": "Configuration/KV collections are read live for each segment.",
        }
    return {
        "mode": "unverified",
        "exact": False,
        "detail": "This repository cannot prove a complete fixed snapshot.",
    }


async def _segment_envelope(
    body: DataExportSegmentRequest,
    state: AppState,
    actor: str,
) -> tuple[dict[str, Any], bytes]:
    """Build one response-bounded segment, shrinking its record page when needed."""
    scope = str(body.scope)
    cursor_state = _decode_cursor(
        scope,
        body.cursor,
        actor=actor,
        signing_key=state.export_cursor_signing_key,
    )
    position = cursor_state["position"] if cursor_state else None
    exported_before = int(cursor_state["exported"]) if cursor_state else 0
    segment_number = int(cursor_state["segment"]) if cursor_state else 1
    snapshot_total = int(cursor_state["snapshot_total"]) if cursor_state else None
    snapshot_id = (
        str(cursor_state["snapshot_id"])
        if cursor_state
        else stdlib_secrets.token_urlsafe(18)
    )
    page_size = int(body.page_size)
    if snapshot_total is not None:
        page_size = min(page_size, max(1, snapshot_total - exported_before))

    while True:
        records, next_position, observed_total, consistency = await _collect_segment_page(
            scope, state, page_size, position,
        )
        if snapshot_total is None:
            snapshot_total = observed_total
        if snapshot_total is not None:
            remaining_before = max(0, snapshot_total - exported_before)
            if len(records) > remaining_before:
                records = records[:remaining_before]
        count = len(records)
        exported = exported_before + count
        complete = snapshot_total is not None and exported >= snapshot_total
        continuation_available = not complete and next_position is not None
        if complete:
            status = "complete"
        elif continuation_available:
            status = "partial"
        else:
            # A third-party repository may support only the legacy bounded read. Never
            # turn that into a false lifetime-complete claim.
            status = "unverified" if snapshot_total is None else "incomplete"
        next_cursor = (
            _encode_cursor(
                scope=scope,
                position=next_position,
                snapshot_total=snapshot_total,
                exported=exported,
                segment=segment_number + 1,
                actor=actor,
                snapshot_id=snapshot_id,
                signing_key=state.export_cursor_signing_key,
            )
            if continuation_available and snapshot_total is not None
            else None
        )
        envelope = {
            "format": "agentic-soc-portable-export-segment",
            "format_version": 2,
            "selection": {"scope": scope},
            "consistency": _consistency_manifest(consistency),
            "segment": {
                "number": segment_number,
                "requested_page_size": int(body.page_size),
                "count": count,
                "cumulative_count": exported,
                "snapshot_total": snapshot_total,
                "remaining": (
                    max(0, snapshot_total - exported)
                    if snapshot_total is not None
                    else None
                ),
                "complete": complete,
                "status": status,
                "next_cursor": next_cursor,
            },
            "limits": {
                "max_items_per_segment": _MAX_ITEMS_PER_SCOPE,
                "max_bytes_per_segment": _MAX_EXPORT_BYTES,
                "actual_page_size": page_size,
            },
            "excluded": _EXCLUDED,
            "records": await _run_blocking(_plain, records),
        }
        payload = await _run_blocking(_canonical_json_bytes, envelope)
        if len(payload) <= _MAX_EXPORT_BYTES:
            if complete or not continuation_available:
                await _close_export_position(scope, state, next_position or position)
            return envelope, payload
        if page_size <= 1:
            await _close_export_position(scope, state, next_position or position)
            raise HTTPException(
                status_code=413,
                detail=(
                    "one sanitized export record exceeds the 25 MiB segment limit; "
                    "export a narrower application scope"
                ),
            )
        page_size = max(1, page_size // 2)
        # Re-read the smaller page from the SAME PIT/start marker. A repository
        # returns its active PIT in ``next_position`` even when this oversized page
        # covered the whole snapshot, specifically so adaptive sizing cannot leak or
        # silently switch snapshots.
        if isinstance(next_position, dict) and next_position.get("pit"):
            previous_after = position.get("after") if isinstance(position, dict) else None
            previous_seen = position.get("seen", 0) if isinstance(position, dict) else 0
            position = {
                "pit": next_position["pit"],
                "after": previous_after,
                "seen": previous_seen,
            }


async def _close_archive_cursor(
    scope: str,
    cursor: str | None,
    state: AppState,
    actor: str,
) -> None:
    if not cursor:
        return
    try:
        cursor_state = _decode_cursor(
            scope,
            cursor,
            actor=actor,
            signing_key=state.export_cursor_signing_key,
        )
    except HTTPException:
        return
    await _close_export_position(
        scope,
        state,
        cursor_state.get("position") if cursor_state else None,
    )


async def _assemble_archive(
    path: str,
    scopes: list[str],
    state: AppState,
    actor: str,
    disconnected: Callable[[], Awaitable[bool]] | None = None,
    progressed: Callable[[str, int, int], Awaitable[None]] | None = None,
) -> tuple[dict[str, Any], str]:
    """Write every selected scope incrementally and add the manifest last."""
    archive = await _run_blocking(
        zipfile.ZipFile,
        path,
        "w",
        zipfile.ZIP_DEFLATED,
        True,
    )
    active_entry: Any | None = None
    active_scope = ""
    active_cursor: str | None = None
    scope_manifest: dict[str, dict[str, Any]] = {}
    assembly_succeeded = False
    try:
        for scope in scopes:
            active_scope = scope
            active_cursor = None
            entry_name = f"{scope}.ndjson"
            active_entry = await _run_blocking(
                archive.open,
                entry_name,
                "w",
                force_zip64=True,
            )
            first_consistency: dict[str, Any] | None = None
            snapshot_total: int | None = None
            exported = 0
            uncompressed_bytes = 0
            digest = hashlib.sha256()
            seen_cursors: set[str] = set()
            while True:
                if disconnected is not None and await disconnected():
                    raise asyncio.CancelledError
                body = DataExportSegmentRequest(
                    scope=scope,  # type: ignore[arg-type]
                    cursor=active_cursor,
                    page_size=_MAX_ITEMS_PER_SCOPE,
                )
                envelope, _bounded_payload = await _segment_envelope(
                    body,
                    state,
                    actor,
                )
                consistency = dict(envelope.get("consistency") or {})
                segment = dict(envelope.get("segment") or {})
                returned_cursor = segment.get("next_cursor")
                active_cursor = str(returned_cursor) if returned_cursor else None
                # Take ownership of the returned continuation/PIT before observing
                # disconnect, so cancellation always closes the newest live cursor.
                if disconnected is not None and await disconnected():
                    raise asyncio.CancelledError
                if consistency.get("mode") == "unverified":
                    raise HTTPException(
                        status_code=409,
                        detail=(
                            f"the {scope} export repository cannot verify its "
                            "consistency; no archive was produced"
                        ),
                    )
                if first_consistency is None:
                    first_consistency = consistency
                elif (
                    consistency.get("mode") != first_consistency.get("mode")
                    or consistency.get("exact") != first_consistency.get("exact")
                ):
                    raise HTTPException(
                        status_code=409,
                        detail=(
                            f"the {scope} export consistency changed during assembly; "
                            "no archive was produced"
                        ),
                    )
                observed_total = segment.get("snapshot_total")
                if not isinstance(observed_total, int) or isinstance(observed_total, bool):
                    raise HTTPException(
                        status_code=409,
                        detail=(
                            f"the {scope} export could not prove its starting record "
                            "count; no archive was produced"
                        ),
                    )
                if snapshot_total is None:
                    snapshot_total = observed_total
                elif observed_total != snapshot_total:
                    raise HTTPException(
                        status_code=409,
                        detail=(
                            f"the {scope} export count changed during assembly; "
                            "no archive was produced"
                        ),
                    )
                records = envelope.get("records")
                if not isinstance(records, list):
                    raise HTTPException(
                        status_code=409,
                        detail=f"the {scope} export returned malformed records",
                    )
                await _run_blocking(
                    _ensure_archive_capacity,
                    path,
                    len(_bounded_payload) + len(records) + 1024 * 1024,
                )
                uncompressed_bytes += int(
                    await _run_blocking(
                        _write_ndjson_page,
                        active_entry,
                        records,
                        digest,
                    )
                )
                exported = int(segment.get("cumulative_count") or 0)
                if progressed is not None:
                    await progressed(scope, exported, int(snapshot_total or 0))
                status = str(segment.get("status") or "unverified")
                complete = bool(segment.get("complete"))
                if complete and status == "complete":
                    if exported != snapshot_total:
                        raise HTTPException(
                            status_code=409,
                            detail=(
                                f"the {scope} export ended before its starting count "
                                "was emitted; no archive was produced"
                            ),
                        )
                    active_cursor = None
                    break
                if status in {"incomplete", "unverified"}:
                    raise HTTPException(
                        status_code=409,
                        detail=(
                            f"the {scope} export stopped with status={status}; "
                            "no archive was produced"
                        ),
                    )
                if (
                    status != "partial"
                    or not active_cursor
                    or not records
                    or active_cursor in seen_cursors
                ):
                    raise HTTPException(
                        status_code=409,
                        detail=(
                            f"the {scope} export made no verifiable forward progress; "
                            "no archive was produced"
                        ),
                    )
                seen_cursors.add(active_cursor)

            await _run_blocking(active_entry.close)
            active_entry = None
            consistency = first_consistency or _consistency_manifest("unverified")
            scope_manifest[scope] = {
                "snapshot_total": snapshot_total,
                "exported": exported,
                "status": "complete",
                "pit_consistent": bool(
                    consistency.get("mode") == "point_in_time"
                    and consistency.get("exact") is True
                ),
                "consistency": consistency,
                "entry": entry_name,
                "uncompressed_bytes": uncompressed_bytes,
                "sha256": digest.hexdigest(),
            }

        if disconnected is not None and await disconnected():
            raise asyncio.CancelledError
        generated = datetime.now(timezone.utc).replace(microsecond=0)
        generated_at = generated.isoformat().replace("+00:00", "Z")
        manifest = {
            "format": "agentic-soc-portable-export-archive",
            "format_version": 1,
            "generated_at": generated_at,
            "generated_by": actor,
            "provenance": current_record_provenance(),
            "selection": {"scopes": scopes},
            "limits": {
                "max_items_per_internal_page": _MAX_ITEMS_PER_SCOPE,
                "max_bytes_per_internal_page": _MAX_EXPORT_BYTES,
                "temporary_disk_reserve_bytes": _ARCHIVE_DISK_RESERVE_BYTES,
            },
            "semantics": {
                "delivery": "the complete ZIP is verified before the response starts",
                "scope_consistency": (
                    "each scope is captured independently; this is not one cross-scope "
                    "database transaction"
                ),
                "complete": (
                    "each scope emitted the record count fixed at that scope's start; "
                    "only consistency.exact=true proves fixed membership and values"
                ),
            },
            "excluded": _EXCLUDED,
            "scopes": scope_manifest,
            "complete": True,
        }
        manifest_payload = json.dumps(
            manifest,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        await _run_blocking(
            archive.writestr,
            "manifest.json",
            manifest_payload,
        )
        filename = f"agentic-soc-export-{generated.strftime('%Y%m%dT%H%M%SZ')}.zip"
        assembly_succeeded = True
        return manifest, filename
    finally:
        if active_entry is not None:
            try:
                await _run_blocking(active_entry.close)
            except Exception:  # noqa: BLE001 — preserve the primary assembly error
                pass
        if active_cursor:
            await _close_archive_cursor(active_scope, active_cursor, state, actor)
        try:
            await _run_blocking(archive.close)
        except Exception:  # noqa: BLE001 — incomplete archives are deleted by caller
            if assembly_succeeded:
                raise


@router.post("/admin/export")
async def export_application_data(
    body: DataExportRequest,
    state: AppState = Depends(get_state),
    actor: str = Depends(current_username),
    _=Depends(require_permission("data_export", "export")),
) -> Response:
    """Download a bounded, secret-free, canonical JSON snapshot of selected state."""
    scopes = _select_scopes([str(scope) for scope in body.scopes])
    data: dict[str, Any] = {}
    manifest: dict[str, Any] = {}
    for scope in scopes:
        try:
            value, meta = await _collect_scope(scope, state, body.limit_per_scope)
            data[scope] = _plain(value)
            manifest[scope] = meta
        except Exception:  # noqa: BLE001 — one optional scope should not erase the snapshot
            data[scope] = None
            manifest[scope] = {
                "count": 0, "total": 0, "truncated": False, "status": "unavailable"
            }

    envelope = {
        "format": "agentic-soc-portable-export",
        "format_version": 1,
        "selection": {"scopes": scopes},
        "limits": {
            "items_per_scope": int(body.limit_per_scope),
            "max_bytes": _MAX_EXPORT_BYTES,
        },
        "excluded": _EXCLUDED,
        "manifest": manifest,
        "data": data,
    }
    payload = json.dumps(
        envelope, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    if len(payload) > _MAX_EXPORT_BYTES:
        raise HTTPException(
            status_code=413,
            detail=(
                "export exceeds the 25 MiB safety limit; select fewer scopes or "
                "lower limit_per_scope"
            ),
        )

    # Append-only audit AFTER capture so this download does not unexpectedly add
    # itself to its own audit scope. A future export will include the event.
    try:
        await state.control_audit.record_strict(
            action_type=ActionType.DATA_EXPORT,
            surface="settings",
            actor=actor or "local-operator",
            result_summary=f"exported scopes={','.join(scopes)} bytes={len(payload)}",
        )
    except Exception as exc:  # noqa: BLE001 — privileged delivery fails closed
        raise HTTPException(
            status_code=503,
            detail="the export audit trail is unavailable; no export was delivered",
        ) from exc

    return Response(
        content=payload,
        media_type="application/json",
        headers={
            "Content-Disposition": 'attachment; filename="agentic-soc-export.json"',
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.post(
    "/admin/export/archive",
    deprecated=True,
    response_class=StreamingResponse,
    responses={
        200: {
            "description": "One complete server-assembled portable export archive.",
            "content": {
                "application/zip": {
                    "schema": {"type": "string", "format": "binary"},
                },
            },
        },
    },
)
async def export_application_data_archive(
    body: DataExportArchiveRequest,
    request: Request,
    state: AppState = Depends(get_state),
    actor: str = Depends(current_username),
    _permission: Any = Depends(_ARCHIVE_PERMISSION_DEP),
    _fresh: Any = Depends(_ARCHIVE_FRESH_DEP),
) -> Response:
    """Deprecated request-bound compatibility export.

    New operator workflows submit ``data_export_archive`` through ``POST /api/jobs``
    so assembly survives navigation, reports durable progress, and produces a
    permission-rechecked artifact. This route remains for existing API integrations.

    Every NDJSON member is written one bounded segment page at a time. The terminal
    manifest is added only after every selected repository emitted its starting count;
    no response begins before the ZIP is complete, freshly authorized, and audited.
    """
    if not _ARCHIVE_SLOT.acquire(blocking=False):
        raise HTTPException(
            status_code=409,
            detail=(
                "another archive export is already being assembled or served; "
                "retry after it finishes or use the resumable segment export"
            ),
        )

    artifact = _ArchiveArtifact()
    effective_actor = actor or "local-operator"
    try:
        artifact.path = await _run_blocking(_new_archive_path)
        await _run_blocking(
            _ensure_archive_capacity,
            artifact.path,
            _MAX_EXPORT_BYTES,
        )
        scopes = _select_scopes([str(scope) for scope in body.scopes])
        manifest, filename = await _assemble_archive(
            artifact.path,
            scopes,
            state,
            effective_actor,
            request.is_disconnected,
        )
        await _run_blocking(_verify_archive, artifact.path, scopes, manifest)

        # Assembly can outlive a short sudo window or an operator's grant. Re-run both
        # gates against the same request immediately before audit and response creation.
        await _ARCHIVE_PERMISSION_DEP(request)
        await _ARCHIVE_FRESH_DEP(request)

        archive_size = await _run_blocking(os.path.getsize, artifact.path)
        counts = ",".join(
            f"{scope}={int(meta['exported'])}"
            for scope, meta in manifest["scopes"].items()
        )
        try:
            await state.control_audit.record_strict(
                action_type=ActionType.DATA_EXPORT,
                surface="settings",
                actor=effective_actor,
                result_summary=(
                    f"prepared archive scopes={','.join(scopes)} records={counts} "
                    f"complete=true bytes={archive_size}"
                ),
            )
        except Exception as exc:  # noqa: BLE001 — privileged delivery fails closed
            raise HTTPException(
                status_code=503,
                detail=(
                    "the export audit trail is unavailable; no archive was delivered"
                ),
            ) from exc

        return _ArchiveStreamingResponse(
            _stream_archive(artifact.path, artifact.cleanup),
            cleanup=artifact.cleanup,
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"',
                "Content-Length": str(archive_size),
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
                "X-Accel-Buffering": "no",
            },
        )
    except HTTPException:
        await artifact.cleanup()
        raise
    except asyncio.CancelledError:
        await artifact.cleanup()
        raise
    except Exception as exc:  # noqa: BLE001 — hide filesystem/backend internals
        await artifact.cleanup()
        raise HTTPException(
            status_code=503,
            detail="the export archive could not be assembled; no archive was delivered",
        ) from exc


@router.post("/admin/export/segment", deprecated=True)
async def export_application_data_segment(
    body: DataExportSegmentRequest,
    state: AppState = Depends(get_state),
    actor: str = Depends(current_username),
    _permission=Depends(require_permission("data_export", "export")),
    _fresh=Depends(require_fresh_auth()),
) -> Response:
    """Deprecated request-bound compatibility segment.

    New operator workflows submit ``data_export_segment`` through ``POST /api/jobs``;
    that worker owns the complete cursor loop and returns one verified artifact. This
    one-page primitive remains for existing integrations and explicit cursor recovery.

    The 5,000-record setting is deliberately a per-segment memory/response bound,
    not a lifetime ceiling. The Console follows ``next_cursor`` until ``complete``;
    each accepted response remains below 25 MiB. Elasticsearch-backed ledgers/cases
    use one PIT carried in the opaque cursor across requests, while other backends
    disclose their weaker consistency mode rather than claiming an exact snapshot.
    """
    effective_actor = actor or "local-operator"
    try:
        envelope, payload = await _segment_envelope(body, state, effective_actor)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 — translate opaque backend/PIT failures
        if body.cursor:
            cursor_state = _decode_cursor(
                str(body.scope),
                body.cursor,
                actor=effective_actor,
                signing_key=state.export_cursor_signing_key,
            )
            await _close_export_position(
                str(body.scope), state,
                cursor_state.get("position") if cursor_state else None,
            )
            raise HTTPException(
                status_code=409,
                detail=(
                    "the export snapshot expired or became unavailable; restart this "
                    "scope from its first segment"
                ),
            ) from exc
        raise HTTPException(
            status_code=503,
            detail=f"the {body.scope} export scope is temporarily unavailable",
        ) from exc
    segment = envelope["segment"]
    try:
        await state.control_audit.record_strict(
            action_type=ActionType.DATA_EXPORT,
            surface="settings",
            actor=effective_actor,
            result_summary=(
                f"exported segment scope={body.scope} part={segment['number']} "
                f"records={segment['count']} cumulative={segment['cumulative_count']} "
                f"status={segment['status']} bytes={len(payload)}"
            ),
        )
    except Exception as exc:  # noqa: BLE001 — privileged delivery fails closed
        next_cursor = segment.get("next_cursor")
        if next_cursor:
            cursor_state = _decode_cursor(
                str(body.scope),
                str(next_cursor),
                actor=effective_actor,
                signing_key=state.export_cursor_signing_key,
            )
            await _close_export_position(
                str(body.scope), state,
                cursor_state.get("position") if cursor_state else None,
            )
        raise HTTPException(
            status_code=503,
            detail=(
                "the export audit trail is unavailable; this segment was not delivered"
            ),
        ) from exc

    filename = f"agentic-soc-{body.scope}-part-{int(segment['number']):05d}.json"
    return Response(
        content=payload,
        media_type="application/json",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.post("/admin/export/segment/cancel")
async def cancel_application_data_segment(
    body: DataExportSegmentCancelRequest,
    state: AppState = Depends(get_state),
    actor: str = Depends(current_username),
    _permission=Depends(require_permission("data_export", "export")),
    _fresh=Depends(require_fresh_auth()),
) -> dict[str, bool]:
    """Best-effort release of a PIT when an operator cancels a segmented export."""
    cursor_state = _decode_cursor(
        str(body.scope),
        body.cursor,
        actor=actor or "local-operator",
        signing_key=state.export_cursor_signing_key,
    )
    await _close_export_position(
        str(body.scope), state, cursor_state.get("position") if cursor_state else None,
    )
    return {"ok": True}
