"""OIDC (OpenID Connect) SSO — Authorization-Code flow, server-side code exchange.

Wave 2 (F4) adds Single-Sign-On against Google, Microsoft Entra, and any generic
OIDC IdP. We deliberately keep ZERO new dependencies:

* HTTP is done with ``httpx`` — the SAME client the enrichment tool already uses
  (``tools/enrich.py``) — so no new package is introduced.
* We do **server-side** code exchange and then call the IdP ``userinfo`` endpoint
  over the back-channel (TLS) to obtain identity claims. We do NOT verify the
  ``id_token`` JWS signature (that would need ``PyJWT[crypto]`` / JWKS). Trusting
  the TLS-protected token-endpoint response + the userinfo lookup is a documented,
  intentional simplification; **id_token signature verification (kid→JWKS, RS256,
  aud/iss/nonce checks) is a production-hardening TODO**, not required for this wave.

The flow (driven by the routes in ``api/routes.py``):

1. ``/auth/sso/authorize`` builds the authorization URL from discovery, stashing a
   single-use ``state``/``nonce`` in the KV (ns ``oidc_state``), and redirects the
   browser to the IdP.
2. The IdP redirects back to ``/auth/sso/callback?code=&state=``. We validate
   ``state``, exchange ``code`` for tokens (server-side), call ``userinfo``, map the
   claims to a local identity (``sub``/``email``/``name``/``domain``/``groups``),
   enforce the domain/tenant allowlist + group→role mapping, provision the user when
   ``auto_create_users`` is on, and mint the normal session JWT.

Discovery documents are cached in-process (they rarely change).
"""

from __future__ import annotations

import asyncio
import json
import logging
import secrets
import urllib.error
import urllib.request
from typing import Any
from urllib.parse import urlencode

logger = logging.getLogger("tlsoc.auth.oidc")

_TIMEOUT = 12.0

# The KV namespace + round-trip TTL for the single-use ``state`` tokens minted for the
# Authorization-Code flow. Round 5 (Coupling-F): the stash/consume round-trip lives
# here (over the shared KV) instead of the route reaching into ``state._kv`` directly —
# the route now goes through the public ``AppState.oidc_state`` accessor.
OIDC_STATE_NS = "oidc_state"
OIDC_STATE_TTL_SECONDS = 600  # 10 minutes for the round-trip to the IdP + back.

# Provider preset discovery URLs. ``microsoft`` is templated on the tenant.
_GOOGLE_DISCOVERY = "https://accounts.google.com/.well-known/openid-configuration"
_MS_DISCOVERY_TMPL = "https://login.microsoftonline.com/{tenant}/v2.0/.well-known/openid-configuration"

_DEFAULT_SCOPES = "openid email profile"

# Process-local discovery cache (discovery_url -> document).
_DISCOVERY_CACHE: dict[str, dict[str, Any]] = {}


def _claim_truthy(value: Any) -> bool:
    """Whether an IdP claim asserts truth. OIDC email_verified is a JSON boolean, but
    some providers stringify it ("true"/"1"). Anything else (including absent/None) is
    treated as NOT asserted — fail closed (#3)."""
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"true", "1", "yes"}


def new_state() -> str:
    """A fresh URL-safe random ``state`` (also reused as the storage key)."""
    return secrets.token_urlsafe(24)


def new_nonce() -> str:
    """A fresh URL-safe random ``nonce`` (replay binding for the auth request)."""
    return secrets.token_urlsafe(24)


def _discovery_url_for(cfg: dict[str, Any]) -> str:
    """Resolve the discovery URL for a provider config dict.

    ``google`` → fixed Google discovery; ``microsoft`` → tenant-templated MS
    discovery (tenant defaults to ``organizations``); ``generic`` / anything else →
    the operator-supplied ``discovery_url``."""
    ptype = str(cfg.get("type") or "generic").lower()
    if ptype == "google":
        return _GOOGLE_DISCOVERY
    if ptype == "microsoft":
        tenant = str(cfg.get("tenant") or "organizations").strip() or "organizations"
        return _MS_DISCOVERY_TMPL.format(tenant=tenant)
    return str(cfg.get("discovery_url") or "").strip()


async def _http_get_json(url: str, *, headers: dict[str, str] | None = None) -> dict[str, Any]:
    """GET ``url`` and parse JSON, preferring ``httpx`` (the repo's client) and
    falling back to stdlib ``urllib`` via a thread when httpx is unavailable."""
    try:
        import httpx

        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.get(url, headers=headers or {})
            resp.raise_for_status()
            return resp.json()
    except ImportError:  # pragma: no cover — httpx is a hard dep here, defensive
        return await asyncio.to_thread(_urllib_get_json, url, headers or {})


def _urllib_get_json(url: str, headers: dict[str, str]) -> dict[str, Any]:  # pragma: no cover
    req = urllib.request.Request(url, headers=headers, method="GET")
    with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:  # noqa: S310 — TLS IdP URL
        return json.loads(resp.read().decode("utf-8"))


async def _http_post_form(url: str, form: dict[str, str]) -> dict[str, Any]:
    """POST a urlencoded form and parse JSON (token endpoint), httpx → urllib."""
    try:
        import httpx

        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.post(
                url, data=form, headers={"Accept": "application/json"}
            )
            resp.raise_for_status()
            return resp.json()
    except ImportError:  # pragma: no cover
        return await asyncio.to_thread(_urllib_post_form, url, form)


def _urllib_post_form(url: str, form: dict[str, str]) -> dict[str, Any]:  # pragma: no cover
    body = urlencode(form).encode("ascii")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:  # noqa: S310
        return json.loads(resp.read().decode("utf-8"))


class OidcError(Exception):
    """A recoverable SSO error (maps to a ``/login?sso_error=...`` redirect)."""


class OidcProvider:
    """One configured OIDC provider (built from a ``sso.providers[]`` entry).

    Parameters mirror the :class:`app.config.SSOProvider` model. ``client_secret``
    is supplied separately (secret tier) and is NEVER part of the config dict.
    """

    def __init__(self, config: dict[str, Any], *, client_secret: str = "") -> None:
        self.config = dict(config or {})
        self.id = str(self.config.get("id") or "")
        self.type = str(self.config.get("type") or "generic").lower()
        self.display_name = str(self.config.get("display_name") or self.id or self.type)
        self.client_id = str(self.config.get("client_id") or "")
        self.client_secret = client_secret or ""
        self.scopes = str(self.config.get("scopes") or _DEFAULT_SCOPES).strip() or _DEFAULT_SCOPES
        self.allowed_domains = [str(d).strip().lower() for d in (self.config.get("allowed_domains") or []) if str(d).strip()]
        self.allowed_tenants = [str(t).strip().lower() for t in (self.config.get("allowed_tenants") or []) if str(t).strip()]
        self.group_claim = str(self.config.get("group_claim") or "").strip()
        self.group_role_map = dict(self.config.get("group_role_map") or {})
        self.auto_create_users = bool(self.config.get("auto_create_users", False))
        self.default_role = str(self.config.get("default_role") or "analyst_tier1")
        self._discovery: dict[str, Any] | None = None

    # ----- discovery -----
    async def discover(self) -> dict[str, Any]:
        """Fetch (and cache) the provider's ``.well-known/openid-configuration``."""
        url = _discovery_url_for(self.config)
        if not url:
            raise OidcError("provider has no discovery_url")
        cached = _DISCOVERY_CACHE.get(url)
        if cached is not None:
            self._discovery = cached
            return cached
        try:
            doc = await _http_get_json(url)
        except Exception as exc:  # noqa: BLE001
            raise OidcError(f"discovery failed: {exc}") from exc
        if not isinstance(doc, dict) or not doc.get("authorization_endpoint"):
            raise OidcError("invalid discovery document")
        _DISCOVERY_CACHE[url] = doc
        self._discovery = doc
        return doc

    # ----- authorization URL -----
    async def authorization_url(self, *, state: str, nonce: str, redirect_uri: str) -> str:
        """Build the IdP authorization URL for the Authorization-Code flow."""
        doc = self._discovery or await self.discover()
        params = {
            "client_id": self.client_id,
            "response_type": "code",
            "redirect_uri": redirect_uri,
            "scope": self.scopes,
            "state": state,
            "nonce": nonce,
        }
        # Google honours `hd` to scope the account chooser to a Workspace domain.
        if self.type == "google" and len(self.allowed_domains) == 1:
            params["hd"] = self.allowed_domains[0]
        sep = "&" if "?" in str(doc["authorization_endpoint"]) else "?"
        return f"{doc['authorization_endpoint']}{sep}{urlencode(params)}"

    # ----- token exchange -----
    async def exchange_code(self, *, code: str, redirect_uri: str) -> dict[str, Any]:
        """Server-side exchange of ``code`` for tokens at the token endpoint."""
        doc = self._discovery or await self.discover()
        token_ep = str(doc.get("token_endpoint") or "")
        if not token_ep:
            raise OidcError("discovery has no token_endpoint")
        form = {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "client_id": self.client_id,
            "client_secret": self.client_secret,
        }
        try:
            tokens = await _http_post_form(token_ep, form)
        except Exception as exc:  # noqa: BLE001
            raise OidcError(f"token exchange failed: {exc}") from exc
        if not isinstance(tokens, dict) or not tokens.get("access_token"):
            raise OidcError("token endpoint returned no access_token")
        return tokens

    # ----- userinfo -----
    async def fetch_userinfo(self, access_token: str) -> dict[str, Any]:
        """Call the ``userinfo`` endpoint with the bearer access token."""
        doc = self._discovery or await self.discover()
        userinfo_ep = str(doc.get("userinfo_endpoint") or "")
        if not userinfo_ep:
            raise OidcError("discovery has no userinfo_endpoint")
        try:
            claims = await _http_get_json(
                userinfo_ep, headers={"Authorization": f"Bearer {access_token}"}
            )
        except Exception as exc:  # noqa: BLE001
            raise OidcError(f"userinfo failed: {exc}") from exc
        if not isinstance(claims, dict):
            raise OidcError("userinfo returned a non-object")
        return claims

    # ----- claim → identity mapping -----
    def identity_from(self, claims: dict[str, Any]) -> dict[str, Any]:
        """Normalise raw IdP claims into ``{sub, email, name, domain, tenant, groups}``.

        ``sub`` prefers the IdP's stable subject; for Microsoft the immutable ``oid``
        is preferred. ``domain`` is the ``hd`` claim for a Google provider, else the
        domain of the verified email.
        ``groups`` is read from the configured ``group_claim`` (list or scalar).

        SECURITY (#3): ``email`` is read ONLY from the ``email`` claim — never from the
        mutable ``preferred_username``, which is not a verified identifier and could be
        set to a victim's address. ``email_verified`` carries whether the IdP asserts
        the address is verified (Google's ``email_verified`` / Microsoft's ``xms_edov``);
        the caller MUST NOT trust the email for account matching unless this is true."""
        email = str(claims.get("email") or "").strip()
        email_verified = _claim_truthy(claims.get("email_verified")) or _claim_truthy(
            claims.get("xms_edov")  # Microsoft "email domain owner verified"
        )
        # Round 16 (B16 hardening): ``hd`` is Google's hosted-domain claim and is read
        # only for a Google provider. Any other IdP could assert ``hd`` freely, so its
        # domain is the VERIFIED email's domain (empty when the email is unverified)
        # and ``allowed_domains`` cannot be passed by asserting a claim.
        domain = str(claims.get("hd") or "").strip().lower() if self.type == "google" else ""
        if not domain and "@" in email and (email_verified or self.type == "google"):
            domain = email.rsplit("@", 1)[-1].strip().lower()
        if self.type == "microsoft":
            sub = str(claims.get("oid") or claims.get("sub") or "").strip()
        else:
            sub = str(claims.get("sub") or "").strip()
        groups: list[str] = []
        if self.group_claim:
            raw = claims.get(self.group_claim)
            if isinstance(raw, list):
                groups = [str(g) for g in raw if str(g).strip()]
            elif raw is not None and str(raw).strip():
                groups = [str(raw).strip()]
        return {
            "sub": sub,
            "email": email,
            "email_verified": email_verified,
            "name": str(claims.get("name") or claims.get("preferred_username") or email or "").strip(),
            "domain": domain,
            "tenant": str(claims.get("tid") or "").strip().lower(),
            "groups": groups,
        }

    # ----- allowlist enforcement -----
    def check_allowed(self, identity: dict[str, Any]) -> str | None:
        """Return ``None`` when ``identity`` passes the domain + tenant allowlist,
        else a human-readable rejection reason."""
        if self.allowed_domains:
            domain = str(identity.get("domain") or "").lower()
            if domain not in self.allowed_domains:
                return f"domain '{domain or '?'}' is not allowed"
        if self.allowed_tenants:
            tenant = str(identity.get("tenant") or "").lower()
            if tenant not in self.allowed_tenants:
                return f"tenant '{tenant or '?'}' is not allowed"
        return None

    # ----- group → role mapping -----
    def role_for(self, identity: dict[str, Any]) -> str:
        """Map the identity's groups to a local RBAC role via ``group_role_map``;
        fall back to ``default_role``. The FIRST mapped group (in claim order) wins."""
        for grp in identity.get("groups") or []:
            mapped = self.group_role_map.get(grp)
            if mapped:
                return str(mapped)
        return self.default_role


class OidcStateStore:
    """Single-use ``state``-token round-trip over the shared KV (Round 5 / Coupling-F).

    The SSO Authorization-Code flow mints a ``state`` token, stashes the pending
    request (provider/nonce/redirect_uri + a short TTL) under it, and validates +
    consumes it exactly once on the IdP callback. This used to be inline route code
    reaching straight into ``AppState._kv``; it now lives here (its natural home — this
    module already owns the ``oidc_state`` namespace) and is exposed via the PUBLIC
    ``AppState.oidc_state`` accessor, so the route no longer touches a private.

    Backend-agnostic (any :class:`app.stores.base.KVStore`); never raises out of the
    happy path (a KV glitch degrades to "state not found" → the flow safely rejects).
    """

    def __init__(self, kv: Any) -> None:
        self._kv = kv

    async def stash(self, state_tok: str, record: dict[str, Any]) -> None:
        """Persist the pending SSO request under ``state_tok`` with a TTL epoch.

        Mirrors the historical route write byte-for-byte (``expires_at`` iso +
        ``expires_epoch`` = now + TTL). Best-effort; never raises."""
        import time as _t

        payload = {
            **record,
            "expires_epoch": int(_t.time()) + OIDC_STATE_TTL_SECONDS,
        }
        try:
            await self._kv.put(OIDC_STATE_NS, state_tok, payload)
        except Exception as exc:  # noqa: BLE001 — a stash glitch fails the flow safely later
            logger.warning("OIDC state stash failed: %s", exc)

    async def consume(self, state_tok: str) -> dict[str, Any] | None:
        """Validate + SINGLE-USE consume a stored ``state`` token.

        Returns the stored record when present, unexpired and not already used; else
        ``None`` (unknown / replayed / expired). Consumption marks the record ``used``
        (the KV has no delete) so a replay finds it consumed. Never raises."""
        import time as _t

        if not state_tok:
            return None
        try:
            rec = await self._kv.get(OIDC_STATE_NS, state_tok)
        except Exception as exc:  # noqa: BLE001 — a read glitch rejects the flow safely
            logger.warning("OIDC state read failed: %s", exc)
            return None
        if not isinstance(rec, dict) or rec.get("used"):
            return None
        if int(rec.get("expires_epoch", 0) or 0) < int(_t.time()):
            return None
        try:
            await self._kv.put(OIDC_STATE_NS, state_tok, {**rec, "used": True})
        except Exception:  # noqa: BLE001 — single-use marking is best-effort
            pass
        return rec
