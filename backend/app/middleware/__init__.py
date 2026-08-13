"""Request-path security middleware (Starlette/FastAPI, stdlib-only logic).

These are additive, individually toggleable middlewares the orchestrator mounts
on the FastAPI app:

- :class:`~app.middleware.security_headers.SecurityHeadersMiddleware` — CSP,
  ``X-Content-Type-Options``, ``X-Frame-Options``, ``Referrer-Policy`` and
  (HTTPS-only) HSTS response headers.
- :class:`~app.middleware.rate_limit.RateLimitMiddleware` — in-process per-IP
  token-bucket rate limiting (no Redis), 429 over the limit.
- :class:`~app.middleware.csrf.CSRFMiddleware` — double-submit-cookie CSRF check
  on unsafe methods.

All of them degrade gracefully and never raise from their own logic; each is a
pass-through when disabled.
"""

from __future__ import annotations

from app.middleware.csrf import CSRFMiddleware
from app.middleware.mutation_admission import MutationAdmissionMiddleware
from app.middleware.rate_limit import RateLimitMiddleware
from app.middleware.security_headers import SecurityHeadersMiddleware

__all__ = [
    "CSRFMiddleware",
    "MutationAdmissionMiddleware",
    "RateLimitMiddleware",
    "SecurityHeadersMiddleware",
]
