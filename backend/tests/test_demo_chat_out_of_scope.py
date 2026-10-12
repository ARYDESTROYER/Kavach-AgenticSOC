"""Demo planner answers say names in full and refuse what chat is not for (Round 12 final review, L4).

Three findings from the final whole-round review, each fixed at its root:

1. **Names were clipped mid-word.** The narration re-bounded values the lookup had
   already bounded (a rule name at 60 characters, a title at 80), so a 61-character
   demo rule read "Entra ID Protection: credential phishing and account takeov…".
   Operator ask 3 is "no truncation": the narration now shows a value exactly as the
   observation carries it (``demo_chat._NARRATED_CHARS`` only guards a malformed
   observation) and the console wraps a long one.
2. **Out-of-scope requests got unrelated content.** "Write me a python script…" and
   "Tell me a joke" fell to the orientation fallback (a case list plus the first two
   Help Center passages found for "Workspace Chat ask a question"), and "Isolate host
   … and block IP …" pointed at a console page that cannot isolate anything and
   quoted a correlation-design passage. Code and creative requests now get one
   honest sentence about what chat answers; a response action says that no part of
   this console performs one and offers to investigate the named values; the
   orientation answer points to the Workspace Chat section instead of quoting
   whatever ranked first.
3. (Renderer side, webui) a Brief section no longer says its heading twice; see
   ``webui/src/soc/chat/blocks/__tests__/report-headings.test.tsx``.

The final fixer's follow-ups (section 3 below): "the story of this case" is a question
about the case, never a refused creative request; a response verb used as a noun or
figuratively ("lock-out events", "isolate the root cause") is a read; a response answer
names only a value that reads as a host or user name, never "of" or "out"; and a change
answer quotes only a Help Center passage about the change, or none.

Offline and pure; the end-to-end checks over the seeded demo stores are the
``OUT_OF_SCOPE`` entries of ``tests/test_chat_golden_set.py``.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.agents.chat_tools.common import case_row
from app.config import Preferences
from app.constants import SourceSurface
from app.engine import demo_chat
from app.engine.demo_chat import PromptView, classify, plan_turn
from app.models import Case, Entity, EntityType
from tests.test_demo_chat_e2e import _prior, _turn, demo_state  # noqa: F401 (the seeded Demo stack fixture)
from tests.test_demo_chat_planner import call, final_of, prompt, tools_of
from tests.test_demo_chat_round12 import _generic_obs, drive, ran

#: The demo generator's three rule names longer than the old 60-character clip.
LONG_RULES = (
    "Entra ID Protection: credential phishing and account takeover",       # 61
    "Entra ID Protection: password spray against privileged account",      # 62
    "Entra ID Protection: workload identity anomaly after web exploit",    # 64
)


def _case(rule: str, *, case_id: str = "case-1c85aa", title: str | None = None) -> dict[str, Any]:
    """The REAL shared case projection (``case_row``) of a machine-titled case, so
    the narration is checked against exactly what a lookup returns."""
    case = Case(case_id=case_id, cluster_signature="sig", source_surface=SourceSurface.INVESTIGATE,
                entity=Entity(type=EntityType.IP, value="203.0.113.77"),
                title=title if title is not None else f"ip:203.0.113.77 — {rule}", rule_ids=[rule],
                source_name="Microsoft Entra ID Protection — Graph security alerts")
    return case_row(case, Preferences())


# --------------------------------------------------------------------------- #
# 1. Names in full.
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("rule", LONG_RULES)
def test_a_case_name_says_a_long_rule_in_full(rule: str) -> None:
    row = _case(rule)
    name = demo_chat._case_name(row)
    assert name == f"{rule} on IP `203.0.113.77`"
    assert "…" not in name


@pytest.mark.parametrize("rule", LONG_RULES)
def test_explaining_a_case_names_its_rule_and_source_in_full(rule: str) -> None:
    row = _case(rule)

    def obs(tool: str, inp: dict[str, Any]) -> dict[str, Any] | None:
        if tool == "get_case":
            return {"case": row, "mitre": []}
        return _generic_obs(tool, inp)

    rounds, _header, body = drive("Explain case case-1c85aa", obs)
    assert ("get_case", {"case_id": "case-1c85aa"}) in ran(rounds)
    assert f"**`case-1c85aa`** ({rule} on IP `203.0.113.77`)" in body
    assert f"It covers rule `{rule}` and source `Microsoft Entra ID Protection — Graph security alerts`." in body
    assert "…" not in body


def test_a_case_list_names_long_rules_and_titles_in_full() -> None:
    free_title = ("Suspicious OAuth consent grant to an unverified multi-tenant application with mail "
                  "read permissions")                                                           # 101
    rows = [_case(LONG_RULES[0], case_id="case-a"), _case(LONG_RULES[2], case_id="case-b", title=free_title)]
    found = {"filters": {"status_group": "active"}, "window": "all time", "count": 2, "returned": 2,
             "exact": True, "cases": rows}
    rounds, _header, body = drive("List the open cases and explain each",
                                  lambda tool, inp: found if tool == "search_cases" else _generic_obs(tool, inp))
    assert [tool for tool, _inp in ran(rounds)] == ["search_cases"]
    assert f"`case-a` ({LONG_RULES[0]} on IP `203.0.113.77`)" in body
    assert f"`case-b` (`{free_title}`)" in body
    # A rule the name does not already say is listed whole too.
    assert f"rule `{LONG_RULES[2]}`" in body
    assert "…" not in body


def test_the_narration_bound_never_clips_tighter_than_the_shared_case_projection() -> None:
    # The projection bounds a title to 160, a rule and a source to 120 and an entity
    # to 300 characters; whatever it returns is narrated unchanged.
    long_value = "x" * 300
    row = _case("r" * 200, title="t" * 200)
    assert len(row["title"]) == 160 and len(row["rules"][0]) == 120
    assert demo_chat._code(row["title"]) == f"`{row['title']}`"
    assert demo_chat._rule_words(row["rules"][0]) == row["rules"][0]
    assert demo_chat._entity_phrase(f"host:{long_value}") == f"host `{long_value}`"
    assert demo_chat._NARRATED_CHARS >= 300


# --------------------------------------------------------------------------- #
# 2. Out-of-scope requests.
# --------------------------------------------------------------------------- #
CODE_ASKS = (
    "Write me a python script to scan my network",
    "Can you write a bash script that pings every host?",
    "Generate python code to parse the logs",
    "Please write a PowerShell one-liner to list services",
    "Build me a web page for our SOC",
    "Create a python script that lists open cases",
    "Write code",
)
CREATIVE_ASKS = ("Tell me a joke", "Write a poem about phishing", "Tell me a funny story", "Tell me a story",
                 "Write a short story about a hacker", "Tell me stories from the SOC", "Tell me a joke about this case",
                 # A generic security noun after an indefinite article or as a bare plural is
                 # fiction, and "make up" is always fiction (closing review).
                 "Make up a story about an intrusion", "Write a short story about a hacker who breaches a bank",
                 "Write a story about a phishing attack", "Tell me stories about cyber attacks",
                 "Tell me some stories about famous breaches", "Make up a story about this case")
RESPONSE_ASKS = (
    "Isolate host srv-db-01 and block IP 203.0.113.77",
    "Quarantine host srv-db-01",
    "Block IP 203.0.113.77",
    "Block 203.0.113.77",
    "Please contain the infected laptop",
    "Kill process 4242 on srv-db-01",
    "Add 203.0.113.77 to the block list",
    "Lock the account svc_backup",
    "Can you isolate dc01?",
    "Sinkhole evil.example",
    "Unblock 203.0.113.9",
    "Isolate the host of the attacker",
    "Lock the account of dsingh",
    "Lock the user out",
    "Contain the host now",
    # A question after a named target still asks to act on it.
    "Isolate host srv-db-01: what else did it talk to?",
    # Containing the issue, the damage or the impact asks to act (closing review): only a
    # case record in the clause, or a question after it, makes it a read.
    "Contain the issue on host srv-db-01", "Contain the damage now", "Contain the damage",
    "Contain the impact of the breach", "Isolate the issue", "Contain the scope of the attack",
    # Ordinary names after a kind word are the names the analyst typed.
    "Lock user dsingh", "Lock out user rmenon", "Isolate host workstation",
)
#: Requests that look alike but are something chat (or the console) does.
NOT_OUT_OF_SCOPE = (
    ("Write a shift brief", "shift"),
    ("Write a report on the bot activity", "perf_report"),
    ("Generate a PDF report of open cases", "cases"),
    ("Make me a chart of alerts by host", "top"),
    ("Create a case for the bot activity", "change"),          # a case, not code
    ("Create a detection rule for bot traffic", "change"),
    ("Kill the export job", "change"),                          # a console object
    ("Lock the case", "change"),
    ("Kill chain stages for the newest escalated case", "case"),
    ("How do I isolate a host?", "help"),
    ("Tell me something interesting", "fallback"),
    # The story of a case, an incident or a period is a question about it.
    ("Tell me the story of case-abc123", "case"),
    ("Write the story of case demo-00000539-0004 for the CISO", "case"),
    ("Tell me the story of what happened today", "tp"),
    # A response verb used figuratively, as a noun, or before a question asks to read.
    ("Help me isolate the root cause of the newest escalated case", "help"),
    ("Help me contain the damage: which hosts are affected?", "help"),
    ("Lock-out events for user dsingh in the last day", "fallback"),
    ("Lock out events for user dsingh", "fallback"),
    ("Kill switch status", "fallback"),
)


@pytest.mark.parametrize("question", CODE_ASKS + CREATIVE_ASKS)
def test_code_and_creative_requests_are_out_of_scope(question: str) -> None:
    assert classify(question).intent == "out_of_scope", question


@pytest.mark.parametrize("question", RESPONSE_ASKS)
def test_response_actions_are_their_own_intent(question: str) -> None:
    assert classify(question).intent == "respond", question


@pytest.mark.parametrize("question,intent", NOT_OUT_OF_SCOPE)
def test_look_alike_requests_keep_their_intent(question: str, intent: str) -> None:
    assert classify(question).intent == intent, question


@pytest.mark.parametrize("question,refusal", [
    ("Write me a python script to scan my network", "I can't write code or scripts."),
    ("Tell me a joke", "I can't write jokes, poems or stories."),
])
def test_an_out_of_scope_request_says_what_chat_answers_and_runs_nothing(question: str, refusal: str) -> None:
    rounds, header, body = drive(question)
    assert rounds == []                                         # no lookup at all
    assert body.startswith(f"{refusal} Chat answers questions about your security data (cases, logs, metrics, "
                           "threat intelligence and platform health) and about this console, using read-only "
                           "lookups.")
    assert "Try one of the suggested questions below" in body
    # Not a data refusal (SPEC D9): no "unsupported", and nothing unrelated.
    assert "unsupported" not in header and header["answer_kind"] == "conversation"
    assert header["citations"] == [] and header["console_links"] == [] and header["blocks"] == []
    for unrelated in ("open case", "From the Help Center", "I could not map", "Open it in the console"):
        assert unrelated not in body
    assert len(header["follow_ups"]) == 3


def test_a_response_action_says_where_it_runs_and_offers_to_investigate() -> None:
    rounds, header, body = drive("Isolate host srv-db-01 and block IP 203.0.113.77")
    assert rounds == []
    assert body.startswith("I can't do that: chat is read-only, and this console has no response actions, so "
                           "nothing here can isolate a host, block an address, quarantine a file or stop a "
                           "process. Run the action in your EDR, firewall or SOAR tool.")
    assert ("Before you act, chat can investigate host `srv-db-01` and IP `203.0.113.77`: the cases that involve "
            "them and their log activity.") in body
    assert header["follow_ups"][:2] == ["Investigate everything about host srv-db-01", "Check 203.0.113.77"]
    # No console page that cannot do it, no Help Center passage, no data refusal.
    for unrelated in ("Do it in the console", "Entity investigation", "From the Help Center", "Correlation"):
        assert unrelated not in body
    assert header["console_links"] == [] and header["citations"] == []
    assert header["answer_kind"] == "product_help" and "unsupported" not in header


def test_the_offered_follow_ups_are_the_investigations_they_name() -> None:
    assert classify("Investigate everything about host srv-db-01").intent == "deep"
    assert classify("Check 203.0.113.77").intent == "hunt"
    assert demo_chat._response_targets("Isolate host srv-db-01 and block IP 203.0.113.77") == [
        ("host", "srv-db-01"), ("ip", "203.0.113.77")]
    assert demo_chat._response_targets("Lock the account svc_backup") == [("user", "svc_backup")]
    assert demo_chat._response_targets("Sinkhole evil.example") == [("domain", "evil.example")]


@pytest.mark.asyncio
async def test_the_offered_follow_ups_run_through_the_real_engine(demo_state) -> None:  # noqa: F811
    # Over the seeded Demo stack: the refusal runs no lookup, and each offered follow-up
    # (sent as a chip, origin "follow_up") runs its investigation; the indicator lookup
    # is allowed because the analyst typed the value in the conversation (#9 taint rule).
    question = "Isolate host srv-db-01 and block IP 203.0.113.77"
    first = await _turn(demo_state, question, origin="user")
    assert [s for s in first.steps if s.kind == "tool"] == [] and first.notice is None
    prior = [_prior(question, first, 1)]
    deep = await _turn(demo_state, first.follow_ups[0], origin="follow_up", prior=prior)
    assert deep.answer.startswith("**In-depth investigation of host `srv-db-01`")
    check = await _turn(demo_state, first.follow_ups[1], origin="follow_up", prior=prior)
    steps = {s.tool: s.status for s in check.steps if s.kind == "tool"}
    assert steps.get("lookup_indicator") == "ok", steps
    assert check.answer.startswith("**`203.0.113.77` scores")


def test_a_response_action_without_a_named_value_offers_the_general_investigation() -> None:
    _rounds, header, body = drive("Please contain the infected laptop")
    assert body.endswith("Before you act, ask chat about the host, user or indicator involved: its cases, its log "
                         "activity and, for an indicator, its reputation.")
    assert header["follow_ups"] and all(not f.startswith("Check ") for f in header["follow_ups"])


def test_a_response_action_in_case_chat_offers_no_workspace_investigation() -> None:
    _rounds, header, _body = drive("Isolate host srv-db-01", case_scoped=True)
    assert "Investigate everything about host srv-db-01" not in header["follow_ups"]


def test_a_response_action_is_refused_without_any_lookup_grant() -> None:
    reply = plan_turn(prompt("Block IP 203.0.113.77", tools=()))
    header, body = final_of(reply)
    assert body.startswith("I can't do that: chat is read-only")
    assert "No lookups are available" not in body and header["follow_ups"] == []


def test_the_rerun_shape_around_a_response_action_is_refused_as_one() -> None:
    assert classify("Run step 3 (isolate the host) again").intent == "respond"
    assert classify("Run step 3 (rename the case) again").intent == "change"


def test_a_response_action_never_saves_a_report() -> None:
    ask = classify("Isolate host srv-db-01 and build a report")
    assert ask.intent == "respond" and ask.save is False
    _rounds, header, _body = drive("Isolate host srv-db-01 and build a report")
    assert "report" not in header


def test_the_orientation_answer_points_to_the_chat_guide_instead_of_quoting_unrelated_passages() -> None:
    # The real ``app_help`` observation shape (``chat_tools.app_help``).
    help_obs = {"kind": "app_help", "available": True, "docs_version": "0.1", "results": [
        {"ref": "D1", "title": "Workspace Chat › Ask a question", "breadcrumb": "Analyst › Workspace Chat",
         "href": "analyst/chat/#ask-a-question", "console": ["page:chat"],
         "text": "On a narrow composer, the scope chips merge into one **Scope · n** chip."},
        {"ref": "D2", "title": "KPI glossary", "breadcrumb": "Reference › KPI glossary",
         "href": "reference/kpi-glossary/", "console": ["page:overview"],
         "text": "This page is the single reference for the numbers on **Overview → Dashboard**."},
    ], "console_targets": [{"id": "page:overview", "label": "Overview › Dashboard", "requires": None,
                            "allowed": True}]}
    cases = {"filters": {"status_group": "active"}, "window": "all time", "count": 1, "returned": 1, "exact": True,
             "cases": [_case(LONG_RULES[0])]}
    rounds, header, body = drive("Tell me something interesting",
                                 lambda tool, inp: {"app_help": help_obs, "search_cases": cases}.get(tool))
    assert [tool for tool, _inp in ran(rounds)] == ["app_help", "search_cases"]   # the §5.5 orientation plan
    assert body.startswith("I could not map that to one specific lookup. Chat answers questions about your "
                           "security data")
    assert "Here is where things stand:" in body and "**1 open case**" in body
    # One pointer to the Workspace Chat section, cited; never a quoted passage.
    assert body.endswith("To see what else you can ask, read **Workspace Chat › Ask a question** [D1] in the "
                         "Help Center.")
    assert header["citations"] == ["D1"]
    for unrelated in ("narrow composer", "KPI glossary", "single reference", "Open it in the console"):
        assert unrelated not in body
    assert header["console_links"] == []


def test_an_off_topic_question_the_help_center_cannot_answer_says_what_chat_answers() -> None:
    help_obs = {"kind": "app_help", "available": True, "results": [], "console_targets": []}
    header, body = final_of(plan_turn(prompt("What is the capital of France?", [call("app_help", help_obs)])))
    assert body == ("The Help Center has no section that answers this directly. Chat answers questions about your "
                    "security data (cases, logs, metrics, threat intelligence and platform health) and about this "
                    "console, using read-only lookups.")
    assert "unsupported" not in header


def test_a_change_request_quotes_only_a_help_center_passage_that_shares_its_words() -> None:
    help_obs = {"kind": "app_help", "available": True, "docs_version": "0.1", "results": [
        {"ref": "D1", "title": "Ingestion and investigation › Correlation across sources", "breadcrumb": "",
         "href": "architecture/ingestion/", "console": [],
         "text": "Cross-source correlation should be a typed, time-bounded graph of detections and identities."},
    ], "console_targets": []}
    plan = tools_of(plan_turn(prompt("Rename the dashboard to SOC wall")))
    assert [t for t, _ in plan] == ["app_help"]
    _header, body = final_of(plan_turn(prompt("Rename the dashboard to SOC wall", [call("app_help", help_obs)])))
    assert body.startswith("I can't change that from chat")
    assert "Correlation" not in body and "From the Help Center" not in body


# --------------------------------------------------------------------------- #
# 3. Final fixer follow-ups.
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("question", ["Tell me the story of this case", "Give me the story of this case"])
def test_the_story_of_this_case_in_case_chat_reads_the_case(question: str) -> None:
    assert classify(question, PromptView(case_scoped=True)).intent == "case"
    rounds, _header, body = drive(question, case_scoped=True)
    assert "get_case" in [tool for tool, _inp in ran(rounds)]
    assert "I can't write" not in body


@pytest.mark.parametrize("question", [
    "Tell me the story of case-abc123", "Tell me a story about case-abc123", "Tell me a story about this incident",
    "Give me a story of what happened overnight", "Write the story of today's shift",
])
def test_a_story_about_the_analysts_own_data_is_never_refused_as_creative(question: str) -> None:
    assert classify(question).intent != "out_of_scope", question
    rounds, _header, body = drive(question)
    assert rounds and "I can't write jokes, poems or stories." not in body


@pytest.mark.parametrize("question", [
    "Block events from 203.0.113.7", "Quarantine status of file abc", "Kill-switch status",
    "Contain the issue with case-abc123", "Isolate the cases for host dc01",
])
def test_a_response_verb_used_to_read_is_neither_an_action_nor_a_change(question: str) -> None:
    assert classify(question).intent not in ("respond", "change", "out_of_scope"), question


@pytest.mark.parametrize("question", [
    "Isolate the host of the attacker", "Lock the user out", "Contain the host now", "Lock the user account",
    "Isolate the host machine",
])
def test_a_response_answer_never_presents_an_ordinary_word_as_a_host_or_user(question: str) -> None:
    assert demo_chat._response_targets(question) == []
    rounds, header, body = drive(question)
    assert rounds == []
    assert body.endswith("Before you act, ask chat about the host, user or indicator involved: its cases, its log "
                         "activity and, for an indicator, its reputation.")
    assert "Before you act, chat can investigate" not in body
    assert not any(f.startswith("Investigate everything about") for f in header["follow_ups"])
    for invented in ("`of`", "`out`", "`now`"):
        assert invented not in body


@pytest.mark.parametrize("question, expected", [
    # After an explicit kind word the next word is the name the analyst typed, whatever
    # its shape: every seeded Demo user is a plain word (closing review).
    ("Lock user dsingh", [("user", "dsingh")]), ("Lock out user rmenon", [("user", "rmenon")]),
    ("Block user jdoe", [("user", "jdoe")]), ("Lock user admin", [("user", "admin")]),
    ("Disable account jdoe immediately", [("user", "jdoe")]), ("Isolate host workstation", [("host", "workstation")]),
    ("Quarantine host webserver", [("host", "webserver")]), ("Isolate machine laptop", [("host", "laptop")]),
    ("Lock the account of dsingh", [("user", "dsingh")]), ("Lock the user account dsingh", [("user", "dsingh")]),
    ("Contain the issue on host srv-db-01", [("host", "srv-db-01")]),
])
def test_a_response_answer_keeps_the_name_after_a_kind_word(question: str, expected: list[tuple[str, str]]) -> None:
    assert demo_chat._response_targets(question) == expected


@pytest.mark.parametrize("question, kind, value", [
    ("Lock user dsingh", "user", "dsingh"), ("Isolate host workstation", "host", "workstation"),
    ("Contain the issue on host srv-db-01", "host", "srv-db-01"),
])
def test_a_response_answer_offers_to_investigate_a_plain_name(question: str, kind: str, value: str) -> None:
    rounds, header, body = drive(question)
    assert rounds == [] and body.startswith("I can't do that: chat is read-only")
    assert f"Before you act, chat can investigate {kind} `{value}`" in body, body
    assert header["follow_ups"][0] == f"Investigate everything about {kind} {value}"


def test_containing_the_damage_is_refused_as_a_response_action() -> None:
    rounds, header, body = drive("Contain the damage now")
    assert rounds == [] and body.startswith("I can't do that: chat is read-only")
    assert "I could not map" not in body and "open case" not in body
    assert header["answer_kind"] == "product_help"


def test_a_response_answer_keeps_a_value_that_reads_as_a_name() -> None:
    assert demo_chat._response_targets("Isolate host dc01 immediately") == [("host", "dc01")]
    assert demo_chat._response_targets('Lock user "dsingh"') == [("user", "dsingh")]
    # An email's local part is not a domain, and a named value is offered once, whole.
    assert demo_chat._response_targets("Lock out user j.smith@corp.example") == [("user", "j.smith@corp.example")]
    assert demo_chat._response_targets("Block sender j.smith@corp.example") == [("domain", "corp.example")]


def _help(*sections: tuple[str, str, tuple[str, ...]], targets: tuple[dict[str, Any], ...] = ()) -> dict[str, Any]:
    """An ``app_help`` observation (the real shape) with the seeded corpus's own leads."""
    return {"kind": "app_help", "available": True, "docs_version": "0.1", "results": [
        {"ref": f"D{i}", "title": title, "breadcrumb": "", "href": f"page/{i}/", "console": list(console),
         "text": text} for i, (title, text, console) in enumerate(sections, 1)], "console_targets": list(targets)}


_NARROW = ("Workspace Chat › Ask a question",
           ("On a narrow composer, the scope chips merge into one **Scope · n** chip, the **Read-only** chip "
            "shows only its lock, and the model chip shows only its icon."), ())
_BOOTSTRAP = ("Upgrades and promotion › The unavoidable first bootstrap",
              ("An installation made before the updater exists cannot grant itself host update authority. The "
               "wrapper and supervisor serialize mutations through the same advisory lifecycle lock."), ())
_RESTART = ("Queues and object stores › Checkpoints and restart",
            ("Object-store and Kinesis receivers can attach to the Agentic SOC cursor store. Broker offsets or "
             "subscriptions may also be durable in the provider."), ())
_HANDOFF = ("Case collaboration › Shift handoff",
            ("Use **Overview → Standup** to review the urgency-ranked attention queue, SLA pressure, workload by "
             "assignee, and action items. Analysts with `cases:write` can create and update handoff actions and "
             "acknowledge the report."), ("page:standup",))
_EXPORT = ("Settings administration › Export portable application state",
           ("The Knowledge scope includes exact catalog counts, sanitized authoritative Markdown for operator-owned "
            "runbooks and playbooks."), ("settings:data_export", "page:batchjobs"))
_JOBS = ("Background jobs › Work that uses the job system",
         ("The current job registry covers Case Manager bulk reinvestigation, lifecycle changes, assignment and "
          "tagging, and Data export archive collection."), ())
_STANDUP = {"id": "page:standup", "label": "Overview › Standup", "requires": None, "allowed": True}
_JOBS_PAGE = {"id": "page:batchjobs", "label": "Analytics › Jobs", "requires": None, "allowed": True}


@pytest.mark.parametrize("question,obs,unrelated", [
    ("Lock the case", _help(_NARROW, _BOOTSTRAP), ("narrow composer", "first bootstrap", "Also see")),
    ("Restart the poller", _help(_RESTART), ("Checkpoints and restart", "Kinesis")),
    ("Create a case for the bot activity", _help(_HANDOFF, targets=(_STANDUP,)),
     ("Shift handoff", "Overview › Standup", "Do it in the console")),
])
def test_a_change_answer_quotes_no_passage_that_only_shares_a_word(question: str, obs: dict[str, Any],
                                                                  unrelated: tuple[str, ...]) -> None:
    assert classify(question).intent == "change"
    header, body = final_of(plan_turn(prompt(question, [call("app_help", obs)])))
    assert body == ("I can't change that from chat: the assistant is read-only, so it can search and explain but "
                    "never close, edit, assign or configure anything.")
    for text in (*unrelated, "From the Help Center"):
        assert text not in body
    assert header["citations"] == [] and header["console_links"] == [] and header["blocks"] == []


def test_a_change_answer_keeps_the_passage_and_page_about_the_request() -> None:
    obs = _help(_EXPORT, _JOBS, targets=(_STANDUP, _JOBS_PAGE))
    header, body = final_of(plan_turn(prompt("Kill the export job", [call("app_help", obs)])))
    assert body.startswith("I can't change that from chat")
    assert "Do it in the console: **Analytics › Jobs**." in body and "Standup" not in body
    assert "From the Help Center:\n\n**Background jobs › Work that uses the job system** [D2]: The current job" in body
    assert "Export portable application state" not in body and header["citations"] == ["D2"]
    # The Help Center card would list the unrelated hit too, so it is left out.
    assert header["blocks"] == []
    assert header["console_links"][0] == "page:batchjobs" and "page:standup" not in header["console_links"]


def test_a_change_terms_reading_names_the_verb_and_object() -> None:
    terms = demo_chat._change_terms("Please kill the export job now")
    assert (terms.verb, terms.noun) == ("kill", "job") and terms.words == {"kill", "export", "job"}
    # A case id names a case; the rerun shape reads the analyst's own words.
    assert demo_chat._change_terms("Close case-0042 now").noun == "cas"
    assert demo_chat._change_terms("Run step 3 (rename the dashboard) again").noun == "dashboard"


def test_campaign_entities_are_said_whole() -> None:
    entity = "user:svc_payments_reconciliation_batch_runner@finance-operations.corp.example"
    # The real ``list_campaigns`` observation shape: an entity value bounded to 120 characters.
    obs = {"status_filter": None, "total": 1, "returned": 1, "campaigns": [
        {"id": "camp-1", "name": None, "status": "open", "case_count": 3, "case_ids": ["case-a", "case-b", "case-c"],
         "entities": [entity], "mitre": ["T1078"], "severity": "high", "first_seen": None, "last_seen": None}]}
    result = demo_chat.Result(ordinal=1, tool="list_campaigns", status="ok", summary="1 campaign", observation=obs)
    text = demo_chat._say_campaigns(result)
    assert "3 cases sharing user `svc_payments_reconciliation_batch_runner@finance-operations.corp.example`" in text
    assert "…" not in text


@pytest.mark.parametrize("question, target, page", [
    ("Change the theme to dark",
     {"id": "settings:customization", "label": "Settings › Account › Appearance & customization",
      "requires": None, "allowed": True}, "Settings › Account › Appearance & customization"),
    ("Change the case ID format",
     {"id": "settings:cases", "label": "Settings › General › Cases", "requires": None, "allowed": True},
     "Settings › General › Cases"),
])
def test_a_change_answer_keeps_the_page_its_console_keywords_name(question: str, target: dict[str, Any],
                                                                  page: str) -> None:
    """The console map's own keywords ("theme", "dark mode"; "case id", "nomenclature")
    name the page even when its label does not: the analyst is told where to do it
    (closing review), never only that chat cannot."""
    assert classify(question).intent == "change"
    assert demo_chat._target_keywords(target["id"]), "the bundled console map names the page's keywords"
    # The search also returned a passage that is not about the change: never quoted.
    obs = _help(_NARROW, targets=(target,))
    header, body = final_of(plan_turn(prompt(question, [call("app_help", obs)])))
    assert body.startswith("I can't change that from chat")
    assert f"Do it in the console: **{page}**." in body, body
    assert header["console_links"] == [target["id"]] and "narrow composer" not in body


def test_a_change_answer_never_keeps_a_page_only_the_verb_names() -> None:
    """"Change" is in many keyword lists; the object decides ("Create a case" never
    keeps Standup, whose keywords name a shift handoff)."""
    standup = {"id": "page:standup", "label": "Overview › Standup", "requires": None, "allowed": True}
    header, body = final_of(plan_turn(prompt("Create a case for the bot activity",
                                             [call("app_help", _help(_NARROW, targets=(standup,)))])))
    assert "Standup" not in body and header["console_links"] == []
