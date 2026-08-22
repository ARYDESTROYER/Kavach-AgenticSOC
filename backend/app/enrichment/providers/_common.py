"""Shared helpers for the Round-3 Wave-2 enrichment providers.

Two utilities every new provider leans on:

  * :func:`http_json` — a tiny async HTTP-GET-then-JSON helper around ``httpx`` with a
    per-provider timeout. It NEVER raises for the caller's benefit only in the sense
    that the calling ``_lookup`` runs under :meth:`EnrichmentProvider.lookup`'s
    fail-open wrapper; here we still raise on transport/HTTP errors so the wrapper can
    record them (that is the established AbuseIPDB/VirusTotal template behaviour). A
    ``404`` is treated as a CLEAN miss (return ``None``) because most reputation APIs
    answer "I have never seen this indicator" with a 404, which is a benign signal —
    NOT an error.
  * :class:`TokenBucket` + :func:`rate_guard` — an in-process, per-provider token
    bucket that honours each free tier's documented request rate (Shodan 1 req/s,
    Censys 1 req/2.5 s, GreyNoise ~50/week, …). It is a courtesy throttle so a burst
    of indicators never trips a provider's rate limit; it is FAIL-OPEN — if a token is
    unavailable within a short wait it simply proceeds (better a possible 429, which
    the provider fails open on, than a stalled investigation).

Both are dependency-free (stdlib + the already-vendored ``httpx``) and process-local
(the buckets live in a module dict keyed by provider name), so they add NO new runtime
dependency and survive across requests within one process.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import httpx

logger = logging.getLogger("tlsoc.enrichment.providers")

# A sane per-request default; individual providers may pass a tighter timeout. The
# dispatcher ALSO wraps the whole lookup in a hard 10s timeout, so this is the inner
# transport bound.
DEFAULT_HTTP_TIMEOUT = 8.0


def _redact_url(url: Any) -> str:
    """Strip the query string + any userinfo from a URL for error messages.

    Several providers pass their API key as a query param (Shodan/Pulsedive
    ``?key=…``). httpx's ``HTTPStatusError`` message embeds ``request.url`` VERBATIM,
    which the fail-open wrapper then records into the ProviderResult error (→ case doc,
    logs, threat-context UI), LEAKING the key. Rendering only scheme+host+path keeps the
    error useful without disclosing the secret (audit #5)."""
    try:
        u = httpx.URL(str(url))
        return str(u.copy_with(query=None, userinfo=b""))
    except Exception:  # noqa: BLE001
        return "<redacted-url>"


async def http_json(
    url: str,
    *,
    method: str = "GET",
    params: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    json_body: Any | None = None,
    data: Any | None = None,
    timeout: float = DEFAULT_HTTP_TIMEOUT,
    treat_404_as_empty: bool = True,
) -> dict[str, Any] | list[Any] | None:
    """GET/POST ``url`` and decode JSON. Returns the decoded body, or ``None`` for a
    "not found" / clean-miss (404 when ``treat_404_as_empty``). Raises on transport or
    other HTTP errors so the caller's fail-open wrapper records them."""
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.request(
            method.upper(),
            url,
            params=params,
            headers=headers,
            json=json_body,
            data=data,
        )
        if treat_404_as_empty and resp.status_code == 404:
            return None
        try:
            resp.raise_for_status()
        except httpx.HTTPStatusError as exc:
            # Re-raise with the key-bearing query string scrubbed from the message so a
            # provider key can never reach the recorded error / logs / UI (audit #5).
            raise httpx.HTTPStatusError(
                f"HTTP {resp.status_code} for {_redact_url(exc.request.url)}",
                request=exc.request,
                response=exc.response,
            ) from None
        if not resp.content:
            return None
        try:
            return resp.json()
        except Exception:  # noqa: BLE001 — a non-JSON 200 is a clean miss, not a crash
            return None


async def http_json_soft(
    url: str,
    **kwargs: Any,
) -> dict[str, Any] | list[Any] | None:
    """Like :func:`http_json` but returns ``None`` on ANY transport/HTTP error instead
    of raising — for KEYLESS *context/exposure* providers (geo, host-exposure, scan
    data) that are advisory-only.

    Rationale + #3: the LEGACY ``EnrichTool.enrich_ip`` aggregates provider errors into
    ``EnrichmentResult.error`` (which the deterministic risk scorer reads). A keyless
    context provider that is simply UNREACHABLE contributes no reputation signal — it is
    "no data", not a reputation error — so it must degrade to a NEUTRAL, error-free
    result (``ok=True, score=0``) and never pollute the legacy reputation contract. A
    KEY-GATED reputation provider, by contrast, uses the hard :func:`http_json` so a real
    failure still surfaces. NEVER raises."""
    try:
        return await http_json(url, **kwargs)
    except Exception as exc:  # noqa: BLE001 — context providers degrade to "no data"
        logger.debug("soft http for %s returned no data (%s)", url, exc)
        return None


class TokenBucket:
    """A minimal async token bucket. ``rate`` tokens accrue per ``per`` seconds up to
    ``capacity``; :meth:`acquire` waits (bounded by ``max_wait``) for a token and then
    proceeds regardless (fail-open throttle, never a hard block)."""

    def __init__(self, rate: float, per: float, capacity: float | None = None) -> None:
        self.rate = float(rate)
        self.per = float(per)
        self.capacity = float(capacity if capacity is not None else max(1.0, rate))
        self._tokens = self.capacity
        self._updated = time.monotonic()
        self._lock = asyncio.Lock()

    def _refill(self) -> None:
        now = time.monotonic()
        elapsed = now - self._updated
        if elapsed <= 0:
            return
        self._tokens = min(self.capacity, self._tokens + elapsed * (self.rate / self.per))
        self._updated = now

    async def acquire(self, *, max_wait: float = 2.0) -> bool:
        """Take one token. Waits up to ``max_wait`` seconds for one to accrue; if none
        is available by then, proceeds anyway (returns ``False`` to signal it was not
        throttled cleanly). NEVER raises."""
        async with self._lock:
            self._refill()
            if self._tokens >= 1.0:
                self._tokens -= 1.0
                return True
            # How long until one token accrues?
            deficit = 1.0 - self._tokens
            wait = deficit * (self.per / self.rate) if self.rate > 0 else max_wait
            wait = min(max(0.0, wait), max_wait)
            if wait > 0:
                try:
                    await asyncio.sleep(wait)
                except Exception:  # noqa: BLE001 — never let the throttle break a lookup
                    pass
            self._refill()
            if self._tokens >= 1.0:
                self._tokens -= 1.0
                return True
            # Couldn't wait long enough — proceed anyway (a possible 429 fails open).
            return False


# Per-provider buckets honouring the documented free-tier request rates. Keyed by the
# provider's stable ``name``; created lazily on first use.
_BUCKETS: dict[str, TokenBucket] = {}

# (rate, per_seconds, capacity) per provider. Conservative — a small burst capacity so
# a handful of indicators in one case don't serialise, then steady-state at the limit.
_BUCKET_SPECS: dict[str, tuple[float, float, float]] = {
    "shodan": (1.0, 1.0, 2.0),               # Shodan: ~1 req/s
    "shodan_internetdb": (1.0, 1.0, 3.0),    # keyless InternetDB — be gentle
    "censys": (1.0, 2.5, 1.0),               # Censys: 1 req / 2.5 s on the free tier
    "greynoise": (1.0, 12096.0, 2.0),        # ~50/week ≈ 1 / 12096 s
    "binaryedge": (1.0, 1.0, 2.0),
    "pulsedive": (1.0, 1.0, 2.0),            # ~30/min free
    "otx": (5.0, 1.0, 5.0),
    "xforce": (1.0, 1.0, 2.0),
    "urlscan": (1.0, 2.0, 2.0),
    "projecthoneypot": (1.0, 1.0, 2.0),
    "spur": (1.0, 1.0, 2.0),
    # --- Round 11 providers ---
    "circl_hashlookup": (2.0, 1.0, 4.0),     # keyless; be polite
    "dshield": (1.0, 2.0, 2.0),              # SANS ISC asks for gentle use
    "onionoo": (1.0, 2.0, 2.0),
    "spamhaus": (2.0, 1.0, 4.0),             # DNS; low-volume free use only
    "cymru_mhr": (2.0, 1.0, 4.0),            # DNS
    "robtex": (1.0, 3.0, 1.0),               # free API is heavily rate-limited
    "crt_sh": (1.0, 5.0, 1.0),               # crt.sh is often slow; be very gentle
    "crowdsec": (1.0, 2.0, 2.0),             # free CTI key: small daily quota
    "google_safebrowsing": (5.0, 1.0, 5.0),
    "ipqualityscore": (1.0, 1.0, 2.0),       # ~5k lookups/month free
    "ipdata": (1.0, 1.0, 2.0),               # 1,500 req/day free
    "apivoid": (1.0, 2.0, 2.0),              # credit-based
    "maltiverse": (1.0, 1.0, 2.0),
    "securitytrails": (1.0, 6.0, 1.0),       # free: 50 queries/month
    "criminalip": (1.0, 2.0, 2.0),
    "netlas": (1.0, 2.0, 2.0),
    "hybrid_analysis": (1.0, 3.0, 2.0),      # 200 req/h vetted free tier
    "metadefender": (1.0, 2.0, 2.0),
    "emailrep": (1.0, 3.0, 1.0),             # free key: tight daily quota
}


async def rate_guard(provider: str, *, max_wait: float = 2.0) -> None:
    """Throttle ``provider`` to its documented free-tier rate (best-effort, fail-open).

    Looks up the provider's bucket (lazily created from :data:`_BUCKET_SPECS`); a
    provider with no spec is not throttled. NEVER raises — a throttle failure must
    never break an enrichment lookup."""
    try:
        spec = _BUCKET_SPECS.get(provider)
        if spec is None:
            return
        bucket = _BUCKETS.get(provider)
        if bucket is None:
            bucket = TokenBucket(rate=spec[0], per=spec[1], capacity=spec[2])
            _BUCKETS[provider] = bucket
        await bucket.acquire(max_wait=max_wait)
    except Exception as exc:  # noqa: BLE001 — throttle is a courtesy; never block a lookup
        logger.debug("rate_guard for %s no-op (%s)", provider, exc)


__all__ = ["http_json", "http_json_soft", "TokenBucket", "rate_guard", "DEFAULT_HTTP_TIMEOUT"]
