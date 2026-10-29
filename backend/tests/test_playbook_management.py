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
    assert _grants(routes_mod.playbooks_coverage) == {("runbooks", "read")}
    assert _grants(routes_mod.playbook_selection) == {("cases", "read"), ("runbooks", "read")}
    for write in (routes_mod.playbooks_create, routes_mod.playbooks_reload, routes_mod.playbook_update):
        assert _grants(write) == {("runbooks", "manage")}
    assert _grants(routes_mod.playbooks_dry_run) == {("runbooks", "read")}


def test_routes_no_longer_import_the_retired_registry() -> None:
    source = inspect.getsource(routes_mod)
    assert "playbooks.registry" not in source
    assert "state.playbooks" not in source
