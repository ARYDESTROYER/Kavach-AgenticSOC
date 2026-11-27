"""A tiny, dependency-free HS256 JWT (encode/decode).

This implements just enough of RFC 7519 / RFC 7515 (JWS compact serialization
with the ``HS256`` algorithm) to issue and verify short-lived session tokens
using only the standard library. It deliberately does NOT pull in PyJWT or any
JOSE package — the suite keeps zero new dependencies.

A token is three base64url segments joined by ``.``::

    base64url(header) . base64url(payload) . base64url(HMAC-SHA256(...))

Only ``HS256`` is accepted on both sides. ``decode`` verifies the signature in
constant time and enforces the ``exp`` claim, raising :class:`TokenError` for any
malformed / tampered / expired token.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from typing import Any

_HEADER = {"alg": "HS256", "typ": "JWT"}


class TokenError(Exception):
    """Raised when a token is malformed, has a bad signature, or is expired."""


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64url_decode(segment: str) -> bytes:
    # Restore padding stripped during encoding (urlsafe_b64decode requires it).
    padding = "=" * (-len(segment) % 4)
    try:
        return base64.urlsafe_b64decode(segment + padding)
    except (ValueError, TypeError) as exc:  # pragma: no cover - defensive
        raise TokenError("malformed token segment") from exc


def _sign(signing_input: bytes, secret: str) -> str:
    sig = hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest()
    return _b64url_encode(sig)


def encode(claims: dict[str, Any], secret: str, *, expires_in_s: int) -> str:
    """Sign ``claims`` into a compact HS256 JWT.

    ``iat`` (issued-at) and ``exp`` (expiry = now + ``expires_in_s``) are added
    automatically; any caller-supplied values for those keys are overwritten.
    """
    now = int(time.time())
    payload = dict(claims)
    payload["iat"] = now
    payload["exp"] = now + int(expires_in_s)

    header_b64 = _b64url_encode(json.dumps(_HEADER, separators=(",", ":")).encode("utf-8"))
    payload_b64 = _b64url_encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    signing_input = f"{header_b64}.{payload_b64}".encode("ascii")
    signature_b64 = _sign(signing_input, secret)
    return f"{header_b64}.{payload_b64}.{signature_b64}"


def decode(token: str, secret: str, *, verify_exp: bool = True) -> dict[str, Any]:
    """Verify ``token`` and return its claims, or raise :class:`TokenError`.

    Verification covers: structural well-formedness, the ``HS256`` algorithm, a
    constant-time signature check, and the ``exp`` expiry claim.

    ``verify_exp=False`` skips ONLY the expiry comparison (the signature and every
    structural check still apply, and ``exp`` must still be present). It exists so
    the server can explain an ended session (``/auth/me`` reports that it ended at
    its absolute limit; the Console never states how long the session lasted); a
    caller must never treat such claims as an authenticated principal.
    """
    if not isinstance(token, str):
        raise TokenError("token must be a string")
    parts = token.split(".")
    if len(parts) != 3:
        raise TokenError("token must have three segments")
    header_b64, payload_b64, signature_b64 = parts

    try:
        header = json.loads(_b64url_decode(header_b64))
    except (ValueError, TypeError) as exc:
        raise TokenError("malformed header") from exc
    if not isinstance(header, dict) or header.get("alg") != "HS256":
        raise TokenError("unsupported or missing algorithm")

    # A crafted token can carry NON-ASCII in a segment: ``.encode("ascii")`` then raises
    # UnicodeEncodeError, and ``compare_digest`` raises TypeError on non-ASCII strings.
    # Both must surface as a TokenError (→ 401), never an uncaught 500 on an auth-gated
    # route (audit #13).
    try:
        signing_input = f"{header_b64}.{payload_b64}".encode("ascii")
        expected_sig = _sign(signing_input, secret)
        sig_ok = hmac.compare_digest(expected_sig, signature_b64)
    except (UnicodeError, TypeError, ValueError) as exc:
        raise TokenError("malformed token segment") from exc
    if not sig_ok:
        raise TokenError("signature mismatch")

    try:
        payload = json.loads(_b64url_decode(payload_b64))
    except (ValueError, TypeError) as exc:
        raise TokenError("malformed payload") from exc
    if not isinstance(payload, dict):
        raise TokenError("payload is not an object")

    exp = payload.get("exp")
    if not isinstance(exp, (int, float)):
        raise TokenError("missing or invalid exp claim")
    if verify_exp and int(time.time()) >= int(exp):
        raise TokenError("token expired")

    return payload
