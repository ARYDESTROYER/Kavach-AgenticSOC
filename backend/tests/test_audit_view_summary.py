"""The summary of an "Audit log viewed" row is a plain sentence (Round 14 SPEC §4.5.2,
§3.1): the inspector shows it as the record's header sentence and the list as its
Summary, as stored (AU-7), so it names the view in the Console's words and never
dumps internal filter keys. Values a caller typed stay plain quoted text, bounded."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import pytest

from app.api.routes_audit import _filters
from app.audit import views
from app.models import AUDIT_TEXT_WRITE_CAP

NOW = datetime(2026, 11, 4, 12, 30, tzinfo=timezone.utc)


def _f(**given: Any):
    params: dict[str, Any] = dict(
        scope=None, q=None, action=None, event=None, actor=None, actor_contains=None,
        actor_kind=None, outcome=None, surface=None, case_id=None, source_id=None,
        target=None, ip=None, from_=None, to=None,
    )
    params.update(given)
    return _filters(now=NOW, **params)


@pytest.mark.parametrize(
    ("given", "order", "expected"),
    [
        ({"scope": "people", "from_": "now-7d"}, "desc",
         "Searched the audit log: People and settings, last 7 days."),
        ({"scope": "agent", "from_": "now-90d", "q": "login"}, "desc",
         'Searched the audit log: Agent activity, last 90 days, matching "login".'),
        ({"scope": "all", "from_": "now-24h", "outcome": "failure", "actor_kind": "agent"}, "asc",
         "Searched the audit log: all scopes, last 24 hours, made by the AI agent, outcome Failed, "
         "oldest first."),
        ({"from_": "now-1h", "outcome": "unknown"}, "desc",
         "Searched the audit log: all scopes, last hour, outcome Not recorded."),
        ({}, "desc", "Searched the audit log: all scopes, all time."),
        ({"scope": "people", "from_": "2026-10-18T15:10:00Z", "to": "2026-10-25T15:09:59Z"}, "desc",
         "Searched the audit log: People and settings, 18 Oct 2026 15:10 UTC to 25 Oct 2026 15:09:59 UTC."),
        ({"scope": "people", "from_": "now-1d/d"}, "desc",
         "Searched the audit log: People and settings, since 3 Nov 2026 00:00 UTC."),
        ({"scope": "people", "to": "2026-10-01"}, "desc",
         "Searched the audit log: People and settings, until 1 Oct 2026 23:59:59 UTC."),
        ({"event": "access", "actor": "trao", "case_id": "case-0001", "ip": "203.0.113.7"}, "desc",
         'Searched the audit log: all scopes, all time, Access and identity events, actor "trao", '
         'case "case-0001", client IP 203.0.113.7.'),
        ({"event": "auth.login_failed", "actor_contains": "adm", "surface": "auth"}, "desc",
         'Searched the audit log: all scopes, all time, event Sign-in failed, actor containing "adm", '
         'surface "auth".'),
        ({"event": "runbook", "action": "status", "source_id": "wazuh-1", "target": "user:bob"}, "desc",
         'Searched the audit log: all scopes, all time, Runbook events, action type "status", '
         'source "wazuh-1", target "user:bob".'),
    ],
)
def test_a_view_is_worded_from_its_known_filters(given: dict[str, Any], order: str, expected: str) -> None:
    assert views.view_summary(_f(**given), order) == expected


def test_no_internal_key_name_reaches_the_summary() -> None:
    text = views.view_summary(_f(scope="people", from_="now-7d", to="now", actor_kind="human"), "asc")
    for key in ("from_token", "to_token", "scope=", "actor_kind", "order=", "="):
        assert key not in text
    assert text == "Searched the audit log: People and settings, last 7 days, made by people, oldest first."


def test_an_event_the_table_does_not_know_is_shown_as_quoted_text() -> None:
    assert views.event_phrase("zzz.yyy") == 'event "zzz.yyy"'
    assert views.event_phrase("zzz") == 'event "zzz"'
    # A known family with an unlisted verb reads like the list's own label for it.
    assert views.event_phrase("runbook.frobbed") == "event Runbook frobbed"


def test_a_crafted_value_stays_one_line_of_plain_bounded_text() -> None:
    # The exact-match parameters are matched as sent, so they may carry anything.
    crafted = 'bob", outcome Success\n‮evil\\'
    text = views.view_summary(_f(actor=crafted), "desc")
    assert text == 'Searched the audit log: all scopes, all time, actor "bob\\", outcome Success��evil\\\\".'
    assert "\n" not in text and "‮" not in text
    long = views.view_summary(_f(actor="a" * 500, surface="s" * 500, case_id="c" * 500,
                                 source_id="d" * 500, action="b" * 500, q="q" * 200), "desc")
    assert len(long) <= AUDIT_TEXT_WRITE_CAP
    assert '"' + "a" * (views.VALUE_MAX_CHARS - 1) + "…" + '"' in long


def test_the_summary_never_exceeds_the_write_cap() -> None:
    text = views.view_summary(_f(
        q="q" * 200, actor="a" * 512, actor_contains="e" * 128, surface="s" * 512,
        case_id="c" * 512, source_id="d" * 512, target="t" * 256, action="b" * 512,
        event="auth.login", outcome="denied", actor_kind="service", ip="2001:db8::1",
        from_="2026-01-01", to="2026-02-01",
    ), "asc")
    assert len(text) == AUDIT_TEXT_WRITE_CAP and text.endswith("…")


def test_an_opened_record_names_the_record_and_the_view_it_was_opened_from() -> None:
    assert views.record_open_summary("sql:42") == "Opened audit record sql:42."
    assert views.record_open_summary("demo:sql:42", _f(scope="people", from_="now-7d")) == (
        "Opened audit record demo:sql:42 while viewing People and settings, last 7 days."
    )


def test_no_summary_contains_an_em_or_en_dash() -> None:
    samples = [
        views.view_summary(_f(scope=s, from_=t, event=e), "asc")
        for s in ("people", "agent", "all", None)
        for t in ("now-7d", "now-1d/d", None)
        for e in ("access", "auth.login", "runbook", None)
    ]
    assert not any("\u2014" in s or "\u2013" in s for s in samples)
