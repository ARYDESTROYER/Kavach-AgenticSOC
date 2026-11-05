"""The retired procedure routes for one release (Round 14 SPEC §4.10.16, D44, E14).

Playbooks are now runbooks. The old reads stay as ALIASES over the runbook library in
the old response shape (each Published runbook mapped to the old fields, ``content``
and ``body`` exported as Markdown) with ``Deprecation`` and ``Link`` headers, behind
``runbooks:read``. Every old write answers ``410 runbooks_moved``: an old-shape write
cannot be honoured without making unreviewed text live (#9). Nothing here reads the
retired registry or reaches ``decide()`` (#3).
"""

from __future__ import annotations

import inspect
from functools import partial

import pytest

from app.api import routes as routes_mod
from app.engine import runbook_runs as R
from app.engine.runbook_model import load_builtin_runbooks
from app.models import Case, Entity, LookupResult
from app.constants import CaseStatus, EntityType, SourceSurface

MOVED = {"code": "runbooks_moved", "detail": "Playbooks are now runbooks.", "see": "/api/runbooks"}


@pytest.fixture(autouse=True)
def _no_lookups(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_execute(state, case, template, *, ran_by, now=None, events=None, load_events=True):
        return LookupResult(tool=template.tool, status="empty", count=0, ran_at="2026-10-28T10:00:00Z",
                            ran_by=ran_by)

    monkeypatch.setattr(R, "execute_lookup", fake_execute)


def _grants(endpoint) -> set[tuple[str, str]]:
    """Every ``require_permission(resource, action)`` dependency of a route."""
    out: set[tuple[str, str]] = set()
    for param in inspect.signature(endpoint).parameters.values():
        dependency = getattr(param.default, "dependency", None)
        closure = getattr(dependency, "__closure__", None) or ()
        names = getattr(getattr(dependency, "__code__", None), "co_freevars", ())
        values = dict(zip(names, (cell.cell_contents for cell in closure)))
        if "resource" in values and "action" in values:
            out.add((values["resource"], values["action"]))
    return out


def _deprecated(response) -> None:
    assert response.headers["Deprecation"] == "true"
    assert response.headers["Link"] == '</api/runbooks>; rel="successor-version"'


def test_list_alias_answers_the_old_shape_from_the_runbook_library(client) -> None:
    r = client.get("/api/playbooks")
    assert r.status_code == 200, r.text
    _deprecated(r)
    body = r.json()
    assert body["enabled"] is True
    assert body["count"] == len(load_builtin_runbooks()) == len(body["playbooks"])
    item = next(p for p in body["playbooks"] if p["id"] == "brute-force-password-spray")
    assert {"id", "name", "version", "description", "priority", "match", "suggested_tools", "rag_queries",
            "escalate_if", "suggested_verdict_bias", "source_type", "protected", "editable",
            "file_name"} <= set(item)
    assert item["source_type"] == "bundled" and item["protected"] is True and item["editable"] is False
    assert "mail_auth" in item["match"]["rule_ids"]
    assert "content" not in item and "source_path" not in item


def test_detail_alias_exports_markdown_and_maps_a_retired_id(client) -> None:
    r = client.get("/api/playbooks/brute_force_login")
    assert r.status_code == 200, r.text
    _deprecated(r)
    item = r.json()
    assert item["id"] == "brute-force-password-spray"
    assert item["content"].startswith("---\n")
    assert not item["body"].startswith("---") and item["body"].strip()
    direct = client.get("/api/playbooks/brute-force-password-spray").json()
    assert direct["content"] == item["content"]
    # An unknown id keeps the old error shape (a string ``detail``), so an old client's
    # error handling still works; the headers still name the successor.
    missing = client.get("/api/playbooks/missing")
    assert missing.status_code == 404 and missing.json() == {"detail": "playbook not found"}
    _deprecated(missing)


@pytest.mark.parametrize("method,path,body", [
    ("post", "/api/playbooks", {"id": "x", "content": "---\nid: x\n---\n"}),
    ("post", "/api/playbooks/reload", None),
    ("post", "/api/playbooks/dry-run", {"rule_ids": ["mail_auth"]}),
    ("put", "/api/playbooks/brute_force_login", {"content": "anything"}),
])
def test_every_old_write_answers_410_runbooks_moved(client, method: str, path: str, body) -> None:
    kwargs = {"json": body} if body is not None else {}
    r = getattr(client, method)(path, **kwargs)
    assert r.status_code == 410
    assert r.json() == MOVED
    _deprecated(r)


def test_no_route_is_invented_for_a_write_that_never_existed(client) -> None:
    """The procedure API never had a DELETE; it still answers 405, as before, and the
    retired routes add nothing to the API surface beyond the old ones."""
    assert client.delete("/api/playbooks/brute_force_login").status_code == 405
    methods = {
        (method, route.path)
        for route in client.app.routes
        if str(getattr(route, "path", "")).startswith("/api/playbooks")
        for method in (getattr(route, "methods", None) or ())
    }
    assert methods == {
        ("GET", "/api/playbooks"), ("POST", "/api/playbooks"), ("POST", "/api/playbooks/reload"),
        ("POST", "/api/playbooks/dry-run"), ("GET", "/api/playbooks/coverage"),
        ("GET", "/api/playbooks/selection/{case_id}"), ("GET", "/api/playbooks/{playbook_id}"),
        ("PUT", "/api/playbooks/{playbook_id}"),
    }


def test_coverage_alias_matches_cases_without_the_fallback(client) -> None:
    state = client.app.state.tlsoc
    for cid, rule in (("cov-1", "mail_auth"), ("cov-2", "nothing_matches_this")):
        client.portal.call(state.cases.save, Case(
            case_id=cid, cluster_signature=cid, source_surface=SourceSurface.INVESTIGATE, rule_ids=[rule],
            entity=Entity(type=EntityType.IP, value="198.51.100.1"), status=CaseStatus.NEEDS_HUMAN))
    r = client.get("/api/playbooks/coverage")
    assert r.status_code == 200
    _deprecated(r)
    body = r.json()
    assert body["scanned_cases"] == 2 and body["covered_cases"] == 1 and body["coverage_percent"] == 50.0
    assert body["selected_playbooks"] == [{"playbook_id": "brute-force-password-spray", "case_count": 1}]
    assert body["unmatched_rule_families"] == [{"rule_id": "nothing_matches_this", "case_count": 1}]


def test_coverage_alias_needs_cases_read_as_well_as_runbooks_read() -> None:
    """The figures are derived from cases (SPEC §4.10.15): a role that holds
    ``runbooks:read`` without ``cases:read`` gets none of them, as from the successor
    ``GET /api/runbooks/metrics``."""
    from fastapi.testclient import TestClient

    from tests.test_runbook_library_api import add_user, auth_secrets, login, make_app

    holder: dict = {}
    rbac = {"denies": {"auditor": {"cases": ["read"]}}}
    with TestClient(make_app(holder, secrets=auth_secrets(), auth=True, rbac=rbac)) as api:
        add_user(api, "auditor", "auditor")
        add_user(api, "tier1", "analyst_tier1")
        login(api, "auditor", "user-pass-12345")
        assert api.get("/api/runbooks").status_code == 200  # it still reads runbooks
        assert api.get("/api/playbooks/coverage").status_code == 403
        assert api.get("/api/runbooks/metrics").status_code == 403
        login(api, "tier1", "user-pass-12345")
        assert api.get("/api/playbooks/coverage").status_code == 200


def test_coverage_alias_is_hidden_while_row_level_scope_applies(client, monkeypatch) -> None:
    """Row-level scope (D16): case aggregates are refused, with the same ``409`` the
    successor answers, rather than counted over cases the caller may not read."""
    import app.engine.chat_starters as starters

    state = client.app.state.tlsoc
    client.portal.call(state.cases.save, Case(
        case_id="cov-s", cluster_signature="cov-s", source_surface=SourceSurface.INVESTIGATE,
        rule_ids=["nothing_matches_this"], entity=Entity(type=EntityType.IP, value="198.51.100.9"),
        status=CaseStatus.NEEDS_HUMAN))
    monkeypatch.setattr(starters, "object_scoped", lambda _state, _role: True)
    r = client.get("/api/playbooks/coverage")
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "runbook_scope_unsupported"
    assert "nothing_matches_this" not in r.text
    _deprecated(r)


def test_coverage_alias_reads_the_newest_cases_up_to_the_metrics_bound(client, monkeypatch) -> None:
    """The alias reads through the bounded case scan (never offset paging, which a
    large Elasticsearch store refuses past its result window), newest first, and stops
    at the bound the runbook metrics use; ``truncated`` then marks lower bounds."""
    from datetime import UTC, datetime, timedelta

    import app.engine.runbook_catalog as catalog

    state = client.app.state.tlsoc
    now = datetime.now(UTC)
    for index, rule in enumerate(("mail_auth", "nothing_matches_this", "old_rule")):
        client.portal.call(state.cases.save, Case(
            case_id=f"cov-b{index}", cluster_signature=f"cov-b{index}",
            source_surface=SourceSurface.INVESTIGATE, rule_ids=[rule],
            entity=Entity(type=EntityType.IP, value="198.51.100.3"), status=CaseStatus.NEEDS_HUMAN,
            created_at=(now - timedelta(hours=index + 1)).isoformat()))

    async def no_offset_paging(*_args, **_kwargs):
        raise AssertionError("the coverage alias must not page by offset")

    monkeypatch.setattr(state.cases, "list", no_offset_paging)
    full = client.get("/api/playbooks/coverage").json()
    assert (full["scanned_cases"], full["scan_limit"], full["truncated"]) == (3, catalog.METRICS_MAX_CASES, False)
    monkeypatch.setattr(catalog, "METRICS_MAX_CASES", 2)
    body = client.get("/api/playbooks/coverage").json()
    assert (body["scanned_cases"], body["covered_cases"], body["scan_limit"], body["truncated"]) == (2, 1, 2, True)
    # The two newest cases are the ones read; the oldest rule is never seen.
    assert body["unmatched_rule_families"] == [{"rule_id": "nothing_matches_this", "case_count": 1}]


@pytest.mark.parametrize("stored,page_size,truncated,pages_read", [
    (3, 500, False, None),  # exactly the bound, on one page
    (3, 1, False, None),    # exactly the bound, one case per page
    (4, 500, True, None),   # one case beyond the bound
    (5, 1, True, 4),        # the read stops on the page that shows a case past the bound
])
def test_coverage_alias_marks_truncation_only_when_a_case_lies_beyond_the_bound(
    client, monkeypatch, stored: int, page_size: int, truncated: bool, pages_read: int | None,
) -> None:
    """A store holding exactly the bound is read whole, so its figures are exact and
    ``truncated`` is false, as from ``runbook_catalog.cases_in_window``; one case more
    makes them lower bounds. Reaching the bound is not the same as passing it."""
    from datetime import UTC, datetime, timedelta

    import app.engine.case_aggregate as aggregate
    import app.engine.runbook_catalog as catalog

    state = client.app.state.tlsoc
    now = datetime.now(UTC)
    for index in range(stored):
        client.portal.call(state.cases.save, Case(
            case_id=f"cov-x{index}", cluster_signature=f"cov-x{index}",
            source_surface=SourceSurface.INVESTIGATE, rule_ids=["mail_auth"],
            entity=Entity(type=EntityType.IP, value="198.51.100.4"), status=CaseStatus.NEEDS_HUMAN,
            created_at=(now - timedelta(minutes=index + 1)).isoformat()))
    real_scan = aggregate.scan_cases
    pages: list[int] = []

    async def scan_in_pages(store, consume, **kwargs):
        outcome = await real_scan(store, consume, page_size=page_size, **kwargs)
        pages.append(outcome.pages)
        return outcome

    monkeypatch.setattr(aggregate, "scan_cases", scan_in_pages)
    monkeypatch.setattr(catalog, "METRICS_MAX_CASES", 3)
    r = client.get("/api/playbooks/coverage")
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["scanned_cases"], body["covered_cases"], body["scan_limit"], body["truncated"]) == (
        3, 3, 3, truncated)
    assert len(pages) == 1
    if pages_read is not None:
        assert pages == [pages_read]


def test_coverage_alias_answers_503_when_the_case_store_cannot_be_read(client, monkeypatch) -> None:
    """A case store that cannot answer is never read as "no cases": the alias says so,
    with the deprecation headers, instead of a zero coverage."""
    state = client.app.state.tlsoc

    async def unreadable(*_args, **_kwargs):
        raise RuntimeError("injected case store outage")

    monkeypatch.setattr(state.cases, "scan_page", unreadable)
    r = client.get("/api/playbooks/coverage")
    assert r.status_code == 503
    assert r.json()["detail"]["code"] == "case_store_unavailable"
    assert "injected" not in r.text
    _deprecated(r)


def test_selection_alias_reports_the_attached_runbook(client) -> None:
    state = client.app.state.tlsoc
    case = Case(case_id="sel-1", cluster_signature="sel-1", source_surface=SourceSurface.INVESTIGATE,
                rule_ids=["mail_auth"], entity=Entity(type=EntityType.IP, value="198.51.100.2"),
                status=CaseStatus.NEEDS_HUMAN)
    client.portal.call(state.cases.save, case)
    empty = client.get("/api/playbooks/selection/sel-1").json()
    assert empty == {"case_id": "sel-1", "playbook_id": "", "reason": ""}
    client.portal.call(partial(R.reevaluate_case, state, case, trigger="test"))
    r = client.get("/api/playbooks/selection/sel-1")
    _deprecated(r)
    body = r.json()
    assert body["playbook_id"] == "brute-force-password-spray"
    assert "mail_auth" in body["reason"]


def test_alias_and_retired_route_grants() -> None:
    assert _grants(routes_mod.playbooks) == {("runbooks", "read")}
    assert _grants(routes_mod.playbook_detail) == {("runbooks", "read")}
    assert _grants(routes_mod.playbooks_coverage) == {("cases", "read"), ("runbooks", "read")}
    assert _grants(routes_mod.playbook_selection) == {("cases", "read"), ("runbooks", "read")}
    for write in (routes_mod.playbooks_create, routes_mod.playbooks_reload, routes_mod.playbook_update):
        assert _grants(write) == {("runbooks", "manage")}
    assert _grants(routes_mod.playbooks_dry_run) == {("runbooks", "read")}


def test_routes_no_longer_import_the_retired_registry() -> None:
    source = inspect.getsource(routes_mod)
    assert "playbooks.registry" not in source
    assert "state.playbooks" not in source
