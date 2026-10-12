"""Round 12 P1-1 (#9): a run-log step shows exactly what was sent.

A model- or log-derived input (``ChatStep.untrusted_params``) and the query as run
(``ChatStep.query``) keep every invisible, bidi, tag or control character as a visible
``\\uXXXX`` escape instead of deleting it. Deleting it would show an attacker-planted
"admin" + ZWSP as "admin" (the real account) in the step inspector's "What was sent"
while the stored observation below it shows the escape. The escapes are ASCII, so the
web normalisers (which strip raw invisible characters) keep them.
"""
from __future__ import annotations

import json

from app.agents import chat_events as E
from app.models import ChatStep, display_params, visible_display_text

ZWSP = "​"
RLO = "‮"


def _step(**extra: object) -> ChatStep:
    return ChatStep.model_validate({"index": 2, "tool": "search_logs", "label": "Searched logs", **extra})


def test_untrusted_params_write_lookalikes_as_escapes() -> None:
    step = _step(untrusted_params={"user": f"admin{ZWSP}", "host": f"evil{RLO}txt.exe", "n": 5})
    assert step.untrusted_params == {"user": "admin\\u200b", "host": "evil\\u202etxt.exe", "n": "5"}
    # The real account and the lookalike never read the same.
    assert step.untrusted_params["user"] != "admin"


def test_query_as_run_writes_lookalikes_as_escapes_and_keeps_lines() -> None:
    step = _step(query=f'user.name:"admin{ZWSP}"\r\nAND host:"evil{RLO}txt.exe"\u0000')
    assert step.query == 'user.name:"admin\\u200b"\nAND host:"evil\\u202etxt.exe"\\u0000'


def test_astral_and_lone_surrogates_are_escaped_like_ensure_ascii() -> None:
    tag = "\U000E0041"   # a tag character: hidden ASCII a reviewer cannot see
    step = _step(untrusted_params={"q": f"x{tag}y", "lone": "a\ud800b"})
    assert step.untrusted_params["q"] == "x\\udb40\\udc41y"
    assert step.untrusted_params["q"] == json.dumps(f"x{tag}y")[1:-1]
    assert step.untrusted_params["lone"] == "a\\ud800b"


def test_trusted_display_params_still_strip() -> None:
    # Engine-validated chips are unchanged: only the untrusted map and the query escape.
    step = _step(params={"window": f"now-7d{ZWSP}"}, untrusted_params={"user": f"a{ZWSP}"})
    assert step.params == {"window": "now-7d"}
    assert display_params({"k": f"a{ZWSP}"}) == {"k": "a"}
    assert display_params({"k": f"a{ZWSP}"}, visible=True) == {"k": "a\\u200b"}


def test_bound_never_cuts_an_escape_in_half() -> None:
    for pad in range(180, 200):
        for char in (ZWSP, "\U000E0041"):
            out = visible_display_text("a" * pad + char + "zz", 200)
            assert len(out) <= 200
            body = out.rstrip("…")
            # Either the whole escape survives or none of it does.
            tail = body[pad:]
            assert tail in ("", "\\u200b", "\\u200bz", "\\u200bzz", "\\udb40\\udc41", "\\udb40\\udc41z",
                            "\\udb40\\udc41zz"), (pad, tail)
    assert visible_display_text("a" * 198 + ZWSP, 200) == "a" * 198 + "…"


def test_scalars_and_containers() -> None:
    assert visible_display_text(5, 10) == "5"
    assert visible_display_text(True, 10) == "true"
    assert visible_display_text({"a": 1}, 10) == ""
    assert visible_display_text(None, 10) == ""
    assert visible_display_text(f" a{ZWSP}\tb ", 0) == "a\\u200b b"


def test_escaped_step_is_stable_across_persist_and_stream() -> None:
    step = _step(untrusted_params={"user": f"admin{ZWSP}"}, query=f"user:admin{ZWSP}")
    # A stored step re-read is unchanged (the escapes are plain ASCII).
    again = ChatStep.model_validate(json.loads(step.model_dump_json()))
    assert again == step
    # The stream carries the same escapes (``step.end``).
    line = E.encode_event(E.StepEndEvent(step=step)).decode("utf-8")
    payload = json.loads(line)
    assert payload["step"]["untrusted_params"] == {"user": "admin\\u200b"}
    assert payload["step"]["query"] == "user:admin\\u200b"
