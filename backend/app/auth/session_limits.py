"""Session lifetime limits — the ONE place the standard and remembered limits are built.

Round 12 (SPEC D14, ``research/remember-me.md`` §4.1). A session-registry row is
judged against either the STANDARD pair (``SessionPolicyConfig.idle_timeout`` /
``absolute_lifetime``) or, when the row was created by a "Remember me" sign-in AND its
principal may still be remembered, the REMEMBERED pair (``SessionPolicyConfig.
remember_me``). Every caller that evaluates a row (``deps.evaluate_session`` — used by
every protected route and ``/auth/me`` — the strict factory-boundary check, the
deferred-job authority, the supervised-update gate, ``/auth/refresh`` and the session
listings) builds its limits here so the call sites cannot drift; contract tests grep
them.

Two rules keep a remembered session from ever being LOOSER than what the
administrator configured for ordinary sign-ins (an upgrade must never weaken a stricter
stored policy):

* The remembered absolute limit is ``min(remember_me.duration_seconds,
  absolute_lifetime)``.
* With no separate remembered inactivity limit (``remember_me.idle_seconds`` unset),
  a remembered session uses the STANDARD ``idle_timeout`` (bounded by its own
  absolute limit). Only an explicit ``idle_seconds`` — a remember-specific choice the
  administrator made — may differ from the standard inactivity limit.

Exclusion is re-checked at EVALUATION time, not only when the session is created: a
remembered row whose principal's LIVE role is excluded (``remember_me.excluded_roles``,
including the effective ``super_admin`` every principal holds while RBAC is off) is
judged as a STANDARD sign-in, exactly as when the administrator turns Remember me off.

Judged as a standard sign-in means never looser than one (Round 12 final review, L1):
an ordinary sign-in ends when its access token expires (``AUTH_TOKEN_HOURS``, 12 h by
default), while a remembered row's token was minted for up to 24 h. Such a row is
therefore also capped at the standard token lifetime from its ``created_at``
(``fallback_absolute``), and an explicit remembered inactivity limit the
administrator chose (``remember_me.idle_seconds``) keeps applying when it is
stricter (``fallback_idle``): turning Remember me off, or excluding a role, can only
shorten a live remembered session, never lengthen it.

Pure and dependency-light: it reads policy/preference objects duck-typed (a missing
block or field degrades to the standard behaviour) and never raises.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable
from dataclasses import dataclass, replace
from typing import Any

logger = logging.getLogger("tlsoc.auth.session_limits")

# The NIST SP 800-63B-4 AAL2 overall-timeout ceiling and the policy maximum.
REMEMBER_MAX_SECONDS = 86_400
REMEMBER_MIN_SECONDS = 3_600

# Every session token — standard or remembered — must expire BEFORE a revoked
# registry row can be pruned (``stores.sessions._PRUNE_GRACE_SECONDS``, 7 days), or a
# revoked token could be lazily re-registered after its row disappeared (ASVS 7.4.1).
# ``AUTH_TOKEN_HOURS`` above this is clamped (with a startup warning) by AuthService.
MAX_SESSION_TOKEN_SECONDS = 6 * 86_400

# The role every principal effectively holds while RBAC is off (the server's own
# back-compat rule, see ``routes._resolved_role``).
_RBAC_OFF_ROLE = "super_admin"


def _int(value: Any) -> int:
    try:
        if isinstance(value, bool):
            return 0
        return max(0, int(value or 0))
    except (TypeError, ValueError, OverflowError):
        return 0


def _norm_role(value: Any) -> str:
    return str(value or "").strip().lower()


def _norm_roles(values: Iterable[Any] | None) -> frozenset[str]:
    if not values:
        return frozenset()
    out = {_norm_role(v) for v in values}
    out.discard("")
    return frozenset(out)


@dataclass(frozen=True)
class SessionLimits:
    """The live limits for one evaluation.

    ``remember_absolute == 0`` means "no remembered limits" (Remember me is turned
    off, this principal's role is excluded, or the caller has none): a remembered
    row is then judged as a standard sign-in — the standard pair, tightened by
    ``fallback_absolute`` (the standard access-token lifetime, which ends every
    ordinary sign-in) and ``fallback_idle`` (an explicit remembered inactivity limit,
    still honoured when stricter). ``excluded_roles`` is the policy's normalised
    exclusion list; :meth:`for_roles` applies it to one principal."""

    idle: int = 0
    absolute: int = 0
    remember_idle: int = 0
    remember_absolute: int = 0
    excluded_roles: frozenset[str] = frozenset()
    fallback_idle: int = 0
    fallback_absolute: int = 0

    @property
    def remember_enabled(self) -> bool:
        return self.remember_absolute > 0

    def kwargs(self) -> dict[str, int]:
        """The keyword arguments every ``SessionStore`` evaluator takes."""
        return {
            "idle_timeout": self.idle,
            "absolute_lifetime": self.absolute,
            "remember_idle": self.remember_idle,
            "remember_absolute": self.remember_absolute,
            "remember_fallback_idle": self.fallback_idle,
            "remember_fallback_absolute": self.fallback_absolute,
        }

    def for_row(self, row: dict[str, Any] | None) -> tuple[int, int]:
        """``(idle, absolute)`` that apply to ``row`` (the same rule as
        :meth:`app.stores.sessions.SessionStore.limits_for_row`)."""
        if row is not None and bool(row.get("remember")):
            if self.remember_absolute > 0:
                return (self.remember_idle or self.remember_absolute, self.remember_absolute)
            return (
                strictest(self.idle, self.fallback_idle),
                strictest(self.absolute, self.fallback_absolute),
            )
        return (self.idle, self.absolute)

    def without_remember(self) -> SessionLimits:
        """These limits with the remembered pair removed (standard pair only)."""
        if not self.remember_enabled:
            return self
        return replace(self, remember_idle=0, remember_absolute=0)

    def role_excluded(self, roles: Iterable[Any] | None) -> bool:
        """Whether any of ``roles`` is on the policy's exclusion list."""
        return bool(self.excluded_roles & _norm_roles(roles))

    def for_roles(self, roles: Iterable[Any] | None) -> SessionLimits:
        """The limits for a principal holding ``roles``: an excluded role is never
        remembered, so its remembered rows fall back to the standard pair."""
        if self.remember_enabled and self.role_excluded(roles):
            return self.without_remember()
        return self


def strictest(*limits: int) -> int:
    """The shortest of the SET limits (``0`` means unset), or ``0`` when none is."""
    positive = [int(v) for v in limits if v and int(v) > 0]
    return min(positive) if positive else 0


def remember_policy(policy: Any) -> Any:
    """The ``remember_me`` block of a session policy (``None`` when absent)."""
    return getattr(policy, "remember_me", None) if policy is not None else None


def _policy_limits(policy: Any, token_seconds: int = 0) -> SessionLimits:
    idle = _int(getattr(policy, "idle_timeout", 0)) if policy is not None else 0
    absolute = _int(getattr(policy, "absolute_lifetime", 0)) if policy is not None else 0
    rm = remember_policy(policy)
    excluded = _norm_roles(getattr(rm, "excluded_roles", None) or []) if rm is not None else frozenset()
    # How a remembered row that is no longer remembered is judged (see the module
    # docstring): it ends where a standard sign-in would, and an explicit remembered
    # inactivity limit keeps applying while it is the stricter one.
    explicit_idle = _int(getattr(rm, "idle_seconds", 0)) if rm is not None else 0
    fallback = {"fallback_idle": explicit_idle, "fallback_absolute": _int(token_seconds)}
    if rm is None or not bool(getattr(rm, "enabled", False)):
        return SessionLimits(idle=idle, absolute=absolute, excluded_roles=excluded, **fallback)
    duration = min(REMEMBER_MAX_SECONDS, _int(getattr(rm, "duration_seconds", 0)))
    if duration <= 0:
        return SessionLimits(idle=idle, absolute=absolute, excluded_roles=excluded, **fallback)
    # Never looser than the standard hard cap.
    remember_absolute = min(duration, absolute) if absolute > 0 else duration
    if explicit_idle > 0:
        remember_idle = min(explicit_idle, remember_absolute)
    elif idle > 0:
        # No remember-specific inactivity limit: the standard one applies.
        remember_idle = min(idle, remember_absolute)
    else:
        remember_idle = remember_absolute
    return SessionLimits(
        idle=idle,
        absolute=absolute,
        remember_idle=remember_idle,
        remember_absolute=remember_absolute,
        excluded_roles=excluded,
        **fallback,
    )


def session_limits(
    policy: Any, *, roles: Iterable[Any] | None, token_seconds: int = 0,
) -> SessionLimits:
    """Build the live limits from ``Preferences.session_policy`` (duck-typed).

    ``roles`` is REQUIRED (keyword-only) so no caller can forget the exclusion
    list: pass the principal's effective roles (see :func:`effective_roles`), or
    ``None`` ONLY for a policy-level view that judges no particular session (tests,
    documentation). Row evaluators use :func:`limits_for_principal` /
    :func:`limits_for_username`. ``token_seconds`` is the STANDARD access-token
    lifetime (``AuthService.token_seconds``): it bounds a remembered row that is no
    longer remembered (``0``: no such bound, for a policy-level view)."""
    limits = _policy_limits(policy, token_seconds)
    return limits if roles is None else limits.for_roles(roles)


def remember_window_seconds(policy: Any) -> int:
    """The lifetime a NEW remembered sign-in is granted under ``policy`` (seconds;
    0 when Remember me is off): the remembered duration, capped by the standard
    absolute lifetime. Used for the token/cookie lifetime and the sign-in page."""
    return _policy_limits(policy).remember_absolute


def remember_idle_window_seconds(policy: Any) -> int:
    """How long a NEW remembered sign-in may go without activity before the server
    ends it (seconds): the remembered inactivity limit — ``remember_me.idle_seconds``
    when set, else the standard ``idle_timeout`` — capped by the remembered
    lifetime. 0 when Remember me is off or no inactivity limit is shorter than the
    lifetime (activity then never matters). Used by the sign-in page, so the
    promise it makes ("up to 24 hours … after 12 hours without activity") is the
    one :meth:`app.stores.sessions.SessionStore.is_active` enforces."""
    limits = _policy_limits(policy)
    if limits.remember_absolute <= 0:
        return 0
    idle = limits.remember_idle
    return idle if 0 < idle < limits.remember_absolute else 0


def effective_roles(prefs: Any, role: Any) -> frozenset[str]:
    """The roles a principal effectively holds for the exclusion check: its stored
    role, plus ``super_admin`` while RBAC is off (every authenticated principal is
    then effectively a super admin) or the default role when RBAC is on and the
    record has none. Mirrors ``routes._resolved_role``."""
    held = {_norm_role(role)}
    rbac = getattr(prefs, "rbac", None) if prefs is not None else None
    if not bool(getattr(rbac, "enabled", False)):
        held.add(_RBAC_OFF_ROLE)
    elif not _norm_role(role):
        held.add(_norm_role(getattr(rbac, "default_role", "")))
    held.discard("")
    return frozenset(held)


def limits_for_principal(prefs: Any, role: Any, *, token_seconds: int = 0) -> SessionLimits:
    """The live limits for a principal whose LIVE role is ``role``;
    ``token_seconds`` is the standard access-token lifetime (see
    :func:`session_limits`)."""
    policy = getattr(prefs, "session_policy", None) if prefs is not None else None
    return session_limits(
        policy, roles=effective_roles(prefs, role), token_seconds=token_seconds,
    )


def standard_token_seconds(state: Any) -> int:
    """The standard access-token lifetime of ``state``'s auth service (seconds; 0
    when unknown). Never raises."""
    try:
        return _int(getattr(getattr(state, "auth", None), "token_seconds", 0))
    except Exception:  # noqa: BLE001 — an unknown lifetime only drops the extra cap
        return 0


def limits_for_username(state: Any, username: str) -> SessionLimits:
    """The live limits for ``username``, resolving its live role from the synced
    user view (``state.auth.principal``). An unknown or inactive principal is never
    remembered (fail closed to the standard pair)."""
    prefs = getattr(state, "prefs", None)
    policy = getattr(prefs, "session_policy", None) if prefs is not None else None
    auth = getattr(state, "auth", None)
    principal = None
    if auth is not None and username:
        try:
            principal = auth.principal(username)
        except Exception:  # noqa: BLE001 — a lookup failure never widens limits
            principal = None
    token_seconds = standard_token_seconds(state)
    if principal is None:
        return session_limits(policy, roles=(), token_seconds=token_seconds).without_remember()
    return limits_for_principal(prefs, getattr(principal, "role", ""), token_seconds=token_seconds)


def bounded_token_seconds(token_hours: Any) -> int:
    """The STANDARD session-token lifetime for ``AUTH_TOKEN_HOURS``, clamped below
    the registry prune grace (:data:`MAX_SESSION_TOKEN_SECONDS`) with a warning, so
    a revoked token can never outlive its registry row."""
    try:
        seconds = max(1, int(token_hours) * 3600)
    except (TypeError, ValueError, OverflowError):
        seconds = 12 * 3600
    if seconds > MAX_SESSION_TOKEN_SECONDS:
        logger.warning(
            "AUTH_TOKEN_HOURS=%s exceeds the %d-hour maximum (a revoked session must "
            "expire before its registry row is pruned); using %d hours",
            token_hours, MAX_SESSION_TOKEN_SECONDS // 3600, MAX_SESSION_TOKEN_SECONDS // 3600,
        )
        seconds = MAX_SESSION_TOKEN_SECONDS
    return seconds


__all__ = [
    "MAX_SESSION_TOKEN_SECONDS",
    "REMEMBER_MAX_SECONDS",
    "REMEMBER_MIN_SECONDS",
    "SessionLimits",
    "bounded_token_seconds",
    "effective_roles",
    "limits_for_principal",
    "limits_for_username",
    "remember_idle_window_seconds",
    "remember_policy",
    "remember_window_seconds",
    "session_limits",
    "standard_token_seconds",
    "strictest",
]
