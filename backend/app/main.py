"""FastAPI application entrypoint.

Run with: ``uvicorn app.main:app --host 0.0.0.0 --port 8088``
"""

from __future__ import annotations

import importlib
import logging
import pkgutil
from contextlib import asynccontextmanager

from fastapi import APIRouter, Depends, FastAPI

from . import __version__
from . import api as api_pkg
from .api.deps import require_auth
from .api.routes import router
from .config import Secrets
from .logging_setup import configure_logging
from .middleware import (
    CSRFMiddleware,
    MutationAdmissionMiddleware,
    RateLimitMiddleware,
    SecurityHeadersMiddleware,
)
from .state import AppState

logger = logging.getLogger("tlsoc.main")


def discover_feature_routers() -> list[tuple[str, APIRouter]]:
    """Deterministically discover the feature routers to mount alongside the base
    ``routes.py`` router (Round-5 Coupling-E/-F).

    Convention: every ``app/api/routes_<feature>.py`` module exposes a top-level
    ``router: APIRouter``. This replaces the previously-hardcoded tuple so "add a
    feature" = "drop a ``routes_*.py`` file" — no edit here.

    Invariants (see RESEARCH_COUPLING §B4):
    * **SORTED** by module name — ``pkgutil`` order is filesystem-dependent, and the
      mount order must be deterministic (uniform ``require_auth`` mount, but a stable
      order keeps OpenAPI / route listings reproducible).
    * The base ``routes`` module is EXCLUDED (it does not start with ``routes_`` and is
      mounted separately above) so it is never double-mounted.
    * **RAISE on import failure** — a broken feature module must fail loudly at boot,
      never be silently print+skipped (which would de-register its routes and, worse,
      could silently de-auth a surface).
    """
    found: list[tuple[str, APIRouter]] = []
    for _finder, name, _ispkg in sorted(
        pkgutil.iter_modules(api_pkg.__path__), key=lambda m: m[1]
    ):
        if not name.startswith("routes_"):  # allowlist convention; excludes base `routes`
            continue
        module = importlib.import_module(f"{api_pkg.__name__}.{name}")  # RAISE on failure
        router_obj = getattr(module, "router", None)
        if router_obj is None:
            # A routes_* module MUST expose a `router`; a missing one is a wiring bug we
            # surface loudly rather than silently drop the feature's endpoints.
            raise RuntimeError(
                f"feature module app.api.{name} has no top-level `router` to mount"
            )
        found.append((name, router_obj))
    return found


@asynccontextmanager
async def lifespan(app: FastAPI):
    secrets = Secrets()
    configure_logging(secrets.log_level)
    logger.info("Starting Agentic SOC API")
    state = AppState.create(secrets=secrets)
    app.state.tlsoc = state
    await state.startup()
    try:
        yield
    finally:
        logger.info("Shutting down Agentic SOC API")
        await state.shutdown()


app = FastAPI(
    title="Agentic SOC API",
    version=__version__,
    description="Vendor-neutral Agentic SOC API. It consumes source data "
                "read-only and owns only Agentic SOC application state.",
    lifespan=lifespan,
)

# Always-on tenant mutation admission. It is a no-op during normal operation and
# becomes the process-local HTTP drain boundary only while a durable factory-reset
# Job owns the corresponding CAS fence. Added before security middleware so response
# hardening remains outermost.
app.add_middleware(MutationAdmissionMiddleware)

# --- Security middleware (Wave 2; env-toggleable, independent of auth). Added in
# this order so security headers are OUTERMOST (cover every response incl. 401/403).
_sec = Secrets()
if _sec.csrf_enabled:
    app.add_middleware(CSRFMiddleware, enabled=True)
if _sec.rate_limit_enabled:
    app.add_middleware(
        RateLimitMiddleware,
        capacity=_sec.rate_limit_capacity,
        refill_per_second=_sec.rate_limit_refill_per_second,
        enabled=True,
    )
if _sec.security_headers_enabled:
    app.add_middleware(SecurityHeadersMiddleware)

# Auth gate on the WHOLE /api router (deny-by-default; a strict no-op when auth is
# disabled). Every /api route inherits it → a new route is protected automatically.
app.include_router(router, dependencies=[Depends(require_auth)])

# Feature routers (each a standalone ``APIRouter(prefix="/api")`` in an
# ``app/api/routes_<feature>.py`` module). Auto-discovered (sorted, raise-on-failure)
# and mounted with the SAME require_auth dependency so every route inherits the auth
# gate (GETs are protected; each non-GET declares its own require_permission).
# Additive — none of these touch the deterministic case_manager.decide() (#3) or the
# LLM ledger (#6). "Add a feature" = "drop a ``routes_*.py`` file"; no edit here.
for _name, _feature_router in discover_feature_routers():
    app.include_router(_feature_router, dependencies=[Depends(require_auth)])


@app.get("/")
async def root() -> dict[str, str]:
    return {"service": "tlsoc-agentic-triage", "health": "/api/health", "docs": "/docs"}
