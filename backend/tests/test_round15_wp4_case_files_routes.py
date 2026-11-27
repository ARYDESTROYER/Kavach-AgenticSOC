"""Round 15 WP4 (SPEC D5.3, D5.5, D5.6, D5.10, §3.2): the case screenshot API.

Uploads, listing, content with its strict headers, deletion, the body bound, the rate
bound, the case caps, the audit-first rows (with ids and codes only in
``result_summary``), permissions with role-based access on, the Demo Mode sinks and
caps, and the rule that a screenshot never changes its case (#3).
"""

from __future__ import annotations

import base64
import json
import re
import struct
import zlib
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.api import routes_case_files as rcf
from app.api.deps import require_auth
from app.config import Secrets
from app.constants import CaseStatus, EntityType, SourceSurface, Verdict
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.models import Case, Entity
from app.state import AppState
from app.stores import case_files as cf
from tests import case_image_fixtures as fx
from tests._auth_helpers import ready_user

CAPTION = "SENTINEL-CAPTION-7f3a"
FILENAME = "SENTINEL-FILENAME-91c2.png"


def png(seed: int = 0, *, width: int = 4, height: int = 3, pad: int = 0) -> bytes:
    def chunk(ctype: bytes, body: bytes) -> bytes:
        return struct.pack(">I", len(body)) + ctype + body + struct.pack(">I", zlib.crc32(ctype + body) & 0xFFFFFFFF)

    rows = b"".join(b"\x00" + bytes((seed + x) % 256 for x in range(width * 3)) for _ in range(height))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows, 0) + bytes(pad)) + chunk(b"IEND", b""))


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def upload_body(data: bytes, **extra: Any) -> dict[str, Any]:
    return {"data_base64": b64(data), "content_type": "image/png", **extra}


def _app(*, auth: bool = False, rbac: bool = False) -> FastAPI:
    from app.api.routes import router as monolith_router
    from app.api.routes_case_files import router as files_router
    from tests.conftest import mount_moved_routers

    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="", anthropic_api_key=None, openai_api_key=None,
        **({"auth_enabled": True, "auth_jwt_secret": "case-files-tests", "auth_seed_admin": True} if auth else {}),
    )
    mock = MockProvider()
    overrides = {"anthropic": mock, "openai": mock, "mock": mock}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
        await state.startup(start_poller=False)
        prefs = state.prefs.model_copy(deep=True)
        prefs.setup_complete = True
        prefs.rbac.enabled = rbac
        await state.update_prefs(prefs)
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    deps = [Depends(require_auth)] if auth else None
    api.include_router(monolith_router, **({"dependencies": deps} if deps else {}))
    api.include_router(files_router, **({"dependencies": deps} if deps else {}))
    mount_moved_routers(api, dependencies=deps)
    return api


@pytest.fixture
def client():
    with TestClient(_app()) as c:
        yield c


@pytest.fixture
def rbac_client():
    with TestClient(_app(auth=True, rbac=True)) as c:
        yield c


def _state(client: TestClient) -> AppState:
    return client.app.state.tlsoc


def seed_case(client: TestClient, case_id: str = "case-files-1", **fields: Any) -> Case:
    case = Case(
        case_id=case_id, cluster_signature=f"sig-{case_id}", case_number="SOC-0042",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="203.0.113.7"),
        verdict=Verdict.NEEDS_HUMAN, confidence=0.5, risk_score=42.0, **fields,
    )
    client.portal.call(_state(client).cases.save, case)
    return case


def rows(client: TestClient, *, repo: Any = None) -> list[dict[str, Any]]:
    store = repo if repo is not None else _state(client).audit
    return client.portal.call(lambda: store.records(limit=1000))


def by_action(client: TestClient, action: str, **kw: Any) -> list[dict[str, Any]]:
    return [r for r in rows(client, **kw) if r.get("action") == action]


@pytest.fixture(autouse=True)
def _fresh_rate_bound():
    rcf._RUNTIMES.clear()
    yield
    rcf._RUNTIMES.clear()


# --------------------------------------------------------------------------- #
# Upload, list, content.
# --------------------------------------------------------------------------- #
def test_upload_list_and_serve_with_strict_headers(client) -> None:
    seed_case(client)
    thumb = png(9, width=2, height=2)
    r = client.post("/api/cases/case-files-1/files",
                    json=upload_body(png(1), thumbnail_base64=b64(thumb), filename=FILENAME, caption=CAPTION))
    assert r.status_code == 201, r.text
    entry = r.json()["file"]
    assert r.json()["deduplicated"] is False
    assert entry["content_type"] == "image/png" and entry["has_thumbnail"] is True
    assert (entry["caption"], entry["filename"], entry["position"]) == (CAPTION, FILENAME, 1)
    assert re.fullmatch(r"[0-9a-f]{32}", entry["id"])

    listing = client.get("/api/cases/case-files-1/files").json()
    assert [f["id"] for f in listing["files"]] == [entry["id"]]
    assert listing["count"] == 1 and listing["can_upload"] is True and listing["files"][0]["can_delete"] is True
    assert listing["limits"]["max_files"] == cf.MEMORY_LIMITS.max_files_per_case  # in-memory fallback
    assert listing["limits"]["accepted_types"] == ["image/jpeg", "image/png", "image/webp"]

    content = client.get(f"/api/cases/case-files-1/files/{entry['id']}/content")
    assert content.status_code == 200
    assert content.content == png(1)
    h = content.headers
    assert h["content-type"] == "image/png"
    assert h["x-content-type-options"] == "nosniff"
    assert h["content-disposition"] == 'inline; filename="SOC-0042-1.png"'
    assert h["content-security-policy"] == "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox"
    assert h["cache-control"] == "private, no-store"
    assert h["cross-origin-resource-policy"] == "same-origin"
    assert h["content-length"] == str(len(png(1)))

    small = client.get(f"/api/cases/case-files-1/files/{entry['id']}/content", params={"variant": "thumb"})
    assert small.content == thumb
    download = client.get(f"/api/cases/case-files-1/files/{entry['id']}/content", params={"download": 1})
    assert download.headers["content-disposition"] == 'attachment; filename="SOC-0042-1.png"'


def test_a_file_without_a_thumbnail_serves_the_full_image_as_thumb(client) -> None:
    seed_case(client)
    entry = client.post("/api/cases/case-files-1/files", json=upload_body(png(1))).json()["file"]
    r = client.get(f"/api/cases/case-files-1/files/{entry['id']}/content", params={"variant": "thumb"})
    assert r.status_code == 200 and r.content == png(1)


def test_metadata_is_stripped_before_storage(client) -> None:
    seed_case(client)
    r = client.post("/api/cases/case-files-1/files",
                    json={"data_base64": b64(fx.JPEG_EXIF), "content_type": "image/jpeg"})
    assert r.status_code == 201, r.text
    body = client.get(f"/api/cases/case-files-1/files/{r.json()['file']['id']}/content")
    assert body.headers["content-type"] == "image/jpeg"
    assert b"SECRET" not in body.content and len(body.content) < len(fx.JPEG_EXIF)


def test_a_data_url_is_accepted(client) -> None:
    seed_case(client)
    r = client.post("/api/cases/case-files-1/files",
                    json={"data_base64": "data:image/png;base64," + b64(png(1))})
    assert r.status_code == 201, r.text


def test_the_same_image_again_returns_the_existing_entry_and_writes_nothing(client) -> None:
    seed_case(client)
    first = client.post("/api/cases/case-files-1/files", json=upload_body(png(1))).json()["file"]
    again = client.post("/api/cases/case-files-1/files", json=upload_body(png(1), caption="other"))
    assert again.status_code == 200 and again.json()["deduplicated"] is True
    assert again.json()["file"]["id"] == first["id"]
    assert len(by_action(client, "case.file_attached")) == 1


def test_uploads_are_allowed_on_a_closed_case_and_never_change_it(client) -> None:
    case = seed_case(client, status=CaseStatus.CLOSED, disposition="false_positive")
    before = client.portal.call(_state(client).cases.get, case.case_id).model_dump(mode="json")
    entry = client.post("/api/cases/case-files-1/files", json=upload_body(png(1))).json()["file"]
    client.delete(f"/api/cases/case-files-1/files/{entry['id']}")
    after = client.portal.call(_state(client).cases.get, case.case_id).model_dump(mode="json")
    assert after == before


# --------------------------------------------------------------------------- #
# Refusals.
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("body, status, code", [
    ({"data_base64": b64(fx.GIF)}, 415, "case_files_unsupported_type"),
    ({"data_base64": b64(b"<svg onload='x'/>")}, 415, "case_files_unsupported_type"),
    ({"data_base64": b64(png(1)), "content_type": "image/jpeg"}, 415, "case_files_unsupported_type"),
    ({"data_base64": "not base64!!"}, 422, "case_files_invalid_base64"),
    ({"data_base64": b64(png(1) + b"trailer")}, 422, "case_files_invalid_image"),
    ({"data_base64": b64(fx.WEBP_ANIMATED)}, 422, "case_files_invalid_image"),
    ({"data_base64": b64(png(1)), "thumbnail_base64": b64(fx.GIF)}, 415, "case_files_unsupported_type"),
])
def test_invalid_uploads_are_refused_without_an_audit_row(client, body, status, code) -> None:
    seed_case(client)
    r = client.post("/api/cases/case-files-1/files", json=body)
    assert r.status_code == status, r.text
    assert r.json()["detail"]["code"] == code
    assert by_action(client, "case.file_attached") == []
    assert by_action(client, "case.file_attach_failed") == []


def test_too_long_captions_and_unknown_fields_are_refused(client) -> None:
    seed_case(client)
    assert client.post("/api/cases/case-files-1/files",
                       json=upload_body(png(1), caption="x" * 201)).status_code == 422
    assert client.post("/api/cases/case-files-1/files",
                       json=upload_body(png(1), extra="x")).status_code == 422


def test_an_image_over_two_mebibytes_is_too_large(client) -> None:
    seed_case(client)
    big = png(1, pad=cf.MAX_IMAGE_BYTES)
    r = client.post("/api/cases/case-files-1/files", json=upload_body(big))
    assert r.status_code == 413 and r.json()["detail"]["code"] == "case_files_too_large"


def test_a_thumbnail_over_48_kibibytes_is_too_large(client) -> None:
    seed_case(client)
    r = client.post("/api/cases/case-files-1/files",
                    json=upload_body(png(1), thumbnail_base64=b64(png(2, pad=49 * 1024))))
    assert r.status_code == 413 and r.json()["detail"]["code"] == "case_files_too_large"
    assert "Thumbnail" in r.json()["detail"]["message"]


def test_a_thumbnail_wider_than_its_side_bound_is_refused(client) -> None:
    """Review fix: a thumbnail is held to 640 px a side (a gallery shows twenty at once,
    and a few kilobytes of PNG can describe 40 megapixels). Nothing is written."""
    from app.engine.case_images import MAX_THUMBNAIL_SIDE_PX

    seed_case(client)
    wide = png(2, width=MAX_THUMBNAIL_SIDE_PX + 1, height=1)
    r = client.post("/api/cases/case-files-1/files", json=upload_body(png(1), thumbnail_base64=b64(wide)))
    assert r.status_code == 422 and r.json()["detail"]["code"] == "case_files_dimensions"
    assert r.json()["detail"]["message"].startswith("Thumbnail:")
    assert client.get("/api/cases/case-files-1/files").json()["count"] == 0
    ok = png(3, width=MAX_THUMBNAIL_SIDE_PX, height=1)
    assert client.post("/api/cases/case-files-1/files",
                       json=upload_body(png(1), thumbnail_base64=b64(ok))).status_code == 201


def test_the_body_is_bounded_before_it_is_parsed(client) -> None:
    seed_case(client)
    oversized = b'{"data_base64": "' + b"A" * rcf.BODY_MAX_BYTES + b'"}'
    r = client.post("/api/cases/case-files-1/files", content=oversized,
                    headers={"content-type": "application/json"})
    assert r.status_code == 413 and r.json()["detail"]["code"] == "case_files_body_too_large"


def test_unknown_case_and_file_answer_404(client) -> None:
    seed_case(client)
    assert client.get("/api/cases/nope/files").status_code == 404
    assert client.post("/api/cases/nope/files", json=upload_body(png(1))).status_code == 404
    for path in ("/api/cases/case-files-1/files/" + "0" * 32, "/api/cases/case-files-1/files/not-an-id"):
        assert client.delete(path).status_code == 404
        assert client.get(path + "/content").status_code == 404


def test_the_in_memory_store_caps_a_case_at_five(client) -> None:
    seed_case(client)
    for n in range(5):
        assert client.post("/api/cases/case-files-1/files", json=upload_body(png(n))).status_code == 201
    r = client.post("/api/cases/case-files-1/files", json=upload_body(png(9)))
    assert r.status_code == 409 and r.json()["detail"]["code"] == "case_files_case_full"
    assert len(by_action(client, "case.file_attached")) == 5


def test_the_rate_bound_answers_429_with_retry_after(client, monkeypatch) -> None:
    seed_case(client)
    monkeypatch.setattr(rcf, "UPLOADS_PER_MINUTE", 2)
    for n in range(2):
        assert client.post("/api/cases/case-files-1/files", json=upload_body(png(n))).status_code == 201
    r = client.post("/api/cases/case-files-1/files", json=upload_body(png(5)))
    assert r.status_code == 429 and r.json()["detail"]["code"] == "case_files_busy"
    assert int(r.headers["retry-after"]) >= 1


def test_the_concurrency_bound_holds_two_slots_per_person() -> None:
    runtime = rcf._UploadRuntime()
    assert runtime.admit("alice") is None and runtime.admit("alice") is None
    assert runtime.admit("alice") == 1.0
    assert runtime.admit("bob") is None
    runtime.release("alice")
    assert runtime.admit("alice") is None


# --------------------------------------------------------------------------- #
# Audit (audit-first; ids and codes only in result_summary).
# --------------------------------------------------------------------------- #
def test_attach_and_delete_rows(client) -> None:
    seed_case(client)
    entry = client.post("/api/cases/case-files-1/files",
                        json=upload_body(png(1), filename=FILENAME, caption=CAPTION)).json()["file"]
    assert client.delete(f"/api/cases/case-files-1/files/{entry['id']}").status_code == 200
    attached = by_action(client, "case.file_attached")
    deleted = by_action(client, "case.file_deleted")
    assert len(attached) == 1 and len(deleted) == 1
    for row in (attached[0], deleted[0]):
        assert row["case_id"] == "case-files-1"
        assert row["target"]["type"] == "case" and row["target"]["id"] == "case-files-1"
        assert row["target"]["label"] == "SOC-0042"
        assert row["outcome"] == "success" and row["actor_type"] == "human"
        assert row["action_type"] == "collab" and row["surface"] == "case"
        assert entry["id"] in row["result_summary"]
        assert entry["id"] in json.dumps(row["changes"])
        text = json.dumps(row)
        assert CAPTION not in text and FILENAME not in text


def test_a_store_failure_after_the_row_writes_a_failure_row(client, monkeypatch) -> None:
    seed_case(client)
    store = _state(client).case_files

    async def broken(*_a: Any, **_k: Any):
        raise cf.CaseFilesUnavailable()

    monkeypatch.setattr(store, "add", broken)
    r = client.post("/api/cases/case-files-1/files", json=upload_body(png(1), caption=CAPTION))
    assert r.status_code == 503 and r.json()["detail"]["code"] == "case_files_unavailable"
    failed = by_action(client, "case.file_attach_failed")
    assert len(failed) == 1 and failed[0]["outcome"] == "failure"
    assert CAPTION not in json.dumps(failed[0])


def test_no_audit_means_no_upload(client, monkeypatch) -> None:
    seed_case(client)

    async def down(**_k: Any) -> None:
        raise RuntimeError("audit store unreachable")

    monkeypatch.setattr(_state(client).audit, "record_strict", down)
    r = client.post("/api/cases/case-files-1/files", json=upload_body(png(1)))
    assert r.status_code == 503 and r.json()["detail"]["code"] == "audit_unavailable"
    index = client.portal.call(_state(client).case_files.index, "case-files-1")
    assert index.entries == ()


# --------------------------------------------------------------------------- #
# Permissions with role-based access on.
# --------------------------------------------------------------------------- #
def _login(c: TestClient, username: str, password: str) -> None:
    c.cookies.clear()
    r = c.post("/api/auth/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.text


def _make_users(c: TestClient) -> None:
    _login(c, "Admin", "Admin@123")
    for name, role in (("tier1a", "analyst_tier1"), ("tier1b", "analyst_tier1"),
                       ("tier2", "analyst_tier2"), ("audit1", "auditor")):
        r = c.post("/api/users", json={"username": name, "password": f"{name}-pass-12", "role": role})
        assert r.status_code == 200, r.text
        ready_user(c, name, f"{name}-pass-12")


def test_permissions_follow_the_grants(rbac_client) -> None:
    c = rbac_client
    _make_users(c)
    seed_case(c)

    _login(c, "audit1", "audit1-pass-12")
    assert c.get("/api/cases/case-files-1/files").status_code == 200
    assert c.post("/api/cases/case-files-1/files", json=upload_body(png(1))).status_code == 403

    _login(c, "tier1a", "tier1a-pass-12")
    entry = c.post("/api/cases/case-files-1/files", json=upload_body(png(1))).json()["file"]
    assert entry["uploaded_by"] == "tier1a" and entry["can_delete"] is True

    _login(c, "audit1", "audit1-pass-12")
    listing = c.get("/api/cases/case-files-1/files").json()
    assert listing["can_upload"] is False and listing["files"][0]["can_delete"] is False
    assert c.get(f"/api/cases/case-files-1/files/{entry['id']}/content").status_code == 200

    _login(c, "tier1b", "tier1b-pass-12")
    assert c.get("/api/cases/case-files-1/files").json()["files"][0]["can_delete"] is False
    denied = c.delete(f"/api/cases/case-files-1/files/{entry['id']}")
    assert denied.status_code == 403 and denied.json()["detail"]["code"] == "case_files_delete_forbidden"
    access_rows = [r for r in rows(c, repo=_state(c).control_audit)
                   if r.get("action_type") == "access_denied" and r.get("actor") == "tier1b"]
    assert access_rows and access_rows[-1]["target"]["id"] == "case-files-1"

    _login(c, "tier1a", "tier1a-pass-12")
    second = c.post("/api/cases/case-files-1/files", json=upload_body(png(2))).json()["file"]
    assert c.delete(f"/api/cases/case-files-1/files/{entry['id']}").status_code == 200

    _login(c, "tier2", "tier2-pass-12")
    assert c.get("/api/cases/case-files-1/files").json()["files"][0]["can_delete"] is True
    assert c.delete(f"/api/cases/case-files-1/files/{second['id']}").status_code == 200
    deleted_rows = by_action(c, "case.file_deleted")
    assert sorted(r["actor"] for r in deleted_rows) == ["tier1a", "tier2"]


def test_signed_out_callers_are_refused(rbac_client) -> None:
    c = rbac_client
    _login(c, "Admin", "Admin@123")
    seed_case(c)
    c.cookies.clear()
    assert c.get("/api/cases/case-files-1/files").status_code == 401
    assert c.post("/api/cases/case-files-1/files", json=upload_body(png(1))).status_code == 401


def test_every_route_declares_its_grant() -> None:
    from app.api.routes_case_files import router

    wanted = {
        ("GET", "/api/cases/{case_id}/files"): ("cases", "read"),
        ("POST", "/api/cases/{case_id}/files"): ("cases", "comment"),
        ("DELETE", "/api/cases/{case_id}/files/{file_id}"): ("cases", "comment"),
        ("GET", "/api/cases/{case_id}/files/{file_id}/content"): ("cases", "read"),
    }
    found = {}
    for route in router.routes:
        for method in route.methods:
            calls = [d.call for d in route.dependant.dependencies]
            closures = [c for c in calls if getattr(c, "__qualname__", "") == "require_permission.<locals>._dep"]
            assert closures, (method, route.path)
            cells = closures[0].__closure__ or ()
            found[(method, route.path)] = tuple(cell.cell_contents for cell in cells if isinstance(cell.cell_contents, str))
    assert {k: tuple(sorted(v)) for k, v in found.items()} == {k: tuple(sorted(v)) for k, v in wanted.items()}


# --------------------------------------------------------------------------- #
# Demo Mode.
# --------------------------------------------------------------------------- #
def test_demo_mode_uses_the_demo_store_audit_and_caps(client) -> None:
    state = _state(client)
    seed_case(client, "real-case")
    real_entry = client.post("/api/cases/real-case/files", json=upload_body(png(1))).json()["file"]
    real_store = state.case_files
    client.portal.call(state.enable_demo)
    try:
        assert state.case_files is not real_store
        assert state.case_files.limits == cf.MEMORY_LIMITS
        cases, _ = client.portal.call(lambda: state.cases.list(limit=1, offset=0))
        demo_case = cases[0].case_id
        r = client.post(f"/api/cases/{demo_case}/files", json=upload_body(png(2)))
        assert r.status_code == 201, r.text
        assert by_action(client, "case.file_attached", repo=state.demo_audit)
        real_rows = by_action(client, "case.file_attached", repo=state.control_audit)
        assert len(real_rows) == 1 and real_rows[0]["case_id"] == "real-case"
        assert client.portal.call(real_store.index, demo_case).entries == ()
    finally:
        client.portal.call(state.disable_demo)
    assert state.case_files is real_store
    assert [e.id for e in client.portal.call(real_store.index, "real-case").live] == [real_entry["id"]]


def test_an_sql_state_backend_gets_the_standard_caps(tmp_path: Path) -> None:
    secrets = Secrets(_env_file=None, es_store_enabled=False, redis_url="", anthropic_api_key=None,
                      openai_api_key=None, state_backend="sqlite",
                      state_db_url=f"sqlite+aiosqlite:///{tmp_path}/s.db")
    state = AppState.create(secrets=secrets, es=InMemoryESClient(),
                            provider_overrides={"mock": MockProvider()})
    assert state.real_case_files.limits == cf.STANDARD_LIMITS
    assert state.real_case_files.kv is state.kv


def test_deleting_an_account_keeps_its_screenshots(rbac_client) -> None:
    c = rbac_client
    _login(c, "Admin", "Admin@123")
    assert c.post("/api/users", json={"username": "leaver", "password": "leaver-pass-12",
                                       "role": "analyst_tier1"}).status_code == 200
    ready_user(c, "leaver", "leaver-pass-12")
    seed_case(c)
    _login(c, "leaver", "leaver-pass-12")
    entry = c.post("/api/cases/case-files-1/files", json=upload_body(png(1))).json()["file"]
    _login(c, "Admin", "Admin@123")
    assert c.delete("/api/users/leaver").status_code == 200
    files = c.get("/api/cases/case-files-1/files").json()["files"]
    assert [(f["id"], f["uploaded_by"]) for f in files] == [(entry["id"], "leaver")]
    assert c.get(f"/api/cases/case-files-1/files/{entry['id']}/content").status_code == 200


def test_the_web_proxy_gives_uploads_the_same_bound() -> None:
    """SPEC D5.6: nginx bounds the upload path at 3 MiB (its default is 1 MiB) with the
    same proxy headers and timeouts as the generic /api/ location."""
    conf = (Path(__file__).resolve().parents[2] / "webui" / "nginx.conf").read_text(encoding="utf-8")
    block = re.search(r"location ~ \^/api/cases/\[\^/\]\+/files\$ \{(.*?)\n    \}", conf, re.S)
    assert block, "the upload location is missing"
    body = block.group(1)
    assert "client_max_body_size 3m;" in body and rcf.BODY_MAX_BYTES == 3 * 1024 * 1024
    generic = re.search(r"location /api/ \{(.*?)\n    \}", conf, re.S)
    assert generic
    for line in generic.group(1).splitlines():
        directive = line.strip()
        if directive.startswith(("proxy_", "client_")):
            assert directive in body, directive
    # The pattern matches the list and upload path only, never content or a deletion.
    pattern = re.compile(r"^/api/cases/[^/]+/files$")
    assert pattern.match("/api/cases/case-1/files")
    assert not pattern.match("/api/cases/case-1/files/" + "a" * 32)
    assert not pattern.match("/api/cases/case-1/files/" + "a" * 32 + "/content")
