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


if __name__ == "__main__":
    unittest.main()
