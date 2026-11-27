"""Central unsafe-HTTP admission middleware for factory-reset quiescence."""

from __future__ import annotations

import json

from ..engine.mutation_gate import MutationAdmissionClosed

_RECOVERY_PATHS = frozenset(
    {
        "/api/auth/login",
        "/api/auth/reauth",
        "/api/setup/account",
    }
)
_CLOSED_READ_PATHS = frozenset(
    {
        "/",
        "/api/health/live",
        "/api/setup/status",
    }
)


class MutationAdmissionMiddleware:
    """Drain/reject unsafe HTTP work while a factory reset owns the state boundary.

    ``POST /api/jobs`` remains reachable because the durable JobStore fence admits
    only a freshly-authorized factory retry while degraded.  Login/reauth/bootstrap
    are reachable only after the reset marks the boundary degraded; they never race
    the destructive phase itself.  Safe reads remain available for diagnostics.
    """

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        method = str(scope.get("method") or "GET").upper()
        app = scope.get("app")
        state = getattr(getattr(app, "state", None), "tlsoc", None)
        gate = getattr(state, "mutation_gate", None)
        if gate is None:
            await self.app(scope, receive, send)
            return
        path = str(scope.get("path") or "")
        if gate.closed:
            # Closed mode is default-deny for EVERY method. GET is not inherently
            # read-only here: SSO authorize/callback, readiness, session touch and SSE
            # registration all mutate tenant/runtime state. Only these proven recovery
            # reads bypass the handler counter. Jobs detail/list is intentionally not
            # included: even authenticated GET normally touches the session registry.
            if method in {"GET", "HEAD"} and path in _CLOSED_READ_PATHS:
                await self.app(scope, receive, send)
                return
            if method == "OPTIONS":
                await self.app(scope, receive, send)
                return
            if gate.degraded and method == "POST" and path == "/api/jobs":
                await self.app(scope, receive, send)
                return
            if gate.degraded and path in _RECOVERY_PATHS:
                await self.app(scope, receive, send)
                return
            await self._rejected(send)
            return
        try:
            async with gate.admit():
                await self.app(scope, receive, send)
        except MutationAdmissionClosed:
            await self._rejected(send)

    @staticmethod
    async def _rejected(send) -> None:
        payload = json.dumps(
            {
                "detail": {
                    "code": "factory_reset_in_progress",
                    "message": "tenant mutations are disabled until factory reset recovery completes",
                }
            },
            separators=(",", ":"),
        ).encode("utf-8")
        await send(
            {
                "type": "http.response.start",
                "status": 503,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(payload)).encode("ascii")),
                    (b"retry-after", b"5"),
                ],
            }
        )
        await send({"type": "http.response.body", "body": payload})
