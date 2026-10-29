"""Every audit row a runbook writer records has a friendly name in the one event table
(``backend/app/audit/event_categories.json``, Round 14 SPEC §4.5.5, §4.10.15).

A row whose action has no exact entry falls back to its prefix label plus the raw
verb ("Runbook run attach failed", "Runbook step ai draft failed"), which is not
Console copy. So:

* every action literal in a runbook writer module has an exact entry;
* every write that is audited first (``audit.write.audited_write``) can append its
  paired ``<resource>.<verb>_failed`` row, and that failure row has an exact entry in
  the SAME category as its action row (a failed library change stays in Configuration
  and data, a failed step change stays in Case work);
* the startup conversion rows read as the hand-offs named them, and the reindex row,
  which records its own outcome, has a label that claims none;
* every label is plain sentence-case Console copy (no em dash, no lower-case "ai").

The source scan fails when a new runbook action appears without an entry, and the
classification of the audit-first set fails when a new write is not declared below.
"""

from __future__ import annotations

import re
from contextlib import asynccontextmanager
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.routes_audit import router as audit_router
from app.audit import events
from app.audit.write import failure_action
from app.config import Secrets
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.state import AppState

APP = Path(__file__).resolve().parent.parent / "app"
#: The runbook writer modules: the library and run routes, the run engine, the
#: one-time conversion, and the catalog, model and store modules they use.
WRITER_GLOBS = ("engine/runbook*.py", "api/routes_*runbook*.py", "stores/runbook*.py")
ACTION_LITERAL = re.compile(r"""["']((?:runbook|run|step)\.[a-z_]{1,48}|case\.closed_with_open_steps)["']""")

#: Writes that are audited first, through ``audited_write``: a failed store write
#: appends ``failure_action(action)``.
AUDIT_FIRST = {
    # The runbook library (routes_runbooks.py ``_audited``).
    "runbook.created", "runbook.draft_updated", "runbook.draft_discarded", "runbook.duplicated",
    "runbook.imported", "runbook.submitted", "runbook.published", "runbook.rejected",
    "runbook.retired", "runbook.restored", "runbook.reviewed",
    # The one-time conversion (runbook_migration.py).
    "runbook.migrated", "runbook.migration_completed",
    # Runs on a case (runbook_runs.py ``_audited_runs_write`` and the evidence write).
    "run.attached", "run.version_switched", "run.abandoned",
    "step.updated", "step.decision_recorded", "step.action_recorded",
    "step.approved", "step.rejected", "step.evidence_collected",
    "step.ai_drafted", "step.ai_draft_confirmed",
}
#: Rows appended on their own: a consequence of a write that already has its row
#: (``record_strict``, a failure is only logged), an export (a read), a best-effort
#: reindex row that records its own outcome, a skip, or the agent's selection.
APPENDED_ONLY = {
    "run.attach_skipped", "run.started", "run.completed", "step.approval_requested",
    "case.closed_with_open_steps", "runbook.exported", "runbook.reindexed",
    "runbook.migration_skipped", "runbook.selected",
}
CATEGORY_OF_RESOURCE = {"runbook": "config", "run": "case_work", "step": "case_work", "case": "case_work"}


def _writer_actions() -> set[str]:
    found: set[str] = set()
    for pattern in WRITER_GLOBS:
        for path in APP.glob(pattern):
            found.update(ACTION_LITERAL.findall(path.read_text(encoding="utf-8")))
    return found


def _entry(action: str) -> events.EventInfo:
    entry = events.TABLE.action_by_name.get(action)
    assert entry is not None, f"{action} has no exact entry in event_categories.json"
    return events.EventInfo(entry.category, entry.label)


def test_the_scan_finds_the_runbook_writers() -> None:
    """Guards the scan itself: the writers are where the globs look."""
    found = _writer_actions()
    assert {"runbook.published", "run.attached", "step.ai_drafted", "case.closed_with_open_steps",
            "runbook.migration_completed", "runbook.reindexed"} <= found


def test_every_runbook_action_a_writer_records_has_an_exact_entry() -> None:
    missing = sorted(a for a in _writer_actions() | AUDIT_FIRST | APPENDED_ONLY
                     if a not in events.TABLE.action_by_name)
    assert missing == []


def test_every_writer_action_is_declared_audit_first_or_appended_only() -> None:
    """A new runbook action must say whether it can have a failure row."""
    assert AUDIT_FIRST.isdisjoint(APPENDED_ONLY)
    undeclared = sorted(_writer_actions() - AUDIT_FIRST - APPENDED_ONLY)
    assert undeclared == []


@pytest.mark.parametrize("action", sorted(AUDIT_FIRST))
def test_the_failure_row_of_an_audit_first_write_reads_in_its_action_category(action: str) -> None:
    success = _entry(action)
    failure = _entry(failure_action(action))
    assert failure.category == success.category == CATEGORY_OF_RESOURCE[action.partition(".")[0]]
    assert failure.label != success.label


@pytest.mark.parametrize(
    ("action", "category", "label"),
    [
        ("runbook.migration_completed", "config", "Runbook conversion finished"),
        ("runbook.migration_skipped", "config", "Runbook not converted"),
        ("runbook.migrate_failed", "config", "Runbook conversion not applied"),
        ("runbook.migration_complete_failed", "config", "Runbook conversion summary not saved"),
        ("runbook.reindexed", "config", "Runbook search index rebuild"),
        ("runbook.publish_failed", "config", "Runbook publication failed"),
        ("run.attach_failed", "case_work", "Runbook attachment failed"),
        ("step.decision_record_failed", "case_work", "Decision not recorded"),
        ("step.ai_draft_failed", "case_work", "AI draft not saved"),
        ("step.ai_draft_confirm_failed", "case_work", "AI draft confirmation failed"),
    ],
)
def test_the_named_rows_read_as_console_copy(action: str, category: str, label: str) -> None:
    assert events.classify({"action": action}) == events.EventInfo(category, label)


def test_the_reindex_label_states_no_outcome() -> None:
    """``runbook.reindexed`` is one best-effort row that records its own outcome
    (``success``, ``partial`` or ``failure``), so its label names the operation and
    claims no result: "Failed" beside "Runbook search index rebuilt" would contradict
    itself."""
    from app.api.routes_runbooks import _reindex_outcome

    outcomes = {
        _reindex_outcome({"ok": True, "indexed": 3, "failed": 0}),
        _reindex_outcome({"ok": True, "indexed": 2, "failed": 1}),
        _reindex_outcome({"ok": False, "indexed": 0, "failed": 1}),
    }
    assert outcomes == {"success", "partial", "failure"}
    label = events.classify({"action": "runbook.reindexed"}).label
    assert not re.search(r"\b(rebuilt|reindexed|failed|finished|completed|done)\b", label, re.IGNORECASE)


def test_runbook_labels_are_plain_sentence_case() -> None:
    names = [a for a in events.TABLE.action_by_name
             if a.startswith(("runbook.", "run.", "step.")) or a == "case.closed_with_open_steps"]
    assert len(names) >= len(AUDIT_FIRST) * 2
    for action in names:
        label = events.TABLE.action_by_name[action].label
        assert label and label[0].isupper() and label == label.strip(), action
        assert "\u2014" not in label and "\u2013" not in label, action
        assert not re.search(r"\bai\b", label), action
        assert not label.endswith("."), action
        # Sentence case: no word after the first is capitalised, except the AI acronym.
        for word in label.split()[1:]:
            assert word == "AI" or not word[0].isupper(), (action, label)


def test_the_startup_conversion_row_reads_runbook_conversion_finished() -> None:
    """The row every first start writes (SPEC §4.10.17 step 5) is named by the read
    API with its exact entry, in Configuration and data."""
    secrets = Secrets(_env_file=None, es_store_enabled=False, redis_url="",
                      anthropic_api_key=None, openai_api_key=None)
    mock = MockProvider()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(),
                                provider_overrides={"anthropic": mock, "openai": mock, "mock": mock})
        await state.startup(start_poller=False)
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(audit_router)
    with TestClient(api) as client:
        body = client.get("/api/audit", params={"scope": "all", "event": "runbook.migration_completed"}).json()
    rows = body["records"]
    assert len(rows) == 1, body
    assert rows[0]["event_label"] == "Runbook conversion finished"
    assert rows[0]["category"] == "config"
