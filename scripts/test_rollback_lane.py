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


if __name__ == "__main__":
    unittest.main()
