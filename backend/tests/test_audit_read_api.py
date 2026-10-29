"""Round 14 SPEC §4.5.5, §4.5.10, §4.5.3 (record interface): the audit read API.

Covers the event table and its legacy derivations, the one predicate compiled for
every store (the fake Elasticsearch, SQLite and the Python reference return the same
rows for every filter), keyset and point-in-time paging in both orders, honest totals,
the old ``GET /api/audit`` query shapes, get-one and its 404s, the count endpoint, the
signed cursor, an expired point-in-time, per-run totals across a page boundary, the
Demo split with a merged cursor, view auditing and the new ``record`` keywords.
Offline: fake Elasticsearch, SQLite, mock LLM.
"""

from __future__ import annotations

import asyncio
import copy
import json
import logging
import weakref
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.audit import events, views
from app.audit.audit_log import AuditLogger
from app.audit.query import (
    And,
    AuditFilters,
    Contains,
    Eq,
    Not,
    Or,
    Prefix,
    build_predicate,
    category_predicate,
    matches,
    scope_predicate,
    to_es_query,
)
from app.config import Secrets
from app.constants import AUDIT_INDEX, AUDIT_WRITE_ALIAS, ActionType
from app.es.fake import InMemoryESClient
from app.es.indices import (
    AUDIT_MAPPING,
    AUDIT_UPGRADE_STEP,
    bootstrap_indices,
    index_template_body,
    missing_properties,
)
from app.llm.providers import MockProvider
from app.models import (
    AUDIT_ROUND14_FIELDS,
    AuditDoc,
    AuditRecord,
    decode_audit_record_id,
    encode_audit_record_id,
)
from app.state import AppState
from app.stores.base import AuditCursorExpired, AuditRepository
from app.stores.sql import SqlAuditRepository, build_async_engine, create_all
from app.stores.sql.models import AuditRow

BASE = datetime(2026, 10, 20, 9, 0, tzinfo=timezone.utc)


def _ts(minutes: int) -> str:
    return (BASE + timedelta(minutes=minutes)).isoformat()


# --------------------------------------------------------------------------- #
# A corpus of legacy and Round 14 rows, every one marked in ``tool_input``.
# --------------------------------------------------------------------------- #
def _corpus() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = [
        # Legacy rows (no Round 14 keys).
        {"action_type": "auth", "surface": "auth", "actor": "bob", "result_summary": "login ok"},
        {"action_type": "auth", "surface": "auth", "actor": "bobby", "result_summary": "login failed"},
        {"action_type": "access_denied", "surface": "rbac", "actor": "carol",
         "result_summary": "denied cases:read for role analyst_tier1"},
        {"action_type": "status", "surface": "settings", "actor": "admin",
         "result_summary": "updated keys auto_close"},
        {"action_type": "status", "surface": "case", "actor": "alice", "case_id": "case-1",
         "result_summary": "action=hold"},
        {"action_type": "prompt", "surface": "investigate", "actor": "investigator",
         "case_id": "case-1", "prompt_excerpt": "<<<UNTRUSTED>>> 10.0.0.5 <<<END>>>"},
        {"action_type": "decision", "surface": "investigate", "actor": "case_manager",
         "case_id": "case-1", "result_summary": "escalated"},
        {"action_type": "poll", "surface": "automated_scan", "actor": "poller", "source_id": "src-1"},
        {"action_type": "error", "surface": "investigate", "actor": "pipeline",
         "result_summary": "pipeline error: boom"},
        {"action_type": "mystery_kind", "surface": "", "actor": "x"},
        {"action_type": "job", "surface": "jobs", "actor": "dave", "result_summary": "job finished"},
        # Round 14 rows.
        {"action_type": "auth", "surface": "auth", "actor": "erin", "action": "auth.login",
         "outcome": "success", "actor_type": "human", "actor_role": "auditor",
         "client": {"ip": "203.0.113.7", "ip_source": "peer", "peer": "203.0.113.7",
                    "forwarded_for": None, "user_agent": "Mozilla/5.0"},
         "request_id": "req-00000001", "session_ref": "0123456789abcdef"},
        {"action_type": "auth", "surface": "auth", "actor": "erin", "action": "auth.login_failed",
         "outcome": "failure", "actor_type": "human",
         "client": {"ip": "2001:db8::1", "ip_source": "trusted_proxy", "peer": "10.0.0.2",
                    "forwarded_for": "1.2.3.4, 2001:db8::1", "user_agent": "curl/8"}},
        {"action_type": "status", "surface": "settings", "actor": "admin", "action": "settings.updated",
         "outcome": "success", "actor_type": "human",
         "target": {"type": "setting", "id": "auto_close", "label": "Auto-close policy", "revision": 4},
         "changes": [{"field": "auto_close.enabled", "before": "true", "after": "false", "secret": False}]},
        {"action_type": "prompt", "surface": "investigate", "actor": "investigator",
         "actor_type": "agent", "run_id": "run-A", "case_id": "case-2"},
        {"action_type": "tool_call", "surface": "investigate", "actor": "investigator",
         "actor_type": "agent", "run_id": "run-A", "case_id": "case-2", "tool_name": "es_query"},
        {"action_type": "verdict", "surface": "investigate", "actor": "investigator",
         "actor_type": "agent", "run_id": "run-B", "case_id": "case-3"},
        {"action_type": "runbook", "surface": "pipeline", "actor": "runbook_selector",
         "action": "runbook.selected", "actor_type": "agent", "outcome": "success"},
        {"action_type": "job", "surface": "jobs", "actor": "system", "action": "widget.spun",
         "actor_type": "system"},
        {"action_type": "job", "surface": "jobs", "actor": "dave", "action": "job.artifact_downloaded",
         "actor_type": "human", "outcome": "success"},
        {"action_type": "runbook", "surface": "runbooks", "actor": "fay", "action": "runbook.draft_updated",
         "actor_type": "human", "outcome": "success",
         "target": {"type": "runbook", "id": "rb-brute", "label": "Brute force"}},
        {"action_type": "runbook", "surface": "runbooks", "actor": "fay",
         "action": "runbook.something_new", "actor_type": "human", "outcome": "partial"},
        {"action_type": "tool_call", "surface": "integration", "actor": "svc-sync",
         "actor_type": "service", "outcome": "success"},
        # 23: a configuration write older builds stored as user_mgmt (models and budget).
        {"action_type": "user_mgmt", "surface": "models", "actor": "admin",
         "result_summary": "budget.updated: daily_usd=10"},
        # 24: an agent's Case work row (the runbook selector attaching a run).
        {"action_type": "runbook", "surface": "pipeline", "actor": "runbook_selector",
         "action": "run.attached", "actor_type": "agent", "run_id": "run-C", "case_id": "case-4"},
        # 25: a system's Configuration row (the one-shot runbook conversion).
        {"action_type": "runbook", "surface": "runbooks", "actor": "runbook_migration",
         "action": "runbook.migrated", "actor_type": "system", "outcome": "success"},
        # 26: a summary in a non-ASCII script.
        {"action_type": "status", "surface": "case", "actor": "zoë", "case_id": "case-5",
         "result_summary": "École fermée: dossier clos"},
        # 27: the failure row of an audit-first write, named by its exact entry
        # ("Runbook publication failed"; row 21 is the action named only by its prefix).
        {"action_type": "runbook", "surface": "runbooks", "actor": "fay",
         "action": "runbook.publish_failed", "actor_type": "human", "outcome": "failure"},
        # 28: an audit-first write whose request was cancelled (outcome recorded unknown).
        {"action_type": "runbook", "surface": "runbooks", "actor": "fay",
         "action": "runbook.published", "actor_type": "human", "outcome": "unknown"},
    ]
    for i, row in enumerate(rows):
        row["ts"] = _ts(i)
        row["tool_input"] = {"mark": i}
        row.setdefault("case_id", None)
    return rows


def _mark(doc: dict[str, Any]) -> int:
    return int((doc.get("tool_input") or {}).get("mark"))


CORPUS = _corpus()


async def _seed_es(es: InMemoryESClient, rows: list[dict[str, Any]]) -> None:
    for row in rows:
        await es.index_doc(AUDIT_WRITE_ALIAS, dict(row))


async def _seed_sql(repo: SqlAuditRepository, rows: list[dict[str, Any]]) -> None:
    async with repo._sm() as session:  # noqa: SLF001 (raw legacy rows, as old builds stored them)
        for row in rows:
            session.add(AuditRow(
                ts=row["ts"], case_id=row.get("case_id"),
                action_type=row.get("action_type") or "", doc=dict(row),
            ))
        await session.commit()


@pytest_asyncio.fixture
async def es_repo():
    es = InMemoryESClient()
    await bootstrap_indices(es)
    await _seed_es(es, CORPUS)
    repo = AuditLogger(es)
    yield repo


@pytest_asyncio.fixture
async def sql_repo():
    engine = build_async_engine("sqlite+aiosqlite:///:memory:")
    await create_all(engine)
    repo = SqlAuditRepository(engine)
    await _seed_sql(repo, CORPUS)
    yield repo
    await engine.dispose()


async def _all_marks(repo: AuditRepository, filters: AuditFilters, order: str = "desc",
                     limit: int = 7) -> list[int]:
    pred = build_predicate(filters)
    marks: list[int] = []
    cursor = None
    for _ in range(50):
        page = await repo.search_page(pred, order=order, limit=limit, cursor=cursor)
        marks.extend(_mark(h.doc) for h in page.hits)
        if page.exhausted:
            break
        cursor = page.hits[-1].position
    return marks


def _reference(filters: AuditFilters, order: str = "desc") -> list[int]:
    pred = build_predicate(filters)
    rows = [r for r in CORPUS if matches(pred, r)]
    rows.sort(key=lambda r: r["ts"], reverse=order == "desc")
    return [_mark(r) for r in rows]


# --------------------------------------------------------------------------- #
# The event table and the legacy derivations
# --------------------------------------------------------------------------- #
def test_every_action_type_has_a_legacy_category():
    known = set(events.TABLE.known_action_types)
    missing = [a.value for a in ActionType if a.value not in known]
    assert not missing, f"ActionType values without a category: {missing}"


def test_fixture_labels_are_console_copy():
    raw = json.loads(events.FIXTURE_PATH.read_text(encoding="utf-8"))
    labels = [c["label"] for c in raw["categories"]]
    labels += [e["label"] for e in raw["legacy_events"]]
    labels += [e["label"] for e in raw["action_prefixes"]]
    labels += [e["label"] for e in raw["actions"]]
    labels += list(raw["actor_labels"].values())
    for label in labels:
        assert "\u2014" not in label and "\u2013" not in label, label
        assert "playbook" not in label.lower(), label
        assert label[0].isupper(), label
    assert "\u2014" not in events.FIXTURE_PATH.read_text(encoding="utf-8")


@pytest.mark.parametrize(
    ("doc", "category", "label"),
    [
        ({"action_type": "status", "surface": "settings"}, "config", "Settings changed"),
        ({"action_type": "status", "surface": "case"}, "case_work", "Case status changed"),
        ({"action_type": "status", "surface": "rules"}, "config", "Detection rule changed"),
        ({"action_type": "auth", "surface": "anything"}, "access", "Sign-in event"),
        ({"action_type": "playbook", "surface": "x"}, "config", "Runbook (before Round 14)"),
        ({"action_type": "user_mgmt", "surface": "settings"}, "access", "User changed"),
        ({"action_type": "user_mgmt", "surface": "users"}, "access", "User changed"),
        ({"action_type": "user_mgmt", "surface": "rbac"}, "access", "User changed"),
        ({"action_type": "user_mgmt", "surface": "baseline"}, "config", "Baseline settings changed"),
        ({"action_type": "user_mgmt", "surface": "batch"}, "config", "Discounted inference settings changed"),
        ({"action_type": "user_mgmt", "surface": "campaigns"}, "config", "Campaign settings changed"),
        ({"action_type": "user_mgmt", "surface": "models"}, "config", "Model and budget settings changed"),
        ({"action_type": "user_mgmt", "surface": "chat"}, "config", "Chat prompt library changed"),
        ({"action_type": "audit_view", "surface": "audit"}, "access", "Audit log viewed"),
        ({"action_type": "prompt", "surface": "investigate"}, "agent", "Model prompt"),
        ({"action_type": "poll"}, "system", "Source poll"),
        ({"action_type": "mystery_kind"}, "system", "mystery_kind"),
        ({"action_type": "status", "action": "auth.login"}, "access", "Signed in"),
        ({"action_type": "runbook", "action": "runbook.selected"}, "agent", "Runbook selected"),
        ({"action_type": "runbook", "action": "runbook.something_new"}, "config", "Runbook something new"),
        ({"action_type": "job", "action": "widget.spun"}, "system", "widget.spun"),
        ({"action_type": "audit_view", "action": "audit.viewed"}, "access", "Audit log viewed"),
    ],
)
def test_classify(doc, category, label):
    info = events.classify(doc)
    assert (info.category, info.label) == (category, label)


def test_derived_outcome_and_actor_kind():
    assert events.derive_outcome({"action_type": "access_denied"}) == ("denied", True)
    assert events.derive_outcome({"action_type": "error"}) == ("failure", True)
    assert events.derive_outcome({"action_type": "auth"}) == (None, False)
    assert events.derive_outcome({"action_type": "error", "outcome": "partial"}) == ("partial", False)
    assert events.derive_actor_type({"actor": "investigator", "action_type": "prompt"}) == ("agent", True)
    assert events.derive_actor_type({"actor": "poller", "action_type": "poll"}) == ("system", True)
    assert events.derive_actor_type({"actor": "alice", "action_type": "status", "surface": "case"}) == ("human", True)
    # An unknown actor of an agent-pipeline row is not guessed.
    assert events.derive_actor_type({"actor": "who", "action_type": "prompt"}) == (None, False)
    assert events.derive_actor_type({"actor": "", "action_type": "auth"}) == (None, False)
    assert events.derive_actor_type({"actor": "x", "actor_type": "service"}) == ("service", False)


def test_truncated_fields_names_capped_text():
    capped = "a" * 999 + "…"
    doc = {"result_summary": capped, "prompt_excerpt": "short", "tool_output_summary": "b" * 1000}
    assert events.truncated_fields(doc) == ["result_summary"]


@pytest.mark.parametrize(
    "mutate",
    [
        lambda raw: raw["legacy_events"].append(dict(raw["legacy_events"][0])),
        lambda raw: raw["legacy_events"].append(
            {"action_type": "new_kind", "surface": "x", "category": "system", "label": "New"}),
        lambda raw: raw["actions"].__setitem__(0, {**raw["actions"][0], "label": "Signed in \u2014 ok"}),
        lambda raw: raw["actions"].append({"action": "Bad.Action", "category": "access", "label": "Bad"}),
        lambda raw: raw["categories"].pop(),
    ],
)
def test_a_malformed_table_is_refused(mutate):
    raw = json.loads(events.FIXTURE_PATH.read_text(encoding="utf-8"))
    mutate(raw)
    with pytest.raises(events.EventTableError):
        events.load_event_table(raw)


# --------------------------------------------------------------------------- #
# One predicate, three stores
# --------------------------------------------------------------------------- #
_SINCE = BASE + timedelta(minutes=5)
_UNTIL = BASE + timedelta(minutes=15)

FILTER_CASES: list[AuditFilters] = [
    AuditFilters(),
    AuditFilters(scope="people"),
    AuditFilters(scope="agent"),
    AuditFilters(scope="all"),
    *[AuditFilters(event=c) for c in ("access", "config", "case_work", "agent", "system")],
    AuditFilters(event="auth.login"),
    AuditFilters(event="auth"),
    AuditFilters(event="status"),
    AuditFilters(actor="bob"),
    AuditFilters(actor_contains="BOB"),
    *[AuditFilters(actor_kind=k) for k in ("human", "agent", "system", "service")],
    *[AuditFilters(outcome=o) for o in ("success", "failure", "denied", "partial", "unknown")],
    AuditFilters(q="signed in"),
    AuditFilters(q="deni"),
    AuditFilters(q="login failed"),
    AuditFilters(q="auto-close"),
    AuditFilters(q="Settings changed"),
    AuditFilters(q="100%_x"),
    AuditFilters(target="auto_close"),
    AuditFilters(ip="203.0.113.7"),
    AuditFilters(ip="2001:db8::1"),
    AuditFilters(action_type="status"),
    AuditFilters(surface="settings"),
    AuditFilters(case_id="case-1"),
    AuditFilters(source_id="src-1"),
    AuditFilters(ts_from=_SINCE, ts_to=_UNTIL),
    AuditFilters(scope="people", q="login"),
    AuditFilters(scope="agent", case_id="case-2"),
    AuditFilters(scope="people", event="config"),
    AuditFilters(scope="people", actor_kind="agent"),
    AuditFilters(event="run"),
    AuditFilters(q="fermée"),
    AuditFilters(q="publish failed"),
    AuditFilters(q="Runbook publish"),
    AuditFilters(q="publication failed"),
    AuditFilters(q="Runbook publi"),
    AuditFilters(q="something new"),
    AuditFilters(q="Runbook something"),
    AuditFilters(scope="people", outcome="unknown"),
    AuditFilters(scope="agent", outcome="unknown"),
]


@pytest.mark.parametrize("filters", FILTER_CASES, ids=lambda f: json.dumps(f.binding(), default=str))
async def test_every_store_returns_the_reference_rows(filters, es_repo, sql_repo):
    expected = _reference(filters)
    assert await _all_marks(es_repo, filters) == expected
    assert await _all_marks(sql_repo, filters) == expected
    count_es = await es_repo.count_matching(build_predicate(filters), cap=1000)
    count_sql = await sql_repo.count_matching(build_predicate(filters), cap=1000)
    assert count_es == count_sql == (len(expected), "eq")


def test_scope_semantics_pin_the_partition():
    people = set(_reference(AuditFilters(scope="people")))
    agent = set(_reference(AuditFilters(scope="agent")))
    assert people.isdisjoint(agent)
    assert people | agent == set(range(len(CORPUS)))
    # Legacy: by category. Sign-ins, denials, settings, case work are people.
    assert {0, 1, 2, 3, 4} <= people
    # Legacy pipeline, poll, error, unknown kind and a person's legacy job are agent activity.
    assert {5, 6, 7, 8, 9, 10} <= agent
    # New rows: a person or a service is people whatever the category.
    assert {11, 12, 13, 19, 20, 21, 22} <= people
    assert {14, 15, 16, 17, 18} <= agent
    # A legacy configuration write stored as user_mgmt is Configuration and data.
    assert 23 in people
    # Contract resolution (SPEC §4.5.5): People and settings is the union of the rows a
    # person made and every Access, Configuration or Case work row, whoever made it;
    # Agent activity is exactly the Agent pipeline and System rows no person made. So
    # an agent's run attachment and a system's runbook conversion are People and
    # settings, and a row keeps its scope across the Round 14 upgrade.
    assert {24, 25} <= people
    assert set(_reference(AuditFilters(scope="agent", event="case_work"))) == set()
    assert set(_reference(AuditFilters(scope="agent", event="config"))) == set()


def _classification_corpus() -> list[dict[str, Any]]:
    """Every shape the event table distinguishes: each known legacy action type under
    each surface the table names (and none, and one it does not), an unknown action
    type, each exact action, each prefix with a new verb, unknown and dotless actions,
    and each of those under every actor kind (and none)."""
    table = events.TABLE
    surfaces = sorted({e.surface for e in table.legacy if e.surface != events.STAR} | {"", "elsewhere"})
    shapes: list[dict[str, Any]] = []
    for action_type in (*table.known_action_types, "never_seen"):
        shapes.extend({"action_type": action_type, "surface": surface} for surface in surfaces)
        shapes.append({"action_type": action_type})
    shapes.extend({"action_type": "status", "surface": "case", "action": e.action} for e in table.actions)
    shapes.extend({"action_type": "status", "action": f"{p.prefix}.something_new"} for p in table.prefixes)
    shapes += [{"action_type": "job", "action": "unknown.thing"}, {"action_type": "job", "action": "loneword"}]
    rows: list[dict[str, Any]] = []
    for shape in shapes:
        for kind in (None, "human", "agent", "system", "service"):
            rows.append({**shape, "actor": "someone", **({"actor_type": kind} if kind else {})})
    for i, row in enumerate(rows):
        row["ts"] = _ts(i)
        row["tool_input"] = {"mark": i}
        row["case_id"] = None
    return rows


def test_category_and_scope_predicates_agree_with_classify():
    """The compiled category and scope predicates select exactly the rows
    :func:`events.classify` puts there, for every shape the table distinguishes."""
    rows = _classification_corpus()
    for category in events.TABLE.category_labels:
        pred = category_predicate(category)
        wrong = [r for r in rows if matches(pred, r) != (events.classify(r).category == category)]
        assert not wrong, (category, wrong[:3])
    people, agent = scope_predicate("people"), scope_predicate("agent")
    for row in rows:
        assert matches(people, row) == events.in_people_scope(row), row
        assert matches(agent, row) != matches(people, row), row


async def test_every_store_categorises_every_shape_the_same_way():
    """The same partition on the fake Elasticsearch (prefix lists compiled under one
    mapping guard), SQLite and the reference."""
    rows = _classification_corpus()
    es = InMemoryESClient()
    await bootstrap_indices(es)
    await _seed_es(es, rows)
    engine = build_async_engine("sqlite+aiosqlite:///:memory:")
    await create_all(engine)
    sql = SqlAuditRepository(engine)
    await _seed_sql(sql, rows)
    try:
        cases = [AuditFilters(scope="people"), AuditFilters(scope="agent"),
                 *[AuditFilters(event=c) for c in events.TABLE.category_labels],
                 AuditFilters(actor_kind="human"), AuditFilters(outcome="unknown")]
        for filters in cases:
            pred = build_predicate(filters)
            expected = len([r for r in rows if matches(pred, r)])
            for repo in (AuditLogger(es), sql):
                assert await repo.count_matching(pred, cap=10_000) == (expected, "eq"), (filters, repo)
    finally:
        await engine.dispose()


def _size(pred: Any) -> int:
    if isinstance(pred, (And, Or)):
        return 1 + sum(_size(item) for item in pred.items)
    if isinstance(pred, Not):
        return 1 + _size(pred.item)
    return 1


def _clauses(query: Any) -> int:
    if isinstance(query, dict):
        return 1 + sum(_clauses(v) for v in query.values())
    if isinstance(query, list):
        return sum(_clauses(v) for v in query)
    return 0


def test_the_scope_predicates_stay_small():
    """The scope a page reads is evaluated for every row (once per document on the
    in-memory store, which backs Demo Mode), so it is compiled per action type, not
    per table entry, and a category's action prefixes share one mapping guard."""
    for scope in ("people", "agent"):
        pred = scope_predicate(scope)
        assert _size(pred) <= 60, _size(pred)
        assert _clauses(to_es_query(pred)) <= 200, _clauses(to_es_query(pred))
    # The action prefixes of a category are one clause under one mapping guard (a
    # guard is the ``exists`` test on ``action.keyword``), not one guard each.
    query = json.dumps(to_es_query(category_predicate("config")))
    prefixes = [p for p in events.TABLE.prefixes if p.category == "config"]
    guards = query.count('{"exists": {"field": "action.keyword"}}')
    assert len(prefixes) > 10 and guards <= 4, (len(prefixes), guards)


def test_a_prefix_list_compiles_to_the_rows_of_its_prefixes():
    pred = Or((Prefix("action", "auth."), Prefix("action", "user.")))
    clause = to_es_query(pred)
    assert clause["bool"]["should"][0] == {"bool": {
        "should": [{"prefix": {"action.keyword": "auth."}}, {"prefix": {"action.keyword": "user."}}],
        "minimum_should_match": 1,
    }}


def test_filters_pin_their_meaning():
    assert _reference(AuditFilters(actor="bob")) == [0]  # exact: never bobby
    assert set(_reference(AuditFilters(actor_contains="BOB"))) == {0, 1}
    assert set(_reference(AuditFilters(outcome="denied"))) == {2}  # derived for legacy
    assert set(_reference(AuditFilters(outcome="failure"))) == {8, 12, 27}  # error derived + recorded
    assert set(_reference(AuditFilters(event="auth"))) == {0, 1, 11, 12}  # the family, old and new
    assert set(_reference(AuditFilters(q="signed in"))) == {11}  # by friendly name
    assert set(_reference(AuditFilters(q="deni"))) == {2}  # a partial word in a summary
    assert set(_reference(AuditFilters(actor_kind="agent"))) == {5, 8, 14, 15, 16, 17, 24}
    assert set(_reference(AuditFilters(actor_kind="system"))) == {6, 7, 18, 25}
    assert set(_reference(AuditFilters(actor_kind="human"))) == {
        0, 1, 2, 3, 4, 11, 12, 13, 19, 20, 21, 23, 26, 27, 28}
    assert set(_reference(AuditFilters(event="config"))) >= {3, 13, 21, 23, 25, 27, 28}
    assert 23 not in set(_reference(AuditFilters(event="access")))
    # A name derived from a prefix entry is searchable as the page shows it: by the
    # verb ("something new", the action token with spaces) and across the prefix
    # label and the verb ("Runbook something": the derived name).
    assert events.classify(CORPUS[21]).label == "Runbook something new"
    assert _reference(AuditFilters(q="something new")) == [21]
    assert _reference(AuditFilters(q="Runbook something")) == [21]
    # An exact entry is searchable by its friendly name and by its action token, and a
    # query across two exact names finds both ("Runbook publi": "Runbook publication
    # failed" and "Runbook published").
    assert events.classify(CORPUS[27]).label == "Runbook publication failed"
    assert _reference(AuditFilters(q="publication failed")) == [27]
    assert _reference(AuditFilters(q="publish failed")) == [27]
    assert set(_reference(AuditFilters(q="Runbook publi"))) == {27, 28}
    assert _reference(AuditFilters(q="Runbook publish")) == [28]


def test_outcome_filters_select_the_rows_the_page_labels():
    """Each Outcome filter value returns exactly the rows the page labels with it:
    ``unknown`` ("Not recorded") is a recorded ``unknown`` and every row that recorded
    no outcome and derives none (SPEC §4.5.1, §4.5.3)."""
    for value in ("success", "failure", "denied", "partial", "unknown"):
        labelled = {
            _mark(row) for row in CORPUS if (events.derive_outcome(row)[0] or "unknown") == value
        }
        assert set(_reference(AuditFilters(outcome=value))) == labelled, value
    not_recorded = set(_reference(AuditFilters(outcome="unknown")))
    assert {0, 5, 7, 14, 23, 28} <= not_recorded  # legacy, new without one, recorded unknown
    assert not {2, 8} & not_recorded  # access_denied and error derive Denied and Failed


def test_new_fields_compile_for_both_elasticsearch_mappings():
    """A Round 14 field may still be dynamic text on an index created before Round 14:
    an exact match uses ``.keyword`` there and the field itself elsewhere, never the
    analysed text (which would match one token of a longer id)."""
    clause = to_es_query(Eq("target.id", "case-000123"))
    should = clause["bool"]["should"]
    assert should[0] == {"term": {"target.id.keyword": "case-000123"}}
    assert should[1] == {"bool": {
        "filter": [{"term": {"target.id": "case-000123"}}],
        "must_not": [{"exists": {"field": "target.id.keyword"}}],
    }}
    # Legacy keyword fields stay a plain term.
    assert to_es_query(Eq("actor", "bob")) == {"term": {"actor": "bob"}}
    # Wildcards escape their metacharacters and fold ASCII case.
    wc = to_es_query(Contains("actor", "a*b?"))
    assert wc == {"wildcard": {"actor": {"value": "*a\\*b\\?*", "case_insensitive": True}}}


def test_mapping_declares_the_round14_fields():
    props = AUDIT_MAPPING["properties"]
    for name in ("outcome", "actor_type", "action", "actor_role", "session_ref", "request_id", "run_id"):
        assert props[name] == {"type": "keyword"}, name
    assert props["client"]["properties"]["ip"] == {"type": "ip"}
    assert props["target"]["properties"]["revision"] == {"type": "long"}
    assert props["target"]["properties"]["id"] == {"type": "keyword"}
    assert props["changes"] == {"type": "object", "enabled": False}
    for raw in ("peer", "forwarded_for", "user_agent"):
        assert props["client"]["properties"][raw].get("index") is False
    # A date-like free string ("2027-04-20" in a change or a target id) must never map
    # a field as a date and then reject every later row with ordinary text there.
    assert AUDIT_MAPPING["date_detection"] is False


async def test_sql_and_the_reference_fold_case_the_same_way(sql_repo):
    """The Python reference and SQLite fold ASCII letters only, so they agree on
    non-ASCII text too (PostgreSQL and Elasticsearch also fold non-ASCII letters; the
    documented difference)."""
    for text in ("ÉCOLE", "école", "FERMÉE", "fermée", "DOSSIER"):
        filters = AuditFilters(q=text)
        assert await _all_marks(sql_repo, filters) == _reference(filters), text
    assert _reference(AuditFilters(q="ÉCOLE")) == [26]
    assert _reference(AuditFilters(q="école")) == []


# --------------------------------------------------------------------------- #
# Paging and totals
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("order", ["desc", "asc"])
@pytest.mark.parametrize("limit", [1, 4, 30])
async def test_paging_never_skips_or_repeats(order, limit, es_repo, sql_repo):
    expected = _reference(AuditFilters(), order)
    assert await _all_marks(es_repo, AuditFilters(), order, limit) == expected
    assert await _all_marks(sql_repo, AuditFilters(), order, limit) == expected


async def test_rows_arriving_while_paging_do_not_shift_the_pages(es_repo, sql_repo):
    for repo in (es_repo, sql_repo):
        pred = build_predicate(AuditFilters())
        first = await repo.search_page(pred, order="desc", limit=5)
        late = {"action_type": "auth", "surface": "auth", "actor": "late", "ts": _ts(500),
                "tool_input": {"mark": 999}, "case_id": None}
        if isinstance(repo, SqlAuditRepository):
            await _seed_sql(repo, [late])
        else:
            await _seed_es(repo._es, [late])
        second = await repo.search_page(pred, order="desc", limit=5, cursor=first.hits[-1].position)
        marks = [_mark(h.doc) for h in first.hits + second.hits]
        assert marks == _reference(AuditFilters())[:10]


@pytest.mark.parametrize("order", ["desc", "asc"])
async def test_rows_arriving_while_paging_change_neither_pages_nor_totals(order, es_repo, sql_repo):
    """Both stores page inside a snapshot (a point-in-time; a SQL high-water time), so
    a row appended mid-read is not returned in either order and the total holds."""
    for repo in (es_repo, sql_repo):
        pred = build_predicate(AuditFilters())
        first = await repo.search_page(pred, order=order, limit=5)
        late = {"action_type": "auth", "surface": "auth", "actor": "late", "ts": _ts(500),
                "tool_input": {"mark": 999}, "case_id": None}
        if isinstance(repo, SqlAuditRepository):
            await _seed_sql(repo, [late])
        else:
            await _seed_es(repo._es, [late])
        marks = [_mark(h.doc) for h in first.hits]
        totals = {first.total}
        page = first
        while not page.exhausted:
            page = await repo.search_page(pred, order=order, limit=5, cursor=page.hits[-1].position)
            marks.extend(_mark(h.doc) for h in page.hits)
            totals.add(page.total)
        assert marks == _reference(AuditFilters(), order)
        assert totals == {len(CORPUS)}


async def test_run_totals_count_inside_the_page_snapshot(es_repo, sql_repo):
    """A run that keeps writing while a person pages: its total never counts rows
    "Load more" cannot reach (reviewer probe: 6 rows, page of 4, 3 more written)."""
    def run_rows(start: int, n: int) -> list[dict[str, Any]]:
        return [{"ts": _ts(start + i), "action_type": "tool_call", "surface": "investigate",
                 "actor": "investigator", "actor_type": "agent", "run_id": "run-Q",
                 "tool_input": {"mark": start + i}, "case_id": None} for i in range(n)]

    for repo in (es_repo, sql_repo):
        seed = (lambda rows, r=repo: _seed_sql(r, rows)) if isinstance(repo, SqlAuditRepository) \
            else (lambda rows, r=repo: _seed_es(r._es, rows))
        await seed(run_rows(100, 6))
        pred = build_predicate(AuditFilters(scope="agent", event="agent"))
        page = await repo.search_page(pred, limit=4)
        assert await repo.run_totals(pred, ["run-Q"], snapshot=page.start) == {"run-Q": 6}
        await seed(run_rows(200, 3))
        nxt = await repo.search_page(pred, limit=4, cursor=page.hits[-1].position)
        assert await repo.run_totals(pred, ["run-Q"], snapshot=nxt.start) == {"run-Q": 6}
        # Without the snapshot the live store counts the late rows too.
        assert await repo.run_totals(pred, ["run-Q"]) == {"run-Q": 9}


async def test_elasticsearch_totals_are_a_lower_bound_past_the_tracking_cap(es_repo):
    page = await es_repo.search_page(build_predicate(AuditFilters()), limit=3, track_total=5)
    assert (page.total, page.relation) == (5, "gte")
    assert await es_repo.count_matching(build_predicate(AuditFilters()), cap=5) == (5, "gte")
    assert await es_repo.count_matching(build_predicate(AuditFilters()), cap=len(CORPUS)) == (
        len(CORPUS), "eq")


async def test_sql_counts_exactly_and_caps_honestly(sql_repo):
    page = await sql_repo.search_page(build_predicate(AuditFilters()), limit=3)
    assert (page.total, page.relation) == (len(CORPUS), "eq")
    assert await sql_repo.count_matching(build_predicate(AuditFilters()), cap=5) == (5, "gte")
    assert await sql_repo.count_matching(build_predicate(AuditFilters()), cap=len(CORPUS)) == (
        len(CORPUS), "eq")


async def test_the_point_in_time_is_closed_when_the_read_ends(es_repo):
    es = es_repo._es
    page = await es_repo.search_page(build_predicate(AuditFilters()), limit=100)
    assert page.exhausted
    assert es._state_pits, "the read held a snapshot"
    await es_repo.close_search_cursor(page.hits[-1].position)
    assert not es._state_pits


async def test_an_expired_point_in_time_is_reported(es_repo):
    first = await es_repo.search_page(build_predicate(AuditFilters()), limit=3)
    es_repo._es._state_pits.clear()
    with pytest.raises(AuditCursorExpired):
        await es_repo.search_page(build_predicate(AuditFilters()), limit=3, cursor=first.hits[-1].position)


async def test_run_totals_count_every_row_of_a_run(es_repo, sql_repo):
    pred = build_predicate(AuditFilters(scope="agent"))
    for repo in (es_repo, sql_repo):
        assert await repo.run_totals(pred, ["run-A", "run-B", "nope"]) == {"run-A": 2, "run-B": 1}
        assert await repo.run_totals(pred, []) == {}


async def test_get_record_reads_only_audit_rows(es_repo, sql_repo):
    page = await es_repo.search_page(build_predicate(AuditFilters(actor="bob")), limit=5)
    hit = page.hits[0]
    ref = decode_audit_record_id(encode_audit_record_id("es", hit.ref, index=hit.index))
    found = await es_repo.get_record(ref)
    assert found is not None and _mark(found.doc) == 0
    # A crafted id naming another index never reads it.
    es = es_repo._es
    await es.index_doc("tlsoc-agent-config", {"secret": "x"}, doc_id="users")
    other = decode_audit_record_id(encode_audit_record_id("es", "users", index="tlsoc-agent-config"))
    assert await es_repo.get_record(other) is None
    missing = decode_audit_record_id(encode_audit_record_id("es", "nope", index=hit.index))
    assert await es_repo.get_record(missing) is None

    sql_page = await sql_repo.search_page(build_predicate(AuditFilters(actor="bob")), limit=5)
    sql_hit = sql_page.hits[0]
    got = await sql_repo.get_record(decode_audit_record_id(f"sql:{sql_hit.ref}"))
    assert got is not None and _mark(got.doc) == 0
    assert await sql_repo.get_record(decode_audit_record_id("sql:987654")) is None
    assert await sql_repo.get_record(decode_audit_record_id("mem:1")) is None


def _old_scan(rows: list[dict[str, Any]], *, actor=None, action_type=None, surface=None,
              case_id=None, source_id=None, ts_from=None, ts_to=None, limit=100):
    """The pre-Round-14 SQL ``records()`` semantics, as a reference: column filters on
    action_type, case_id and the ts strings, Python equality on the JSON fields."""
    out = []
    for doc in sorted(rows, key=lambda r: r["ts"], reverse=True):
        if action_type and doc.get("action_type") != action_type:
            continue
        if case_id and doc.get("case_id") != case_id:
            continue
        if ts_from and doc["ts"] < ts_from:
            continue
        if ts_to and doc["ts"] > ts_to:
            continue
        if actor and str(doc.get("actor", "")) != actor:
            continue
        if surface and str(doc.get("surface", "")) != surface:
            continue
        if source_id and str(doc.get("source_id", "")) != source_id:
            continue
        out.append(doc)
    return out[:limit]


@pytest.mark.parametrize(
    "kwargs",
    [
        {}, {"actor": "investigator"}, {"surface": "investigate"}, {"source_id": "src-1"},
        {"action_type": "status", "surface": "settings"}, {"case_id": "case-1", "actor": "alice"},
        {"ts_from": _ts(3), "ts_to": _ts(12), "surface": "auth"}, {"actor": "erin", "limit": 1},
        {"actor": "nobody"},
    ],
)
async def test_sql_push_down_returns_the_rows_of_the_old_scan(sql_repo, kwargs):
    got = await sql_repo.records(**kwargs)
    assert [_mark(d) for d in got] == [_mark(d) for d in _old_scan(CORPUS, **kwargs)]


async def test_sql_actor_feed_finds_a_sparse_actor_far_back(sql_repo):
    noise = [{"ts": _ts(1000 + i), "action_type": "poll", "surface": "s", "actor": "poller",
              "tool_input": {"mark": 1000 + i}, "case_id": None} for i in range(600)]
    await _seed_sql(sql_repo, noise)
    rows = await sql_repo.records_for_actor("carol", limit=5)
    assert [_mark(r) for r in rows] == [2]
    assert [_mark(r) for r in await sql_repo.records(actor="carol")] == [2]


class _ThirdPartyRepo(AuditRepository):
    """A repository with only the historical methods: the generic read serves it."""

    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows

    async def write(self, doc: AuditDoc) -> None:  # pragma: no cover - not used
        self.rows.append(doc.model_dump(mode="json"))

    async def record(self, **kwargs: Any) -> None:  # pragma: no cover - not used
        return None

    async def records_for_case(self, case_id: str, limit: int = 500) -> list[dict[str, Any]]:
        return []

    async def records(self, *, limit: int = 100, **_: Any) -> list[dict[str, Any]]:
        return sorted(self.rows, key=lambda r: r["ts"], reverse=True)[:limit]


async def test_a_third_party_repository_is_served_by_the_generic_read():
    repo = _ThirdPartyRepo([dict(r) for r in CORPUS])
    filters = AuditFilters(scope="people")
    assert await _all_marks(repo, filters) == _reference(filters)
    page = await repo.search_page(build_predicate(filters), limit=2)
    again = await repo.search_page(build_predicate(filters), limit=2)
    assert [h.ref for h in page.hits] == [h.ref for h in again.hits]  # stable numbers
    record_id = encode_audit_record_id("mem", page.hits[0].ref)
    found = await repo.get_record(decode_audit_record_id(record_id))
    assert found is not None and found.doc == page.hits[0].doc
    assert await repo.count_matching(build_predicate(filters), cap=3) == (3, "gte")


# --------------------------------------------------------------------------- #
# The record interface (SPEC §4.5.3, A4a's part)
# --------------------------------------------------------------------------- #
async def test_record_and_record_strict_store_the_new_fields(es_repo, sql_repo):
    for repo in (es_repo, sql_repo):
        await repo.record_strict(
            action_type=ActionType.AUTH_EVENT, surface="auth", actor="gil", action="auth.login",
            outcome="success", actor_type="human", actor_role="soc_manager",
            client={"ip": "198.51.100.4", "peer": "198.51.100.4", "user_agent": "UA"},
            session_ref="fedcba9876543210", request_id="req-12345678", run_id=None,
            target={"type": "user", "id": "gil", "label": "gil", "revision": 2},
            changes=[{"field": "role", "before": "analyst_tier1", "after": 7}],
        )
        await repo.record(action_type=ActionType.STATUS, surface="case", actor="hal")
        page = await repo.search_page(build_predicate(AuditFilters(actor="gil")), limit=5)
        doc = page.hits[0].doc
        assert doc["action"] == "auth.login" and doc["outcome"] == "success"
        assert doc["client"]["ip"] == "198.51.100.4" and doc["client"]["ip_source"] == "peer"
        assert doc["target"] == {"type": "user", "id": "gil", "label": "gil", "revision": 2}
        assert doc["changes"] == [{"field": "role", "before": "analyst_tier1", "after": "7", "secret": False}]
        assert "run_id" not in doc
        plain = (await repo.search_page(build_predicate(AuditFilters(actor="hal")), limit=5)).hits[0].doc
        for key in ("outcome", "actor_type", "action", "client", "target", "changes", "request_id"):
            assert key not in plain, key  # the pre-Round-14 shape is kept


async def test_a_best_effort_row_survives_an_invalid_round14_field(es_repo, sql_repo, caplog):
    """#2: an optional Round 14 field a writer got wrong is left out and named in the
    log; the row (the evidence) is still written with every other field. A strict
    append still refuses the whole row, so an audit-first caller learns of it."""
    import logging

    from pydantic import ValidationError

    bad: list[dict[str, Any]] = [
        {"run_id": "r" * 129},
        {"target": {"type": "case", "id": ""}},
        {"target": {"type": "spaceship", "id": "x"}},
        {"action": "Bad Action"},
        {"request_id": "short", "session_ref": "nothex"},
    ]
    for repo in (es_repo, sql_repo):
        for i, extra in enumerate(bad):
            actor = f"ivy{i}"
            with caplog.at_level(logging.ERROR, logger="tlsoc.stores.base"):
                caplog.clear()
                await repo.record(
                    action_type=ActionType.VERDICT, surface="investigate", actor=actor,
                    case_id="c1", result_summary="verdict TRUE_POSITIVE", actor_type="agent",
                    **extra,
                )
            hits = (await repo.search_page(build_predicate(AuditFilters(actor=actor)), limit=5)).hits
            assert len(hits) == 1, (repo, extra)
            doc = hits[0].doc
            assert doc["result_summary"] == "verdict TRUE_POSITIVE" and doc["case_id"] == "c1"
            assert doc["actor_type"] == "agent"  # the valid enrichment is kept
            for name in extra:
                assert name not in doc, (repo, name)
            message = " ".join(r.getMessage() for r in caplog.records)
            assert "WITHOUT INVALID FIELDS" in message and all(name in message for name in extra)
            assert "r" * 129 not in message  # names and kinds only, never the values
            with pytest.raises(ValidationError):
                await repo.record_strict(action_type=ActionType.VERDICT, actor=actor, **extra)
        # A field every row carried before Round 14 still refuses the row (logged).
        await repo.record(action_type="not_a_kind", actor="ivy-legacy")  # type: ignore[arg-type]
        assert not (await repo.search_page(build_predicate(AuditFilters(actor="ivy-legacy")), limit=5)).hits


# --------------------------------------------------------------------------- #
# The routes
# --------------------------------------------------------------------------- #
def _app(secrets: Secrets) -> FastAPI:
    from app.api.routes import router

    mock = MockProvider()
    overrides = {"anthropic": mock, "openai": mock, "mock": mock}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
        await state.startup(start_poller=False)
        await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
        app.state.tlsoc = state
        yield
        await state.shutdown()

    from tests.conftest import mount_moved_routers

    api = FastAPI(lifespan=lifespan)
    api.include_router(router)
    mount_moved_routers(api)
    return api


def _secrets(**extra: Any) -> Secrets:
    return Secrets(_env_file=None, es_store_enabled=False, redis_url="",
                   anthropic_api_key=None, openai_api_key=None, **extra)


@pytest.fixture(autouse=True)
def _fresh_view_recorder():
    views.RECORDER.reset()
    yield
    views.RECORDER.reset()


@pytest.fixture(params=["es", "sql"])
def api(request, tmp_path):
    if request.param == "sql":
        secrets = _secrets(state_backend="sqlite", state_db_url=f"sqlite+aiosqlite:///{tmp_path}/a.db")
    else:
        secrets = _secrets()
    with TestClient(_app(secrets)) as client:
        client.store = request.param  # type: ignore[attr-defined]
        yield client


def _state(client: TestClient) -> AppState:
    return client.app.state.tlsoc


async def _write_rows(state: AppState, rows: list[dict[str, Any]], demo: bool = False) -> None:
    repo = state.demo_audit if demo else state.control_audit
    for row in rows:
        await repo.write_strict(AuditDoc.model_validate(row))


def _seed(client: TestClient, rows: list[dict[str, Any]], *, demo: bool = False) -> None:
    client.portal.call(_write_rows, _state(client), rows, demo)


def _rows(n: int, **fields: Any) -> list[dict[str, Any]]:
    return [
        {"ts": _ts(i), "action_type": "status", "surface": "r14", "actor": f"user{i % 3}",
         "result_summary": f"row {i}", **fields}
        for i in range(n)
    ]


def _strip(record: dict[str, Any]) -> dict[str, Any]:
    """The stored row inside a read API record: the read-time projections removed.

    ``outcome`` and ``actor_type`` are projections only when the API derived them
    (``*_derived`` true, for a legacy row that recorded none). A recorded value is
    part of the stored row and stays, so it is compared with what the store holds
    (the startup runbook conversion row, for one, records both)."""
    added = {"record_id", "category", "event_label", "demo", "truncated_fields",
             "outcome_derived", "actor_type_derived"}
    if record.get("outcome_derived"):
        added.add("outcome")
    if record.get("actor_type_derived"):
        added.add("actor_type")
    return {k: v for k, v in record.items() if k not in added and v is not None}


def _stored(doc: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in doc.items() if v is not None}


@pytest.mark.parametrize(
    "params",
    [
        {},
        {"action": "status"},
        {"actor": "user1"},
        {"surface": "r14"},
        {"limit": 7},
        {"from": _ts(5), "to": _ts(20)},
        {"actor": "user2", "limit": 3},
    ],
)
def test_the_old_query_shapes_return_the_same_rows(api, params):
    _seed(api, _rows(30))
    state = _state(api)
    reference = api.portal.call(lambda: state.control_audit.records(
        actor=params.get("actor"), action_type=params.get("action"), surface=params.get("surface"),
        ts_from=params.get("from"), ts_to=params.get("to"), limit=params.get("limit", 100),
    ))
    body = api.get("/api/audit", params=params).json()
    assert [_strip(r) for r in body["records"]] == [_stored(r) for r in reference]
    assert {"records", "total"} <= set(body)


def test_old_shape_limits_are_clamped_never_refused(api):
    _seed(api, _rows(205))
    body = api.get("/api/audit", params={"limit": 500}).json()
    assert len(body["records"]) == 200 and body["next_cursor"]
    assert body["total"] >= 205 and body["total_relation"] == "eq"
    assert len(api.get("/api/audit").json()["records"]) == 100  # no scope: today's default
    assert len(api.get("/api/audit", params={"scope": "people"}).json()["records"]) == 50
    # The old route read ``int(limit or 100)``: 0 is the default, a negative is 1.
    assert len(api.get("/api/audit", params={"limit": 0}).json()["records"]) == 100
    assert len(api.get("/api/audit", params={"limit": 0, "scope": "people"}).json()["records"]) == 50
    assert len(api.get("/api/audit", params={"limit": -5}).json()["records"]) == 1
    assert len(api.get("/api/audit", params={"limit": 10**30}).json()["records"]) == 200


def test_actor_is_exact_and_action_filters_the_action_type(api):
    _seed(api, [
        {"ts": _ts(1), "action_type": "auth", "surface": "auth", "actor": "bob"},
        {"ts": _ts(2), "action_type": "auth", "surface": "auth", "actor": "bobby"},
        {"ts": _ts(3), "action_type": "status", "surface": "case", "actor": "bob"},
    ])
    rows = api.get("/api/audit", params={"actor": "bob"}).json()["records"]
    assert [r["actor"] for r in rows] == ["bob", "bob"]
    auth = api.get("/api/audit", params={"action": "auth"}).json()["records"]
    assert auth and all(r["action_type"] == "auth" for r in auth)
    contains = api.get("/api/audit", params={"actor_contains": "BOB", "scope": "all"}).json()["records"]
    assert {r["actor"] for r in contains} == {"bob", "bobby"}


def test_load_more_walks_every_row_in_both_orders(api):
    _seed(api, _rows(23))
    for order in ("desc", "asc"):
        seen: list[str] = []
        params: dict[str, Any] = {"surface": "r14", "limit": 5, "order": order, "scope": "all"}
        for _ in range(10):
            body = api.get("/api/audit", params=params).json()
            seen.extend(r["result_summary"] for r in body["records"])
            assert body["total"] == 23 and body["total_relation"] == "eq"
            if not body["next_cursor"]:
                break
            params["cursor"] = body["next_cursor"]
        expected = [f"row {i}" for i in range(23)]
        assert seen == (expected if order == "asc" else expected[::-1])


def test_a_cursor_is_bound_to_its_filters_and_signed(api):
    _seed(api, _rows(12))
    body = api.get("/api/audit", params={"surface": "r14", "limit": 5}).json()
    cursor = body["next_cursor"]
    other = api.get("/api/audit", params={"surface": "r14", "limit": 5, "q": "row", "cursor": cursor})
    assert other.status_code == 409 and other.json()["detail"]["code"] == "audit_cursor_expired"
    payload, signature = cursor.split(".")
    forged = api.get("/api/audit", params={"surface": "r14", "cursor": payload + "." + signature[::-1]})
    assert forged.status_code == 409
    garbage = api.get("/api/audit", params={"surface": "r14", "cursor": "not-a-cursor"})
    assert garbage.status_code == 400 and garbage.json()["detail"]["code"] == "audit_cursor_invalid"
    # Every cursor this server issues is ASCII: any other text is not one of ours
    # (never a 500 from the signature comparison).
    for crafted in ("abc.\u00e9", "\u00e9.def", payload + ".\u00e9" + signature[1:], "abc.d\u0000f"):
        response = api.get("/api/audit", params={"surface": "r14", "cursor": crafted})
        assert response.status_code in (400, 409), crafted
        if not crafted.isascii():
            assert response.status_code == 400 and response.json()["detail"]["code"] == "audit_cursor_invalid"


def _cursor_payload(cursor: str) -> dict[str, Any]:
    import base64

    payload = cursor.split(".", 1)[0]
    return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))


def test_the_cursor_never_carries_a_snapshot_handle(api):
    """The point-in-time id stays in the open-read registry (it grows with the shards
    the audit spans); the cursor holds the read's id and each store's sort position."""
    _seed(api, _rows(12))
    body = api.get("/api/audit", params={"surface": "r14", "limit": 5}).json()
    decoded = _cursor_payload(body["next_cursor"])
    assert "pit" not in json.dumps(decoded)
    assert set(decoded) == {"v", "sub", "f", "o", "d", "k", "tf", "tt", "p"}
    entry = decoded["p"]["control"]
    if api.store == "es":
        assert entry["held"] is True and set(entry["at"]) == {"after"}
    # The read still continues from the registry.
    more = api.get("/api/audit", params={"surface": "r14", "limit": 5, "cursor": body["next_cursor"]})
    assert more.status_code == 200 and len(more.json()["records"]) == 5


def test_an_expired_point_in_time_answers_409(api):
    if api.store != "es":
        pytest.skip("point-in-time snapshots exist on Elasticsearch only")
    _seed(api, _rows(12))
    body = api.get("/api/audit", params={"surface": "r14", "limit": 5}).json()
    _state(api).es._state_pits.clear()
    again = api.get("/api/audit", params={"surface": "r14", "limit": 5, "cursor": body["next_cursor"]})
    assert again.status_code == 409
    assert again.json()["detail"] == {
        "code": "audit_cursor_expired",
        "message": "The list was refreshed because it had been open a long time.",
    }


def test_run_totals_span_a_page_boundary(api):
    rows = [
        {"ts": _ts(i), "action_type": "tool_call", "surface": "investigate", "actor": "investigator",
         "actor_type": "agent", "run_id": "run-Z" if i < 10 else "run-Y", "case_id": "case-9"}
        for i in range(14)
    ]
    _seed(api, rows)
    body = api.get("/api/audit", params={"scope": "agent", "case_id": "case-9", "limit": 6}).json()
    shown = [r["run_id"] for r in body["records"]]
    assert shown == ["run-Y"] * 4 + ["run-Z"] * 2
    assert body["run_totals"] == {"run-Y": 4, "run-Z": 10}


def test_run_totals_never_exceed_the_rows_load_more_can_reach(api):
    """Reviewer probe: a run of 6, a page of 4, then 3 more rows of the same run are
    written. The group header can never read "6 of 9" while "Load more" has only 2."""
    def run_row(ts: str) -> dict[str, Any]:
        return {"ts": ts, "action_type": "tool_call", "surface": "investigate", "actor": "investigator",
                "actor_type": "agent", "run_id": "run-Q", "case_id": "case-q"}

    _seed(api, [run_row(_ts(i)) for i in range(6)])
    params: dict[str, Any] = {"scope": "agent", "case_id": "case-q", "limit": 4}
    first = api.get("/api/audit", params=params).json()
    assert (first["total"], first["run_totals"]) == (6, {"run-Q": 6})
    later = datetime.now(timezone.utc) + timedelta(minutes=5)
    _seed(api, [run_row((later + timedelta(seconds=i)).isoformat()) for i in range(3)])
    params["cursor"] = first["next_cursor"]
    second = api.get("/api/audit", params=params).json()
    assert len(second["records"]) == 2 and second["next_cursor"] is None
    assert (second["total"], second["run_totals"]) == (6, {"run-Q": 6})


def test_a_relative_window_is_resolved_once_per_read(api, monkeypatch):
    """``from=now-1h`` is resolved by the first page; "Load more" an hour later still
    reads the same window, so no row at its edge drops out and the total holds."""
    from app.api import routes_audit

    now = datetime.now(timezone.utc)
    _seed(api, [
        {"ts": (now - timedelta(minutes=m)).isoformat(), "action_type": "status", "surface": "r14",
         "actor": f"m{m}"}
        for m in (10, 30, 50)
    ])
    clock = [now]
    monkeypatch.setattr(routes_audit, "_now", lambda: clock[0])
    params: dict[str, Any] = {"surface": "r14", "from": "now-1h", "limit": 1, "scope": "all"}
    seen: list[str] = []
    totals: list[int] = []
    for _ in range(5):
        body = api.get("/api/audit", params=params).json()
        seen.extend(r["actor"] for r in body["records"])
        totals.append(body["total"])
        clock[0] += timedelta(minutes=45)
        if not body["next_cursor"]:
            break
        params["cursor"] = body["next_cursor"]
    assert seen == ["m10", "m30", "m50"]
    assert totals == [3, 3, 3]
    # A new read (no cursor) resolves "now-1h" against the moved clock.
    fresh = api.get("/api/audit", params={k: v for k, v in params.items() if k != "cursor"}).json()
    assert fresh["total"] == 0


def _small_registry(client: TestClient, **bounds: Any):
    """Give the app a fresh open-read registry with small bounds (and, optionally, a
    controllable clock) so the bounds are reached with a handful of reads."""
    from app.api import routes_audit

    reads = routes_audit._OpenReads(**bounds)
    routes_audit._open_reads_by_state[_state(client)] = reads
    return reads


def test_abandoned_reads_hold_a_bounded_number_of_snapshots(api):
    """Every first page that is not the last opens a point-in-time. Reads abandoned
    (a refresh, a filter change) are closed oldest first past the bound, so
    Elasticsearch's open point-in-time cap is never reached. With sign-in off every
    person is one anonymous caller, so the process bound is the one that applies.
    "Load more" on a read closed that way answers 409 and says why."""
    if api.store != "es":
        pytest.skip("point-in-time snapshots exist on Elasticsearch only")
    reads = _small_registry(api, total=4)
    _seed(api, _rows(12))
    es = _state(api).es
    baseline = len(es._state_pits)
    cursors = []
    for _ in range(10):
        body = api.get("/api/audit", params={"surface": "r14", "limit": 2}).json()
        cursors.append(body["next_cursor"])
        assert len(es._state_pits) - baseline <= 4
    assert len(es._state_pits) - baseline == 4 == len(reads)
    evicted = api.get("/api/audit", params={"surface": "r14", "limit": 2, "cursor": cursors[0]})
    assert evicted.status_code == 409
    assert evicted.json()["detail"] == {
        "code": "audit_cursor_expired",
        "message": "The list was refreshed because many newer searches were opened after it.",
    }
    # The newest read continues, and reading it to the end releases its snapshot.
    params: dict[str, Any] = {"surface": "r14", "limit": 2, "cursor": cursors[-1]}
    for _ in range(10):
        response = api.get("/api/audit", params=params)
        assert response.status_code == 200
        body = response.json()
        if not body["next_cursor"]:
            break
        params["cursor"] = body["next_cursor"]
    assert len(es._state_pits) - baseline == 3 == len(reads)


def test_the_default_bounds_leave_room_for_several_readers():
    from app.api import routes_audit

    assert routes_audit.OPEN_READS_PER_CALLER == 8
    assert routes_audit.OPEN_READS_TOTAL == 128
    assert routes_audit._OpenReads().idle_seconds == 300


def test_a_read_being_paged_outlives_a_burst_of_new_reads(api):
    """Reviewer probe: a person pages one read while new searches start in another tab
    (with sign-in off, everyone is the same caller). The read in use is never the one
    closed to make room: reads never continued past their first page go first."""
    reads = _small_registry(api, total=4)
    _seed(api, _rows(12))
    first = api.get("/api/audit", params={"surface": "r14", "limit": 2}).json()
    paged = api.get("/api/audit", params={"surface": "r14", "limit": 2, "cursor": first["next_cursor"]})
    assert paged.status_code == 200
    for _ in range(6):
        api.get("/api/audit", params={"surface": "r14", "limit": 3})
    assert len(reads) == 4
    more = api.get("/api/audit", params={"surface": "r14", "limit": 2, "cursor": paged.json()["next_cursor"]})
    assert more.status_code == 200
    assert [r["result_summary"] for r in more.json()["records"]] == ["row 7", "row 6"]


def test_idle_reads_are_forgotten_and_their_snapshot_closed(api):
    """Reviewer probe: a read nobody continues is forgotten once it has been idle for
    the point-in-time keep-alive (its snapshot has expired anyway), on the next read,
    whether or not that read has a next page; it is not kept until the bounds fill."""
    clock = [1000.0]
    reads = _small_registry(api, clock=lambda: clock[0])
    _seed(api, _rows(12))
    es = _state(api).es if api.store == "es" else None
    baseline = len(es._state_pits) if es is not None else 0
    body = api.get("/api/audit", params={"surface": "r14", "limit": 2}).json()
    assert len(reads) == 1
    clock[0] += 299
    api.get("/api/audit", params={"surface": "r14", "limit": 50})  # a read without a next page
    assert len(reads) == 1
    clock[0] += 1
    api.get("/api/audit", params={"surface": "r14", "limit": 50})
    assert len(reads) == 0
    if es is not None:
        assert len(es._state_pits) == baseline
        again = api.get("/api/audit", params={"surface": "r14", "limit": 2, "cursor": body["next_cursor"]})
        assert again.status_code == 409
        assert again.json()["detail"]["message"] == (
            "The list was refreshed because it had been open a long time."
        )


def test_ending_demo_mode_releases_the_demo_store_from_open_reads():
    """Reviewer probe: Demo on, a merged read with a next page, then Demo off. After one
    more read the registry references no Demo store (so it never keeps an ended Demo
    stack and its point-in-time snapshot alive), the Demo snapshot is closed, and the
    old cursor says Demo Mode switched."""
    from app.api import routes_audit

    with TestClient(_app(_secrets())) as client:
        state = _state(client)
        client.portal.call(state.enable_demo)
        demo_repo = state.demo_audit
        demo_es = demo_repo._es
        _seed(client, [
            {"ts": _ts(m), "action_type": "status", "surface": "r14", "actor": f"d{m}"} for m in range(6)
        ], demo=True)
        demo_pits = len(demo_es._state_pits)
        body = client.get("/api/audit", params={"scope": "all", "surface": "r14", "limit": 2}).json()
        assert body["next_cursor"]
        reads = routes_audit._open_reads(state)
        assert any(repo is demo_repo for repo in reads.held_repositories())
        assert len(demo_es._state_pits) == demo_pits + 1

        client.portal.call(state.disable_demo)
        client.get("/api/audit", params={"surface": "r14"})
        assert len(reads) == 0
        assert not any(repo is demo_repo for repo in reads.held_repositories())
        assert len(demo_es._state_pits) == demo_pits

        stale = client.get("/api/audit", params={"scope": "all", "surface": "r14", "limit": 2,
                                                 "cursor": body["next_cursor"]})
        assert stale.status_code == 409
        assert stale.json()["detail"] == {
            "code": "audit_cursor_expired",
            "message": "The list was refreshed because Demo Mode was turned on or off.",
        }


class _Repo:
    """A stand-in store for the registry's unit tests."""


def test_open_reads_bound_signed_in_callers_and_prefer_reads_never_continued():
    from app.api.routes_audit import _OpenReads

    clock = [0.0]

    def tick() -> float:
        clock[0] += 1
        return clock[0]

    reads = _OpenReads(per_caller=2, total=5, clock=tick)
    repo = _Repo()
    # Alice pages "a1" (continued), then opens two new reads: the never-continued
    # "a2" closes, not "a1", though "a1" is older.
    assert reads.hold("alice", "a1", [(repo, "p1")], run="", continued=False) == []
    assert reads.hold("alice", "a1", [(repo, "p1b")], run="", continued=True) == []
    assert reads.hold("alice", "a2", [(repo, "p2")], run="", continued=False) == []
    assert reads.hold("alice", "a3", [(repo, "p3")], run="", continued=False) == [(repo, "p2")]
    assert reads.closed_for_room("a2") and not reads.closed_for_room("a1")
    # Another signed-in caller has a bound of its own.
    assert reads.hold("bob", "b1", [(repo, "q1")], run="", continued=False) == []
    assert reads.hold("bob", "b2", [(repo, "q2")], run="", continued=False) == []
    assert len(reads) == 4
    # The anonymous caller (sign-in off) is held only by the process bound, which
    # closes the reads never continued, idle longest first, across everyone; Alice's
    # paged "a1" stays.
    assert reads.hold("", "x1", [(repo, "r1")], run="", continued=False) == []
    assert reads.hold("", "x2", [(repo, "r2")], run="", continued=False) == [(repo, "p3")]
    assert reads.hold("", "x3", [(repo, "r3")], run="", continued=False) == [(repo, "q1")]
    assert reads.hold("", "x4", [(repo, "r4")], run="", continued=False) == [(repo, "q2")]
    assert not reads.closed_for_room("a1")
    assert len(reads) == 5
    # Releasing a finished read returns what it held and is not "closed for room".
    assert reads.release("x4") == [(repo, "r4")]
    assert not reads.closed_for_room("x4")


def test_open_reads_forget_idle_stale_run_and_retired_store_reads():
    from app.api.routes_audit import _OpenReads

    clock = [0.0]
    reads = _OpenReads(idle_seconds=300, clock=lambda: clock[0])
    control, demo, retired = _Repo(), _Repo(), _Repo()
    reads.hold("", "idle", [(control, "i")], run="", continued=False)
    clock[0] = 100.0
    reads.hold("", "demo", [(control, "c"), (demo, "d")], run="run-1", continued=False)
    reads.hold("", "retired", [(retired, "r")], run="", continued=False)
    reads.hold("", "fresh", [(control, "f")], run="", continued=True)
    clock[0] = 300.0
    pruned = reads.prune(live=[control], run="")
    assert pruned == [(control, "i"), (control, "c"), (demo, "d"), (retired, "r")]
    assert len(reads) == 1 and reads.held_repositories() == [control]
    # Nothing pruned is reported as "closed for room".
    assert not any(reads.closed_for_room(c) for c in ("idle", "demo", "retired"))


def test_open_reads_never_keep_a_store_alive():
    """The registry references stores weakly: a Demo stack that ended is released at
    once, before any further read prunes its entry, and its gone snapshot is not closed
    twice."""
    import gc

    from app.api.routes_audit import _OpenReads

    reads = _OpenReads()
    demo = _Repo()
    alive = weakref.ref(demo)
    reads.hold("", "d", [(demo, "pit")], run="run-1", continued=False)
    assert reads.held_repositories() == [demo]
    del demo
    gc.collect()
    assert alive() is None
    assert reads.held_repositories() == []
    assert reads.prune(live=[], run="") == [] and len(reads) == 0


def test_open_reads_remember_a_bounded_number_of_closed_reads():
    from app.api.routes_audit import _OpenReads

    reads = _OpenReads(per_caller=1, total=10, remembered=3)
    repo = _Repo()
    for i in range(6):
        reads.hold("alice", f"c{i}", [(repo, i)], run="", continued=False)
    assert [reads.closed_for_room(f"c{i}") for i in range(6)] == [False, False, True, True, True, False]


def test_records_carry_ids_categories_and_derived_values(api):
    _seed(api, [
        {"ts": _ts(1), "action_type": "access_denied", "surface": "rbac", "actor": "t1",
         "result_summary": "denied audit:view"},
        {"ts": _ts(2), "action_type": "auth", "surface": "auth", "actor": "erin", "action": "auth.login",
         "outcome": "success", "actor_type": "human",
         "client": {"ip": "203.0.113.7", "peer": "203.0.113.7", "user_agent": "UA"}},
    ])
    rows = api.get("/api/audit", params={"scope": "people", "from": _ts(0), "to": _ts(3)}).json()["records"]
    by_actor = {r["actor"]: r for r in rows}
    legacy, new = by_actor["t1"], by_actor["erin"]
    assert legacy["outcome"] == "denied" and legacy["outcome_derived"] is True
    assert legacy["category"] == "access" and legacy["event_label"] == "Access denied"
    for absent in ("action", "client", "target", "changes", "request_id", "run_id", "session_ref"):
        assert absent not in legacy, absent
    assert new["event_label"] == "Signed in" and new["outcome_derived"] is False
    assert new["client"]["ip"] == "203.0.113.7"
    assert new["demo"] is False and new["truncated_fields"] == []
    for row in rows:
        AuditRecord.model_validate(row)
        decode_audit_record_id(row["record_id"])
        assert row["record_id"].startswith("es:" if api.store == "es" else "sql:")


def test_get_one_record_and_its_404s(api):
    _seed(api, _rows(3))
    rows = api.get("/api/audit", params={"surface": "r14"}).json()["records"]
    one = api.get(f"/api/audit/records/{rows[0]['record_id']}")
    assert one.status_code == 200 and one.json()["result_summary"] == rows[0]["result_summary"]
    for bad in ("nope", "sql:0", "es:BAD:QQ", "demo:sql:1", "mem:5", "es:tlsoc-agent-config:dXNlcnM"):
        response = api.get(f"/api/audit/records/{bad}")
        assert response.status_code == 404, bad
        assert response.json()["detail"]["code"] == "audit_record_not_found"


def test_count_is_exact_to_the_cap(api):
    _seed(api, _rows(12))
    assert api.get("/api/audit/count", params={"surface": "r14"}).json() == {"count": 12, "relation": "eq"}
    assert api.get("/api/audit/count", params={"surface": "r14", "cap": 5}).json() == {
        "count": 5, "relation": "gte"}
    assert api.get("/api/audit/count", params={"surface": "r14", "cap": 10**9}).json()["count"] == 12
    assert api.get("/api/audit/count", params={"surface": "r14", "q": "row 1"}).json()["count"] == 3


_BAD = "audit_invalid_filter"
_BAD_TIME = "audit_invalid_time"


@pytest.mark.parametrize(
    ("params", "code"),
    [
        ({"scope": "everyone"}, _BAD),
        ({"outcome": "maybe"}, _BAD),
        ({"actor_kind": "robot"}, _BAD),
        ({"event": "Auth.Login"}, _BAD),
        ({"ip": "999.1.1.1"}, _BAD),
        ({"ip": "10.0.0.0/8"}, _BAD),
        ({"q": "x" * 201}, _BAD),
        ({"q": "bad\u202etext"}, _BAD),
        ({"actor_contains": "a\nb"}, _BAD),
        ({"target": "t" * 257}, _BAD),
        ({"order": "sideways"}, _BAD),
        ({"from": "yesterday-ish"}, _BAD_TIME),
        ({"from": "now-1x"}, _BAD_TIME),
        ({"to": "2026-13"}, _BAD_TIME),
        ({"to": "9999999999999999"}, _BAD_TIME),
    ],
)
def test_invalid_new_parameters_are_refused_with_a_coded_detail(api, params, code):
    """Every bad value answers the coded 422 the Console maps to copy, on every
    route that takes it (never FastAPI's generic validation list)."""
    paths = ["/api/audit"]
    if "order" not in params:
        paths += ["/api/audit/count", "/api/audit/records/sql:1"]
    for path in paths:
        response = api.get(path, params=params)
        assert response.status_code == 422, (path, params)
        detail = response.json()["detail"]
        assert isinstance(detail, dict) and detail["code"] == code, (path, params, detail)
        assert detail["message"]


def test_old_exact_parameters_are_bounded_and_keep_their_meaning(api):
    """``actor``, ``action``, ``surface``, ``case_id`` and ``source_id`` still match
    exactly as sent (never stripped), up to 512 characters; a longer value is the coded
    422, so a view row, which records the filters, stays small."""
    long_actor = "a" * 512
    _seed(api, [
        {"ts": _ts(1), "action_type": "status", "surface": "r14", "actor": long_actor},
        {"ts": _ts(2), "action_type": "status", "surface": "r14", "actor": " padded "},
    ])
    assert [r["actor"] for r in api.get("/api/audit", params={"actor": long_actor}).json()["records"]] == [
        long_actor]
    assert [r["actor"] for r in api.get("/api/audit", params={"actor": " padded "}).json()["records"]] == [
        " padded "]
    assert api.get("/api/audit", params={"actor": "padded"}).json()["records"] == []
    views.RECORDER.reset()
    before = len(_view_rows(api))
    for name in ("actor", "action", "surface", "case_id", "source_id"):
        for path in ("/api/audit", "/api/audit/count", "/api/audit/records/sql:1"):
            response = api.get(path, params={name: "A" * 513})
            assert response.status_code == 422, (name, path)
            assert response.json()["detail"]["code"] == "audit_invalid_filter"
    # A refused read is no search: nothing is recorded, and no row ever holds the value.
    rows = _view_rows(api)
    assert len(rows) == before
    assert max(len(json.dumps(r.get("tool_input"))) for r in rows) < 2_000


def test_time_tokens_are_bounded_on_every_route(api):
    """``from`` and ``to`` are recorded as sent in each ``audit_view`` row, so each
    takes at most 64 characters once trimmed: a longer chain of date math is the coded
    ``422 audit_invalid_time`` on the list, count and record routes, and no view row
    is written for it. Every real form (date math, ISO 8601 with nanoseconds and an
    offset) stays well inside the bound."""
    _seed(api, _rows(2))
    views.RECORDER.reset()
    before = len(_view_rows(api))
    too_long = "now" + "/d" * 40
    for name in ("from", "to"):
        for path in ("/api/audit", "/api/audit/count", "/api/audit/records/sql:1"):
            response = api.get(path, params={name: too_long})
            assert response.status_code == 422, (name, path)
            assert response.json()["detail"] == {
                "code": "audit_invalid_time",
                "message": f"'{name}' must be at most 64 characters.",
            }
    rows = _view_rows(api)
    assert len(rows) == before
    assert all(too_long not in json.dumps(r.get("tool_input")) for r in rows)
    # Long real forms are read as before.
    for value in ("2026-10-28T10:00:00.123456789+05:30", "now-1d/d", "  now" + "/d" * 30 + "  "):
        assert api.get("/api/audit", params={"from": value}).status_code == 200, value


def test_time_token_bound_is_measured_after_trimming():
    from fastapi import HTTPException

    from app.api.routes_audit import TIME_MAX_CHARS, _parse_time

    now = datetime(2026, 3, 31, 15, 10, 30, tzinfo=timezone.utc)
    past_bound = "now" + "/d" * 30 + "+0s"  # 66 characters: one step past the bound
    assert len(past_bound) > TIME_MAX_CHARS
    with pytest.raises(HTTPException) as refused:
        _parse_time(past_bound, "to", now)
    assert refused.value.detail["code"] == "audit_invalid_time"
    longest = "now" + "/d" * 30  # 63 characters
    assert len(longest) <= TIME_MAX_CHARS
    assert _parse_time(" " * 100 + longest + " " * 100, "from", now) == datetime(
        2026, 3, 31, tzinfo=timezone.utc)


def test_blank_closed_vocabulary_values_mean_absent(api):
    _seed(api, _rows(3))
    body = api.get("/api/audit", params={"scope": "", "outcome": " ", "actor_kind": "", "order": ""})
    assert body.status_code == 200
    assert len(body.json()["records"]) >= 3  # no scope: the legacy read of every row


def test_the_closed_vocabularies_stay_listed_in_the_openapi_schema(api):
    schema = api.app.openapi()["paths"]["/api/audit"]["get"]["parameters"]
    by_name = {p["name"]: p["schema"] for p in schema}
    assert by_name["scope"]["anyOf"][0]["enum"] == ["people", "agent", "all"]
    assert by_name["outcome"]["anyOf"][0]["enum"] == ["success", "failure", "denied", "partial", "unknown"]
    assert by_name["actor_kind"]["anyOf"][0]["enum"] == ["human", "agent", "system", "service"]
    assert by_name["order"]["enum"] == ["desc", "asc"]


def test_old_time_forms_keep_their_elasticsearch_meaning():
    """The old route passed ``from`` and ``to`` to an Elasticsearch range, so date math
    with rounding, a year or month, and epoch milliseconds keep working, on every
    store, with Elasticsearch's semantics (rounding down for ``from``, up to the end
    of the unit for ``to``)."""
    from fastapi import HTTPException

    from app.api.routes_audit import _parse_time

    utc = timezone.utc
    now = datetime(2026, 3, 31, 15, 10, 30, 123456, tzinfo=utc)
    # Elasticsearch's ``now`` is the current millisecond, and a ``date`` field keeps
    # milliseconds: ``from`` bounds start on a whole millisecond and ``to`` bounds end
    # on the last microsecond of theirs, on every store.
    now_ms = now.replace(microsecond=123000)
    end_of = timedelta(microseconds=1)
    assert _parse_time("now", "from", now) == now_ms
    assert _parse_time("now", "to", now) == now.replace(microsecond=123999)
    assert _parse_time("now-7d", "from", now) == now_ms - timedelta(days=7)
    assert _parse_time("now-90m", "from", now) == now_ms - timedelta(minutes=90)
    assert _parse_time("now+1h", "to", now) == datetime(2026, 3, 31, 16, 10, 30, 123999, tzinfo=utc)
    assert _parse_time("now-1d/d", "from", now) == datetime(2026, 3, 30, tzinfo=utc)
    assert _parse_time("now-1d/d", "to", now) == datetime(2026, 3, 31, tzinfo=utc) - end_of
    assert _parse_time("now/M", "from", now) == datetime(2026, 3, 1, tzinfo=utc)
    assert _parse_time("now/M", "to", now) == datetime(2026, 4, 1, tzinfo=utc) - end_of
    assert _parse_time("now/w", "from", now) == datetime(2026, 3, 30, tzinfo=utc)  # Monday
    assert _parse_time("now-2H/h", "from", now) == datetime(2026, 3, 31, 13, tzinfo=utc)
    assert _parse_time("now-1y/y", "from", now) == datetime(2025, 1, 1, tzinfo=utc)
    # Calendar months clamp the day (31 March minus one month is 28 February).
    assert _parse_time("now-1M", "from", now) == datetime(2026, 2, 28, 15, 10, 30, 123000, tzinfo=utc)
    assert _parse_time("1700000000000", "from", now) == datetime(2023, 11, 14, 22, 13, 20, tzinfo=utc)
    assert _parse_time("1700000000123", "to", now) == datetime(2023, 11, 14, 22, 13, 20, 123999, tzinfo=utc)
    assert _parse_time("2026", "from", now) == datetime(2026, 1, 1, tzinfo=utc)
    # A partial ``to`` is filled as Elasticsearch fills an ``lte`` bound without
    # rounding: a missing month or day is 1 and a missing time is the end of that day.
    assert _parse_time("2026", "to", now) == datetime(2026, 1, 1, 23, 59, 59, 999999, tzinfo=utc)
    assert _parse_time("2024-02", "to", now) == datetime(2024, 2, 1, 23, 59, 59, 999999, tzinfo=utc)
    assert _parse_time("2026-10-20", "to", now) == datetime(2026, 10, 21, tzinfo=utc) - end_of
    # A time ends with the last instant of its last given part.
    assert _parse_time("2026-10-20T10:00", "to", now) == datetime(2026, 10, 20, 10, 0, 59, 999999, tzinfo=utc)
    assert _parse_time("2026-10-20T10:00:00.5Z", "to", now) == datetime(
        2026, 10, 20, 10, 0, 0, 500999, tzinfo=utc)
    assert _parse_time("2026-10-20T10:00:00.5004Z", "from", now) == datetime(
        2026, 10, 20, 10, 0, 0, 501000, tzinfo=utc)
    assert _parse_time("2026-10-20T10:00:00+02:00", "from", now) == datetime(2026, 10, 20, 8, tzinfo=utc)
    assert _parse_time(" ", "from", now) is None
    for bad in ("now-1x", "now-", "now/", "2026-13", "0000", "9999999999999999", "now-999999y", "tomorrow"):
        with pytest.raises(HTTPException) as caught:
            _parse_time(bad, "from", now)
        assert caught.value.status_code == 422, bad
        assert caught.value.detail["code"] == "audit_invalid_time", bad


def test_relative_times_and_inverted_ranges(api):
    now = datetime.now(timezone.utc)
    _seed(api, [
        {"ts": (now - timedelta(days=2)).isoformat(), "action_type": "status", "surface": "r14", "actor": "a"},
        {"ts": (now - timedelta(days=10)).isoformat(), "action_type": "status", "surface": "r14", "actor": "b"},
    ])
    week = api.get("/api/audit", params={"surface": "r14", "from": "now-7d"}).json()["records"]
    assert [r["actor"] for r in week] == ["a"]
    rounded = api.get("/api/audit", params={"surface": "r14", "from": "now-7d/d"}).json()["records"]
    assert [r["actor"] for r in rounded] == ["a"]
    millis = str(int((now - timedelta(days=7)).timestamp() * 1000))
    epoch = api.get("/api/audit", params={"surface": "r14", "from": millis}).json()["records"]
    assert [r["actor"] for r in epoch] == ["a"]
    year = api.get("/api/audit", params={"surface": "r14", "from": str(now.year - 1), "to": "now"}).json()
    assert {r["actor"] for r in year["records"]} == {"a", "b"}
    inverted = api.get("/api/audit", params={"surface": "r14", "from": "now", "to": "now-7d"}).json()
    assert inverted["records"] == [] and inverted["total"] == 0


def test_a_date_to_includes_the_whole_day(api):
    _seed(api, [
        {"ts": "2026-10-20T23:59:59.500000+00:00", "action_type": "status", "surface": "r14", "actor": "late"},
        {"ts": "2026-10-21T00:00:00+00:00", "action_type": "status", "surface": "r14", "actor": "next"},
        {"ts": "2026-10-19T23:59:59+00:00", "action_type": "status", "surface": "r14", "actor": "before"},
    ])
    rows = api.get("/api/audit", params={"surface": "r14", "from": "2026-10-20", "to": "2026-10-20"}).json()
    assert [r["actor"] for r in rows["records"]] == ["late"]
    zulu = api.get("/api/audit", params={"surface": "r14", "from": "2026-10-20T00:00:00Z"}).json()
    assert [r["actor"] for r in zulu["records"]] == ["next", "late"]


def test_retention_is_reported_for_the_scope_line(api):
    retention = api.get("/api/audit", params={"limit": 1}).json()["retention"]
    if api.store == "es":
        # The bundled in-memory Elasticsearch stand-in is the volatile fallback.
        assert retention == {"hot_days": None, "warm_days": None, "volatile": True}
    else:
        assert retention == {"hot_days": None, "warm_days": None, "volatile": False}


def test_every_value_is_returned_as_stored_text(api):
    crafted = '<script>alert("x")</script>'
    _seed(api, [{"ts": _ts(1), "action_type": "status", "surface": "r14", "actor": "a",
                 "result_summary": crafted}])
    row = api.get("/api/audit", params={"surface": "r14"}).json()["records"][0]
    assert row["result_summary"] == crafted


# --------------------------------------------------------------------------- #
# View auditing (D8)
# --------------------------------------------------------------------------- #
def _view_rows(client: TestClient) -> list[dict[str, Any]]:
    state = _state(client)
    return client.portal.call(lambda: state.control_audit.records(action_type="audit_view", limit=100))


def test_a_search_is_recorded_once_per_filter_set(api):
    _seed(api, _rows(3))
    api.get("/api/audit", params={"scope": "people", "q": "row"})
    api.get("/api/audit", params={"scope": "people", "q": "row", "limit": 10})  # coalesced
    rows = _view_rows(api)
    assert len(rows) == 1
    assert rows[0]["action"] == "audit.viewed" and rows[0]["surface"] == "audit"
    assert rows[0]["tool_input"] == {"list": {"q": "row", "scope": "people"}}
    api.get("/api/audit", params={"scope": "agent"})
    assert len(_view_rows(api)) == 2
    record_id = api.get("/api/audit", params={"surface": "r14"}).json()["records"][0]["record_id"]
    api.get(f"/api/audit/records/{record_id}")
    api.get(f"/api/audit/records/{record_id}")
    opened = [r for r in _view_rows(api) if r["tool_input"] == {"record": record_id}]
    assert len(opened) == 1


def test_opening_records_with_the_page_filters_joins_the_list_view(api):
    """J and K through 5 records under one filter set add no view row beyond the list
    read's own (D8). An open without the page's filters is recorded per record."""
    _seed(api, _rows(6))
    params = {"scope": "people", "surface": "r14"}
    records = api.get("/api/audit", params=params).json()["records"]
    for record in records[:5]:
        response = api.get(f"/api/audit/records/{record['record_id']}", params=params)
        assert response.status_code == 200
    rows = _view_rows(api)
    assert len(rows) == 1
    assert rows[0]["tool_input"] == {"list": {"scope": "people", "surface": "r14"}}
    for record in records[:3]:
        api.get(f"/api/audit/records/{record['record_id']}")
    opened = [r for r in _view_rows(api) if "record" in (r.get("tool_input") or {})]
    assert len(opened) == 3
    # A deep link that opens a record first records it under the list's filter set
    # when those filters select it, and the list read then joins that row.
    _seed(api, [{"ts": _ts(30), "action_type": "prompt", "surface": "investigate",
                 "actor": "investigator", "actor_type": "agent"}])
    agent_record = api.get("/api/audit", params={"scope": "agent"}).json()["records"][0]
    views.RECORDER.reset()  # a new five-minute window
    seen = len(_view_rows(api))
    api.get(f"/api/audit/records/{agent_record['record_id']}", params={"scope": "agent"})
    api.get("/api/audit", params={"scope": "agent"})
    new_rows = _view_rows(api)[: len(_view_rows(api)) - seen]  # newest first
    assert len(new_rows) == 1 and new_rows[0]["tool_input"] == {"list": {"scope": "agent"}}
    assert new_rows[0]["result_summary"].startswith(f"opened audit record {agent_record['record_id']}")
    # A record the sent filters do not select (a People row under ``scope=agent``) is
    # recorded by its own id: the filters never vouch for a row they do not list.
    views.RECORDER.reset()
    seen = len(_view_rows(api))
    api.get(f"/api/audit/records/{records[0]['record_id']}", params={"scope": "agent"})
    new_rows = _view_rows(api)[: len(_view_rows(api)) - seen]
    assert [r["tool_input"] for r in new_rows] == [{"record": records[0]["record_id"]}]
    assert new_rows[0]["result_summary"] == f"opened audit record {records[0]['record_id']}"


def test_a_count_with_the_page_filters_joins_the_list_view(api):
    """The export dialog's count is a search of the audit log (D8): before or after
    the list read with the same filters it adds no row of its own."""
    _seed(api, _rows(4))
    params = {"scope": "people", "surface": "r14", "q": "row"}
    api.get("/api/audit", params=params)
    assert api.get("/api/audit/count", params=params).json() == {"count": 4, "relation": "eq"}
    rows = _view_rows(api)
    assert len(rows) == 1 and rows[0]["tool_input"] == {"list": params}
    # A count with other filters is its own search.
    api.get("/api/audit/count", params={"scope": "people", "surface": "r14"})
    assert len(_view_rows(api)) == 2
    views.RECORDER.reset()
    api.get("/api/audit/count", params={"scope": "agent"})
    api.get("/api/audit", params={"scope": "agent"})
    assert len([r for r in _view_rows(api) if r["tool_input"] == {"list": {"scope": "agent"}}]) == 1


def test_a_failing_view_append_never_fails_the_read(api):
    _seed(api, _rows(2))
    state = _state(api)
    original = state.control_audit.record_strict

    async def failing(**kwargs: Any) -> None:
        if kwargs.get("action") == views.VIEW_ACTION:
            raise RuntimeError("audit store down")
        await original(**kwargs)

    state.control_audit.record_strict = failing  # type: ignore[method-assign]
    try:
        response = api.get("/api/audit", params={"surface": "r14"})
    finally:
        state.control_audit.record_strict = original  # type: ignore[method-assign]
    assert response.status_code == 200 and len(response.json()["records"]) == 2
    assert views.dropped_count() == 1
    # Not remembered as written: the next read tries again.
    api.get("/api/audit", params={"surface": "r14"})
    assert len(_view_rows(api)) == 1


def test_view_coalescing_is_bounded_and_expires():
    clock = [0.0]
    recorder = views.ViewRecorder(clock=lambda: clock[0], window=300, max_keys=2)

    class Sink:
        def __init__(self) -> None:
            self.rows: list[dict[str, Any]] = []

        async def record_strict(self, **kw: Any) -> None:
            self.rows.append(kw)

    sink = Sink()

    async def run() -> None:
        assert await recorder.note(sink, actor="a", view={"q": 1}, summary="s")
        assert not await recorder.note(sink, actor="a", view={"q": 1}, summary="s")
        assert await recorder.note(sink, actor="b", view={"q": 1}, summary="s")
        assert await recorder.note(sink, actor="a", view={"q": 2}, summary="s")  # evicts the oldest
        assert await recorder.note(sink, actor="a", view={"q": 1}, summary="s")
        clock[0] = 301
        assert await recorder.note(sink, actor="b", view={"q": 1}, summary="s")

    asyncio.run(run())
    assert len(sink.rows) == 5
    assert all(r["action_type"] == ActionType.AUDIT_VIEW for r in sink.rows)


# --------------------------------------------------------------------------- #
# Demo Mode (SPEC §3.5, D11)
# --------------------------------------------------------------------------- #
def test_demo_split_shows_real_sign_ins_beside_demo_agent_rows():
    with TestClient(_app(_secrets())) as client:
        state = _state(client)
        client.portal.call(state.enable_demo)
        _seed(client, [
            {"ts": _ts(1), "action_type": "auth", "surface": "r14", "actor": "erin",
             "action": "auth.login", "outcome": "success", "actor_type": "human"},
            {"ts": _ts(3), "action_type": "status", "surface": "r14", "actor": "admin",
             "action": "settings.updated", "actor_type": "human"},
        ])
        _seed(client, [
            {"ts": _ts(2), "action_type": "prompt", "surface": "r14", "actor": "investigator",
             "actor_type": "agent", "run_id": "demo-run"},
            {"ts": _ts(4), "action_type": "status", "surface": "r14", "actor": "demo-analyst",
             "case_id": "demo-case-1"},
        ], demo=True)

        people = client.get("/api/audit", params={"scope": "people", "surface": "r14"}).json()
        assert [(r["actor"], r["demo"]) for r in people["records"]] == [
            ("demo-analyst", True), ("admin", False), ("erin", False)]
        assert all(r["record_id"].startswith("demo:") == r["demo"] for r in people["records"])
        agent = client.get("/api/audit", params={"scope": "agent", "surface": "r14"}).json()
        assert [(r["actor"], r["demo"]) for r in agent["records"]] == [("investigator", True)]
        everything = client.get("/api/audit", params={"scope": "all", "surface": "r14"}).json()
        assert [r["actor"] for r in everything["records"]] == ["demo-analyst", "admin", "investigator", "erin"]
        assert everything["total"] == 4

        # The merged cursor pages through both stores without a gap or a repeat.
        for order, expected in (
            ("desc", ["demo-analyst", "admin", "investigator", "erin"]),
            ("asc", ["erin", "investigator", "admin", "demo-analyst"]),
        ):
            seen: list[str] = []
            params: dict[str, Any] = {"scope": "all", "surface": "r14", "limit": 1, "order": order}
            for _ in range(10):
                body = client.get("/api/audit", params=params).json()
                seen.extend(r["actor"] for r in body["records"])
                # Honest on every page, also after one store has run out.
                assert (body["total"], body["total_relation"]) == (4, "eq"), (order, seen)
                if not body["next_cursor"]:
                    break
                params["cursor"] = body["next_cursor"]
            assert seen == expected

        # A Demo record opens by its id; the count adds both stores.
        demo_id = people["records"][0]["record_id"]
        opened = client.get(f"/api/audit/records/{demo_id}")
        assert opened.status_code == 200 and opened.json()["demo"] is True
        assert client.get("/api/audit/count", params={"surface": "r14"}).json() == {"count": 4, "relation": "eq"}

        # View rows always go to the real control store.
        demo_views = client.portal.call(lambda: state.demo_audit.records(action_type="audit_view", limit=50))
        assert demo_views == []
        assert _view_rows(client)

        # A cursor from this Demo run does not continue after Demo Mode ends.
        cursor = client.get("/api/audit", params={"scope": "all", "surface": "r14", "limit": 1}).json()["next_cursor"]
        client.portal.call(state.disable_demo)
        stale = client.get("/api/audit", params={"scope": "all", "surface": "r14", "limit": 1, "cursor": cursor})
        assert stale.status_code == 409
        assert client.get(f"/api/audit/records/{demo_id}").status_code == 404
        after = client.get("/api/audit", params={"scope": "all", "surface": "r14"}).json()
        assert [r["actor"] for r in after["records"]] == ["admin", "erin"]


def test_demo_mode_never_shows_a_real_agent_row():
    """While Demo Mode is on, agent activity is Demo data (D11): a real control-store
    agent row (a source poll) is in none of All, no scope or People, nor in their
    counts, and it is back once Demo Mode ends."""
    with TestClient(_app(_secrets())) as client:
        state = _state(client)
        client.portal.call(state.enable_demo)
        _seed(client, [
            {"ts": _ts(1), "action_type": "poll", "surface": "r14", "actor": "poller", "source_id": "src-1"},
            {"ts": _ts(2), "action_type": "auth", "surface": "r14", "actor": "erin", "action": "auth.login",
             "actor_type": "human", "outcome": "success"},
        ])
        _seed(client, [{"ts": _ts(3), "action_type": "prompt", "surface": "r14", "actor": "investigator",
                        "actor_type": "agent"}], demo=True)
        expected = {
            "all": [("investigator", True), ("erin", False)],
            None: [("investigator", True), ("erin", False)],
            "people": [("erin", False)],
            "agent": [("investigator", True)],
        }
        for scope, rows in expected.items():
            params = {"surface": "r14", **({"scope": scope} if scope else {})}
            body = client.get("/api/audit", params=params).json()
            assert [(r["actor"], r["demo"]) for r in body["records"]] == rows, scope
            assert body["total"] == len(rows), scope
            assert client.get("/api/audit/count", params=params).json() == {"count": len(rows), "relation": "eq"}
        client.portal.call(state.disable_demo)
        after = client.get("/api/audit", params={"surface": "r14"}).json()["records"]
        assert [(r["actor"], r["demo"]) for r in after] == [("erin", False), ("poller", False)]


@pytest.mark.parametrize("order", ["desc", "asc"])
def test_a_merged_total_holds_after_one_store_runs_out(order):
    """Reviewer probe: Demo on, 2 control rows and 5 Demo rows, a merged read of 2 at a
    time. The total stays 7 on every page, though the control store runs out first."""
    with TestClient(_app(_secrets())) as client:
        state = _state(client)
        client.portal.call(state.enable_demo)
        _seed(client, [
            {"ts": _ts(m), "action_type": "status", "surface": "r14", "actor": f"c{m}"} for m in (1, 3)
        ])
        _seed(client, [
            {"ts": _ts(m), "action_type": "status", "surface": "r14", "actor": f"d{m}"} for m in (0, 2, 4, 5, 6)
        ], demo=True)
        ordered = sorted(["c1", "c3", "d0", "d2", "d4", "d5", "d6"], key=lambda a: int(a[1:]),
                         reverse=order == "desc")
        seen: list[str] = []
        pages: list[tuple[int, str]] = []
        params: dict[str, Any] = {"scope": "all", "surface": "r14", "limit": 2, "order": order}
        for _ in range(10):
            body = client.get("/api/audit", params=params).json()
            seen.extend(r["actor"] for r in body["records"])
            pages.append((body["total"], body["total_relation"]))
            if not body["next_cursor"]:
                break
            params["cursor"] = body["next_cursor"]
        assert seen == ordered
        assert pages == [(7, "eq")] * 4


# --------------------------------------------------------------------------- #
# The audit mapping on an upgraded Elasticsearch (es/indices.py)
# --------------------------------------------------------------------------- #
_AUDIT_TEMPLATE = f"{AUDIT_INDEX}-template"
_FIRST_AUDIT_INDEX = f"{AUDIT_INDEX}-000001"


def _pre_round14_mapping() -> dict[str, Any]:
    """The audit mapping as builds before Round 14 stored it: no structured fields and
    Elasticsearch's default date detection."""
    return {"properties": {
        k: copy.deepcopy(v) for k, v in AUDIT_MAPPING["properties"].items() if k not in AUDIT_ROUND14_FIELDS
    }}


async def _pre_round14_es() -> InMemoryESClient:
    es = InMemoryESClient()
    body = index_template_body(AUDIT_INDEX, _pre_round14_mapping(),
                               extra_settings={"index.lifecycle.name": "tlsoc-agent-audit-policy"})
    body["_meta"]["note"] = "kept"
    await es.put_index_template(_AUDIT_TEMPLATE, body)
    await es.create_index(_FIRST_AUDIT_INDEX, {"aliases": {AUDIT_INDEX: {"is_write_index": True}}})
    # Rows already written there mapped two Round 14 names dynamically.
    keyword_sub = {"keyword": {"type": "keyword", "ignore_above": 256}}
    await es.put_index_mapping(_FIRST_AUDIT_INDEX, {"properties": {
        "outcome": {"type": "text", "fields": keyword_sub},
        "client": {"properties": {"ip": {"type": "text", "fields": keyword_sub}}},
    }})
    return es


async def test_bootstrap_extends_a_pre_round14_audit_mapping_additively(caplog):
    es = await _pre_round14_es()
    assert "date_detection" not in es.index_mappings[_FIRST_AUDIT_INDEX]
    with caplog.at_level(logging.INFO, logger="tlsoc.es.indices"):
        await bootstrap_indices(es)

    template = es.templates[_AUDIT_TEMPLATE]
    mappings = template["template"]["mappings"]
    assert mappings["date_detection"] is False
    for name in AUDIT_ROUND14_FIELDS:
        assert mappings["properties"][name] == AUDIT_MAPPING["properties"][name], name
    # Everything else the stored template held is kept.
    assert template["template"]["settings"]["index.lifecycle.name"] == "tlsoc-agent-audit-policy"
    assert template["_meta"]["note"] == "kept"

    index = es.index_mappings[_FIRST_AUDIT_INDEX]
    assert index["date_detection"] is False
    # A field the index already mapped is never changed, only named in the log.
    assert index["properties"]["outcome"]["type"] == "text"
    assert index["properties"]["client"]["properties"]["ip"]["type"] == "text"
    assert index["properties"]["client"]["properties"]["ip_source"] == {"type": "keyword"}
    for name in set(AUDIT_ROUND14_FIELDS) - {"outcome", "client"}:
        assert index["properties"][name] == AUDIT_MAPPING["properties"][name], name
    assert "outcome" in caplog.text and "client.ip" in caplog.text and "_rollover" in caplog.text

    # The index the next rollover creates has the whole Round 14 mapping.
    await es.create_index(f"{AUDIT_INDEX}-000002")
    rolled = es.index_mappings[f"{AUDIT_INDEX}-000002"]
    assert rolled["date_detection"] is False and rolled["properties"]["outcome"] == {"type": "keyword"}

    # Idempotent: the next start changes nothing.
    before = copy.deepcopy((es.templates, es.index_mappings))
    await bootstrap_indices(es)
    assert (es.templates, es.index_mappings) == before


async def test_a_fresh_install_is_created_right_and_left_alone(caplog):
    es = InMemoryESClient()
    with caplog.at_level(logging.INFO, logger="tlsoc.es.indices"):
        await bootstrap_indices(es)
    index = es.index_mappings[_FIRST_AUDIT_INDEX]
    assert index == AUDIT_MAPPING and index["date_detection"] is False
    assert "Updated index template" not in caplog.text and "Extended audit index" not in caplog.text


async def test_an_audit_index_created_without_the_template_is_extended():
    """A legacy concrete ``tlsoc-agent-audit`` index (no template at the time) gains
    the mapping though the template is new."""
    es = InMemoryESClient()
    await es.create_index(AUDIT_INDEX)
    assert AUDIT_INDEX not in es.index_mappings
    await bootstrap_indices(es)
    legacy = es.index_mappings[AUDIT_INDEX]
    assert legacy["date_detection"] is False and legacy["properties"]["run_id"] == {"type": "keyword"}


async def test_a_client_that_cannot_extend_mappings_names_the_operator_step(caplog):
    es = await _pre_round14_es()
    es.get_index_mapping = None  # type: ignore[assignment,method-assign]
    before = copy.deepcopy((es.templates[_AUDIT_TEMPLATE], es.index_mappings[_FIRST_AUDIT_INDEX]))
    with caplog.at_level(logging.WARNING, logger="tlsoc.es.indices"):
        await bootstrap_indices(es)
    assert (es.templates[_AUDIT_TEMPLATE], es.index_mappings[_FIRST_AUDIT_INDEX]) == before
    assert AUDIT_UPGRADE_STEP in caplog.text
    assert "tlsoc-agent-audit.template.json" in AUDIT_UPGRADE_STEP and "_rollover" in AUDIT_UPGRADE_STEP
    # The warning prints on every start of such a deployment, after writers may already
    # have run: it asks for the step only where it is still needed, and says who needs
    # nothing, rather than asking for it "before" anything.
    warning = caplog.text
    assert "make sure this step has been done" in warning
    assert "first created by Round 14 or later needs nothing" in warning
    assert "before Round 14 writers run" not in warning
    assert "\u2014" not in warning  # no em dash


async def test_a_failing_mapping_update_never_fails_the_boot(caplog):
    es = await _pre_round14_es()
    put_template = es.put_index_template

    async def refuse_mapping(*_: Any, **__: Any) -> None:
        raise RuntimeError("security_exception: action [indices:admin/mapping/put] is unauthorized")

    async def refuse_audit_template(name: str, body: dict[str, Any]) -> None:
        if name == _AUDIT_TEMPLATE:
            raise RuntimeError("security_exception: action [indices:admin/index_template/put] is unauthorized")
        await put_template(name, body)

    es.put_index_mapping = refuse_mapping  # type: ignore[method-assign]
    es.put_index_template = refuse_audit_template  # type: ignore[method-assign]
    with caplog.at_level(logging.WARNING, logger="tlsoc.es.indices"):
        await bootstrap_indices(es)
    assert "could not be updated" in caplog.text and "could not be extended" in caplog.text
    assert f"{AUDIT_INDEX.replace('audit', 'cases')}-template" in es.templates  # the rest of the boot ran


async def test_the_in_memory_store_refuses_a_mapping_type_change():
    """Elasticsearch never changes a field's type in place; nor does the stand-in, so
    the additive extension is tested against the real rule."""
    es = await _pre_round14_es()
    with pytest.raises(RuntimeError, match="cannot be changed"):
        await es.put_index_mapping(_FIRST_AUDIT_INDEX, {"properties": {"outcome": {"type": "keyword"}}})
    with pytest.raises(RuntimeError, match="index_not_found"):
        await es.put_index_mapping("tlsoc-agent-nope", {"date_detection": False})


def test_missing_properties_adds_and_never_changes():
    desired = {"a": {"type": "keyword"}, "o": {"properties": {"x": {"type": "ip"}, "y": {"type": "keyword"}}},
               "c": {"type": "object", "enabled": False}}
    existing = {"a": {"type": "text"}, "o": {"properties": {"x": {"type": "text"}}},
                "c": {"properties": {"field": {"type": "text"}}}}
    missing, kept = missing_properties(desired, existing)
    assert missing == {"o": {"properties": {"y": {"type": "keyword"}}}}
    assert sorted(kept) == ["a", "c", "o.x"]
    assert missing_properties(desired, {}) == (desired, [])


# --------------------------------------------------------------------------- #
# Gate
# --------------------------------------------------------------------------- #
def test_every_audit_route_needs_audit_view():
    from fastapi import Depends

    from app.api.deps import require_auth
    from app.api.routes import router

    mock = MockProvider()
    secrets = _secrets(auth_enabled=True, auth_jwt_secret="audit-read")

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(),
                                provider_overrides={"anthropic": mock, "openai": mock, "mock": mock})
        await state.startup(start_poller=False)
        prefs = state.prefs.model_copy(deep=True)
        prefs.setup_complete = True
        prefs.rbac.enabled = True
        await state.update_prefs(prefs)
        app.state.tlsoc = state
        yield
        await state.shutdown()

    from tests.conftest import mount_moved_routers

    api = FastAPI(lifespan=lifespan)
    api.include_router(router, dependencies=[Depends(require_auth)])
    mount_moved_routers(api, dependencies=[Depends(require_auth)])
    with TestClient(api) as c:
        paths = ["/api/audit", "/api/audit/count", "/api/audit/records/sql:1"]
        for path in paths:
            assert c.get(path).status_code == 401, path
            assert c.get(path, params={"scope": "bogus"}).status_code == 401, path
        c.post("/api/auth/login", json={"username": "Admin", "password": "Admin@123"})
        c.post("/api/users", json={"username": "t1", "password": "t1password", "role": "analyst_tier1"})
        c.post("/api/users", json={"username": "aud", "password": "audpassword", "role": "auditor"})
        c.post("/api/auth/logout")
        c.post("/api/auth/login", json={"username": "t1", "password": "t1password"})
        for path in paths:
            assert c.get(path).status_code == 403, path
            # The gate runs before the parameters are read: a caller without the
            # grant learns nothing about the filter grammar.
            for bad in ({"scope": "bogus"}, {"from": "tomorrow"}, {"actor": "x" * 600},
                        {"cursor": "abc.\u00e9"}, {"limit": "many"}, {"cap": "lots"}):
                assert c.get(path, params=bad).status_code == 403, (path, bad)
        denied = c.portal.call(lambda: c.app.state.tlsoc.control_audit.records(action_type="access_denied"))
        assert denied and all(r["actor"] == "t1" for r in denied[:3])
        c.post("/api/auth/logout")
        c.post("/api/auth/login", json={"username": "aud", "password": "audpassword"})
        assert c.get("/api/audit").status_code == 200
        assert c.get("/api/audit/count").status_code == 200
        assert c.get("/api/audit/records/sql:1").status_code == 404
        views_rows = c.portal.call(lambda: c.app.state.tlsoc.control_audit.records(action_type="audit_view"))
        assert views_rows and views_rows[0]["actor"] == "aud"


def test_the_audit_router_is_its_own_module():
    from app.api import routes_audit, routes_search

    paths = {r.path for r in routes_audit.router.routes}
    assert paths == {"/api/audit", "/api/audit/count", "/api/audit/records/{record_id}"}
    assert not [r for r in routes_search.router.routes if "audit" in r.path]
    assert AUDIT_INDEX == "tlsoc-agent-audit"
