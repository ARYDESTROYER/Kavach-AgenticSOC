"""OOBE first-admin account setup (Round 4, Wave 4 — PROPOSAL §6.7).

A NEW first-run "create the admin account" step, grounded in the OOBE flows of
Grafana / Kibana / Splunk / Wazuh / GitLab: the operator supplies a username + a
display name + a **force-set strong password** (server-enforced policy), and the
platform creates the FIRST ``super_admin``. This REPLACES the ``Admin`` / ``Admin@123``
seed as the real operator credential; the seed survives ONLY as the auth-OFF /
offline-test default (unchanged — see ``AppState.seed_users`` + ``Secrets``).

Endpoints (PUBLIC / pre-auth — reachable before any session exists; guarded by
first-run state, NOT an RBAC grant):

* ``POST /api/setup/account`` — create the FIRST ``super_admin``. Callable ONLY while
  ``setup_complete == false`` AND auth is enabled AND NO admin exists yet; it
  SELF-LOCKS after the first success (subsequent calls 409 / 403). The password must
  clear a server-side strong-password policy (min 12 chars, not equal to the username,
  not a trivially-common password) and is hashed via :mod:`app.auth.passwords`
  (PBKDF2-SHA256). MFA is prompted-optional — this step NEVER forces it.

The ``GET /api/setup/status`` the wizard reads is ALREADY served by the monolith router
(:mod:`app.api.routes`) with a SUPERSET shape (``setup_complete`` / ``auth_enabled`` +
``user_count`` / ``needs_user`` — from which ``has_admin = user_count > 0``). This
module deliberately does NOT re-declare it to avoid a duplicate path-handler; it owns
ONLY the new ``POST /api/setup/account`` writer.

Non-negotiables upheld
----------------------
* **#2** — the account creation is appended to the append-only audit log (setup surface).
* **#3** — nothing here touches ``case_manager.decide()`` (this is identity bootstrap).
* **#9** — the password is NEVER echoed; responses carry BOOLEANS + the username only.
  The username / display-name are operator-supplied but are returned as PLAIN data (the
  webui renders them escaped) and are never interpolated into an LLM prompt.
* **DEFAULT-OFF** — when auth is disabled (the out-of-the-box default), the account
  step is a no-op/blocked (400) and behaviour is byte-identical to before.

``/api/setup/account`` MUST be listed in ``deps.PUBLIC_API_PATHS`` (it is pre-auth) —
the one new allowlist entry this wave introduces (``/api/setup/status`` is already
there, owned by the monolith router).
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..auth.passwords import hash_password
from ..constants import ActionType, UserRole
from ..state import AppState
from .deps import get_state

logger = logging.getLogger("tlsoc.api.setup")

router = APIRouter(prefix="/api")

# --------------------------------------------------------------------------- #
# Server-enforced strong-password policy (stdlib only; no new deps).
# --------------------------------------------------------------------------- #
# The OOBE admin credential replaces the Admin/Admin@123 seed, so it MUST be strong.
# Kept deliberately simple + explainable (length + not-equal-to-username + a common
# blocklist) rather than an entropy heuristic — this is a bootstrap gate, not a
# password-strength meter, and the operator is picking a NEW credential.
_MIN_PASSWORD_LEN = 12

# A small, case-insensitive blocklist of trivially-common / default passwords. Not a
# full dictionary (that would be a dependency + a large asset) — just the credentials
# an attacker tries first against a fresh SOC install. Compared lowercased.
_COMMON_PASSWORDS = frozenset(
    p.lower()
    for p in (
        "password", "password1", "password123", "passw0rd", "p@ssw0rd", "p@ssword",
        "123456", "12345678", "123456789", "1234567890", "111111", "000000",
        "qwerty", "qwerty123", "qwertyuiop", "abc123", "abc12345", "a1b2c3d4",
        "letmein", "welcome", "welcome1", "welcome123", "admin", "admin123",
        "administrator", "root", "toor", "changeme", "changeme1", "changeme123",
        "iloveyou", "monkey", "dragon", "sunshine", "princess", "football",
        "trustno1", "master", "superman", "starwars", "whatever", "secret",
        "default", "temp1234", "test1234", "passw0rd1", "adminadmin", "rootroot",
        "soc12345678", "tlsoc123456", "admin@123", "admin12345678",
    )
)


def password_policy_error(password: str, username: str) -> str | None:
    """Return a human-readable reason the password FAILS the strong-password policy,
    or ``None`` when it PASSES. Pure + deterministic — reused by the route + tests.

    Policy (server-enforced): min length, not equal to the username (case-insensitive,
    trimmed), and not a trivially-common / default password (case-insensitive)."""
    pw = password or ""
    if len(pw) < _MIN_PASSWORD_LEN:
        return f"password must be at least {_MIN_PASSWORD_LEN} characters"
    if pw.strip().lower() == (username or "").strip().lower():
        return "password must not be the same as the username"
    if pw.strip().lower() in _COMMON_PASSWORDS:
        return "password is too common; choose a less predictable password"
    return None


# --------------------------------------------------------------------------- #
# POST /api/setup/account
# --------------------------------------------------------------------------- #
class SetupAccountBody(BaseModel):
    username: str = Field(..., description="the first super_admin's login username")
    password: str = Field(..., description="force-set strong password (server-policied)")
    display_name: str | None = Field(
        default=None, description="optional human display name for the account"
    )


@router.post("/setup/account")
async def setup_account(
    body: SetupAccountBody, state: AppState = Depends(get_state)
) -> dict[str, Any]:
    """PUBLIC OOBE: create the FIRST ``super_admin`` account.

    Callable ONLY while the platform is un-bootstrapped:
    * auth is ENABLED (400 when disabled — the account step is meaningless with no
      login layer, and the no-auth default stays byte-identical);
    * ``setup_complete`` is ``False`` — once setup is marked complete this step is
      locked (403);
    * NO user exists yet — the moment an admin exists it SELF-LOCKS (409), so this can
      never be used to add or escalate an account on a live platform.

    On success it hashes the (policy-checked) password via PBKDF2-SHA256, creates the
    ``super_admin`` (``must_change_password=False`` — the operator just chose it),
    refreshes the auth view, clears the demo-seed hint, and audits the bootstrap (#2).
    The password is NEVER echoed — the response carries booleans + the username only."""
    # 1) auth must be on (the no-auth default has no account layer to bootstrap).
    if not state.secrets.auth_enabled:
        raise HTTPException(status_code=400, detail="authentication is disabled")

    # 2) once setup is complete the step is locked. The sole exception is a durable
    # degraded factory boundary that has already confirmed the strict user store is
    # empty; this lets a deployment without an environment admin bootstrap authority
    # for the only operation the still-closed Job fence accepts: factory recovery.
    recovery_bootstrap = await state.factory_recovery_bootstrap_allowed()
    if bool(state.prefs.setup_complete) and not recovery_bootstrap:
        raise HTTPException(
            status_code=403, detail="setup already complete; account step is locked"
        )

    uname = (body.username or "").strip()
    if not uname:
        raise HTTPException(status_code=400, detail="username is required")

    # 3) server-enforced strong-password policy (min length / != username / not common).
    policy_err = password_policy_error(body.password or "", uname)
    if policy_err is not None:
        raise HTTPException(status_code=400, detail=policy_err)

    # 4) self-lock: an admin already existing means the platform is bootstrapped.
    #    Use the RAISING ``has_any()`` probe (NOT ``count()``): ``count()``/``_load()``
    #    swallow a store-read error and degrade to 0/empty, which would 'fail OPEN' and
    #    let a store glitch allow a 2nd bootstrap. ``has_any()`` lets the load error
    #    PROPAGATE so we fail SAFE with a 503 instead (H4 / FINDING #12).
    try:
        already = await state.users.has_any()
    except Exception as exc:  # noqa: BLE001 — a store read glitch → fail SAFE (don't create)
        logger.warning("setup/account: user-store probe failed (%s); refusing", exc)
        raise HTTPException(status_code=503, detail="user store unavailable; try again") from exc
    if already:
        raise HTTPException(
            status_code=409, detail="an admin already exists; setup is already bootstrapped"
        )

    # 5) create the first super_admin (race-safe create-if-absent). must_change_password
    #    is False because the operator is choosing this credential right now.
    created = await state.users.create_if_absent(
        username=uname,
        password_hash=hash_password(body.password),
        role=UserRole.SUPER_ADMIN.value,
        active=True,
        must_change_password=False,
    )
    if created is None:  # lost the race — someone else just bootstrapped
        raise HTTPException(
            status_code=409, detail="an admin already exists; setup is already bootstrapped"
        )

    # Persist the optional display name (additive self-service profile field).
    display = (body.display_name or "").strip()
    if display:
        try:
            await state.users.update(created.username, display_name=display)
        except Exception as exc:  # noqa: BLE001 — the account exists; a profile patch is best-effort
            logger.warning("setup/account: display_name patch failed (%s); continuing", exc)

    # The demo Admin/Admin@123 hint no longer applies once a real admin is created.
    state._seeded_default_admin = False
    await state.refresh_users()

    # #2 — append-only audit of the bootstrap (password NEVER logged).
    try:
        await state.control_audit.record(
            action_type=ActionType.USER_MGMT,
            surface="setup",
            actor=created.username,
            result_summary=f"OOBE first super_admin '{created.username}' created",
        )
    except Exception as exc:  # noqa: BLE001 — the account is created; auditing is best-effort
        logger.warning("setup/account: audit record failed (%s); continuing", exc)

    # Response: booleans + username only (#9 — the password is never echoed).
    return {
        "ok": True,
        "username": created.username,
        "role": UserRole.SUPER_ADMIN.value,
        "mfa_prompt": True,  # the UI MAY offer MFA enrollment next (prompted-optional).
    }
