"""Demo chat lists the REAL runbook library, read only (Round 14 SPEC §3.5, D45).

The Demo pipeline matches and attaches the real library's Published runbooks, so Demo
chat's ``list_runbooks`` lists the same ones: a Published operator runbook is there,
a Draft is not. The library reaches the chat context only behind a read-only view
(its Published catalog and nothing else); the store itself refuses writes while Demo
Mode is on. Without a wired library, chat lists the built-ins and says so.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import FastAPI, Request

from app.agents.chat_tools.intel import SearchKnowledgeTool
from app.engine.demo_runtime import DemoStack, ReadOnlyRunbookLibrary
from app.models import ChatRequest, RunbookDefinition, RunbookStep, RunbookVersionDoc
from app.state import AppState
from app.stores.runbook_library import StoredRunbook

pytestmark = pytest.mark.asyncio


def _version(runbook_id: str, state: str, title: str) -> RunbookVersionDoc:
    definition = RunbookDefinition(
        id=runbook_id, title=title, summary=f"Work a {title.lower()} case.", phases=["triage"],
        steps=[RunbookStep(id="step-1", phase="triage", kind="check", title="Is it expected?")],
    )
    return RunbookVersionDoc(
        version=1, state=state, definition=definition, author="alice", created_at="2026-10-01T00:00:00+00:00",
        published_at="2026-10-02T00:00:00+00:00" if state == "published" else None,
    )


def _request(state: AppState) -> Request:
    app = FastAPI()
    app.state.tlsoc = state
    return Request({
        "type": "http", "method": "POST", "path": "/api/chat/stream", "headers": [],
        "query_string": b"", "app": app, "client": ("127.0.0.1", 9),
    })


async def test_demo_chat_lists_the_real_published_runbooks(app_state: AppState) -> None:
    library = app_state.runbook_library
    await library.create(StoredRunbook(id="acme-vpn-lockout", created_by="alice",
                                       versions=[_version("acme-vpn-lockout", "published", "Acme VPN lockout")]))
    await library.create(StoredRunbook(id="acme-draft-only", created_by="alice",
                                       versions=[_version("acme-draft-only", "draft", "Acme draft only")]))
    await app_state.enable_demo(mode="seeded", seed=1337, history_days=1)
    try:
        ctx = await app_state.build_chat_tool_context(_request(app_state), ChatRequest(message="x"))
        assert isinstance(ctx.runbooks, ReadOnlyRunbookLibrary)
        out = await SearchKnowledgeTool().run(ctx, kind="list_runbooks")
        assert out.ok, out.error
        listed = {row["id"]: row for row in out.observation["runbooks"]}
        assert listed["acme-vpn-lockout"]["origin"] == "Yours"
        assert listed["acme-vpn-lockout"]["state"] == "Published"
        assert "acme-draft-only" not in listed
        assert out.observation["catalogue"] == "built-in and published"
        # The alias reads the same library.
        alias = await SearchKnowledgeTool().run(ctx, kind="list_playbooks")
        assert "acme-vpn-lockout" in {row["id"] for row in alias.observation["runbooks"]}
    finally:
        await app_state.disable_demo()


async def test_the_view_exposes_the_published_catalog_only() -> None:
    class _Library:
        def __init__(self) -> None:
            self.writes: list[str] = []

        async def published_catalog(self) -> tuple[str, ...]:
            return ("catalog",)

        async def create(self, *_a: Any, **_k: Any) -> None:  # pragma: no cover - never reachable
            self.writes.append("create")

    view = ReadOnlyRunbookLibrary(_Library())
    assert await view.published_catalog() == ("catalog",)
    for name in ("create", "update", "save_draft", "publish", "retire", "delete", "put"):
        assert not hasattr(view, name), name
    with pytest.raises(AttributeError):
        view.extra = 1  # type: ignore[attr-defined]


@pytest.mark.parametrize("provider", [None, lambda: None, lambda: object()], ids=["no-provider", "none", "no-catalog"])
async def test_without_a_library_demo_chat_lists_the_built_ins(provider: Any) -> None:
    stack = DemoStack.__new__(DemoStack)
    stack._runbook_library = provider  # noqa: SLF001 - the one attribute this reads
    assert stack._chat_runbook_library() is None  # noqa: SLF001


async def test_a_failing_provider_never_fails_the_chat_context() -> None:
    def _boom() -> Any:
        raise RuntimeError("library unavailable")

    stack = DemoStack.__new__(DemoStack)
    stack._runbook_library = _boom  # noqa: SLF001
    assert stack._chat_runbook_library() is None  # noqa: SLF001
