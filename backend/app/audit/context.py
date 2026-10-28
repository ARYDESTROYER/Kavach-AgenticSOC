"""The request's audit context (Round 14 SPEC §4.5.3, §4.5.4, E15).

Every request-driven audit row names where it came from and who made it in the same
way, so writers never compute these by hand:

* ``client``: the client address (:func:`audit_client_ip`), the raw socket peer, the
  raw ``X-Forwarded-For`` header as untrusted text, and the user agent.
* ``session_ref``: an HMAC of the session id (``AuthService.session_ref``), never the
  token or the id itself.
* ``actor_role``: the role the actor held at the time of the request.
* ``request_id``: the id the request-id middleware gave the request
  (:mod:`app.middleware.request_id`), so the action row and a failure row pair up.

:func:`audit_context` builds all four from a request and never raises: a value it
cannot work out is ``None`` ("not recorded"), never a guess.

The client address is believed from a forwarded header only when the socket peer is
one of the named trusted proxies (:class:`TrustedProxies`, the ``TRUSTED_PROXIES``
setting), and then only the rightmost entry that is not itself a trusted proxy: the
walk starts at the entry the trusted peer appended and skips only addresses that are
trusted proxies (a load balancer in front of the bundled Web UI), so a caller can
never choose the recorded address by sending a header. Otherwise the address is the
socket peer, whatever the caller sent. So a caller that reaches the backend port
directly can never choose its recorded address. This is deliberately not
``state.client_ip_from``, which returns the first, client-supplied entry and stays as
it is for session metadata.

A row written before its actor has signed in (a failed sign-in, a second-factor
check, a refused single sign-on) is built with ``from_request=False``: the credential
the request happens to carry (another account's cookie in the same browser) is never
read, so the row never borrows that account's role or session.

The address and user agent are personal data (SPEC D9): they are recorded for the
audit trail only and are never an authorization input.
"""

from __future__ import annotations

import asyncio
import contextvars
import ipaddress
import logging
import os
import re
import socket
import threading
import time
import uuid
from dataclasses import dataclass
from typing import Any, Callable, Iterable, Mapping

from ..models import (
    AUDIT_FORWARDED_FOR_MAX_CHARS,
    AUDIT_REQUEST_ID_PATTERN,
    AUDIT_ROLE_MAX_CHARS,
    AUDIT_USER_AGENT_MAX_CHARS,
    AuditClient,
    normalise_audit_ip,
)

logger = logging.getLogger("tlsoc.audit.context")

#: The request and response header that carries the request id.
REQUEST_ID_HEADER = "X-Request-ID"
#: The key under ``request.state`` where the middleware stores the request id.
REQUEST_ID_STATE_KEY = "request_id"

_REQUEST_ID_RE = re.compile(AUDIT_REQUEST_ID_PATTERN)
_CURRENT_REQUEST_ID: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "audit_request_id", default=None,
)

#: How long resolved proxy host names are believed before they are looked up again.
TRUSTED_PROXY_REFRESH_SECONDS = 300.0
#: The upper bound on one round of host-name lookups (a slow resolver never stalls a
#: request: lookups run in a worker thread and their result is used when it arrives).
TRUSTED_PROXY_RESOLVE_TIMEOUT_SECONDS = 5.0
#: Consecutive failed lookups of a host name before its last resolved addresses stop
#: being believed (3 rounds of 5 minutes: one transient DNS failure never drops the
#: bundled proxy, so its requests never fall back to recording the proxy as the client).
TRUSTED_PROXY_FAILED_ROUNDS_TO_FORGET = 3
#: How soon a host name that does not resolve (it never has, or its last addresses
#: were forgotten) is looked up again, by consecutive rounds that left one unresolved;
#: the last step repeats. In the bundled Compose stack the Web UI starts only once the
#: backend is healthy, so ``tlsoc-webui`` cannot resolve at startup: waiting the full
#: :data:`TRUSTED_PROXY_REFRESH_SECONDS` would record the proxy as the client of every
#: first-run request (the first administrator, the first sign-in). Only the unresolved
#: names are retried; a name that resolves keeps the full cadence, so the
#: :data:`TRUSTED_PROXY_FAILED_ROUNDS_TO_FORGET` rounds still span 15 minutes.
TRUSTED_PROXY_UNRESOLVED_RETRY_SECONDS: tuple[float, ...] = (5.0, 10.0, 30.0, 60.0)
#: Entries accepted from the setting (a mistyped list never grows without bound).
_MAX_TRUSTED_PROXY_ENTRIES = 64
_PEER_MAX_CHARS = 64


# --------------------------------------------------------------------------- #
# Request id
# --------------------------------------------------------------------------- #
def honoured_request_id(value: Any) -> str | None:
    """``value`` when it is an acceptable ``X-Request-ID`` (``^[A-Za-z0-9._-]{8,64}$``),
    else ``None`` (the caller mints a fresh one)."""
    if isinstance(value, str) and _REQUEST_ID_RE.fullmatch(value):
        return value
    return None


def new_request_id() -> str:
    """A fresh request id (a random UUIDv4)."""
    return str(uuid.uuid4())


def current_request_id() -> str | None:
    """The id of the request being served in this task, or ``None`` outside one."""
    return _CURRENT_REQUEST_ID.get()


def bind_request_id(request_id: str | None) -> contextvars.Token:
    """Make ``request_id`` the current request id; pass the token to
    :func:`unbind_request_id` when the request ends."""
    return _CURRENT_REQUEST_ID.set(request_id)


def unbind_request_id(token: contextvars.Token) -> None:
    _CURRENT_REQUEST_ID.reset(token)


def request_id_of(request: Any) -> str | None:
    """The request id the middleware stored on ``request`` (or bound to this task)."""
    state = getattr(request, "state", None)
    value = getattr(state, REQUEST_ID_STATE_KEY, None) if state is not None else None
    return honoured_request_id(value) or honoured_request_id(current_request_id())


# --------------------------------------------------------------------------- #
# Trusted proxies
# --------------------------------------------------------------------------- #
Resolver = Callable[[str], Iterable[str]]


def _system_resolver(name: str) -> list[str]:
    """Every address ``name`` resolves to through the system resolver (the container
    DNS in Compose). Raises ``OSError`` for an unknown name."""
    infos = socket.getaddrinfo(name, None, proto=socket.IPPROTO_TCP)
    return [str(info[4][0]) for info in infos]


def _parse_entries(spec: str | Iterable[str] | None) -> tuple[
    tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, ...], tuple[str, ...]
]:
    if spec is None:
        raw: list[str] = []
    elif isinstance(spec, str):
        raw = spec.split(",")
    else:
        raw = [str(item) for item in spec]
    networks: list[ipaddress.IPv4Network | ipaddress.IPv6Network] = []
    names: list[str] = []
    for item in raw:
        text = item.strip()
        if not text:
            continue
        if len(networks) + len(names) >= _MAX_TRUSTED_PROXY_ENTRIES:
            logger.warning("TRUSTED_PROXIES lists more than %d entries; the rest are ignored",
                           _MAX_TRUSTED_PROXY_ENTRIES)
            break
        try:
            networks.append(ipaddress.ip_network(text, strict=False))
            continue
        except ValueError:
            pass
        if len(text) <= 253 and re.fullmatch(r"[A-Za-z0-9_.-]+", text):
            names.append(text.lower())
        else:
            logger.warning("TRUSTED_PROXIES entry %r is not an address, range or host name; ignored",
                           text[:80])
    return tuple(networks), tuple(dict.fromkeys(names))


class TrustedProxies:
    """The proxies whose ``X-Forwarded-For`` header is believed (SPEC §4.5.3).

    Addresses and CIDR ranges apply at once. Host names are resolved through the
    system resolver by :meth:`refresh` (in a worker thread, never on the event loop)
    and believed for :data:`TRUSTED_PROXY_REFRESH_SECONDS`. A name that has never
    resolved is ignored until a round resolves it, and is retried on a short backoff
    (:data:`TRUSTED_PROXY_UNRESOLVED_RETRY_SECONDS`) rather than the full cadence, so
    a proxy that starts after the backend is believed within seconds. A name that
    resolved before keeps
    its last addresses through a failed lookup, and loses them only after
    :data:`TRUSTED_PROXY_FAILED_ROUNDS_TO_FORGET` failed rounds in a row (a transient
    DNS failure never drops the bundled proxy). Until the first round has finished a
    host name matches nothing, so the peer is recorded: never a guess."""

    def __init__(
        self,
        spec: str | Iterable[str] | None = "",
        *,
        resolver: Resolver | None = None,
        clock: Callable[[], float] = time.monotonic,
        refresh_seconds: float = TRUSTED_PROXY_REFRESH_SECONDS,
    ) -> None:
        self._networks, self._names = _parse_entries(spec)
        self._resolver = resolver or _system_resolver
        self._clock = clock
        self._refresh_seconds = float(refresh_seconds)
        self._resolved: frozenset[ipaddress.IPv4Address | ipaddress.IPv6Address] = frozenset()
        self._by_name: dict[str, frozenset[ipaddress.IPv4Address | ipaddress.IPv6Address]] = {}
        self._failures: dict[str, int] = {}
        self._resolved_at: float | None = None  # the last full round
        self._attempted_at: float | None = None  # the last round of either kind
        self._unresolved_rounds = 0  # consecutive rounds that left a name unresolved
        self._lock = threading.Lock()
        self._refreshing = False

    @property
    def names(self) -> tuple[str, ...]:
        return self._names

    @property
    def networks(self) -> tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, ...]:
        return self._networks

    @property
    def resolved_addresses(self) -> frozenset[ipaddress.IPv4Address | ipaddress.IPv6Address]:
        return self._resolved

    def matches(self, address: str | None) -> bool:
        """Is ``address`` (a socket peer) one of the trusted proxies?"""
        parsed = _parse_address(address)
        if parsed is None:
            return False
        if parsed in self._resolved:
            return True
        return any(parsed.version == net.version and parsed in net for net in self._networks)

    def unresolved_names(self) -> tuple[str, ...]:
        """The host names no address is believed for now (never resolved, or forgotten)."""
        by_name = self._by_name
        return tuple(name for name in self._names if name not in by_name)

    def _retry_interval(self) -> float | None:
        if not self._unresolved_rounds:
            return None
        steps = TRUSTED_PROXY_UNRESOLVED_RETRY_SECONDS
        step = steps[min(self._unresolved_rounds, len(steps)) - 1]
        return min(self._refresh_seconds, step)

    def _due_round(self) -> tuple[bool, tuple[str, ...]] | None:
        """``(full, names)`` of the round that is due now, or ``None``: a full round
        of every name on the refresh cadence, else a retry of the unresolved names on
        their backoff."""
        if not self._names or self._refreshing:
            return None
        now = self._clock()
        last_full = self._resolved_at
        if last_full is None or now - last_full >= self._refresh_seconds:
            return True, self._names
        interval = self._retry_interval()
        last = self._attempted_at
        if interval is not None and (last is None or now - last >= interval):
            unresolved = self.unresolved_names()
            if unresolved:
                return False, unresolved
        return None

    def due(self) -> bool:
        """True when host names need (re)resolving and no round is running: every name
        on the refresh cadence, an unresolved one sooner (see the class doc)."""
        return self._due_round() is not None

    def refresh(
        self, names: Iterable[str] | None = None,
    ) -> frozenset[ipaddress.IPv4Address | ipaddress.IPv6Address]:
        """Resolve host names now (blocking; call it from a worker thread): every name
        (a full round), or only ``names`` (a retry of unresolved ones). A name that
        resolves replaces its addresses; a name that fails keeps its last ones until it
        has failed :data:`TRUSTED_PROXY_FAILED_ROUNDS_TO_FORGET` rounds in a row (a name
        that never resolved contributes nothing). Never raises."""
        full = names is None
        wanted = set(names or ())
        targets = self._names if full else tuple(n for n in self._names if n in wanted)
        by_name = dict(self._by_name)
        failures = dict(self._failures)
        for name in targets:
            try:
                addresses = frozenset(
                    parsed for parsed in (_parse_address(text) for text in self._resolver(name))
                    if parsed is not None
                )
            except Exception as exc:  # noqa: BLE001 (an unresolvable name is handled below)
                addresses = None
                reason = type(exc).__name__
            else:
                reason = "no address"
            if addresses:
                by_name[name] = addresses
                failures.pop(name, None)
                continue
            failures[name] = failures.get(name, 0) + 1
            if name in by_name and failures[name] >= TRUSTED_PROXY_FAILED_ROUNDS_TO_FORGET:
                by_name.pop(name, None)
                logger.warning(
                    "Trusted proxy %r has not resolved for %d rounds (%s); its last "
                    "addresses are no longer believed", name, failures[name], reason,
                )
            elif name in by_name:
                logger.info("Trusted proxy %r did not resolve (%s); keeping its last "
                            "addresses for now", name, reason)
            elif full or failures[name] == 1:
                # Logged once, then on each full round: a retry every few seconds is
                # not news.
                logger.info("Trusted proxy %r did not resolve (%s); it is ignored for now "
                            "and retried shortly", name, reason)
        resolved = frozenset(addr for addresses in by_name.values() for addr in addresses)
        self._by_name = by_name
        self._failures = failures
        self._resolved = resolved
        now = self._clock()
        self._attempted_at = now
        if full:
            self._resolved_at = now
        if any(name not in by_name for name in self._names):
            self._unresolved_rounds += 1
        else:
            self._unresolved_rounds = 0
        return resolved

    def _refresh_guarded(self, names: tuple[str, ...] | None = None) -> None:
        try:
            self.refresh(names)
        except Exception as exc:  # noqa: BLE001 (defensive: refresh() never raises)
            logger.warning("Trusted proxy refresh failed: %s", exc)
        finally:
            with self._lock:
                self._refreshing = False

    def _claim(self) -> tuple[bool, tuple[str, ...] | None]:
        """Claim the due round: ``(True, None)`` for a full round, ``(True, names)``
        for a retry of unresolved names, ``(False, None)`` when nothing is due."""
        with self._lock:
            due = self._due_round()
            if due is None:
                return False, None
            self._refreshing = True
            full, names = due
            return True, (None if full else names)

    def refresh_in_background(self) -> bool:
        """Start a resolution round in a worker thread when one is due (startup, then
        every 5 minutes); returns whether one was started. Cheap when nothing is due,
        so the request-id middleware calls it on every request. Never raises."""
        if not self.due():
            return False
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return False
        claimed, names = self._claim()
        if not claimed:
            return False
        try:
            future = loop.run_in_executor(None, self._refresh_guarded, names)
        except Exception as exc:  # noqa: BLE001 (an executor that refuses work)
            with self._lock:
                self._refreshing = False
            logger.warning("Trusted proxy refresh could not start: %s", exc)
            return False
        future.add_done_callback(_ignore_result)
        return True

    async def refresh_now(self, timeout: float = TRUSTED_PROXY_RESOLVE_TIMEOUT_SECONDS) -> bool:
        """Resolve now in a worker thread and wait at most ``timeout`` seconds;
        returns whether the round finished in time (a late round still lands)."""
        if not self._names:
            return True
        claimed, names = self._claim()
        if not claimed:
            return False
        loop = asyncio.get_running_loop()
        future = loop.run_in_executor(None, self._refresh_guarded, names)
        try:
            await asyncio.wait_for(asyncio.shield(future), timeout)
            return True
        except asyncio.TimeoutError:
            future.add_done_callback(_ignore_result)
            logger.warning("Resolving TRUSTED_PROXIES took longer than %.0f s; continuing", timeout)
            return False


def _ignore_result(future: Any) -> None:
    try:
        future.result()
    except BaseException:  # noqa: BLE001 (already logged by the guarded refresh)
        pass


def _parse_address(value: Any) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    text = normalise_audit_ip(value) if isinstance(value, str) else None
    if text is None:
        return None
    try:
        parsed = ipaddress.ip_address(text)
    except ValueError:
        return None
    mapped = getattr(parsed, "ipv4_mapped", None)
    return mapped if mapped is not None else parsed


_TRUSTED: TrustedProxies | None = None
_TRUSTED_GUARD = threading.Lock()


def configure_trusted_proxies(spec: str | Iterable[str] | None, *,
                              resolver: Resolver | None = None) -> TrustedProxies:
    """Install the process-wide trusted proxy list (startup, and tests)."""
    global _TRUSTED
    proxies = TrustedProxies(spec, resolver=resolver)
    with _TRUSTED_GUARD:
        _TRUSTED = proxies
    return proxies


def trusted_proxies() -> TrustedProxies:
    """The process-wide trusted proxy list; read from ``TRUSTED_PROXIES`` on first use
    when startup did not configure one."""
    global _TRUSTED
    current = _TRUSTED
    if current is not None:
        return current
    with _TRUSTED_GUARD:
        if _TRUSTED is None:
            try:
                from ..config import Secrets

                spec = Secrets().trusted_proxies
            except Exception as exc:  # noqa: BLE001 (an unreadable setting trusts no proxy)
                logger.warning("TRUSTED_PROXIES could not be read (%s); no proxy is trusted", exc)
                spec = ""
            _TRUSTED = TrustedProxies(spec)
        return _TRUSTED


# --------------------------------------------------------------------------- #
# Client address
# --------------------------------------------------------------------------- #
def _peer_of(request: Any) -> str:
    client = getattr(request, "client", None)
    host = getattr(client, "host", None) if client is not None else None
    if host is None and isinstance(client, (tuple, list)) and client:
        host = client[0]
    return str(host or "")[:_PEER_MAX_CHARS]


def _port_of(request: Any) -> int | None:
    client = getattr(request, "client", None)
    port = getattr(client, "port", None) if client is not None else None
    if port is None and isinstance(client, (tuple, list)) and len(client) > 1:
        port = client[1]
    return port if isinstance(port, int) and not isinstance(port, bool) else None


#: The server's own proxy-header trust (uvicorn's ``--forwarded-allow-ips``), read
#: once. Uvicorn rewrites the socket peer of a request from one of these hosts to an
#: ``X-Forwarded-For`` entry and marks it with port 0 (a real TCP peer never has
#: port 0); see :func:`_socket_peer`.
_SERVER_FORWARDED_ALLOW_IPS = os.environ.get("FORWARDED_ALLOW_IPS", "127.0.0.1")


def _socket_peer(request: Any, forwarded_raw: str | None) -> tuple[str, bool]:
    """``(socket peer, known)``. The ASGI server (uvicorn, proxy headers on by
    default) replaces the peer of a request that came from one of ITS trusted hosts
    (``FORWARDED_ALLOW_IPS``, loopback by default) with an ``X-Forwarded-For`` entry
    and port 0, before the application sees it. That entry is caller-supplied, so it
    is never recorded as the peer: the real peer is the server's single trusted host
    when there is exactly one, and unknown otherwise. Only ``TRUSTED_PROXIES``
    decides whether a forwarded header is believed."""
    peer = _peer_of(request)
    if not forwarded_raw or _port_of(request) != 0:
        return peer, True
    hosts = [h.strip() for h in _SERVER_FORWARDED_ALLOW_IPS.split(",") if h.strip()]
    if len(hosts) == 1 and hosts[0] != "*" and normalise_audit_ip(hosts[0]) is not None:
        return hosts[0][:_PEER_MAX_CHARS], True
    return "", False


def _header_values(request: Any, name: str) -> list[str]:
    headers = getattr(request, "headers", None)
    if headers is None:
        return []
    getlist = getattr(headers, "getlist", None)
    if callable(getlist):
        return [str(v) for v in getlist(name)]
    value = headers.get(name) if hasattr(headers, "get") else None
    return [str(value)] if value is not None else []


#: Forwarded entries walked at most, counted from the right (the end the trusted
#: proxies append to). Entries left of this window are never read: padding the header
#: can never push the entry the trusted proxy appended out of the walk.
_MAX_FORWARDED_HOPS = 32
#: The marker that opens a ``forwarded_for`` value cut to its tail.
_FORWARDED_TAIL_MARKER = "..."


def _forwarded_client(header: str, proxies: TrustedProxies) -> str | None:
    """The client address in an ``X-Forwarded-For`` header a trusted proxy sent:
    the rightmost entry that is not itself a trusted proxy.

    The walk starts at the right, at the entry the trusted peer appended, and skips
    only entries that are trusted proxies (each of those appended the entry to its
    left). The first parsed address that is not a trusted proxy is the client. Only
    the last :data:`_MAX_FORWARDED_HOPS` entries are walked, so a caller that pads
    the header with junk can never push its own address (appended by the trusted
    proxy) out of reach. The walk stops with ``None`` (the peer is recorded) at an
    entry that cannot be parsed, so a forged entry never wins whatever range it
    claims, and when the window holds only trusted proxies and more entries lie
    beyond it (a forged entry left of the window is never read). When the whole
    header holds only trusted proxies, the leftmost one is the furthest hop seen and
    is returned."""
    entries = [part.strip() for part in header.split(",")]
    entries = [part for part in entries if part]
    if not entries:
        return None
    window = entries[-_MAX_FORWARDED_HOPS:]
    furthest_proxy: str | None = None
    for entry in reversed(window):
        candidate = normalise_audit_ip(entry)
        if candidate is None:
            return None
        if proxies.matches(candidate):
            furthest_proxy = candidate
            continue
        return candidate
    if len(window) < len(entries):
        return None
    return furthest_proxy


def _forwarded_for_text(raw: str | None) -> str | None:
    """The raw header kept as untrusted text, at most
    :data:`AUDIT_FORWARDED_FOR_MAX_CHARS` characters. A longer header keeps its TAIL
    (after a ``...`` marker): the entries the trusted proxies appended are at the
    right, so padding at the left never cuts them from the record."""
    if not raw:
        return None
    if len(raw) <= AUDIT_FORWARDED_FOR_MAX_CHARS:
        return raw
    keep = AUDIT_FORWARDED_FOR_MAX_CHARS - len(_FORWARDED_TAIL_MARKER)
    return _FORWARDED_TAIL_MARKER + raw[-keep:]


def audit_client_ip(request: Any, trusted: TrustedProxies | None = None) -> AuditClient:
    """Where a request came from, for its audit row (SPEC §4.5.3, E15).

    When the socket peer is a trusted proxy and the request carries
    ``X-Forwarded-For``, ``ip`` is the rightmost entry that is not itself a trusted
    proxy (:func:`_forwarded_client`: the bundled proxy's entry, or behind a trusted
    load balancer the entry that one appended) and ``ip_source`` is
    ``trusted_proxy``. Otherwise ``ip`` is the socket peer and ``ip_source`` is
    ``peer``: headers from anyone else are never believed. ``ip`` is always a parsed
    address or ``None`` (never an empty string): a peer that is not an address (a
    Unix socket, a test client) leaves it ``None`` and stays readable in ``peer``.
    ``forwarded_for`` keeps the raw header as untrusted text, at most 256
    characters: a longer header keeps its tail (:func:`_forwarded_for_text`), where
    the trusted proxies appended their entries. The user agent is cut to 512
    characters. A peer the ASGI server already replaced
    with a forwarded entry is undone first (:func:`_socket_peer`)."""
    proxies = trusted if trusted is not None else trusted_proxies()
    forwarded_values = _header_values(request, "x-forwarded-for")
    forwarded_raw = ", ".join(v for v in forwarded_values if v is not None) if forwarded_values else None
    peer, _known = _socket_peer(request, forwarded_raw)
    user_agent = ", ".join(_header_values(request, "user-agent"))[:AUDIT_USER_AGENT_MAX_CHARS]

    ip: str | None = None
    ip_source = "peer"
    if forwarded_raw and proxies.matches(peer):
        candidate = _forwarded_client(forwarded_raw, proxies)
        if candidate is not None:
            ip, ip_source = candidate, "trusted_proxy"
    if ip is None:
        ip = normalise_audit_ip(peer)
        ip_source = "peer"
    return AuditClient(
        ip=ip,
        ip_source=ip_source,  # type: ignore[arg-type]
        peer=peer,
        forwarded_for=_forwarded_for_text(forwarded_raw),
        user_agent=user_agent,
    )


# --------------------------------------------------------------------------- #
# The context
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class AuditContext:
    """What a request-driven audit row records about its request. ``actor`` is the
    signed-in username ("" with sign-in off or before sign-in); the four other fields
    are the Round 14 record fields (SPEC §4.5.3). ``audited_write`` and the view
    recorder read the fields by name."""

    client: AuditClient | None = None
    session_ref: str | None = None
    actor_role: str | None = None
    request_id: str | None = None
    actor: str = ""

    def record_fields(self) -> dict[str, Any]:
        """The keyword arguments ``AuditRepository.record`` / ``record_strict`` take."""
        return {
            "client": self.client,
            "session_ref": self.session_ref,
            "actor_role": self.actor_role,
            "request_id": self.request_id,
        }


def _state_of(request: Any) -> Any:
    app = getattr(request, "app", None)
    return getattr(getattr(app, "state", None), "tlsoc", None)


def _token_of(request: Any) -> str | None:
    cookies = getattr(request, "cookies", None) or {}
    token = cookies.get("tlsoc_token") if hasattr(cookies, "get") else None
    if token:
        return str(token)
    headers = getattr(request, "headers", None)
    auth = headers.get("authorization") if headers is not None and hasattr(headers, "get") else None
    if isinstance(auth, str) and auth.lower().startswith("bearer "):
        return auth.split(" ", 1)[1].strip() or None
    return None


def effective_role(state: Any, user: Any) -> str | None:
    """The role a signed-in principal acts with: its stored role, or ``super_admin``
    while role-based access control is off (every signed-in principal then has every
    permission, the Console's ``_resolved_role`` rule). ``None`` without a principal."""
    if user is None:
        return None
    rbac = getattr(getattr(state, "prefs", None), "rbac", None)
    if rbac is not None and not getattr(rbac, "enabled", False):
        return "super_admin"
    role = getattr(user, "role", "") or (getattr(rbac, "default_role", "") if rbac is not None else "")
    role = getattr(role, "value", role)
    text = str(role or "")[:AUDIT_ROLE_MAX_CHARS]
    return text or None


def _principal(state: Any, request: Any, token: str | None) -> Any:
    auth = getattr(state, "auth", None)
    if auth is None or not getattr(auth, "is_enabled", False) or not token:
        return None
    try:
        return auth.verify(token)
    except Exception:  # noqa: BLE001 (an unreadable token is no principal)
        return None


def _claims_sid(auth: Any, token: str | None) -> str | None:
    """The ``sid`` claim of a token this server signed, or ``None``."""
    if auth is None or not token:
        return None
    try:
        claims = auth.claims_of(token) or {}
    except Exception:  # noqa: BLE001
        return None
    value = claims.get("sid") if isinstance(claims, Mapping) else None
    return str(value) if value else None


def _session_ref(state: Any, *, sid: str | None, token: str | None, user: Any,
                 request_token: str | None) -> str | None:
    """The reference of the session the row is about: ``sid`` when given, else the
    session of the token a sign-in route just minted, else the principal's own
    session (the request's session when the principal is the request's user;
    ``request_token`` is ``None`` for a row written before sign-in)."""
    auth = getattr(state, "auth", None)
    if auth is None or not getattr(auth, "is_enabled", False):
        return None
    the_sid = sid or _claims_sid(auth, token)
    if not the_sid and user is not None:
        principal_sid = getattr(user, "sid", None)
        the_sid = principal_sid if isinstance(principal_sid, str) and principal_sid else None
    if not the_sid and user is None:
        the_sid = _claims_sid(auth, request_token)
    ref_of = getattr(auth, "session_ref", None)
    return ref_of(the_sid) if callable(ref_of) and the_sid else None


def audit_context(
    request: Any,
    *,
    user: Any = None,
    token: str | None = None,
    sid: str | None = None,
    actor_role: str | None = None,
    from_request: bool = True,
) -> AuditContext:
    """The audit context of ``request`` (SPEC §4.5.4). Never raises.

    By default the principal is the request's own signed-in user. A sign-in route
    passes the principal it just verified (``user``) and the token it just minted
    (``token``) so the row names the new session; ``sid`` names a session directly;
    ``actor_role`` overrides the role (a principal that is not the request's user).

    ``from_request=False`` is for a row written before its actor has signed in (a
    failed sign-in, a second-factor check, a refused single sign-on, a refresh): the
    credential the request carries is never read, so a cookie another account left
    in the same browser never lends that account's role or session to the row. The
    principal is then only ``user`` (or the ``token`` just minted)."""
    state = _state_of(request)
    try:
        client: AuditClient | None = audit_client_ip(request)
    except Exception as exc:  # noqa: BLE001 (the row is written without it)
        logger.debug("audit client unavailable: %s", exc)
        client = None
    request_token: str | None = None
    if from_request:
        try:
            request_token = _token_of(request)
        except Exception:  # noqa: BLE001
            request_token = None
    principal = user if user is not None else _principal(state, request, token or request_token)
    try:
        session_ref = _session_ref(state, sid=sid, token=token, user=user,
                                   request_token=request_token)
    except Exception as exc:  # noqa: BLE001
        logger.debug("audit session reference unavailable: %s", exc)
        session_ref = None
    role = actor_role
    if role is None:
        try:
            role = effective_role(state, principal)
        except Exception:  # noqa: BLE001
            role = None
    try:
        request_id = request_id_of(request)
    except Exception:  # noqa: BLE001
        request_id = honoured_request_id(current_request_id())
    username = str(getattr(principal, "username", "") or "") if principal is not None else ""
    return AuditContext(
        client=client,
        session_ref=session_ref,
        actor_role=(str(role)[:AUDIT_ROLE_MAX_CHARS] or None) if role else None,
        request_id=request_id,
        actor=username,
    )


__all__ = [
    "REQUEST_ID_HEADER",
    "REQUEST_ID_STATE_KEY",
    "TRUSTED_PROXY_FAILED_ROUNDS_TO_FORGET",
    "TRUSTED_PROXY_REFRESH_SECONDS",
    "AuditContext",
    "TrustedProxies",
    "audit_client_ip",
    "audit_context",
    "bind_request_id",
    "configure_trusted_proxies",
    "current_request_id",
    "effective_role",
    "honoured_request_id",
    "new_request_id",
    "request_id_of",
    "trusted_proxies",
    "unbind_request_id",
]
