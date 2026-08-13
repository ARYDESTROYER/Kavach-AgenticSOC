"""Atomic server-side portable export archive contracts (offline)."""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import os
import re
import threading
import zipfile
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator, Callable

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.api import routes_export
from app.api.deps import require_auth
from app.api.routes import router as base_router
from app.build_identity import current_record_provenance
from app.config import Secrets
from app.constants import ActionType
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.models import AuditDoc
from app.state import AppState


def _export_app(
    *,
    auth_enabled: bool = False,
    rbac_enabled: bool = False,
    sudo_reauth_window: int = 600,
    configure: Callable[[AppState], Any] | None = None,
) -> tuple[FastAPI, dict[str, AppState]]:
    """Build the real export router with the production auth boundary."""

    holder: dict[str, AppState] = {}
    secrets = Secrets(
        _env_file=None,
        es_store_enabled=False,
        redis_url="",
        anthropic_api_key=None,
        openai_api_key=None,
        auth_enabled=auth_enabled,
        auth_jwt_secret="archive-export-test-secret",
        auth_seed_admin=True,
    )
    mock = MockProvider()
    overrides = {"anthropic": mock, "openai": mock, "mock": mock}

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        state = AppState.create(
            secrets=secrets,
            es=InMemoryESClient(),
            provider_overrides=overrides,
        )
        await state.startup(start_poller=False)
        prefs = state.prefs.model_copy(deep=True)
        prefs.setup_complete = True
        prefs.rbac.enabled = rbac_enabled
        prefs.session_policy.sudo_reauth_window = sudo_reauth_window
        await state.update_prefs(prefs)
        if configure is not None:
            configured = configure(state)
            if hasattr(configured, "__await__"):
                await configured
        holder["state"] = state
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    if auth_enabled:
        api.include_router(base_router, dependencies=[Depends(require_auth)])
        api.include_router(
            routes_export.router,
            dependencies=[Depends(require_auth)],
        )
    else:
        api.include_router(routes_export.router)
    return api, holder


def _sqlite_export_app(
    database_path: Path,
    *,
    configure: Callable[[AppState], Any] | None = None,
) -> tuple[FastAPI, dict[str, AppState]]:
    holder: dict[str, AppState] = {}
    secrets = Secrets(
        _env_file=None,
        es_store_enabled=False,
        redis_url="",
        anthropic_api_key=None,
        openai_api_key=None,
        state_backend="sqlite",
        state_db_url=f"sqlite+aiosqlite:///{database_path}",
    )
    mock = MockProvider()
    overrides = {"anthropic": mock, "openai": mock, "mock": mock}

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        state = AppState.create(
            secrets=secrets,
            es=InMemoryESClient(),
            provider_overrides=overrides,
        )
        await state.startup(start_poller=False)
        if configure is not None:
            configured = configure(state)
            if hasattr(configured, "__await__"):
                await configured
        holder["state"] = state
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(routes_export.router)
    return api, holder


def _capture_archive_path(monkeypatch: pytest.MonkeyPatch, path: Path) -> None:
    """Make archive cleanup observable without changing production behavior."""

    def create() -> str:
        path.touch(exist_ok=False)
        return str(path)

    monkeypatch.setattr(routes_export, "_new_archive_path", create)


def _read_zip(payload: bytes) -> tuple[list[str], dict[str, bytes]]:
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        names = archive.namelist()
        return names, {name: archive.read(name) for name in names}


def _read_ndjson(payload: bytes) -> list[dict[str, Any]]:
    return [json.loads(line) for line in payload.splitlines() if line]


def _assert_archive_slot_free() -> None:
    assert routes_export._ARCHIVE_SLOT.acquire(blocking=False)
    routes_export._ARCHIVE_SLOT.release()


def test_archive_response_is_one_complete_zip_with_real_length_and_provenance(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    archive_path = tmp_path / "single-export.zip"
    _capture_archive_path(monkeypatch, archive_path)
    monkeypatch.setenv("TLSOC_BUILD_SHA", "archive-build-sha")
    audit_summaries: list[str] = []

    async def configure(state: AppState) -> None:
        real_record = state.control_audit.record_strict

        async def capture_audit(*args: Any, **kwargs: Any) -> Any:
            audit_summaries.append(str(kwargs.get("result_summary") or ""))
            return await real_record(*args, **kwargs)

        state.control_audit.record_strict = capture_audit  # type: ignore[method-assign]

    api, _holder = _export_app(configure=configure)

    with TestClient(api) as client:
        response = client.post(
            "/api/admin/export/archive",
            json={"scopes": ["configuration"]},
        )

    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "application/zip"
    assert int(response.headers["content-length"]) == len(response.content)
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["x-accel-buffering"] == "no"
    assert re.fullmatch(
        r'attachment; filename="agentic-soc-export-\d{8}T\d{6}Z\.zip"',
        response.headers["content-disposition"],
    )
    assert response.content.startswith(b"PK")

    names, members = _read_zip(response.content)
    assert names == ["configuration.ndjson", "manifest.json"]
    rows = _read_ndjson(members["configuration.ndjson"])
    manifest = json.loads(members["manifest.json"])
    assert manifest["format"] == "agentic-soc-portable-export-archive"
    assert manifest["format_version"] == 1
    assert manifest["generated_at"].endswith("Z")
    assert manifest["generated_by"] == "local-operator"
    assert manifest["provenance"] == current_record_provenance()
    assert manifest["provenance"]["build_sha"] == "archive-build-sha"
    assert manifest["selection"] == {"scopes": ["configuration"]}
    assert manifest["complete"] is True
    scope_manifest = manifest["scopes"]["configuration"]
    assert scope_manifest["snapshot_total"] == len(rows)
    assert scope_manifest["exported"] == len(rows)
    assert scope_manifest["status"] == "complete"
    assert scope_manifest["pit_consistent"] is False
    assert scope_manifest["consistency"] == {
        "mode": "live_values_at_read",
        "exact": False,
        "detail": "Configuration/KV collections are read live for each segment.",
    }
    assert scope_manifest["entry"] == "configuration.ndjson"
    assert scope_manifest["uncompressed_bytes"] == len(
        members["configuration.ndjson"]
    )
    assert scope_manifest["sha256"] == hashlib.sha256(
        members["configuration.ndjson"]
    ).hexdigest()
    assert any(
        summary.startswith(
            "prepared archive scopes=configuration records=configuration="
        )
        and " complete=true bytes=" in summary
        for summary in audit_summaries
    )
    assert not archive_path.exists()
    _assert_archive_slot_free()


def test_archive_empty_request_defaults_to_every_safe_scope(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    archive_path = tmp_path / "default-all.zip"
    _capture_archive_path(monkeypatch, archive_path)
    api, _holder = _export_app()

    with TestClient(api) as client:
        response = client.post("/api/admin/export/archive", json={})

    assert response.status_code == 200, response.text
    names, members = _read_zip(response.content)
    expected_scopes = list(routes_export._SCOPE_ORDER)
    assert names == [*(f"{scope}.ndjson" for scope in expected_scopes), "manifest.json"]
    manifest = json.loads(members["manifest.json"])
    assert manifest["selection"] == {"scopes": expected_scopes}
    assert set(manifest["scopes"]) == set(expected_scopes)
    assert manifest["complete"] is True
    assert all(
        metadata["entry"] == f"{scope}.ndjson"
        and metadata["status"] == "complete"
        and metadata["exported"] == metadata["snapshot_total"]
        for scope, metadata in manifest["scopes"].items()
    )
    assert not archive_path.exists()
    _assert_archive_slot_free()


def test_archive_ndjson_is_lossless_and_ordered_like_segment_walk(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    archive_path = tmp_path / "parity.zip"
    _capture_archive_path(monkeypatch, archive_path)
    api, _holder = _export_app()

    segmented: list[dict[str, Any]] = []
    cursor: str | None = None
    with TestClient(api) as client:
        while True:
            segment_response = client.post(
                "/api/admin/export/segment",
                json={
                    "scope": "knowledge",
                    "cursor": cursor,
                    "page_size": 2,
                },
            )
            assert segment_response.status_code == 200, segment_response.text
            segment = segment_response.json()
            segmented.extend(segment["records"])
            if segment["segment"]["complete"]:
                break
            cursor = segment["segment"]["next_cursor"]
            assert cursor

        archive_response = client.post(
            "/api/admin/export/archive",
            json={"scopes": ["knowledge"]},
        )

    assert archive_response.status_code == 200, archive_response.text
    names, members = _read_zip(archive_response.content)
    assert names == ["knowledge.ndjson", "manifest.json"]
    archived = _read_ndjson(members["knowledge.ndjson"])
    manifest = json.loads(members["manifest.json"])
    assert archived == segmented
    assert manifest["scopes"]["knowledge"]["snapshot_total"] == len(segmented)
    assert manifest["scopes"]["knowledge"]["exported"] == len(segmented)
    assert manifest["scopes"]["knowledge"]["status"] == "complete"
    assert not archive_path.exists()


def test_archive_crosses_5000_using_only_bounded_sequential_pages(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    archive_path = tmp_path / "multipage.zip"
    _capture_archive_path(monkeypatch, archive_path)
    collect_calls: list[tuple[int, int | None]] = []
    write_batches: list[int] = []

    async def collect_page(
        _scope: str,
        _state: AppState,
        limit: int,
        position: Any,
    ) -> tuple[list[dict[str, Any]], int | None, int, str]:
        start = int(position or 0)
        collect_calls.append((limit, None if position is None else start))
        end = min(start + limit, 5001)
        records = [{"record": {"sequence": index}} for index in range(start, end)]
        return records, (end if end < 5001 else None), 5001, "bounded_at_start"

    real_write = routes_export._write_ndjson_page

    def track_write(entry: Any, records: list[Any], digest: Any) -> int:
        write_batches.append(len(records))
        return int(real_write(entry, records, digest))

    monkeypatch.setattr(routes_export, "_collect_segment_page", collect_page)
    monkeypatch.setattr(routes_export, "_write_ndjson_page", track_write)
    api, _holder = _export_app()

    with TestClient(api) as client:
        response = client.post(
            "/api/admin/export/archive",
            json={"scopes": ["configuration"]},
        )

    assert response.status_code == 200, response.text
    _names, members = _read_zip(response.content)
    rows = _read_ndjson(members["configuration.ndjson"])
    manifest = json.loads(members["manifest.json"])
    assert collect_calls == [(5000, None), (1, 5000)]
    assert write_batches == [5000, 1]
    assert max(size for size, _position in collect_calls) <= 5000
    assert [row["record"]["sequence"] for row in rows] == list(range(5001))
    assert manifest["scopes"]["configuration"]["exported"] == 5001
    assert manifest["scopes"]["configuration"]["snapshot_total"] == 5001
    assert manifest["scopes"]["configuration"]["consistency"]["mode"] == (
        "bounded_at_start"
    )
    assert not archive_path.exists()


def test_archive_uses_real_sqlite_pages_and_discloses_weaker_consistency(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    archive_path = tmp_path / "sqlite-state-export.zip"
    database_path = tmp_path / "archive-state.db"
    _capture_archive_path(monkeypatch, archive_path)
    expected_rows: list[dict[str, Any]] = []

    async def configure(state: AppState) -> None:
        for index in range(3):
            await state.audit.write_strict(
                AuditDoc(
                    ts=f"2026-08-13T00:00:0{index}+00:00",
                    action_type=ActionType.POLL,
                    actor="sqlite-seed",
                    result_summary=f"sqlite-row-{index}",
                )
            )
        page, cursor, total, mode = await state.audit.export_page(limit=5000)
        assert cursor is None and total == len(page) and mode == "bounded_at_start"
        expected_rows.extend(page)

    api, _holder = _sqlite_export_app(database_path, configure=configure)

    with TestClient(api) as client:
        response = client.post(
            "/api/admin/export/archive",
            json={"scopes": ["audit"]},
        )

    assert response.status_code == 200, response.text
    names, members = _read_zip(response.content)
    assert names == ["audit.ndjson", "manifest.json"]
    archived = _read_ndjson(members["audit.ndjson"])
    assert archived == [{"record": row} for row in expected_rows]
    assert [row["record"]["result_summary"] for row in archived] == [
        "sqlite-row-0",
        "sqlite-row-1",
        "sqlite-row-2",
    ]
    scope_manifest = json.loads(members["manifest.json"])["scopes"]["audit"]
    assert scope_manifest["snapshot_total"] == len(expected_rows) == 3
    assert scope_manifest["exported"] == len(expected_rows)
    assert scope_manifest["status"] == "complete"
    assert scope_manifest["pit_consistent"] is False
    assert scope_manifest["consistency"] == {
        "mode": "bounded_at_start",
        "exact": False,
        "detail": (
            "The record count is fixed at export start; values are read page by page "
            "and may reflect concurrent updates."
        ),
    }
    assert not archive_path.exists()
    _assert_archive_slot_free()


@pytest.mark.parametrize("unsafe_scope", ["users", "secrets"])
def test_archive_request_schema_rejects_unsafe_scopes_before_temp_allocation(
    monkeypatch: pytest.MonkeyPatch,
    unsafe_scope: str,
) -> None:
    api, _holder = _export_app()

    def must_not_create() -> str:
        raise AssertionError("schema-invalid scopes must not allocate an archive")

    monkeypatch.setattr(routes_export, "_new_archive_path", must_not_create)
    with TestClient(api) as client:
        response = client.post(
            "/api/admin/export/archive",
            json={"scopes": [unsafe_scope]},
        )

    assert response.status_code == 422
    assert response.headers["content-type"].startswith("application/json")
    assert "content-disposition" not in response.headers
    _assert_archive_slot_free()


@pytest.mark.parametrize("failure", ["unverified", "incomplete"])
def test_archive_never_delivers_or_marks_manifest_on_unproven_scope(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    failure: str,
) -> None:
    archive_path = tmp_path / f"{failure}.zip"
    _capture_archive_path(monkeypatch, archive_path)
    deleted_members: list[str] = []

    async def failed_segment(
        _body: Any,
        _state: AppState,
        _actor: str,
    ) -> tuple[dict[str, Any], bytes]:
        unverified = failure == "unverified"
        envelope = {
            "consistency": {
                "mode": "unverified" if unverified else "bounded_at_start",
                "exact": False,
            },
            "segment": {
                "snapshot_total": None if unverified else 2,
                "cumulative_count": 0 if unverified else 1,
                "status": failure,
                "complete": False,
                "next_cursor": None,
            },
            "records": [] if unverified else [{"record": {"sequence": 0}}],
        }
        return envelope, b"unused"

    def inspect_then_unlink(path: str) -> None:
        if os.path.exists(path):
            with zipfile.ZipFile(path) as archive:
                deleted_members.extend(archive.namelist())
            os.unlink(path)

    monkeypatch.setattr(routes_export, "_segment_envelope", failed_segment)
    monkeypatch.setattr(routes_export, "_unlink_archive", inspect_then_unlink)
    api, _holder = _export_app()

    with TestClient(api) as client:
        response = client.post(
            "/api/admin/export/archive",
            json={"scopes": ["configuration"]},
        )

    assert response.status_code == 409
    assert response.headers["content-type"].startswith("application/json")
    assert "content-disposition" not in response.headers
    assert "no archive was produced" in response.json()["detail"]
    assert "manifest.json" not in deleted_members
    assert not archive_path.exists()
    _assert_archive_slot_free()


@pytest.mark.parametrize("failure", ["assembly", "audit"])
def test_archive_tempfile_is_deleted_and_slot_released_on_server_error(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    failure: str,
) -> None:
    archive_path = tmp_path / f"{failure}-error.zip"
    _capture_archive_path(monkeypatch, archive_path)

    async def fail_assembly(*_args: Any, **_kwargs: Any) -> Any:
        raise RuntimeError("injected assembly failure")

    async def configure(state: AppState) -> None:
        if failure != "audit":
            return

        async def fail_audit(*_args: Any, **_kwargs: Any) -> None:
            raise RuntimeError("injected audit failure")

        state.control_audit.record_strict = fail_audit  # type: ignore[method-assign]

    if failure == "assembly":
        monkeypatch.setattr(routes_export, "_assemble_archive", fail_assembly)
    api, _holder = _export_app(configure=configure)

    with TestClient(api) as client:
        response = client.post(
            "/api/admin/export/archive",
            json={"scopes": ["configuration"]},
        )

    assert response.status_code == 503
    assert response.headers["content-type"].startswith("application/json")
    assert "content-disposition" not in response.headers
    assert "no archive was delivered" in response.json()["detail"]
    assert not archive_path.exists()
    _assert_archive_slot_free()


def test_archive_disk_reserve_failure_returns_507_without_artifact_or_audit(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    archive_path = tmp_path / "no-capacity.zip"
    _capture_archive_path(monkeypatch, archive_path)
    audit_calls: list[dict[str, Any]] = []

    async def configure(state: AppState) -> None:
        real_record = state.control_audit.record_strict

        async def capture_audit(*args: Any, **kwargs: Any) -> Any:
            audit_calls.append(dict(kwargs))
            return await real_record(*args, **kwargs)

        state.control_audit.record_strict = capture_audit  # type: ignore[method-assign]

    class _NoSpace:
        free = 0

    monkeypatch.setattr(routes_export.shutil, "disk_usage", lambda _path: _NoSpace())
    api, _holder = _export_app(configure=configure)

    with TestClient(api) as client:
        response = client.post(
            "/api/admin/export/archive",
            json={"scopes": ["configuration"]},
        )

    assert response.status_code == 507
    assert "temporary storage is too full" in response.json()["detail"]
    assert "content-disposition" not in response.headers
    assert audit_calls == []
    assert not archive_path.exists()
    _assert_archive_slot_free()


def test_archive_verifier_rejection_deletes_artifact_before_audit_or_delivery(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    archive_path = tmp_path / "verification-rejected.zip"
    _capture_archive_path(monkeypatch, archive_path)
    audit_calls: list[dict[str, Any]] = []
    real_assemble = routes_export._assemble_archive

    async def configure(state: AppState) -> None:
        real_record = state.control_audit.record_strict

        async def capture_audit(*args: Any, **kwargs: Any) -> Any:
            audit_calls.append(dict(kwargs))
            return await real_record(*args, **kwargs)

        state.control_audit.record_strict = capture_audit  # type: ignore[method-assign]

    def corrupt_completed_archive(path: str, manifest: dict[str, Any]) -> None:
        with zipfile.ZipFile(path, "r") as archive:
            scope_payload = archive.read("configuration.ndjson")
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
            archive.writestr(
                "configuration.ndjson",
                scope_payload + b'{"record":{"tampered":true}}\n',
            )
            archive.writestr(
                "manifest.json",
                json.dumps(
                    manifest,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                ).encode("utf-8"),
            )

    async def assemble_then_corrupt(
        path: str,
        scopes: list[str],
        state: AppState,
        actor: str,
        disconnected: Callable[[], Any] | None = None,
    ) -> tuple[dict[str, Any], str]:
        manifest, filename = await real_assemble(
            path,
            scopes,
            state,
            actor,
            disconnected,
        )
        await routes_export._run_blocking(
            corrupt_completed_archive,
            path,
            manifest,
        )
        return manifest, filename

    monkeypatch.setattr(routes_export, "_assemble_archive", assemble_then_corrupt)
    api, _holder = _export_app(configure=configure)

    with TestClient(api) as client:
        response = client.post(
            "/api/admin/export/archive",
            json={"scopes": ["configuration"]},
        )

    assert response.status_code == 503
    assert response.json()["detail"] == (
        "the completed export archive failed integrity verification"
    )
    assert "content-disposition" not in response.headers
    assert audit_calls == []
    assert not archive_path.exists()
    _assert_archive_slot_free()


@pytest.mark.asyncio
async def test_archive_disconnect_poll_aborts_assembly_and_cleans_tempfile(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    archive_path = tmp_path / "assembly-disconnect.zip"
    _capture_archive_path(monkeypatch, archive_path)

    class _DisconnectedRequest:
        polls = 0

        async def is_disconnected(self) -> bool:
            self.polls += 1
            return True

    request = _DisconnectedRequest()
    with pytest.raises(asyncio.CancelledError):
        await routes_export.export_application_data_archive(
            routes_export.DataExportArchiveRequest(scopes=["configuration"]),
            request,  # type: ignore[arg-type]
            state=object(),  # type: ignore[arg-type]
            actor="disconnecting-operator",
            _permission=None,
            _fresh=None,
        )

    assert request.polls == 1
    assert not archive_path.exists()
    _assert_archive_slot_free()


@pytest.mark.asyncio
async def test_disconnect_after_partial_page_closes_newest_signed_pit_cursor(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    archive_path = tmp_path / "disconnect-after-page.zip"
    _capture_archive_path(monkeypatch, archive_path)
    actor = "pit-disconnect-operator"
    signing_key = b"archive-pit-cursor-test-key" * 2
    position = {"pit": "pit-newest-live", "after": ["sort-1"], "seen": 1}
    cursor = routes_export._encode_cursor(
        scope="audit",
        position=position,
        snapshot_total=2,
        exported=1,
        segment=2,
        actor=actor,
        snapshot_id="snapshot_archive_disconnect",
        signing_key=signing_key,
    )
    close_calls: list[tuple[str, Any]] = []
    audit_calls: list[dict[str, Any]] = []

    async def partial_segment(*_args: Any, **_kwargs: Any) -> tuple[dict[str, Any], bytes]:
        return (
            {
                "consistency": {"mode": "point_in_time", "exact": True},
                "segment": {
                    "snapshot_total": 2,
                    "cumulative_count": 1,
                    "status": "partial",
                    "complete": False,
                    "next_cursor": cursor,
                },
                "records": [{"record": {"sequence": 0}}],
            },
            b"bounded-page",
        )

    async def capture_close(_scope: str, _state: Any, captured: Any) -> None:
        close_calls.append((_scope, captured))

    class _Audit:
        async def record_strict(self, *args: Any, **kwargs: Any) -> None:
            audit_calls.append(dict(kwargs))

    class _State:
        export_cursor_signing_key = signing_key
        control_audit = _Audit()

    class _DisconnectAfterPage:
        polls = 0

        async def is_disconnected(self) -> bool:
            self.polls += 1
            return self.polls >= 2

    request = _DisconnectAfterPage()
    monkeypatch.setattr(routes_export, "_segment_envelope", partial_segment)
    monkeypatch.setattr(routes_export, "_close_export_position", capture_close)

    with pytest.raises(asyncio.CancelledError):
        await routes_export.export_application_data_archive(
            routes_export.DataExportArchiveRequest(scopes=["audit"]),
            request,  # type: ignore[arg-type]
            state=_State(),  # type: ignore[arg-type]
            actor=actor,
            _permission=None,
            _fresh=None,
        )

    assert request.polls == 2
    assert close_calls == [("audit", position)]
    assert audit_calls == []
    assert not archive_path.exists()
    _assert_archive_slot_free()


@pytest.mark.asyncio
async def test_archive_cancelled_assembly_after_allocation_cleans_tempfile(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    archive_path = tmp_path / "cancelled-assembly.zip"
    _capture_archive_path(monkeypatch, archive_path)

    async def cancel_assembly(*_args: Any, **_kwargs: Any) -> Any:
        raise asyncio.CancelledError

    class _ConnectedRequest:
        async def is_disconnected(self) -> bool:
            return False

    monkeypatch.setattr(routes_export, "_assemble_archive", cancel_assembly)
    with pytest.raises(asyncio.CancelledError):
        await routes_export.export_application_data_archive(
            routes_export.DataExportArchiveRequest(scopes=["configuration"]),
            _ConnectedRequest(),  # type: ignore[arg-type]
            state=object(),  # type: ignore[arg-type]
            actor="cancelled-operator",
            _permission=None,
            _fresh=None,
        )

    assert not archive_path.exists()
    _assert_archive_slot_free()


@pytest.mark.asyncio
async def test_cancelled_blocking_writer_finishes_before_archive_unlink(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    archive_path = tmp_path / "shielded-writer.zip"
    archive_path.write_bytes(b"start")
    writer_started = threading.Event()
    allow_writer_finish = threading.Event()
    writer_finished = threading.Event()
    cleanup_observations: list[bool] = []
    real_unlink = routes_export._unlink_archive

    def slow_writer() -> None:
        writer_started.set()
        assert allow_writer_finish.wait(timeout=2)
        with archive_path.open("ab") as handle:
            handle.write(b"-finished")
        writer_finished.set()

    def observe_unlink(path: str) -> None:
        cleanup_observations.append(writer_finished.is_set())
        real_unlink(path)

    monkeypatch.setattr(routes_export, "_unlink_archive", observe_unlink)
    assert routes_export._ARCHIVE_SLOT.acquire(blocking=False)
    artifact = routes_export._ArchiveArtifact()
    artifact.path = str(archive_path)

    async def write_then_cleanup() -> None:
        try:
            await routes_export._run_blocking(slow_writer)
        finally:
            await artifact.cleanup()

    task = asyncio.create_task(write_then_cleanup())
    try:
        assert await asyncio.to_thread(writer_started.wait, 1)
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done()
        assert archive_path.exists()
        assert cleanup_observations == []
        allow_writer_finish.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert writer_finished.is_set()
        assert cleanup_observations == [True]
        assert not archive_path.exists()
        _assert_archive_slot_free()
    finally:
        allow_writer_finish.set()
        await artifact.cleanup()


@pytest.mark.asyncio
async def test_archive_asgi_send_failure_still_deletes_file_and_releases_slot(
    tmp_path: Path,
) -> None:
    archive_path = tmp_path / "send-failure.zip"
    archive_path.write_bytes(b"archive-body")
    assert routes_export._ARCHIVE_SLOT.acquire(blocking=False)
    artifact = routes_export._ArchiveArtifact()
    artifact.path = str(archive_path)
    response = routes_export._ArchiveStreamingResponse(
        routes_export._stream_archive(str(archive_path), artifact.cleanup),
        cleanup=artifact.cleanup,
        headers={"Content-Length": str(archive_path.stat().st_size)},
    )
    sent_types: list[str] = []

    async def receive() -> dict[str, Any]:
        await asyncio.Future()
        raise AssertionError("unreachable")

    async def send(message: dict[str, Any]) -> None:
        sent_types.append(message["type"])
        if message["type"] == "http.response.body":
            raise RuntimeError("injected client disconnect")

    try:
        with pytest.raises(BaseException):
            await response(
                {"type": "http", "method": "POST", "path": "/export"},
                receive,
                send,
            )
        assert sent_types[:2] == ["http.response.start", "http.response.body"]
        assert not archive_path.exists()
        _assert_archive_slot_free()
    finally:
        await response.body_iterator.aclose()  # type: ignore[union-attr]
        await artifact.cleanup()


def test_archive_returns_409_while_process_slot_is_busy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    api, _holder = _export_app()
    assert routes_export._ARCHIVE_SLOT.acquire(blocking=False)

    def must_not_create() -> str:
        raise AssertionError("a busy request must not allocate a temp file")

    monkeypatch.setattr(routes_export, "_new_archive_path", must_not_create)
    try:
        with TestClient(api) as client:
            response = client.post(
                "/api/admin/export/archive",
                json={"scopes": ["configuration"]},
            )
    finally:
        routes_export._ARCHIVE_SLOT.release()

    assert response.status_code == 409
    assert "another archive export" in response.json()["detail"]


@pytest.mark.parametrize("role", ["analyst_tier2", "auditor"])
def test_archive_real_router_denies_role_without_export_permission(role: str) -> None:
    api, _holder = _export_app(auth_enabled=True, rbac_enabled=True)
    username = f"{role}-export-test"

    with TestClient(api) as client:
        login = client.post(
            "/api/auth/login",
            json={"username": "Admin", "password": "Admin@123"},
        )
        assert login.status_code == 200, login.text
        created = client.post(
            "/api/users",
            json={
                "username": username,
                "password": "archive-role-test-pass",
                "role": role,
            },
        )
        assert created.status_code == 200, created.text
        client.cookies.clear()
        login = client.post(
            "/api/auth/login",
            json={
                "username": username,
                "password": "archive-role-test-pass",
            },
        )
        assert login.status_code == 200, login.text
        denied = client.post(
            "/api/admin/export/archive",
            json={"scopes": ["configuration"]},
        )

    assert denied.status_code == 403
    assert denied.json()["detail"] == "permission denied: data_export:export"
    assert "content-disposition" not in denied.headers
    _assert_archive_slot_free()


def test_archive_rechecks_permission_after_assembly_before_audit_or_delivery(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    archive_path = tmp_path / "permission-revoked.zip"
    _capture_archive_path(monkeypatch, archive_path)
    real_assemble = routes_export._assemble_archive
    audit_calls: list[dict[str, Any]] = []

    async def configure(state: AppState) -> None:
        real_record = state.control_audit.record_strict

        async def capture_audit(*args: Any, **kwargs: Any) -> Any:
            audit_calls.append(dict(kwargs))
            return await real_record(*args, **kwargs)

        state.control_audit.record_strict = capture_audit  # type: ignore[method-assign]

    async def assemble_then_revoke(
        path: str,
        scopes: list[str],
        state: AppState,
        actor: str,
        disconnected: Callable[[], Any] | None = None,
    ) -> tuple[dict[str, Any], str]:
        result = await real_assemble(path, scopes, state, actor, disconnected)
        prefs = state.prefs.model_copy(deep=True)
        prefs.rbac.denies.setdefault("soc_manager", {})["data_export"] = ["export"]
        await state.update_prefs(prefs)
        return result

    monkeypatch.setattr(routes_export, "_assemble_archive", assemble_then_revoke)
    api, _holder = _export_app(
        auth_enabled=True,
        rbac_enabled=True,
        configure=configure,
    )

    with TestClient(api) as client:
        admin = client.post(
            "/api/auth/login",
            json={"username": "Admin", "password": "Admin@123"},
        )
        assert admin.status_code == 200, admin.text
        created = client.post(
            "/api/users",
            json={
                "username": "archive-manager",
                "password": "archive-manager-pass",
                "role": "soc_manager",
            },
        )
        assert created.status_code == 200, created.text
        client.cookies.clear()
        manager = client.post(
            "/api/auth/login",
            json={
                "username": "archive-manager",
                "password": "archive-manager-pass",
            },
        )
        assert manager.status_code == 200, manager.text
        response = client.post(
            "/api/admin/export/archive",
            json={"scopes": ["configuration"]},
        )

    assert response.status_code == 403
    assert response.json()["detail"] == "permission denied: data_export:export"
    assert "content-disposition" not in response.headers
    assert not any(
        str(call.get("result_summary") or "").startswith("prepared archive")
        for call in audit_calls
    )
    assert not archive_path.exists()
    _assert_archive_slot_free()


def test_archive_audit_records_actor_and_counts_only_after_integrity_verification(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    archive_path = tmp_path / "audit-timing.zip"
    _capture_archive_path(monkeypatch, archive_path)
    real_verify = routes_export._verify_archive
    order: list[str] = []
    audit_calls: list[dict[str, Any]] = []

    def verify_then_mark(*args: Any, **kwargs: Any) -> None:
        real_verify(*args, **kwargs)
        order.append("verified")

    async def configure(state: AppState) -> None:
        real_record = state.control_audit.record_strict

        async def capture_audit(*args: Any, **kwargs: Any) -> Any:
            order.append("audited")
            audit_calls.append(dict(kwargs))
            return await real_record(*args, **kwargs)

        state.control_audit.record_strict = capture_audit  # type: ignore[method-assign]

    monkeypatch.setattr(routes_export, "_verify_archive", verify_then_mark)
    api, _holder = _export_app(
        auth_enabled=True,
        rbac_enabled=True,
        configure=configure,
    )

    with TestClient(api) as client:
        login = client.post(
            "/api/auth/login",
            json={"username": "Admin", "password": "Admin@123"},
        )
        assert login.status_code == 200, login.text
        response = client.post(
            "/api/admin/export/archive",
            json={"scopes": ["configuration"]},
        )

    assert response.status_code == 200, response.text
    _names, members = _read_zip(response.content)
    manifest = json.loads(members["manifest.json"])
    exported = manifest["scopes"]["configuration"]["exported"]
    assert order == ["verified", "audited"]
    assert len(audit_calls) == 1
    assert audit_calls[0]["actor"] == "Admin"
    assert audit_calls[0]["action_type"] == ActionType.DATA_EXPORT
    assert audit_calls[0]["surface"] == "settings"
    assert audit_calls[0]["result_summary"].startswith(
        f"prepared archive scopes=configuration records=configuration={exported} "
    )
    assert " complete=true bytes=" in audit_calls[0]["result_summary"]
    assert not archive_path.exists()
    _assert_archive_slot_free()


def test_archive_rechecks_fresh_auth_after_long_assembly(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    archive_path = tmp_path / "stale-after-assembly.zip"
    _capture_archive_path(monkeypatch, archive_path)
    real_assemble = routes_export._assemble_archive

    async def assemble_then_expire(
        path: str,
        scopes: list[str],
        state: AppState,
        actor: str,
        disconnected: Callable[[], Any] | None = None,
    ) -> tuple[dict[str, Any], str]:
        result = await real_assemble(path, scopes, state, actor, disconnected)

        def backdate(entries: list[dict[str, Any]]) -> bool:
            changed = False
            for row in entries:
                if row.get("username") == actor and not str(row.get("sid", "")).startswith(
                    "__tv__:"
                ):
                    row["last_authn_at"] = "2000-01-01T00:00:00+00:00"
                    changed = True
            return changed

        await state.sessions._mutate(backdate)  # type: ignore[attr-defined]
        return result

    monkeypatch.setattr(routes_export, "_assemble_archive", assemble_then_expire)
    api, _holder = _export_app(
        auth_enabled=True,
        rbac_enabled=True,
        sudo_reauth_window=1,
    )

    with TestClient(api) as client:
        login = client.post(
            "/api/auth/login",
            json={"username": "Admin", "password": "Admin@123"},
        )
        assert login.status_code == 200, login.text
        response = client.post(
            "/api/admin/export/archive",
            json={"scopes": ["configuration"]},
        )

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "reauth_required"
    assert response.json()["detail"]["reason"] == "stale_authn"
    assert "content-disposition" not in response.headers
    assert not archive_path.exists()
    _assert_archive_slot_free()
