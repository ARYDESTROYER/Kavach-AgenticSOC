"""Deterministic playbook selection + an atomic, hot-reloadable registry.

``select_playbook`` is a PURE function: given a cluster and a list of playbooks it
returns the single best match and a short, explainable reason. A playbook matches
iff ALL of its PRESENT (non-empty) criteria are satisfied; absent criteria do not
constrain. Among matches we pick deterministically by:
``priority`` (desc) → ``version`` (desc) → ``id`` (asc).

``PlaybookRegistry`` wraps a directory and reloads atomically: it loads into a temp
list and only swaps the live set on success, so a broken file can never replace a
good live set (validate-then-swap).
"""

from __future__ import annotations

import logging
import os
import re
import tempfile
import threading
from pathlib import Path

from ..models import Cluster
from .loader import load_playbooks, parse_playbook
from .manifest import MAX_PLAYBOOK_PROMPT_CHARS, Playbook, render_playbook_prompt

logger = logging.getLogger("tlsoc.playbooks.registry")

_NO_MATCH = "no_playbook_matched"

# These files ship with the application and are reference procedures, not mutable
# operator state.  An operator can view them (or copy their Markdown into a new
# operator-owned id), but the management API never overwrites them.  A configured
# override directory contains operator files only, so this protection is applied
# by ``AppState`` solely when the registry points at the packaged default directory.
DEFAULT_BUNDLED_PLAYBOOK_FILES = frozenset(
    {
        "brute_force_login.md",
        "phishing_reported_email.md",
        "suspicious_outbound_connection.md",
        "web_application_abuse.md",
        "privileged_web_access.md",
        "web_scanner_activity.md",
        "cloud_identity_compromise.md",
        "data_exfiltration_response.md",
        "ransomware_response.md",
    }
)

MAX_PLAYBOOK_BYTES = 256 * 1024
_PLAYBOOK_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_RESERVED_PLAYBOOK_IDS = frozenset({"readme", "index"})


class PlaybookManagementError(ValueError):
    """Base class for safe operator-file management failures."""


class PlaybookConflictError(PlaybookManagementError):
    """The requested id/path already exists and must not be overwritten."""


class PlaybookProtectedError(PlaybookManagementError):
    """A mutation targeted a packaged, read-only playbook."""


class PlaybookNotFoundError(PlaybookManagementError):
    """A requested playbook is not loaded."""


def _cluster_rule_set(cluster: Cluster) -> set[str]:
    """The cluster's rule identifiers: declared rule values + the primary rule."""
    # Source products occasionally pad rule names (the live export contains one
    # such family).  Whitespace is not semantic, but case and punctuation are:
    # selection remains an exact, deterministic contract after trimming edges.
    rules: set[str] = {str(r).strip() for r in (cluster.rule_values or []) if str(r).strip()}
    primary = cluster.primary_rule()
    if primary:
        rules.add(str(primary).strip())
    return rules


def diagnose_playbook(cluster: Cluster, playbook: Playbook) -> dict[str, object]:
    """Explain every declared match criterion for one playbook.

    This is deliberately the same deterministic predicate as selection.  It is
    suitable for dry-run/coverage UI and never calls an LLM or mutates state.
    """
    rule_set = _cluster_rule_set(cluster)
    rule_set_l = {r.lower() for r in rule_set}
    entity_type = cluster.entity.type.value
    count = cluster.count
    match = playbook.manifest.match
    checks: list[dict[str, object]] = []

    def add(criterion: str, passed: bool, expected: object, actual: object, reason: str) -> None:
        checks.append({
            "criterion": criterion,
            "passed": passed,
            "expected": expected,
            "actual": actual,
            "reason": reason,
        })

    hard_passed = True
    if match.rule_ids:
        expected = sorted({str(value).strip() for value in match.rule_ids if str(value).strip()})
        intersection = sorted(set(expected).intersection(rule_set))
        passed = bool(intersection)
        hard_passed = hard_passed and passed
        add("rule_ids", passed, expected, sorted(rule_set),
            f"matched exact rule(s): {', '.join(intersection)}" if passed else "no exact rule id matched")
    if match.entity_types:
        expected = sorted(set(match.entity_types))
        passed = entity_type in expected
        hard_passed = hard_passed and passed
        add("entity_types", passed, expected, entity_type,
            f"entity type {entity_type!r} matched" if passed else f"entity type {entity_type!r} is not allowed")
    if match.min_event_count is not None:
        passed = count >= match.min_event_count
        hard_passed = hard_passed and passed
        add("min_event_count", passed, match.min_event_count, count,
            f"event count {count} meets minimum" if passed else f"event count {count} is below minimum")

    soft_hit = False
    if match.mitre:
        hits = sorted({value for value in match.mitre if value.lower() in rule_set_l})
        soft_hit = soft_hit or bool(hits)
        add("mitre", bool(hits), sorted(match.mitre), sorted(rule_set),
            f"advisory signal(s): {', '.join(hits)}" if hits else "advisory signal unavailable before investigation")
    if match.any_tags:
        hits = sorted({value for value in match.any_tags if value.lower() in rule_set_l})
        soft_hit = soft_hit or bool(hits)
        add("any_tags", bool(hits), sorted(match.any_tags), sorted(rule_set),
            f"advisory tag(s): {', '.join(hits)}" if hits else "advisory tag unavailable before investigation")

    no_hard = not (match.rule_ids or match.entity_types or match.min_event_count is not None)
    declared_soft = bool(match.mitre or match.any_tags)
    matched = hard_passed and not (no_hard and declared_soft and not soft_hit)
    if not checks:
        checks.append({
            "criterion": "unconstrained",
            "passed": True,
            "expected": None,
            "actual": None,
            "reason": "playbook declares no match constraints",
        })
    return {
        "playbook_id": playbook.id,
        "playbook_name": playbook.name,
        "priority": playbook.manifest.priority,
        "version": playbook.manifest.version,
        "matched": matched,
        "checks": checks,
        "failed_criteria": [c["criterion"] for c in checks if not c["passed"] and c["criterion"] not in {"mitre", "any_tags"}],
    }


def selection_diagnostics(cluster: Cluster, playbooks: list[Playbook]) -> dict[str, object]:
    """Return the selected procedure plus bounded, ordered no-match evidence."""
    rows = [diagnose_playbook(cluster, playbook) for playbook in playbooks]
    selected, reason = select_playbook(cluster, playbooks)
    rows.sort(
        key=lambda row: (
            not bool(row["matched"]),
            -int(row["priority"]),
            -int(row["version"]),
            str(row["playbook_id"]),
        )
    )
    return {
        "selected_playbook_id": selected.id if selected else None,
        "selection_reason": reason,
        "matched_count": sum(1 for row in rows if row["matched"]),
        "candidate_count": len(rows),
        "candidates": rows,
    }


def select_playbook(cluster: Cluster, playbooks: list[Playbook]) -> tuple[Playbook | None, str]:
    """Pick the best-matching playbook for ``cluster``, or ``(None, reason)``.

    DETERMINISTIC. A criterion that is empty / ``None`` does not constrain:

    * ``rule_ids`` (any-of): intersect with the cluster rule set
      (``set(cluster.rule_values) | {cluster.primary_rule()}``, dropping ``None``).
    * ``entity_types`` (any-of): must contain ``cluster.entity.type.value``.
    * ``min_event_count``: ``cluster.count >= min_event_count``.
    * ``mitre`` / ``any_tags`` (any-of): clusters carry no MITRE/tags before
      investigation, so these match OPPORTUNISTICALLY against the (lowercased)
      cluster rule set — i.e. a rule named like a technique/tag still matches.

    Ties resolve by ``priority`` desc, then ``version`` desc, then ``id`` asc.
    """
    rule_set = _cluster_rule_set(cluster)
    rule_set_l = {r.lower() for r in rule_set}
    entity_type = cluster.entity.type.value
    count = cluster.count

    candidates: list[tuple[Playbook, str]] = []
    for pb in playbooks:
        m = pb.manifest.match
        reasons: list[str] = []

        if m.rule_ids:
            inter = {str(r).strip() for r in m.rule_ids if str(r).strip() in rule_set}
            if not inter:
                continue
            reasons.append("rule_ids∩{" + ",".join(sorted(inter)) + "}")

        if m.entity_types:
            if entity_type not in m.entity_types:
                continue
            reasons.append(f"entity_type={entity_type}")

        if m.min_event_count is not None:
            if count < m.min_event_count:
                continue
            reasons.append(f"count{count}>={m.min_event_count}")

        # mitre / any_tags are ADVISORY signals, NOT hard constraints: clusters carry
        # no MITRE techniques or tags at selection time (those come from the verdict,
        # AFTER investigation), so requiring them would make every technique-tagged
        # playbook unmatchable. They opportunistically BOOST the reason when a rule
        # name happens to carry the signal, but never exclude a rule/entity/count
        # match. (Deviation from the brief's "all-of" wording, forced by the real
        # pre-investigation cluster shape — documented in the module docstring.)
        if m.mitre:
            inter = {t for t in m.mitre if t.lower() in rule_set_l}
            if inter:
                reasons.append("mitre~{" + ",".join(sorted(inter)) + "}")

        if m.any_tags:
            inter = {t for t in m.any_tags if t.lower() in rule_set_l}
            if inter:
                reasons.append("tags~{" + ",".join(sorted(inter)) + "}")

        # A playbook whose ONLY declared criteria are the soft mitre/tags signals,
        # with no opportunistic hit, must not match everything by default — exclude
        # it. (A FULLY-unconstrained playbook with NO criteria at all still matches
        # everything, per the "absent criteria don't constrain" rule.)
        no_hard = not (m.rule_ids or m.entity_types or m.min_event_count is not None)
        declared_soft = bool(m.mitre or m.any_tags)
        if no_hard and declared_soft and not reasons:
            continue

        reason = "matched " + ("; ".join(reasons) if reasons else "unconstrained")
        reason += f"; priority={pb.manifest.priority}"
        candidates.append((pb, reason))

    if not candidates:
        return None, _NO_MATCH

    # priority desc, version desc, id asc — fully deterministic.
    candidates.sort(key=lambda pr: (-pr[0].manifest.priority, -pr[0].manifest.version, pr[0].manifest.id))
    return candidates[0]


class PlaybookRegistry:
    """A directory-backed registry of playbooks with atomic hot reload."""

    def __init__(
        self,
        directory: Path,
        *,
        protected_filenames: frozenset[str] | set[str] | None = None,
    ) -> None:
        self._directory = Path(directory)
        self._playbooks: list[Playbook] = []
        self._protected_filenames = frozenset(protected_filenames or ())
        # Reload and file replacement form one process-local transaction.  RLock is
        # intentional because create/update call reload while already holding it.
        self._lock = threading.RLock()

    def reload(self) -> dict:
        """Reload from disk ATOMICALLY (validate-then-swap).

        Loads into a temp list; only swaps the live set if loading succeeded. A
        broken file is skipped (and reported in ``skipped``) but never replaces a
        good live set. Returns a summary
        ``{"loaded": int, "skipped": [{"file","reason"}], "ids": [...]}``.
        """
        with self._lock:
            skipped: list[dict[str, str]] = []
            try:
                base = self._directory
                md_files = (
                    [p for p in sorted(base.glob("*.md")) if p.stem.lower() not in {"readme", "index"}]
                    if base.is_dir()
                    else []
                )
                loaded = load_playbooks(base)
                loaded_paths = {pb.source_path for pb in loaded}
                for path in md_files:
                    if str(path) not in loaded_paths:
                        skipped.append({"file": path.name, "reason": "invalid_or_unparseable"})
            except Exception as exc:  # noqa: BLE001 — never let a reload crash the caller
                logger.warning("Playbook reload failed for %s: %s", self._directory, exc)
                return {
                    "loaded": len(self._playbooks),
                    # The summary is an API response as well as an internal result.
                    # Keep filesystem paths and raw OS exception text in the log only.
                    "skipped": [{"file": "<playbook-directory>", "reason": "reload_failed"}],
                    "ids": [pb.id for pb in self._playbooks],
                }

            # Validate-then-swap: the live set only changes after a clean load.
            self._playbooks = loaded
            return {
                "loaded": len(loaded),
                "skipped": skipped,
                "ids": [pb.id for pb in loaded],
            }

    def load(self) -> dict:
        """Alias for ``reload`` (initial load)."""
        return self.reload()

    def all(self) -> list[Playbook]:
        with self._lock:
            return list(self._playbooks)

    def get(self, id: str) -> Playbook | None:
        with self._lock:
            for pb in self._playbooks:
                if pb.id == id:
                    return pb
        return None

    # ------------------------------------------------------------- management

    def metadata(self, playbook: Playbook) -> dict[str, object]:
        """Return non-sensitive file ownership metadata for the API catalog.

        Full server paths are deliberately never returned.  ``editable`` reflects
        both ownership and directory replace permission; the mutation path repeats
        every check and remains authoritative if filesystem permissions change.
        """
        path = self._safe_existing_source(playbook)
        protected = path.name in self._protected_filenames
        directory_writable = self._directory_writeable()
        return {
            "source_type": "bundled" if protected else "operator",
            "protected": protected,
            "editable": bool(not protected and directory_writable),
            "file_name": path.name,
        }

    def read_document(self, playbook_id: str) -> tuple[Playbook, str]:
        """Read one loaded Markdown document after path-containment checks."""
        with self._lock:
            playbook = self.get(playbook_id)
            if playbook is None:
                raise PlaybookNotFoundError(playbook_id)
            path = self._safe_existing_source(playbook)
            try:
                raw = path.read_bytes()
            except OSError as exc:
                raise PlaybookManagementError("playbook file could not be read") from exc
            if len(raw) > MAX_PLAYBOOK_BYTES:
                raise PlaybookManagementError(
                    f"playbook exceeds the {MAX_PLAYBOOK_BYTES // 1024} KiB management limit"
                )
            try:
                return playbook, raw.decode("utf-8")
            except UnicodeDecodeError as exc:
                raise PlaybookManagementError("playbook must be UTF-8 Markdown") from exc

    def create_operator(self, playbook_id: str, content: str) -> tuple[Playbook, dict]:
        """Atomically create one operator-owned ``<id>.md`` and hot-reload it."""
        with self._lock:
            self._validate_id(playbook_id)
            self._validate_content_size(content)
            self._ensure_directory()
            target = self._safe_target(playbook_id)
            if target.exists() or self.get(playbook_id) is not None:
                raise PlaybookConflictError(f"playbook {playbook_id!r} already exists")
            candidate = self._parse_candidate(playbook_id, content, target)
            self._atomic_write(target, content)
            try:
                summary = self.reload()
                loaded = self.get(playbook_id)
                if loaded is None or self._safe_existing_source(loaded) != target:
                    raise PlaybookManagementError("new playbook did not load cleanly")
                return loaded, summary
            except Exception:
                # The file did not exist before this transaction; a failed reload is
                # rolled back so disk and the live registry stay aligned.
                try:
                    target.unlink(missing_ok=True)
                finally:
                    self.reload()
                raise

    def update_operator(self, playbook_id: str, content: str) -> tuple[Playbook, dict]:
        """Atomically replace one editable operator Markdown file and hot-reload."""
        with self._lock:
            self._validate_id(playbook_id)
            self._validate_content_size(content)
            current = self.get(playbook_id)
            if current is None:
                raise PlaybookNotFoundError(playbook_id)
            target = self._safe_existing_source(current)
            if target.name in self._protected_filenames:
                raise PlaybookProtectedError(f"playbook {playbook_id!r} is bundled and read-only")
            if not self._directory_writeable():
                raise PlaybookProtectedError("the configured playbook directory is read-only")
            self._parse_candidate(playbook_id, content, target)
            try:
                previous = target.read_text(encoding="utf-8")
            except OSError as exc:
                raise PlaybookManagementError("playbook file could not be read") from exc
            self._atomic_write(target, content)
            try:
                summary = self.reload()
                loaded = self.get(playbook_id)
                if loaded is None or self._safe_existing_source(loaded) != target:
                    raise PlaybookManagementError("updated playbook did not load cleanly")
                return loaded, summary
            except Exception:
                # Restore the exact previous document atomically if anything between
                # replacement and validate/reload fails.
                try:
                    self._atomic_write(target, previous)
                finally:
                    self.reload()
                raise

    def _resolved_directory(self) -> Path:
        return self._directory.expanduser().resolve(strict=False)

    def _ensure_directory(self) -> Path:
        root = self._resolved_directory()
        try:
            root.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise PlaybookManagementError("configured playbook directory is not writable") from exc
        if not root.is_dir():
            raise PlaybookManagementError("configured playbook path is not a directory")
        return root

    def _directory_writeable(self) -> bool:
        root = self._resolved_directory()
        return root.is_dir() and os.access(root, os.W_OK)

    def _safe_target(self, playbook_id: str) -> Path:
        root = self._resolved_directory()
        raw_target = root / f"{playbook_id}.md"
        if raw_target.is_symlink():
            raise PlaybookManagementError("symbolic-link playbook targets are not editable")
        target = raw_target.resolve(strict=False)
        try:
            target.relative_to(root)
        except ValueError as exc:
            raise PlaybookManagementError("playbook path escapes the configured directory") from exc
        return target

    def _safe_existing_source(self, playbook: Playbook) -> Path:
        if not playbook.source_path:
            raise PlaybookManagementError("playbook has no managed source file")
        root = self._resolved_directory()
        source = Path(playbook.source_path)
        if source.is_symlink():
            raise PlaybookManagementError("symbolic-link playbook sources are not manageable")
        path = source.resolve(strict=False)
        try:
            path.relative_to(root)
        except ValueError as exc:
            raise PlaybookManagementError("playbook source escapes the configured directory") from exc
        return path

    @staticmethod
    def _validate_id(playbook_id: str) -> None:
        if not isinstance(playbook_id, str) or _PLAYBOOK_ID_RE.fullmatch(playbook_id) is None:
            raise PlaybookManagementError(
                "playbook id must be a lowercase slug (letters, numbers, '_' or '-', max 64)"
            )
        if playbook_id in _RESERVED_PLAYBOOK_IDS:
            raise PlaybookManagementError(
                f"playbook id {playbook_id!r} is reserved for directory documentation"
            )

    @staticmethod
    def _validate_content_size(content: str) -> None:
        if not isinstance(content, str) or not content.strip():
            raise PlaybookManagementError("playbook Markdown is required")
        if "\x00" in content:
            raise PlaybookManagementError("playbook Markdown may not contain NUL bytes")
        if len(content.encode("utf-8")) > MAX_PLAYBOOK_BYTES:
            raise PlaybookManagementError(
                f"playbook exceeds the {MAX_PLAYBOOK_BYTES // 1024} KiB management limit"
            )

    @staticmethod
    def _parse_candidate(playbook_id: str, content: str, target: Path) -> Playbook:
        candidate = parse_playbook(content, fallback_id=playbook_id, source_path=str(target))
        if candidate is None:
            raise PlaybookManagementError("playbook front matter is invalid")
        if candidate.id != playbook_id:
            raise PlaybookManagementError(
                f"front-matter id {candidate.id!r} must match {playbook_id!r}"
            )
        prompt_chars = len(render_playbook_prompt(candidate))
        if prompt_chars > MAX_PLAYBOOK_PROMPT_CHARS:
            raise PlaybookManagementError(
                "playbook trusted procedure exceeds the "
                f"{MAX_PLAYBOOK_PROMPT_CHARS}-character prompt budget "
                f"({prompt_chars} characters); shorten the procedure or advisory fields"
            )
        return candidate

    def _atomic_write(self, target: Path, content: str) -> None:
        root = self._ensure_directory()
        fd = -1
        tmp_path: Path | None = None
        try:
            fd, tmp_name = tempfile.mkstemp(
                prefix=f".{target.name}.", suffix=".tmp", dir=str(root)
            )
            tmp_path = Path(tmp_name)
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
                fd = -1
                handle.write(content)
                if not content.endswith("\n"):
                    handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(tmp_path, 0o640)
            os.replace(tmp_path, target)
        except OSError as exc:
            raise PlaybookManagementError("playbook file could not be written atomically") from exc
        finally:
            if fd >= 0:
                os.close(fd)
            if tmp_path is not None and tmp_path.exists():
                tmp_path.unlink(missing_ok=True)

    def select(self, cluster: Cluster) -> tuple[Playbook | None, str]:
        return select_playbook(cluster, self.all())

    def diagnose(self, cluster: Cluster) -> dict[str, object]:
        """Deterministic selection/no-match evidence for operator dry-runs."""
        return selection_diagnostics(cluster, self.all())

    async def run(
        self, pipeline, cluster, source_surface, prefs, playbook_id: str, *, query_source=...
    ):
        """Manually RUN a specific playbook on a case (F10) — CONTEXT-ONLY.

        Re-investigates ``cluster`` through the SHARED pipeline with ``playbook_id``
        FORCED as the injected TRUSTED operator procedure (reusing the reinvestigate
        + playbook-injection path). It does NOT bypass the decision: the forced
        playbook can still only RECOMMEND, and ``case_manager.decide()`` makes the
        close/escalate call exactly as for an auto-selected playbook (#3).

        Raises ``KeyError`` when ``playbook_id`` is unknown so the caller can 404.
        Returns the updated :class:`app.models.Case`."""
        if self.get(playbook_id) is None:
            raise KeyError(playbook_id)
        kwargs = {"force": True, "force_playbook_id": playbook_id}
        if query_source is not ...:
            kwargs["query_source"] = query_source
        return await pipeline.investigate_cluster(
            cluster, source_surface, prefs, **kwargs
        )
