"""TOTP / MFA primitives — pure standard library (RFC 6238 / RFC 4226).

Wave 2 (F3) adds opt-in time-based one-time-password MFA on top of the Wave-1
password login. There is intentionally NO third-party dependency (no ``pyotp`` /
``qrcode``): TOTP is a tiny HMAC construction and the QR is rendered client-side
from the ``otpauth://`` URI we hand back.

What lives here (all stdlib — ``hmac``/``hashlib``/``struct``/``base64``/``time``/
``secrets``):

* :func:`generate_secret` — a fresh Base32 shared secret (160-bit, RFC-recommended).
* :func:`hotp` / :func:`totp` — the HMAC-based / time-based OTP per RFC 4226 / 6238.
* :func:`verify_totp` — window-tolerant verification (±``window`` steps) WITH replay
  rejection: the matched step must be strictly greater than the stored ``last_step``.
* :func:`provisioning_uri` — the ``otpauth://totp/...`` URI for the authenticator app.
* :func:`generate_recovery_codes` + :func:`hash_recovery_code` /
  :func:`verify_recovery_code` — single-use fallback codes (PBKDF2-hashed at rest).
* :func:`obfuscate_secret` / :func:`deobfuscate_secret` — stdlib at-rest protection
  of the shared secret via an HMAC-SHA256 keystream XOR keyed by a server key. This
  is **obfuscation, not a KMS**: it raises the bar for a stolen state dump but the
  server key (derived from ``auth_jwt_secret`` when unset) is itself a secret-tier
  value, not hardware-protected. Documented as a production-hardening seam.

RFC 6238 Appendix-B test vectors (SHA1 path; the seed is the ASCII string
``"12345678901234567890"`` Base32-encoded) — asserted by ``tests/test_mfa.py``::

    T (unix)      step (T/30)        TOTP8       TOTP6
    59            0x0000000000000001 94287082    287082
    1111111109    0x00000000023523EC 07081804    081804
    1111111111    0x00000000023523ED 14050471    050471
    1234567890    0x000000000273EF07 89005924    005924
    2000000000    0x0000000003F940AA 69279037    279037
    20000000000   0x0000000027BC86AA 65353130    353130
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import struct
import time
from urllib.parse import quote

# RFC 6238 Appendix-B shared seed (ASCII), the canonical SHA1 test key. Exposed so
# the test module can reference the EXACT same constant without re-deriving it.
RFC6238_TEST_SEED_ASCII = "12345678901234567890"

# (unix_time, expected 6-digit TOTP) — the SHA1 rows of RFC 6238 Appendix B.
RFC6238_SHA1_VECTORS: tuple[tuple[int, str], ...] = (
    (59, "287082"),
    (1111111109, "081804"),
    (1111111111, "050471"),
    (1234567890, "005924"),
    (2000000000, "279037"),
    (20000000000, "353130"),
)

_DEFAULT_PERIOD = 30
_DEFAULT_DIGITS = 6
_SECRET_BYTES = 20  # 160-bit, RFC 4226 §4 recommendation


# --------------------------------------------------------------------------- #
# Base32 secret handling
# --------------------------------------------------------------------------- #
def generate_secret() -> str:
    """A fresh, unpadded uppercase Base32 shared secret (160-bit / 32 chars)."""
    return base64.b32encode(secrets.token_bytes(_SECRET_BYTES)).decode("ascii").rstrip("=")


def _b32decode(secret: str) -> bytes:
    """Decode a (possibly unpadded, possibly spaced/lowercased) Base32 secret.

    Authenticator apps display the secret in lowercase groups of four; we accept
    that liberally so a manually-entered secret round-trips. Raises ``ValueError``
    on a truly invalid secret."""
    cleaned = (secret or "").strip().replace(" ", "").replace("-", "").upper()
    if not cleaned:
        raise ValueError("empty TOTP secret")
    padding = "=" * (-len(cleaned) % 8)
    return base64.b32decode(cleaned + padding, casefold=True)


# --------------------------------------------------------------------------- #
# HOTP / TOTP (RFC 4226 / RFC 6238)
# --------------------------------------------------------------------------- #
def hotp(secret: str, counter: int, *, digits: int = _DEFAULT_DIGITS) -> str:
    """RFC 4226 HMAC-based OTP for ``secret`` (Base32) at integer ``counter``.

    Always SHA1 (the universally-supported authenticator algorithm). Returns the
    zero-padded ``digits``-length decimal code."""
    key = _b32decode(secret)
    msg = struct.pack(">Q", int(counter))
    digest = hmac.new(key, msg, hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    binary = struct.unpack(">I", digest[offset : offset + 4])[0] & 0x7FFFFFFF
    return str(binary % (10**digits)).zfill(digits)


def totp(
    secret: str,
    *,
    ts: float | None = None,
    period: int = _DEFAULT_PERIOD,
    digits: int = _DEFAULT_DIGITS,
) -> str:
    """RFC 6238 time-based OTP: :func:`hotp` over the time-step ``floor(ts/period)``."""
    now = time.time() if ts is None else float(ts)
    counter = int(now // int(period or _DEFAULT_PERIOD))
    return hotp(secret, counter, digits=digits)


def verify_totp(
    secret: str,
    code: str,
    *,
    ts: float | None = None,
    window: int = 1,
    period: int = _DEFAULT_PERIOD,
    digits: int = _DEFAULT_DIGITS,
    last_step: int | None = None,
) -> tuple[bool, int]:
    """Constant-time verify ``code`` against ``secret`` within ±``window`` steps.

    Returns ``(ok, matched_step)``. ``matched_step`` is the time-step the code
    matched (caller persists it as the new ``mfa_last_step``); it is ``-1`` when no
    step matched.

    **Replay protection:** when ``last_step`` is provided, any matched step that is
    ``<= last_step`` is REJECTED — so a code that was already accepted (or an older
    in-window code) cannot be reused. Never raises (a malformed secret/code → fail
    closed)."""
    code = (code or "").strip().replace(" ", "")
    if not code or not code.isdigit():
        return (False, -1)
    now = time.time() if ts is None else float(ts)
    step = int(now // int(period or _DEFAULT_PERIOD))
    span = max(0, int(window))
    try:
        # Walk oldest→newest so the LARGEST matching step wins (monotonic last_step).
        matched = -1
        for offset in range(-span, span + 1):
            candidate = hotp(secret, step + offset, digits=digits)
            if hmac.compare_digest(candidate, code):
                matched = step + offset
        if matched < 0:
            return (False, -1)
        if last_step is not None and matched <= int(last_step):
            return (False, matched)  # replay / stale code
        return (True, matched)
    except (ValueError, TypeError):
        return (False, -1)


# --------------------------------------------------------------------------- #
# Provisioning URI (otpauth://) for the authenticator-app QR
# --------------------------------------------------------------------------- #
def provisioning_uri(
    secret: str,
    account: str,
    issuer: str,
    *,
    digits: int = _DEFAULT_DIGITS,
    period: int = _DEFAULT_PERIOD,
) -> str:
    """Build the ``otpauth://totp/{issuer}:{account}?...`` provisioning URI.

    The label is ``Issuer:account`` (both percent-encoded); ``issuer`` is repeated
    as a query parameter per the Key-URI spec. Algorithm is always SHA1."""
    issuer = (issuer or "Agentic SOC").strip() or "Agentic SOC"
    account = (account or "user").strip() or "user"
    label = quote(f"{issuer}:{account}", safe="")
    params = (
        f"secret={secret}"
        f"&issuer={quote(issuer, safe='')}"
        f"&algorithm=SHA1"
        f"&digits={int(digits)}"
        f"&period={int(period)}"
    )
    return f"otpauth://totp/{label}?{params}"


# --------------------------------------------------------------------------- #
# Recovery codes (single-use, PBKDF2-hashed at rest)
# --------------------------------------------------------------------------- #
def _norm_recovery(code: str) -> str:
    """Canonicalise a recovery code for hashing/comparison (case + separators)."""
    return (code or "").strip().replace("-", "").replace(" ", "").upper()


def generate_recovery_codes(n: int = 10) -> list[str]:
    """``n`` random single-use recovery codes, formatted ``XXXX-XXXX`` (8 hex chars)."""
    out: list[str] = []
    for _ in range(max(1, int(n))):
        raw = secrets.token_bytes(4).hex().upper()  # 8 hex chars
        out.append(f"{raw[:4]}-{raw[4:]}")
    return out


def hash_recovery_code(code: str) -> str:
    """Hash a recovery code for at-rest storage (reuses the PBKDF2 password hasher)."""
    from .passwords import hash_password

    return hash_password(_norm_recovery(code))


def verify_recovery_code(code: str, stored_hash: str) -> bool:
    """Constant-time verify a recovery code against one stored hash."""
    from .passwords import verify_password

    return verify_password(_norm_recovery(code), stored_hash)


_RECOVERY_SHAPE = frozenset("0123456789ABCDEF")


def looks_like_recovery_code(code: str) -> bool:
    """Whether ``code`` has the shape of a recovery code: 8 hex characters once case,
    dashes and spaces are normalised. A six-digit authenticator code never does, so
    it never runs the recovery-code PBKDF2 loop (Round 16, B18)."""
    norm = _norm_recovery(code)
    return len(norm) == 8 and all(ch in _RECOVERY_SHAPE for ch in norm)


async def averify_recovery_code(code: str, stored_hash: str) -> bool:
    """:func:`verify_recovery_code` off the event loop, under the hashing semaphore."""
    from .passwords import run_hashing

    return await run_hashing(verify_recovery_code, code, stored_hash)


async def ahash_recovery_codes(codes: list[str]) -> list[str]:
    """Hash every recovery code in one worker-thread call under the semaphore."""
    from .passwords import run_hashing

    def _all() -> list[str]:
        return [hash_recovery_code(c) for c in codes]

    return await run_hashing(_all)


async def amatch_recovery_hash(code: str, stored_hashes: list[str]) -> str | None:
    """The stored hash ``code`` matches, found off the event loop, or ``None``.

    Only a code with the recovery-code shape is checked; anything else answers
    ``None`` without hashing. The caller consumes the exact returned string inside
    its own compare-and-swap (Round 16, B23), so no PBKDF2 runs inside a mutator."""
    if not looks_like_recovery_code(code):
        return None
    for stored in list(stored_hashes or []):
        if await averify_recovery_code(code, stored):
            return stored
    return None


# --------------------------------------------------------------------------- #
# At-rest secret obfuscation (stdlib HMAC keystream XOR — NOT a KMS)
# --------------------------------------------------------------------------- #
_OBF_PREFIX = "obf1:"


def _keystream(server_key: str, salt: bytes, length: int) -> bytes:
    """An HMAC-SHA256 counter-mode keystream of ``length`` bytes keyed by
    ``server_key`` + ``salt`` (so two encryptions of the same secret differ)."""
    key = (server_key or "tlsoc-mfa").encode("utf-8")
    out = bytearray()
    counter = 0
    while len(out) < length:
        block = hmac.new(key, salt + struct.pack(">I", counter), hashlib.sha256).digest()
        out.extend(block)
        counter += 1
    return bytes(out[:length])


def obfuscate_secret(plaintext: str, server_key: str) -> str:
    """Obfuscate a TOTP secret for at-rest storage.

    Layout (single ``base64url`` blob, prefixed ``obf1:``): ``salt(16) || ciphertext``
    where ``ciphertext = plaintext XOR keystream(server_key, salt)``. This is stdlib
    confidentiality-at-rest, NOT key-management — the server key is itself a
    secret-tier value (see the module docstring)."""
    data = (plaintext or "").encode("utf-8")
    salt = secrets.token_bytes(16)
    ks = _keystream(server_key, salt, len(data))
    ct = bytes(a ^ b for a, b in zip(data, ks))
    blob = base64.urlsafe_b64encode(salt + ct).decode("ascii")
    return _OBF_PREFIX + blob


def deobfuscate_secret(stored: str, server_key: str) -> str:
    """Reverse :func:`obfuscate_secret`. A value WITHOUT the ``obf1:`` prefix is
    returned unchanged (back-compat / a plaintext secret never written obfuscated)."""
    if not isinstance(stored, str) or not stored:
        return ""
    if not stored.startswith(_OBF_PREFIX):
        return stored  # legacy / plaintext — return as-is
    try:
        raw = base64.urlsafe_b64decode(stored[len(_OBF_PREFIX) :].encode("ascii"))
    except (ValueError, TypeError):
        return ""
    if len(raw) < 16:
        return ""
    salt, ct = raw[:16], raw[16:]
    ks = _keystream(server_key, salt, len(ct))
    pt = bytes(a ^ b for a, b in zip(ct, ks))
    try:
        return pt.decode("utf-8")
    except UnicodeDecodeError:
        return ""
