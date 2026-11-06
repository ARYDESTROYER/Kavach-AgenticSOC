"""``POST /api/runbooks/{id}/reindex`` for a built-in id (Round 14 SPEC §4.10.18).

The runbook corpus holds every Published version, built-ins included, so the route
admits a built-in id and reprojects it for real (no stubbed retrieval here): its live
chunks are written and the success row names it. When a Published operator copy
replaces the built-in, the same call removes the built-in's chunks, because the copy
is what is Published now. An unknown id is refused before any work, with no row.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.engine.runbook_model import builtin_runbook
from app.tools.rag import RUNBOOK_SOURCE, parse_runbook_document_id
from tests.test_runbook_library_api import BASE_BUILTIN, audit_rows, make_app, publish


@pytest.fixture
def box() -> Any:
    holder: dict[str, Any] = {}
    with TestClient(make_app(holder)) as client:
        holder["client"] = client
        state = holder["state"]

        async def retrieval_on() -> None:
            prefs = state.prefs
            await state.update_prefs(prefs.model_copy(update={"rag": prefs.rag.model_copy(update={"enabled": True})}))

        client.portal.call(retrieval_on)
        yield holder


def _projected(box: dict[str, Any], runbook_id: str) -> set[str]:
    state = box["state"]
    documents = box["client"].portal.call(state.rag.store.list_documents)
    return {
        str(d["document_id"]) for d in documents
        if d.get("source") == RUNBOOK_SOURCE and (parse_runbook_document_id(d.get("document_id")) or ("",))[0]
        == runbook_id
    }


def test_a_built_in_id_is_reprojected(box) -> None:
    client, state = box["client"], box["state"]
    phases = len(builtin_runbook(BASE_BUILTIN).definition.phases)
    response = client.post(f"/api/runbooks/{BASE_BUILTIN}/reindex")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is True and body["failed"] == 0 and body["errors"] == []
    assert body["runbooks"] == 1 and body["indexed"] == phases          # one chunk per phase
    version = builtin_runbook(BASE_BUILTIN).version
    assert [parse_runbook_document_id(d) for d in _projected(box, BASE_BUILTIN)] == [(BASE_BUILTIN, version)]
    rows = [r for r in audit_rows(state, action="runbook.reindexed") if r["target"]["id"] == BASE_BUILTIN]
    assert len(rows) == 1 and rows[0]["outcome"] == "success"


def test_a_replaced_built_in_is_removed_from_the_corpus(box) -> None:
    client = box["client"]
    assert client.post(f"/api/runbooks/{BASE_BUILTIN}/reindex").json()["indexed"] > 0
    copy_id = client.post(f"/api/runbooks/{BASE_BUILTIN}/duplicate").json()["summary"]["id"]
    publish(client, copy_id)
    response = client.post(f"/api/runbooks/{BASE_BUILTIN}/reindex")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is True and body["indexed"] == 0 and body["failed"] == 0
    assert _projected(box, BASE_BUILTIN) == set()


def test_an_unknown_id_is_refused_before_any_work(box, monkeypatch) -> None:
    client, state = box["client"], box["state"]
    calls: list[Any] = []

    async def reindex(ids: set[str] | None = None) -> dict[str, Any]:
        calls.append(ids)
        return {"ok": True, "indexed": 0, "deleted": 0, "failed": 0, "errors": []}

    monkeypatch.setattr(state.rag, "reindex_runbooks", reindex)
    response = client.post("/api/runbooks/no-such-runbook/reindex")
    assert response.status_code == 404
    assert calls == []
    assert not [r for r in audit_rows(state, action="runbook.reindexed") if r["target"]["id"] == "no-such-runbook"]
