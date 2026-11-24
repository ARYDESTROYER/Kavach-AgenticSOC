"""Round 15 WP4 (SPEC D5.1 to D5.3, D5.9): the case screenshot KV store, on both KV
backends (the Elasticsearch adapter over the in-memory client, and SQL on SQLite).

Pins the storage shape (the six-field budget, the store tag, ``case:<id>`` labels,
write-once ``_rev: 1`` content), the case and organisation bounds, the duplicate rule,
deletion (bytes gone, metadata kept), the strict reads and the plain-text rules.
"""

from __future__ import annotations

import base64
import struct
import zlib

import pytest
import pytest_asyncio

from app.constants import CASE_FILES_NS, CONFIG_INDEX
from app.engine.case_images import validate_image
from app.es.fake import InMemoryESClient
from app.stores import case_files as cf
from app.stores.case_files import (
    CaseFileLimits,
    CaseFileNotFound,
    CaseFilesConflict,
    CaseFilesFull,
    CaseFileStore,
    CaseFilesUnavailable,
    clean_caption,
    clean_filename,
)
from app.stores.memory import EsKVStore
from app.stores.sql import SqlKVStore, build_async_engine, create_all

NOW = "2026-11-20T10:00:00+00:00"


def png_image(seed: int, *, width: int = 4, height: int = 3, pad: int = 0):
    """A distinct valid PNG per ``seed`` (``pad`` extra zero bytes of image data)."""
    def chunk(ctype: bytes, body: bytes) -> bytes:
        return struct.pack(">I", len(body)) + ctype + body + struct.pack(">I", zlib.crc32(ctype + body) & 0xFFFFFFFF)

    rows = b"".join(b"\x00" + bytes((seed + x) % 256 for x in range(width * 3)) for _ in range(height))
    data = zlib.compress(rows, 0) + bytes(pad)
    raw = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", data) + chunk(b"IEND", b""))
    return validate_image(raw)


@pytest_asyncio.fixture(params=["es", "sql"])
async def kv(request):
    if request.param == "es":
        yield EsKVStore(InMemoryESClient())
        return
    engine = build_async_engine("sqlite+aiosqlite:///:memory:")
    await create_all(engine)
    try:
        yield SqlKVStore(engine)
    finally:
        await engine.dispose()


def fid(n: int) -> str:
    return f"{n:032x}"


async def _raw(kv, key: str):
    getter = getattr(kv, "get_strict", None) or kv.get
    return await getter(CASE_FILES_NS, key)


async def test_round_trip_and_the_storage_shape(kv) -> None:
    store = CaseFileStore(kv)
    image, thumb = png_image(1), png_image(2, width=2, height=2)
    record = await store.add("case-1", image, thumb, file_id=fid(1), filename="C:\\Users\\me\\shot.png",
                             caption="  Login\npage  ", uploaded_by="alice", uploaded_at=NOW)
    assert (record.filename, record.caption) == ("shot.png", "Login page")
    assert record.thumb is not None and record.stored_bytes == image.size + thumb.size

    got, data, kind = await store.read_content("case-1", fid(1))
    assert got.id == fid(1) and data == image.data and kind == "png"
    _, small, _ = await store.read_content("case-1", fid(1), "thumb")
    assert small == thumb.data

    for key in ("case:case-1", f"blob:{fid(1)}", f"thumb:{fid(1)}", "usage"):
        doc = await _raw(kv, key)
        assert doc[cf.STORE_FIELD] == CASE_FILES_NS
        assert len(doc) <= 6, key
        assert all(name.startswith("case_file_") or name == "_rev" for name in doc), key
    blob = await _raw(kv, f"blob:{fid(1)}")
    assert blob["_rev"] == 1 and blob[cf.CASE_FIELD] == "case:case-1"
    assert base64.b64decode(blob[cf.DATA_FIELD]) == image.data
    index = await _raw(kv, "case:case-1")
    assert index[cf.CASE_FIELD] == "case:case-1"
    assert "Login page" in index[cf.INDEX_FIELD]  # opaque JSON, never a top-level field


async def test_content_documents_are_write_once(kv) -> None:
    store = CaseFileStore(kv)
    await store.add("case-1", png_image(1), None, file_id=fid(1), uploaded_at=NOW)
    put_if = getattr(kv, "put_if_strict", None) or kv.put_if
    assert await put_if(CASE_FILES_NS, f"blob:{fid(1)}", {"case_file_data": "x"}, 0) is False
    with pytest.raises(CaseFilesConflict):
        await store._create_once(f"blob:{fid(1)}", {"_rev": 1})
    # The same id twice is refused and leaves the first upload intact.
    with pytest.raises(CaseFilesConflict):
        await store.add("case-1", png_image(2), None, file_id=fid(1), uploaded_at=NOW)
    _, data, _ = await store.read_content("case-1", fid(1))
    assert data == png_image(1).data


async def test_case_count_bound_and_room_after_a_delete(kv) -> None:
    store = CaseFileStore(kv, limits=CaseFileLimits(max_files_per_case=2))
    await store.add("case-1", png_image(1), None, file_id=fid(1), uploaded_at=NOW)
    await store.add("case-1", png_image(2), None, file_id=fid(2), uploaded_at=NOW)
    with pytest.raises(CaseFilesFull) as full:
        await store.add("case-1", png_image(3), None, file_id=fid(3), uploaded_at=NOW)
    assert full.value.code == "case_files_case_full" and full.value.status == 409
    assert await _raw(kv, f"blob:{fid(3)}") is None  # compensation removed the content
    # Another case is not affected.
    await store.add("case-2", png_image(3), None, file_id=fid(4), uploaded_at=NOW)
    await store.delete("case-1", fid(1), deleted_by="alice", deleted_at=NOW)
    await store.add("case-1", png_image(5), None, file_id=fid(5), uploaded_at=NOW)
    assert len((await store.index("case-1")).live) == 2


async def test_case_bytes_bound(kv) -> None:
    one = png_image(1, pad=400)
    store = CaseFileStore(kv, limits=CaseFileLimits(max_case_bytes=one.size * 2 + 10))
    await store.add("case-1", one, None, file_id=fid(1), uploaded_at=NOW)
    await store.add("case-1", png_image(2, pad=400), None, file_id=fid(2), uploaded_at=NOW)
    with pytest.raises(CaseFilesFull) as full:
        await store.add("case-1", png_image(3, pad=400), None, file_id=fid(3), uploaded_at=NOW)
    assert full.value.code == "case_files_case_full"


async def test_organisation_bound_spans_cases_and_releases_on_delete(kv) -> None:
    one = png_image(1, pad=300)
    store = CaseFileStore(kv, limits=CaseFileLimits(max_total_bytes=one.size * 2 + 50))
    await store.add("case-1", one, None, file_id=fid(1), uploaded_at=NOW)
    await store.add("case-2", png_image(2, pad=300), None, file_id=fid(2), uploaded_at=NOW)
    usage = await store.usage()
    assert usage.count == 2 and usage.bytes == one.size * 2
    with pytest.raises(CaseFilesFull) as full:
        await store.add("case-3", png_image(3, pad=300), None, file_id=fid(3), uploaded_at=NOW)
    assert full.value.code == "case_files_storage_full"
    assert (await store.usage()).count == 2  # nothing reserved for the refusal
    await store.delete("case-2", fid(2), deleted_by="bob", deleted_at=NOW)
    assert (await store.usage()).count == 1
    await store.add("case-3", png_image(3, pad=300), None, file_id=fid(3), uploaded_at=NOW)


async def test_a_duplicate_that_lands_meanwhile_is_refused_and_undone(kv) -> None:
    store = CaseFileStore(kv)
    image = png_image(7)
    await store.add("case-1", image, None, file_id=fid(1), uploaded_at=NOW)
    with pytest.raises(CaseFilesConflict) as conflict:
        await store.add("case-1", image, png_image(8, width=2, height=2), file_id=fid(2), uploaded_at=NOW)
    assert conflict.value.code == "case_files_duplicate"
    assert await _raw(kv, f"blob:{fid(2)}") is None and await _raw(kv, f"thumb:{fid(2)}") is None
    assert (await store.usage()).count == 1
    # The same image on another case is not a duplicate.
    await store.add("case-2", image, None, file_id=fid(3), uploaded_at=NOW)


async def test_delete_removes_the_bytes_and_keeps_the_metadata(kv) -> None:
    store = CaseFileStore(kv)
    await store.add("case-1", png_image(1), png_image(2, width=2, height=2), file_id=fid(1),
                    caption="evidence", uploaded_by="alice", uploaded_at=NOW)
    deleted = await store.delete("case-1", fid(1), deleted_by="bob", deleted_at="2026-11-20T11:00:00+00:00")
    assert deleted.deleted_at and deleted.deleted_by == "bob" and deleted.caption == "evidence"
    assert await _raw(kv, f"blob:{fid(1)}") is None
    assert await _raw(kv, f"thumb:{fid(1)}") is None
    index = await store.index("case-1")
    assert index.live == () and [e.id for e in index.deleted] == [fid(1)]
    with pytest.raises(CaseFileNotFound):
        await store.read_content("case-1", fid(1))
    with pytest.raises(CaseFileNotFound):
        await store.delete("case-1", fid(1), deleted_by="bob", deleted_at=NOW)
    usage = await store.usage()
    assert (usage.bytes, usage.count) == (0, 0)


async def test_tombstones_are_bounded(kv, monkeypatch) -> None:
    monkeypatch.setattr(cf, "MAX_TOMBSTONES", 2)
    store = CaseFileStore(kv)
    for n in range(1, 5):
        await store.add("case-1", png_image(n), None, file_id=fid(n), uploaded_at=NOW)
        await store.delete("case-1", fid(n), deleted_by="a", deleted_at=f"2026-11-20T10:0{n}:00+00:00")
    assert [e.id for e in (await store.index("case-1")).deleted] == [fid(3), fid(4)]


async def test_content_is_served_only_when_listed_for_that_case(kv) -> None:
    store = CaseFileStore(kv)
    image = png_image(1)
    # An orphan content document (no index entry) is never served.
    await store._create_once(f"blob:{fid(9)}", cf.encode_content("case-1", fid(9), image, "full"))
    with pytest.raises(CaseFileNotFound):
        await store.read_content("case-1", fid(9))
    await store.add("case-1", image, None, file_id=fid(1), uploaded_at=NOW)
    # Asking through another case finds nothing.
    with pytest.raises(CaseFileNotFound):
        await store.read_content("case-2", fid(1))
    with pytest.raises(CaseFileNotFound):
        await store.read_content("case-1", "not-an-id")


async def test_content_with_another_hash_is_refused() -> None:
    es = InMemoryESClient()
    store = CaseFileStore(EsKVStore(es))
    await store.add("case-1", png_image(1), None, file_id=fid(1), uploaded_at=NOW)
    doc = es.docs[CONFIG_INDEX][f"{CASE_FILES_NS}:blob:{fid(1)}"]
    doc[cf.DATA_FIELD] = base64.b64encode(png_image(2).data).decode()
    with pytest.raises(CaseFileNotFound):
        await store.read_content("case-1", fid(1))


class _DownES(InMemoryESClient):
    down = False

    async def get_doc_strict(self, index, doc_id):
        if self.down:
            raise RuntimeError("cluster unavailable")
        return await super().get_doc_strict(index, doc_id)


async def test_an_outage_is_unavailable_never_empty() -> None:
    es = _DownES()
    store = CaseFileStore(EsKVStore(es))
    await store.add("case-1", png_image(1), None, file_id=fid(1), uploaded_at=NOW)
    es.down = True
    with pytest.raises(CaseFilesUnavailable):
        await store.index("case-1")
    with pytest.raises(CaseFilesUnavailable):
        await store.usage()
    with pytest.raises(CaseFilesUnavailable):
        await store.add("case-1", png_image(2), None, file_id=fid(2), uploaded_at=NOW)


async def test_a_damaged_index_is_unavailable(kv) -> None:
    put = getattr(kv, "put_strict", None) or kv.put
    await put(CASE_FILES_NS, "case:case-1", {cf.STORE_FIELD: CASE_FILES_NS, cf.INDEX_FIELD: "{not json"})
    store = CaseFileStore(kv)
    with pytest.raises(CaseFilesUnavailable):
        await store.index("case-1")
    with pytest.raises(CaseFilesUnavailable):
        await store.add("case-1", png_image(1), None, file_id=fid(1), uploaded_at=NOW)


async def test_long_case_ids_are_keyed_on_their_hash(kv) -> None:
    case_id = "c" * 190
    store = CaseFileStore(kv)
    await store.add(case_id, png_image(1), None, file_id=fid(1), uploaded_at=NOW)
    key = cf.case_key(case_id)
    assert len(key) <= cf.KV_KEY_MAX_CHARS and key.startswith("case:~")
    assert (await _raw(kv, key))[cf.CASE_FIELD] == f"case:{case_id}"
    assert [e.id for e in (await store.index(case_id)).live] == [fid(1)]
    with pytest.raises(CaseFileNotFound):
        await store.index("bad\nid")


async def test_get_many_lists_only_cases_with_screenshots(kv) -> None:
    store = CaseFileStore(kv)
    await store.add("case-1", png_image(1), None, file_id=fid(1), uploaded_at=NOW)
    found = await store.get_many(["case-1", "case-2", "case-1"])
    assert list(found) == ["case-1"]


def test_memory_limits_are_the_demo_caps() -> None:
    assert (cf.MEMORY_LIMITS.max_files_per_case, cf.MEMORY_LIMITS.max_total_bytes) == (5, 64 * 1024 * 1024)
    assert (cf.STANDARD_LIMITS.max_files_per_case, cf.STANDARD_LIMITS.max_case_bytes,
            cf.STANDARD_LIMITS.max_total_bytes) == (20, 20 * 1024 * 1024, 2 * 1024 ** 3)
    assert cf.STANDARD_LIMITS.max_file_bytes == 2 * 1024 * 1024
    assert cf.STANDARD_LIMITS.max_thumbnail_bytes == 48 * 1024


def test_plain_text_rules() -> None:
    assert clean_caption("a\u200bb\u202e c\n\td") == "ab c d"
    assert len(clean_caption("x" * 500)) == cf.CAPTION_MAX_CHARS
    assert clean_caption(None) == ""
    assert clean_filename("../../etc/passwd") == "passwd"
    assert clean_filename("C:\\a\\b\\report\u2066.png") == "report.png"
    assert clean_filename("..") == ""
    long_name = "n" * 300 + ".png"
    assert clean_filename(long_name).endswith(".png") and len(clean_filename(long_name)) == cf.FILENAME_MAX_CHARS
