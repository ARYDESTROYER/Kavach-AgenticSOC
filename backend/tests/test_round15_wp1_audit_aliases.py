"""Round 15 WP1: the legacy event families still find the new case-work rows (SPEC D7.4).

Human case work kept its ``action_type`` (``status``, ``collab``, ``feedback``) and
gained a structured ``case.*`` action. A row that carries an action no longer matches
the legacy branch of its family (``action`` absent), so ``audit.query.event_predicate``
maps each family onto its new actions through one alias table. The Elasticsearch, SQL
and Python compilers all interpret the same predicate tree; this test holds one
old-shape and one new-shape row per family on each store (the fake Elasticsearch,
SQLite, and the third-party fallback over the Python reference) and checks the family
filter finds both, and nothing else.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.audit.audit_log import AuditLogger
from app.audit.query import EVENT_FAMILY_ALIASES, AuditFilters, build_predicate, event_predicate, matches
from app.constants import CASE_COLLAB_AUDIT_ACTIONS, CASE_GRADED_AUDIT_ACTION, CASE_LIFECYCLE_AUDIT_ACTIONS
from app.es.fake import InMemoryESClient
from app.es.indices import bootstrap_indices
from app.stores.sql import SqlAuditRepository, build_async_engine, create_all
from tests.test_audit_read_api import _ThirdPartyRepo, _seed_es, _seed_sql

#: (mark, row). Marks 0 to 5 are the six family rows; 6 to 8 must match no family.
_ROWS: list[tuple[int, dict[str, Any]]] = [
    (0, {"action_type": "status", "surface": "case", "actor": "ann",
         "result_summary": "action=close status open→closed disposition=none"}),
    (1, {"action_type": "status", "surface": "case", "actor": "ann", "action": "case.closed",
         "actor_type": "human", "outcome": "success",
         "result_summary": "action=close status open→closed disposition=none"}),
    (2, {"action_type": "collab", "surface": "case", "actor": "ann", "result_summary": "comment added"}),
    (3, {"action_type": "collab", "surface": "case", "actor": "ann", "action": "case.commented",
         "actor_type": "human", "outcome": "success", "result_summary": "comment added"}),
    (4, {"action_type": "feedback", "surface": "case", "actor": "ann",
         "result_summary": "assessment=agree outcome=unknown accuracy=0.0"}),
    (5, {"action_type": "feedback", "surface": "case", "actor": "ann", "action": "case.graded",
         "actor_type": "human", "outcome": "success",
         "result_summary": "assessment=agree outcome=unknown accuracy=0.0"}),
    # Other case actions: no family claims them.
    (6, {"action_type": "runbook", "surface": "case", "actor": "ann", "action": "case.closed_with_open_steps",
         "actor_type": "human", "outcome": "success"}),
    (7, {"action_type": "context", "surface": "case", "actor": "system", "action": "case.review_requested",
         "actor_type": "system", "outcome": "success"}),
    (8, {"action_type": "thread_post", "surface": "case", "actor": "ann"}),
]

_FAMILIES = {"status": [0, 1], "collab": [2, 3], "feedback": [4, 5]}


def _corpus() -> list[dict[str, Any]]:
    out = []
    for mark, row in _ROWS:
        doc = dict(row)
        doc["ts"] = f"2026-11-20T10:00:{mark:02d}.000000+00:00"
        doc["case_id"] = f"case-{mark}"
        doc["tool_input"] = {"mark": mark}
        out.append(doc)
    return out


def _mark(doc: dict[str, Any]) -> int:
    return int((doc.get("tool_input") or {}).get("mark"))


async def _marks(repo: Any, event: str) -> list[int]:
    page = await repo.search_page(build_predicate(AuditFilters(event=event)), order="asc", limit=50)
    return sorted(_mark(h.doc) for h in page.hits)


def test_the_alias_table_names_every_new_case_work_action_once() -> None:
    assert EVENT_FAMILY_ALIASES["status"] == tuple(sorted(CASE_LIFECYCLE_AUDIT_ACTIONS.values()))
    assert EVENT_FAMILY_ALIASES["collab"] == tuple(sorted(CASE_COLLAB_AUDIT_ACTIONS))
    assert EVENT_FAMILY_ALIASES["feedback"] == (CASE_GRADED_AUDIT_ACTION,)
    named = [a for actions in EVENT_FAMILY_ALIASES.values() for a in actions]
    assert len(named) == len(set(named)) == 15


@pytest.mark.parametrize("family, expected", sorted(_FAMILIES.items()))
def test_the_reference_finds_both_shapes(family: str, expected: list[int]) -> None:
    pred = event_predicate(family)
    assert sorted(_mark(r) for r in _corpus() if matches(pred, r)) == expected


@pytest.mark.parametrize("family, expected", sorted(_FAMILIES.items()))
async def test_elasticsearch_finds_both_shapes(family: str, expected: list[int]) -> None:
    es = InMemoryESClient()
    await bootstrap_indices(es)
    await _seed_es(es, _corpus())
    assert await _marks(AuditLogger(es), family) == expected


@pytest.mark.parametrize("family, expected", sorted(_FAMILIES.items()))
async def test_sql_finds_both_shapes(family: str, expected: list[int]) -> None:
    engine = build_async_engine("sqlite+aiosqlite:///:memory:")
    await create_all(engine)
    repo = SqlAuditRepository(engine)
    try:
        await _seed_sql(repo, _corpus())
        assert await _marks(repo, family) == expected
    finally:
        await engine.dispose()


@pytest.mark.parametrize("family, expected", sorted(_FAMILIES.items()))
async def test_the_third_party_fallback_finds_both_shapes(family: str, expected: list[int]) -> None:
    assert await _marks(_ThirdPartyRepo(_corpus()), family) == expected


async def test_an_exact_new_action_still_finds_only_its_own_rows() -> None:
    es = InMemoryESClient()
    await bootstrap_indices(es)
    await _seed_es(es, _corpus())
    assert await _marks(AuditLogger(es), "case.closed") == [1]
    # The case family (the prefix) finds every structured case row, old rows not.
    assert await _marks(AuditLogger(es), "case") == [1, 3, 5, 6, 7]
