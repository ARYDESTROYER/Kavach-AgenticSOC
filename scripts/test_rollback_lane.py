"""Offline tests of the N to N-1 rollback lane (``scripts/rollback_lane.py``).

The lane itself boots real backends on PostgreSQL; these tests pin the parts that can
drift without a database: the pin file, the log markers the lane judges a boot by (they
must stay the backend's own wording), the scratch-database URL and the requests it
sends. Run with ``python -m unittest scripts.test_rollback_lane -v`` from the
repository root.
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from io import StringIO
from pathlib import Path

from scripts import rollback_lane as lane

ROOT = Path(__file__).resolve().parent.parent


class PinTests(unittest.TestCase):
    def test_the_pinned_previous_release_is_a_full_commit_id(self) -> None:
        pin = lane.load_pin()
        self.assertRegex(pin.previous_release, r"^[0-9a-f]{40}$")
        self.assertIsInstance(pin.forward_contract, bool)

    def test_a_malformed_pin_is_refused(self) -> None:
        for content in (
            {"previous_release": "45a4c31", "forward_contract": False},
            {"previous_release": "g" * 40},
            {"previous_release": "a" * 40, "forward_contract": "yes"},
            ["not", "an", "object"],
        ):
            with tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / "pin.json"
                path.write_text(json.dumps(content), encoding="utf-8")
                with self.assertRaises(ValueError):
                    lane.load_pin(path)

    def test_forward_contract_defaults_to_false(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "pin.json"
            path.write_text(json.dumps({"previous_release": "a" * 40}), encoding="utf-8")
            self.assertFalse(lane.load_pin(path).forward_contract)


class MarkerTests(unittest.TestCase):
    """The lane fails a boot on these lines, so they must be the backend's words."""

    def test_the_markers_are_the_backends_own_log_lines(self) -> None:
        state = (ROOT / "backend" / "app" / "state.py").read_text(encoding="utf-8")
        rag = (ROOT / "backend" / "app" / "tools" / "rag.py").read_text(encoding="utf-8")
        for marker in lane.SAFE_STOP_MARKERS:
            self.assertIn(marker, state)
        for marker in lane.REFUSAL_MARKERS:
            self.assertIn(marker, rag)
        self.assertIn(lane.SEEDED_MARKER, rag)

    def test_scan_log_counts_each_kind_of_line(self) -> None:
        text = "\n".join([
            "INFO tlsoc.tools.rag :: RAG seeded with 62 chunk(s)",
            "ERROR tlsoc.tools.rag :: RAG projection REFUSED (retention_floor) - kept",
            "ERROR tlsoc.state :: Jobs factory-fence status unavailable; entering safe-stop: x",
            "WARNING tlsoc.state :: AppState started in factory-reset recovery safe-stop (owner=y)",
            "INFO unrelated",
        ])
        self.assertEqual(lane.scan_log(text), {"safe_stop": 2, "refused": 1, "seeded": 1})
        self.assertEqual(lane.scan_log(""), {"safe_stop": 0, "refused": 0, "seeded": 0})


class ScenarioTests(unittest.TestCase):
    """The default run gates this build's own forward contract, whatever the pin."""

    @staticmethod
    def _args(**overrides: object) -> "lane.argparse.Namespace":
        values: dict[str, object] = {
            "database_url": "postgresql+asyncpg://u:p@127.0.0.1/x",
            "work_dir": None,
            "previous_python": None,
            "keep_database": False,
            "previous_release": None,
            "previous_backend": None,
            "forward_contract": False,
            "pinned_only": False,
        }
        values.update(overrides)
        return lane.argparse.Namespace(**values)

    def test_the_default_run_adds_a_self_forward_scenario_on_future_data(self) -> None:
        pin = lane.Pin(previous_release="a" * 40, forward_contract=False)
        plan = lane.plan_scenarios(self._args(work_dir="/w"), pin)
        self.assertEqual([name for name, _args, _pin in plan], ["pinned", "self-forward"])
        (_, pinned_args, pinned_pin), (_, self_args, self_pin) = plan
        self.assertIsNone(pinned_args.previous_backend)
        self.assertEqual(pinned_pin, pin)
        self.assertEqual(Path(self_args.previous_backend), lane.BACKEND)
        self.assertTrue(self_pin.forward_contract)
        self.assertNotEqual(pinned_args.work_dir, self_args.work_dir)

    def test_a_rehearsal_or_pinned_only_runs_one_scenario(self) -> None:
        pin = lane.Pin(previous_release="a" * 40, forward_contract=False)
        for overrides, name in (
            ({"previous_backend": "backend"}, "rehearsal"),
            ({"previous_release": "b" * 40}, "rehearsal"),
            ({"pinned_only": True}, "pinned"),
        ):
            plan = lane.plan_scenarios(self._args(**overrides), pin)
            self.assertEqual([entry[0] for entry in plan], [name])


class RequestTests(unittest.TestCase):
    def test_the_scratch_url_names_the_scratch_database_and_keeps_credentials(self) -> None:
        try:
            url = lane.scratch_url(
                "postgresql+asyncpg://tlsoc:secret@127.0.0.1:5432/tlsoc", "tlsoc_rollback_lane_x"
            )
        except ImportError:  # pragma: no cover - SQLAlchemy is a backend dependency
            self.skipTest("SQLAlchemy is not installed")
        self.assertEqual(url, "postgresql+asyncpg://tlsoc:secret@127.0.0.1:5432/tlsoc_rollback_lane_x")

    def test_the_audit_export_body_is_one_the_backend_accepts(self) -> None:
        body = lane.audit_export_body("rollback-lane-key", now=0)
        self.assertEqual(body["kind"], "audit_export")
        self.assertGreaterEqual(len(body["idempotency_key"]), 8)
        self.assertEqual(body["params"]["to"], "1970-01-01T00:00:00Z")
        sys.path.insert(0, str(ROOT / "backend"))
        try:
            from app.api.routes_jobs import AuditExportParams, JobSubmit
        except ImportError:  # pragma: no cover - the backend's dependencies are absent
            self.skipTest("the backend's dependencies are not installed")
        finally:
            sys.path.remove(str(ROOT / "backend"))
        submit = JobSubmit.model_validate(body)
        AuditExportParams.model_validate(submit.params)

    def test_the_lane_needs_a_postgresql_url(self) -> None:
        with redirect_stderr(StringIO()), self.assertRaises(SystemExit) as raised:
            lane.main(["--database-url", "sqlite+aiosqlite:///x.db"])
        self.assertEqual(raised.exception.code, 2)


class _Backend:
    """The backend on ``sys.path`` for one import block."""

    def __enter__(self) -> None:
        sys.path.insert(0, str(ROOT / "backend"))

    def __exit__(self, *exc: object) -> None:
        sys.path.remove(str(ROOT / "backend"))


class _FakeBoot:
    """A booted backend's HTTP surface, answered from a table (no process, no database)."""

    def __init__(self, label: str, responses: dict) -> None:
        self.label = label
        self.responses = responses
        self.calls: list[tuple] = []

    def get(self, path: str):
        self.calls.append(("GET", path))
        return self.responses[("GET", path)]

    def put(self, path: str, body: object):
        self.calls.append(("PUT", path, body))
        return self.responses[("PUT", path)]

    def post(self, path: str, body: object):
        self.calls.append(("POST", path, body))
        return self.responses[("POST", path)]

    def get_bytes(self, path: str):
        self.calls.append(("GET_BYTES", path))
        return self.responses[("GET_BYTES", path)]

    def log(self) -> str:
        return ""


def _reviewed_case(*, marker: bool = True, event: bool = True, comment: bool = False) -> dict:
    """The review case as N serves it after the review (and after N-1's full save)."""
    doc = lane.review_case_doc("2026-11-23T12:00:00+00:00")
    grade = {"ts": "2026-11-23T12:05:00+00:00", "analyst": "default", "assessment": "agree"}
    if marker:
        grade.update({"origin": lane.REVIEW_EVENT, "review_id": lane.REVIEW_ID})
    doc["feedback"] = [grade]
    if event:
        doc["history"] = list(doc["history"]) + [{
            "ts": grade["ts"], "event": lane.REVIEW_EVENT, "review_id": lane.REVIEW_ID,
            "feedback_ts": grade["ts"], "analyst": "default", "agrees": True,
        }]
    doc["comments"] = (
        [{"author": "rollback-lane", "body": "Saved again by the previous release."}] if comment else []
    )
    return doc


def inspect_source(obj: object) -> str:
    import inspect

    return inspect.getsource(obj)


def _bare_lane() -> "lane.Lane":
    """A Lane without its set-up (no work directory, no database)."""
    instance = lane.Lane.__new__(lane.Lane)
    instance.results = []
    instance.boots = []
    instance.screenshot_id = ""
    instance.feedback_baseline = -1
    instance.round16 = {}
    return instance


class Round15PlantTests(unittest.TestCase):
    """SPEC §3.7: the review grade and the screenshot survive a rollback round trip."""

    def test_the_screenshot_plant_is_a_png_the_backend_accepts(self) -> None:
        data = lane.tiny_png()
        self.assertTrue(data.startswith(lane.PNG_SIGNATURE))
        try:
            with _Backend():
                from app.api.routes_case_files import CaseFileUploadBody
                from app.engine.case_images import validate_image
        except ImportError:  # pragma: no cover - the backend's dependencies are absent
            self.skipTest("the backend's dependencies are not installed")
        image = validate_image(data, declared="image/png")
        self.assertEqual((image.kind, image.width, image.height), ("png", 2, 2))
        body = CaseFileUploadBody.model_validate(lane.screenshot_body())
        self.assertEqual(body.content_type, "image/png")
        self.assertEqual(body.caption, lane.SCREENSHOT_CAPTION)

    def test_the_review_plant_is_an_agent_close_the_review_endpoint_accepts(self) -> None:
        try:
            with _Backend():
                from app.api.routes_auto_close_review import ReviewBody
                from app.constants import TERMINAL_CASE_STATUSES
                from app.engine.auto_close_review import classification_agrees, first_decision_is_agent_close
                from app.models import Case
        except ImportError:  # pragma: no cover
            self.skipTest("the backend's dependencies are not installed")
        case = Case.model_validate(lane.review_case_doc("2026-11-23T12:00:00+00:00"))
        self.assertIn(case.status.value, TERMINAL_CASE_STATUSES)
        self.assertTrue(first_decision_is_agent_close(case))
        body = ReviewBody.model_validate(lane.review_body())
        self.assertTrue(classification_agrees(body.classification, "FALSE_POSITIVE"))

    def test_a_save_that_drops_the_grade_marker_keeps_the_grade_excluded(self) -> None:
        """What the lane proves on PostgreSQL, offline: once an older build saved the case
        without the grade's new fields, the history event alone marks the grade."""
        try:
            with _Backend():
                from app.engine.metrics import feedback_stats
                from app.engine.review_origin import is_review_grade
                from app.models import Case
        except ImportError:  # pragma: no cover
            self.skipTest("the backend's dependencies are not installed")
        case = Case.model_validate(_reviewed_case(marker=False, comment=True))
        (grade,) = case.feedback
        self.assertEqual((grade.origin, grade.review_id), ("", ""))
        self.assertTrue(is_review_grade(case, grade))
        self.assertEqual(feedback_stats([case])["feedback_count"], 0)
        # Without the history event as well, the grade would count: the lane catches that.
        unmarked = Case.model_validate(_reviewed_case(marker=False, event=False))
        self.assertEqual(feedback_stats([unmarked])["feedback_count"], 1)

    @staticmethod
    def _responses(case: dict) -> dict:
        base = f"/api/cases/{lane.REVIEW_CASE_ID}"
        return {
            ("GET", "/api/feedback/stats"): (200, {"feedback_count": 0}),
            ("POST", f"{base}/review"): (200, {"sampled": True, "review_id": lane.REVIEW_ID, "agrees": True}),
            ("GET", base): (200, case),
            ("POST", f"{base}/files"): (201, {"file": {"id": "file-1"}, "deduplicated": False}),
            ("GET", f"{base}/files"): (200, {"files": [{"id": "file-1"}]}),
            ("GET_BYTES", f"{base}/files/file-1/content"): (200, "image/png", lane.tiny_png()),
        }

    def test_release_n_records_the_review_then_uploads_the_screenshot(self) -> None:
        instance = _bare_lane()
        planted: list[str] = []

        async def plant() -> None:
            planted.append("case and sample")

        instance._plant_review_case = plant  # type: ignore[method-assign]
        boot = _FakeBoot("release-n", self._responses(_reviewed_case()))
        instance.plant_review_case(boot)  # type: ignore[arg-type]
        self.assertEqual(planted, ["case and sample"])
        posts = [call[1] for call in boot.calls if call[0] == "POST"]
        self.assertEqual(posts, [
            f"/api/cases/{lane.REVIEW_CASE_ID}/review", f"/api/cases/{lane.REVIEW_CASE_ID}/files",
        ])
        self.assertEqual(instance.screenshot_id, "file-1")
        self.assertEqual(instance.feedback_baseline, 0)

    def test_release_n_fails_when_the_review_is_not_the_sampled_one(self) -> None:
        instance = _bare_lane()

        async def plant() -> None:
            return None

        instance._plant_review_case = plant  # type: ignore[method-assign]
        responses = self._responses(_reviewed_case())
        responses[("POST", f"/api/cases/{lane.REVIEW_CASE_ID}/review")] = (200, {"sampled": False, "review_id": None})
        with self.assertRaises(lane.LaneFailure):
            instance.plant_review_case(_FakeBoot("release-n", responses))  # type: ignore[arg-type]

    def test_the_return_checks_fail_when_the_grade_counts_or_the_screenshot_is_gone(self) -> None:
        instance = _bare_lane()
        instance.screenshot_id = "file-1"
        instance.feedback_baseline = 0
        good = self._responses(_reviewed_case(marker=False, comment=True))
        instance.assert_review_grade_excluded(_FakeBoot("release-n-again", good))  # type: ignore[arg-type]
        instance.assert_screenshot_served(_FakeBoot("release-n-again", good))  # type: ignore[arg-type]

        counted = dict(good)
        counted[("GET", "/api/feedback/stats")] = (200, {"feedback_count": 1})
        with self.assertRaises(lane.LaneFailure):
            instance.assert_review_grade_excluded(_FakeBoot("release-n-again", counted))  # type: ignore[arg-type]
        no_event = dict(good)
        no_event[("GET", f"/api/cases/{lane.REVIEW_CASE_ID}")] = (200, _reviewed_case(marker=False, event=False))
        with self.assertRaises(lane.LaneFailure):
            instance.assert_review_grade_excluded(_FakeBoot("release-n-again", no_event))  # type: ignore[arg-type]
        gone = dict(good)
        gone[("GET", f"/api/cases/{lane.REVIEW_CASE_ID}/files")] = (200, {"files": []})
        with self.assertRaises(lane.LaneFailure):
            instance.assert_screenshot_served(_FakeBoot("release-n-again", gone))  # type: ignore[arg-type]
        not_png = dict(good)
        not_png[("GET_BYTES", f"/api/cases/{lane.REVIEW_CASE_ID}/files/file-1/content")] = (
            200, "text/html", b"<html>",
        )
        with self.assertRaises(lane.LaneFailure):
            instance.assert_screenshot_served(_FakeBoot("release-n-again", not_png))  # type: ignore[arg-type]

    def test_the_results_say_which_marker_kept_the_grade_excluded(self) -> None:
        dropped = lane.review_marker_note(_reviewed_case(marker=False))
        kept = lane.review_marker_note(_reviewed_case(marker=True))
        self.assertIn("history event alone", dropped)
        self.assertIn("kept its own marker", kept)
        self.assertNotEqual(dropped, kept)
        self.assertIn("review_marker_note(case)", inspect_source(lane.Lane.phase_return))

    def test_each_phase_carries_its_plant_unconditionally(self) -> None:
        """phase_n plants before it stops, phase_previous makes the full save, and
        phase_return asserts both, whatever the forward contract says (SPEC §3.7)."""
        import inspect

        phase_n = inspect.getsource(lane.Lane.phase_n)
        self.assertLess(phase_n.index("self.plant_review_case(boot)"), phase_n.index("self.stop(boot)"))
        previous = inspect.getsource(lane.Lane.phase_previous)
        self.assertIn('f"/api/cases/{REVIEW_CASE_ID}/comment"', previous)
        self.assertLess(previous.index("/comment"), previous.index("self.stop(boot)"))
        back = inspect.getsource(lane.Lane.phase_return)
        for call in ("self.assert_review_grade_excluded(boot)", "self.assert_screenshot_served(boot)"):
            self.assertLess(back.index(call), back.index("self.stop(boot)"))
        self.assertNotIn("forward_contract", phase_n + previous + back)

    def test_the_review_plant_is_written_through_the_sql_case_repository_and_the_ledger(self) -> None:
        import inspect

        source = inspect.getsource(lane.Lane._plant_review_case)
        self.assertIn("SqlCaseRepository(engine)", source)
        self.assertIn("AutoCloseReviewStore(SqlKVStore(engine)).update(add)", source)


# --------------------------------------------------------------------------- #
# Round 16 (SPEC §3.7): recorded risk inputs, ledger rates, an MFA lockout counter
# and the What's new marker.
# --------------------------------------------------------------------------- #
_NOW_ISO = "2026-11-25T12:00:00+00:00"
_LOCKOUT = {"mfa_failed_count": 10, "mfa_locked_until": "2026-11-25T13:00:00+00:00"}


def _plants() -> dict:
    """The Round 16 plant documents as N builds them (skips without the backend)."""
    from datetime import datetime

    try:
        with _Backend():
            return lane.round16_plant_docs(datetime.fromisoformat(_NOW_ISO))
    except ImportError as exc:  # pragma: no cover - the backend's dependencies are absent
        raise unittest.SkipTest(f"the backend's dependencies are not installed ({exc})") from exc


def _expected(docs: dict) -> dict:
    return {
        "factors": docs["factors"], "inputs": docs["inputs"], "cost": docs["cost"],
        "rates": docs["rates"], "lockout": dict(_LOCKOUT), "marker": lane.whats_new_marker(),
    }


def _risk_case(docs: dict, *, inputs: bool = True, comment: bool = False, **changes: object) -> dict:
    case = json.loads(json.dumps(docs["case"]))
    if not inputs:
        case["risk_breakdown"].pop("inputs", None)
    if comment:
        case["comments"] = [{"author": "rollback-lane", "body": lane.RISK_COMMENT}]
    case.update(changes)
    return case


def _stages(basis: str) -> dict:
    return {"stages": [
        {"id": "input", "state": None},
        {"id": "risk", "state": {"risk_calculation": {"weight_basis": basis}}},
    ]}


def _round16_responses(docs: dict, *, recorded: bool, comment: bool, display_name: str,
                       theme: str = "system") -> dict:
    base = f"/api/cases/{lane.RISK_CASE_ID}"
    usage_row = dict(docs["usage"])
    return {
        ("GET", base): (200, _risk_case(docs, inputs=recorded, comment=comment)),
        ("GET", f"{base}/stages"): (200, _stages("recorded_at_scoring" if recorded else "current_preferences")),
        ("GET", f"{base}/usage"): (200, {"rows": [usage_row], "reconciles": True}),
        ("GET", "/api/users"): (200, {"users": [
            {"username": "someone-else", "display_name": ""},
            {"username": lane.LOCKED_USER, "display_name": display_name},
        ]}),
        ("GET", "/api/prefs/user"): (200, {"theme_mode": theme, "misc": {
            lane.WHATS_NEW_SEEN_KEY: lane.whats_new_marker(), lane.WHATS_NEW_AUTO_KEY: False,
        }}),
        ("PUT", "/api/prefs/user"): (200, {}),
        ("POST", f"{base}/comment"): (200, {"ok": True}),
        ("GET", f"/api/usage/summary?case_id={lane.RISK_CASE_ID}&window_hours=24"): (
            200, {"call_count": 1, "total_cost": round(docs["cost"], 6)},
        ),
        ("PUT", f"/api/users/{lane.LOCKED_USER}"): (200, {"ok": True}),
    }


def _round16_lane(docs: dict, *, stored_user: dict | None, previous: Path | None = None) -> "lane.Lane":
    instance = _bare_lane()
    instance.round16 = _expected(docs)
    instance.previous_backend = previous or lane.BACKEND

    async def stored() -> dict | None:
        return stored_user

    instance._stored_user = stored  # type: ignore[method-assign]
    return instance


def _previous_backend(tmp: str, *source_lines: str) -> Path:
    """A previous release's backend whose ``app/models.py`` holds ``source_lines``."""
    backend = Path(tmp) / "backend"
    (backend / "app").mkdir(parents=True)
    (backend / "app" / "models.py").write_text("\n".join(source_lines) + "\n", encoding="utf-8")
    return backend


class Round16PlantTests(unittest.TestCase):
    """SPEC §3.7: N writes the Round 16 fields, N-1 loads and rewrites them, N reads the
    rewritten case as "not recorded" and the losses are exactly the documented ones."""

    def test_the_risk_plant_records_inputs_that_reproduce_its_score(self) -> None:
        docs = _plants()
        with _Backend():
            from app.engine.risk_explain import factors_from_inputs
            from app.models import Case, RiskInputs
        case = Case.model_validate(docs["case"])
        self.assertIsNotNone(case.risk_breakdown.inputs)
        self.assertEqual(case.risk_score, case.risk_breakdown.total)
        self.assertEqual(docs["inputs"]["event_count"], lane.RISK_EVENTS)
        self.assertEqual(docs["inputs"]["rule_values"], list(lane.RISK_RULES))
        self.assertEqual(docs["inputs"]["reputation_source"], "enrichment")
        # Every factor re-derives from the recorded inputs alone (the explanation's use).
        derived = factors_from_inputs(RiskInputs.model_validate(docs["inputs"]))
        for key in lane.RISK_FACTORS:
            # compute_risk rounds each factor and the total once, to 2 decimals.
            self.assertAlmostEqual(derived[key], docs["factors"][key], delta=0.01, msg=key)
        self.assertGreater(docs["factors"]["total"], 0)

    def test_the_usage_plant_carries_its_rates_and_reconciles_with_the_case(self) -> None:
        docs = _plants()
        with _Backend():
            from app.models import UsageDoc
        row = UsageDoc.model_validate(docs["usage"])
        self.assertEqual(row.case_id, lane.RISK_CASE_ID)
        self.assertEqual(set(docs["rates"]), set(lane.USAGE_RATE_FIELDS))
        self.assertTrue(all(value is not None for value in docs["rates"].values()), docs["rates"])
        self.assertEqual(docs["rates"]["price_basis"], "catalog")
        self.assertGreater(row.cost, 0, "a priced row; a free model would prove nothing")
        rederived = round((
            row.prompt_tokens * row.input_rate_per_million
            + row.completion_tokens * row.output_rate_per_million
        ) / 1e6, 8)
        self.assertEqual(rederived, row.cost)
        self.assertEqual(docs["case"]["token_cost"], row.cost)
        with _Backend():
            from app.constants import CASE_PIPELINE_USAGE_ROLES
            from app.models import USAGE_RATE_FIELDS
        self.assertIn(lane.USAGE_ROLE, CASE_PIPELINE_USAGE_ROLES)
        self.assertEqual(tuple(lane.USAGE_RATE_FIELDS), tuple(USAGE_RATE_FIELDS))

    def test_the_lockout_plant_uses_the_threshold_the_second_factor_route_locks_at(self) -> None:
        routes = (ROOT / "backend" / "app" / "api" / "routes.py").read_text(encoding="utf-8")
        self.assertIn(f"MFA_LOCK_THRESHOLD = {lane.LOCKED_USER_FAILURES}\n", routes)
        source = inspect_source(lane.Lane._plant_round16)
        self.assertIn("accounts.record_mfa_failure(", source)
        self.assertIn("UserStore(SqlKVStore(engine))", source)
        self.assertIn("SqlCaseRepository(engine)", source)
        self.assertIn("SqlUsageRepository(engine).write_strict(", source)

    def test_the_marker_is_the_newest_bundled_update_id(self) -> None:
        latest = json.loads((ROOT / "backend" / "app" / "whats_new_latest.json").read_text(encoding="utf-8"))
        self.assertEqual(lane.whats_new_marker(), latest["latest_update_id"])
        with _Backend():
            from app.models import DISMISSED_INTRO_ID_PATTERN, WHATS_NEW_AUTO_PREF_KEY, WHATS_NEW_SEEN_PREF_KEY
        self.assertEqual((lane.WHATS_NEW_SEEN_KEY, lane.WHATS_NEW_AUTO_KEY), (WHATS_NEW_SEEN_PREF_KEY, WHATS_NEW_AUTO_PREF_KEY))
        self.assertEqual(f"^{lane.UPDATE_ID_PATTERN}$", DISMISSED_INTRO_ID_PATTERN)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "latest.json"
            for bad in ({"latest_update_id": "Has Spaces"}, {"latest_update_id": ""}, ["x"]):
                path.write_text(json.dumps(bad), encoding="utf-8")
                with self.assertRaises(ValueError):
                    lane.whats_new_marker(path)

    def test_previous_defines_reads_the_previous_models(self) -> None:
        self.assertTrue(lane.previous_defines(lane.BACKEND, lane.DEFINES_RISK_INPUTS))
        self.assertTrue(lane.previous_defines(lane.BACKEND, lane.DEFINES_MFA_LOCKOUT))
        with tempfile.TemporaryDirectory() as tmp:
            older = _previous_backend(tmp, "class RiskBreakdown(BaseModel):", "    total: float = 0.0")
            self.assertFalse(lane.previous_defines(older, lane.DEFINES_RISK_INPUTS))
            self.assertFalse(lane.previous_defines(older, lane.DEFINES_MFA_LOCKOUT))
        with self.assertRaises(lane.LaneFailure):
            lane.previous_defines(Path("/nonexistent/backend"), lane.DEFINES_RISK_INPUTS)

    def test_the_pinned_release_defines_none_of_the_round16_fields(self) -> None:
        """So the pinned scenario takes the documented-loss path: the case reads "not
        recorded" and the lockout counter resets."""
        import subprocess

        pin = lane.load_pin()
        shown = subprocess.run(
            ["git", "-C", str(ROOT), "show", f"{pin.previous_release}:backend/app/models.py"],
            capture_output=True, text=True,
        )
        if shown.returncode != 0:  # pragma: no cover - a shallow clone without the pin
            self.skipTest("the pinned release is not in this clone")
        with tempfile.TemporaryDirectory() as tmp:
            previous = _previous_backend(tmp, shown.stdout)
            self.assertFalse(lane.previous_defines(previous, lane.DEFINES_RISK_INPUTS))
            self.assertFalse(lane.previous_defines(previous, lane.DEFINES_MFA_LOCKOUT))
            self.assertNotIn("input_rate_per_million", shown.stdout)
            self.assertIn("misc: dict[str, Any]", shown.stdout, "misc is a free dictionary in N-1")

    def test_release_n_serves_every_plant_back(self) -> None:
        docs = _plants()
        stored = {"username": lane.LOCKED_USER, **_LOCKOUT}
        instance = _round16_lane(docs, stored_user=stored)
        good = _round16_responses(docs, recorded=True, comment=False, display_name="")
        boot = _FakeBoot("release-n", good)
        instance.assert_risk_case(boot, recorded=True)  # type: ignore[arg-type]
        instance.assert_usage_rates(boot)  # type: ignore[arg-type]
        instance.assert_locked_user(boot, kept=True, display_name="")  # type: ignore[arg-type]
        instance.assert_marker(boot)  # type: ignore[arg-type]

        base = f"/api/cases/{lane.RISK_CASE_ID}"
        for key, value in (
            (("GET", base), (200, _risk_case(docs, inputs=False))),
            (("GET", f"{base}/stages"), (200, _stages("current_preferences"))),
        ):
            broken = dict(good)
            broken[key] = value
            with self.assertRaises(lane.LaneFailure, msg=str(key)):
                instance.assert_risk_case(_FakeBoot("release-n", broken), recorded=True)  # type: ignore[arg-type]
        unrated = dict(good)
        unrated[("GET", f"{base}/usage")] = (200, {"rows": [{
            k: v for k, v in docs["usage"].items() if k not in lane.USAGE_RATE_FIELDS
        }], "reconciles": True})
        with self.assertRaises(lane.LaneFailure):
            instance.assert_usage_rates(_FakeBoot("release-n", unrated))  # type: ignore[arg-type]
        unlocked = _round16_lane(docs, stored_user={"username": lane.LOCKED_USER, "mfa_failed_count": 0, "mfa_locked_until": ""})
        with self.assertRaises(lane.LaneFailure):
            unlocked.assert_locked_user(_FakeBoot("release-n", good), kept=True, display_name="")  # type: ignore[arg-type]
        no_marker = dict(good)
        no_marker[("GET", "/api/prefs/user")] = (200, {"misc": {}})
        with self.assertRaises(lane.LaneFailure):
            instance.assert_marker(_FakeBoot("release-n", no_marker))  # type: ignore[arg-type]

    def test_release_n_minus_1_reads_each_plant_then_rewrites_them(self) -> None:
        docs = _plants()
        instance = _round16_lane(docs, stored_user=None)
        responses = _round16_responses(docs, recorded=False, comment=False, display_name="")
        boot = _FakeBoot("release-n-1", responses)
        instance.round16_on_previous(boot)  # type: ignore[arg-type]
        writes = [call[:2] for call in boot.calls if call[0] in ("POST", "PUT")]
        self.assertEqual(writes, [
            ("POST", f"/api/cases/{lane.RISK_CASE_ID}/comment"),
            ("PUT", f"/api/users/{lane.LOCKED_USER}"),
            ("PUT", "/api/prefs/user"),
        ])
        bodies = {call[1]: call[2] for call in boot.calls if call[0] in ("POST", "PUT")}
        self.assertEqual(bodies[f"/api/users/{lane.LOCKED_USER}"], {"display_name": lane.LOCKED_USER_DISPLAY_NAME})
        self.assertEqual(bodies["/api/prefs/user"], {"theme_mode": lane.PREVIOUS_THEME})
        self.assertEqual(bodies[f"/api/cases/{lane.RISK_CASE_ID}/comment"]["body"], lane.RISK_COMMENT)

        for key, value in (
            (("GET", f"/api/usage/summary?case_id={lane.RISK_CASE_ID}&window_hours=24"),
             (200, {"call_count": 0, "total_cost": 0.0})),
            (("GET", "/api/users"), (200, {"users": []})),
            (("GET", "/api/prefs/user"), (200, {"misc": {}})),
            (("GET", f"/api/cases/{lane.RISK_CASE_ID}"), (404, {"detail": "Case not found"})),
        ):
            broken = dict(responses)
            broken[key] = value
            with self.assertRaises(lane.LaneFailure, msg=str(key)):
                instance.round16_on_previous(_FakeBoot("release-n-1", broken))  # type: ignore[arg-type]

    def test_release_n_again_reads_the_rewritten_case_as_not_recorded(self) -> None:
        """Against an N-1 that defines none of the fields (the pinned release): the
        inputs are gone, today's weights apply, the score holds; the counter is reset;
        the rates and the marker survive."""
        docs = _plants()
        with tempfile.TemporaryDirectory() as tmp:
            older = _previous_backend(tmp, "class RiskBreakdown(BaseModel):")
            reset = {"username": lane.LOCKED_USER, "mfa_failed_count": 0, "mfa_locked_until": ""}
            instance = _round16_lane(docs, stored_user=reset, previous=older)
            good = _round16_responses(
                docs, recorded=False, comment=True, display_name=lane.LOCKED_USER_DISPLAY_NAME,
                theme=lane.PREVIOUS_THEME,
            )
            lines = instance.assert_round16_return(_FakeBoot("release-n-again", good))  # type: ignore[arg-type]
            self.assertIn("not recorded", lines[0])
            self.assertIn("reset the lockout counter", lines[2])

            base = f"/api/cases/{lane.RISK_CASE_ID}"
            breaks = {
                "inputs survived a rewrite that drops them": (("GET", base), (200, _risk_case(docs, inputs=True, comment=True))),
                "today's weights not used": (("GET", f"{base}/stages"), (200, _stages("recorded_at_scoring"))),
                "the score moved": (("GET", base), (200, _risk_case(docs, inputs=False, comment=True, risk_score=1.0))),
                "N-1's save is missing": (("GET", base), (200, _risk_case(docs, inputs=False))),
                "the rates were lost": (("GET", f"{base}/usage"), (200, {"rows": [{"cost": docs["cost"]}], "reconciles": True})),
                "the marker was lost": (("GET", "/api/prefs/user"), (200, {"theme_mode": "dark", "misc": {}})),
                "N-1's theme is missing": (("GET", "/api/prefs/user"), (200, {"theme_mode": "system", "misc": {
                    lane.WHATS_NEW_SEEN_KEY: lane.whats_new_marker(), lane.WHATS_NEW_AUTO_KEY: False}})),
                "N-1's display name is missing": (("GET", "/api/users"), (200, {"users": [
                    {"username": lane.LOCKED_USER, "display_name": ""}]})),
            }
            for reason, (key, value) in breaks.items():
                broken = dict(good)
                broken[key] = value
                with self.assertRaises(lane.LaneFailure, msg=reason):
                    instance.assert_round16_return(_FakeBoot("release-n-again", broken))  # type: ignore[arg-type]
            kept_counter = _round16_lane(docs, stored_user={"username": lane.LOCKED_USER, **_LOCKOUT}, previous=older)
            with self.assertRaises(lane.LaneFailure, msg="the counter must read reset"):
                kept_counter.assert_round16_return(_FakeBoot("release-n-again", good))  # type: ignore[arg-type]
            gone = _round16_lane(docs, stored_user=None, previous=older)
            with self.assertRaises(lane.LaneFailure, msg="the account must still load"):
                gone.assert_round16_return(_FakeBoot("release-n-again", good))  # type: ignore[arg-type]

    def test_release_n_again_requires_an_n_minus_1_that_defines_a_field_to_keep_it(self) -> None:
        """The self-forward scenario (this checkout as N-1): nothing may be lost."""
        docs = _plants()
        instance = _round16_lane(docs, stored_user={"username": lane.LOCKED_USER, **_LOCKOUT})
        kept = _round16_responses(
            docs, recorded=True, comment=True, display_name=lane.LOCKED_USER_DISPLAY_NAME,
            theme=lane.PREVIOUS_THEME,
        )
        lines = instance.assert_round16_return(_FakeBoot("release-n-again", kept))  # type: ignore[arg-type]
        self.assertIn("kept its recorded inputs", lines[0])
        self.assertIn("survived", lines[2])
        dropped = _round16_responses(
            docs, recorded=False, comment=True, display_name=lane.LOCKED_USER_DISPLAY_NAME,
            theme=lane.PREVIOUS_THEME,
        )
        with self.assertRaises(lane.LaneFailure):
            instance.assert_round16_return(_FakeBoot("release-n-again", dropped))  # type: ignore[arg-type]
        reset = _round16_lane(docs, stored_user={"username": lane.LOCKED_USER, "mfa_failed_count": 0, "mfa_locked_until": ""})
        with self.assertRaises(lane.LaneFailure):
            reset.assert_round16_return(_FakeBoot("release-n-again", kept))  # type: ignore[arg-type]

    def test_each_phase_carries_the_round16_step_unconditionally(self) -> None:
        import inspect

        phase_n = inspect.getsource(lane.Lane.phase_n)
        self.assertLess(phase_n.index("self.plant_round16(boot)"), phase_n.index("self.stop(boot)"))
        self.assertLess(phase_n.index("self.plant_review_case(boot)"), phase_n.index("self.plant_round16(boot)"))
        previous = inspect.getsource(lane.Lane.phase_previous)
        self.assertLess(previous.index("self.round16_on_previous(boot)"), previous.index("self.stop(boot)"))
        back = inspect.getsource(lane.Lane.phase_return)
        self.assertLess(back.index("self.assert_round16_return(boot)"), back.index("self.stop(boot)"))
        self.assertIn("self.results.extend(round16)", back)
        self.assertNotIn("forward_contract", phase_n + previous + back)
        plant = inspect.getsource(lane.Lane.plant_round16)
        for call in ("self.assert_risk_case(boot, recorded=True)", "self.assert_usage_rates(boot)",
                     "self.assert_locked_user(boot, kept=True", "self.assert_marker(boot)"):
            self.assertIn(call, plant)

    def test_the_plant_is_written_through_n_and_the_marker_through_its_route(self) -> None:
        docs = _plants()
        instance = _round16_lane(docs, stored_user={"username": lane.LOCKED_USER, **_LOCKOUT})
        expected = _expected(docs)
        planted: list[str] = []

        async def plant() -> dict:
            planted.append("stores")
            return {key: expected[key] for key in ("factors", "inputs", "cost", "rates", "lockout")}

        instance._plant_round16 = plant  # type: ignore[method-assign]
        boot = _FakeBoot("release-n", _round16_responses(docs, recorded=True, comment=False, display_name=""))
        instance.plant_round16(boot)  # type: ignore[arg-type]
        self.assertEqual(planted, ["stores"])
        puts = [call for call in boot.calls if call[0] == "PUT"]
        self.assertEqual(puts, [("PUT", "/api/prefs/user", {"misc": {
            lane.WHATS_NEW_SEEN_KEY: lane.whats_new_marker(), lane.WHATS_NEW_AUTO_KEY: False,
        }})])
        self.assertEqual(instance.round16["marker"], lane.whats_new_marker())


if __name__ == "__main__":
    unittest.main()
