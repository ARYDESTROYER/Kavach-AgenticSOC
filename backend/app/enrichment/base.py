"""The enrichment-provider SPI — one contract every threat-intel source plugs into.

A *provider* answers one question: "what does <provider> think of this indicator?".
Given an observable ``(value, kind)`` it returns a single
:class:`app.models.ProviderResult` (a 0..100 maliciousness score + the provider's
own malicious/confidence call + tags + a raw excerpt). It mirrors the *connector*
SPI (``app.connectors.base``):

  * a static :class:`ProviderManifest` (identity, the :class:`IndicatorKind`s it
    handles, its secret/auth fields, free-tier note, default-enabled) drives
    discovery + the settings UI WITHOUT an instance or credentials, exactly like
    ``ConnectorManifest``;
  * an async :meth:`EnrichmentProvider.lookup` does the work and is **FAIL-OPEN**:
    on ANY error it returns ``ProviderResult(ok=False, error=...)`` and NEVER raises,
    so a flaky third party degrades the signal but can never crash the engine
    (mirrors the legacy ``EnrichTool`` contract).

The provider is given its config (``EnrichmentConfig``) + secrets at construction;
``capable(kind)`` reports whether it handles a given indicator kind, and
``key_present(secrets)`` reports whether its required secret(s) are configured. The
registry uses both to filter the providers a dispatch actually calls.
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel, Field

from ..constants import IndicatorKind
from ..models import ProviderResult

if TYPE_CHECKING:  # avoid import cycles / heavy imports at module load
    from ..config import EnrichmentConfig, Secrets

logger = logging.getLogger("tlsoc.enrichment.provider")


# --------------------------------------------------------------------------- #
# Settings-facing metadata (mirrors connectors/base.AuthField + ConnectorManifest)
# --------------------------------------------------------------------------- #
class ProviderSecretField(BaseModel):
    """One secret/auth input a key-gated provider needs.

    ``key`` is the attribute on :class:`app.config.Secrets` that holds the value
    (e.g. ``"greynoise_api_key"``). Like ``AuthField`` with ``secret=True``, the
    value is written to the SECRET tier and surfaced in the UI as ``configured ✓``
    only — never echoed back (#10). The settings UI renders ``label``/``help`` and
    shows a configured-boolean derived from ``Secrets``."""

    key: str
    label: str
    required: bool = True
    help: str = ""
    help_link: str = ""


class ProviderManifest(BaseModel):
    """Self-description of an enrichment provider (drives discovery + the UI).

    Static — obtained from the class WITHOUT an instance or credentials (mirrors
    ``ConnectorManifest``). ``indicator_kinds`` lists the :class:`IndicatorKind`s the
    provider handles; ``config_key`` is the ``EnrichmentConfig.use_*`` toggle that
    enables it; ``secret_fields`` are the SECRET-tier keys it needs (empty ⇒ the
    provider is KEYLESS and needs no key to run). ``free_tier`` is a human note about
    rate limits; ``default_enabled`` mirrors the shipped ``EnrichmentConfig`` default
    so the UI can show the out-of-the-box state.

    ``setup_steps`` (Round 11) is an ordered list of concrete operator steps to get
    the provider running (where to create the account/key, which env var / Settings
    field to set, free-tier notes); ``example`` is a one-or-two-sentence "how this
    helps triage" blurb. Both are FIXED manifest strings hard-coded by the provider
    author — trusted UI copy, never derived from provider responses (#9)."""

    name: str
    display_name: str = ""
    description: str = ""
    indicator_kinds: list[IndicatorKind] = Field(default_factory=list)
    config_key: str = ""            # the EnrichmentConfig.use_<x> attribute
    secret_fields: list[ProviderSecretField] = Field(default_factory=list)
    keyless: bool = False           # True ⇒ no secret needed to run
    free_tier: str = ""             # human note: free-tier limits / signup
    docs_url: str | None = None
    default_enabled: bool = False
    version: str = "1.0.0"
    # Round 11: operator setup guide + usefulness example (fixed, trusted UI copy).
    setup_steps: list[str] = Field(default_factory=list)
    example: str = ""


# --------------------------------------------------------------------------- #
# The provider ABC
# --------------------------------------------------------------------------- #
class EnrichmentProvider(ABC):
    """One threat-intel provider. Never instantiated directly by callers — the
    :class:`app.enrichment.registry.ProviderRegistry` constructs the enabled ones.

    Subclasses MUST set the class attribute :attr:`name` (the stable provider id used
    as the cache namespace + the ``ProviderResult.provider`` value) and implement
    :meth:`manifest` (classmethod, no instance needed) + :meth:`_lookup` (the actual
    provider call). They MUST NOT override :meth:`lookup` — that wrapper is what
    guarantees the fail-open contract."""

    #: Stable provider id (cache namespace + ProviderResult.provider). Set by subclass.
    name: str = "provider"

    def __init__(
        self,
        cfg: "EnrichmentConfig",
        secrets: "Secrets",
    ) -> None:
        self._cfg = cfg
        self._secrets = secrets

    # ----- static self-description (no instance needed in callers) -----
    @classmethod
    @abstractmethod
    def manifest(cls) -> ProviderManifest:
        """Static self-description (does NOT require an instance/credentials)."""

    # ----- capability / gating helpers (used by the registry filter) -----
    @classmethod
    def handles(cls, kind: IndicatorKind) -> bool:
        """True iff this provider's manifest declares it handles ``kind``."""
        try:
            return kind in cls.manifest().indicator_kinds
        except Exception:  # noqa: BLE001 — a bad manifest must never break filtering
            return False

    @classmethod
    def secret_keys(cls) -> list[str]:
        """The ``Secrets`` attribute names this provider needs (empty ⇒ keyless)."""
        try:
            return [f.key for f in cls.manifest().secret_fields]
        except Exception:  # noqa: BLE001
            return []

    @classmethod
    def config_toggle(cls) -> str:
        """The ``EnrichmentConfig.use_*`` attribute name that enables this provider."""
        try:
            return cls.manifest().config_key
        except Exception:  # noqa: BLE001
            return ""

    @classmethod
    def is_keyless(cls) -> bool:
        try:
            m = cls.manifest()
            return bool(m.keyless) or not m.secret_fields
        except Exception:  # noqa: BLE001
            return False

    @classmethod
    def enabled_by_config(cls, cfg: "EnrichmentConfig") -> bool:
        """True iff the operator's ``EnrichmentConfig`` toggles this provider on.

        A blank/unknown ``config_key`` defaults to enabled (a provider with no toggle
        is always on); a present toggle is read off ``cfg`` (missing attr ⇒ False)."""
        toggle = cls.config_toggle()
        if not toggle:
            return True
        return bool(getattr(cfg, toggle, False))

    @classmethod
    def key_present(cls, secrets: "Secrets") -> bool:
        """True iff this provider is keyless OR every required secret key is set."""
        keys = cls.secret_keys()
        if not keys:
            return True
        return all(bool(getattr(secrets, k, None)) for k in keys)

    def _secret(self, key: str) -> str | None:
        return getattr(self._secrets, key, None)

    # ----- the fail-open lookup wrapper (subclasses implement _lookup) -----
    async def lookup(self, value: str, kind: IndicatorKind) -> ProviderResult:
        """Resolve one indicator. NEVER raises — on any error returns
        ``ProviderResult(ok=False, error=...)`` (fail-open, mirrors EnrichTool)."""
        try:
            result = await self._lookup(value, kind)
            # Defensive: a misbehaving provider that returns None still fails open.
            if result is None:
                return ProviderResult(
                    provider=self.name,
                    indicator=value,
                    indicator_kind=kind.value,
                    ok=False,
                    error="provider returned no result",
                )
            # Stamp identity defensively so providers can't forget it.
            if not result.provider:
                result.provider = self.name
            if not result.indicator:
                result.indicator = value
            if not result.indicator_kind:
                result.indicator_kind = kind.value
            return result
        except Exception as exc:  # noqa: BLE001 — fail-open: NEVER let a provider raise
            logger.warning("%s lookup failed for %s (%s): %s", self.name, value, kind.value, exc)
            return ProviderResult(
                provider=self.name,
                indicator=value,
                indicator_kind=kind.value,
                ok=False,
                error=f"{self.name}: {exc}",
            )

    @abstractmethod
    async def _lookup(self, value: str, kind: IndicatorKind) -> ProviderResult:
        """The actual provider call. MAY raise — :meth:`lookup` catches it. Should
        return a populated :class:`ProviderResult` (``ok=True`` on success)."""


__all__ = ["EnrichmentProvider", "ProviderManifest", "ProviderSecretField"]
