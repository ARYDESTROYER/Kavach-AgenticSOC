"""Round 15 WP4 (SPEC D5.10, D5.11, §3.6): screenshots never reach a model and never
decide anything.

* Static guards: nothing under ``app/agents`` or ``app/tools``, nor the report digest,
  the chat starters or the standup, imports the screenshot store, its routes or its
  validator, or names the store at all; the screenshot modules never import the
  decision core (#3).
* A sentinel test: a screenshot uploaded with a sentinel caption and filename, then an
  investigation, a re-investigation, a case chat turn and a standup. No prompt sent to
  the gateway and no text embedded carries either sentinel, and the ``audit_search``
  chat tool's model-visible observation of the real audit rows carries neither.
"""

from __future__ import annotations

import ast
import base64
import json
from pathlib import Path

import pytest

from app.agents.chat_tools.ops import AuditSearchTool
from app.llm.providers import MockProvider
from tests.test_chat_tools_support import RecordingAudit, make_ctx
from tests.test_round15_wp4_case_files_routes import png

APP = Path(__file__).resolve().parents[1] / "app"
CAPTION = "SENTINEL-CAPTION-c41b"
FILENAME = "SENTINEL-FILE-88de.png"

#: The model-facing code (SPEC §3.6).
_MODEL_FACING = sorted(
    [p for p in (APP / "agents").rglob("*.py")]
    + [p for p in (APP / "tools").rglob("*.py")]
    + [APP / "engine" / "report_digest.py", APP / "engine" / "chat_starters.py", APP / "agents" / "standup.py"]
)
_BANNED_MODULES = ("stores.case_files", "api.routes_case_files", "engine.case_images")


def _imports(path: Path) -> list[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    found: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            found.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            base = node.module or ""
            found.append(base)
            found.extend(f"{base}.{alias.name}" if base else alias.name for alias in node.names)
    return found


@pytest.mark.parametrize("path", _MODEL_FACING, ids=lambda p: str(p.relative_to(APP)))
def test_model_facing_code_never_imports_or_names_the_screenshot_store(path: Path) -> None:
    for name in _imports(path):
        assert not any(name.endswith(banned) or f"{banned}." in name for banned in _BANNED_MODULES), (path, name)
        assert not name.endswith(".case_files") and name != "case_files", (path, name)
    source = path.read_text(encoding="utf-8")
    assert "case_files" not in source and "case_file_" not in source, path


@pytest.mark.parametrize("module", [
    "engine/case_images.py", "stores/case_files.py", "api/routes_case_files.py",
])
def test_screenshot_modules_never_import_the_decision_core(module: str) -> None:
    for name in _imports(APP / module):
        assert "case_manager" not in name, (module, name)
    source = (APP / module).read_text(encoding="utf-8")
    assert "decide(" not in source.replace("decide()", "")


class _RecordingProvider(MockProvider):
    def __init__(self) -> None:
        super().__init__()
        self.embedded: list[str] = []

    async def embed(self, texts, model):
        self.embedded.extend(texts)
        return await super().embed(texts, model)


def _route(provider: MockProvider) -> None:
    provider.push("router", json.dumps({"bucket": "needs_strong_model", "confidence": 0.9, "reason": "x"}))
    provider.push("investigator", json.dumps({
        "action": "final", "reasoning": "scripted",
        "verdict": {"verdict": "TRUE_POSITIVE", "confidence": 0.9,
                    "evidence": [{"summary": "scripted", "event_ids": []}],
                    "mitre": ["T1110"], "recommended_action": "block", "reproduce_query": 'source.ip : "x"'},
    }))


def test_captions_and_filenames_never_reach_a_prompt() -> None:
    from contextlib import asynccontextmanager

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.api.routes import router as monolith_router
    from app.api.routes_case_files import router as files_router
    from app.config import Secrets
    from app.es.fake import InMemoryESClient
    from app.state import AppState
    from app.utils import now_utc, to_millis
    from tests.conftest import make_log_event, mount_moved_routers

    provider = _RecordingProvider()
    secrets = Secrets(_env_file=None, es_store_enabled=False, redis_url="", anthropic_api_key=None,
                      openai_api_key=None)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        overrides = {"anthropic": provider, "openai": provider, "mock": provider}
        state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
        await state.startup(start_poller=False)
        await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(monolith_router)
    api.include_router(files_router)
    mount_moved_routers(api)
    with TestClient(api) as client:
        state = client.app.state.tlsoc
        now = to_millis(now_utc())
        for hours in (1, 2):
            state.es.add_log("all-logs-2026.11.20", make_log_event(ip="192.0.2.77", ts_millis=now - hours * 3_600_000))
        _route(provider)
        created = client.post("/api/investigate", json={"entity": {"type": "ip", "value": "192.0.2.77"},
                                                         "source_surface": "investigate"})
        assert created.status_code == 200, created.text
        case_id = created.json()["case_id"]

        upload = client.post(f"/api/cases/{case_id}/files", json={
            "data_base64": base64.b64encode(png(3)).decode(), "content_type": "image/png",
            "caption": CAPTION, "filename": FILENAME,
        })
        assert upload.status_code == 201, upload.text
        provider.calls.clear()
        provider.embedded.clear()

        _route(provider)
        assert client.post(f"/api/cases/{case_id}/reinvestigate").status_code == 200
        chat = client.post("/api/chat", json={"message": f"What screenshots are on case {case_id}?",
                                              "case_id": case_id})
        assert chat.status_code == 200, chat.text
        assert client.get("/api/standup").status_code == 200
        assert provider.calls, "the flow made no model call, so it proves nothing"

        prompts = json.dumps([call["messages"] for call in provider.calls])
        embedded = json.dumps(provider.embedded)
        for sentinel in (CAPTION, FILENAME):
            assert sentinel not in prompts
            assert sentinel not in embedded

        rows = client.portal.call(lambda: state.audit.records(limit=1000))
        assert any(r.get("action") == "case.file_attached" for r in rows)
        attach_rows = [r for r in rows if r.get("action") == "case.file_attached"]
        outcome = client.portal.call(
            lambda: AuditSearchTool().run(make_ctx(audit=RecordingAudit(attach_rows)), case_id=case_id))
        assert outcome.ok and outcome.observation["matched"] == len(attach_rows) == 1
        seen = json.dumps(outcome.observation) + outcome.summary
        for sentinel in (CAPTION, FILENAME):
            assert sentinel not in seen
            assert sentinel not in json.dumps(rows)

