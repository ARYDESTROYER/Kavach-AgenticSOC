"""Merged immutable bundled + durable operator playbook catalog."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from ..stores.playbooks import (
    PlaybookStore,
    PlaybookStoreConflict,
    PlaybookStoreNotFound,
    PlaybookStoreRevisionConflict,
)
from .loader import parse_playbook
from .manifest import MAX_PLAYBOOK_PROMPT_CHARS, Playbook, render_playbook_prompt
from .registry import (
    PlaybookConflictError,
    PlaybookManagementError,
    PlaybookNotFoundError,
    PlaybookProtectedError,
    PlaybookRegistry,
)

logger = logging.getLogger("tlsoc.playbooks.durable")


class DurablePlaybookRegistry(PlaybookRegistry):
    """Registry-compatible cache backed by a strict-CAS operator store.

    Selection remains synchronous/pure over an atomically replaced in-memory
    snapshot. Management refreshes that snapshot only after the state write is
    confirmed, so the pipeline never observes a half-written catalog.
    """

    def __init__(self, directory: Path, store: PlaybookStore, *, protected_filenames) -> None:
        self.store = store
        self._operator_rows: dict[str, dict[str, Any]] = {}
        self._bundled: list[Playbook] = []
        #: Operator ids displaced by a BUNDLED id of the same name. ``create_durable``
        #: refuses a colliding id, so this set is only ever populated the other way
        #: round — by a release that ADDS or RENAMES a bundled playbook onto an id an
        #: operator already held. Tracked (not merely logged) because every ownership
        #: answer below has to agree that the live procedure is the bundled one.
        self._shadowed: list[str] = []
        super().__init__(directory, protected_filenames=protected_filenames)

    def _bundled_ids(self) -> set[str]:
        return {playbook.id for playbook in self._bundled}

    def _operator_row(self, playbook_id: str) -> dict[str, Any] | None:
        """The operator row that OWNS ``playbook_id``, or ``None``.

        A row whose id collides with a bundled playbook owns nothing: ``_merge_snapshot``
        drops it from the live set, so the procedure that actually runs under that id is
        the bundled one. Keying ownership off ``_operator_rows`` alone made the registry
        contradict itself — reporting a bundled procedure as operator-owned and editable,
        serving the shadowed Markdown from ``read_document``, and accepting a ``PUT``
        that changed nothing. Every ownership question routes through here instead.
        """
        if playbook_id in self._bundled_ids():
            return None
        return self._operator_rows.get(playbook_id)

    def reload(self) -> dict:
        """Reload packaged files, then re-apply the last durable operator snapshot."""
        summary = super().reload()
        self._bundled = super().all()
        self._merge_snapshot()
        return {
            **summary,
            "loaded": len(self._playbooks),
            "ids": [playbook.id for playbook in self._playbooks],
            # Reported, not just logged: an operator whose procedure was displaced by an
            # upgrade needs to SEE it. A log line reaches nobody who is looking at the
            # catalog. Always present (usually empty) so a consumer can rely on the key.
            "shadowed_by_bundled": list(self._shadowed),
            "storage": "state",
        }

    def _merge_snapshot(self) -> None:
        bundled_ids = self._bundled_ids()
        operator: list[Playbook] = []
        invalid: list[str] = []
        # Kept apart from ``invalid``: a shadowed row is not malformed. It is a
        # perfectly valid operator document that a bundled id of the same name now
        # outranks, and conflating the two hid an upgrade-time displacement inside a
        # warning about "invalid" content.
        shadowed: list[str] = []
        for playbook_id, row in sorted(self._operator_rows.items()):
            if playbook_id in bundled_ids:
                shadowed.append(playbook_id)
                continue
            content = str(row.get("content") or "")
            playbook = parse_playbook(
                content, fallback_id=playbook_id, source_path=f"state:{playbook_id}"
            )
            if (
                playbook is None
                or playbook.id != playbook_id
                or len(render_playbook_prompt(playbook)) > MAX_PLAYBOOK_PROMPT_CHARS
            ):
                invalid.append(playbook_id)
                continue
            operator.append(playbook)
        if invalid:
            logger.warning("Ignoring invalid durable playbooks: %s", ", ".join(invalid))
        if shadowed:
            logger.warning(
                "Operator playbook(s) shadowed by a bundled id of the same name and "
                "NOT running: %s. The bundled procedure is authoritative for these ids; "
                "the stored document is retained but inert.",
                ", ".join(shadowed),
            )
        with self._lock:
            self._playbooks = [*self._bundled, *operator]
            self._shadowed = shadowed

    async def refresh(self) -> dict:
        """Load the confirmed operator state and atomically publish the merged set."""
        rows = await self.store.list()
        with self._lock:
            self._operator_rows = rows
        summary = self.reload()
        summary["operator_count"] = len(rows)
        return summary

    def metadata(self, playbook: Playbook) -> dict[str, object]:
        row = self._operator_row(playbook.id)
        if row is None:
            meta: dict[str, object] = {
                "source_type": "bundled",
                "protected": True,
                "editable": False,
                "file_name": Path(playbook.source_path).name,
                "revision": 1,
                "storage": "package",
            }
            if playbook.id in self._operator_rows:
                # Additive, and only ever set on a bundled entry: the operator's own
                # document under this id exists but is inert. Surfaced so the Console
                # can explain why an id they authored is suddenly read-only, instead of
                # silently presenting the bundled procedure as their own.
                meta["shadowed_operator_document"] = True
            return meta
        return {
            "source_type": "operator",
            "protected": False,
            "editable": True,
            "file_name": f"{playbook.id}.md",
            "revision": int(row.get("revision", 1) or 1),
            "created_at": str(row.get("created_at") or ""),
            "updated_at": str(row.get("updated_at") or ""),
            "created_by": str(row.get("created_by") or ""),
            "updated_by": str(row.get("updated_by") or ""),
            "storage": "state",
        }

    def read_document(self, playbook_id: str) -> tuple[Playbook, str]:
        playbook = self.get(playbook_id)
        if playbook is None:
            raise PlaybookNotFoundError(playbook_id)
        # ``_operator_row`` (not ``_operator_rows``): under a shadowed id this used to
        # pair the operator's Markdown with the BUNDLED parsed object, so the editor
        # showed content that was not what ran.
        row = self._operator_row(playbook_id)
        if row is not None:
            return playbook, str(row.get("content") or "")
        return super().read_document(playbook_id)

    def _validated_candidate(self, playbook_id: str, content: str) -> Playbook:
        self._validate_id(playbook_id)
        self._validate_content_size(content)
        # Reuse the exact file-registry domain validator; the synthetic path is
        # never opened or returned and only supplies parser provenance.
        return self._parse_candidate(playbook_id, content, Path(f"{playbook_id}.md"))

    async def create_durable(
        self, playbook_id: str, content: str, *, actor: str
    ) -> tuple[Playbook, dict]:
        self._validated_candidate(playbook_id, content)
        if self.get(playbook_id) is not None:
            raise PlaybookConflictError(f"playbook {playbook_id!r} already exists")
        try:
            await self.store.create(playbook_id, content, actor=actor)
        except PlaybookStoreConflict as exc:
            raise PlaybookConflictError(f"playbook {playbook_id!r} already exists") from exc
        except ValueError as exc:
            raise PlaybookManagementError(str(exc)) from exc
        summary = await self.refresh()
        playbook = self.get(playbook_id)
        if playbook is None:  # confirmed storage must also become a valid live entry
            raise PlaybookManagementError("stored playbook did not load cleanly")
        return playbook, summary

    async def update_durable(
        self,
        playbook_id: str,
        content: str,
        *,
        actor: str,
        expected_revision: int,
    ) -> tuple[Playbook, dict]:
        self._validated_candidate(playbook_id, content)
        current = self.get(playbook_id)
        if current is None:
            raise PlaybookNotFoundError(playbook_id)
        # A shadowed id fails LOUDLY here. Keying off ``_operator_rows`` let the update
        # proceed: it wrote the store, consumed the CAS revision, audited an "updated
        # operator playbook" that never happened, and returned the unchanged BUNDLED
        # playbook with HTTP 200.
        if self._operator_row(playbook_id) is None:
            raise PlaybookProtectedError(f"playbook {playbook_id!r} is bundled and read-only")
        try:
            await self.store.update(
                playbook_id,
                content,
                actor=actor,
                expected_revision=expected_revision,
            )
        except PlaybookStoreNotFound as exc:
            raise PlaybookNotFoundError(playbook_id) from exc
        except PlaybookStoreRevisionConflict as exc:
            raise PlaybookConflictError(
                "playbook changed since it was opened; reload before saving"
            ) from exc
        except ValueError as exc:
            raise PlaybookManagementError(str(exc)) from exc
        summary = await self.refresh()
        playbook = self.get(playbook_id)
        if playbook is None:
            raise PlaybookManagementError("stored playbook did not load cleanly")
        return playbook, summary
