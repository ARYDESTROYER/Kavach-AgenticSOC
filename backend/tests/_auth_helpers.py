"""Shared sign-in helpers for the offline tests (Round 16, B20).

An account an administrator creates through ``POST /api/users`` (or resets through
``PUT /api/users/{username}``) carries ``must_change_password``. Since Round 16 the
server enforces it: until the temporary password is changed, every /api route other
than the change-password flow answers ``403 password_change_required``.

:func:`ready_user` does what the person would do: it signs in as the account and
changes the temporary password. It changes it to the same value, so a test that signs
in again later keeps using the password it chose. It never weakens what the server
checks and adds no application-side bypass.
"""

from __future__ import annotations

from typing import Any

import httpx


def _bearer(token: str | None) -> dict[str, str] | None:
    return {"Authorization": f"Bearer {token}"} if token else None


def ready_user(client: Any, username: str, password: str) -> None:
    """Sign in as ``username`` and clear its forced password change.

    The readying session is signed out again (so it never counts as another session
    of the account) and the client's cookies are restored, so a test signed in as an
    administrator stays signed in as the administrator. A sign-in that asks for a
    second factor is left to the caller. Asserts each step succeeds, so a broken
    account fails the test here rather than later with a confusing 403."""
    saved = httpx.Cookies(client.cookies)
    try:
        client.cookies.clear()
        r = client.post("/api/auth/login", json={"username": username, "password": password})
        assert r.status_code == 200, r.text
        body = r.json()
        if body.get("requires_mfa"):
            return
        token = body.get("token")
        if (body.get("user") or {}).get("must_change_password"):
            r = client.post(
                "/api/auth/change-password",
                json={"current_password": password, "new_password": password},
                headers=_bearer(token),
            )
            assert r.status_code == 200, r.text
        client.post("/api/auth/logout", headers=_bearer(token))
    finally:
        client.cookies = saved


async def aready_user(client: Any, username: str, password: str) -> None:
    """:func:`ready_user` for an ``httpx.AsyncClient``."""
    saved = httpx.Cookies(client.cookies)
    try:
        client.cookies.clear()
        r = await client.post("/api/auth/login", json={"username": username, "password": password})
        assert r.status_code == 200, r.text
        body = r.json()
        if body.get("requires_mfa"):
            return
        token = body.get("token")
        if (body.get("user") or {}).get("must_change_password"):
            r = await client.post(
                "/api/auth/change-password",
                json={"current_password": password, "new_password": password},
                headers=_bearer(token),
            )
            assert r.status_code == 200, r.text
        await client.post("/api/auth/logout", headers=_bearer(token))
    finally:
        client.cookies = saved
