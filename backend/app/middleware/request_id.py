"""Request-id middleware (Round 14 SPEC §4.5.3).

Every request gets one id, which the audit rows it writes carry as ``request_id`` so
an action row and its failure row pair up (SPEC §3.6), and which the response echoes
in ``X-Request-ID`` so an operator can quote it.

* An incoming ``X-Request-ID`` is honoured only when it matches
  ``^[A-Za-z0-9._-]{8,64}$``; anything else (missing, too short or long, other
  characters, several values) is replaced by a fresh UUIDv4. The id is therefore
  always safe to store and to echo.
* The id is stored on ``request.state.request_id`` and bound to the task
  (:func:`app.audit.context.current_request_id`) for the request's duration.
* The response always carries ``X-Request-ID`` with the id the request used,
  replacing any value a route set.
* The middleware also keeps the trusted proxy host names fresh
  (:meth:`app.audit.context.TrustedProxies.refresh_in_background`): a cheap clock
  check per request, and a lookup in a worker thread every 5 minutes (sooner, on a
  short backoff, for a name that does not resolve yet).

A pure ASGI middleware (not ``BaseHTTPMiddleware``) so streaming responses, the
``contextvars`` of the route and background tasks are untouched. Registered
outermost, so every response, a rate-limit or CSRF refusal included, carries the id.

An unhandled error is the one response the middleware cannot see: Starlette's
``ServerErrorMiddleware`` sits outside every user middleware and sends its 500 with
the server's own ``send``. :func:`internal_error_response` is that 500, registered
as the application's handler for ``Exception`` (``main.py``): the same plain
"Internal Server Error" body, with the request's ``X-Request-ID`` (read from the
request state the middleware filled, which outlives it), and one error log line that
names the id, so the id an operator quotes finds the traceback logged after it.
"""

from __future__ import annotations

import logging
from typing import Any, Awaitable, Callable, MutableMapping

from starlette.requests import Request
from starlette.responses import PlainTextResponse, Response

from ..audit.context import (
    REQUEST_ID_HEADER,
    REQUEST_ID_STATE_KEY,
    TrustedProxies,
    bind_request_id,
    honoured_request_id,
    new_request_id,
    trusted_proxies,
    unbind_request_id,
)

Scope = MutableMapping[str, Any]
Message = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]
ASGIApp = Callable[[Scope, Receive, Send], Awaitable[None]]

_HEADER_KEY = REQUEST_ID_HEADER.lower().encode("latin-1")

logger = logging.getLogger("tlsoc.middleware.request_id")


def _incoming_request_id(scope: Scope) -> str | None:
    """The honoured ``X-Request-ID`` of the request: exactly one value, in the
    accepted alphabet and length, else ``None``."""
    values = [value for key, value in scope.get("headers") or () if key.lower() == _HEADER_KEY]
    if len(values) != 1:
        return None
    try:
        text = values[0].decode("latin-1")
    except Exception:  # noqa: BLE001 (an undecodable value is replaced)
        return None
    return honoured_request_id(text)


class RequestIdMiddleware:
    """Give every HTTP request an id, expose it to the routes and echo it back."""

    def __init__(self, app: ASGIApp, *, trusted: TrustedProxies | None = None) -> None:
        self.app = app
        self._trusted = trusted

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        request_id = _incoming_request_id(scope) or new_request_id()
        state = scope.setdefault("state", {})
        if isinstance(state, dict):
            state[REQUEST_ID_STATE_KEY] = request_id
        proxies = self._trusted if self._trusted is not None else trusted_proxies()
        proxies.refresh_in_background()
        header_value = request_id.encode("latin-1")

        async def send_with_id(message: Message) -> None:
            if message.get("type") == "http.response.start":
                headers = [
                    (key, value) for key, value in (message.get("headers") or [])
                    if key.lower() != _HEADER_KEY
                ]
                headers.append((_HEADER_KEY, header_value))
                message["headers"] = headers
            await send(message)

        token = bind_request_id(request_id)
        try:
            await self.app(scope, receive, send_with_id)
        finally:
            unbind_request_id(token)


async def internal_error_response(request: Request, exc: Exception) -> Response:
    """The 500 of an unhandled error, carrying the request's ``X-Request-ID`` (see
    the module doc). Registered with ``app.add_exception_handler(Exception, ...)``;
    the server still logs the traceback (Starlette re-raises after sending)."""
    state = getattr(request, "state", None)
    request_id = honoured_request_id(getattr(state, REQUEST_ID_STATE_KEY, None)) \
        or new_request_id()
    logger.error("Request %s failed with an unhandled %s", request_id, type(exc).__name__)
    return PlainTextResponse(
        "Internal Server Error", status_code=500, headers={REQUEST_ID_HEADER: request_id},
    )


__all__ = ["RequestIdMiddleware", "internal_error_response"]
