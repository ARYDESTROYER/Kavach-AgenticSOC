"""Per-USER personal-preferences store — pervasive customization (Wave 7).

A user's PERSONAL preferences (saved views, per-table column state, theme mode,
last-used list state, pinned default-view ids, a small misc bag) live here, keyed
by ``user_id``. When auth is OFF there is no principal, so everything lands in the
``default`` bucket — the no-auth profile still gets real, persisted customization.

Backend-agnostic by construction (the same JSON-in-KV pattern as
:mod:`app.stores.memory`): the WHOLE set of buckets is ONE KV document
(``ns="user_prefs"``, ``key="buckets"``) persisted through the existing
:class:`KVStore` abstraction — so it needs NO new ES index / SQL table / migration.
The SQL backend uses ``SqlKVStore`` (the shared KV table); the ES backend uses the
thin :class:`app.stores.memory.EsKVStore` adapter (a doc in the existing config
index).

The two-store customization model: ORG defaults live on
``Preferences.customization`` (admin-only PUT) and PERSONAL prefs live HERE. A
cascade resolver (:func:`resolve_effective_prefs`) merges ``ORG ← USER`` so a user
override always wins, while org-shared saved views remain visible to everyone.

Reads + writes are read-modify-write over the single buckets dict — fine at our
scale (per-user UI config, not log volume). The store NEVER raises: a load/save
failure degrades to an empty bucket / best-effort write and is logged, so a prefs
glitch can never break a page.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Callable, TypeVar

from ..constants import USER_PREFS_DEFAULT_BUCKET, USER_PREFS_KEY, USER_PREFS_NS
from ..models import ColumnState, SavedView, UserPrefs
from ..utils import iso_now
from .base import KVStore, kv_mutate

_T = TypeVar("_T")

logger = logging.getLogger("tlsoc.stores.user_prefs")


def normalize_user_id(user_id: str | None) -> str:
    """Resolve a principal to a bucket key. Empty / None → the shared ``default``
    bucket (the no-auth profile). Lowercased + trimmed so the same identity maps to
    one bucket regardless of case (mirrors the user store's username normalisation)."""
    uid = (user_id or "").strip().lower()
    return uid or USER_PREFS_DEFAULT_BUCKET


class UserPrefsStore:
    """CRUD over the per-user personal-preferences buckets, persisted as one KV doc.

    The KV value is ``{"buckets": {"<user_id>": <UserPrefs json>, ...}}``. Methods
    are read-modify-write; none raises (a failure logs + returns a safe default).
    Every method keys on a NORMALISED user_id so ``'default'`` (auth off) and a real
    username are treated identically."""

    def __init__(self, kv: KVStore) -> None:
        self._kv = kv
        # Per-store lock serialising the read-modify-write of the shared prefs doc
        # (lost-update safe; see :func:`app.stores.base.kv_mutate`). Every mutating
        # method routes through :meth:`_mutate` so two concurrent writers (e.g. a
        # theme patch racing a saved-view add) never silently clobber each other.
        self._lock = asyncio.Lock()

    @staticmethod
    def _decode(doc: dict | None) -> dict[str, UserPrefs]:
        raw = doc.get("buckets", {}) if isinstance(doc, dict) else {}
        out: dict[str, UserPrefs] = {}
        for uid, item in (raw or {}).items():
            try:
                out[str(uid)] = UserPrefs.model_validate(item)
            except Exception:  # noqa: BLE001 — skip a single corrupt bucket, keep the rest
                continue
        return out

    @staticmethod
    def _encode(buckets: dict[str, UserPrefs]) -> dict:
        return {"buckets": {uid: p.model_dump(mode="json") for uid, p in buckets.items()}}

    async def _load_all(self) -> dict[str, UserPrefs]:
        try:
            doc = await self._kv.get(USER_PREFS_NS, USER_PREFS_KEY)
        except Exception as exc:  # noqa: BLE001 — prefs are best-effort
            logger.warning("Loading user prefs failed (%s); using empty set", exc)
            return {}
        if not doc:
            return {}
        return self._decode(doc)

    async def _mutate(self, change: Callable[[dict[str, UserPrefs]], _T]) -> _T:
        """Atomic, lost-update-safe read-modify-write over the shared prefs doc.

        ``change`` is applied to a FRESH decode of the current value (it may run more
        than once on a CAS retry) and both mutates the buckets dict AND stashes a
        result to return. Mirrors the ``inbox.py`` / ``tuning.py`` CAS pattern so two
        interleaving writers can't drop one another's change. Never raises."""
        box: dict[str, _T] = {}

        def _mutator(current: dict | None) -> dict:
            buckets = self._decode(current)
            box["r"] = change(buckets)
            return self._encode(buckets)

        await kv_mutate(self._kv, USER_PREFS_NS, USER_PREFS_KEY, _mutator, lock=self._lock)
        return box.get("r")  # type: ignore[return-value]

    async def get(self, user_id: str | None) -> UserPrefs:
        """The user's personal prefs bucket (an empty default bucket when none stored)."""
        buckets = await self._load_all()
        return buckets.get(normalize_user_id(user_id)) or UserPrefs()

    async def list(self) -> dict[str, UserPrefs]:
        """Every bucket (admin/debug view), keyed by normalised user_id."""
        return await self._load_all()

    async def put(self, user_id: str | None, prefs: UserPrefs) -> UserPrefs:
        """Replace the user's whole bucket (the route validates the body first)."""
        bid = normalize_user_id(user_id)
        stamped = prefs.model_copy(update={"updated_at": iso_now()})

        def _change(buckets: dict[str, UserPrefs]) -> UserPrefs:
            buckets[bid] = stamped
            return stamped

        return await self._mutate(_change)

    async def patch(self, user_id: str | None, **fields: Any) -> UserPrefs:
        """Patch only the provided (non-None) top-level fields on the user's bucket.

        DEEP-MERGES the dict-valued bags (``misc``, ``last_list_state``, ``tables``)
        so a partial patch ADDS/updates keys instead of CLOBBERING the whole bag —
        e.g. patching ``misc={"density": "compact"}`` when the user already has
        ``misc={"terminology": {...}}`` keeps BOTH (Round-5 #5 fix). List/scalar
        fields still replace wholesale (the caller sends the full new list).

        Re-validates through the model after the merge so the stored/returned object
        always holds real ``SavedView``/``ColumnState`` instances (the route passes
        the patch as dicts via ``model_dump``; ``model_copy(update=...)`` does NOT
        re-validate, so a bare merge would leave raw dicts in the typed lists).

        CAS-safe: the read-modify-write runs under the store lock + ``_rev`` retry so
        a concurrent writer's change is never dropped."""
        bid = normalize_user_id(user_id)
        # The bags that DEEP-merge (a partial patch adds keys, never wipes siblings).
        deep_merge_keys = {"misc", "last_list_state", "tables"}

        def _change(buckets: dict[str, UserPrefs]) -> UserPrefs:
            current = buckets.get(bid) or UserPrefs()
            merged = current.model_dump(mode="json")
            for key, value in fields.items():
                if value is None or key == "updated_at":
                    continue
                if key in deep_merge_keys and isinstance(value, dict) and isinstance(merged.get(key), dict):
                    # Shallow-merge the top-level bag keys (each value replaces its own
                    # entry) so an unrelated sibling key survives the patch.
                    combined = dict(merged.get(key) or {})
                    combined.update(value)
                    merged[key] = combined
                else:
                    merged[key] = value
            merged["updated_at"] = iso_now()
            updated = UserPrefs.model_validate(merged)
            buckets[bid] = updated
            return updated

        return await self._mutate(_change)

    async def delete(self, user_id: str | None) -> bool:
        """Drop a user's entire personal-prefs bucket (e.g. on user delete)."""
        bid = normalize_user_id(user_id)

        def _change(buckets: dict[str, UserPrefs]) -> bool:
            if bid not in buckets:
                return False
            del buckets[bid]
            return True

        return await self._mutate(_change)

    # ---- Saved views ----------------------------------------------------- #
    async def list_views(self, user_id: str | None) -> list[SavedView]:
        prefs = await self.get(user_id)
        return list(prefs.saved_views)

    async def get_view(self, user_id: str | None, view_id: str) -> SavedView | None:
        for v in await self.list_views(user_id):
            if v.id == view_id:
                return v
        return None

    async def add_view(self, user_id: str | None, view: SavedView) -> SavedView:
        bid = normalize_user_id(user_id)

        def _change(buckets: dict[str, UserPrefs]) -> SavedView:
            current = buckets.get(bid) or UserPrefs()
            views = [v for v in current.saved_views if v.id != view.id]
            views.append(view)
            buckets[bid] = current.model_copy(update={"saved_views": views, "updated_at": iso_now()})
            return view

        return await self._mutate(_change)

    async def update_view(
        self, user_id: str | None, view_id: str, **fields: Any
    ) -> SavedView | None:
        bid = normalize_user_id(user_id)
        allowed = {"name", "scope", "shared", "filters", "sort", "columns"}

        def _change(buckets: dict[str, UserPrefs]) -> SavedView | None:
            current = buckets.get(bid) or UserPrefs()
            updated: SavedView | None = None
            views = list(current.saved_views)
            for idx, v in enumerate(views):
                if v.id != view_id:
                    continue
                patch = {k: val for k, val in fields.items() if k in allowed and val is not None}
                patch["updated_at"] = iso_now()
                updated = v.model_copy(update=patch)
                views[idx] = updated
                break
            if updated is not None:
                buckets[bid] = current.model_copy(
                    update={"saved_views": views, "updated_at": iso_now()}
                )
            return updated

        return await self._mutate(_change)

    async def delete_view(self, user_id: str | None, view_id: str) -> bool:
        bid = normalize_user_id(user_id)

        def _change(buckets: dict[str, UserPrefs]) -> bool:
            current = buckets.get(bid) or UserPrefs()
            remaining = [v for v in current.saved_views if v.id != view_id]
            if len(remaining) == len(current.saved_views):
                return False
            # Also drop a now-dangling pin.
            pins = [p for p in current.pinned_view_ids if p != view_id]
            buckets[bid] = current.model_copy(
                update={"saved_views": remaining, "pinned_view_ids": pins, "updated_at": iso_now()}
            )
            return True

        return await self._mutate(_change)

    # ---- Per-table column state ------------------------------------------ #
    async def set_table_state(
        self, user_id: str | None, table_id: str, state: dict[str, Any] | ColumnState | None
    ) -> ColumnState:
        """Set (or clear, when ``state`` is empty/None) ONE table's column state.

        Returns the stored :class:`ColumnState` (an empty one when cleared). A
        focused helper so the UI can persist just one table's layout without
        read-modify-writing the whole prefs object."""
        bid = normalize_user_id(user_id)
        tid = str(table_id or "").strip()
        if not tid:
            raise ValueError("table_id is required")
        # Coerce/validate OUTSIDE the CAS mutator so a bad payload raises to the
        # caller (rather than being swallowed inside the never-raise mutate loop).
        if state:
            cs = state if isinstance(state, ColumnState) else ColumnState.model_validate(state)
        else:
            cs = ColumnState()

        def _change(buckets: dict[str, UserPrefs]) -> ColumnState:
            current = buckets.get(bid) or UserPrefs()
            tables = dict(current.tables)
            if state:
                tables[tid] = cs
            else:
                tables.pop(tid, None)
            buckets[bid] = current.model_copy(update={"tables": tables, "updated_at": iso_now()})
            return cs

        return await self._mutate(_change)


# --------------------------------------------------------------------------- #
# Cascade resolver — ORG defaults (Preferences.customization) ← USER overrides.
# --------------------------------------------------------------------------- #
def resolve_effective_prefs(customization: Any, user_prefs: UserPrefs | None) -> dict[str, Any]:
    """Merge the ORG customization defaults with the USER's personal prefs.

    Precedence (a USER override ALWAYS wins over an ORG default, which always wins
    over the shipped built-in defaults):

    * ``terminology`` — ORG label overrides merged UNDER the user's own personal
      labels (a user's label wins; absent → org; absent → built-in default at the UI
      ``t()`` helper).
    * ``theme_mode``: the user's own ``theme_mode``. ``system`` is resolved by the
      Console against Branding ``default_theme``, the one organization default (an org
      can ship a dark-by-default console and a user can still pin light/dark for
      themselves). The legacy ``customization.default_theme`` is only echoed.
    * ``saved_views`` — org-shared views (forced ``shared=True``) UNION the user's
      personal views (a user view with the same id wins).
    * ``pinned_view_ids`` — the user's pins when set, else the org default pins.
    * ``tables`` / ``last_list_state`` / ``misc`` — purely personal (passed through).

    Returns a plain JSON-able dict the ``GET /api/prefs/effective`` route serves; it
    is all PLAIN DATA (#9). Never raises — a missing piece degrades to a safe default.
    """
    up = user_prefs or UserPrefs()

    org_terms: dict[str, str] = dict(getattr(customization, "terminology", {}) or {})
    raw_user_terms = up.misc.get("terminology")
    user_terms = dict(raw_user_terms) if isinstance(raw_user_terms, dict) else {}
    # USER label overrides win over ORG; ORG wins over the built-in (resolved at the UI).
    terminology = {**org_terms, **user_terms}

    org_theme = str(getattr(customization, "default_theme", "system") or "system")
    # Round 16 B45: Branding ``default_theme`` is the one organization theme default.
    # A user's explicit choice wins; "system" stays "system" and the Console resolves it
    # against Branding, so the legacy ``customization.default_theme`` no longer
    # overrides it (``Preferences`` moves an old legacy choice into Branding on load).
    theme_mode = up.theme_mode

    # Org-shared saved views (validated/normalised) + the user's personal set.
    org_views: list[SavedView] = []
    for raw in (getattr(customization, "default_saved_views", []) or []):
        try:
            org_views.append(SavedView.model_validate(raw).model_copy(update={"shared": True}))
        except Exception:  # noqa: BLE001 — skip a malformed org view
            continue
    by_id: dict[str, SavedView] = {v.id: v for v in org_views}
    for raw in up.saved_views:  # a personal view with the same id overrides the org one
        # Defensive: a personal view is normally a validated SavedView, but coerce a
        # stray dict (e.g. from a not-yet-revalidated patch) so this never raises.
        try:
            v = raw if isinstance(raw, SavedView) else SavedView.model_validate(raw)
        except Exception:  # noqa: BLE001
            continue
        by_id[v.id] = v
    saved_views = list(by_id.values())

    pinned = up.pinned_view_ids or list(getattr(customization, "default_pinned_view_ids", []) or [])

    return {
        "terminology": terminology,
        "theme_mode": theme_mode,
        "saved_views": [v.model_dump(mode="json") for v in saved_views],
        "pinned_view_ids": list(pinned),
        "tables": {tid: cs.model_dump(mode="json") for tid, cs in up.tables.items()},
        "last_list_state": dict(up.last_list_state),
        "misc": {k: val for k, val in up.misc.items() if k != "terminology"},
        # Echo the org defaults so the UI can show "reset to org default" affordances.
        "org": {
            "terminology": org_terms,
            "default_theme": org_theme,
            "default_saved_views": [v.model_dump(mode="json") for v in org_views],
            "default_pinned_view_ids": list(
                getattr(customization, "default_pinned_view_ids", []) or []
            ),
        },
    }
