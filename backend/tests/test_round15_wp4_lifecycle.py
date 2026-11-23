"""Round 15 WP4 (SPEC D5.9): case screenshots through the data lifecycle.

The cases (and sources) reset removes every document of the ``case_files`` namespace
on both state backends and names it in its receipt; a factory reset leaves it to the
wholesale KV purge; a cases export lists each screenshot's metadata and never its
bytes, and says so.
"""

from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest

from app.api import routes_export
from app.config import Secrets
from app.constants import CASE_FILES_NS, EntityType, ResetScope, SourceSurface, Verdict
from app.engine.reset import reset_service
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.models import Case, Entity
from app.state import AppState
from tests.test_round15_wp4_case_files_store import NOW, fid, png_image


async def _seed(state: AppState, case_id: str = "case-1") -> None:
    await state.cases.save(Case(
        case_id=case_id, cluster_signature=f"sig-{case_id}", source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="198.51.100.4"), verdict=Verdict.NEEDS_HUMAN,
    ))
    store = state.real_case_files
    await store.add(case_id, png_image(1), png_image(2, width=2, height=2), file_id=fid(1),
                    caption="Login page", filename="login.png", uploaded_by="alice", uploaded_at=NOW)
    await store.add(case_id, png_image(3), None, file_id=fid(2), uploaded_at=NOW)
    await store.delete(case_id, fid(2), deleted_by="bob", deleted_at=NOW)


async def _sql_state(tmp_path: Path) -> AppState:
    secrets = Secrets(_env_file=None, es_store_enabled=False, redis_url="", anthropic_api_key=None,
                      openai_api_key=None, state_backend="sqlite",
                      state_db_url=f"sqlite+aiosqlite:///{tmp_path}/s.db")
    state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides={"mock": MockProvider()})
    await state.startup(start_poller=False)
    return state


def _removed(receipt: dict) -> int:
    entries = [c for c in receipt["cleared"] if c.startswith("kv:case_files:")]
    assert len(entries) == 1, receipt
    return int(entries[0].rsplit(":", 1)[1])


@pytest.mark.asyncio
@pytest.mark.parametrize("scope", [ResetScope.CASES, ResetScope.SOURCES])
async def test_cases_and_sources_resets_clear_the_namespace_on_elasticsearch(app_state, scope) -> None:
    await _seed(app_state)
    await app_state.kv.put("memory_keep", "row", {"value": 1})
    receipt = await reset_service(app_state, scope)
    # index + one blob + one thumbnail + the usage document (the deleted file has no bytes)
    assert _removed(receipt) == 4
    assert "kv:case_files" not in receipt["failed"]
    assert (await app_state.real_case_files.index("case-1")).entries == ()
    assert (await app_state.real_case_files.usage()).count == 0
    assert await app_state.kv.get("memory_keep", "row") == {"value": 1}
    hits = [d for d in app_state.es.docs.get(app_state.es._resolve("tlsoc-agent-config"), {})
            if d.startswith(f"{CASE_FILES_NS}:")]
    assert hits == []


@pytest.mark.asyncio
async def test_cases_reset_clears_the_namespace_on_sql(tmp_path: Path) -> None:
    state = await _sql_state(tmp_path)
    try:
        await _seed(state)
        await state.kv.put("memory_keep", "row", {"value": 1})
        receipt = await reset_service(state, ResetScope.CASES)
        assert _removed(receipt) == 4
        assert (await state.real_case_files.index("case-1")).entries == ()
        assert await state.kv.get(CASE_FILES_NS, "usage") is None
        assert await state.kv.get("memory_keep", "row") == {"value": 1}
    finally:
        await state.shutdown()


@pytest.mark.asyncio
async def test_a_factory_reset_leaves_the_namespace_to_the_wholesale_purge(app_state) -> None:
    receipt = await reset_service(app_state, ResetScope.FACTORY, factory_owner="factory-job")
    assert "kv:case_files" not in receipt["attempted"]


@pytest.mark.asyncio
async def test_a_cases_export_carries_metadata_and_never_the_bytes(app_state) -> None:
    await _seed(app_state)
    await app_state.cases.save(Case(
        case_id="case-2", cluster_signature="sig-case-2", source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="198.51.100.5"),
    ))
    rows, meta = await routes_export._collect_scope("cases", app_state, 100)
    by_id = {r["case_id"]: r for r in rows}
    files = by_id["case-1"]["case_files"]
    assert [f["id"] for f in files] == [fid(1), fid(2)]
    assert files[0]["caption"] == "Login page" and files[0]["sha256"] == png_image(1).sha256
    assert files[0]["thumbnail_bytes"] == png_image(2, width=2, height=2).size
    assert files[1]["deleted_at"] == NOW and files[1]["deleted_by"] == "bob"
    assert "case_files" not in by_id["case-2"]
    assert meta["case_files"] == 2 and meta["case_files_consistency"]["exact"] is False
    assert "case_runbook_runs" not in meta

    text = json.dumps(rows, default=str)
    assert base64.b64encode(png_image(1).data).decode() not in text
    assert "case_file_data" not in text

    records, *_ = await routes_export._collect_segment_page("cases", app_state, 100)
    seg = {r["record"].case_id: r for r in records}
    assert [f["id"] for f in seg["case-1"]["case_files"]] == [fid(1), fid(2)]
    assert "case_files" not in seg["case-2"]


def test_the_manifest_states_that_screenshot_bytes_are_excluded() -> None:
    assert "case screenshot image contents (metadata and SHA-256 are included)" in routes_export._EXCLUDED
