#!/usr/bin/env python3
"""The N to N-1 rollback acceptance lane, on PostgreSQL.

An image-only rollback (this release N back to the previous release N-1) is the
documented recovery path, so N-1 must boot healthy on the data N wrote. This lane
proves it against a real PostgreSQL server:

1. Boot release N (this checkout's backend) on a fresh scratch database and write the
   data N introduces: an ``audit_export`` job record (a job run to completion), the
   migrated runbook corpus (``runbook-library:`` documents) and ``runbooks.*``
   preferences an operator changed (``investigator_guidance`` and ``auto_attach`` off).
   Stop it gracefully.
2. Boot release N-1 (the commit pinned in ``scripts/rollback_previous_release.json``,
   materialised with ``git archive``) on that exact data and assert: no safe-stop;
   ``/api/health`` and ``/api/health/ready`` answer 200 with no RAG degradation; its
   RAG projection is not refused and serves runbook documents; repeated retrievals do
   not re-embed the corpus; the operator's ``runbooks.*`` choices read back. Stop it
   gracefully (its shutdown rewrites the preferences document).
3. Boot release N again and assert the ``runbooks.*`` choices survived the round trip.

Round 15 (SPEC §3.7) adds, unconditionally: in step 1, a terminal case the AI agent
closed is written through the SQL case repository with a pending auto-close review
sample, then N records a review of it (a review grade, excluded from
``/api/feedback/stats``) and uploads a screenshot to it. In step 2, N-1 makes a full save
of that case (``POST /api/cases/{id}/comment``), which drops the fields it does not know
from the grade (``origin``, ``review_id``) but keeps the case history. In step 3, N
asserts that the grade stays excluded (the history marker alone identifies it) and that
the screenshot still lists and serves.

With ``"forward_contract": true`` in the pin file (set it once N-1 is a release that
carries the forward-compatibility contract: tolerated unknown job kinds, preserved
unknown preference keys, corpus-migration markers), the lane also plants synthetic
FUTURE data after step 1 (a job of a kind no release knows, unknown preference keys, a
marker-identified corpus under a newer id scheme) and asserts N-1 tolerates and
preserves it.

The default run has two scenarios, each on its own scratch database:

* ``pinned``: the steps above with the pinned release as N-1;
* ``self-forward``: the same steps with THIS checkout as N-1 and the synthetic future
  data always planted. This gates this build's own forward contract (it is the next
  release's N-1), so reverting it fails the lane even while the pinned release is one
  that natively understands everything N writes.

``--previous-release`` or ``--previous-backend`` runs that one rehearsal instead, and
``--pinned-only`` skips the self-forward scenario.

Every boot is a real ``uvicorn app.main:app`` process (auth off, mock model, no
Elasticsearch, no Redis). Each boot's log is kept in the work directory and printed on
failure. The lane creates and drops its own scratch database; nothing is written to
the database the URL names.

Usage (from the repository root, in the backend's Python environment)::

    python scripts/rollback_lane.py \\
        --database-url postgresql+asyncpg://tlsoc:password@127.0.0.1:5432/tlsoc

Exit status 0 when every assertion holds, 1 otherwise. A previous release whose
``backend/requirements.txt`` differs from this checkout's gets its own virtual
environment (``pip install`` needs the package index), unless ``--previous-python``
names one.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import re
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
PIN_FILE = Path(__file__).resolve().parent / "rollback_previous_release.json"

READY_TIMEOUT_S = 180.0
STOP_TIMEOUT_S = 90.0
JOB_TIMEOUT_S = 120.0
#: Log lines that fail the lane wherever they appear.
SAFE_STOP_MARKERS = (
    "entering safe-stop",
    "started in factory-reset recovery safe-stop",
)
REFUSAL_MARKERS = ("RAG projection REFUSED", "RAG vector-space migration REFUSED")
SEEDED_MARKER = "RAG seeded with"
#: The operator's runbook choices the lane sets on N and expects back.
RUNBOOK_CHOICES = {"investigator_guidance": False, "auto_attach": False}
#: Synthetic future data (``forward_contract``).
FUTURE_KIND = "rollback_lane_future_kind"
FUTURE_SECTION = "rollback_lane_future_section"
FUTURE_RUNBOOK_KEY = "rollback_lane_future_switch"
FUTURE_SCHEME = "runbook-rollback-lane-future:"
FUTURE_CHUNKS = 300
#: The Round 15 plants (SPEC §3.7): a terminal agent-closed case in the review sample.
REVIEW_CASE_ID = "case-rollback-lane-review"
REVIEW_CASE_NUMBER = "CASE-ROLLBACK-LANE"
REVIEW_ID = "acr-rollback-lane"
REVIEW_EVENT = "auto_close_review"
SCREENSHOT_CAPTION = "Rollback lane screenshot"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


class LaneFailure(AssertionError):
    """One lane assertion failed."""


@dataclass(frozen=True)
class Pin:
    previous_release: str
    forward_contract: bool


def load_pin(path: Path = PIN_FILE) -> Pin:
    """The pinned previous release. The SHA must be a full 40-character commit id."""
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path.name} must hold a JSON object")
    sha = str(data.get("previous_release") or "")
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError(f"{path.name}: previous_release must be a full 40-character commit id")
    forward = data.get("forward_contract", False)
    if not isinstance(forward, bool):
        raise ValueError(f"{path.name}: forward_contract must be true or false")
    return Pin(previous_release=sha, forward_contract=forward)


def scratch_url(database_url: str, database: str) -> str:
    """``database_url`` naming ``database`` instead (credentials kept)."""
    from sqlalchemy.engine import make_url

    return make_url(database_url).set(database=database).render_as_string(hide_password=False)


def scan_log(text: str) -> dict[str, int]:
    """Counts of the lines the lane judges a boot by."""
    lines = text.splitlines()
    return {
        "safe_stop": sum(1 for line in lines if any(m in line for m in SAFE_STOP_MARKERS)),
        "refused": sum(1 for line in lines if any(m in line for m in REFUSAL_MARKERS)),
        "seeded": sum(1 for line in lines if SEEDED_MARKER in line),
    }


def audit_export_body(key: str, *, now: float | None = None) -> dict[str, Any]:
    """An ``audit_export`` submit body covering everything written so far."""
    instant = time.gmtime(now if now is not None else time.time() + 60)
    return {
        "kind": "audit_export",
        "idempotency_key": key,
        "params": {
            "format": "jsonl",
            "scope": "all",
            "from": "2000-01-01T00:00:00Z",
            "to": time.strftime("%Y-%m-%dT%H:%M:%SZ", instant),
        },
    }


def tiny_png(width: int = 2, height: int = 2) -> bytes:
    """A small, valid RGB PNG built with the standard library (the screenshot plant)."""

    def chunk(kind: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(kind + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", crc)

    rows = b"".join(b"\x00" + b"\x1f\x6f\xd0" * width for _ in range(height))
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return PNG_SIGNATURE + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")


def screenshot_body() -> dict[str, Any]:
    """A ``POST /api/cases/{id}/files`` body the backend accepts."""
    return {
        "data_base64": base64.b64encode(tiny_png()).decode("ascii"),
        "content_type": "image/png",
        "thumbnail_base64": None,
        "filename": "rollback-lane.png",
        "caption": SCREENSHOT_CAPTION,
    }


def review_body() -> dict[str, Any]:
    """A ``POST /api/cases/{id}/review`` body: the reviewer agrees with the AI."""
    return {"classification": "false_positive", "note": "", "elapsed_ms": 1000}


def review_case_doc(now_iso: str) -> dict[str, Any]:
    """The terminal case the AI agent closed (first decision record an agent close)."""
    return {
        "case_id": REVIEW_CASE_ID,
        "case_number": REVIEW_CASE_NUMBER,
        "title": "Rollback lane: an automatic close in the review sample",
        "cluster_signature": "sig-rollback-lane-review",
        "source_surface": "automated_scan",
        "rule_ids": ["rollback-lane-rule"],
        "entity": {"type": "ip", "value": "198.51.100.7"},
        "verdict": "FALSE_POSITIVE",
        "confidence": 0.93,
        "risk_score": 12.0,
        "status": "closed",
        "decision_by": "agent",
        "disposition": "false_positive",
        "created_at": now_iso,
        "updated_at": now_iso,
        "status_history": [{"from_status": "new", "to_status": "closed", "by": "agent", "at": now_iso}],
        "history": [{
            "ts": now_iso, "event": "decision", "status": "closed", "decision_by": "agent",
            "escalate": False, "rationale": "FALSE_POSITIVE auto-closed",
        }],
    }


def review_events(case: dict[str, Any]) -> list[dict[str, Any]]:
    """The case's ``auto_close_review`` history events (the rollback-safe marker)."""
    return [
        event for event in (case.get("history") or [])
        if isinstance(event, dict) and event.get("event") == REVIEW_EVENT
    ]


def check(condition: bool, message: str) -> None:
    if not condition:
        raise LaneFailure(message)


def _backend_on_path() -> None:
    """Make this checkout's backend importable (the planting and reading helpers)."""
    if str(BACKEND) not in sys.path:
        sys.path.insert(0, str(BACKEND))


# --------------------------------------------------------------------------- #
# Processes and HTTP
# --------------------------------------------------------------------------- #
def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


#: The backends listen on loopback: never route those requests through a proxy.
_LOCAL = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _http(method: str, url: str, body: Any = None, timeout: float = 30.0) -> tuple[int, Any]:
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("Accept", "application/json")
    if data is not None:
        request.add_header("Content-Type", "application/json")
    try:
        with _LOCAL.open(request, timeout=timeout) as response:
            raw = response.read()
            status = response.status
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        status = exc.code
    try:
        return status, json.loads(raw.decode("utf-8") or "null")
    except ValueError:
        return status, raw.decode("utf-8", "replace")


@dataclass
class Boot:
    label: str
    process: subprocess.Popen[bytes]
    port: int
    log_path: Path
    log_handle: Any = field(repr=False)

    @property
    def base(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def get(self, path: str) -> tuple[int, Any]:
        return _http("GET", self.base + path)

    def put(self, path: str, body: Any) -> tuple[int, Any]:
        return _http("PUT", self.base + path, body)

    def post(self, path: str, body: Any) -> tuple[int, Any]:
        return _http("POST", self.base + path, body)

    def get_bytes(self, path: str) -> tuple[int, str, bytes]:
        """A raw read (status, content type, bytes): a screenshot's content."""
        request = urllib.request.Request(self.base + path, method="GET")
        try:
            with _LOCAL.open(request, timeout=30.0) as response:
                return response.status, response.headers.get("Content-Type", ""), response.read()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.headers.get("Content-Type", "") if exc.headers else "", exc.read()

    def log(self) -> str:
        if not self.log_handle.closed:
            self.log_handle.flush()
        return self.log_path.read_text(encoding="utf-8", errors="replace")


class Lane:
    def __init__(self, args: argparse.Namespace, pin: Pin) -> None:
        self.args = args
        self.pin = pin
        self.work = Path(args.work_dir or tempfile.mkdtemp(prefix="rollback-lane-")).resolve()
        self.work.mkdir(parents=True, exist_ok=True)
        self.database = f"tlsoc_rollback_lane_{uuid.uuid4().hex[:12]}"
        self.url = scratch_url(args.database_url, self.database)
        self.previous_backend = (
            Path(args.previous_backend).resolve() if args.previous_backend
            else self.work / "previous" / "backend"
        )
        self.previous_python = args.previous_python or ""
        self.boots: list[Boot] = []
        self.results: list[str] = []
        #: The Round 15 plants: the screenshot's id and the feedback count before the review.
        self.screenshot_id = ""
        self.feedback_baseline = -1

    # ----- set-up ------------------------------------------------------ #
    def materialise_previous(self) -> None:
        if self.args.previous_backend:
            # A rehearsal against a backend directory (for example this checkout,
            # to exercise the forward contract before it ships in a release).
            self.previous_python = self.previous_python or sys.executable
            return
        sha = self.pin.previous_release
        probe = subprocess.run(
            ["git", "-C", str(ROOT), "cat-file", "-e", f"{sha}^{{commit}}"],
            capture_output=True,
        )
        if probe.returncode != 0:
            subprocess.run(
                ["git", "-C", str(ROOT), "fetch", "--no-tags", "--depth=1", "origin", sha],
                check=True,
            )
        target = self.work / "previous"
        if target.exists():
            shutil.rmtree(target)
        target.mkdir(parents=True)
        archive = subprocess.run(
            ["git", "-C", str(ROOT), "archive", "--format=tar", sha, "backend"],
            check=True, capture_output=True,
        )
        archive_path = self.work / "previous.tar"
        archive_path.write_bytes(archive.stdout)
        with tarfile.open(archive_path) as bundle:
            try:
                bundle.extractall(target, filter="data")
            except TypeError:  # Python without extraction filters
                bundle.extractall(target)  # noqa: S202 - our own git archive
        archive_path.unlink()
        if self.previous_python:
            return
        previous_requirements = (self.previous_backend / "requirements.txt").read_bytes()
        if previous_requirements == (BACKEND / "requirements.txt").read_bytes():
            self.previous_python = sys.executable
            return
        venv = self.work / "venv-previous"
        subprocess.run([sys.executable, "-m", "venv", str(venv)], check=True)
        python = venv / "bin" / "python"
        subprocess.run(
            [str(python), "-m", "pip", "install", "--quiet", "--requirement",
             str(self.previous_backend / "requirements.txt")],
            check=True,
        )
        self.previous_python = str(python)

    async def _admin(self, statement: str) -> None:
        from sqlalchemy import text
        from sqlalchemy.ext.asyncio import create_async_engine

        engine = create_async_engine(self.args.database_url, isolation_level="AUTOCOMMIT")
        try:
            async with engine.connect() as conn:
                await conn.execute(text(statement))
        finally:
            await engine.dispose()

    def create_database(self) -> None:
        asyncio.run(self._admin(f'CREATE DATABASE "{self.database}"'))

    def drop_database(self) -> None:
        asyncio.run(self._admin(f'DROP DATABASE IF EXISTS "{self.database}" WITH (FORCE)'))

    # ----- boots ------------------------------------------------------- #
    def boot(self, label: str, backend: Path, python: str) -> Boot:
        port = _free_port()
        env = {
            key: value for key, value in os.environ.items()
            if not key.endswith("_API_KEY") and not key.startswith(("STATE_", "POSTGRES_"))
        }
        env.update({
            "STATE_BACKEND": "postgres",
            "STATE_DB_URL": self.url,
            "REDIS_URL": "",
            "ES_STORE_ENABLED": "false",
            "AUTH_ENABLED": "false",
            "LOG_LEVEL": "INFO",
            "JOBS_ARTIFACT_DIR": str(self.work / "job-artifacts"),
            "PYTHONDONTWRITEBYTECODE": "1",
        })
        log_path = self.work / f"{len(self.boots) + 1:02d}-{label}.log"
        handle = log_path.open("wb")
        process = subprocess.Popen(
            [python, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(port)],
            cwd=str(backend), env=env, stdout=handle, stderr=subprocess.STDOUT,
        )
        boot = Boot(label=label, process=process, port=port, log_path=log_path, log_handle=handle)
        self.boots.append(boot)
        deadline = time.monotonic() + READY_TIMEOUT_S
        last: Any = None
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise LaneFailure(f"{label}: the backend exited during startup ({process.returncode})")
            if scan_log(boot.log())["safe_stop"]:
                raise LaneFailure(f"{label}: the backend entered safe-stop")
            try:
                status, body = boot.get("/api/health/ready")
                last = (status, body)
                if status == 200 and isinstance(body, dict) and body.get("ready") is True:
                    self.results.append(f"{label}: ready")
                    return boot
            except OSError as exc:
                last = exc
            time.sleep(0.5)
        raise LaneFailure(f"{label}: /api/health/ready did not answer 200 ({last!r})")

    def stop(self, boot: Boot) -> None:
        """A graceful stop (the shutdown path an operator's rollback takes)."""
        if boot.process.poll() is None:
            boot.process.send_signal(signal.SIGTERM)
            try:
                boot.process.wait(timeout=STOP_TIMEOUT_S)
            except subprocess.TimeoutExpired:
                boot.process.kill()
                boot.process.wait()
                raise LaneFailure(f"{boot.label}: the backend did not stop gracefully")
        boot.log_handle.close()

    # ----- assertions -------------------------------------------------- #
    def assert_healthy(self, boot: Boot) -> None:
        status, ready = boot.get("/api/health/ready")
        check(status == 200 and ready.get("ready") is True, f"{boot.label}: not ready ({status} {ready})")
        status, health = boot.get("/api/health")
        check(status == 200, f"{boot.label}: /api/health answered {status}")
        check(health.get("status") == "ok", f"{boot.label}: health status {health.get('status')!r}")
        reasons = list(health.get("degraded_reasons") or [])
        check("rag_projection_refused" not in reasons, f"{boot.label}: RAG projection refused")
        check(scan_log(boot.log())["safe_stop"] == 0, f"{boot.label}: safe-stop in the log")

    def runbook_documents(self, boot: Boot) -> list[dict[str, Any]]:
        status, body = boot.get("/api/rag/documents")
        check(status == 200, f"{boot.label}: /api/rag/documents answered {status}")
        return [d for d in body.get("documents", []) if d.get("source") == "runbook"]

    def assert_runbook_choices(self, boot: Boot) -> None:
        status, settings = boot.get("/api/settings")
        check(status == 200, f"{boot.label}: /api/settings answered {status}")
        runbooks = (settings.get("prefs") or settings).get("runbooks") or {}
        for key, value in RUNBOOK_CHOICES.items():
            check(runbooks.get(key) is value, f"{boot.label}: runbooks.{key} is {runbooks.get(key)!r}, expected {value!r}")

    def assert_no_reembedding(self, boot: Boot, documents: list[dict[str, Any]]) -> None:
        """Retrievals serve runbook passages and, after the first projection, never
        re-embed the corpus. The queries are runbook titles from the corpus listing,
        so they match under any embedding (the lane runs on the local fallback)."""
        titles = [str(d.get("title") or "") for d in documents if d.get("title")][:3]
        check(bool(titles), f"{boot.label}: the runbook documents have no titles")
        for title in titles:
            query = urllib.parse.quote(title)
            status, body = boot.get(f"/api/rag/search?q={query}&top_k=20")
            check(status == 200, f"{boot.label}: /api/rag/search answered {status}")
            sources = {str(chunk.get("source")) for chunk in (body or {}).get("chunks", [])}
            check("runbook" in sources, f"{boot.label}: no runbook passage was served for {title!r}")
        counts = scan_log(boot.log())
        check(counts["refused"] == 0, f"{boot.label}: a RAG projection was refused")
        check(counts["seeded"] <= 1, f"{boot.label}: the corpus was projected {counts['seeded']} times")

    def feedback_count(self, boot: Boot) -> int:
        status, stats = boot.get("/api/feedback/stats")
        check(status == 200 and isinstance(stats, dict), f"{boot.label}: /api/feedback/stats answered {status}")
        return int(stats.get("feedback_count") or 0)

    def review_case(self, boot: Boot) -> dict[str, Any]:
        status, case = boot.get(f"/api/cases/{REVIEW_CASE_ID}")
        check(status == 200 and isinstance(case, dict), f"{boot.label}: the review case answered {status}")
        return case

    def assert_review_grade_excluded(self, boot: Boot) -> None:
        """The review grade is on the case, marked by its history event, and left out of
        the agreement view (D6.7, D6.8)."""
        case = self.review_case(boot)
        grades = list(case.get("feedback") or [])
        check(len(grades) == 1, f"{boot.label}: the review case holds {len(grades)} grades, expected 1")
        events = review_events(case)
        check(
            len(events) == 1 and events[0].get("review_id") == REVIEW_ID
            and events[0].get("feedback_ts") == grades[0].get("ts"),
            f"{boot.label}: the review history event does not name the grade ({events})",
        )
        count = self.feedback_count(boot)
        check(
            count == self.feedback_baseline,
            f"{boot.label}: /api/feedback/stats counts {count} grades, expected {self.feedback_baseline} (the review excluded)",
        )

    def assert_screenshot_served(self, boot: Boot) -> None:
        status, listing = boot.get(f"/api/cases/{REVIEW_CASE_ID}/files")
        check(status == 200 and isinstance(listing, dict), f"{boot.label}: the screenshot list answered {status}")
        ids = [str(entry.get("id")) for entry in listing.get("files") or []]
        check(ids == [self.screenshot_id], f"{boot.label}: the screenshot list is {ids}, expected [{self.screenshot_id}]")
        status, kind, data = boot.get_bytes(f"/api/cases/{REVIEW_CASE_ID}/files/{self.screenshot_id}/content")
        check(status == 200, f"{boot.label}: the screenshot content answered {status}")
        check(kind.startswith("image/png"), f"{boot.label}: the screenshot was served as {kind!r}")
        check(data.startswith(PNG_SIGNATURE), f"{boot.label}: the screenshot content is not the PNG uploaded")

    def plant_review_case(self, boot: Boot) -> None:
        """SPEC §3.7 on release N: the agent-closed case and its pending sample, written
        directly (the case repository and the ledger's compare-and-set), then a review
        and a screenshot through N's own API."""
        asyncio.run(self._plant_review_case())
        self.feedback_baseline = self.feedback_count(boot)
        status, result = boot.post(f"/api/cases/{REVIEW_CASE_ID}/review", review_body())
        check(status == 200, f"release-n: the review answered {status} {result}")
        check(
            result.get("sampled") is True and result.get("review_id") == REVIEW_ID,
            f"release-n: the review was not recorded as the sampled review ({result})",
        )
        case = self.review_case(boot)
        grades = list(case.get("feedback") or [])
        check(
            len(grades) == 1 and grades[0].get("origin") == REVIEW_EVENT and grades[0].get("review_id") == REVIEW_ID,
            f"release-n: the review grade carries no marker ({grades})",
        )
        check(case.get("status") == "closed" and case.get("decision_by") == "agent",
              "release-n: the review changed the case's status or decider")
        status, upload = boot.post(f"/api/cases/{REVIEW_CASE_ID}/files", screenshot_body())
        check(status in (200, 201), f"release-n: the screenshot upload answered {status} {upload}")
        self.screenshot_id = str(((upload or {}).get("file") or {}).get("id") or "")
        check(bool(self.screenshot_id), f"release-n: the upload named no file ({upload})")
        self.assert_review_grade_excluded(boot)
        self.assert_screenshot_served(boot)

    async def _plant_review_case(self) -> None:
        _backend_on_path()
        from datetime import datetime, timezone  # noqa: PLC0415

        from app.models import Case  # noqa: PLC0415
        from app.stores.auto_close_review import AutoCloseReviewStore, ReviewEntry  # noqa: PLC0415
        from app.stores.sql import SqlKVStore, build_async_engine  # noqa: PLC0415
        from app.stores.sql.repositories import SqlCaseRepository  # noqa: PLC0415

        now = datetime.now(timezone.utc)
        engine = build_async_engine(self.url)
        try:
            repository = SqlCaseRepository(engine)
            # Written as stored data, never announced on a bus (no process listens here).
            repository.publishes_case_events = False
            await repository.save(Case.model_validate(review_case_doc(now.isoformat())))
            entry = ReviewEntry(
                review_id=REVIEW_ID, case_id=REVIEW_CASE_ID, case_number=REVIEW_CASE_NUMBER,
                rule="rollback-lane-rule", sampled_at=now.isoformat(), day=now.date().isoformat(),
                score=0.0, ai_verdict="FALSE_POSITIVE",
            )

            def add(ledger: Any) -> Any:
                if ledger.entry_for_case(REVIEW_CASE_ID) is not None:
                    return None
                ledger.add(entry, now=now, expiry_days=7)
                return ledger

            await AutoCloseReviewStore(SqlKVStore(engine)).update(add)
        finally:
            await engine.dispose()

    # ----- the phases -------------------------------------------------- #
    def phase_n(self) -> None:
        boot = self.boot("release-n", BACKEND, sys.executable)
        self.assert_healthy(boot)
        status, body = boot.put("/api/settings", {"runbooks": dict(RUNBOOK_CHOICES)})
        check(status == 200, f"release-n: settings write answered {status} {body}")
        status, job = boot.post("/api/jobs", audit_export_body(f"rollback-lane-{uuid.uuid4().hex}"))
        check(status in (200, 201, 202), f"release-n: audit export submit answered {status} {job}")
        job_id = str(job.get("job_id") or "")
        deadline = time.monotonic() + JOB_TIMEOUT_S
        state = ""
        while time.monotonic() < deadline:
            status, detail = boot.get(f"/api/jobs/{job_id}")
            state = str((detail or {}).get("status") or "") if status == 200 else ""
            if state in ("succeeded", "partial", "failed", "cancelled"):
                break
            time.sleep(0.5)
        check(state == "succeeded", f"release-n: the audit export ended {state or 'unfinished'}")
        documents = self.runbook_documents(boot)
        check(
            bool(documents) and all(str(d["document_id"]).startswith("runbook-library:") for d in documents),
            "release-n: the runbook corpus is not the migrated runbook-library corpus",
        )
        self.assert_runbook_choices(boot)
        self.plant_review_case(boot)
        self.stop(boot)
        self.results.append("release-n: wrote an audit export, the migrated corpus and runbook settings")
        self.results.append("release-n: recorded an auto-close review and a screenshot on an agent-closed case")

    def phase_previous(self) -> None:
        boot = self.boot("release-n-1", self.previous_backend, self.previous_python)
        self.assert_healthy(boot)
        status, _jobs = boot.get("/api/jobs")
        check(status == 200, f"release-n-1: /api/jobs answered {status}")
        documents = self.runbook_documents(boot)
        check(bool(documents), "release-n-1: the corpus holds no runbook documents")
        self.assert_no_reembedding(boot, documents)
        self.assert_healthy(boot)
        self.assert_runbook_choices(boot)
        # A full save of the reviewed case by a build that does not know the grade's
        # Round 15 fields (SPEC §3.7): it keeps the history, not the unknown fields.
        status, saved = boot.post(
            f"/api/cases/{REVIEW_CASE_ID}/comment",
            {"author": "rollback-lane", "body": "Saved again by the previous release."},
        )
        check(status == 200, f"release-n-1: the comment on the review case answered {status} {saved}")
        self.stop(boot)
        self.results.append("release-n-1: healthy on release N data; corpus served; settings intact")
        self.results.append("release-n-1: made a full save of the reviewed case")

    def phase_return(self) -> None:
        boot = self.boot("release-n-again", BACKEND, sys.executable)
        self.assert_healthy(boot)
        self.assert_runbook_choices(boot)
        case = self.review_case(boot)
        comments = [str(c.get("body") or "") for c in case.get("comments") or []]
        check(
            "Saved again by the previous release." in comments,
            "release-n again: the previous release's save of the review case is missing",
        )
        self.assert_review_grade_excluded(boot)
        self.assert_screenshot_served(boot)
        self.stop(boot)
        self.results.append("release-n again: the runbook settings survived the round trip")
        self.results.append("release-n again: the review grade stays excluded; the screenshot lists and serves")

    # ----- synthetic future data (forward_contract) -------------------- #
    async def _plant_future(self) -> dict[str, Any]:
        _backend_on_path()
        from app.config import Preferences  # noqa: PLC0415
        from app.llm.providers import _hash_embed  # noqa: PLC0415
        from app.stores.rag_corpus_migration import encode_marker  # noqa: PLC0415
        from app.stores.sql import SqlKVStore, SqlVectorStore, build_async_engine  # noqa: PLC0415
        from app.tools.vectorstore import StoredChunk  # noqa: PLC0415

        engine = build_async_engine(self.url)
        try:
            kv = SqlKVStore(engine)
            registry = await kv.get("jobs", "jobs") or {"jobs": {}, "idempotency": {}, "factory_fence": ""}
            record = {
                "job_id": "job-rollback-lane-future",
                "kind": FUTURE_KIND,
                "actor": "",
                "actor_generation": "",
                "created_at": "2030-01-01T00:00:00+00:00",
                "finished_at": "2030-01-01T00:00:01+00:00",
                "status": "succeeded",
                "request_fingerprint": "f" * 64,
                "idempotency_key_hash": "e" * 64,
                "params": {"future": True},
                "a_field_only_a_future_build_has": [1, 2],
            }
            registry["jobs"][record["job_id"]] = record
            registry["idempotency"][record["idempotency_key_hash"]] = record["job_id"]
            await kv.put("jobs", "jobs", registry)
            prefs = await kv.get("config", "preferences") or {}
            prefs[FUTURE_SECTION] = {"enabled": True}
            prefs.setdefault("runbooks", {})[FUTURE_RUNBOOK_KEY] = "on"
            await kv.put("config", "preferences", prefs)
            await kv.put("rag_corpus_migration", "runbook", encode_marker({
                "contract": 1, "source": "runbook", "scheme": FUTURE_SCHEME,
                "replaced": ["runbook-library:", "runbook:", "seed:runbook"],
            }))
            store = SqlVectorStore(engine)
            for document in await store.list_documents():
                if document.get("source") == "runbook":
                    await store.delete_document(str(document["document_id"]))
            model = Preferences().model_for("embedding").model
            await store.add([
                StoredChunk(
                    text=f"future runbook passage {index}", source="runbook",
                    metadata={"document_id": f"{FUTURE_SCHEME}doc-{index // 4}"},
                    embedding=_hash_embed(f"future runbook passage {index}"),
                    embedding_model=model, dim=256,
                    doc_id=f"{FUTURE_SCHEME}doc-{index // 4}:{index % 4}",
                )
                for index in range(FUTURE_CHUNKS)
            ])
            return record
        finally:
            await engine.dispose()

    async def _stored(self, namespace: str, key: str) -> Any:
        _backend_on_path()
        from app.stores.sql import SqlKVStore, build_async_engine  # noqa: PLC0415

        engine = build_async_engine(self.url)
        try:
            return await SqlKVStore(engine).get(namespace, key)
        finally:
            await engine.dispose()

    def assert_future_preserved(self, record: dict[str, Any]) -> None:
        registry = asyncio.run(self._stored("jobs", "jobs")) or {}
        kept = (registry.get("jobs") or {}).get(record["job_id"])
        check(
            json.dumps(kept, sort_keys=True) == json.dumps(record, sort_keys=True),
            "release-n-1: the future job record was not preserved byte-stable",
        )
        prefs = asyncio.run(self._stored("config", "preferences")) or {}
        check(prefs.get(FUTURE_SECTION) == {"enabled": True}, "release-n-1: a future preference section was dropped")
        check(
            (prefs.get("runbooks") or {}).get(FUTURE_RUNBOOK_KEY) == "on",
            "release-n-1: a future runbook preference was dropped",
        )
        self.results.append("release-n-1: synthetic future data tolerated and preserved")

    # ----- the run ----------------------------------------------------- #
    def run(self) -> int:
        previous = self.args.previous_backend or self.pin.previous_release
        print(f"rollback lane: N-1 = {previous}; work = {self.work}")
        try:
            self.materialise_previous()
        except (OSError, subprocess.CalledProcessError) as exc:
            print(f"rollback lane FAILED: the previous release could not be prepared: {exc}", file=sys.stderr)
            return 1
        self.create_database()
        try:
            self.phase_n()
            future = asyncio.run(self._plant_future()) if self.pin.forward_contract else None
            self.phase_previous()
            if future is not None:
                self.assert_future_preserved(future)
            self.phase_return()
            for boot in self.boots:
                counts = scan_log(boot.log_path.read_text(encoding="utf-8", errors="replace"))
                check(counts["refused"] == 0, f"{boot.label}: a RAG projection was refused")
                check(counts["safe_stop"] == 0, f"{boot.label}: safe-stop in the log")
        except Exception as exc:  # noqa: BLE001 - every failure prints the boot logs
            print(f"rollback lane FAILED: {type(exc).__name__}: {exc}", file=sys.stderr)
            for boot in self.boots:
                if boot.process.poll() is None:
                    boot.process.kill()
                    boot.process.wait()
                print(f"----- {boot.log_path.name} -----", file=sys.stderr)
                print(boot.log_path.read_text(encoding="utf-8", errors="replace")[-20000:], file=sys.stderr)
            return 1
        finally:
            for boot in self.boots:
                if boot.process.poll() is None:
                    boot.process.kill()
                    boot.process.wait()
                if not boot.log_handle.closed:
                    boot.log_handle.close()
            if not self.args.keep_database:
                self.drop_database()
        for line in self.results:
            print(f"  ok  {line}")
        print("rollback lane passed")
        return 0


def plan_scenarios(
    args: argparse.Namespace, pin: Pin
) -> list[tuple[str, argparse.Namespace, Pin]]:
    """The scenarios one run executes: ``(name, args, pin)``. A rehearsal flag runs
    just that rehearsal; otherwise the pinned scenario and the self-forward one (this
    checkout as N-1 on synthetic future data), unless ``--pinned-only``. Each
    scenario gets its own work directory under ``--work-dir`` when one is given."""

    def scoped(name: str, **changes: Any) -> argparse.Namespace:
        values = dict(vars(args))
        if args.work_dir:
            values["work_dir"] = str(Path(args.work_dir) / name)
        values.update(changes)
        return argparse.Namespace(**values)

    if args.previous_backend or args.previous_release:
        return [("rehearsal", args, pin)]
    if args.pinned_only:
        return [("pinned", args, pin)]
    return [
        ("pinned", scoped("pinned"), pin),
        (
            "self-forward",
            scoped("self-forward", previous_backend=str(BACKEND)),
            Pin(previous_release=pin.previous_release, forward_contract=True),
        ),
    ]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "--database-url",
        default=os.environ.get("POSTGRES_TEST_DB_URL", ""),
        help="an admin PostgreSQL URL (postgresql+asyncpg://...) used only to create "
             "and drop a scratch database (default: POSTGRES_TEST_DB_URL)",
    )
    parser.add_argument("--work-dir", help="where the previous release and the boot logs go")
    parser.add_argument("--previous-python", help="the interpreter for the previous release")
    parser.add_argument("--keep-database", action="store_true", help="keep the scratch database")
    parser.add_argument(
        "--previous-release",
        help="boot this commit as N-1 instead of the pinned one (a rehearsal; the CI "
             "lane always uses the pin)",
    )
    parser.add_argument(
        "--previous-backend",
        help="boot this backend directory as N-1 instead of a commit (a rehearsal)",
    )
    parser.add_argument(
        "--forward-contract", action="store_true",
        help="plant and check the synthetic future data even if the pin says false",
    )
    parser.add_argument(
        "--pinned-only", action="store_true",
        help="skip the self-forward scenario (this checkout as N-1 on synthetic future "
             "data); the CI lane runs both",
    )
    args = parser.parse_args(argv)
    if not str(args.database_url).startswith("postgresql"):
        parser.error("--database-url (or POSTGRES_TEST_DB_URL) must name a PostgreSQL server")
    pin = load_pin()
    if args.previous_release:
        if not re.fullmatch(r"[0-9a-f]{40}", args.previous_release):
            parser.error("--previous-release must be a full 40-character commit id")
        pin = Pin(previous_release=args.previous_release, forward_contract=pin.forward_contract)
    if args.forward_contract:
        pin = Pin(previous_release=pin.previous_release, forward_contract=True)
    failed: list[str] = []
    for name, scenario_args, scenario_pin in plan_scenarios(args, pin):
        print(f"rollback lane scenario: {name}")
        if Lane(scenario_args, scenario_pin).run() != 0:
            failed.append(name)
    if failed:
        print(f"rollback lane FAILED in: {', '.join(failed)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
