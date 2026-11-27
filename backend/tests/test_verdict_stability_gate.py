"""Verdict-stability gate: a deterministic, offline, two-arm fixture run.

Why it exists. Round 14 gave the investigator the Generic incident fallback, a
runbook that matches every case, as trusted guidance, with two extra retrieval
queries. A real-model A/B on a staging clone measured the FALSE_POSITIVE verdict
rate falling from about 69% to about 32%, and the auto-close-eligible count with it.
``decide()`` never changed; the verdicts it was given did. This gate makes a guidance
or prompt change that shifts the verdict mix that much a failing build instead of a
surprise in the field.

What it runs. Every frozen fixture in ``fixtures/verdict_stability/cases.json``
(synthetic clusters, no real data) goes through the REAL pipeline: runbook
selection, prompt assembly, the retrieval groups over the real projected runbook
corpus, the formatter, and the production ``decide()`` (read-only, #3). Each arm and
replicate runs on a fresh offline stack (fake Elasticsearch, no network, no key), so
every case is a first investigation. Two arms:

* ``current``: this build's default preferences;
* ``baseline``: the same build with ``runbooks.investigator_guidance=false``. The
  staging A/B measured this configuration as indistinguishable from the release
  before runbooks guided the investigator (sign test p = 0.77), so it stands in for
  that release, which cannot be run here.

The model is a SENSITIVITY MODEL, not a measurement of a real model. Its verdict is
a declared function of the investigator prompt it is sent (:func:`model_verdict`):

* ``cues``: the evidence, read only from inside the untrusted evidence fences (the
  fixture's ``benign-cues=<n>`` token in each event's ``url.path``);
* ``pressure``: the number of ``Escalate if:`` lines the prompt gives the model as
  trusted context, outside every untrusted fence (the runbook block and retrieved
  runbook passages);
* FALSE_POSITIVE (confidence 0.95) when ``cues > pressure``, else NEEDS_HUMAN
  (confidence 0.5);
* declared replicate noise: a borderline case (``cues == pressure + 1``) answers
  NEEDS_HUMAN on a replicate whose SHA-256 of ``"<fixture id>:<replicate>"`` starts
  with a byte below 128 (about one replicate in two, deterministically).

So the gate measures how much a change moves trusted escalation pressure onto cases,
which is the mechanism the A/B found. It says nothing about the size of the effect on
a real model; the real-model A/B is an operator procedure on a staging clone.

The decision. Each arm runs :data:`REPLICATES` times. The measured self-consistency
floor is the largest share of fixtures whose FALSE_POSITIVE verdict or
close-eligibility differs between two replicates of one arm (it bounds how far either
rate can move by noise alone). The gate fails when the declared threshold
(:data:`MAX_RATE_SHIFT`) does not clear that floor, when either rate differs between
the arms by more than the threshold, or when either arm's mean rate differs by more
than the threshold from the rate recorded in the fixture file (``recorded``). The
arm comparison catches a guidance change, whose effect differs between the arms; the
recorded rates catch a prompt or retrieval change that moves both arms alike. A
specific (tier 1 or higher) runbook is meant to inform its own rule's cases, so the
fixtures that a specific runbook matches carry decisive evidence either way; the gate
guards the blanket shift.

CI runs this file as its own lane (``Verdict stability gate``); it is also part of
the complete offline suite. A guidance or prompt change that is meant to move the
verdict mix is a product decision: record it in the changelog and the upgrade notes,
and update ``recorded`` (or the fixtures, or the threshold) in the same reviewed
change, never only to make the build pass.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import pytest

from app.agents import investigator as investigator_module
from app.agents import pipeline as pipeline_module
from app.agents.prompts import RUNBOOK_OPEN
from app.config import Secrets
from app.constants import UNTRUSTED_CLOSE, UNTRUSTED_OPEN, EntityType, SourceSurface
from app.engine.correlation import cluster_from_events
from app.engine.replay.scoring import offline_decision
from app.engine.runbook_model import render_runbook_prompt
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.models import RawEvent
from app.state import AppState

FIXTURES = Path(__file__).parent / "fixtures" / "verdict_stability" / "cases.json"

#: Replicates per arm: enough to measure the declared noise as a floor.
REPLICATES = 2
#: The declared threshold: the largest shift of the FALSE_POSITIVE-verdict rate or the
#: close-eligible rate between the arms that the gate accepts (15 percentage points).
#: It must clear the measured self-consistency floor, or the gate fails closed.
MAX_RATE_SHIFT = 0.15

FP_CONFIDENCE = 0.95
NH_CONFIDENCE = 0.5
_BASE_MILLIS = 1_700_000_000_000
_EVENT_SPACING_SECONDS = 300
_FENCED = re.compile(re.escape(UNTRUSTED_OPEN) + r".*?" + re.escape(UNTRUSTED_CLOSE), re.S)
_CUES = re.compile(r"benign-cues=(\d+)")
_ESCALATE = re.compile(r"escalate if:", re.I)


# --------------------------------------------------------------------------- #
# The sensitivity model (a declared function of the prompt)
# --------------------------------------------------------------------------- #
def prompt_signals(user_prompt: str) -> tuple[int, int]:
    """``(cues, pressure)`` of one investigator prompt: the benign cues inside the
    untrusted fences, and the ``Escalate if:`` lines outside them."""
    fenced = _FENCED.findall(user_prompt)
    trusted = _FENCED.sub("", user_prompt)
    cues = max((int(n) for block in fenced for n in _CUES.findall(block)), default=0)
    return cues, len(_ESCALATE.findall(trusted))


def _noisy(fixture_id: str, replicate: int) -> bool:
    return hashlib.sha256(f"{fixture_id}:{replicate}".encode()).digest()[0] < 128


def model_verdict(user_prompt: str, *, fixture_id: str, replicate: int) -> tuple[str, float]:
    """The sensitivity model's verdict and confidence for one prompt (see the module
    docstring for the declaration)."""
    cues, pressure = prompt_signals(user_prompt)
    if cues > pressure and not (cues == pressure + 1 and _noisy(fixture_id, replicate)):
        return "FALSE_POSITIVE", FP_CONFIDENCE
    return "NEEDS_HUMAN", NH_CONFIDENCE


class SensitivityModel(MockProvider):
    """A mock provider whose investigator answer is :func:`model_verdict` of the
    prompt it receives. The router always sends the case to the investigator (it
    never sees runbook guidance), and the formatter returns the draft unchanged.
    Every call still goes through the one gateway and is metered (#6)."""

    def __init__(self, replicate: int) -> None:
        super().__init__()
        self.replicate = replicate
        self.fixture_id = ""
        self.prompts: dict[str, str] = {}

    async def complete(self, role, messages, model, temperature, max_tokens):
        if role == "router":
            self.push(role, json.dumps({
                "bucket": "needs_strong_model", "confidence": 0.9, "reason": "sensitivity model",
            }))
        elif role == "investigator":
            prompt = messages[1]["content"]
            self.prompts.setdefault(self.fixture_id, prompt)
            verdict, confidence = model_verdict(prompt, fixture_id=self.fixture_id, replicate=self.replicate)
            self.push(role, json.dumps({
                "action": "final", "reasoning": "sensitivity model",
                "verdict": {"verdict": verdict, "confidence": confidence, "evidence": [],
                            "mitre": [], "recommended_action": "review", "reproduce_query": ""},
            }))
        elif role == "formatter":
            self.push(role, json.dumps(json.loads(messages[1]["content"])["draft_verdict"]))
        return await super().complete(role, messages, model, temperature, max_tokens)


# --------------------------------------------------------------------------- #
# Fixtures and one arm run
# --------------------------------------------------------------------------- #
def _fixture_file() -> dict[str, Any]:
    data = json.loads(FIXTURES.read_text(encoding="utf-8"))
    assert data["contract"] == 1
    return data


def load_fixtures() -> list[dict[str, Any]]:
    return list(_fixture_file()["cases"])


def load_recorded() -> dict[str, float]:
    """The two-replicate mean rates this build recorded on the fixtures."""
    recorded = _fixture_file()["recorded"]
    return {"fp_rate": float(recorded["fp_rate"]), "close_rate": float(recorded["close_rate"])}


def fixture_cluster(case: dict[str, Any]):
    ip, rule, fid = case["ip"], case["rule"], case["id"]
    severity = float(case.get("severity", 2.0))
    spacing = int(case.get("spacing_seconds", _EVENT_SPACING_SECONDS)) * 1000
    events = []
    for index in range(int(case["events"])):
        ts = _BASE_MILLIS + index * spacing
        source = {
            "@timestamp": datetime.fromtimestamp(ts / 1000, tz=timezone.utc).isoformat(),
            "source": {"ip": ip}, "user": {"name": "svc"}, "host": {"name": "app01"},
            "event": {"module": rule, "action": "request", "outcome": "success", "severity": severity},
            "rule": {"name": rule},
            "url": {"path": f"/{fid}/benign-cues={int(case['benign_cues'])}"},
            "message": f"{rule} request from {ip}",
        }
        events.append(RawEvent(
            id=f"{fid}-e{index}", index="all-logs-2023.11.14", source=source, timestamp_millis=ts,
            ip=ip, user="svc", host="app01", rule=rule, rule_name=rule, severity=severity,
        ))
    return cluster_from_events(EntityType.IP, ip, events)


@dataclass
class Cell:
    fixture_id: str
    verdict: str
    close_eligible: bool
    runbook_block: bool
    groups: list[str]
    selection_status: str
    selection_id: str


@dataclass
class ArmRun:
    arm: str
    replicate: int
    cells: dict[str, Cell] = field(default_factory=dict)

    @property
    def fp_rate(self) -> float:
        return sum(c.verdict == "FALSE_POSITIVE" for c in self.cells.values()) / len(self.cells)

    @property
    def close_rate(self) -> float:
        return sum(c.close_eligible for c in self.cells.values()) / len(self.cells)


async def run_arm(arm: str, replicate: int, *, guidance: bool = True) -> ArmRun:
    """One arm and replicate on a fresh offline stack."""
    model = SensitivityModel(replicate)
    secrets = Secrets(_env_file=None, es_store_enabled=False, redis_url="",
                      anthropic_api_key=None, openai_api_key=None)
    state = AppState.create(secrets=secrets, es=InMemoryESClient(),
                            provider_overrides={"anthropic": model, "openai": model, "mock": model})
    await state.startup(start_poller=False)
    try:
        # The startup migration projects the Published runbook corpus in the
        # background; every arm starts from the complete projection.
        task = getattr(state, "_runbook_projection_task", None)
        if task is not None and not task.done():
            await asyncio.wait_for(asyncio.shield(task), timeout=60)
        prefs = state.prefs.model_copy(deep=True, update={"setup_complete": True})
        prefs.runbooks = prefs.runbooks.model_copy(update={"investigator_guidance": guidance})
        await state.update_prefs(prefs)
        out = ArmRun(arm=arm, replicate=replicate)
        for case in load_fixtures():
            model.fixture_id = case["id"]
            result = await state.pipeline.investigate_cluster(
                fixture_cluster(case), SourceSurface.INVESTIGATE, state.prefs,
            )
            rows = await state.audit.records_for_case(result.case_id)
            selector = [r for r in rows if r.get("action") == "runbook.selected"][-1]["tool_input"]
            procedure = [r for r in rows if r.get("actor") == "procedure_provenance"][-1]["tool_input"]
            _decision, eligible = offline_decision(
                result.verdict, result.confidence, result.risk_score, state.prefs,
            )
            out.cells[case["id"]] = Cell(
                fixture_id=case["id"],
                verdict=result.verdict.value,
                close_eligible=eligible,
                runbook_block=RUNBOOK_OPEN in model.prompts.get(case["id"], ""),
                groups=[g["group"] for g in procedure.get("retrieval_query_groups") or []],
                selection_status=str(selector.get("runbook_status") or ""),
                selection_id=str((selector.get("runbook_selection") or {}).get("id") or ""),
            )
        return out
    finally:
        await state.shutdown()


# --------------------------------------------------------------------------- #
# The gate (pure)
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class GateResult:
    passed: bool
    floor: float
    fp_shift: float
    close_shift: float
    reasons: tuple[str, ...]

    def report(self) -> str:
        return (f"floor={self.floor:.3f} fp_shift={self.fp_shift:.3f} "
                f"close_shift={self.close_shift:.3f} threshold={MAX_RATE_SHIFT:.3f}; "
                + ("; ".join(self.reasons) or "passed"))


def _mean(values: list[float]) -> float:
    return sum(values) / len(values)


def self_consistency_floor(runs: list[ArmRun]) -> float:
    """The largest share of fixtures whose FALSE_POSITIVE verdict or close-eligibility
    differs between two replicates of one arm."""
    shares = [0.0]
    for i, one in enumerate(runs):
        for two in runs[i + 1:]:
            if one.arm != two.arm:
                continue
            ids = one.cells.keys() & two.cells.keys()
            for read in (lambda c: c.verdict == "FALSE_POSITIVE", lambda c: c.close_eligible):
                differ = sum(read(one.cells[k]) != read(two.cells[k]) for k in ids)
                shares.append(differ / max(len(ids), 1))
    return max(shares)


def evaluate_gate(current: list[ArmRun], baseline: list[ArmRun], *,
                  threshold: float = MAX_RATE_SHIFT,
                  recorded: dict[str, float] | None = None) -> GateResult:
    """The gate over the two arms, and, with ``recorded``, over each arm against the
    rates recorded in the fixture file (a change that moves both arms alike)."""
    floor = self_consistency_floor([*current, *baseline])
    fp_shift = abs(_mean([r.fp_rate for r in current]) - _mean([r.fp_rate for r in baseline]))
    close_shift = abs(_mean([r.close_rate for r in current]) - _mean([r.close_rate for r in baseline]))
    reasons: list[str] = []
    if threshold <= floor:
        reasons.append("the threshold does not clear the measured self-consistency floor")
    if fp_shift > threshold:
        reasons.append("the FALSE_POSITIVE-verdict rate moved past the threshold")
    if close_shift > threshold:
        reasons.append("the close-eligible rate moved past the threshold")
    if recorded is not None:
        for arm, runs in (("current", current), ("baseline", baseline)):
            if abs(_mean([r.fp_rate for r in runs]) - recorded["fp_rate"]) > threshold:
                reasons.append(f"the {arm} FALSE_POSITIVE-verdict rate moved past the "
                               "threshold from the recorded rate")
            if abs(_mean([r.close_rate for r in runs]) - recorded["close_rate"]) > threshold:
                reasons.append(f"the {arm} close-eligible rate moved past the threshold "
                               "from the recorded rate")
    return GateResult(not reasons, floor, fp_shift, close_shift, tuple(reasons))


_RUNS: dict[str, list[ArmRun]] = {}


async def _arm(name: str, *, guidance: bool) -> list[ArmRun]:
    if name not in _RUNS:
        _RUNS[name] = [await run_arm(name, r, guidance=guidance) for r in range(REPLICATES)]
    return _RUNS[name]


# --------------------------------------------------------------------------- #
# The gate on this build
# --------------------------------------------------------------------------- #
async def test_the_verdict_mix_of_this_build_stays_within_the_noise_floor() -> None:
    current = await _arm("current", guidance=True)
    baseline = await _arm("baseline", guidance=False)
    result = evaluate_gate(current, baseline, recorded=load_recorded())
    assert result.passed, result.report()
    # The fixtures are meaningful: the baseline closes cases, and the declared noise
    # gives a non-zero floor that the threshold clears.
    assert 0.0 < result.floor < MAX_RATE_SHIFT, result.report()
    assert _mean([r.fp_rate for r in baseline]) >= 0.4 and _mean([r.close_rate for r in baseline]) > 0


async def test_only_a_specific_runbook_reaches_the_investigator() -> None:
    by_id = {case["id"]: case for case in load_fixtures()}
    for run in await _arm("current", guidance=True):
        for cell in run.cells.values():
            expect = by_id[cell.fixture_id]["expect"]
            if expect == "none":
                # Only the Generic incident fallback matched: recorded, never given.
                assert (cell.selection_status, cell.selection_id) == ("fallback", "generic-incident")
                assert not cell.runbook_block and cell.groups == ["cluster"], cell
            else:
                assert (cell.selection_status, cell.selection_id) == ("matched", expect)
                assert cell.runbook_block and cell.groups[0] == "cluster", cell
                assert all(g.startswith("runbook:") for g in cell.groups[1:]) and len(cell.groups) > 1
    for run in await _arm("baseline", guidance=False):
        for cell in run.cells.values():
            assert cell.selection_status == "guidance_off" and not cell.runbook_block
            assert cell.groups == ["cluster"], cell


# --------------------------------------------------------------------------- #
# The gate catches a synthetic guidance change
# --------------------------------------------------------------------------- #
def _feed_the_fallback(original: Callable[..., Any]) -> Callable[..., Any]:
    """The Round 14 behaviour, rebuilt as a synthetic change: the fallback's
    rendering and retrieval queries are given to the investigator again."""

    def select(cluster, prefs, catalog, **kwargs):
        guidance = original(cluster, prefs, catalog, **kwargs)
        if guidance.status != investigator_module.GUIDANCE_FALLBACK:
            return guidance
        winner = next(entry for entry in catalog if entry.id == guidance.runbook_id)
        text = render_runbook_prompt(winner.definition, winner.version)
        return replace(guidance, text=text, prompt_chars=len(text),
                       retrieval_queries=tuple(winner.definition.retrieval_queries or ()))

    return select


async def test_the_gate_fails_when_a_guidance_change_shifts_the_verdict_mix(monkeypatch) -> None:
    baseline = await _arm("baseline", guidance=False)
    monkeypatch.setattr(pipeline_module, "select_investigator_runbook",
                        _feed_the_fallback(investigator_module.select_investigator_runbook))
    shifted = [await run_arm("fallback-fed", r, guidance=True) for r in range(REPLICATES)]
    assert all(cell.runbook_block for run in shifted for cell in run.cells.values())
    result = evaluate_gate(shifted, baseline)
    assert not result.passed, result.report()
    assert result.fp_shift > MAX_RATE_SHIFT and result.floor < MAX_RATE_SHIFT, result.report()
    assert "the FALSE_POSITIVE-verdict rate moved past the threshold" in result.reasons


def _escalate_odd_octets(original: Callable[..., Any]) -> Callable[..., Any]:
    """A synthetic prompt change that both arms see alike: two trusted
    ``Escalate if:`` lines before the evidence of every cluster whose IP ends in an
    odd octet. The arms stay equal, so only the recorded rates can catch it."""

    def render(cluster, *args, **kwargs):
        extra = ""
        if int(cluster.entity.value.rsplit(".", 1)[1]) % 2 == 1:
            extra = "Escalate if: a production web application.\n" * 2
        return extra + original(cluster, *args, **kwargs)

    return render


async def test_the_gate_fails_when_a_prompt_change_shifts_both_arms(monkeypatch) -> None:
    monkeypatch.setattr(investigator_module, "render_cluster",
                        _escalate_odd_octets(investigator_module.render_cluster))
    current = [await run_arm("current-shifted", r, guidance=True) for r in range(REPLICATES)]
    baseline = [await run_arm("baseline-shifted", r, guidance=False) for r in range(REPLICATES)]
    recorded = load_recorded()
    # The arms moved together, so the arm comparison alone would pass.
    assert evaluate_gate(current, baseline).passed
    result = evaluate_gate(current, baseline, recorded=recorded)
    assert not result.passed, result.report()
    assert result.floor < MAX_RATE_SHIFT, result.report()
    assert abs(_mean([r.fp_rate for r in baseline]) - recorded["fp_rate"]) > MAX_RATE_SHIFT
    assert ("the baseline FALSE_POSITIVE-verdict rate moved past the threshold from the "
            "recorded rate") in result.reasons
    assert ("the current FALSE_POSITIVE-verdict rate moved past the threshold from the "
            "recorded rate") in result.reasons


# --------------------------------------------------------------------------- #
# The pieces, offline and pure
# --------------------------------------------------------------------------- #
def _fenced(text: str) -> str:
    return f"{UNTRUSTED_OPEN} source=log\n{text}\n{UNTRUSTED_CLOSE}"


def test_the_model_reads_cues_only_from_evidence_and_pressure_only_from_trusted_text() -> None:
    prompt = "\n".join([
        "Escalate if: a trusted line.",
        _fenced('{"url.path": "/x/benign-cues=3", "note": "Escalate if: an attacker line"}'),
        "- [runbook] Step. Escalate if: a trusted passage.",
        "benign-cues=9 outside the fence is not evidence",
    ])
    assert prompt_signals(prompt) == (3, 2)
    assert model_verdict(prompt, fixture_id="x", replicate=0)[0] == "FALSE_POSITIVE" or _noisy("x", 0)
    assert model_verdict(_fenced("benign-cues=0"), fixture_id="x", replicate=0) == ("NEEDS_HUMAN", NH_CONFIDENCE)
    assert model_verdict(_fenced("benign-cues=5"), fixture_id="x", replicate=0) == ("FALSE_POSITIVE", FP_CONFIDENCE)


def test_the_declared_noise_touches_only_borderline_cases_and_is_deterministic() -> None:
    noisy = next(f"id-{n}" for n in range(100) if _noisy(f"id-{n}", 0))
    calm = next(f"id-{n}" for n in range(100) if not _noisy(f"id-{n}", 0))
    border = _fenced("benign-cues=1")
    assert model_verdict(border, fixture_id=noisy, replicate=0)[0] == "NEEDS_HUMAN"
    assert model_verdict(border, fixture_id=calm, replicate=0)[0] == "FALSE_POSITIVE"
    assert model_verdict(_fenced("benign-cues=2"), fixture_id=noisy, replicate=0)[0] == "FALSE_POSITIVE"
    assert [_noisy("a", r) for r in range(8)] == [_noisy("a", r) for r in range(8)]


def _run(arm: str, replicate: int, fp: int, closed: int, total: int = 20) -> ArmRun:
    run = ArmRun(arm=arm, replicate=replicate)
    for i in range(total):
        run.cells[str(i)] = Cell(str(i), "FALSE_POSITIVE" if i < fp else "NEEDS_HUMAN",
                                 i < closed, False, ["cluster"], "", "")
    return run


def test_the_gate_arithmetic() -> None:
    base = [_run("b", 0, 12, 10), _run("b", 1, 13, 11)]
    same = [_run("c", 0, 12, 10), _run("c", 1, 11, 10)]
    assert evaluate_gate(same, base).passed
    # A shift past the threshold fails, on either rate.
    assert not evaluate_gate([_run("c", 0, 5, 10), _run("c", 1, 5, 10)], base).passed
    closes = evaluate_gate([_run("c", 0, 12, 3), _run("c", 1, 12, 3)], base)
    assert closes.reasons == ("the close-eligible rate moved past the threshold",)
    # A threshold that does not clear the measured floor fails closed.
    noisy = [_run("b", 0, 12, 10), _run("b", 1, 17, 10)]
    refused = evaluate_gate(same, noisy, threshold=0.2)
    assert not refused.passed and refused.floor == pytest.approx(0.25)
    assert "the threshold does not clear the measured self-consistency floor" in refused.reasons
    # Both arms moved alike: the arms agree, and only the recorded rates catch it.
    recorded = {"fp_rate": 0.625, "close_rate": 0.525}
    assert evaluate_gate(same, base, recorded=recorded).passed
    moved_b = [_run("b", 0, 6, 4), _run("b", 1, 6, 4)]
    moved_c = [_run("c", 0, 6, 4), _run("c", 1, 6, 4)]
    assert evaluate_gate(moved_c, moved_b).passed
    both = evaluate_gate(moved_c, moved_b, recorded=recorded)
    assert not both.passed
    assert both.reasons == (
        "the current FALSE_POSITIVE-verdict rate moved past the threshold from the recorded rate",
        "the current close-eligible rate moved past the threshold from the recorded rate",
        "the baseline FALSE_POSITIVE-verdict rate moved past the threshold from the recorded rate",
        "the baseline close-eligible rate moved past the threshold from the recorded rate",
    )
