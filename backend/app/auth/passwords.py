"""PBKDF2-SHA256 password hashing (stdlib only).

Stored format (single line, ``$``-delimited)::

    pbkdf2_sha256$<iterations>$<salt_hex>$<hash_hex>

This mirrors the well-known Django/passlib layout so the value is self-describing
(the iteration count + salt travel with the hash) while depending on nothing
beyond :mod:`hashlib`, :mod:`hmac`, and :mod:`secrets`. There is intentionally no
bcrypt/argon2 here — those are extra dependencies; PBKDF2-SHA256 with a high
iteration count is a sound, FIPS-friendly stdlib choice.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import os
import secrets
import weakref

_ALGORITHM = "pbkdf2_sha256"
_SALT_BYTES = 16
# Iteration count bumped to 310k (OWASP 2023 PBKDF2-SHA256 guidance). The count is
# embedded in every stored hash, so lower-iteration hashes written by older
# versions still verify transparently — no migration needed.
_DEFAULT_ITERATIONS = 310_000


def hash_password(password: str, *, iterations: int = _DEFAULT_ITERATIONS) -> str:
    """Hash ``password`` and return the self-describing stored string.

    A fresh random 16-byte salt is drawn per call, so hashing the same password
    twice yields different outputs. ``iterations`` is embedded so future cost
    increases verify old hashes transparently.
    """
    if iterations < 1:
        raise ValueError("iterations must be >= 1")
    salt = secrets.token_bytes(_SALT_BYTES)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return f"{_ALGORITHM}${iterations}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    """Constant-time verify ``password`` against a ``stored`` hash string.

    Returns ``False`` on any malformed/unsupported input and never raises, so
    callers can treat it as a pure predicate even on corrupted records.
    """
    if not isinstance(stored, str):
        return False
    parts = stored.split("$")
    if len(parts) != 4:
        return False
    algorithm, iter_str, salt_hex, hash_hex = parts
    if algorithm != _ALGORITHM:
        return False
    try:
        iterations = int(iter_str)
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(hash_hex)
    except (ValueError, TypeError):
        return False
    if iterations < 1 or not salt or not expected:
        return False
    candidate = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return hmac.compare_digest(candidate, expected)


# --------------------------------------------------------------------------- #
# Off the event loop (Round 16, B18)
# --------------------------------------------------------------------------- #
# One PBKDF2 call costs tens of milliseconds of CPU. Run on the event loop, a burst of
# sign-ins or wrong second-factor codes stalls every other request (health checks,
# SSE heartbeats, chat streams). The async forms below run the hash in a worker thread
# under a semaphore, so a flood queues for a bounded number of threads instead of
# taking the loop or every CPU.
HASH_CONCURRENCY = max(2, (os.cpu_count() or 2) // 2)

# One semaphore per running event loop: an asyncio primitive that ever waited is bound
# to the loop it waited on, and a process may run more than one loop over its life (the
# offline test suite starts one per test client).
_SEMAPHORES: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore] = (
    weakref.WeakKeyDictionary()
)


def hash_semaphore() -> asyncio.Semaphore:
    """The semaphore that bounds concurrent PBKDF2 work on the running loop."""
    loop = asyncio.get_running_loop()
    sem = _SEMAPHORES.get(loop)
    if sem is None:
        sem = asyncio.Semaphore(HASH_CONCURRENCY)
        _SEMAPHORES[loop] = sem
    return sem


async def run_hashing(fn, /, *args, **kwargs):
    """Run a synchronous PBKDF2 function in a worker thread under the semaphore."""
    async with hash_semaphore():
        return await asyncio.to_thread(fn, *args, **kwargs)


async def ahash_password(password: str, *, iterations: int = _DEFAULT_ITERATIONS) -> str:
    """:func:`hash_password` off the event loop."""
    return await run_hashing(hash_password, password, iterations=iterations)


async def averify_password(password: str, stored: str) -> bool:
    """:func:`verify_password` off the event loop."""
    return await run_hashing(verify_password, password, stored)
