"""Multi-USER store — real SOC accounts for login + RBAC (Wave 1).

A USER is a login account with a role (see :class:`app.constants.UserRole`), a
PBKDF2 password hash, an ``active`` flag and a ``must_change_password`` flag.

Backend-agnostic by construction (same shape as :mod:`app.stores.memory` /
:mod:`app.stores.proposals`): the WHOLE user set is ONE JSON list persisted through
the existing :class:`KVStore` abstraction (``ns="users"``, ``key="entries"``) — so it
needs NO new ES index / SQL table / migration. The SQL backend uses ``SqlKVStore``
(the shared KV table); the ES backend uses the thin :class:`app.stores.memory.EsKVStore`
adapter (a doc in the existing config index).

Reads + writes are read-modify-write over the single list — fine at our scale (a
handful of operator accounts, not log volume). The store NEVER raises on a load: a
load failure degrades to an empty list and is logged. Mutations DO surface errors so
the caller (e.g. the user-admin route) can report a failure.

Usernames are unique, case-insensitively matched, and stored as entered. The
``create_if_absent`` seeding path is race-safe at our single-process scale (one
read-modify-write under the asyncio event loop; no two coroutines interleave a save).
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Callable

from ..constants import USERS_KEY, USERS_NS, UserRole
from ..models import User
from ..utils import iso_now
from .base import KVStore, kv_mutate

logger = logging.getLogger("tlsoc.stores.users")


def _norm(username: str) -> str:
    return (username or "").strip().lower()


class UserStore:
    """CRUD over the user list, persisted as one KV document.

    The KV value is ``{"entries": [<User json>, ...]}``. Methods are
    read-modify-write. ``_load`` never raises (a failure logs + returns an empty
    list); mutations surface persistence errors.

    The OOBE bootstrap create (``create_if_absent``) is serialized under an
    ``asyncio.Lock`` so two concurrent first-run setup requests cannot both pass
    the read-check and each write an admin (last-writer-wins) — exactly ONE admin
    is created under concurrency (H4 / FINDING #13)."""

    def __init__(self, kv: KVStore) -> None:
        self._kv = kv
        # One per-store lock shared by every mutation (via kv_mutate) AND the bootstrap
        # seed, so concurrent account changes serialise in-process and the _rev CAS covers
        # the multi-process race — no lost update (audit #25). (Also the FINDING-#13
        # single-admin bootstrap guard.)
        self._lock = asyncio.Lock()

    async def _mutate(self, apply: Callable[[list[User]], Any]) -> Any:
        """Run ``apply(users)`` under kv_mutate (per-store lock + _rev CAS). ``apply``
        mutates the fresh user list in place and returns an auxiliary result (the updated
        User, a bool, …); the persisted attempt's result is returned. ``apply`` may raise
        (e.g. ``create`` on a duplicate) — the exception propagates and no write lands."""
        box: dict[str, Any] = {}

        def mutator(current: dict[str, Any] | None) -> dict[str, Any]:
            raw = current.get("entries", []) if isinstance(current, dict) else []
            users: list[User] = []
            for item in (raw or []):
                try:
                    users.append(User.model_validate(item))
                except Exception:  # noqa: BLE001 — skip a corrupt entry, keep the rest
                    continue
            box["result"] = apply(users)
            return {"entries": [u.model_dump(mode="json") for u in users]}

        await kv_mutate(self._kv, USERS_NS, USERS_KEY, mutator, lock=self._lock)
        return box.get("result")

    async def _load(self) -> list[User]:
        try:
            doc = await self._kv.get(USERS_NS, USERS_KEY)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Loading users failed (%s); using empty set", exc)
            return []
        if not doc:
            return []
        raw = doc.get("entries", []) if isinstance(doc, dict) else []
        out: list[User] = []
        for item in raw or []:
            try:
                out.append(User.model_validate(item))
            except Exception:  # noqa: BLE001 — skip a single corrupt entry, keep the rest
                continue
        return out

    async def _save(self, entries: list[User]) -> None:
        await self._kv.put(
            USERS_NS, USERS_KEY,
            {"entries": [u.model_dump(mode="json") for u in entries]},
        )

    async def list(self) -> list[User]:
        """All users, oldest first (stable admin-table order)."""
        return sorted(await self._load(), key=lambda u: u.created_at)

    async def save(self, user: User) -> None:
        """Upsert ``user`` by (case-insensitive) username — append if new, replace
        in place if it already exists. ``updated_at`` is refreshed on replace; the
        stored ``created_at`` is preserved so it remains the true creation time."""
        needle = _norm(user.username)

        def apply(entries: list[User]) -> None:
            for idx, existing in enumerate(entries):
                if _norm(existing.username) == needle:
                    entries[idx] = user.model_copy(update={
                        "created_at": existing.created_at,
                        "updated_at": iso_now(),
                    })
                    return
            entries.append(user)

        await self._mutate(apply)

    async def count(self) -> int:
        return len(await self._load())

    async def has_any(self) -> bool:
        """Whether ANY user exists — a RAISING probe (unlike ``count()``/``_load()``,
        which swallow a load error and degrade to an empty set). A store-read glitch
        therefore PROPAGATES here so the OOBE setup gate fails SAFE (503 / blocked)
        rather than silently proceeding to a 2nd bootstrap (H4 / FINDING #12).

        Reads the raw KV doc directly (no swallowing ``_load``) and lets any store
        error bubble to the caller."""
        doc = await self._kv.get(USERS_NS, USERS_KEY)
        if not doc:
            return False
        entries = doc.get("entries", []) if isinstance(doc, dict) else []
        return bool(entries)

    async def get(self, username: str) -> User | None:
        needle = _norm(username)
        for u in await self._load():
            if _norm(u.username) == needle:
                return u
        return None

    async def find_active(self, username: str) -> User | None:
        u = await self.get(username)
        return u if (u is not None and u.active) else None

    async def credentials(self) -> dict[str, str]:
        """``username -> password_hash`` for ACTIVE users (the AuthService user map)."""
        return {u.username: u.password_hash for u in await self._load() if u.active}

    async def create(
        self,
        *,
        username: str,
        password_hash: str,
        role: str = UserRole.ANALYST_TIER1.value,
        active: bool = True,
        must_change_password: bool = False,
        display_name: str = "",
        email: str = "",
        phone: str = "",
        mfa_required: bool = False,
        prefs: dict | None = None,
    ) -> User:
        """Create a user. Raises ``ValueError`` if the username already exists.

        ``display_name``/``email``/``phone`` are the admin-set profile/contact
        fields; ``mfa_required`` is the admin MFA-enrollment mandate (NEVER the
        enrolled ``mfa_enabled`` flag — no secret is minted here); ``prefs`` seeds
        the free-form prefs bag (e.g. ``{"custom_roles": [...]}`` — the same shape
        ``PUT /api/users/{u}/roles`` writes). All optional + defaulted (additive)."""
        uname = (username or "").strip()
        if not uname:
            raise ValueError("username is required")
        user = User(
            username=uname,
            password_hash=password_hash,
            role=role,
            active=active,
            must_change_password=must_change_password,
            display_name=display_name or "",
            email=email or "",
            phone=phone or "",
            mfa_required=bool(mfa_required),
            prefs=dict(prefs or {}),
        )

        def apply(entries: list[User]) -> User:
            if any(_norm(u.username) == _norm(uname) for u in entries):
                raise ValueError(f"user '{uname}' already exists")
            entries.append(user)
            return user

        return await self._mutate(apply)

    async def create_if_absent(
        self,
        *,
        username: str,
        password_hash: str,
        role: str = UserRole.ANALYST_TIER1.value,
        active: bool = True,
        must_change_password: bool = False,
    ) -> User | None:
        """Race-safe seed: create the user ONLY if the store is empty AND the
        username is absent. Returns the created user, or ``None`` if it already
        existed / the store was non-empty (so seeding never clobbers real users).

        The read-check-write runs under ``self._lock`` (shared with every other
        mutation) so two concurrent first-run setup requests cannot both observe an empty
        store and each save an admin (last-writer-wins) — exactly ONE admin is created
        under concurrency (H4 / FINDING #13). At single-process scale the lock is the
        whole guard; the emptiness check inside it is the linearization point."""
        async with self._lock:
            entries = await self._load()
            if entries:
                return None
            user = User(
                username=(username or "").strip(),
                password_hash=password_hash,
                role=role,
                active=active,
                must_change_password=must_change_password,
            )
            await self._save([user])
            return user

    async def update(self, username: str, **fields: object) -> User | None:
        """Patch a user (role / active / password_hash / must_change_password).
        Returns the updated user, or ``None`` if the username is unknown."""
        needle = _norm(username)
        allowed = {
            "role", "active", "password_hash", "must_change_password", "last_login_at",
            # Wave 2 (MFA / SSO) — additive, set via the auth routes (never the UI).
            "mfa_enabled", "mfa_secret", "mfa_recovery_hashes", "mfa_last_step",
            "oauth_provider", "oauth_sub",
            # Wave 2 (W2) self-service profile — patched via /api/account/me.
            "display_name", "alias", "avatar", "alt_email", "timezone", "locale", "prefs",
            # Admin-managed contact fields + the MFA-enrollment mandate — patched
            # via PUT /api/users/{username} (users:manage).
            "email", "phone", "mfa_required",
        }

        def apply(entries: list[User]) -> User | None:
            for idx, u in enumerate(entries):
                if _norm(u.username) != needle:
                    continue
                patch = {k: v for k, v in fields.items() if k in allowed and v is not None}
                patch["updated_at"] = iso_now()
                updated = u.model_copy(update=patch)
                entries[idx] = updated
                return updated
            return None

        return await self._mutate(apply)

    async def delete(self, username: str) -> bool:
        needle = _norm(username)

        def apply(entries: list[User]) -> bool:
            before = len(entries)
            entries[:] = [u for u in entries if _norm(u.username) != needle]
            return len(entries) != before

        return bool(await self._mutate(apply))

    async def count_active_super_admins(self, *, super_admin_role: str) -> int:
        """How many ACTIVE users hold the super-admin role — used to forbid
        deleting/demoting/disabling the last super_admin (lockout guard)."""
        return sum(
            1 for u in await self._load()
            if u.active and u.role == super_admin_role
        )
